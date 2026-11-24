import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import {
  DATA_DIR,
  lectureAudioPath,
  lectureRebuildInFlight,
  readLectureState,
  startLectureAudioRebuild,
  startLectureJob,
  type LectureMistakeInput,
  type LectureScriptItem,
  type LectureState,
} from '../server/lecture.ts';
import { wavFromPcm } from '../server/lectureAudioEncode.ts';

const ai = {} as GoogleGenAI;

function uidFor(name: string): string {
  return `test_force_${name}_${process.pid}`;
}

function cleanup(uid: string) {
  fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const mistakes: LectureMistakeInput[] = [
  { id: 'm1', myPhrase: 'I go yesterday', naturalPhrase: 'I went yesterday', createdAt: '2026-11-24T00:00:00Z' },
];

const sampleScript: LectureScriptItem[] = [
  {
    mistakeId: 'm1',
    kind: 'new',
    myPhrase: 'I go yesterday',
    naturalPhrase: 'I went yesterday',
    explanation: '과거 시제',
    dialogue: [{ speaker: 'Coach', line: 'I went yesterday.' }],
    meaningKo: '어제 갔다',
    answerEnglish: 'I went yesterday',
  },
];

test('1-2) force aborts a hung job, superseding its writes, onReady, and isCurrent', async () => {
  const uid = uidFor('abort_hung');
  const date = '2026-11-24';
  let firstSignal!: AbortSignal;
  let releaseOld!: () => void;
  let oldWriteResult: boolean | undefined;
  let oldOnReadyCalls = 0;
  let newOnReadyIsCurrent: boolean | undefined;

  try {
    const first = startLectureJob(ai, uid, date, mistakes, [], {
      jobTimeoutMs: 5_000,
      runJobFn: async (_ai, state, _n, _r, ctx) => {
        firstSignal = ctx.signal;
        await new Promise<void>((r) => {
          releaseOld = r;
        });
        state.status = 'ready';
        state.title = 'old-title';
        oldWriteResult = ctx.write(state);
      },
      onReady: () => {
        oldOnReadyCalls += 1;
      },
    });
    assert.equal(firstSignal.aborted, false);
    await sleep(5);

    const second = startLectureJob(ai, uid, date, mistakes, [], {
      force: true,
      runJobFn: async (_ai, state, _n, _r, ctx) => {
        state.status = 'ready';
        state.title = 'new-title';
        state.script = sampleScript;
        state.itemCount = 1;
        ctx.write(state);
      },
      onReady: (_s, isCurrent) => {
        newOnReadyIsCurrent = isCurrent();
      },
    });

    assert.notEqual(second.createdAt, first.createdAt);
    assert.equal(firstSignal.aborted, true);
    await sleep(20);
    assert.equal(newOnReadyIsCurrent, true);

    releaseOld();
    await sleep(20);
    assert.equal(oldWriteResult, false);
    assert.equal(oldOnReadyCalls, 0);
    const final = readLectureState(uid, date);
    assert.equal(final?.status, 'ready');
    assert.equal(final?.title, 'new-title');
  } finally {
    cleanup(uid);
  }
});

test('3) without force, a running job is returned unchanged', async () => {
  const uid = uidFor('reuse_running');
  const date = '2026-11-24';
  let runs = 0;
  let release!: () => void;
  try {
    const first = startLectureJob(ai, uid, date, mistakes, [], {
      jobTimeoutMs: 5_000,
      runJobFn: async () => {
        runs += 1;
        await new Promise<void>((r) => {
          release = r;
        });
      },
    });
    const second = startLectureJob(ai, uid, date, mistakes, [], {
      runJobFn: async () => {
        runs += 1;
      },
    });
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(runs, 1);
    release();
    await sleep(10);
  } finally {
    cleanup(uid);
  }
});

test('4) force while an audio rebuild runs aborts the rebuild and starts generating', async () => {
  const uid = uidFor('abort_rebuild');
  const date = '2026-11-24';
  let rebuildSignal: AbortSignal | undefined;
  let releaseRebuild!: () => void;
  try {
    startLectureAudioRebuild(
      ai,
      uid,
      date,
      { title: '복구용', script: sampleScript, coachNote: '첫째. 둘째.' },
      {
        synthesizeFn: async (_ai, _e, _t, _two, signal) => {
          rebuildSignal = signal;
          await new Promise<void>((r) => {
            releaseRebuild = r;
          });
          return { data: Buffer.alloc(2400 * 2), rate: 24000 };
        },
        encodeFn: async (pcm, rate) => ({ ext: 'wav', mime: 'audio/wav', buffer: wavFromPcm(pcm, rate) }),
      }
    );
    assert.ok(lectureRebuildInFlight(uid, date));
    assert.equal(rebuildSignal?.aborted, false);

    const forced = startLectureJob(ai, uid, date, mistakes, [], {
      force: true,
      runJobFn: async (_ai, state, _n, _r, ctx) => {
        await sleep(0);
        state.status = 'ready';
        state.title = 'regenerated';
        state.script = sampleScript;
        ctx.write(state);
      },
    });
    assert.equal(forced.status, 'generating');
    assert.equal(rebuildSignal?.aborted, true);
    assert.equal(lectureRebuildInFlight(uid, date), undefined);

    await sleep(20);
    releaseRebuild?.();
    await sleep(20);
    assert.equal(readLectureState(uid, date)?.title, 'regenerated');
    assert.equal(lectureAudioPath(uid, date), null);
  } finally {
    cleanup(uid);
  }
});

test('5) force with empty inputs on a ready lecture returns the ready lecture unchanged', () => {
  const uid = uidFor('empty_keep_ready');
  const date = '2026-11-24';
  try {
    const dir = path.join(DATA_DIR, 'lectures', uid);
    fs.mkdirSync(dir, { recursive: true });
    const ready: LectureState = {
      uid,
      date,
      status: 'ready',
      title: '기존 강의',
      script: sampleScript,
      newMistakeIds: ['m1'],
      reviewMistakeIds: [],
      ttsEngine: 'gemini',
      createdAt: '2026-11-24T00:00:00Z',
      updatedAt: '2026-11-24T00:00:00Z',
    };
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(ready, null, 2));

    const out = startLectureJob(ai, uid, date, [], [], { force: true });
    assert.equal(out.status, 'ready');
    assert.equal(out.title, '기존 강의');
    assert.equal(readLectureState(uid, date)?.status, 'ready');
  } finally {
    cleanup(uid);
  }
});

test('6) new state stores inputNewIds, inputReviewIds, and inputLatestCreatedAt from sanitized inputs', async () => {
  const uid = uidFor('input_ids');
  const date = '2026-11-24';
  try {
    const st = startLectureJob(
      ai,
      uid,
      date,
      [
        { id: 'n1', myPhrase: 'a1', naturalPhrase: 'b1', createdAt: '2026-11-24T01:00:00Z' },
        { id: 'qa', myPhrase: 'x', naturalPhrase: 'y', source: 'qa' } as any,
        { id: 'n2', myPhrase: 'a2', naturalPhrase: 'b2', createdAt: '2026-11-24T03:00:00Z' },
      ],
      [
        { id: 'n1', myPhrase: 'a1', naturalPhrase: 'b1' },
        { id: 'r1', myPhrase: 'c1', naturalPhrase: 'd1', createdAt: '2026-11-20T00:00:00Z' },
        { id: 'r2', myPhrase: 'c2', naturalPhrase: 'd2' },
      ],
      {
        runJobFn: async () => {},
      }
    );
    assert.deepEqual(st.inputNewIds, ['n1', 'n2']);
    assert.deepEqual(st.inputReviewIds, ['r1']);
    assert.equal(st.inputLatestCreatedAt, '2026-11-24T03:00:00Z');
    await sleep(10);
  } finally {
    cleanup(uid);
  }
});
