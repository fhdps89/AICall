import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import {
  DATA_DIR,
  readLectureState,
  startLectureJob,
  type LectureScriptItem,
  type LectureState,
} from '../server/lecture.ts';
import { buildFeedToday, ensureTodayLecture, feedOnFailed, type FeedSyncState } from '../server/feed.ts';
import {
  acquireLectureGenLease,
  decryptLectureBackup,
  failedJobScriptBackup,
  loadLectureBackup,
  saveLectureBackup,
  saveLectureFailureBackup,
} from '../server/feedStore.ts';

const ai = {} as GoogleGenAI;

function uidFor(name: string): string {
  return `test_failscript_${name}_${process.pid}`;
}

function cleanup(uid: string) {
  fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
}

function script(): LectureScriptItem[] {
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

function failedWithScript(uid: string, date: string): LectureState {
  const now = '2026-11-26T21:57:00.000Z';
  return {
    uid,
    date,
    status: 'failed',
    error: 'TIMED_OUT',
    title: '생산 회의 보고',
    script: script(),
    coachNote: '첫 문장. 둘째 문장.',
    itemCount: 1,
    newMistakeIds: ['m1'],
    reviewMistakeIds: [],
    inputNewIds: ['m1'],
    inputReviewIds: [],
    ttsEngine: 'gemini',
    audioProgress: { completed: 3, total: 14 },
    audioRetryAfter: '2026-11-26T21:57:00.000Z',
    createdAt: '2026-11-26T21:42:00.000Z',
    updatedAt: now,
  };
}

/** Firestore REST stand-in for feeds/{id}/days/{date}: GET and PATCH only. */
function fakeFirestore() {
  const docs: Record<string, any> = {};
  let patches = 0;
  const fetchFn = async (url: string, init: any = {}) => {
    const id = String(url).split('/feeds/')[1].split('?')[0];
    if ((init.method || 'GET') === 'PATCH') {
      patches += 1;
      docs[id] = JSON.parse(init.body);
      return { ok: true, status: 200 };
    }
    if (!docs[id]) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => docs[id] };
  };
  return { docs, fetchFn, patches: () => patches };
}

const secret = 's'.repeat(48);

test('failedJobScriptBackup: only a failed state with a script becomes ready/missing, audio fields dropped', () => {
  const st = { ...failedWithScript('u', '2026-11-27'), audioFile: 'x.mp3', audioBackupId: 'b', audioChunks: 2 };
  const out = failedJobScriptBackup(st)!;
  assert.equal(out.status, 'ready');
  assert.equal(out.audioStatus, 'missing');
  assert.equal(out.audioFile, undefined);
  assert.equal(out.audioBackupId, undefined);
  assert.equal(out.audioChunks, undefined);
  assert.equal(out.audioProgress, undefined);
  assert.equal(out.script?.length, 1);
  assert.equal(failedJobScriptBackup({ ...st, script: [] }), null);
  assert.equal(failedJobScriptBackup({ ...st, status: 'ready' }), null);
  // TIMED_OUT / INTERRUPTED are retried right away on the same server, so no cooldown is carried over.
  assert.equal(out.audioRetryAfter, undefined);
  assert.equal(failedJobScriptBackup({ ...st, error: 'GENERATION_FAILED' })!.audioRetryAfter, st.audioRetryAfter);
});

test('saveLectureFailureBackup: failed job with a script is backed up and loads back as a ready lecture', async () => {
  const realFetch = globalThis.fetch;
  const fs_ = fakeFirestore();
  (globalThis as any).fetch = fs_.fetchFn;
  try {
    const date = '2026-11-27';
    await saveLectureFailureBackup(secret, failedWithScript('u1', date));
    const loaded = await loadLectureBackup(secret, date);
    assert.equal(loaded?.status, 'ready');
    assert.equal(loaded?.title, '생산 회의 보고');
    assert.equal(loaded?.script?.length, 1);
    assert.equal(loaded?.audioBackupId, undefined);
    assert.equal(loaded?.audioChunks, undefined);

    // No script: nothing written. Superseded: nothing written.
    const before = fs_.patches();
    await saveLectureFailureBackup(secret, { ...failedWithScript('u1', '2026-11-28'), script: undefined });
    await saveLectureFailureBackup(secret, failedWithScript('u1', '2026-11-29'), () => false);
    assert.equal(fs_.patches(), before);
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test('saveLectureFailureBackup: a failed regeneration never replaces an existing ready backup', async () => {
  const realFetch = globalThis.fetch;
  const fs_ = fakeFirestore();
  (globalThis as any).fetch = fs_.fetchFn;
  try {
    const date = '2026-11-27';
    const ready: LectureState = {
      ...failedWithScript('u2', date),
      status: 'ready',
      title: '이미 완성된 강의',
      audioBackupId: 'keep',
      audioChunks: 3,
    };
    delete ready.error;
    await saveLectureBackup(secret, ready);
    const before = fs_.patches();
    await saveLectureFailureBackup(secret, { ...failedWithScript('u2', date), title: '실패한 새 강의' });
    assert.equal(fs_.patches(), before);
    const loaded = await loadLectureBackup(secret, date);
    assert.equal(loaded?.title, '이미 완성된 강의');
    assert.equal(loaded?.audioBackupId, 'keep');
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test('redeploy after a TTS failure: the new container restores the script and rebuilds audio instead of starting a new job', async () => {
  const uid = uidFor('redeploy');
  const date = '2026-11-27';
  const realFetch = globalThis.fetch;
  const origErr = console.error;
  console.error = () => {};
  const fs_ = fakeFirestore();
  (globalThis as any).fetch = fs_.fetchFn;
  try {
    const st: FeedSyncState = {
      uid,
      secret,
      quizCount: 10,
      newMistakes: [{ id: 'm1', myPhrase: 'I go yesterday', naturalPhrase: 'I went yesterday' }],
      reviewMistakes: [],
      syncedAt: '2026-11-26T14:00:00.000Z',
    };
    startLectureJob(ai, uid, date, st.newMistakes, [], {
      generateScriptFn: async () => ({ title: '생산 회의 보고', items: script(), coachNote: '첫 문장. 둘째 문장.' }),
      synthesizeFn: async () => {
        throw Object.assign(new Error('tts down'), { status: 500, attempts: 3 });
      },
      onFailed: feedOnFailed(st),
    });
    for (let i = 0; i < 200 && readLectureState(uid, date)?.status !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(readLectureState(uid, date)?.status, 'failed');
    for (let i = 0; i < 100 && !(await loadLectureBackup(secret, date)); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(await loadLectureBackup(secret, date), 'failed job script was backed up');

    // Redeploy: the container disk is wiped.
    cleanup(uid);
    assert.equal(readLectureState(uid, date), null);

    const restored: LectureState[] = [];
    const restoreLecture = ((_ai: GoogleGenAI, _uid: string, _date: string, backup: LectureState) => {
      restored.push(backup);
      return backup;
    }) as any;
    // Past the failure cooldown, which starts from the real clock when the job fails (a fixed date broke after it passed).
    const farFuture = Date.now() + 24 * 3600 * 1000;
    await ensureTodayLecture(ai, st, date, { restoreLecture, genRemote: null, now: farFuture });
    assert.equal(restored.length, 1, 'audio rebuild requested from the backed-up script');
    assert.equal(restored[0].title, '생산 회의 보고');
    assert.equal(restored[0].script?.length, 1);

    // With the backup installed locally, the feed never starts a fresh generation.
    cleanup(uid);
    await ensureTodayLecture(ai, st, date, { restoreLecture, genRemote: null, now: Date.now() - 1 });
    let started = 0;
    const today = buildFeedToday(ai, st, 'https://example.test', {
      date,
      genRemote: null,
      startJob: ((..._a: any[]) => {
        started += 1;
        return null as any;
      }) as any,
    });
    assert.equal(started, 0);
    assert.equal(today.status, 'ready');
    assert.equal(today.title, '생산 회의 보고');
  } finally {
    (globalThis as any).fetch = realFetch;
    console.error = origErr;
    cleanup(uid);
  }
});

test('saveLectureFailureBackup: a backup read failure or a job superseded during the read writes nothing', async () => {
  const realFetch = globalThis.fetch;
  try {
    let patches = 0;
    (globalThis as any).fetch = async (_url: string, init: any = {}) => {
      if (init.method === 'PATCH') { patches += 1; return { ok: true, status: 200 }; }
      return { ok: false, status: 503 };
    };
    await saveLectureFailureBackup(secret, failedWithScript('u3', '2026-11-27'));
    (globalThis as any).fetch = async () => { throw new TypeError('fetch failed'); };
    await saveLectureFailureBackup(secret, failedWithScript('u3', '2026-11-27'));
    assert.equal(patches, 0);

    const fs_ = fakeFirestore();
    (globalThis as any).fetch = fs_.fetchFn;
    let current = true;
    const save = saveLectureFailureBackup(secret, failedWithScript('u3', '2026-11-27'), () => current);
    current = false; // superseded while the existing backup is being read
    await save;
    assert.equal(fs_.patches(), 0);
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test('saveLectureFailureBackup: a days doc holding only genControl (lease + count) keeps it', async () => {
  const realFetch = globalThis.fetch;
  const fs_ = fakeFirestore();
  (globalThis as any).fetch = fs_.fetchFn;
  try {
    const date = '2026-11-27';
    const lease = await acquireLectureGenLease(secret, date, {
      owner: 'o1', token: 't1', kind: 'job', ttlMs: 60_000, cap: 3, now: Date.now(),
    } as any);
    assert.equal(lease.ok, true);
    assert.equal(await loadLectureBackup(secret, date), null);
    await saveLectureFailureBackup(secret, failedWithScript('u4', date));
    const key = Object.keys(fs_.docs).find((k) => k.endsWith(`/days/${date}`))!;
    const raw: any = decryptLectureBackup(secret, fs_.docs[key].fields.iv.stringValue, fs_.docs[key].fields.data.stringValue);
    assert.equal(raw.status, 'ready');
    assert.equal(raw.genControl?.genCount, 1);
    assert.equal(raw.genControl?.lease?.token, 't1');
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test('same server after TIMED_OUT: the script-only backup does not replace the local failed state, so the feed retries right away', async () => {
  const uid = uidFor('same_server');
  const date = '2026-11-27';
  const realFetch = globalThis.fetch;
  const fs_ = fakeFirestore();
  (globalThis as any).fetch = fs_.fetchFn;
  try {
    const local = { ...failedWithScript(uid, date), audioRetryAfter: new Date(Date.now() + 30 * 60_000).toISOString() };
    const dir = path.join(DATA_DIR, 'lectures', uid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(local));
    await saveLectureFailureBackup(secret, local);
    assert.ok(await loadLectureBackup(secret, date));

    const st: FeedSyncState = {
      uid, secret, quizCount: 10,
      newMistakes: [{ id: 'm1', myPhrase: 'I go yesterday', naturalPhrase: 'I went yesterday' }],
      reviewMistakes: [], syncedAt: '2026-11-26T14:00:00.000Z',
    };
    let restored = 0;
    await ensureTodayLecture(ai, st, date, { restoreLecture: (() => { restored += 1; return null; }) as any, genRemote: null });
    assert.equal(restored, 0);
    assert.equal(readLectureState(uid, date)?.status, 'failed');
    assert.equal(readLectureState(uid, date)?.error, 'TIMED_OUT');

    let started = 0;
    buildFeedToday(ai, st, 'https://example.test', {
      date, genRemote: null,
      startJob: ((..._a: any[]) => { started += 1; return readLectureState(uid, date)!; }) as any,
    });
    assert.equal(started, 1, 'TIMED_OUT is retried immediately from the local script');
  } finally {
    (globalThis as any).fetch = realFetch;
    cleanup(uid);
  }
});

test('new server after a TIMED_OUT job: audio rebuild starts without waiting for a cooldown', async () => {
  const uid = uidFor('new_server_timeout');
  const date = '2026-11-27';
  const realFetch = globalThis.fetch;
  const fs_ = fakeFirestore();
  (globalThis as any).fetch = fs_.fetchFn;
  try {
    await saveLectureFailureBackup(secret, { ...failedWithScript(uid, date), audioRetryAfter: new Date(Date.now() + 30 * 60_000).toISOString() });
    const st: FeedSyncState = {
      uid, secret, quizCount: 10,
      newMistakes: [{ id: 'm1', myPhrase: 'I go yesterday', naturalPhrase: 'I went yesterday' }],
      reviewMistakes: [], syncedAt: '2026-11-26T14:00:00.000Z',
    };
    const restored: LectureState[] = [];
    await ensureTodayLecture(ai, st, date, {
      restoreLecture: ((_a: any, _u: string, _d: string, b: LectureState) => { restored.push(b); return b; }) as any,
      genRemote: null,
    });
    assert.equal(restored.length, 1);
    assert.equal(restored[0].script?.length, 1);
  } finally {
    (globalThis as any).fetch = realFetch;
    cleanup(uid);
  }
});
