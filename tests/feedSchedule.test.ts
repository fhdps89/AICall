import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import { DATA_DIR, type LectureState } from '../server/lecture.ts';
import {
  FEED_START_HOUR_KST,
  isBeforeFeedStartKst,
  buildFeedToday,
  shouldAutoRegenerate,
  maybeAutoRegenerateToday,
  type FeedSyncState,
} from '../server/feed.ts';

const ai = {} as GoogleGenAI;

function uidFor(name: string): string {
  return `test_sched_${name}_${process.pid}`;
}

function cleanup(uid: string) {
  fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
}

function feedState(uid: string, overrides: Partial<FeedSyncState> = {}): FeedSyncState {
  return {
    uid,
    secret: 's'.repeat(48),
    quizCount: 2,
    newMistakes: [{ id: 'm1', myPhrase: 'I go', naturalPhrase: 'I went', createdAt: '2026-11-24T00:00:00Z' }],
    reviewMistakes: [],
    syncedAt: '2026-11-24T01:00:00.000Z',
    ...overrides,
  };
}

function lectureState(uid: string, date: string, overrides: Partial<LectureState> = {}): LectureState {
  return {
    uid,
    date,
    status: 'ready',
    title: '제목',
    newMistakeIds: ['m1'],
    reviewMistakeIds: [],
    inputNewIds: ['m1'],
    inputReviewIds: [],
    ttsEngine: 'gemini',
    createdAt: '2026-11-24T00:30:00.000Z',
    updatedAt: '2026-11-24T00:30:00.000Z',
    ...overrides,
  };
}

test('1) isBeforeFeedStartKst checks 05:00 KST boundary', () => {
  assert.equal(FEED_START_HOUR_KST, 5);
  assert.equal(isBeforeFeedStartKst(Date.parse('2026-11-23T19:59:59.000Z')), true); // 04:59:59 KST
  assert.equal(isBeforeFeedStartKst(Date.parse('2026-11-23T20:00:00.000Z')), false); // 05:00:00 KST
  assert.equal(isBeforeFeedStartKst(Date.parse('2026-11-24T14:59:59.000Z')), false); // 23:59:59 KST
});

test('2-3) buildFeedToday gates generation before 05:00 KST (none & TIMED_OUT) and starts at 05:01 KST', () => {
  const uid = uidFor('gate_5am');
  const date = '2026-11-24';
  const before5 = Date.parse('2026-11-23T19:30:00.000Z'); // 04:30 KST
  const after5 = Date.parse('2026-11-23T20:01:00.000Z'); // 05:01 KST
  const st = feedState(uid);
  let startCalls = 0;
  try {
    const waiting = buildFeedToday(ai, st, 'https://example.test', {
      date,
      now: before5,
      startJob: () => {
        startCalls += 1;
        throw new Error('should not start');
      },
    });
    assert.equal(startCalls, 0);
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.startsAt, `${date}T05:00:00+09:00`);

    const dir = path.join(DATA_DIR, 'lectures', uid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${date}.json`),
      JSON.stringify(lectureState(uid, date, { status: 'failed', error: 'TIMED_OUT' }))
    );
    const timedOutBefore5 = buildFeedToday(ai, st, 'https://example.test', {
      date,
      now: before5,
      startJob: () => {
        startCalls += 1;
        throw new Error('should not retry before 05:00');
      },
    });
    assert.equal(startCalls, 0);
    assert.equal(timedOutBefore5.status, 'waiting');
    assert.equal(timedOutBefore5.startsAt, `${date}T05:00:00+09:00`);
    assert.equal(timedOutBefore5.error, undefined);

    const started = buildFeedToday(ai, st, 'https://example.test', {
      date,
      now: after5,
      startJob: (_ai, u, d) => {
        startCalls += 1;
        return lectureState(u, d, { status: 'generating' });
      },
    });
    assert.equal(startCalls, 1);
    assert.equal(started.status, 'generating');
  } finally {
    cleanup(uid);
  }
});

test('4-5) shouldAutoRegenerate decision table rows 1-7 and loop guard', () => {
  const before5 = Date.parse('2026-11-23T19:30:00.000Z');
  const after5 = Date.parse('2026-11-24T02:00:00.000Z');
  const uid = 'u_decision';
  const date = '2026-11-24';

  const stNovel = feedState(uid, {
    syncedAt: '2026-11-24T01:00:00.000Z',
    newMistakes: [
      { id: 'm1', myPhrase: 'a', naturalPhrase: 'b' },
      { id: 'm2', myPhrase: 'c', naturalPhrase: 'd' },
    ],
  });
  const ready = lectureState(uid, date, { createdAt: '2026-11-24T00:30:00.000Z' });

  // Row 1: before 05:00 KST -> false
  assert.equal(shouldAutoRegenerate(ready, stNovel, before5), false);
  // Row 2: autoRegenerate: false -> false
  assert.equal(shouldAutoRegenerate(ready, { ...stNovel, autoRegenerate: false }, after5), false);
  // Row 3: null or failed -> false; generating -> allowed
  assert.equal(shouldAutoRegenerate(null, stNovel, after5), false);
  assert.equal(shouldAutoRegenerate({ ...ready, status: 'failed' }, stNovel, after5), false);
  assert.equal(shouldAutoRegenerate({ ...ready, status: 'generating' }, stNovel, after5), true);
  // Row 4: sync not newer -> false
  assert.equal(
    shouldAutoRegenerate({ ...ready, createdAt: '2026-11-24T01:00:00.000Z' }, stNovel, after5),
    false
  );
  // Row 5-6: legacy fallback (no inputNewIds) -> false when m1, m2 already in newMistakeIds
  assert.equal(
    shouldAutoRegenerate(
      { ...ready, inputNewIds: undefined, newMistakeIds: ['m1', 'm2'] },
      stNovel,
      after5
    ),
    false
  );
  // Row 5-6: N1-dropped item (in inputNewIds, absent from script/newMistakeIds) -> false
  assert.equal(
    shouldAutoRegenerate(
      { ...ready, inputNewIds: ['m1', 'm2'], newMistakeIds: ['m1'] },
      stNovel,
      after5
    ),
    false
  );
  // Row 7: newer sync with unseen new id -> true
  assert.equal(shouldAutoRegenerate(ready, stNovel, after5), true);
  // Loop guard: after regen, createdAt > syncedAt -> false on next call
  const regenerated = lectureState(uid, date, {
    createdAt: '2026-11-24T01:00:05.000Z',
    inputNewIds: ['m1', 'm2'],
  });
  assert.equal(shouldAutoRegenerate(regenerated, stNovel, after5), false);
});

test('6) maybeAutoRegenerateToday calls startJob with force:true exactly once over two GETs', () => {
  const uid = uidFor('two_gets');
  const date = '2026-11-24';
  const after5 = Date.parse('2026-11-24T02:00:00.000Z');
  const dir = path.join(DATA_DIR, 'lectures', uid);
  const calls: Array<{ force?: boolean }> = [];

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${date}.json`),
      JSON.stringify(lectureState(uid, date, { createdAt: '2026-11-24T00:30:00.000Z' }))
    );
    const st = feedState(uid, {
      syncedAt: '2026-11-24T01:00:00.000Z',
      newMistakes: [
        { id: 'm1', myPhrase: 'a', naturalPhrase: 'b' },
        { id: 'm2', myPhrase: 'c', naturalPhrase: 'd' },
      ],
    });
    const stubStart = (_ai: GoogleGenAI, u: string, d: string, _n: any, _r: any, opts: any) => {
      calls.push({ force: opts?.force });
      const next = lectureState(u, d, {
        status: 'ready',
        createdAt: '2026-11-24T01:00:05.000Z',
        inputNewIds: ['m1', 'm2'],
      });
      fs.writeFileSync(path.join(dir, `${d}.json`), JSON.stringify(next));
      return next;
    };

    const g1 = buildFeedToday(ai, st, 'https://example.test', { date, now: after5, startJob: stubStart as any });
    const g2 = buildFeedToday(ai, st, 'https://example.test', { date, now: after5, startJob: stubStart as any });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].force, true);
    assert.equal(g1.status, 'ready');
    assert.equal(g2.status, 'ready');
  } finally {
    cleanup(uid);
  }
});
