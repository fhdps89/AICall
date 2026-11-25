import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import {
  DATA_DIR,
  LECTURE_GEN_SKIPPED,
  LECTURE_JOB_TIMEOUT_MS,
  lectureAudioPath,
  lectureRebuildInFlight,
  readLectureState,
  restoreReadyLecture,
  startLectureJob,
  synthesizeGemini,
  type LectureGenerateScriptFn,
  type LectureMistakeInput,
  type LecturePcm,
  type LectureScriptItem,
  type LectureState,
  type LectureSynthesizeFn,
} from '../server/lecture.ts';
import {
  buildFeedDiag,
  buildFeedToday,
  ensureTodayLecture,
  type FeedSyncState,
} from '../server/feed.ts';
import { wavFromPcm, type LectureEncodeFn } from '../server/lectureAudioEncode.ts';
import {
  applyGenRelease,
  decideGenAcquire,
  type GenControl,
  type GenRemote,
} from '../server/lectureGenGuard.ts';

const ai = {} as GoogleGenAI;

function uidFor(name: string): string {
  return `test_gencost_${name}_${process.pid}`;
}

function cleanup(uid: string) {
  fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
}

function twoInputs(): LectureMistakeInput[] {
  return [
    { id: 'm1', myPhrase: 'I go yesterday', naturalPhrase: 'I went yesterday', createdAt: '2026-11-25T00:00:00.000Z' },
    { id: 'm2', myPhrase: 'He have a car', naturalPhrase: 'He has a car', createdAt: '2026-11-25T00:01:00.000Z' },
  ];
}

function twoScriptItems(): LectureScriptItem[] {
  return [
    {
      mistakeId: 'm1',
      kind: 'new',
      myPhrase: 'I go yesterday',
      naturalPhrase: 'I went yesterday',
      explanation: '과거 시제를 써야 해요.',
      dialogue: [{ speaker: 'Coach', line: 'I went yesterday.' }],
      meaningKo: '나는 어제 갔다',
      answerEnglish: 'I went yesterday',
    },
    {
      mistakeId: 'm2',
      kind: 'new',
      myPhrase: 'He have a car',
      naturalPhrase: 'He has a car',
      explanation: '3인칭 단수 현재형은 has를 써요.',
      dialogue: [{ speaker: 'Partner', line: 'He has a car.' }],
      meaningKo: '그는 차가 있다',
      answerEnglish: 'He has a car',
    },
  ];
}

function silentPcm(sec = 0.2): LecturePcm {
  return { data: Buffer.alloc(Math.round(24000 * sec) * 2), rate: 24000 };
}

const wavEncode: LectureEncodeFn = async (pcm, rate) => ({
  ext: 'wav',
  mime: 'audio/wav',
  buffer: wavFromPcm(pcm, rate),
});

function memoryGenRemote(initial?: GenControl) {
  let gc: GenControl = initial ? { ...initial } : { genCount: 0 };
  let acquireCalls = 0;
  let releaseCalls = 0;
  const remote: GenRemote = {
    async acquire(_date, req) {
      acquireCalls += 1;
      const d = decideGenAcquire(gc, req);
      if (!d.ok) return { ok: false, skip: d.skip, gc };
      gc = d.next;
      return { ok: true, gc };
    },
    async release(_date, rel) {
      releaseCalls += 1;
      gc = applyGenRelease(gc, rel);
    },
  };
  return {
    remote,
    getGc: () => gc,
    getAcquireCalls: () => acquireCalls,
    getReleaseCalls: () => releaseCalls,
  };
}

async function waitForJobSettled(
  uid: string,
  date: string,
  now?: number,
  timeoutMs = 2000
): Promise<LectureState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = readLectureState(uid, date, now);
    if (st && st.status !== 'generating') return st;
    await new Promise((r) => setTimeout(r, 10));
  }
  return readLectureState(uid, date, now);
}

test('1) mid-segment failure followed by non-force retry delegates to rebuild and never re-synthesizes cached segments', async () => {
  const uid = uidFor('segcache');
  const date = '2026-11-25';
  const inputs = twoInputs();
  const items = twoScriptItems();
  let scriptCalls = 0;
  const generateScriptFn: LectureGenerateScriptFn = async () => {
    scriptCalls += 1;
    return { title: '세그먼트 캐시 테스트', items, coachNote: '첫 문장. 둘째 문장.', tokens: 123 };
  };

  const firstOkTexts: string[] = [];
  const secondTexts: string[] = [];
  let speechCallNum = 0;
  let failOnce = true;

  const synthFn: LectureSynthesizeFn = async (_ai, _engine, text) => {
    if (failOnce) {
      speechCallNum += 1;
      if (speechCallNum === 4) {
        throw Object.assign(new Error('UNAVAILABLE'), { status: 503 });
      }
      firstOkTexts.push(text);
    } else {
      secondTexts.push(text);
    }
    return silentPcm(0.2);
  };

  try {
    startLectureJob(ai, uid, date, inputs, [], {
      generateScriptFn,
      synthesizeFn: synthFn,
      encodeFn: wavEncode,
    });
    const afterFirst = await waitForJobSettled(uid, date);
    assert.equal(afterFirst?.status, 'failed');
    assert.equal(afterFirst?.script?.length, 2);
    assert.equal(scriptCalls, 1);
    assert.ok(firstOkTexts.length >= 2);

    const segRoot = path.join(DATA_DIR, 'lectures', uid, 'segcache', date);
    assert.equal(fs.existsSync(segRoot), true);
    const fps = fs.readdirSync(segRoot);
    assert.equal(fps.length, 1);
    const cachedFiles = fs.readdirSync(path.join(segRoot, fps[0])).filter((f) => f.endsWith('.pcm'));
    assert.equal(cachedFiles.length, firstOkTexts.length);

    failOnce = false;
    let readyResolve!: () => void;
    const readyPromise = new Promise<void>((r) => { readyResolve = r; });

    const second = startLectureJob(ai, uid, date, inputs, [], {
      generateScriptFn,
      synthesizeFn: synthFn,
      encodeFn: wavEncode,
      ignoreCooldown: true,
      onReady: () => readyResolve(),
    });
    assert.equal(second.status, 'ready');
    assert.equal(second.audioStatus, 'rebuilding');
    await lectureRebuildInFlight(uid, date);
    await readyPromise;

    assert.equal(scriptCalls, 1);
    const firstOkSet = new Set(firstOkTexts);
    for (const t of secondTexts) {
      assert.equal(firstOkSet.has(t), false, `segment should have been cached: ${t}`);
    }
    const finalSt = readLectureState(uid, date);
    assert.equal(finalSt?.status, 'ready');
    assert.equal(finalSt?.audioStatus, 'ready');
    assert.ok(lectureAudioPath(uid, date));
  } finally {
    cleanup(uid);
  }
});

test('2a) concurrent requests for same date (startLectureJob x2 + ensureTodayLecture) run 1 script and 1 TTS set', async () => {
  const uid = uidFor('concurrent_date');
  const date = '2026-11-25';
  const inputs = twoInputs();
  const items = twoScriptItems();
  let scriptCalls = 0;
  let synthCalls = 0;

  let releaseFirstSynth!: () => void;
  const firstSynthStarted = new Promise<void>((r) => {
    const orig = () => r();
    void orig;
  });
  let markFirstSynth!: () => void;
  const gate1 = new Promise<void>((r) => { markFirstSynth = r; });
  const gate2 = new Promise<void>((r) => { releaseFirstSynth = r; });
  void firstSynthStarted;

  const st: FeedSyncState = {
    uid,
    secret: 'c'.repeat(48),
    quizCount: 1,
    newMistakes: inputs,
    reviewMistakes: [],
    syncedAt: '2026-11-25T00:00:00.000Z',
  };

  try {
    let readyResolve!: () => void;
    const readyDone = new Promise<void>((r) => { readyResolve = r; });

    const job1 = startLectureJob(ai, uid, date, inputs, [], {
      generateScriptFn: async () => {
        scriptCalls += 1;
        return { title: '동시성 테스트', items, coachNote: '첫 문장. 둘째 문장.' };
      },
      synthesizeFn: async () => {
        synthCalls += 1;
        if (synthCalls === 1) {
          markFirstSynth();
          await gate2;
        }
        return silentPcm(0.2);
      },
      encodeFn: wavEncode,
      onReady: () => readyResolve(),
    });
    const job2 = startLectureJob(ai, uid, date, inputs, [], {
      generateScriptFn: async () => {
        scriptCalls += 1;
        return { title: '동시성 테스트', items, coachNote: '첫 문장. 둘째 문장.' };
      },
      synthesizeFn: async () => {
        synthCalls += 1;
        return silentPcm(0.2);
      },
      encodeFn: wavEncode,
    });
    const ensurePromise = ensureTodayLecture(ai, st, date, {
      loadBackup: async () => null,
      synthesizeFn: async () => {
        synthCalls += 1;
        return silentPcm(0.2);
      },
    });

    assert.equal(job1.createdAt, job2.createdAt);
    await gate1;
    releaseFirstSynth();
    await Promise.all([ensurePromise, readyDone]);

    assert.equal(scriptCalls, 1);
    // 2 items -> opening(1) + (body+answer)*2(4) + closing(1) + recap(1) = 7 calls (or 6 if no recap)
    assert.ok(synthCalls >= 6 && synthCalls <= 7, `expected 6..7 synth calls, got ${synthCalls}`);
    assert.equal(readLectureState(uid, date)?.status, 'ready');
  } finally {
    cleanup(uid);
  }
});

test('2b) foreign lease blocks script & TTS (0 calls), sets GEN_SKIPPED & diag genSkipReason=lease, and peekGenGate skips remote on buildFeedToday', async () => {
  const uid = uidFor('foreign_lease');
  const date = '2026-11-25';
  const inputs = twoInputs();
  const nowMs = Date.parse('2026-11-25T02:00:00.000Z'); // 11:00 KST
  const untilIso = new Date(nowMs + 10 * 60 * 1000).toISOString();

  const mem = memoryGenRemote({
    genCount: 1,
    lease: {
      owner: 'other',
      token: 'tok-other',
      kind: 'job',
      until: untilIso,
    },
  });

  let scriptCalls = 0;
  let synthCalls = 0;
  let onFailedCalls = 0;

  try {
    startLectureJob(ai, uid, date, inputs, [], {
      now: nowMs,
      genRemote: mem.remote,
      generateScriptFn: async () => {
        scriptCalls += 1;
        return { title: 'x', items: twoScriptItems(), coachNote: 'a. b.' };
      },
      synthesizeFn: async () => {
        synthCalls += 1;
        return silentPcm();
      },
      onFailed: () => {
        onFailedCalls += 1;
      },
    });

    const afterJob = await waitForJobSettled(uid, date, nowMs);
    assert.equal(afterJob?.status, 'failed');
    assert.equal(afterJob?.error, LECTURE_GEN_SKIPPED);
    assert.equal(scriptCalls, 0);
    assert.equal(synthCalls, 0);
    assert.equal(onFailedCalls, 0);

    const backup: LectureState = {
      uid,
      date,
      status: 'ready',
      title: '백업',
      script: twoScriptItems(),
      coachNote: '첫 문장. 둘째 문장.',
      newMistakeIds: ['m1', 'm2'],
      reviewMistakeIds: [],
      ttsEngine: 'gemini',
      createdAt: new Date(nowMs - 60_000).toISOString(),
      updatedAt: new Date(nowMs - 60_000).toISOString(),
    };
    const restored = restoreReadyLecture(ai, uid, date, backup, {
      now: nowMs,
      genRemote: mem.remote,
      synthesizeFn: async () => {
        synthCalls += 1;
        return silentPcm();
      },
      encodeFn: wavEncode,
    });
    assert.equal(restored?.error, LECTURE_GEN_SKIPPED);
    assert.equal(synthCalls, 0);

    const st: FeedSyncState = {
      uid,
      secret: 'f'.repeat(48),
      quizCount: 1,
      newMistakes: inputs,
      reviewMistakes: [],
      syncedAt: new Date(nowMs).toISOString(),
    };
    const diag = buildFeedDiag(st, { date, now: nowMs });
    assert.equal(diag.genSkipReason, 'lease');
    assert.equal(diag.genBlockedUntil, untilIso);
    assert.equal(diag.genLeaseMode, 'firestore');

    const lectureFile = path.join(DATA_DIR, 'lectures', uid, `${date}.json`);
    if (fs.existsSync(lectureFile)) {
      const disk = JSON.parse(fs.readFileSync(lectureFile, 'utf8'));
      disk.audioRetryAfter = new Date(nowMs - 1000).toISOString();
      fs.writeFileSync(lectureFile, JSON.stringify(disk, null, 2));
    }
    const acqBefore = mem.getAcquireCalls();
    let startJobCalls = 0;
    buildFeedToday(ai, st, 'https://example.test', {
      date,
      now: nowMs,
      genRemote: mem.remote,
      startJob: (a, u, d, n, r, o) => {
        startJobCalls += 1;
        return startLectureJob(a, u, d, n, r, { ...o, now: nowMs, genRemote: mem.remote });
      },
    });
    assert.equal(startJobCalls, 1);
    assert.equal(mem.getAcquireCalls(), acqBefore);
    assert.equal(scriptCalls, 0);
    assert.equal(synthCalls, 0);
  } finally {
    cleanup(uid);
  }
});

test('3) restart simulation: wiped .data + text & audio backup -> 0 TTS, 0 script, 0 startJob, dailyGenCount unchanged', async () => {
  const uid = uidFor('restart_sim');
  const date = '2026-11-25';
  const inputs = twoInputs();
  const items = twoScriptItems();
  const nowMs = Date.parse('2026-11-25T02:00:00.000Z');
  let scriptCalls = 0;
  let synthCalls = 0;

  try {
    let readyResolve!: () => void;
    const readyDone = new Promise<void>((r) => { readyResolve = r; });
    startLectureJob(ai, uid, date, inputs, [], {
      now: nowMs,
      generateScriptFn: async () => {
        scriptCalls += 1;
        return { title: '백업 복원 테스트', items, coachNote: '첫 문장. 둘째 문장.' };
      },
      synthesizeFn: async () => {
        synthCalls += 1;
        return silentPcm(0.2);
      },
      encodeFn: wavEncode,
      onReady: () => readyResolve(),
    });
    await readyDone;
    const built = readLectureState(uid, date)!;
    assert.equal(built.status, 'ready');

    // Simulate container restart wiping .data/lectures/{uid}
    cleanup(uid);
    const scriptBefore = scriptCalls;
    const synthBefore = synthCalls;

    const st: FeedSyncState = {
      uid,
      secret: 'r'.repeat(48),
      quizCount: 2,
      newMistakes: inputs,
      reviewMistakes: [],
      syncedAt: new Date(nowMs - 60_000).toISOString(),
    };
    const diagBefore = buildFeedDiag(st, { date, now: nowMs });
    assert.equal(diagBefore.dailyGenCount, 0);

    const backedUp: LectureState = {
      ...built,
      audioBackupId: 'bak-restart-1',
      audioChunks: 1,
    };
    const mp3Buf = Buffer.from('ID3-fake-mp3-audio');

    await ensureTodayLecture(ai, st, date, {
      now: nowMs,
      loadBackup: async () => backedUp,
      loadAudio: async () => ({
        status: 'ok',
        ext: 'mp3',
        mime: 'audio/mpeg',
        buffer: mp3Buf,
        durationSec: 362,
      }),
      synthesizeFn: async () => {
        synthCalls += 1;
        return silentPcm();
      },
    });

    let startJobCalls = 0;
    const today = buildFeedToday(ai, st, 'https://example.test', {
      date,
      now: nowMs,
      startJob: (...args) => {
        startJobCalls += 1;
        return startLectureJob(...args);
      },
    });

    assert.equal(scriptCalls, scriptBefore);
    assert.equal(synthCalls, synthBefore);
    assert.equal(startJobCalls, 0);
    assert.equal(today.status, 'ready');
    assert.ok(today.audioUrl?.endsWith(`/audio/${date}.mp3`));
    const diagAfter = buildFeedDiag(st, { date, now: nowMs });
    assert.equal(diagAfter.dailyGenCount, 0);
  } finally {
    cleanup(uid);
  }
});

test('3b) INTERRUPTED with local script delegates to rebuild with 0 generateScript calls and uses cached segments', async () => {
  const uid = uidFor('interrupted_resume');
  const date = '2026-11-25';
  const inputs = twoInputs();
  const items = twoScriptItems();
  const nowMs = Date.parse('2026-11-25T02:00:00.000Z');

  try {
    let scriptCalls = 0;
    let firstSpeech = true;
    const firstTexts: string[] = [];

    // 1st run writes script checkpoint then fails on 3rd speech segment
    let calls1 = 0;
    startLectureJob(ai, uid, date, inputs, [], {
      now: nowMs,
      generateScriptFn: async () => {
        scriptCalls += 1;
        return { title: '중단 재개 테스트', items, coachNote: '첫 문장. 둘째 문장.' };
      },
      synthesizeFn: async (_ai, _e, text) => {
        calls1 += 1;
        if (firstSpeech && calls1 === 3) {
          throw Object.assign(new Error('UNAVAILABLE'), { status: 503 });
        }
        firstTexts.push(text);
        return silentPcm(0.2);
      },
      encodeFn: wavEncode,
    });
    await waitForJobSettled(uid, date, nowMs);
    firstSpeech = false;

    // Rewrite local file to simulate process crash mid-job ('generating' with script on disk, no running in memory)
    const saved = readLectureState(uid, date, nowMs)!;
    assert.equal(saved.script?.length, 2);
    fs.writeFileSync(
      path.join(DATA_DIR, 'lectures', uid, `${date}.json`),
      JSON.stringify({ ...saved, status: 'generating', error: undefined })
    );

    const st: FeedSyncState = {
      uid,
      secret: 'i'.repeat(48),
      quizCount: 1,
      newMistakes: inputs,
      reviewMistakes: [],
      syncedAt: new Date(nowMs).toISOString(),
    };
    const synth2Texts: string[] = [];
    const today = buildFeedToday(ai, st, 'https://example.test', {
      date,
      now: nowMs,
      startJob: (a, u, d, n, r, o) =>
        startLectureJob(a, u, d, n, r, {
          ...o,
          onReady: undefined,
          onFailed: undefined,
          generateScriptFn: async () => {
            scriptCalls += 1;
            return { title: 'should-not-run', items, coachNote: 'a. b.' };
          },
          synthesizeFn: async (_ai, _e, text) => {
            synth2Texts.push(text);
            return silentPcm(0.2);
          },
          encodeFn: wavEncode,
        }),
    });

    assert.equal(today.status, 'ready');
    assert.equal(today.audioRestoring, true);
    await lectureRebuildInFlight(uid, date);

    assert.equal(scriptCalls, 1);
    const cachedSet = new Set(firstTexts);
    for (const t of synth2Texts) {
      assert.equal(cachedSet.has(t), false);
    }
    assert.equal(readLectureState(uid, date)?.audioStatus, 'ready');
  } finally {
    cleanup(uid);
  }
});


test('3c) TIMED_OUT with a still-running job and script checkpoint delegates to rebuild (generateScript 0)', async () => {
  const uid = uidFor('timedout_delegate');
  const date = '2026-11-25';
  const inputs = twoInputs();
  const items = twoScriptItems();
  const createdAtMs = Date.now() - LECTURE_JOB_TIMEOUT_MS - 5_000;
  let scriptCalls = 0;
  let synthCalls = 0;
  try {
    startLectureJob(ai, uid, date, inputs, [], {
      now: createdAtMs,
      jobTimeoutMs: 60 * 60 * 1000,
      runJobFn: async (_ai, _state, _newList, _reviewList, ctx) => {
        await new Promise<void>((_, reject) => {
          const onAbort = () => reject(new Error('lecture job superseded'));
          if (ctx?.signal.aborted) {
            onAbort();
            return;
          }
          ctx?.signal.addEventListener('abort', onAbort, { once: true });
        });
      },
    });
    const file = path.join(DATA_DIR, 'lectures', uid, `${date}.json`);
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    disk.script = items;
    disk.title = '중단';
    disk.coachNote = '첫 문장. 둘째 문장.';
    fs.writeFileSync(file, JSON.stringify(disk, null, 2));

    const viewed = readLectureState(uid, date);
    assert.equal(viewed?.status, 'failed');
    assert.equal(viewed?.error, 'TIMED_OUT');

    let readyResolve!: () => void;
    const readyDone = new Promise<void>((r) => { readyResolve = r; });
    const second = startLectureJob(ai, uid, date, inputs, [], {
      generateScriptFn: async () => {
        scriptCalls += 1;
        return { title: 'x', items, coachNote: '첫 문장. 둘째 문장.' };
      },
      synthesizeFn: async () => {
        synthCalls += 1;
        return silentPcm(0.2);
      },
      encodeFn: wavEncode,
      ignoreCooldown: true,
      onReady: () => readyResolve(),
    });
    assert.equal(second.audioStatus, 'rebuilding');
    await lectureRebuildInFlight(uid, date);
    await readyDone;
    assert.equal(scriptCalls, 0);
    assert.ok(synthCalls > 0);
    assert.equal(readLectureState(uid, date)?.status, 'ready');
  } finally {
    cleanup(uid);
  }
});

test('4) daily cap exceeded skips script/TTS (0 calls), preserves ready lecture/audio, and records diag cap fields (local and remote)', async () => {
  const uidLocal = uidFor('cap_local');
  const uidRemote = uidFor('cap_remote');
  const date = '2026-11-25';
  const inputs = twoInputs();
  const items = twoScriptItems();
  const nowMs = Date.parse('2026-11-25T02:00:00.000Z');
  const prevCap = process.env.LECTURE_DAILY_GEN_CAP;

  try {
    process.env.LECTURE_DAILY_GEN_CAP = '1';
    let calls = 0;
    let readyResolve!: () => void;
    const readyDone = new Promise<void>((r) => { readyResolve = r; });

    startLectureJob(ai, uidLocal, date, inputs, [], {
      now: nowMs,
      generateScriptFn: async () => {
        calls += 1;
        return { title: '상한 테스트', items, coachNote: '첫 문장. 둘째 문장.' };
      },
      synthesizeFn: async () => {
        calls += 1;
        return silentPcm(0.2);
      },
      encodeFn: wavEncode,
      onReady: () => readyResolve(),
    });
    await readyDone;
    const callsAfterFirst = calls;
    const audioBefore = lectureAudioPath(uidLocal, date);
    assert.ok(audioBefore);

    const blocked = startLectureJob(ai, uidLocal, date, inputs, [], {
      force: true,
      now: nowMs,
      generateScriptFn: async () => {
        calls += 1;
        return { title: 'blocked', items, coachNote: 'a. b.' };
      },
      synthesizeFn: async () => {
        calls += 1;
        return silentPcm();
      },
      encodeFn: wavEncode,
    });

    assert.equal(calls, callsAfterFirst);
    assert.equal(blocked.status, 'ready');
    assert.equal(blocked.title, '상한 테스트');
    assert.ok(fs.existsSync(audioBefore!));

    const stLocal: FeedSyncState = {
      uid: uidLocal,
      secret: 'a'.repeat(48),
      quizCount: 0,
      newMistakes: inputs,
      reviewMistakes: [],
      syncedAt: new Date(nowMs).toISOString(),
    };
    const diagLocal = buildFeedDiag(stLocal, { date, now: nowMs });
    assert.equal(diagLocal.dailyGenCount, 1);
    assert.equal(diagLocal.dailyGenCap, 1);
    assert.equal(diagLocal.genSkipReason, 'daily_cap');

    // Remote cap = 2 with gc.genCount = 2
    process.env.LECTURE_DAILY_GEN_CAP = '2';
    const mem = memoryGenRemote({ genCount: 2 });
    let remoteCalls = 0;
    startLectureJob(ai, uidRemote, date, inputs, [], {
      now: nowMs,
      genRemote: mem.remote,
      generateScriptFn: async () => {
        remoteCalls += 1;
        return { title: 'blocked', items, coachNote: 'a. b.' };
      },
      synthesizeFn: async () => {
        remoteCalls += 1;
        return silentPcm();
      },
    });
    const afterRemote = await waitForJobSettled(uidRemote, date, nowMs);
    assert.equal(remoteCalls, 0);
    assert.equal(afterRemote?.status, 'failed');
    assert.equal(afterRemote?.error, LECTURE_GEN_SKIPPED);

    const stRemote: FeedSyncState = { ...stLocal, uid: uidRemote };
    const diagRemote = buildFeedDiag(stRemote, { date, now: nowMs });
    assert.equal(diagRemote.dailyGenCount, 2);
    assert.equal(diagRemote.dailyGenCap, 2);
    assert.equal(diagRemote.genSkipReason, 'daily_cap');
  } finally {
    if (prevCap === undefined) delete process.env.LECTURE_DAILY_GEN_CAP;
    else process.env.LECTURE_DAILY_GEN_CAP = prevCap;
    cleanup(uidLocal);
    cleanup(uidRemote);
  }
});

test('5) 429 & AUTH fail immediately with 0 retries, set 30m/6h cooldown in state and gen file, block buildFeedToday, allow ignoreCooldown', async () => {
  const uid429 = uidFor('cd_429');
  const uidAuth = uidFor('cd_auth');
  const date = '2026-11-25';
  const inputs = twoInputs();
  const items = twoScriptItems();

  // Direct synthesizeGemini check: 429 and 403 -> 1 generateContent call, 0 sleeps
  for (const status of [429, 403]) {
    let genCalls = 0;
    const sleeps: number[] = [];
    await assert.rejects(
      synthesizeGemini(
        {
          models: {
            generateContent: async () => {
              genCalls += 1;
              throw Object.assign(new Error(status === 429 ? 'RESOURCE_EXHAUSTED' : 'PERMISSION_DENIED'), { status });
            },
          },
        } as unknown as GoogleGenAI,
        'Coach: hello',
        false,
        undefined,
        { sleepFn: async (ms) => { sleeps.push(ms); } }
      )
    );
    assert.equal(genCalls, 1);
    assert.deepEqual(sleeps, []);
  }

  try {
    // Job path: 429 on TTS -> 30m cooldown
    let synth429 = 0;
    startLectureJob(ai, uid429, date, inputs, [], {
      generateScriptFn: async () => ({ title: '429 테스트', items, coachNote: '첫 문장. 둘째 문장.' }),
      synthesizeFn: async () => {
        synth429 += 1;
        throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
      },
      encodeFn: wavEncode,
    });
    const st429 = await waitForJobSettled(uid429, date);
    assert.equal(st429?.status, 'failed');
    assert.equal(st429?.audioError?.code, 'QUOTA');
    const gen429 = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, 'lectures', uid429, `${date}.gen.json`), 'utf8')
    );
    assert.equal(gen429.cooldownUntil, st429?.audioRetryAfter);
    const retry429Ms = Date.parse(st429!.audioRetryAfter!) - Date.parse(st429!.updatedAt);
    assert.ok(retry429Ms >= 29 * 60 * 1000 && retry429Ms <= 31 * 60 * 1000);

    // Job path: 403 AUTH on script -> 6h cooldown
    startLectureJob(ai, uidAuth, date, inputs, [], {
      generateScriptFn: async () => {
        throw Object.assign(new Error('PERMISSION_DENIED'), { status: 403 });
      },
      synthesizeFn: async () => silentPcm(),
      encodeFn: wavEncode,
    });
    const stAuth = await waitForJobSettled(uidAuth, date);
    assert.equal(stAuth?.status, 'failed');
    assert.equal(stAuth?.audioError?.code, 'AUTH');
    const genAuth = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, 'lectures', uidAuth, `${date}.gen.json`), 'utf8')
    );
    assert.equal(genAuth.cooldownUntil, stAuth?.audioRetryAfter);
    const retryAuthMs = Date.parse(stAuth!.audioRetryAfter!) - Date.parse(stAuth!.updatedAt);
    assert.ok(retryAuthMs >= 5.9 * 3600 * 1000 && retryAuthMs <= 6.1 * 3600 * 1000);

    // Next buildFeedToday (at 11:00 KST on same day) must make 0 spy calls
    const feed429: FeedSyncState = {
      uid: uid429,
      secret: 'q'.repeat(48),
      quizCount: 0,
      newMistakes: inputs,
      reviewMistakes: [],
      syncedAt: new Date().toISOString(),
    };
    const lecture429 = path.join(DATA_DIR, 'lectures', uid429, `${date}.json`);
    const disk429 = JSON.parse(fs.readFileSync(lecture429, 'utf8'));
    disk429.audioRetryAfter = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(lecture429, JSON.stringify(disk429, null, 2));
    const synthBeforeFeed = synth429;
    let feedStartCalls = 0;
    buildFeedToday(ai, feed429, 'https://example.test', {
      date,
      now: Date.now(),
      startJob: (a, u, d, n, r, o) => {
        feedStartCalls += 1;
        return startLectureJob(a, u, d, n, r, {
          ...o,
          synthesizeFn: async () => {
            synth429 += 1;
            return silentPcm();
          },
        });
      },
    });
    assert.equal(feedStartCalls, 1);
    assert.equal(synth429, synthBeforeFeed);
    // Also verify non-force startLectureJob is blocked by cooldown regardless of time-of-day
    startLectureJob(ai, uid429, date, inputs, [], {
      generateScriptFn: async () => {
        synth429 += 1;
        return { title: 'blocked', items, coachNote: 'a. b.' };
      },
      synthesizeFn: async () => {
        synth429 += 1;
        return silentPcm();
      },
    });
    assert.equal(synth429, synthBeforeFeed);

    // ignoreCooldown: true passes gate and succeeds
    let readyResolve!: () => void;
    const readyDone = new Promise<void>((r) => { readyResolve = r; });
    startLectureJob(ai, uid429, date, inputs, [], {
      force: true,
      ignoreCooldown: true,
      generateScriptFn: async () => ({ title: '복구', items, coachNote: '첫 문장. 둘째 문장.' }),
      synthesizeFn: async () => {
        synth429 += 1;
        return silentPcm(0.2);
      },
      encodeFn: wavEncode,
      onReady: () => readyResolve(),
    });
    await readyDone;
    assert.ok(synth429 > synthBeforeFeed);
    assert.equal(readLectureState(uid429, date)?.status, 'ready');
  } finally {
    cleanup(uid429);
    cleanup(uidAuth);
  }
});

test('6) 0-billable-call failure (first call 429) refunds dailyGenCount back to 0', async () => {
  const uid = uidFor('refund_zero');
  const date = '2026-11-25';
  const inputs = twoInputs();

  try {
    startLectureJob(ai, uid, date, inputs, [], {
      generateScriptFn: async () => {
        throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
      },
      synthesizeFn: async () => silentPcm(),
      encodeFn: wavEncode,
    });
    const failed = await waitForJobSettled(uid, date);
    assert.equal(failed?.status, 'failed');

    const st: FeedSyncState = {
      uid,
      secret: 'z'.repeat(48),
      quizCount: 0,
      newMistakes: inputs,
      reviewMistakes: [],
      syncedAt: new Date().toISOString(),
    };
    const diag = buildFeedDiag(st, { date });
    assert.equal(diag.dailyGenCount, 0);
  } finally {
    cleanup(uid);
  }
});
