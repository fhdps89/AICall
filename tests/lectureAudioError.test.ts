import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import {
  DATA_DIR,
  installRestoredLectureAudio,
  lectureRebuildInFlight,
  readLectureState,
  resetTtsPause,
  startLectureAudioRebuild,
  startLectureJob,
  synthesizeGemini,
  type LecturePcm,
  type LectureScriptItem,
  type LectureState,
} from '../server/lecture.ts';
import { buildFeedToday, ensureTodayLecture, feedOnFailed, type FeedSyncState } from '../server/feed.ts';
import { decryptLectureBackup, feedDocId, saveLectureFailureBackup } from '../server/feedStore.ts';
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

test('8) synthesizeGemini retry policy: 404 & QUOTA_DAILY stop at 1, 429 retryDelay 2s sleeps 2000ms, generic sleeps [1500, 3000]', async () => {
  const validInline = {
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

  try {
    // 404 -> 1 call, 0 sleeps
    resetTtsPause();
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
    resetTtsPause();
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

    // 429 retryDelay 2s -> sleep(2000) then succeed
    resetTtsPause();
    let calls429 = 0;
    const sleeps429: number[] = [];
    const pcm = await synthesizeGemini(
      {
        models: {
          generateContent: async () => {
            calls429 += 1;
            if (calls429 === 1) {
              throw Object.assign(new Error('{"status":"RESOURCE_EXHAUSTED","retryDelay":"2s"}'), {
                status: 429,
              });
            }
            return validInline;
          },
        },
      } as unknown as GoogleGenAI,
      'Coach: hi',
      false,
      undefined,
      { sleepFn: async (ms) => { sleeps429.push(ms); }, now: () => 1_000_000 }
    );
    assert.equal(calls429, 2);
    assert.deepEqual(sleeps429, [2000]);
    assert.equal(pcm.rate, 24000);

    // Generic error -> 3 calls, sleeps [1500, 3000]
    resetTtsPause();
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
  } finally {
    resetTtsPause();
  }
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
    assert.equal(dec.audioBackupId, undefined);
    assert.equal(dec.audioChunks, undefined);
    assert.equal(dec.audioError?.code, 'QUOTA');
    assert.ok(dec.audioRebuildFailedAt);
    assert.ok(dec.audioRetryAfter);

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
    assert.equal(local10?.audioError?.origin, 'backup');

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
