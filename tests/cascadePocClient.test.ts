import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALL_ENGINE_KEY,
  getCallEngine,
  isCascadePocEnabled,
  setCascadePocEnabled,
  POC_TEXT_VARIANT_KEY,
  getStoredPocTextVariant,
  setStoredPocTextVariant,
  parsePocTextParam,
  resolvePocTextVariant,
} from '../src/services/settings/callEngineSetting.ts';
import {
  PocFallbackProvider,
  POC_FALLBACK_NOTICE,
  activeEngineOf,
  pocUsageOf,
  pocTextVariantOf,
} from '../src/services/providers/cascadeFallbackProvider.ts';
import type { PocCapableProvider } from '../src/services/providers/cascadeFallbackProvider.ts';
import type { LiveProvider, LiveSessionOptions } from '../src/services/providers/types.ts';
import { emptyPocUsage, pocCostUsd, parsePocTextVariant, POC_TEXT_VARIANTS } from '../src/config/cascadePoc.ts';
import { pocCallUsageDelta, callUsageDelta, summarizeLearningLog } from '../src/services/usage/learningLog.ts';
import {
  buildUsageFields,
  estimateCostUsd,
  priceUsage,
  pocUsageCostUsd,
  USAGE_COST_COMPONENTS,
} from '../src/services/usage/usageService.ts';
import {
  POC_TEXT_VARIANT_TITLE,
  POC_TEXT_VARIANT_OPTION_LABELS,
} from '../src/ui/settings/settingsText.ts';

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

test('test-mode switch is OFF by default and only the exact value turns it on', () => {
  assert.equal(isCascadePocEnabled(mem()), false);
  assert.equal(isCascadePocEnabled(null), false);
  assert.equal(isCascadePocEnabled(), false, 'no localStorage in node → off');
  assert.equal(getCallEngine(mem()), 'live');
  for (const v of ['true', '1', 'CASCADE_POC', 'cascade_poc ', 'on']) {
    assert.equal(isCascadePocEnabled(mem({ [CALL_ENGINE_KEY]: v })), false, v);
  }
  const s = mem();
  setCascadePocEnabled(true, s);
  assert.equal(isCascadePocEnabled(s), true);
  assert.equal(getCallEngine(s), 'cascade_poc');
  setCascadePocEnabled(false, s);
  assert.equal(s.map.has(CALL_ENGINE_KEY), false, 'OFF removes the key');
  const throwing = { getItem: () => { throw new Error('denied'); } };
  assert.equal(isCascadePocEnabled(throwing), false);
});

function fakeProvider(name: string, log: string[], fail?: Error): LiveProvider & { getPocUsage: () => any } {
  return {
    name,
    async connect(o: LiveSessionOptions) {
      log.push(`${name}.connect`);
      if (fail) throw fail;
      o.onStatusChange('connected');
    },
    sendAudioChunk() {},
    sendTextPrompt(p: string) {
      log.push(`${name}.text:${p}`);
      return true;
    },
    appendUserText() {},
    sendControlCommand(c) {
      log.push(`${name}.cmd:${c}`);
    },
    getLiveTranscript: () => [],
    getResumeToken: () => null,
    getMediaStream: () => null,
    getConnectionStats: () => ({ connectionPath: 'proxy' as const, directFailCount: 0 }),
    async disconnect(notify?: boolean) {
      log.push(`${name}.disconnect:${notify === false ? 'silent' : 'notify'}`);
    },
    getPocUsage: () => ({ ...emptyPocUsage(), sttAudioSec: 30, turns: 2 }),
  };
}

function opts(statuses: [string, string | undefined][]): LiveSessionOptions {
  return {
    sessionId: 's',
    systemPrompt: 'p',
    onAudioData() {},
    onTranscript() {},
    onStatusChange: (s, m) => void statuses.push([s, m]),
  } as LiveSessionOptions;
}

test('fallback wrapper: test mode connects → PoC engine and PoC usage', async () => {
  const log: string[] = [];
  const p = new PocFallbackProvider(() => fakeProvider('poc', log) as PocCapableProvider, () => fakeProvider('live', log));
  await p.connect(opts([]));
  assert.equal(p.getEngine(), 'cascade_poc');
  assert.equal(activeEngineOf(p), 'cascade_poc');
  assert.equal(pocUsageOf(p)?.sttAudioSec, 30);
  p.sendControlCommand('Done');
  assert.deepEqual(log, ['poc.connect', 'poc.cmd:Done']);
});

test('fallback wrapper: PoC failure (e.g. 8 s timeout) → normal engine with notice, retries stay normal', async () => {
  const log: string[] = [];
  const statuses: [string, string | undefined][] = [];
  const origWarn = console.warn;
  const warns: string[] = [];
  console.warn = (m: string) => void warns.push(m);
  let made = 0;
  const p = new PocFallbackProvider(
    () => fakeProvider('poc', log, Object.assign(new Error('x'), { code: 'POC_READY_TIMEOUT' })) as PocCapableProvider,
    () => (made++, fakeProvider('live', log))
  );
  try {
    await p.connect(opts(statuses));
  } finally {
    console.warn = origWarn;
  }
  assert.equal(p.getEngine(), 'live');
  assert.equal(activeEngineOf(p), 'live');
  assert.equal(pocUsageOf(p), null, 'fallback call is not billed as PoC');
  assert.deepEqual(log, ['poc.connect', 'poc.disconnect:silent', 'live.connect']);
  assert.deepEqual(statuses, [['connecting', POC_FALLBACK_NOTICE], ['connected', undefined]]);
  assert.deepEqual(warns, ['[poc] fallback=live reason=POC_READY_TIMEOUT']);
  await p.connect(opts([]));
  assert.equal(made, 1, '다시 시도 reuses the normal engine');
  assert.deepEqual(log.slice(-1), ['live.connect']);
});

test('normal provider reports the live engine and no PoC usage', () => {
  const plain = fakeProvider('live', []);
  assert.equal(activeEngineOf(plain), 'live');
  assert.equal(pocUsageOf(plain), null);
  assert.equal(activeEngineOf(null), 'live');
});

test('PoC call usage goes to the variant\'s poc fields, never liveMinutes; calls still count', () => {
  const u = { ...emptyPocUsage(), sttAudioSec: 600, sttOutTokens: 1500, textInTokens: 300_000, textOutTokens: 6000, ttsInTokens: 3000, ttsAudioSec: 240, turns: 20 };
  const d = pocCallUsageDelta(600, false, u);
  assert.equal(d.liveMinutes, undefined);
  assert.equal(d.pocMinutes, 10);
  assert.equal(d.pocCalls, 1);
  assert.equal(d.calls, 1);
  assert.equal(d.pocATtsAudioSec, 240, 'default variant is A');
  assert.equal(d.pocTtsAudioSec, undefined, 'legacy untagged fields are no longer written');
  const qa = pocCallUsageDelta(600, true, u, 'b');
  assert.equal(qa.pocMinutes, undefined);
  assert.equal(qa.calls, undefined);
  assert.equal(qa.pocBSttAudioSec, 600, 'QA call: tokens only, in the B fields');
  assert.equal(qa.pocASttAudioSec, undefined);
  assert.equal(pocCallUsageDelta(5, false, u).calls, 0, 'calls under 10 s do not count');

  const now = Date.now();
  const fields = buildUsageFields(d, (n) => n);
  assert.equal(fields.liveMinutes, 0);
  assert.equal(fields.pocMinutes, 10);
  assert.equal(fields.pocATextInTokens, 300_000);
  assert.equal((fields as any).pocBTextInTokens, undefined, 'an A call never writes B fields');
  assert.equal((fields as any).pocTextInTokens, undefined, 'nor legacy fields');
  assert.ok(Math.abs((fields.estCostUsd as number) - pocUsageCostUsd(d, now)) < 1e-9);
  assert.ok(Math.abs(estimateCostUsd(d) - pocUsageCostUsd(d)) < 1e-9);
  const qaFields = buildUsageFields(qa, (n) => n);
  assert.equal(qaFields.pocBSttAudioSec, 600);
  assert.ok(Math.abs((qaFields.estCostUsd as number) - pocCostUsd(u, now, 'b')) < 1e-9, 'QA B call priced at B rates');
});

test('per-variant pricing: A and B tokens use their own text rates; untagged records use legacy rates', () => {
  const t2026 = Date.parse('2026-11-27T03:00:00Z');
  const t2027 = Date.parse('2027-01-02T00:00:00Z');
  const tok = { textInTokens: 1_000_000, textOutTokens: 1_000_000 };
  assert.ok(Math.abs(pocCostUsd(tok, t2026, 'a') - (0.75 + 3.75)) < 1e-12);
  assert.ok(Math.abs(pocCostUsd(tok, t2027, 'a') - (1.5 + 7.5)) < 1e-12);
  assert.ok(Math.abs(pocCostUsd(tok, t2026, 'b') - (0.3 + 2.5)) < 1e-12);
  assert.ok(Math.abs(pocCostUsd(tok, t2027, 'b') - (0.3 + 2.5)) < 1e-12, 'no 2027 change listed for 3.5-flash-lite');
  assert.ok(Math.abs(pocCostUsd(tok, t2026, 'legacy') - (0.25 + 1.5)) < 1e-12);
  // TTS: A and B share gemini-3.8-flash-tts ($9 audio); legacy = flash-lite-tts ($6)
  const tts = { ttsAudioSec: 40_000 }; // 1M audio tokens
  assert.ok(Math.abs(pocCostUsd(tts, t2026, 'a') - 9) < 1e-9);
  assert.ok(Math.abs(pocCostUsd(tts, t2026, 'b') - 9) < 1e-9);
  assert.ok(Math.abs(pocCostUsd(tts, t2026, 'legacy') - 6) < 1e-9);
  assert.ok(Math.abs(pocCostUsd(tts, t2027, 'legacy') - 12) < 1e-9);

  const month = {
    liveMinutes: 0, sttMinutes: 0, textTokens: 0, ttsChars: 0, estCostUsd: 0,
    pocTextInTokens: 1_000_000, // legacy
    pocATextInTokens: 1_000_000,
    pocBTextInTokens: 1_000_000,
  };
  const b = priceUsage(month);
  assert.ok(Math.abs(b.poc - pocUsageCostUsd(month, undefined, 'legacy')) < 1e-12);
  assert.ok(b.pocA > b.pocB && b.pocB > b.poc, 'A $0.75 > B $0.30 > legacy $0.25 per 1M input');
  assert.ok(Math.abs(b.total - (b.poc + b.pocA + b.pocB)) < 1e-12);
});

test('normal call usage write is unchanged: no poc* fields', () => {
  const fields = buildUsageFields(callUsageDelta(300, false, null), (n) => n);
  assert.equal(Object.keys(fields).some((k) => k.startsWith('poc')), false);
});

test('cost breakdown has 「시험 통화 비용 A/B」 rows plus the legacy row, and the total adds them', () => {
  assert.ok(USAGE_COST_COMPONENTS.some((c) => c.key === 'pocA' && c.label === '시험 통화 비용 A'));
  assert.ok(USAGE_COST_COMPONENTS.some((c) => c.key === 'pocB' && c.label === '시험 통화 비용 B'));
  assert.ok(USAGE_COST_COMPONENTS.some((c) => c.key === 'poc' && c.label === '시험 통화 비용(A/B 이전 기록)'));
  const month = { liveMinutes: 0, sttMinutes: 0, textTokens: 0, ttsChars: 0, estCostUsd: 0, pocBSttAudioSec: 600, pocBTtsAudioSec: 240 };
  const b = priceUsage(month);
  assert.ok(b.pocB > 0);
  assert.equal(b.pocA, 0);
  assert.equal(b.poc, 0);
  assert.equal(b.live, 0);
  assert.ok(Math.abs(b.total - b.pocB) < 1e-12);
  assert.equal(priceUsage(null).pocA, 0);
});

test('A/B variant: only "a"/"b" map to models; invalid values fall back to A', () => {
  assert.equal(parsePocTextVariant('b'), 'b');
  assert.equal(parsePocTextVariant(' B '), 'b');
  for (const bad of ['a', '', 'c', 'gemini-3.5-flash-lite', null, undefined, 1, {}, ['b']]) {
    assert.equal(parsePocTextVariant(bad), 'a', String(bad));
  }
  assert.equal(POC_TEXT_VARIANTS.a.model, 'gemini-3.8-flash');
  assert.equal(POC_TEXT_VARIANTS.a.thinkingLevel, 'low');
  assert.equal(POC_TEXT_VARIANTS.b.model, 'gemini-3.5-flash-lite');
  assert.equal(POC_TEXT_VARIANTS.b.thinkingLevel, 'minimal');
});

test('A/B setting: default A, saved B, ?pocText= overrides for the page load without saving', () => {
  const s = mem();
  assert.deepEqual(resolvePocTextVariant('', s), { variant: 'a', source: 'default' });
  assert.equal(getStoredPocTextVariant(s), 'a');
  setStoredPocTextVariant('b', s);
  assert.equal(s.map.get(POC_TEXT_VARIANT_KEY), 'b');
  assert.deepEqual(resolvePocTextVariant('', s), { variant: 'b', source: 'setting' });
  assert.deepEqual(resolvePocTextVariant('?qa=1&pocText=a', s), { variant: 'a', source: 'url' });
  assert.equal(s.map.get(POC_TEXT_VARIANT_KEY), 'b', 'URL override is not saved');
  assert.deepEqual(resolvePocTextVariant('?pocText=zzz', s), { variant: 'a', source: 'url' }, 'invalid URL value = A');
  setStoredPocTextVariant('a', s);
  assert.equal(s.map.has(POC_TEXT_VARIANT_KEY), false, 'A removes the key');
  assert.deepEqual(resolvePocTextVariant('?qa=1&pocText=b', s), { variant: 'b', source: 'url' });
  assert.equal(parsePocTextParam('?qa=1'), null);
  assert.equal(parsePocTextParam('pocText=B'), 'b');
  assert.equal(getStoredPocTextVariant(mem({ [POC_TEXT_VARIANT_KEY]: 'gemini-x' })), 'a', 'tampered storage = A');
  assert.deepEqual(resolvePocTextVariant(undefined, null), { variant: 'a', source: 'default' }, 'no window/localStorage in node');
});


test('learning log counts PoC call minutes as study time', () => {
  const s = summarizeLearningLog(
    { '2026-11': { liveMinutes: 0, sttMinutes: 0, textTokens: 0, ttsChars: 0, estCostUsd: 0, days: { '26': { calls: 0, pocMinutes: 4 } } } },
    '2026-11-26'
  );
  assert.equal(s.today.minutes, 4);
});

test('createLiveProvider: normal engine by default, wrapper only when the switch is on', async () => {
  const { createLiveProvider } = await import('../src/services/providers/index.ts');
  assert.equal(createLiveProvider().constructor.name, 'GeminiLiveProvider');
  assert.equal(createLiveProvider(false).constructor.name, 'GeminiLiveProvider');
  assert.ok(createLiveProvider(true) instanceof PocFallbackProvider);
});

test('pocTextVariantOf reports the variant of the test-mode call ("a" for the normal engine or unknown)', async () => {
  const log: string[] = [];
  const pocB = Object.assign(fakeProvider('poc', log), { getPocTextVariant: () => 'b' as const });
  const p = new PocFallbackProvider(() => pocB as PocCapableProvider, () => fakeProvider('live', log));
  await p.connect(opts([]));
  assert.equal(pocTextVariantOf(p), 'b');
  const noTag = new PocFallbackProvider(() => fakeProvider('poc', log) as PocCapableProvider, () => fakeProvider('live', log));
  await noTag.connect(opts([]));
  assert.equal(pocTextVariantOf(noTag), 'a');
  assert.equal(pocTextVariantOf(fakeProvider('live', log)), 'a');
  assert.equal(pocTextVariantOf(null), 'a');
});

test('A 확정 표시: 라벨·제목 문구와 명시적 B 선택 외 기본값 A 동작', () => {
  assert.ok(POC_TEXT_VARIANT_OPTION_LABELS.a.includes('확정'));
  assert.ok(POC_TEXT_VARIANT_OPTION_LABELS.b.includes('비교용'));
  assert.equal(POC_TEXT_VARIANT_TITLE.includes('A/B 비교'), false);

  const s = mem();
  assert.deepEqual(resolvePocTextVariant('', s), { variant: 'a', source: 'default' });
  assert.equal(s.map.has(POC_TEXT_VARIANT_KEY), false);

  setStoredPocTextVariant('b', s);
  assert.deepEqual(resolvePocTextVariant('', s), { variant: 'b', source: 'setting' });

  setStoredPocTextVariant('a', s);
  assert.deepEqual(resolvePocTextVariant('', s), { variant: 'a', source: 'default' });
  assert.equal(s.map.has(POC_TEXT_VARIANT_KEY), false);

  // Only an explicit B pick selects B; a URL override still wins over the stored value.
  setStoredPocTextVariant('b', s);
  assert.deepEqual(resolvePocTextVariant('?pocText=a', s), { variant: 'a', source: 'url' });
  setStoredPocTextVariant('a', s);

  for (const bad of ['B-model', 'gemini-3.5-flash-lite']) {
    const badStorage = mem({ [POC_TEXT_VARIANT_KEY]: bad });
    assert.equal(getStoredPocTextVariant(badStorage), 'a', bad);
    // A garbage stored value is still reported as source 'setting', but it never selects B.
    assert.equal(resolvePocTextVariant('', badStorage).variant, 'a', bad);
  }

  // Storage that throws (privacy mode): falls back to A, never B.
  const broken = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  assert.equal(getStoredPocTextVariant(broken), 'a');
  assert.doesNotThrow(() => setStoredPocTextVariant('b', broken));
  assert.deepEqual(resolvePocTextVariant('', broken), { variant: 'a', source: 'default' });
  assert.equal(getStoredPocTextVariant(mem({ [POC_TEXT_VARIANT_KEY]: '' })), 'a');
});
