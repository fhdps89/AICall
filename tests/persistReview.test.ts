import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MistakeData, SessionReviewData, SttFinalData } from '../src/services/firebase/db.ts';
import {
  persistReviewOutcome,
  type PersistReviewDeps,
  type PersistReviewInput,
} from '../src/services/review/persistReview.ts';

function makeReview(overrides: Partial<SessionReviewData> = {}): SessionReviewData {
  return {
    overallEvaluation: 'Good job',
    estimatedLevel: 'IH',
    mistakes: [
      { myPhrase: 'I go yesterday', naturalPhrase: 'I went yesterday', reason: 'past tense', sourceStt: 'sttFinal' },
      { myPhrase: 'He like it', naturalPhrase: 'He likes it', reason: '3rd person s', sourceStt: 'sttFinal' },
    ],
    extraMistakes: [
      { myPhrase: 'Extra phrase', naturalPhrase: 'Better extra', reason: 'naturalness', sourceStt: 'sttFinal' },
    ],
    keyExpressions: [],
    usedCorrectly: ['rev-1'],
    repeatedMistakes: ['grad-1'],
    keepSyncText: '',
    generatedAt: '2026-11-22T01:00:00.000Z',
    ...overrides,
  };
}

function makeStt(): SttFinalData {
  return {
    transcript: 'hello world',
    sourceStt: 'sttFinal',
    createdAt: '2026-11-22T01:00:00.000Z',
    engine: 'gemini-3.5-transcribe',
    mode: 'VERBATIM',
  };
}

function makePoolMistake(id: string, status: MistakeData['status']): MistakeData {
  return {
    id,
    createdAt: '2026-11-20T01:00:00.000Z',
    source: 'call',
    myPhrase: `my-${id}`,
    naturalPhrase: `nat-${id}`,
    reason: 'reason',
    sourceStt: 'sttFinal',
    stage: 1,
    status,
  };
}

function makeBaseInput(overrides: Partial<PersistReviewInput> = {}): PersistReviewInput {
  return {
    userId: 'u1',
    sessionId: 's1',
    goalId: 'travel',
    lessonIndex: 3,
    lessonTitle: '공항에서',
    review: makeReview(),
    sttFinal: makeStt(),
    sourceStt: 'sttFinal',
    isQa: false,
    tomorrow: '2026-11-23',
    nowIso: '2026-11-22T01:00:00.000Z',
    reviewingMistakes: [makePoolMistake('rev-1', 'reviewing')],
    graduatedMistakes: [makePoolMistake('grad-1', 'graduated')],
    ...overrides,
  };
}

function makeFakeDeps(
  calls: string[],
  overrides: Partial<PersistReviewDeps> = {}
): PersistReviewDeps {
  return {
    deleteCallMistakesForSession: async () => {
      calls.push('delete');
      return 0;
    },
    saveCallMistakes: async (_uid, docs) => {
      calls.push('saveCallMistakes');
      return docs.map((_, i) => `id-${i}`);
    },
    applyCallMistakeUpdates: async () => {
      calls.push('applyCallMistakeUpdates');
      return { graduatedCount: 1, reopenedCount: 1 };
    },
    saveSessionReview: async () => {
      calls.push('saveSessionReview');
    },
    advanceGoalAfterCompletedCall: async () => {
      calls.push('advanceGoalAfterCompletedCall');
    },
    ...overrides,
  };
}

test('A4: QA call only calls saveSessionReview and skips mistakes, graduation, and lesson advance', async () => {
  const calls: string[] = [];
  const deps = makeFakeDeps(calls);
  const res = await persistReviewOutcome(deps, makeBaseInput({ isQa: true }));

  assert.deepEqual(calls, ['saveSessionReview']);
  assert.notEqual(res.review.lessonAdvanced, true);
  assert.equal(res.review.qaCall, true);
  assert.equal(res.review.mistakesSaved, undefined);
  assert.deepEqual(res.review.usedCorrectlyItems, []);
  assert.deepEqual(res.review.repeatedItems, []);
  assert.equal(res.mistakeDocs.length, 2);
  assert.ok(res.mistakeDocs.every((m) => m.source === 'qa'));
});

test('A5: normal call runs full sequence in order and saves primary + transcript_analysis mistakes', async () => {
  const calls: string[] = [];
  let advanceArgs: [string, string, number] | null = null;
  const deps = makeFakeDeps(calls, {
    advanceGoalAfterCompletedCall: async (uid, goalId, lessonIndex) => {
      calls.push('advanceGoalAfterCompletedCall');
      advanceArgs = [uid, goalId, lessonIndex];
    },
  });

  const res = await persistReviewOutcome(deps, makeBaseInput({ isQa: false }));

  assert.deepEqual(calls, [
    'delete',
    'saveCallMistakes',
    'applyCallMistakeUpdates',
    'saveSessionReview',
    'advanceGoalAfterCompletedCall',
  ]);
  assert.deepEqual(advanceArgs, ['u1', 'travel', 3]);
  assert.equal(res.review.lessonAdvanced, true);
  assert.equal(res.review.mistakesSaved, true);
  assert.equal(res.review.qaCall, undefined);
  assert.equal(res.review.mistakes[0].id, 'id-0');
  assert.equal(res.review.mistakes[1].id, 'id-1');
  assert.equal(res.review.extraMistakes?.[0].id, 'id-2');
  assert.equal(res.mistakeDocs.length, 3);
  assert.equal(res.mistakeDocs[0].source, 'call');
  assert.equal(res.mistakeDocs[1].source, 'call');
  assert.equal(res.mistakeDocs[2].source, 'transcript_analysis');
  assert.equal(res.review.usedCorrectlyItems?.length, 1);
  assert.equal(res.review.repeatedItems?.length, 1);
});

test('A6: normal call marks mistakesSaved=false when saveCallMistakes throws, but still saves review and advances lesson', async () => {
  const calls: string[] = [];
  const deps = makeFakeDeps(calls, {
    saveCallMistakes: async () => {
      calls.push('saveCallMistakes');
      throw new Error('write failed');
    },
  });

  const res = await persistReviewOutcome(deps, makeBaseInput({ isQa: false }));

  assert.equal(res.review.mistakesSaved, false);
  assert.ok(calls.includes('saveSessionReview'));
  assert.ok(calls.includes('advanceGoalAfterCompletedCall'));
});

test('A7: normal call does not throw and does not advance lesson when saveSessionReview throws', async () => {
  const calls: string[] = [];
  const deps = makeFakeDeps(calls, {
    saveSessionReview: async () => {
      calls.push('saveSessionReview');
      throw new Error('session save failed');
    },
  });

  const res = await persistReviewOutcome(deps, makeBaseInput({ isQa: false }));

  assert.equal(res.review.lessonAdvanced, true);
  assert.ok(!calls.includes('advanceGoalAfterCompletedCall'));
});

test('A8: empty normal call skips saveCallMistakes and applyCallMistakeUpdates while keeping mistakesSaved=true', async () => {
  const calls: string[] = [];
  const deps = makeFakeDeps(calls);
  const res = await persistReviewOutcome(
    deps,
    makeBaseInput({
      isQa: false,
      review: makeReview({
        mistakes: [],
        extraMistakes: [],
        usedCorrectly: [],
        repeatedMistakes: [],
      }),
    })
  );

  assert.deepEqual(calls, [
    'delete',
    'saveSessionReview',
    'advanceGoalAfterCompletedCall',
  ]);
  assert.equal(res.review.mistakesSaved, true);
  assert.equal(res.mistakeDocs.length, 0);
});

test('A9: QA call with only unknown ids in usedCorrectly does not call applyCallMistakeUpdates or throw', async () => {
  const calls: string[] = [];
  const deps = makeFakeDeps(calls);
  const res = await persistReviewOutcome(
    deps,
    makeBaseInput({
      isQa: true,
      review: makeReview({
        usedCorrectly: ['unknown-id'],
        repeatedMistakes: [],
      }),
    })
  );

  assert.deepEqual(calls, ['saveSessionReview']);
  assert.deepEqual(res.review.usedCorrectly, []);
  assert.deepEqual(res.review.usedCorrectlyItems, []);
});
