import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALL_ENGINE_KEY,
  getCallEngine,
  isCascadePocEnabled,
  setCascadePocEnabled,
} from '../src/services/settings/callEngineSetting.ts';
import {
  PocFallbackProvider,
  POC_FALLBACK_NOTICE,
  activeEngineOf,
  pocUsageOf,
} from '../src/services/providers/cascadeFallbackProvider.ts';
import type { PocCapableProvider } from '../src/services/providers/cascadeFallbackProvider.ts';
import type { LiveProvider, LiveSessionOptions } from '../src/services/providers/types.ts';
import { emptyPocUsage } from '../src/config/cascadePoc.ts';
import { pocCallUsageDelta, callUsageDelta, summarizeLearningLog } from '../src/services/usage/learningLog.ts';
import {
  buildUsageFields,
  estimateCostUsd,
  priceUsage,
  pocUsageCostUsd,
  USAGE_COST_COMPONENTS,
} from '../src/services/usage/usageService.ts';

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

test('PoC call usage goes to poc* fields, never liveMinutes; calls still count', () => {
  const u = { ...emptyPocUsage(), sttAudioSec: 600, sttOutTokens: 1500, textInTokens: 300_000, textOutTokens: 6000, ttsInTokens: 3000, ttsAudioSec: 240, turns: 20 };
  const d = pocCallUsageDelta(600, false, u);
  assert.equal(d.liveMinutes, undefined);
  assert.equal(d.pocMinutes, 10);
  assert.equal(d.pocCalls, 1);
  assert.equal(d.calls, 1);
  assert.equal(d.pocTtsAudioSec, 240);
  const qa = pocCallUsageDelta(600, true, u);
  assert.equal(qa.pocMinutes, undefined);
  assert.equal(qa.calls, undefined);
  assert.equal(qa.pocSttAudioSec, 600);
  assert.equal(pocCallUsageDelta(5, false, u).calls, 0, 'calls under 10 s do not count');

  const now = Date.now();
  const fields = buildUsageFields(d, (n) => n);
  assert.equal(fields.liveMinutes, 0);
  assert.equal(fields.pocMinutes, 10);
  assert.equal(fields.pocTextInTokens, 300_000);
  assert.ok(Math.abs((fields.estCostUsd as number) - pocUsageCostUsd(d, now)) < 1e-9);
  assert.ok(Math.abs(estimateCostUsd(d) - pocUsageCostUsd(d)) < 1e-9);
});

test('normal call usage write is unchanged: no poc* fields', () => {
  const fields = buildUsageFields(callUsageDelta(300, false, null), (n) => n);
  assert.equal(Object.keys(fields).some((k) => k.startsWith('poc')), false);
});

test('cost breakdown has a 「시험 통화 비용」 row and the total adds it', () => {
  assert.ok(USAGE_COST_COMPONENTS.some((c) => c.key === 'poc' && c.label === '시험 통화 비용'));
  const month = { liveMinutes: 0, sttMinutes: 0, textTokens: 0, ttsChars: 0, estCostUsd: 0, pocSttAudioSec: 600, pocTtsAudioSec: 240 };
  const b = priceUsage(month);
  assert.ok(b.poc > 0);
  assert.equal(b.live, 0);
  assert.ok(Math.abs(b.total - b.poc) < 1e-12);
  assert.equal(priceUsage(null).poc, 0);
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
