import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildUsageFields,
  estimateCostUsd,
  liveCostEstimateUsd,
  liveMeasuredCostUsd,
  liveUsageBasis,
  priceUsage,
  USAGE_COST_COMPONENTS,
  type UsageDay,
  type UsageMonth,
} from '../src/services/usage/usageService.ts';
import { callUsageDelta, liveContextMinutesSq } from '../src/services/usage/learningLog.ts';
import { PRICING_RATES, USAGE_ASSUMPTIONS } from '../src/config/models.ts';
import { recoveredCallUsage } from '../src/services/session/recoveredUsage.ts';
import { tokensFromUsageMetadata } from '../server/usageMeta.ts';
import {
  createCachedSegmentSynth,
  sanitizeLectureScriptPayload,
} from '../server/lecture.ts';

test('priceUsage: empty doc returns 0 across all fields with calls=0 and no NaN', () => {
  const empty = priceUsage({
    liveMinutes: 0,
    sttMinutes: 0,
    textTokens: 0,
    ttsChars: 0,
    estCostUsd: 0,
    calls: 0,
  });
  assert.deepEqual(empty, {
    live: 0,
    qaLive: 0,
    stt: 0,
    text: 0,
    tts: 0,
    sie: 0,
    poc: 0,
    pocA: 0,
    pocB: 0,
    pocTtsLite: 0,
    total: 0,
  });

  const malformed = priceUsage({
    liveMinutes: Number.NaN,
    qaLiveMinutes: -3,
    liveMinutesSq: Number.POSITIVE_INFINITY,
    sttMinutes: -1,
    textTokens: Number.NaN,
    ttsChars: -10,
    calls: 0,
  });
  for (const val of Object.values(malformed)) {
    assert.equal(Number.isFinite(val), true);
    assert.equal(val, 0);
  }
  assert.deepEqual(priceUsage(null), empty);
  assert.deepEqual(priceUsage(undefined), empty);
});

// Updated for the new STT rule: STT is now (sttMinutes + partialSttMinutes) * geminiSttPerMinute
// rather than unconditionally adding liveMinutes + qaLiveMinutes. Legacy docs have no partialSttMinutes,
// so stt drops from $0.3468 to $0.1239 (24.3 min * $0.0051/min) and total from $4.03 to $3.80,
// while live cost ($2.3979) is unchanged.
test('priceUsage: legacy month matches calculation without measured fields (total ≈ $3.80, live ≈ $2.40)', () => {
  const legacyMonth: UsageMonth = {
    calls: 16,
    liveMinutes: 43.7,
    sttMinutes: 24.3,
    textTokens: 318298,
    ttsChars: 33217,
    estCostUsd: 0.367,
  };
  const b = priceUsage(legacyMonth);
  assert.ok(Math.abs(b.live - 2.3979) < 0.01, `expected live ≈ 2.40, got ${b.live}`);
  assert.ok(Math.abs(b.stt - 0.12393) < 0.001, `expected stt ≈ 0.1239, got ${b.stt}`);
  assert.ok(Math.abs(b.text - 0.5252) < 0.01, `expected text ≈ 0.53, got ${b.text}`);
  assert.ok(Math.abs(b.tts - 0.7557) < 0.01, `expected tts ≈ 0.76, got ${b.tts}`);
  assert.ok(Math.abs(b.total - 3.8027) < 0.01, `expected total ≈ 3.80, got ${b.total}`);
  assert.ok(Math.abs(b.live - 2.40) < 0.05);
});

test('priceUsage: additive across components when Sq is present', () => {
  const a: UsageDay = {
    liveMinutes: 3,
    liveMinutesSq: 9,
    qaLiveMinutes: 2,
    qaLiveMinutesSq: 4,
    sttMinutes: 1.5,
    textTokens: 1500,
    textInputTokens: 1000,
    textOutputTokens: 500,
    ttsChars: 400,
    ttsAudioSec: 36,
    ttsAudioChars: 400,
    sieEmbeddingTokens: 2000,
    calls: 1,
  };
  const b: UsageDay = {
    liveMinutes: 5,
    liveMinutesSq: 25,
    qaLiveMinutes: 4,
    qaLiveMinutesSq: 16,
    sttMinutes: 2.5,
    textTokens: 2500,
    textInputTokens: 1800,
    textOutputTokens: 700,
    ttsChars: 600,
    ttsAudioSec: 55,
    ttsAudioChars: 600,
    sieEmbeddingTokens: 3000,
    calls: 1,
  };
  const sum: UsageDay = {
    liveMinutes: (a.liveMinutes || 0) + (b.liveMinutes || 0),
    liveMinutesSq: (a.liveMinutesSq || 0) + (b.liveMinutesSq || 0),
    qaLiveMinutes: (a.qaLiveMinutes || 0) + (b.qaLiveMinutes || 0),
    qaLiveMinutesSq: (a.qaLiveMinutesSq || 0) + (b.qaLiveMinutesSq || 0),
    sttMinutes: (a.sttMinutes || 0) + (b.sttMinutes || 0),
    textTokens: (a.textTokens || 0) + (b.textTokens || 0),
    textInputTokens: (a.textInputTokens || 0) + (b.textInputTokens || 0),
    textOutputTokens: (a.textOutputTokens || 0) + (b.textOutputTokens || 0),
    ttsChars: (a.ttsChars || 0) + (b.ttsChars || 0),
    ttsAudioSec: (a.ttsAudioSec || 0) + (b.ttsAudioSec || 0),
    ttsAudioChars: (a.ttsAudioChars || 0) + (b.ttsAudioChars || 0),
    sieEmbeddingTokens: (a.sieEmbeddingTokens || 0) + (b.sieEmbeddingTokens || 0),
    calls: (a.calls || 0) + (b.calls || 0),
  };

  const pa = priceUsage(a);
  const pb = priceUsage(b);
  const psum = priceUsage(sum);
  assert.ok(Math.abs(pa.live + pb.live - psum.live) < 1e-12);
  assert.ok(Math.abs(pa.qaLive + pb.qaLive - psum.qaLive) < 1e-12);
  assert.ok(Math.abs(pa.stt + pb.stt - psum.stt) < 1e-12);
  assert.ok(Math.abs(pa.text + pb.text - psum.text) < 1e-12);
  assert.ok(Math.abs(pa.tts + pb.tts - psum.tts) < 1e-12);
  assert.ok(Math.abs(pa.sie + pb.sie - psum.sie) < 1e-12);
  assert.ok(Math.abs(pa.total + pb.total - psum.total) < 1e-12);
});

test('priceUsage: mixed legacy + new month uses max(liveMinutesSq, liveMinutes^2/calls) lower bound', () => {
  // 2 calls totaling 10 min: one legacy 8m (Sq not stored) + one new 2m (Sq=4).
  // liveMinutesSq=4 < lower bound 2 × liveContextMinutesSq(5) = 2 × (2·4·5 − 4²) = 48 (12k/6k cap = 4 min) -> 48 applies.
  const mixed = priceUsage({
    liveMinutes: 10,
    liveMinutesSq: 4,
    calls: 2,
    sttMinutes: 0,
    textTokens: 0,
    ttsChars: 0,
    estCostUsd: 0,
  });
  const lowerBound = priceUsage({
    liveMinutes: 10,
    liveMinutesSq: 48,
    calls: 2,
    sttMinutes: 0,
    textTokens: 0,
    ttsChars: 0,
    estCostUsd: 0,
  });
  assert.ok(Math.abs(mixed.live - lowerBound.live) < 1e-12);

  // When actual Sq > liveMinutes^2/calls (e.g. 9m + 1m => Sq=82 > 48), stored Sq is kept.
  const skewed = priceUsage({
    liveMinutes: 10,
    liveMinutesSq: 82,
    calls: 2,
    sttMinutes: 0,
    textTokens: 0,
    ttsChars: 0,
    estCostUsd: 0,
  });
  assert.ok(skewed.live > lowerBound.live);

  // QA fallback when qaLiveMinutesSq is missing uses qaLiveMinutes^2 as 1-call lower bound.
  const qaFallback = priceUsage({ qaLiveMinutes: 4 });
  const qaExplicitSingle = priceUsage({ qaLiveMinutes: 4, qaLiveMinutesSq: 16 });
  const qaTwoCalls = priceUsage({ qaLiveMinutes: 4, qaLiveMinutesSq: 8 });
  assert.ok(Math.abs(qaFallback.qaLive - qaExplicitSingle.qaLive) < 1e-12);
  assert.ok(qaTwoCalls.qaLive < qaExplicitSingle.qaLive);
});

test('buildUsageFields stores all 7 new fields and keeps textTokens as in+out+legacy total', () => {
  const delta = {
    liveMinutes: 4,
    qaLiveMinutes: 2,
    liveMinutesSq: 16,
    qaLiveMinutesSq: 4,
    sttMinutes: 1,
    textInputTokens: 600,
    textOutputTokens: 300,
    textTokens: 100,
    ttsChars: 500,
    ttsAudioSec: 32.5,
    ttsAudioChars: 350,
    sieEmbeddingTokens: 1000,
    calls: 1,
  };
  const fields = buildUsageFields(delta, (n) => n);
  assert.equal(fields.liveMinutes, 4);
  assert.equal(fields.qaLiveMinutes, 2);
  assert.equal(fields.liveMinutesSq, 16);
  assert.equal(fields.qaLiveMinutesSq, 4);
  assert.equal(fields.textInputTokens, 600);
  assert.equal(fields.textOutputTokens, 300);
  assert.equal(fields.textTokens, 1000);
  assert.equal(fields.ttsChars, 500);
  assert.equal(fields.ttsAudioSec, 32.5);
  assert.equal(fields.ttsAudioChars, 350);
  assert.equal(fields.estCostUsd, estimateCostUsd(delta));
});

test('callUsageDelta: QA has qaLiveMinutes & qaLiveMinutesSq and no calls; normal has liveMinutesSq', () => {
  const qa = callUsageDelta(180, true);
  assert.deepEqual(qa, { qaLiveMinutes: 3, qaLiveMinutesSq: 9 });
  assert.equal('calls' in qa, false);
  assert.equal('liveMinutes' in qa, false);

  const normal = callUsageDelta(180, false);
  assert.deepEqual(normal, { liveMinutes: 3, liveMinutesSq: 9, calls: 1 });
});

test('recoveredCallUsage includes liveMinutesSq', () => {
  const rec = recoveredCallUsage(
    {
      startedAt: '2026-11-25T01:00:00.000Z',
      lastChunkAt: '2026-11-25T01:03:00.000Z',
      liveTranscript: [],
    },
    '2026-11-25'
  );
  assert.deepEqual(rec, { liveMinutes: 3, liveMinutesSq: 9, calls: 1 });
});

test('tokensFromUsageMetadata adds thoughtsTokenCount to outputTokens and handles missing values', () => {
  assert.deepEqual(
    tokensFromUsageMetadata({
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 250,
    }),
    { inputTokens: 100, outputTokens: 300 }
  );
  assert.deepEqual(tokensFromUsageMetadata(undefined), { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(tokensFromUsageMetadata(null), { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(tokensFromUsageMetadata({ promptTokenCount: 40 }), { inputTokens: 40, outputTokens: 0 });
});

test('lecture billed TTS helper excludes cache hits and sanitizeLectureScriptPayload accepts new fields', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lecture-tts-bill-'));
  try {
    let missCalls = 0;
    const rate = 24000;
    // First run synthesizes two segments and writes cache files.
    const tracker1 = createCachedSegmentSynth({
      segDir: tmpDir,
      rate,
      synthOne: async (text) => {
        // 1 second per char for easy sample verification
        return { data: Buffer.alloc(text.length * rate * 2), rate };
      },
      onMiss: () => {
        missCalls += 1;
      },
    });
    await tracker1.synth(0, 'hello', false); // 5 chars -> 5s
    await tracker1.synth(1, 'world!', false); // 6 chars -> 6s
    assert.equal(missCalls, 2);
    assert.equal(tracker1.billedChars(), 11);
    assert.equal(tracker1.billedSamples(), 11 * rate);

    // Second run with same segDir hits cache for seg 0 and misses for seg 2.
    let missCalls2 = 0;
    const tracker2 = createCachedSegmentSynth({
      segDir: tmpDir,
      rate,
      synthOne: async (text) => ({ data: Buffer.alloc(text.length * rate * 2), rate }),
      onMiss: () => {
        missCalls2 += 1;
      },
    });
    await tracker2.synth(0, 'hello', false); // cache hit -> 0 billed
    await tracker2.synth(2, 'abc', false); // cache miss -> 3 chars, 3s
    assert.equal(missCalls2, 1);
    assert.equal(tracker2.billedChars(), 3);
    assert.equal(tracker2.billedSamples(), 3 * rate);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const sanitized = sanitizeLectureScriptPayload({
    script: [
      {
        mistakeId: 'm1',
        kind: 'new',
        myPhrase: 'I go yesterday',
        naturalPhrase: 'I went yesterday',
        explanation: '과거형',
        dialogue: [
          { speaker: 'Coach', line: 'Try again' },
          { speaker: 'Partner', line: 'I went yesterday.' },
        ],
        meaningKo: '어제 갔어',
        answerEnglish: 'I went yesterday',
        similarExample: 'I went home early.',
      },
    ],
    textTokens: 1200,
    textInputTokens: 400,
    textOutputTokens: 800,
    ttsAudioSec: 42.3,
    ttsAudioChars: 410,
  });
  assert.equal(sanitized.ok, true);
  if (sanitized.ok) {
    assert.equal(sanitized.payload.textTokens, 1200);
    assert.equal(sanitized.payload.textInputTokens, 400);
    assert.equal(sanitized.payload.textOutputTokens, 800);
    assert.equal(sanitized.payload.ttsAudioSec, 42.3);
    assert.equal(sanitized.payload.ttsAudioChars, 410);
  }
});

test('live context re-billing is capped by the sliding context window for very long calls', async () => {
  const { liveContextMinutesSq } = await import('../src/services/usage/learningLog.ts');
  const { USAGE_ASSUMPTIONS } = await import('../src/config/models.ts');
  const a = USAGE_ASSUMPTIONS;
  const capMin = a.liveContextWindowTokens / (a.audioTokensPerSec * 60 * (1 + a.liveModelTalkShare));
  // 12k/6k compression: average history 9k tokens = 4 minutes at 2,250 tok/min, so a 10-minute call is 2·4·10 − 4² = 64.
  assert.equal(capMin, 4);
  assert.equal(liveContextMinutesSq(3), 9);
  assert.equal(liveContextMinutesSq(10), 64);
  assert.equal(liveContextMinutesSq(0), 0);
  assert.equal(liveContextMinutesSq(-5), 0);
  assert.equal(liveContextMinutesSq(Number.NaN), 0);
  const t = 180;
  const expected = 2 * capMin * t - capMin * capMin;
  assert.ok(Math.abs(liveContextMinutesSq(t) - expected) < 1e-9);
  assert.ok(liveContextMinutesSq(t) < t * t);
  // continuous at the cap
  assert.ok(Math.abs(liveContextMinutesSq(capMin) - capMin * capMin) < 1e-9);
});

test('lecture audio cost per minute is derived from the TTS rate (1,500 tok/min x $9/M)', async () => {
  const { lectureAudioCostPerMinute } = await import('../src/services/usage/usageService.ts');
  assert.ok(Math.abs(lectureAudioCostPerMinute() - 0.0135) < 1e-12);
});

test('createCachedSegmentSynth: failed synth is not billed; corrupt (odd-length) cache is re-synthesized and billed', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'segsynth-edge-'));
  try {
    const rate = 24000;
    let misses = 0;
    const failing = createCachedSegmentSynth({
      segDir: tmpDir,
      rate,
      synthOne: async () => {
        throw new Error('429');
      },
      onMiss: () => {
        misses += 1;
      },
    });
    await assert.rejects(failing.synth(0, 'abc', false), /429/);
    assert.equal(misses, 0);
    assert.equal(failing.billedSamples(), 0);
    assert.equal(failing.billedChars(), 0);

    const ok = createCachedSegmentSynth({
      segDir: tmpDir,
      rate,
      synthOne: async (text) => ({ data: Buffer.alloc(text.length * rate * 2), rate }),
      onMiss: () => {
        misses += 1;
      },
    });
    await ok.synth(7, 'xy', false);
    const cacheFile = fs.readdirSync(tmpDir).find((f) => f.startsWith('7-') && f.endsWith('.pcm'));
    assert.ok(cacheFile);
    fs.writeFileSync(path.join(tmpDir, cacheFile!), Buffer.alloc(3)); // corrupt: odd length
    const again = createCachedSegmentSynth({
      segDir: tmpDir,
      rate,
      synthOne: async (text) => ({ data: Buffer.alloc(text.length * rate * 2), rate }),
    });
    await again.synth(7, 'xy', false);
    assert.equal(again.billedChars(), 2);
    assert.equal(again.billedSamples(), 2 * rate);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('legacy live lower bound uses calls x capped Sq at the average call length', async () => {
  const { liveContextMinutesSq } = await import('../src/services/usage/learningLog.ts');
  const legacy = priceUsage({ liveMinutes: 200, calls: 2, sttMinutes: 0, textTokens: 0, ttsChars: 0, estCostUsd: 0 });
  const explicit = priceUsage({
    liveMinutes: 200,
    calls: 2,
    liveMinutesSq: 2 * liveContextMinutesSq(100),
    sttMinutes: 0,
    textTokens: 0,
    ttsChars: 0,
    estCostUsd: 0,
  });
  assert.ok(Math.abs(legacy.live - explicit.live) < 1e-12);
  // the average (100 min) is past the cap, so the bound is below the uncapped calls x avg²
  assert.ok(2 * liveContextMinutesSq(100) < 2 * 100 * 100);
});

test('USAGE_COST_COMPONENTS keys match non-total keys of priceUsage output exactly', () => {
  const breakdownKeys = Object.keys(priceUsage(null)).filter((k) => k !== 'total');
  const componentKeys = USAGE_COST_COMPONENTS.map((c) => c.key);
  assert.equal(new Set(componentKeys).size, componentKeys.length);
  assert.deepEqual([...componentKeys].sort(), [...breakdownKeys].sort());
});

test('USAGE_COST_COMPONENTS sum equals total for a sample month with all components non-zero', () => {
  const sampleMonth: UsageMonth = {
    calls: 4,
    liveMinutes: 12,
    liveMinutesSq: 40,
    qaLiveMinutes: 3,
    qaLiveMinutesSq: 9,
    sttMinutes: 5,
    textTokens: 6000,
    textInputTokens: 4000,
    textOutputTokens: 2000,
    ttsChars: 1200,
    ttsAudioSec: 80,
    ttsAudioChars: 1200,
    sieEmbeddingTokens: 25000,
    pocSttAudioSec: 120,
    pocTtsAudioSec: 40,
    pocASttAudioSec: 60,
    pocBTtsAudioSec: 30,
    pocTtsLiteAudioSec: 10,
    estCostUsd: 0,
  };
  const breakdown = priceUsage(sampleMonth);
  let sum = 0;
  for (const { key } of USAGE_COST_COMPONENTS) {
    assert.ok(breakdown[key] > 0, `expected ${key} > 0, got ${breakdown[key]}`);
    sum += breakdown[key];
  }
  assert.ok(Math.abs(sum - breakdown.total) < 1e-12, `expected sum ${sum} === total ${breakdown.total}`);
});

test('USAGE_COST_COMPONENTS labels are non-empty Korean strings without internal identifiers', () => {
  for (const { key, label } of USAGE_COST_COMPONENTS) {
    assert.equal(typeof label, 'string');
    assert.ok(label.trim().length > 0, `empty label for ${key}`);
    assert.match(label, /[\uAC00-\uD7AF]/, `expected Korean text in label for ${key}: ${label}`);
    assert.doesNotMatch(label, /[a-z_]/, `unexpected identifier-like token in label for ${key}: ${label}`);
  }
});

function assertComponentsSumToTotal(b: ReturnType<typeof priceUsage>) {
  const sum = USAGE_COST_COMPONENTS.reduce((acc, { key }) => acc + b[key], 0);
  assert.ok(Math.abs(sum - b.total) < 1e-12, `expected sum ${sum} === total ${b.total}`);
}

const GEMINI_STT_PER_MIN =
  (USAGE_ASSUMPTIONS.audioTokensPerSec * 60 * PRICING_RATES.sttInAudioPer1M +
    USAGE_ASSUMPTIONS.sttOutTokensPerMin * PRICING_RATES.sttOutTextPer1M) /
  1_000_000;

test('STT pricing: partial STT OFF does not charge liveMinutes/qaLiveMinutes; partialSttMinutes priced exactly', () => {
  // Partial STT OFF: liveMinutes & qaLiveMinutes alone add 0 STT cost
  const off = priceUsage({
    liveMinutes: 10,
    liveMinutesSq: 100,
    qaLiveMinutes: 5,
    qaLiveMinutesSq: 25,
    sttMinutes: 4,
    calls: 1,
  });
  assert.ok(Math.abs(off.stt - 4 * GEMINI_STT_PER_MIN) < 1e-12);
  assertComponentsSumToTotal(off);

  const liveOnly = priceUsage({ liveMinutes: 10, liveMinutesSq: 100, calls: 1 });
  assert.equal(liveOnly.stt, 0);
  assertComponentsSumToTotal(liveOnly);

  // Partial STT ON: partialSttMinutes priced at geminiSttPerMinute
  const on = priceUsage({
    liveMinutes: 10,
    liveMinutesSq: 100,
    sttMinutes: 4,
    partialSttMinutes: 3,
    calls: 1,
  });
  assert.ok(Math.abs(on.stt - 7 * GEMINI_STT_PER_MIN) < 1e-12);
  assertComponentsSumToTotal(on);

  // AssemblyAI branch in estimateCostUsd uses partialSttMinutes (not liveMinutes + qaLiveMinutes)
  const asm = estimateCostUsd({
    liveMinutes: 10,
    liveMinutesSq: 100,
    qaLiveMinutes: 5,
    qaLiveMinutesSq: 25,
    sttMinutes: 4,
    partialSttMinutes: 2,
    sttEngine: 'assemblyai',
    calls: 1,
  });
  const expectedAsm =
    on.live +
    priceUsage({ qaLiveMinutes: 5, qaLiveMinutesSq: 25 }).qaLive +
    4 * PRICING_RATES.sttPerMinuteAssembly +
    2 * GEMINI_STT_PER_MIN;
  assert.ok(Math.abs(asm - expectedAsm) < 1e-12);
});

test('measured Live tokens: priceUsage and estimateCostUsd match hand-computed token * rate (including thoughts at $4.5/1M)', () => {
  assert.equal(PRICING_RATES.liveOutTextPer1M, 4.5);

  const delta = {
    liveMinutes: 5,
    liveMinutesSq: 25,
    calls: 1,
    liveInputAudioTokens: 200_000,
    liveInputTextTokens: 100_000,
    liveOutputAudioTokens: 50_000,
    liveOutputTextTokens: 20_000,
    liveThoughtTokens: 30_000,
    liveMeasuredMinutes: 5,
    liveMeasuredMinutesSq: 25,
    liveMeasuredCalls: 1,
  };
  const handComputed =
    (200_000 * 3 + 100_000 * 0.75 + 50_000 * 12 + (20_000 + 30_000) * 4.5) / 1_000_000;
  // = (600_000 + 75_000 + 600_000 + 225_000) / 1_000_000 = 1.5

  assert.ok(Math.abs(handComputed - 1.5) < 1e-12);
  assert.ok(
    Math.abs(
      liveMeasuredCostUsd({
        inAudio: 200_000,
        inText: 100_000,
        outAudio: 50_000,
        outText: 20_000,
        thoughts: 30_000,
      }) - handComputed
    ) < 1e-12
  );

  const b = priceUsage(delta);
  assert.ok(Math.abs(b.live - handComputed) < 1e-12);
  assert.equal(b.qaLive, 0);
  assert.equal(b.stt, 0);
  assert.ok(Math.abs(b.total - handComputed) < 1e-12);
  assertComponentsSumToTotal(b);

  assert.ok(Math.abs(estimateCostUsd(delta) - handComputed) < 1e-12);

  const fields = buildUsageFields(delta, (n) => n);
  assert.equal(fields.liveInputAudioTokens, 200_000);
  assert.equal(fields.liveInputTextTokens, 100_000);
  assert.equal(fields.liveOutputAudioTokens, 50_000);
  assert.equal(fields.liveOutputTextTokens, 20_000);
  assert.equal(fields.liveThoughtTokens, 30_000);
  assert.equal(fields.liveMeasuredMinutes, 5);
  assert.equal(fields.liveMeasuredMinutesSq, 25);
  assert.equal(fields.liveMeasuredCalls, 1);
  assert.equal(fields.partialSttMinutes, 0);
  assert.ok(Math.abs(fields.estCostUsd - handComputed) < 1e-12);
});

test('mixed month: measured minutes + legacy minutes prices measured tokens plus estimate for remainder only; measured >= liveMinutes has 0 remainder', () => {
  // 1 legacy call (8 min, Sq not stored -> lower bound 8^2 = 64) + 1 measured call (2 min, Sq=4)
  const measuredUsd = (100_000 * 3 + 10_000 * 12) / 1_000_000; // $0.42
  const legacyOnly = priceUsage({ liveMinutes: 8, calls: 1 });
  const mixed = priceUsage({
    liveMinutes: 10,
    liveMinutesSq: 4,
    calls: 2,
    liveInputAudioTokens: 100_000,
    liveOutputAudioTokens: 10_000,
    liveMeasuredMinutes: 2,
    liveMeasuredMinutesSq: 4,
    liveMeasuredCalls: 1,
  });
  assert.ok(Math.abs(mixed.live - (measuredUsd + legacyOnly.live)) < 1e-12);
  assertComponentsSumToTotal(mixed);

  const basis = liveUsageBasis({
    liveMinutes: 10,
    liveMinutesSq: 4,
    calls: 2,
    liveInputAudioTokens: 100_000,
    liveOutputAudioTokens: 10_000,
    liveMeasuredMinutes: 2,
    liveMeasuredMinutesSq: 4,
    liveMeasuredCalls: 1,
  });
  assert.equal(basis.measuredMinutes, 2);
  assert.equal(basis.estimatedMinutes, 8);
  assert.ok(Math.abs(basis.measuredUsd - measuredUsd) < 1e-12);
  assert.ok(Math.abs(basis.estimatedUsd - legacyOnly.live) < 1e-12);

  // Guard: measuredMinutes >= liveMinutes -> remainder is 0 (no negative, no double count)
  const overMeasured = priceUsage({
    liveMinutes: 3,
    liveMinutesSq: 9,
    calls: 1,
    liveInputAudioTokens: 100_000,
    liveOutputAudioTokens: 10_000,
    liveMeasuredMinutes: 5,
    liveMeasuredMinutesSq: 25,
    liveMeasuredCalls: 2,
  });
  assert.ok(Math.abs(overMeasured.live - measuredUsd) < 1e-12);
  assertComponentsSumToTotal(overMeasured);
  const overBasis = liveUsageBasis({
    liveMinutes: 3,
    liveMinutesSq: 9,
    calls: 1,
    liveInputAudioTokens: 100_000,
    liveOutputAudioTokens: 10_000,
    liveMeasuredMinutes: 5,
    liveMeasuredMinutesSq: 25,
    liveMeasuredCalls: 2,
  });
  assert.equal(overBasis.estimatedMinutes, 0);
  assert.equal(overBasis.estimatedUsd, 0);
});

test('QA measured tokens are priced into qaLive only and never leak into live', () => {
  const qaExpected = (80_000 * 3 + 40_000 * 0.75 + 25_000 * 12 + (10_000 + 15_000) * 4.5) / 1_000_000;
  const qaDoc: UsageDay = {
    qaLiveMinutes: 4,
    qaLiveMinutesSq: 16,
    qaLiveInputAudioTokens: 80_000,
    qaLiveInputTextTokens: 40_000,
    qaLiveOutputAudioTokens: 25_000,
    qaLiveOutputTextTokens: 10_000,
    qaLiveThoughtTokens: 15_000,
    qaLiveMeasuredMinutes: 4,
    qaLiveMeasuredMinutesSq: 16,
  };
  const b = priceUsage(qaDoc);
  assert.equal(b.live, 0);
  assert.ok(Math.abs(b.qaLive - qaExpected) < 1e-12);
  assert.ok(Math.abs(b.total - qaExpected) < 1e-12);
  assertComponentsSumToTotal(b);

  // Mixed QA: 4 min measured + 2 min estimated (sq = 16 + 4 = 20 -> rem sq = 4)
  const qaMixed = priceUsage({
    ...qaDoc,
    qaLiveMinutes: 6,
    qaLiveMinutesSq: 20,
  });
  const remEst = liveCostEstimateUsd(2, 4);
  assert.equal(qaMixed.live, 0);
  assert.ok(Math.abs(qaMixed.qaLive - (qaExpected + remEst)) < 1e-12);
  assertComponentsSumToTotal(qaMixed);
});

test('liveContextMinutesSq custom windowTokens shrinks cap for long calls while default is unchanged', () => {
  const def = liveContextMinutesSq(120);
  const custom = liveContextMinutesSq(120, 4_500);
  assert.ok(custom < def);
  assert.equal(liveContextMinutesSq(120, 0), def);
  assert.equal(liveContextMinutesSq(120, -1), def);
  assert.equal(liveContextMinutesSq(120, Number.NaN), def);
});
