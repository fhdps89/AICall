import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import {
  DATA_DIR,
  LECTURE_AUDIO_REBUILD_TIMED_OUT,
  installBackupLectureWithoutAudio,
  installRestoredLectureAudio,
  lectureAudioPath,
  lectureRebuildInFlight,
  readLectureState,
  startLectureAudioRebuild,
  startLectureJob,
  synthesizeGemini,
  type LecturePcm,
  type LectureScriptItem,
  type LectureState,
} from '../server/lecture.ts';
import { buildFeedToday, ensureTodayLecture, feedOnFailed, type FeedSyncState } from '../server/feed.ts';
import { decryptLectureBackup, feedDocId, saveLectureFailureBackup } from '../server/feedStore.ts';
import { encryptLectureAudio, splitAudioBlob } from '../server/lectureAudioBackup.ts';
import { classifyLectureAudioError, cooldownMsFor } from '../server/lectureAudioError.ts';
import { wavFromPcm, type LectureEncodeFn } from '../server/lectureAudioEncode.ts';

const ai = {} as GoogleGenAI;

function uidFor(name: string): string {
  return `test_audioerr_${name}_${process.pid}`;
}

function cleanup(uid: string) {
  fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
}

function sampleScript(): LectureScriptItem[] {
  return [
    {
      mistakeId: 'm1',
      kind: 'new',
      myPhrase: 'I go yesterday',
      naturalPhrase: 'I went yesterday',
      explanation: '과거 시제',
      dialogue: [{ speaker: 'Coach', line: 'Try again' }],
      meaningKo: '갔다',
      answerEnglish: 'I went yesterday',
    },
  ];
}

function sampleReady(uid: string, date: string): LectureState {
  const now = '2026-11-25T00:00:00.000Z';
  return {
    uid,
    date,
    status: 'ready',
    title: '오류 테스트 강의',
    script: sampleScript(),
    coachNote: '첫 문장. 둘째 문장.',
    itemCount: 1,
    newMistakeIds: ['m1'],
    reviewMistakeIds: [],
    ttsEngine: 'gemini',
    createdAt: now,
    updatedAt: now,
  };
}

const wavEncode: LectureEncodeFn = async (pcm, rate) => ({
  ext: 'wav',
  mime: 'audio/wav',
  buffer: wavFromPcm(pcm, rate),
});

function silentPcm(): LecturePcm {
  return { data: Buffer.alloc(2400 * 2), rate: 24000 };
}

const EXPECTED_ERROR_KEYS = [
  'stage',
  'code',
  'httpStatus',
  'googleStatus',
  'quota',
  'retryDelaySec',
  'attempts',
  'completed',
  'total',
  'at',
  'origin',
];

test('7) classifyLectureAudioError maps all categories, matches exact allow-list, and never leaks raw message/URL', () => {
  const MARKER = 'SENSITIVE_MARKER_https://generativelanguage.googleapis.com/?key=AIzaFakeSecret';
  const cases: Array<{ err: any; ctx?: any; expect: Partial<ReturnType<typeof classifyLectureAudioError>> }> = [
    {
      err: { status: 429, message: `{"status":"RESOURCE_EXHAUSTED","metric":"GenerateRequestsPerDayPerModel"} ${MARKER}` },
      ctx: { stage: 'tts', attempts: 1 },
      expect: { code: 'QUOTA_DAILY', quota: 'day', httpStatus: 429, googleStatus: 'RESOURCE_EXHAUSTED' },
    },
    {
      err: { status: 429, message: `{"status":"RESOURCE_EXHAUSTED","metric":"PerMinute","retryDelay":"12s"} ${MARKER}` },
      ctx: { stage: 'tts', attempts: 3 },
      expect: { code: 'QUOTA', quota: 'minute', retryDelaySec: 12, httpStatus: 429, googleStatus: 'RESOURCE_EXHAUSTED' },
    },
    {
      err: { status: 404, message: `NOT_FOUND ${MARKER}` },
      expect: { code: 'MODEL_NOT_FOUND', httpStatus: 404, googleStatus: 'NOT_FOUND' },
    },
    {
      err: { status: 400, message: `API_KEY_INVALID INVALID_ARGUMENT ${MARKER}` },
      expect: { code: 'AUTH', httpStatus: 400, googleStatus: 'INVALID_ARGUMENT' },
    },
    {
      err: { status: 403, message: `PERMISSION_DENIED ${MARKER}` },
      expect: { code: 'AUTH', httpStatus: 403, googleStatus: 'PERMISSION_DENIED' },
    },
    {
      err: { status: 503, message: `UNAVAILABLE ${MARKER}` },
      expect: { code: 'UNAVAILABLE', httpStatus: 503, googleStatus: 'UNAVAILABLE' },
    },
    {
      err: new Error(`audio rebuild timed out after 1000ms ${MARKER}`),
      expect: { code: 'REBUILD_TIMEOUT', stage: 'rebuild_timeout' },
    },
    {
      err: new Error(`lecture job timed out after 900000ms ${MARKER}`),
      ctx: { stage: 'script' },
      expect: { code: 'REBUILD_TIMEOUT', stage: 'script' },
    },
    {
      err: new Error(`lecture TTS timed out after 90000ms ${MARKER}`),
      expect: { code: 'STEP_TIMEOUT' },
    },
    {
      err: new Error(`TTS 음성 데이터 없음 ${MARKER}`),
      expect: { code: 'NO_AUDIO' },
    },
    {
      err: new Error(`duration fit did not converge ${MARKER}`),
      expect: { code: 'FIT_NO_CONVERGE' },
    },
    {
      err: Object.assign(new Error(`no space ${MARKER}`), { code: 'ENOSPC' }),
      expect: { code: 'DISK' },
    },
    {
      err: Object.assign(new Error(`fetch failed ${MARKER}`), { cause: { code: 'ECONNRESET' } }),
      expect: { code: 'NETWORK' },
    },
    {
      err: new Error(`completely unknown failure ${MARKER}`),
      expect: { code: 'UNKNOWN', httpStatus: null, googleStatus: null, quota: null, retryDelaySec: null },
    },
  ];

  for (const c of cases) {
    const out = classifyLectureAudioError(c.err, c.ctx);
    assert.deepEqual(Object.keys(out), EXPECTED_ERROR_KEYS);
    for (const [k, v] of Object.entries(c.expect)) {
      assert.equal((out as any)[k], v, `mismatch on ${k} for ${c.expect.code}`);
    }
    const raw = JSON.stringify(out);
    assert.equal(raw.includes('SENSITIVE_MARKER'), false);
    assert.equal(raw.includes('AIzaFakeSecret'), false);
    assert.equal(raw.includes('https://'), false);
  }
});

test('8) synthesizeGemini retry policy: 404, QUOTA_DAILY, and 429 (QUOTA) stop at 1 with 0 sleeps; generic sleeps [1500, 3000]', async () => {
  // 404 -> 1 call, 0 sleeps
  let calls404 = 0;
  const sleeps404: number[] = [];
  await assert.rejects(
    synthesizeGemini(
      {
        models: {
          generateContent: async () => {
            calls404 += 1;
            throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
          },
        },
      } as unknown as GoogleGenAI,
      'Coach: hi',
      false,
      undefined,
      { sleepFn: async (ms) => { sleeps404.push(ms); }, now: () => 1_000_000 }
    ),
    (err: any) => err?.attempts === 1
  );
  assert.equal(calls404, 1);
  assert.deepEqual(sleeps404, []);

  // QUOTA_DAILY -> 1 call, 0 sleeps
  let callsDaily = 0;
  const sleepsDaily: number[] = [];
  await assert.rejects(
    synthesizeGemini(
      {
        models: {
          generateContent: async () => {
            callsDaily += 1;
            throw Object.assign(new Error('RESOURCE_EXHAUSTED PerDay'), { status: 429 });
          },
        },
      } as unknown as GoogleGenAI,
      'Coach: hi',
      false,
      undefined,
      { sleepFn: async (ms) => { sleepsDaily.push(ms); }, now: () => 1_000_000 }
    ),
    (err: any) => err?.attempts === 1
  );
  assert.equal(callsDaily, 1);
  assert.deepEqual(sleepsDaily, []);

  // 429 (QUOTA) -> 1 call, 0 sleeps, throws immediately
  let calls429 = 0;
  const sleeps429: number[] = [];
  await assert.rejects(
    synthesizeGemini(
      {
        models: {
          generateContent: async () => {
            calls429 += 1;
            throw Object.assign(new Error('{"status":"RESOURCE_EXHAUSTED","retryDelay":"2s"}'), {
              status: 429,
            });
          },
        },
      } as unknown as GoogleGenAI,
      'Coach: hi',
      false,
      undefined,
      { sleepFn: async (ms) => { sleeps429.push(ms); }, now: () => 1_000_000 }
    ),
    (err: any) => err?.attempts === 1
  );
  assert.equal(calls429, 1);
  assert.deepEqual(sleeps429, []);

  // Generic error -> 3 calls, sleeps [1500, 3000]
  let callsGen = 0;
  const sleepsGen: number[] = [];
  await assert.rejects(
    synthesizeGemini(
      {
        models: {
          generateContent: async () => {
            callsGen += 1;
            throw new Error('transient boom');
          },
        },
      } as unknown as GoogleGenAI,
      'Coach: hi',
      false,
      undefined,
      { sleepFn: async (ms) => { sleepsGen.push(ms); }, now: () => 1_000_000 }
    ),
    (err: any) => err?.attempts === 3
  );
  assert.equal(callsGen, 3);
  assert.deepEqual(sleepsGen, [1500, 3000]);
});

test('9) rebuild 429 keeps error=GENERATION_FAILED, records audioError & audioRetryAfter, onFailed PATCHes without pointers, superseded skips PATCH', async () => {
  const uid = uidFor('rebuild_429');
  const date = '2026-11-25';
  const secret = 'fail_secret_marker_' + 'g'.repeat(29);
  const docId = feedDocId(secret);
  const dir = path.join(DATA_DIR, 'lectures', uid);
  const realFetch = globalThis.fetch;
  const origErr = console.error;
  const errLogs: string[] = [];
  console.error = (...a: any[]) => errLogs.push(a.map(String).join(' '));

  let patchBody: any = null;
  let patchCalls = 0;
  const RAW_URL_MARKER = 'https://secret.api.example.com/v1?key=SECRET123';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const ready: LectureState = {
      ...sampleReady(uid, date),
      audioBackupId: 'old-bak-id',
      audioChunks: 4,
    };
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(ready));

    (globalThis as any).fetch = async (_url: string, init: any = {}) => {
      if (init.method === 'PATCH') {
        assert.ok(init.signal instanceof AbortSignal);
        patchCalls += 1;
        patchBody = JSON.parse(init.body);
        return { ok: true, status: 200 };
      }
      return { ok: false, status: 404 };
    };

    const feedSt: FeedSyncState = {
      uid,
      secret,
      quizCount: 0,
      newMistakes: [],
      reviewMistakes: [],
      syncedAt: '2026-11-25T00:00:00.000Z',
    };

    startLectureAudioRebuild(ai, uid, date, undefined, {
      synthesizeFn: async () => {
        throw Object.assign(new Error(`RESOURCE_EXHAUSTED ${RAW_URL_MARKER}`), {
          status: 429,
          attempts: 3,
        });
      },
      encodeFn: wavEncode,
      onFailed: feedOnFailed(feedSt),
    });
    await lectureRebuildInFlight(uid, date);

    const local = readLectureState(uid, date);
    assert.equal(local?.status, 'ready');
    assert.equal(local?.audioStatus, 'missing');
    assert.equal(local?.error, 'GENERATION_FAILED');
    assert.equal(local?.audioError?.code, 'QUOTA');
    assert.equal(local?.audioError?.stage, 'tts');
    assert.equal(local?.audioError?.attempts, 3);
    assert.equal(local?.audioError?.completed, 0);
    assert.ok((local?.audioError?.total ?? 0) >= 1);
    assert.equal(local?.audioError?.origin, 'local');
    assert.ok(local?.audioRetryAfter);
    assert.ok(local?.audioRebuildFailedAt);

    assert.equal(patchCalls, 1);
    assert.ok(patchBody);
    const dec = decryptLectureBackup(
      secret,
      patchBody.fields.iv.stringValue,
      patchBody.fields.data.stringValue
    );
    // Pointer preservation: rebuild failure alone does not wipe existing chunk pointers
    assert.equal(dec.audioBackupId, 'old-bak-id');
    assert.equal(dec.audioChunks, 4);
    assert.equal(dec.audioError?.code, 'QUOTA');
    assert.ok(dec.audioRebuildFailedAt);
    assert.ok(dec.audioRetryAfter);

    const parsedRebuildLog = JSON.parse(errLogs[0].replace('[Lecture] audio rebuild failed: ', ''));
    assert.equal(parsedRebuildLog.errName, 'Error');

    for (const msg of errLogs) {
      assert.equal(msg.includes(secret), false);
      assert.equal(msg.includes(docId), false);
      assert.equal(msg.includes('SECRET123'), false);
      assert.equal(msg.includes('https://'), false);
    }

    // Superseded (epoch changed / isCurrent false) -> 0 PATCH calls
    const beforeCalls = patchCalls;
    await saveLectureFailureBackup(secret, local!, () => false);
    assert.equal(patchCalls, beforeCalls);

    // Also test epoch superseding during startLectureAudioRebuild
    let triggerFail!: () => void;
    startLectureAudioRebuild(ai, uid, date, undefined, {
      ignoreCooldown: true,
      synthesizeFn: () =>
        new Promise((_r, rej) => {
          triggerFail = () => rej(Object.assign(new Error('fail'), { status: 503 }));
        }),
      encodeFn: wavEncode,
      onFailed: feedOnFailed(feedSt),
    });
    // Force a new job so epoch changes before the rebuild rejects
    startLectureJob(
      ai,
      uid,
      date,
      [{ id: 'm-new', myPhrase: 'a', naturalPhrase: 'b' }],
      [],
      {
        force: true,
        ignoreCooldown: true,
        runJobFn: async () => {},
      }
    );
    triggerFail();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(patchCalls, beforeCalls);
  } finally {
    (globalThis as any).fetch = realFetch;
    console.error = origErr;
    cleanup(uid);
  }
});

test('10) ensureTodayLecture honors cooldown (10m vs 31m vs QUOTA_DAILY audioRetryAfter) and installs ready/missing so startJob is 0', async () => {
  const uid10 = uidFor('cd_10m');
  const uid31 = uidFor('cd_31m');
  const uidDaily = uidFor('cd_daily');
  const date = '2026-11-25';
  const nowMs = Date.parse('2026-11-25T02:00:00.000Z'); // 11:00 KST

  try {
    // 10 min ago -> restore 0, local ready/missing installed, buildFeedToday startJob 0
    const failed10m = new Date(nowMs - 10 * 60 * 1000).toISOString();
    const backup10m: LectureState = {
      ...sampleReady(uid10, date),
      audioRebuildFailedAt: failed10m,
      audioError: classifyLectureAudioError({ status: 503 }, { stage: 'tts', attempts: 3, at: failed10m }),
    };
    const st10: FeedSyncState = {
      uid: uid10,
      secret: 'h'.repeat(48),
      quizCount: 1,
      newMistakes: [{ id: 'm2', myPhrase: 'x', naturalPhrase: 'y' }],
      reviewMistakes: [],
      syncedAt: '2026-11-25T00:00:00.000Z',
    };
    let restore10 = 0;
    await ensureTodayLecture(ai, st10, date, {
      now: nowMs,
      loadBackup: async () => backup10m,
      restoreLecture: (() => {
        restore10 += 1;
        return null;
      }) as any,
      synthesizeFn: async () => silentPcm(),
    });
    assert.equal(restore10, 0);
    const local10 = readLectureState(uid10, date, nowMs);
    assert.equal(local10?.status, 'ready');
    assert.equal(local10?.audioStatus, 'missing');
    assert.equal(local10?.error, 'GENERATION_FAILED');
    assert.equal(local10?.audioError?.origin, 'backup');

    // installBackupLectureWithoutAudio fills AUDIO_REBUILD_TIMED_OUT when code is REBUILD_TIMEOUT
    const rtInstalled = installBackupLectureWithoutAudio(uid10, date, {
      ...sampleReady(uid10, date),
      audioError: classifyLectureAudioError(new Error('audio rebuild timed out after 100ms')),
    });
    assert.equal(rtInstalled?.error, LECTURE_AUDIO_REBUILD_TIMED_OUT);

    let startJob10 = 0;
    const feed10 = buildFeedToday(ai, st10, 'https://example.test', {
      date,
      now: nowMs,
      startJob: () => {
        startJob10 += 1;
        throw new Error('must not startJob');
      },
    });
    assert.equal(startJob10, 0);
    assert.equal(feed10.status, 'ready');
    assert.equal(feed10.audioRestoring, false);

    // 31 min ago (no audioRetryAfter) -> restore 1
    const failed31m = new Date(nowMs - 31 * 60 * 1000).toISOString();
    const backup31m: LectureState = {
      ...sampleReady(uid31, date),
      audioRebuildFailedAt: failed31m,
    };
    const st31: FeedSyncState = { ...st10, uid: uid31 };
    let restore31 = 0;
    await ensureTodayLecture(ai, st31, date, {
      now: nowMs,
      loadBackup: async () => backup31m,
      restoreLecture: (() => {
        restore31 += 1;
        return null;
      }) as any,
      synthesizeFn: async () => silentPcm(),
    });
    assert.equal(restore31, 1);

    // QUOTA_DAILY 1 hour ago with 6h audioRetryAfter in future -> restore 0, startJob 0
    const failed1h = nowMs - 60 * 60 * 1000;
    const dailyErr = classifyLectureAudioError(
      { status: 429, message: 'PerDay' },
      { stage: 'tts', attempts: 1, at: new Date(failed1h).toISOString() }
    );
    const backupDaily: LectureState = {
      ...sampleReady(uidDaily, date),
      audioRebuildFailedAt: new Date(failed1h).toISOString(),
      audioRetryAfter: new Date(failed1h + cooldownMsFor(dailyErr.code)).toISOString(),
      audioError: dailyErr,
    };
    const stDaily: FeedSyncState = { ...st10, uid: uidDaily };
    let restoreDaily = 0;
    await ensureTodayLecture(ai, stDaily, date, {
      now: nowMs,
      loadBackup: async () => backupDaily,
      restoreLecture: (() => {
        restoreDaily += 1;
        return null;
      }) as any,
      synthesizeFn: async () => silentPcm(),
    });
    assert.equal(restoreDaily, 0);
    let startJobDaily = 0;
    buildFeedToday(ai, stDaily, 'https://example.test', {
      date,
      now: nowMs,
      startJob: () => {
        startJobDaily += 1;
        throw new Error('must not startJob');
      },
    });
    assert.equal(startJobDaily, 0);
  } finally {
    cleanup(uid10);
    cleanup(uid31);
    cleanup(uidDaily);
  }
});

test('11) succeeding after failure clears audioError and audioRetryAfter', async () => {
  const uid = uidFor('clear_on_success');
  const date = '2026-11-25';
  const dir = path.join(DATA_DIR, 'lectures', uid);

  try {
    fs.mkdirSync(dir, { recursive: true });
    const failedState: LectureState = {
      ...sampleReady(uid, date),
      audioStatus: 'missing',
      error: 'GENERATION_FAILED',
      audioRebuildFailedAt: '2026-11-25T00:10:00.000Z',
      audioRetryAfter: '2026-11-25T00:40:00.000Z',
      audioError: classifyLectureAudioError({ status: 503 }, { stage: 'tts', attempts: 3 }),
    };
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(failedState));

    startLectureAudioRebuild(ai, uid, date, undefined, {
      ignoreCooldown: true,
      synthesizeFn: async () => silentPcm(),
      encodeFn: wavEncode,
    });
    await lectureRebuildInFlight(uid, date);

    const afterRebuild = readLectureState(uid, date);
    assert.equal(afterRebuild?.audioStatus, 'ready');
    assert.equal(afterRebuild?.audioError, undefined);
    assert.equal(afterRebuild?.audioRetryAfter, undefined);
    assert.equal(afterRebuild?.audioRebuildFailedAt, undefined);

    // Also verify installRestoredLectureAudio clears audioError and audioRetryAfter
    const installed = installRestoredLectureAudio(uid, date, failedState, {
      ext: 'wav',
      mime: 'audio/wav',
      buffer: Buffer.from('RIFFok'),
      durationSec: 365,
    });
    assert.equal(installed?.audioStatus, 'ready');
    assert.equal(installed?.audioError, undefined);
    assert.equal(installed?.audioRetryAfter, undefined);
  } finally {
    cleanup(uid);
  }
});

test('12) synthesizeGemini 429 (QUOTA) always fails on 1st attempt with 0 sleep regardless of retryDelay', async () => {
  for (const msg of [
    '{"status":"RESOURCE_EXHAUSTED","retryDelay":"120s"}',
    '{"status":"RESOURCE_EXHAUSTED"}',
    '{"status":"RESOURCE_EXHAUSTED","retryDelay":"0s"}',
  ]) {
    let calls = 0;
    const sleeps: number[] = [];
    await assert.rejects(
      synthesizeGemini(
        {
          models: {
            generateContent: async () => {
              calls += 1;
              throw Object.assign(new Error(msg), { status: 429 });
            },
          },
        } as unknown as GoogleGenAI,
        'Coach: hi',
        false,
        undefined,
        { sleepFn: async (ms) => { sleeps.push(ms); }, now: () => 1_000_000 }
      ),
      (err: any) => err?.attempts === 1
    );
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  }
});

test('13) synthesizeGemini aborts per-attempt generateContent abortSignal on stepTimeoutMs', async () => {
  const capturedSignals: AbortSignal[] = [];
  let attempt = 0;
  const pcm = await synthesizeGemini(
    {
      models: {
        generateContent: async (req: any) => {
          attempt += 1;
          const sig = req.config.abortSignal as AbortSignal;
          capturedSignals.push(sig);
          if (attempt === 1) {
            return new Promise((_, reject) => {
              sig.addEventListener(
                'abort',
                () => reject(Object.assign(new Error('aborted by step timeout'), { name: 'TimeoutError' })),
                { once: true }
              );
            });
          }
          return {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        data: Buffer.alloc(240).toString('base64'),
                        mimeType: 'audio/pcm;rate=24000',
                      },
                    },
                  ],
                },
              },
            ],
          };
        },
      },
    } as unknown as GoogleGenAI,
    'Coach: timeout test',
    false,
    undefined,
    { stepTimeoutMs: 25, sleepFn: async () => {} }
  );
  assert.equal(pcm.rate, 24000);
  assert.equal(capturedSignals.length, 2);
  assert.equal(capturedSignals[0].aborted, true);
  assert.notEqual(capturedSignals[0], capturedSignals[1]);
  assert.equal(capturedSignals[1].aborted, false);
});

test('14) startLectureJob calls onFailed on failure and skips abortCurrentJob when onFailed starts a new job', async () => {
  const uidFail = uidFor('job_onfailed');
  const uidTimeout = uidFor('job_to_new');
  const date = '2026-11-25';

  try {
    let failState: LectureState | undefined;
    let failCurrent = false;
    startLectureJob(
      ai,
      uidFail,
      date,
      [{ id: 'm1', myPhrase: 'a', naturalPhrase: 'b' }],
      [],
      {
        runJobFn: async () => {
          throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
        },
        onFailed: (st, isCurrent) => {
          failState = { ...st };
          failCurrent = isCurrent();
        },
      }
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(failState?.status, 'failed');
    assert.equal(failState?.error, 'GENERATION_FAILED');
    assert.equal(failState?.audioError?.code, 'QUOTA');
    assert.equal(failCurrent, true);

    // Timeout in startLectureJob whose onFailed starts a new job: abortCurrentJob must be skipped
    let newJobSignal: AbortSignal | undefined;
    let timedOutState: LectureState | undefined;
    const origErr = console.error;
    const jobLogs: string[] = [];
    console.error = (...a: any[]) => jobLogs.push(a.map(String).join(' '));
    try {
      startLectureJob(
        ai,
        uidTimeout,
        date,
        [{ id: 'm1', myPhrase: 'a', naturalPhrase: 'b' }],
        [],
        {
          jobTimeoutMs: 25,
          runJobFn: () => new Promise(() => {}),
          onFailed: (st) => {
            timedOutState = { ...st };
            startLectureJob(
              ai,
              uidTimeout,
              date,
              [{ id: 'm2', myPhrase: 'c', naturalPhrase: 'd' }],
              [],
              {
                runJobFn: async (_ai, nextSt, _n, _r, ctx) => {
                  newJobSignal = ctx.signal;
                  await new Promise((r) => setTimeout(r, 20));
                  nextSt.status = 'ready';
                  nextSt.title = 'recovered';
                  nextSt.script = sampleScript();
                  ctx.write(nextSt);
                },
              }
            );
          },
        }
      );
      await new Promise((r) => setTimeout(r, 80));
    } finally {
      console.error = origErr;
    }
    assert.equal(timedOutState?.error, 'TIMED_OUT');
    assert.equal(timedOutState?.audioError?.code, 'REBUILD_TIMEOUT');
    assert.equal(timedOutState?.audioError?.stage, 'script');
    assert.equal(newJobSignal?.aborted, false);
    assert.equal(readLectureState(uidTimeout, date)?.status, 'ready');
    assert.equal(readLectureState(uidTimeout, date)?.title, 'recovered');
    const parsedJobLog = JSON.parse(jobLogs[0].replace('[Lecture] job failed: ', ''));
    assert.equal(parsedJobLog.errName, 'Error');
  } finally {
    cleanup(uidFail);
    cleanup(uidTimeout);
  }
});

test('15) failure backup preserves pointers on transient chunk failure and clears them on confirmed missing', async () => {
  const uidKeep = uidFor('ptr_keep');
  const uidClear = uidFor('ptr_clear');
  const date = '2026-11-25';
  const secretKeep = 'p'.repeat(48);
  const secretClear = 'q'.repeat(48);
  const realFetch = globalThis.fetch;

  try {
    // 1) Transient (503) -> backup payload's pointers are carried into state and preserved on failure PATCH
    let keepPatchBody: any = null;
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      if (init.method === 'PATCH') {
        keepPatchBody = JSON.parse(init.body);
        return { ok: true, status: 200 };
      }
      if (String(url).includes('/audio/')) {
        return { ok: false, status: 503 };
      }
      return { ok: false, status: 404 };
    };
    const backupKeep: LectureState = {
      ...sampleReady(uidKeep, date),
      audioBackupId: 'bak-keep-1',
      audioChunks: 3,
    };
    const stKeep: FeedSyncState = {
      uid: uidKeep,
      secret: secretKeep,
      quizCount: 0,
      newMistakes: [],
      reviewMistakes: [],
      syncedAt: '2026-11-25T00:00:00.000Z',
    };
    await ensureTodayLecture(ai, stKeep, date, {
      loadBackup: async () => backupKeep,
      synthesizeFn: async () => {
        throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
      },
    });
    await lectureRebuildInFlight(uidKeep, date);
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(keepPatchBody);
    const decKeep = decryptLectureBackup(
      secretKeep,
      keepPatchBody.fields.iv.stringValue,
      keepPatchBody.fields.data.stringValue
    );
    assert.equal(decKeep.audioBackupId, 'bak-keep-1');
    assert.equal(decKeep.audioChunks, 3);
    assert.equal(decKeep.audioError?.code, 'QUOTA');
    assert.equal(readLectureState(uidKeep, date)?.audioBackupId, 'bak-keep-1');

    // 2) Confirmed missing (404 / GCM fail / id mismatch) -> pointers cleared on failure PATCH and local state
    let clearPatchBody: any = null;
    const encBlob = encryptLectureAudio(
      secretClear,
      {
        v: 1,
        date,
        audioBackupId: 'bak-other-id',
        ext: 'wav',
        mime: 'audio/wav',
        durationSec: 10,
        bytes: 4,
      },
      Buffer.from('RIFF')
    );
    const mismatchChunks = splitAudioBlob(encBlob);
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      if (init.method === 'PATCH') {
        clearPatchBody = JSON.parse(init.body);
        return { ok: true, status: 200 };
      }
      if (String(url).includes('/audio/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ fields: { data: { stringValue: mismatchChunks[0] } } }),
        };
      }
      return { ok: false, status: 404 };
    };
    const backupClear: LectureState = {
      ...sampleReady(uidClear, date),
      audioBackupId: 'bak-gone-1',
      audioChunks: mismatchChunks.length,
    };
    const stClear: FeedSyncState = {
      uid: uidClear,
      secret: secretClear,
      quizCount: 0,
      newMistakes: [],
      reviewMistakes: [],
      syncedAt: '2026-11-25T00:00:00.000Z',
    };
    await ensureTodayLecture(ai, stClear, date, {
      loadBackup: async () => backupClear,
      synthesizeFn: async () => {
        throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
      },
    });
    await lectureRebuildInFlight(uidClear, date);
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(clearPatchBody);
    const decClear = decryptLectureBackup(
      secretClear,
      clearPatchBody.fields.iv.stringValue,
      clearPatchBody.fields.data.stringValue
    );
    assert.equal(decClear.audioBackupId, undefined);
    assert.equal(decClear.audioChunks, undefined);
    assert.equal(readLectureState(uidClear, date)?.audioBackupId, undefined);
    assert.equal(readLectureState(uidClear, date)?.audioChunks, undefined);
  } finally {
    (globalThis as any).fetch = realFetch;
    cleanup(uidKeep);
    cleanup(uidClear);
  }
});

test('16) manual rebuild starts a new job even while onFailed is unresolved, clears stale audioBackup, and honors audioRetryAfter', async () => {
  const uid = uidFor('slow_onfailed');
  const date = '2026-11-25';
  const dir = path.join(DATA_DIR, 'lectures', uid);
  const baseMs = Date.parse('2026-11-25T02:00:00.000Z');

  try {
    fs.mkdirSync(dir, { recursive: true });
    const initial: LectureState = {
      ...sampleReady(uid, date),
      audioBackup: {
        target: 'firestore',
        result: 'ok',
        httpStatus: 200,
        chunks: 2,
        bytes: 1000,
        at: '2026-11-25T00:00:00.000Z',
      },
    };
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(initial));

    let onFailedStarted = false;
    startLectureAudioRebuild(ai, uid, date, undefined, {
      now: baseMs,
      synthesizeFn: async () => {
        throw Object.assign(new Error('fail'), { status: 503 });
      },
      encodeFn: wavEncode,
      onFailed: () => {
        onFailedStarted = true;
        return new Promise(() => {}); // intentionally never resolves
      },
    });
    await lectureRebuildInFlight(uid, date);
    assert.equal(onFailedStarted, true);
    assert.equal(readLectureState(uid, date)?.audioBackup, undefined);

    // Even with onFailed never resolving, a manual rebuild immediately starts a fresh job
    const second = startLectureAudioRebuild(ai, uid, date, undefined, {
      ignoreCooldown: true,
      synthesizeFn: async () => silentPcm(),
      encodeFn: wavEncode,
    });
    assert.equal(second.audioStatus, 'rebuilding');
    await lectureRebuildInFlight(uid, date);
    assert.equal(readLectureState(uid, date)?.audioStatus, 'ready');
    assert.ok(lectureAudioPath(uid, date));

    // Cooldown check on frozen job prioritizes audioRetryAfter over audioRebuildFailedAt
    const uidCd = uidFor('cd_priority');
    const dirCd = path.join(DATA_DIR, 'lectures', uidCd);
    try {
      fs.mkdirSync(dirCd, { recursive: true });
      fs.writeFileSync(
        path.join(dirCd, `${date}.json`),
        JSON.stringify({
          ...sampleReady(uidCd, date),
          audioRetryAfter: new Date(baseMs + 3 * 60 * 60 * 1000).toISOString(),
        })
      );
      let synthCd = 0;
      startLectureAudioRebuild(ai, uidCd, date, undefined, {
        now: baseMs,
        synthesizeFn: (_ai, _e, _t, _two, signal) =>
          new Promise((_, rej) => {
            if (signal?.aborted) {
              rej(new Error('aborted'));
              return;
            }
            signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
          }),
      });
      // Simulate 45 min later: overlay sets AUDIO_REBUILD_TIMED_OUT and failedAt=base+30m (15m ago),
      // while manual check at base + 90m with audioRetryAfter still in future (3h) must honor audioRetryAfter.
      const stFile = path.join(dirCd, `${date}.json`);
      const savedSt = JSON.parse(fs.readFileSync(stFile, 'utf8'));
      savedSt.audioRetryAfter = new Date(baseMs + 3 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(stFile, JSON.stringify(savedSt));
      const blocked = startLectureAudioRebuild(ai, uidCd, date, undefined, {
        now: baseMs + 90 * 60 * 1000,
        synthesizeFn: async () => {
          synthCd += 1;
          return silentPcm();
        },
      });
      assert.equal(blocked.error, LECTURE_AUDIO_REBUILD_TIMED_OUT);
      assert.equal(synthCd, 0);

      // Force restart with invalid err.name -> errName omitted in log
      const origErr = console.error;
      const badNameLogs: string[] = [];
      console.error = (...a: any[]) => badNameLogs.push(a.map(String).join(' '));
      try {
        startLectureAudioRebuild(ai, uidCd, date, undefined, {
          ignoreCooldown: true,
          synthesizeFn: async () => {
            throw Object.assign(new Error('bad name err'), { name: 'https://bad-name' });
          },
          encodeFn: wavEncode,
        });
        await lectureRebuildInFlight(uidCd, date);
      } finally {
        console.error = origErr;
      }
      const badParsed = JSON.parse(badNameLogs[0].replace('[Lecture] audio rebuild failed: ', ''));
      assert.equal('errName' in badParsed, false);
    } finally {
      cleanup(uidCd);
    }
  } finally {
    cleanup(uid);
  }
});

test('17) cold-start backup in cooldown still restores valid audio chunks (0 TTS), transient chunk failure installs ready/missing without TTS', async () => {
  const uidOk = uidFor('cd_chunks_ok');
  const uidTr = uidFor('cd_chunks_transient');
  const date = '2026-11-25';
  const nowMs = Date.parse('2026-11-25T02:00:00.000Z');
  const failedAt = new Date(nowMs - 10 * 60 * 1000).toISOString();
  const base = (uid: string): LectureState => ({
    ...sampleReady(uid, date),
    audioBackupId: 'bak-cooldown-1',
    audioChunks: 1,
    audioRebuildFailedAt: failedAt,
    audioRetryAfter: new Date(nowMs + 20 * 60 * 1000).toISOString(),
    audioError: classifyLectureAudioError({ status: 429 }, { stage: 'tts', attempts: 1, at: failedAt }),
  });
  const rawAudio = Buffer.from('RIFFcooldown-chunk-audio');
  try {
    const stOk: FeedSyncState = {
      uid: uidOk,
      secret: 'k'.repeat(48),
      quizCount: 0,
      newMistakes: [],
      reviewMistakes: [],
      syncedAt: '2026-11-25T00:00:00.000Z',
    };
    let loadCalls = 0;
    let restoreCalls = 0;
    let synthCalls = 0;
    await ensureTodayLecture(ai, stOk, date, {
      now: nowMs,
      loadBackup: async () => base(uidOk),
      loadAudio: (async (_s: string, _d: string, expectId: string) => {
        loadCalls += 1;
        assert.equal(expectId, 'bak-cooldown-1');
        return { status: 'ok', ext: 'wav', mime: 'audio/wav', buffer: rawAudio, durationSec: 365 };
      }) as any,
      restoreLecture: (() => {
        restoreCalls += 1;
        return null;
      }) as any,
      synthesizeFn: async () => {
        synthCalls += 1;
        return silentPcm();
      },
    });
    assert.equal(loadCalls, 1);
    assert.equal(restoreCalls, 0);
    assert.equal(synthCalls, 0);
    assert.ok(lectureAudioPath(uidOk, date));
    assert.deepEqual(fs.readFileSync(lectureAudioPath(uidOk, date)!), rawAudio);

    const stTr: FeedSyncState = { ...stOk, uid: uidTr };
    let restoreTr = 0;
    await ensureTodayLecture(ai, stTr, date, {
      now: nowMs,
      loadBackup: async () => base(uidTr),
      loadAudio: (async () => ({ status: 'transient' })) as any,
      restoreLecture: (() => {
        restoreTr += 1;
        return null;
      }) as any,
      synthesizeFn: async () => silentPcm(),
    });
    assert.equal(restoreTr, 0);
    const localTr = readLectureState(uidTr, date, nowMs);
    assert.equal(localTr?.status, 'ready');
    assert.equal(localTr?.audioStatus, 'missing');
    assert.equal(localTr?.audioBackupId, 'bak-cooldown-1');
    assert.equal(lectureAudioPath(uidTr, date), null);
  } finally {
    cleanup(uidOk);
    cleanup(uidTr);
  }
});
