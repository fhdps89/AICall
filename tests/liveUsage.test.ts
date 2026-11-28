import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUsageMetadata,
  createLiveUsageAccumulator,
  formatLiveUsageLog,
} from '../src/services/providers/liveUsage.ts';
import {
  sanitizeLiveUsageMetadata,
  tokensFromUsageMetadata,
} from '../server/usageMeta.ts';

test('parseUsageMetadata splits AUDIO/TEXT/other modalities from details and captures thoughts/cached/raw sums', () => {
  const parsed = parseUsageMetadata({
    promptTokenCount: 350,
    cachedContentTokenCount: 40,
    responseTokenCount: 180,
    thoughtsTokenCount: 25,
    totalTokenCount: 555,
    promptTokensDetails: [
      { modality: 'AUDIO', tokenCount: 200 },
      { modality: 'TEXT', tokenCount: 100 },
      { modality: 'IMAGE', tokenCount: 30 },
      { modality: 'VIDEO', tokenCount: 20 },
    ],
    responseTokensDetails: [
      { modality: 'AUDIO', tokenCount: 150 },
      { modality: 'TEXT', tokenCount: 20 },
      { modality: 'DOCUMENT', tokenCount: 10 },
    ],
  });

  assert.deepEqual(parsed, {
    turns: 1,
    inAudio: 200,
    inText: 150,
    outAudio: 150,
    outText: 30,
    thoughts: 25,
    cached: 40,
    promptTokens: 350,
    responseTokens: 180,
    totalTokens: 555,
    unsplitPromptTokens: 0,
  });
});

test('parseUsageMetadata falls back to inAudio/outAudio and records unsplitPromptTokens when details are absent or empty', () => {
  const parsed = parseUsageMetadata({
    promptTokenCount: 420,
    responseTokenCount: 130,
    totalTokenCount: 550,
    promptTokensDetails: [],
  });

  assert.deepEqual(parsed, {
    turns: 1,
    inAudio: 420,
    inText: 0,
    outAudio: 130,
    outText: 0,
    thoughts: 0,
    cached: 0,
    promptTokens: 420,
    responseTokens: 130,
    totalTokens: 550,
    unsplitPromptTokens: 420,
  });
});

test('parseUsageMetadata supports candidatesTokenCount alias and thoughtsTokenCount', () => {
  const parsed = parseUsageMetadata({
    promptTokenCount: 100,
    candidatesTokenCount: 75,
    thoughtsTokenCount: 15,
    totalTokenCount: 190,
  });

  assert.deepEqual(parsed, {
    turns: 1,
    inAudio: 100,
    inText: 0,
    outAudio: 75,
    outText: 0,
    thoughts: 15,
    cached: 0,
    promptTokens: 100,
    responseTokens: 75,
    totalTokens: 190,
    unsplitPromptTokens: 100,
  });
});

test('parseUsageMetadata ignores malformed payloads without throwing', () => {
  const badInputs: unknown[] = [
    null,
    undefined,
    'usage',
    123,
    [],
    {},
    { promptTokenCount: -10, responseTokenCount: NaN, totalTokenCount: Infinity },
    { promptTokenCount: '100', responseTokenCount: true, thoughtsTokenCount: null },
    { promptTokensDetails: 'not-an-array', responseTokensDetails: { modality: 'AUDIO', tokenCount: 50 } },
    { promptTokensDetails: [null, 'bad', { modality: 'AUDIO', tokenCount: '50' }, { modality: 'TEXT', tokenCount: -5 }] },
  ];

  for (const input of badInputs) {
    assert.equal(parseUsageMetadata(input), null);
  }

  // Partially malformed object still extracts valid numeric fields and ignores bad items.
  const partial = parseUsageMetadata({
    promptTokenCount: 200,
    responseTokenCount: -99,
    thoughtsTokenCount: NaN,
    promptTokensDetails: [
      null,
      { modality: 'AUDIO', tokenCount: 120 },
      { modality: 'TEXT', tokenCount: 'bad' },
      { modality: 'TEXT', tokenCount: -5 },
      { modality: 'TEXT', tokenCount: 80 },
    ],
  });
  assert.deepEqual(partial, {
    turns: 1,
    inAudio: 120,
    inText: 80,
    outAudio: 0,
    outText: 0,
    thoughts: 0,
    cached: 0,
    promptTokens: 200,
    responseTokens: 0,
    totalTokens: 0,
    unsplitPromptTokens: 0,
  });
});

test('accumulator uses last-wins within a turn, sums across committed turns, preserves across reconnect, and finalizes pending', () => {
  const acc = createLiveUsageAccumulator();
  assert.equal(acc.hasData(), false);

  // Turn 1: two snapshots before turnComplete -> only the latest counts.
  acc.observe({
    promptTokenCount: 100,
    responseTokenCount: 20,
    promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 100 }],
    responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 20 }],
  });
  acc.observe({
    promptTokenCount: 100,
    responseTokenCount: 60,
    thoughtsTokenCount: 10,
    promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 100 }],
    responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 60 }],
  });
  assert.equal(acc.hasData(), true);

  // snapshot() includes pending without mutating/committing.
  assert.equal(acc.snapshot().turns, 1);
  assert.equal(acc.snapshot().outAudio, 60);

  // Another update in same turn still replaces pending (because snapshot() did not commit).
  acc.observe({
    promptTokenCount: 100,
    responseTokenCount: 80,
    thoughtsTokenCount: 12,
    promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 100 }],
    responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 80 }],
  });
  acc.commitTurn();

  // Turn 2: committed on turnComplete.
  acc.observe({
    promptTokenCount: 250,
    responseTokenCount: 90,
    promptTokensDetails: [
      { modality: 'AUDIO', tokenCount: 200 },
      { modality: 'TEXT', tokenCount: 50 },
    ],
    responseTokensDetails: [
      { modality: 'AUDIO', tokenCount: 70 },
      { modality: 'TEXT', tokenCount: 20 },
    ],
  });
  acc.commitTurn();

  // Reconnect: commitTurn() on empty pending is a no-op and preserves totals.
  acc.commitTurn();

  // Turn 3 (after reconnect): left pending until finalize().
  acc.observe({
    promptTokenCount: 300,
    candidatesTokenCount: 50,
  });

  const snapBeforeFinalize = acc.snapshot();
  assert.equal(snapBeforeFinalize.turns, 3);
  assert.equal(snapBeforeFinalize.inAudio, 100 + 200 + 300);
  assert.equal(snapBeforeFinalize.inText, 50);
  assert.equal(snapBeforeFinalize.outAudio, 80 + 70 + 50);
  assert.equal(snapBeforeFinalize.outText, 20);
  assert.equal(snapBeforeFinalize.thoughts, 12);
  assert.equal(snapBeforeFinalize.unsplitPromptTokens, 300);

  const finalized = acc.finalize();
  assert.deepEqual(finalized, snapBeforeFinalize);
  // Calling finalize() again does not double-count the committed pending turn.
  assert.deepEqual(acc.finalize(), finalized);

  acc.reset();
  assert.equal(acc.hasData(), false);
  assert.equal(acc.snapshot().turns, 0);
  assert.equal(acc.snapshot().inAudio, 0);
});

test('formatLiveUsageLog emits single-line key=value numbers with 4-decimal Usd formatting', () => {
  const line = formatLiveUsageLog(
    {
      turns: 4,
      inAudio: 1200,
      inText: 300,
      outAudio: 800,
      outText: 50,
      thoughts: 40,
      cached: 0,
      promptTokens: 1500,
      responseTokens: 850,
      totalTokens: 2390,
      unsplitPromptTokens: 0,
    },
    { estUsd: 0.012345, durationSec: 95 },
  );

  assert.equal(
    line,
    '[live-usage] turns=4 inAudio=1200 inText=300 outAudio=800 outText=50 thoughts=40 estUsd=0.0123 durationSec=95',
  );
  assert.equal(line.includes('\n'), false);
});

test('sanitizeLiveUsageMetadata keeps only numeric counts and modality/tokenCount details', () => {
  const sanitized = sanitizeLiveUsageMetadata({
    promptTokenCount: 120,
    cachedContentTokenCount: 0,
    responseTokenCount: 80,
    candidatesTokenCount: 80,
    toolUsePromptTokenCount: 10,
    thoughtsTokenCount: 15,
    totalTokenCount: 225,
    secretTranscript: 'do not forward conversation text',
    promptTokensDetails: [
      { modality: 'AUDIO', tokenCount: 100, extra: 'drop-me' },
      { modality: 'TEXT', tokenCount: 20 },
      { modality: 'hello world text', tokenCount: 10 },
      { modality: 'AUDIO', tokenCount: -5 },
      null,
    ],
    responseTokensDetails: [
      { modality: 'AUDIO', tokenCount: 80 },
    ],
    cacheTokensDetails: 'not-an-array',
  });

  assert.deepEqual(sanitized, {
    promptTokenCount: 120,
    cachedContentTokenCount: 0,
    responseTokenCount: 80,
    candidatesTokenCount: 80,
    toolUsePromptTokenCount: 10,
    thoughtsTokenCount: 15,
    totalTokenCount: 225,
    promptTokensDetails: [
      { modality: 'AUDIO', tokenCount: 100 },
      { modality: 'TEXT', tokenCount: 20 },
    ],
    responseTokensDetails: [
      { modality: 'AUDIO', tokenCount: 80 },
    ],
  });
  assert.equal(JSON.stringify(sanitized).includes('do not forward'), false);
  assert.equal(sanitizeLiveUsageMetadata(null), null);
  assert.equal(sanitizeLiveUsageMetadata('str'), null);
  assert.equal(sanitizeLiveUsageMetadata({ extra: 'only-text' }), null);

  // Existing helper stays intact.
  assert.deepEqual(
    tokensFromUsageMetadata({ promptTokenCount: 50, candidatesTokenCount: 20, thoughtsTokenCount: 5 }),
    { inputTokens: 50, outputTokens: 25 },
  );
});

test('accumulator commits a late snapshot of the previous request instead of overwriting it', () => {
  const acc = createLiveUsageAccumulator();
  // Turn 1 snapshot arrives only after its turnComplete (nothing pending at commit time).
  acc.commitTurn();
  acc.observe({ promptTokenCount: 100, responseTokenCount: 20 });
  // Turn 2 snapshot has a different prompt size -> turn 1 is committed first, not replaced.
  acc.observe({ promptTokenCount: 180, responseTokenCount: 30 });
  acc.commitTurn();
  const t = acc.finalize();
  assert.equal(t.turns, 2);
  assert.equal(t.promptTokens, 280);
  assert.equal(t.responseTokens, 50);
});

test('accumulator does not double count a repeated snapshot of the same request after interrupted/turnComplete commit', () => {
  const acc = createLiveUsageAccumulator();
  const meta = (prompt: number, resp: number) => ({
    promptTokenCount: prompt,
    responseTokenCount: resp,
    promptTokensDetails: [{ modality: 'AUDIO', tokenCount: prompt }],
    responseTokensDetails: [{ modality: 'AUDIO', tokenCount: resp }],
  });
  acc.observe(meta(1000, 50));
  acc.commitTurn(); // interrupted
  acc.observe(meta(1000, 60)); // late update of the same request
  acc.commitTurn(); // turnComplete
  let t = acc.finalize();
  assert.equal(t.turns, 1);
  assert.equal(t.inAudio, 1000);
  assert.equal(t.outAudio, 60);

  acc.observe(meta(1800, 40)); // next request
  acc.commitTurn();
  t = acc.finalize();
  assert.equal(t.turns, 2);
  assert.equal(t.inAudio, 2800);
  assert.equal(t.outAudio, 100);
});

test('peakPromptTokens tracks the largest single-turn promptTokenCount and resets', () => {
  const acc = createLiveUsageAccumulator();
  assert.equal(acc.peakPromptTokens(), 0);
  acc.observe({ promptTokenCount: 5000 });
  acc.commitTurn();
  acc.observe({ promptTokenCount: 11800 });
  acc.commitTurn();
  acc.observe({ promptTokenCount: 6200 }); // after a compression the context drops back
  acc.commitTurn();
  acc.observe({ promptTokenCount: 'x' });
  acc.observe(null);
  assert.equal(acc.peakPromptTokens(), 11800);
  assert.equal(acc.finalize().promptTokens, 5000 + 11800 + 6200);
  acc.reset();
  assert.equal(acc.peakPromptTokens(), 0);
});

test('formatLiveUsageLog carries peakPrompt/ctxTrigger/ctxTarget extras', () => {
  const acc = createLiveUsageAccumulator();
  acc.observe({ promptTokenCount: 100, responseTokenCount: 10 });
  const line = formatLiveUsageLog(acc.finalize(), { peakPrompt: 100, ctxTrigger: 12000, ctxTarget: 6000 });
  assert.match(line, /peakPrompt=100 ctxTrigger=12000 ctxTarget=6000$/);
});
