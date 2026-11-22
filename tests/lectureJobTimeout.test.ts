import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import {
  DATA_DIR,
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
