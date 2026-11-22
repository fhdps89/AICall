import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import {
  DATA_DIR,
  LECTURE_JOB_TIMEOUT_MS,
  isLectureJobWallClockTimedOut,
  readLectureState,
  startLectureJob,
  withTimeout,
  type LectureMistakeInput,
  type LectureState,
} from '../server/lecture.ts';

const ai = {} as GoogleGenAI;
const mistakes: LectureMistakeInput[] = [
  { id: 'm1', myPhrase: 'I go yesterday', naturalPhrase: 'I went yesterday' },
];

function uidFor(name: string): string {
  return `test_jobto_${name}_${process.pid}`;
}

function cleanup(uid: string) {
  fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

test('withTimeout resolves when the work finishes in time', async () => {
  const value = await withTimeout(Promise.resolve(7), 200, 'fast');
  assert.equal(value, 7);
});

test('withTimeout rejects when the work hangs past the cap', async () => {
  const hung = new Promise<void>(() => {});
  await assert.rejects(withTimeout(hung, 30, 'slow-step'), /slow-step timed out after 30ms/);
});

test('a hung lecture job is marked TIMED_OUT and is no longer generating', async () => {
  const uid = uidFor('hang');
  const date = '2026-11-22';
  try {
    startLectureJob(ai, uid, date, mistakes, [], {
      jobTimeoutMs: 40,
      runJobFn: () => new Promise(() => {}),
    });
    assert.equal(readLectureState(uid, date)?.status, 'generating');
    await sleep(80);
    const st = readLectureState(uid, date);
    assert.equal(st?.status, 'failed');
    assert.equal(st?.error, 'TIMED_OUT');
  } finally {
    cleanup(uid);
  }
});

test('a timed-out job cannot overwrite a later job’s state', async () => {
  const uid = uidFor('epoch');
  const date = '2026-11-22';
  let finishOld!: () => void;
  let lateWrote: boolean | undefined;
  try {
    startLectureJob(ai, uid, date, mistakes, [], {
      jobTimeoutMs: 40,
      runJobFn: async (_ai, state: LectureState, _n, _r, ctx) => {
        await new Promise<void>((resolve) => {
          finishOld = resolve;
        });
        state.status = 'ready';
        state.title = 'late-old';
        lateWrote = ctx.write(state);
      },
    });
    await sleep(80);
    assert.equal(readLectureState(uid, date)?.error, 'TIMED_OUT');

    startLectureJob(ai, uid, date, mistakes, [], {
      runJobFn: async (_ai, state, _n, _r, ctx) => {
        state.status = 'ready';
        state.title = 'new';
        state.itemCount = 1;
        ctx.write(state);
      },
    });
    await sleep(20);
    finishOld();
    await sleep(30);
    const st = readLectureState(uid, date);
    assert.equal(lateWrote, false);
    assert.equal(st?.status, 'ready');
    assert.equal(st?.title, 'new');
  } finally {
    cleanup(uid);
  }
});

test('force does not restart a lecture job that is still running', async () => {
  const uid = uidFor('force');
  const date = '2026-11-22';
  try {
    const first = startLectureJob(ai, uid, date, mistakes, [], {
      jobTimeoutMs: 5_000,
      runJobFn: () => new Promise(() => {}),
    });
    assert.equal(first.status, 'generating');
    const again = startLectureJob(ai, uid, date, mistakes, [], {
      force: true,
      runJobFn: async (_ai, state, _n, _r, ctx) => {
        state.status = 'ready';
        state.title = 'forced';
        ctx.write(state);
      },
    });
    assert.equal(again.status, 'generating');
    await sleep(20);
    const st = readLectureState(uid, date);
    assert.equal(st?.status, 'generating');
    assert.notEqual(st?.title, 'forced');
  } finally {
    cleanup(uid);
  }
});

test('wall-clock timeout is TIMED_OUT even when running is still set', async () => {
  const uid = uidFor('wallclock');
  const date = '2026-11-23';
  try {
    startLectureJob(ai, uid, date, mistakes, [], {
      jobTimeoutMs: 2_000,
      runJobFn: () => new Promise(() => {}),
    });
    assert.equal(readLectureState(uid, date)?.status, 'generating');

    const file = path.join(DATA_DIR, 'lectures', uid, `${date}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as LectureState;
    raw.createdAt = new Date(Date.now() - LECTURE_JOB_TIMEOUT_MS - 1000).toISOString();
    raw.updatedAt = raw.createdAt;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));

    assert.equal(isLectureJobWallClockTimedOut(raw), true);
    const st = readLectureState(uid, date);
    assert.equal(st?.status, 'failed');
    assert.equal(st?.error, 'TIMED_OUT');
  } finally {
    cleanup(uid);
  }
});

test('a wall-clock timed-out job is restarted even if running still has the key', async () => {
  const uid = uidFor('wallclock_restart');
  const date = '2026-11-23';
  try {
    startLectureJob(ai, uid, date, mistakes, [], {
      jobTimeoutMs: 2_000,
      runJobFn: () => new Promise(() => {}),
    });
    const file = path.join(DATA_DIR, 'lectures', uid, `${date}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as LectureState;
    raw.createdAt = new Date(Date.now() - LECTURE_JOB_TIMEOUT_MS - 1000).toISOString();
    raw.updatedAt = raw.createdAt;
    raw.title = 'stale-title';
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));

    const next = startLectureJob(ai, uid, date, mistakes, [], {
      runJobFn: async (_ai, state, _n, _r, ctx) => {
        await sleep(0);
        state.status = 'ready';
        state.title = 'restarted';
        state.itemCount = 1;
        ctx.write(state);
      },
    });
    assert.equal(next.status, 'generating');
    assert.notEqual(next.title, 'stale-title');
    await sleep(30);
    const st = readLectureState(uid, date);
    assert.equal(st?.status, 'ready');
    assert.equal(st?.title, 'restarted');
  } finally {
    cleanup(uid);
  }
});

test('a recent in-memory job is not treated as wall-clock timed out', async () => {
  const uid = uidFor('wallclock_fresh');
  const date = '2026-11-23';
  try {
    startLectureJob(ai, uid, date, mistakes, [], {
      jobTimeoutMs: 2_000,
      runJobFn: () => new Promise(() => {}),
    });
    const st = readLectureState(uid, date);
    assert.equal(st?.status, 'generating');
    assert.equal(isLectureJobWallClockTimedOut(st!), false);
  } finally {
    cleanup(uid);
  }
});

test('INTERRUPTED wins over wall-clock when no job is in memory', () => {
  const uid = uidFor('interrupted_wins');
  const date = '2026-11-23';
  try {
    const file = path.join(DATA_DIR, 'lectures', uid, `${date}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const createdAt = new Date(Date.now() - LECTURE_JOB_TIMEOUT_MS - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify({
      uid, date, status: 'generating', newMistakeIds: ['m1'], reviewMistakeIds: [],
      ttsEngine: 'gemini', createdAt, updatedAt: createdAt,
    }, null, 2));
    const st = readLectureState(uid, date);
    assert.equal(st?.status, 'failed');
    assert.equal(st?.error, 'INTERRUPTED');
  } finally {
    cleanup(uid);
  }
});

test('a late finish after a wall-clock restart cannot overwrite the new job', async () => {
  const uid = uidFor('wallclock_late');
  const date = '2026-11-23';
  let finishOld!: () => void;
  let lateWrote: boolean | undefined;
  try {
    startLectureJob(ai, uid, date, mistakes, [], {
      jobTimeoutMs: 5_000,
      runJobFn: async (_ai, state: LectureState, _n, _r, ctx) => {
        await new Promise<void>((resolve) => { finishOld = resolve; });
        state.status = 'ready';
        state.title = 'late-old';
        lateWrote = ctx.write(state);
      },
    });
    const file = path.join(DATA_DIR, 'lectures', uid, `${date}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as LectureState;
    raw.createdAt = new Date(Date.now() - LECTURE_JOB_TIMEOUT_MS - 1000).toISOString();
    raw.updatedAt = raw.createdAt;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));

    startLectureJob(ai, uid, date, mistakes, [], {
      runJobFn: async (_ai, state, _n, _r, ctx) => {
        await sleep(0);
        state.status = 'ready';
        state.title = 'restarted';
        state.itemCount = 1;
        ctx.write(state);
      },
    });
    await sleep(30);
    finishOld();
    await sleep(30);
    const st = readLectureState(uid, date);
    assert.equal(lateWrote, false);
    assert.equal(st?.status, 'ready');
    assert.equal(st?.title, 'restarted');
  } finally {
    cleanup(uid);
  }
});

