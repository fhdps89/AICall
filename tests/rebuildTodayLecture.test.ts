import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebuildTodayLectureWith } from '../src/services/lecture/rebuildTodayLecture.ts';
import type { LectureDoc } from '../src/services/lecture/lectureService.ts';

function makeLecture(overrides: Partial<LectureDoc> = {}): LectureDoc {
  return {
    date: '2026-11-24',
    status: 'generating',
    createdAt: '2026-11-24T01:00:00.000Z',
    ...overrides,
  };
}

test('rebuildTodayLectureWith calls syncFeed(uid, { autoRegenerate: false }) first, then startLecture(uid, date, true)', async () => {
  const calls: string[] = [];
  const expected = makeLecture({ title: '아침 강의' });

  const result = await rebuildTodayLectureWith('user-1', '2026-11-24', {
    syncFeed: async (uid, opts) => {
      calls.push(`syncFeed:${uid}:${JSON.stringify(opts)}`);
      return 'secret-ok';
    },
    startLecture: async (uid, date, force) => {
      calls.push(`startLecture:${uid}:${date}:${force}`);
      return expected;
    },
  });

  assert.deepEqual(calls, [
    'syncFeed:user-1:{"autoRegenerate":false}',
    'startLecture:user-1:2026-11-24:true',
  ]);
  assert.equal(result, expected);
});

test('rebuildTodayLectureWith continues to startLecture with force=true when syncFeed rejects', async () => {
  const calls: string[] = [];
  const expected = makeLecture({ status: 'generating' });
  const warnings: unknown[][] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const result = await rebuildTodayLectureWith('user-2', '2026-11-24', {
      syncFeed: async (uid) => {
        calls.push(`syncFeed:${uid}`);
        throw new Error('feed sync failed');
      },
      startLecture: async (uid, date, force) => {
        calls.push(`startLecture:${uid}:${date}:${force}`);
        return expected;
      },
    });

    assert.deepEqual(calls, [
      'syncFeed:user-2',
      'startLecture:user-2:2026-11-24:true',
    ]);
    assert.equal(result, expected);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = origWarn;
  }
});

test('rebuildTodayLectureWith propagates startLecture rejection after syncFeed succeeds', async () => {
  const calls: string[] = [];
  const boom = new Error('generate failed');

  await assert.rejects(
    () =>
      rebuildTodayLectureWith('user-3', '2026-11-24', {
        syncFeed: async (uid) => {
          calls.push(`syncFeed:${uid}`);
          return 'ok';
        },
        startLecture: async (uid, date, force) => {
          calls.push(`startLecture:${uid}:${date}:${force}`);
          throw boom;
        },
      }),
    (err: unknown) => err === boom
  );

  assert.deepEqual(calls, [
    'syncFeed:user-3',
    'startLecture:user-3:2026-11-24:true',
  ]);
});
