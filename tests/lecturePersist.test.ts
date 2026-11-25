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
  restoreReadyLecture,
  startLectureJob,
  type LectureMistakeInput,
  type LecturePcm,
  type LectureScriptItem,
  type LectureState,
  type LectureSynthesizeFn,
} from '../server/lecture.ts';
import {
  buildFeedToday,
  ensureTodayLecture,
  feedAudioFile,
  type FeedSyncState,
} from '../server/feed.ts';
import {
  decryptLectureBackup,
  loadLectureBackup,
  saveLectureBackup,
} from '../server/feedStore.ts';

const ai = {} as GoogleGenAI;

function uidFor(name: string): string {
  return `test_persist_${name}_${process.pid}`;
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
      explanation: '과거 시제를 써야 해요.',
      dialogue: [
        { speaker: 'Coach', line: 'What did you do yesterday?' },
        { speaker: 'Partner', line: 'I went yesterday.' },
      ],
      meaningKo: '나는 어제 갔어요',
      answerEnglish: 'I went yesterday',
    },
  ];
}

function sampleBackup(uid: string, date: string, title = '복원될 오늘 강의'): LectureState {
  const now = new Date().toISOString();
  return {
    uid,
    date,
    status: 'ready',
    title,
    script: sampleScript(),
    coachNote: '오늘도 화이팅!',
    itemCount: 1,
    newMistakeIds: ['m1'],
    reviewMistakeIds: [],
    ttsEngine: 'gemini',
    createdAt: now,
    updatedAt: now,
  };
}

function sampleFeedState(uid: string, secret = 's'.repeat(48)): FeedSyncState {
  return {
    uid,
    secret,
    quizCount: 2,
    newMistakes: [{ id: 'm1', myPhrase: 'I go yesterday', naturalPhrase: 'I went yesterday', reason: '과거시제' }],
    reviewMistakes: [],
    syncedAt: new Date().toISOString(),
  };
}

function silentPcm(): LecturePcm {
  return { data: Buffer.alloc(2400 * 2), rate: 24000 };
}

function mockSynth(calls: { n: number }, delayMs = 0): LectureSynthesizeFn {
  return async () => {
    calls.n += 1;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return silentPcm();
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

test('1) backup doc fields are only iv/data/updatedAt, wrong secret fails decrypt, copied yesterday doc loads as null', async () => {
  const realFetch = globalThis.fetch;
  const docs: Record<string, any> = {};
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    const id = String(url).split('/feeds/')[1];
    if (init.method === 'PATCH') {
      docs[id] = JSON.parse(init.body);
      return { ok: true, status: 200 };
    }
    if (!docs[id]) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => docs[id] };
  };
  try {
    const uid = uidFor('fields');
    const secret = 'k'.repeat(48);
    const yesterday = '2026-11-21';
    const today = '2026-11-22';
    const backup = sampleBackup(uid, yesterday, '어제 비밀 강의 제목');

    await saveLectureBackup(secret, backup);
    const docKey = Object.keys(docs)[0];
    const doc = docs[docKey];
    assert.deepEqual(Object.keys(doc.fields).sort(), ['data', 'iv', 'updatedAt']);

    const serialized = JSON.stringify(doc);
    assert.ok(!serialized.includes('어제 비밀 강의 제목'));
    assert.ok(!serialized.includes('I went yesterday'));
    assert.ok(!serialized.includes(secret));

    assert.throws(() =>
      decryptLectureBackup('w'.repeat(48), doc.fields.iv.stringValue, doc.fields.data.stringValue)
    );

    // Copy yesterday's encrypted doc onto today's path
    const todayKey = docKey.replace(`/days/${yesterday}`, `/days/${today}`);
    docs[todayKey] = doc;
    assert.equal(await loadLectureBackup(secret, today), null);
    assert.equal((await loadLectureBackup(secret, yesterday))?.title, '어제 비밀 강의 제목');
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test('2) empty .data/ + ready backup: ensure+build restores title with 0 startJob calls, reports generating while rebuilding, then ready with WAV', async () => {
  const uid = uidFor('restore_ok');
  const date = '2026-11-22';
  const st = sampleFeedState(uid);
  const backup = sampleBackup(uid, date, '어젯밤 실수 1분 정리');
  let startJobCalls = 0;
  const synthCalls = { n: 0 };

  try {
    await ensureTodayLecture(ai, st, date, {
      loadBackup: async () => backup,
      synthesizeFn: mockSynth(synthCalls, 30),
    });

    const whileRebuilding = buildFeedToday(ai, st, 'https://example.test', {
      date,
      now: Date.parse('2026-11-22T01:00:00.000Z'), // 10:00 KST (after 05:00 gate)
      startJob: () => {
        startJobCalls += 1;
        throw new Error('should not startJob');
      },
    });
    assert.equal(startJobCalls, 0);
    assert.equal(whileRebuilding.status, 'ready');
    assert.equal(whileRebuilding.audioRestoring, true);
    assert.equal(whileRebuilding.audioUrl, null);
    assert.equal(whileRebuilding.title, '어젯밤 실수 1분 정리');

    await lectureRebuildInFlight(uid, date);

    const ready = buildFeedToday(ai, st, 'https://example.test', {
      date,
      now: Date.parse('2026-11-22T01:00:00.000Z'),
      startJob: () => {
        startJobCalls += 1;
        throw new Error('should not startJob');
      },
    });
    assert.equal(startJobCalls, 0);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.title, '어젯밤 실수 1분 정리');
    assert.match(ready.audioUrl || '', new RegExp(`/audio/${date}\\.(wav|m4a|mp3)$`));
    assert.ok(synthCalls.n > 0);
    assert.ok(lectureAudioPath(uid, date));
    assert.ok(feedAudioFile(st, date));
  } finally {
    cleanup(uid);
  }
});

test('3) 404 backup starts generation; 500 backup error skips generation (0 startJob calls)', async () => {
  const realFetch = globalThis.fetch;
  const uid404 = uidFor('not_found');
  const uid500 = uidFor('err_500');
  const date = '2026-11-22';

  try {
    // 404 -> ensure resolves, buildFeedToday calls startJob
    (globalThis as any).fetch = async () => ({ ok: false, status: 404 });
    const st404 = sampleFeedState(uid404, 'a'.repeat(48));
    let started404 = 0;
    let skip404 = false;
    try {
      await ensureTodayLecture(ai, st404, date);
    } catch {
      skip404 = true;
    }
    assert.equal(skip404, false);
    const out404 = buildFeedToday(ai, st404, 'https://example.test', {
      date,
      now: Date.parse('2026-11-22T01:00:00.000Z'),
      skipStart: skip404,
      startJob: (_ai, u, d) => {
        started404 += 1;
        return {
          uid: u,
          date: d,
          status: 'generating',
          newMistakeIds: ['m1'],
          reviewMistakeIds: [],
          ttsEngine: 'gemini',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
    });
    assert.equal(started404, 1);
    assert.equal(out404.status, 'generating');

    // 500 -> ensure rejects, caller passes skipStart=true so startJob is called 0 times
    (globalThis as any).fetch = async () => ({ ok: false, status: 500 });
    const st500 = sampleFeedState(uid500, 'b'.repeat(48));
    let started500 = 0;
    let skip500 = false;
    await assert.rejects(
      ensureTodayLecture(ai, st500, date).catch((err) => {
        skip500 = true;
        throw err;
      }),
      /Firestore 500/
    );
    assert.equal(skip500, true);
    const out500 = buildFeedToday(ai, st500, 'https://example.test', {
      date,
      now: Date.parse('2026-11-22T01:00:00.000Z'), // 10:00 KST, after the 05:00 gate (wall-clock independent)
      skipStart: skip500,
      startJob: () => {
        started500 += 1;
        throw new Error('should not startJob on 500');
      },
    });
    assert.equal(started500, 0);
    assert.equal(out500.status, 'nothing');
  } finally {
    (globalThis as any).fetch = realFetch;
    cleanup(uid404);
    cleanup(uid500);
  }
});

test('4) local generating on disk (not running) + no backup -> INTERRUPTED then retries generation, never fabricates ready', async () => {
  const uid = uidFor('interrupted');
  const date = '2026-11-22';
  const dir = path.join(DATA_DIR, 'lectures', uid);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, `${date}.json`),
    JSON.stringify({
      uid,
      date,
      status: 'generating',
      newMistakeIds: ['m1'],
      reviewMistakeIds: [],
      ttsEngine: 'gemini',
      createdAt: now,
      updatedAt: now,
    })
  );

  try {
    const st = sampleFeedState(uid);
    await ensureTodayLecture(ai, st, date, { loadBackup: async () => null });
    assert.equal(readLectureState(uid, date)?.error, 'INTERRUPTED');

    let started = 0;
    const feed = buildFeedToday(ai, st, 'https://example.test', {
      date,
      now: Date.parse('2026-11-22T01:00:00.000Z'),
      startJob: (_ai, u, d) => {
        started += 1;
        return {
          uid: u,
          date: d,
          status: 'generating',
          newMistakeIds: ['m1'],
          reviewMistakeIds: [],
          ttsEngine: 'gemini',
          createdAt: now,
          updatedAt: now,
        };
      },
    });
    assert.equal(started, 1);
    assert.equal(feed.status, 'generating');
    assert.notEqual(feed.status, 'ready');
  } finally {
    cleanup(uid);
  }
});

test('5) running job in memory + ready backup -> skips restore and keeps generating', async () => {
  const uid = uidFor('running_skip');
  const date = '2026-11-22';
  const mistakes: LectureMistakeInput[] = [{ id: 'm1', myPhrase: 'a', naturalPhrase: 'b' }];
  let finishJob!: () => void;

  try {
    const started = startLectureJob(ai, uid, date, mistakes, [], {
      jobTimeoutMs: 5_000,
      runJobFn: async () => {
        await new Promise<void>((resolve) => {
          finishJob = resolve;
        });
      },
    });
    assert.equal(started.status, 'generating');

    let loadCalled = 0;
    const st = sampleFeedState(uid);
    await ensureTodayLecture(ai, st, date, {
      loadBackup: async () => {
        loadCalled += 1;
        return sampleBackup(uid, date);
      },
    });
    assert.equal(loadCalled, 0);
    assert.equal(readLectureState(uid, date)?.status, 'generating');
    assert.equal(lectureRebuildInFlight(uid, date), undefined);

    const direct = restoreReadyLecture(ai, uid, date, sampleBackup(uid, date));
    assert.equal(direct?.status, 'generating');
    assert.equal(lectureRebuildInFlight(uid, date), undefined);

    finishJob();
    await sleep(20);
  } finally {
    cleanup(uid);
  }
});

test('6) onReady runs once when current job finishes ready, and never on late finish after TIMED_OUT or failed job', async () => {
  const uidOk = uidFor('onready_ok');
  const uidTo = uidFor('onready_to');
  const date = '2026-11-22';
  const mistakes: LectureMistakeInput[] = [{ id: 'm1', myPhrase: 'a', naturalPhrase: 'b' }];

  try {
    let okCalls = 0;
    startLectureJob(ai, uidOk, date, mistakes, [], {
      runJobFn: async (_ai, state, _n, _r, ctx) => {
        state.status = 'ready';
        state.title = '완료';
        state.script = sampleScript();
        ctx.write(state);
      },
      onReady: () => {
        okCalls += 1;
      },
    });
    await sleep(30);
    assert.equal(okCalls, 1);

    // TIMED_OUT followed by late resolution must NOT invoke onReady
    let lateCalls = 0;
    let resolveLate!: () => void;
    startLectureJob(ai, uidTo, date, mistakes, [], {
      jobTimeoutMs: 30,
      runJobFn: async (_ai, state, _n, _r, ctx) => {
        await new Promise<void>((r) => {
          resolveLate = r;
        });
        state.status = 'ready';
        state.title = '늦은 완료';
        ctx.write(state);
      },
      onReady: () => {
        lateCalls += 1;
      },
    });
    await sleep(60);
    assert.equal(readLectureState(uidTo, date)?.error, 'TIMED_OUT');
    resolveLate();
    await sleep(30);
    assert.equal(lateCalls, 0);
  } finally {
    cleanup(uidOk);
    cleanup(uidTo);
  }
});

test('7) restore bumps jobEpoch so an old slow job finishing later cannot overwrite restored state', async () => {
  const uid = uidFor('epoch_restore');
  const date = '2026-11-22';
  const mistakes: LectureMistakeInput[] = [{ id: 'm1', myPhrase: 'a', naturalPhrase: 'b' }];
  let finishOld!: () => void;
  let oldWriteResult: boolean | undefined;

  try {
    startLectureJob(ai, uid, date, mistakes, [], {
      jobTimeoutMs: 30,
      runJobFn: async (_ai, state, _n, _r, ctx) => {
        await new Promise<void>((r) => {
          finishOld = r;
        });
        state.status = 'failed';
        state.title = 'stale-title';
        state.error = 'GENERATION_FAILED';
        oldWriteResult = ctx.write(state);
      },
    });
    await sleep(60);
    assert.equal(readLectureState(uid, date)?.error, 'TIMED_OUT');

    const restored = restoreReadyLecture(ai, uid, date, sampleBackup(uid, date, '복원된 제목'), {
      synthesizeFn: mockSynth({ n: 0 }),
    });
    assert.equal(restored?.status, 'ready');
    await lectureRebuildInFlight(uid, date);

    finishOld();
    await sleep(30);

    const finalState = readLectureState(uid, date);
    assert.equal(oldWriteResult, false);
    assert.equal(finalState?.status, 'ready');
    assert.equal(finalState?.title, '복원된 제목');
    assert.ok(lectureAudioPath(uid, date));
  } finally {
    cleanup(uid);
  }
});

test('8) concurrent ensureTodayLecture calls share one backup fetch (single-flight)', async () => {
  const uid = uidFor('single_flight');
  const date = '2026-11-22';
  const st = sampleFeedState(uid);
  let loadCount = 0;
  let releaseLoad!: () => void;

  try {
    const loadGate = new Promise<void>((r) => {
      releaseLoad = r;
    });
    const deps = {
      loadBackup: async () => {
        loadCount += 1;
        await loadGate;
        return sampleBackup(uid, date, '싱글플라이트 제목');
      },
      synthesizeFn: mockSynth({ n: 0 }),
    };

    const p1 = ensureTodayLecture(ai, st, date, deps);
    const p2 = ensureTodayLecture(ai, st, date, deps);
    await sleep(10);
    assert.equal(loadCount, 1);

    releaseLoad();
    await Promise.all([p1, p2]);
    assert.equal(loadCount, 1);

    await lectureRebuildInFlight(uid, date);
    assert.equal(readLectureState(uid, date)?.title, '싱글플라이트 제목');
  } finally {
    cleanup(uid);
  }
});

test('9) firestore.rules: days block uses hasOnly, forbids anonymous delete, and restricts parent feeds write to allowed user', () => {
  const rules = fs.readFileSync(path.resolve(DATA_DIR, '..', 'firestore.rules'), 'utf-8');
  const feedsStart = rules.indexOf('match /feeds/{feedId}');
  assert.ok(feedsStart >= 0);
  const usersStart = rules.indexOf('match /users/{userId}');
  const feedsSection = rules.slice(feedsStart, usersStart);

  // Parent feeds write restricted to single allowed user
  assert.match(feedsSection, /allow create:\s*if isSingleAllowedUser\(/);
  assert.match(feedsSection, /allow update:\s*if isSingleAllowedUser\(/);
  assert.match(feedsSection, /allow delete:\s*if isSingleAllowedUser\(/);

  // days subcollection rules
  const daysStart = feedsSection.indexOf('match /days/{date}');
  assert.ok(daysStart >= 0);
  const daysSection = feedsSection.slice(daysStart);
  assert.match(daysSection, /request\.resource\.data\.keys\(\)\.hasOnly\(\['iv',\s*'data',\s*'updatedAt'\]\)/);
  assert.match(daysSection, /allow delete:\s*if isSingleAllowedUser\(/);
  assert.ok(!/allow delete:\s*if true/.test(daysSection));
});
