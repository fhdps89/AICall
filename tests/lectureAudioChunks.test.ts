import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import {
  DATA_DIR,
  lectureAudioPath,
  readLectureState,
  recordLectureBackupResult,
  type LectureState,
} from '../server/lecture.ts';
import { ensureTodayLecture, feedOnReady, type FeedSyncState } from '../server/feed.ts';
import { decryptLectureBackup, feedDocId, persistLectureBackups } from '../server/feedStore.ts';
import {
  AUDIO_CHUNK_MAX,
  decryptLectureAudio,
  encryptLectureAudio,
  joinAudioChunks,
  loadLectureAudioChunks,
  splitAudioBlob,
} from '../server/lectureAudioBackup.ts';

const ai = {} as GoogleGenAI;

function uidFor(name: string): string {
  return `test_chunks_${name}_${process.pid}`;
}

function cleanup(uid: string) {
  fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
}

function sampleState(uid: string, date: string, audioBackupId = 'chunk-bak-1'): LectureState {
  return {
    uid,
    date,
    status: 'ready',
    title: '청크 테스트',
    script: [
      {
        mistakeId: 'm1',
        kind: 'new',
        myPhrase: 'I go',
        naturalPhrase: 'I went',
        explanation: '과거 시제',
        dialogue: [],
        meaningKo: '갔다',
        answerEnglish: 'I went',
      },
    ],
    coachNote: '첫 문장. 둘째 문장.',
    itemCount: 1,
    newMistakeIds: ['m1'],
    reviewMistakeIds: [],
    ttsEngine: 'gemini',
    durationSec: 365,
    audioFile: `${date}.m4a`,
    audioMime: 'audio/mp4',
    audioStatus: 'ready',
    audioBackupId,
    createdAt: '2026-11-25T00:00:00.000Z',
    updatedAt: '2026-11-25T00:05:00.000Z',
  };
}

test('1) 2.7MB random audio splits into 5 chunks <= 800,000 chars and decrypts back identically', () => {
  const secret = 'a'.repeat(48);
  const date = '2026-11-25';
  const raw = crypto.randomBytes(2_700_000);
  const blob = encryptLectureAudio(
    secret,
    {
      v: 1,
      date,
      audioBackupId: 'bak-27mb',
      ext: 'm4a',
      mime: 'audio/mp4',
      durationSec: 365,
      bytes: raw.length,
    },
    raw
  );
  const chunks = splitAudioBlob(blob);
  assert.equal(chunks.length, 5);
  for (const c of chunks) {
    assert.ok(c.length <= 800_000);
  }
  const joined = joinAudioChunks(chunks);
  const dec = decryptLectureAudio(secret, date, joined);
  assert.ok(dec);
  assert.equal(dec.header.audioBackupId, 'bak-27mb');
  assert.deepEqual(dec.audio, raw);
});

test('2) 17MB audio finishes as too_large with 0 commit calls and pointer-free days PATCH', async () => {
  const uid = uidFor('too_large');
  const date = '2026-11-25';
  const secret = 'b'.repeat(48);
  const dir = path.join(DATA_DIR, 'lectures', uid);
  const audioPath = path.join(dir, `${date}.wav`);
  const realFetch = globalThis.fetch;

  let commitCalls = 0;
  let patchBody: any = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(audioPath, Buffer.alloc(17 * 1024 * 1024));
    const st: LectureState = {
      ...sampleState(uid, date, 'bak-17mb'),
      audioFile: `${date}.wav`,
      audioMime: 'audio/wav',
    };
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(st));

    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      if (String(url).endsWith(':commit')) {
        commitCalls += 1;
        return { ok: true, status: 200 };
      }
      if (init.method === 'PATCH') {
        patchBody = JSON.parse(init.body);
        return { ok: true, status: 200 };
      }
      return { ok: false, status: 404 };
    };

    const res = await persistLectureBackups(secret, st, () => true);
    assert.equal(res.target, 'firestore');
    assert.equal(res.result, 'too_large');
    assert.equal(res.httpStatus, null);
    assert.ok((res.chunks ?? 0) > AUDIO_CHUNK_MAX);
    assert.equal(commitCalls, 0);
    assert.ok(patchBody);

    const dec = decryptLectureBackup(
      secret,
      patchBody.fields.iv.stringValue,
      patchBody.fields.data.stringValue
    );
    assert.equal(dec.audioBackupId, undefined);
    assert.equal(dec.audioChunks, undefined);
    assert.equal(dec.audioBackup?.result, 'too_large');
  } finally {
    (globalThis as any).fetch = realFetch;
    cleanup(uid);
  }
});

test('3) commit 200 sends n chunk writes + days write in one body and returns ok', async () => {
  const uid = uidFor('commit_ok');
  const date = '2026-11-25';
  const secret = 'c'.repeat(48);
  const dir = path.join(DATA_DIR, 'lectures', uid);
  const audioPath = path.join(dir, `${date}.m4a`);
  const realFetch = globalThis.fetch;

  let commitBody: any = null;
  let patchCalls = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(audioPath, crypto.randomBytes(1_300_000)); // 3 chunks
    const st = sampleState(uid, date, 'bak-commit-ok');
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(st));

    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      if (String(url).endsWith(':commit') && init.method === 'POST') {
        assert.equal(init.headers?.Authorization, undefined);
        commitBody = JSON.parse(init.body);
        return { ok: true, status: 200 };
      }
      if (init.method === 'PATCH') {
        patchCalls += 1;
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
    await feedOnReady(feedSt)(st, () => true);

    assert.equal(patchCalls, 0);
    assert.ok(commitBody);
    assert.equal(commitBody.writes.length, 4); // 3 chunks + 1 days
    for (let i = 0; i < 3; i++) {
      const w = commitBody.writes[i].update;
      assert.ok(w.name.endsWith(`/days/${date}/audio/${i}`));
      assert.deepEqual(Object.keys(w.fields).sort(), ['data', 'updatedAt']);
      assert.ok(w.fields.data.stringValue.length <= 800_000);
    }
    const dayWrite = commitBody.writes[3].update;
    assert.ok(dayWrite.name.endsWith(`/days/${date}`));
    assert.deepEqual(Object.keys(dayWrite.fields).sort(), ['data', 'iv', 'updatedAt']);

    const dec = decryptLectureBackup(
      secret,
      dayWrite.fields.iv.stringValue,
      dayWrite.fields.data.stringValue
    );
    assert.equal(dec.audioChunks, 3);
    assert.equal(dec.audioBackupId, 'bak-commit-ok');
    assert.equal(dec.audioBackup?.result, 'ok');
    assert.equal(dec.audioBackup?.chunks, 3);

    const local = readLectureState(uid, date);
    assert.equal(local?.audioChunks, 3);
    assert.equal(local?.audioBackup?.result, 'ok');
  } finally {
    (globalThis as any).fetch = realFetch;
    cleanup(uid);
  }
});

test('4) commit 403 falls back to pointer-free PATCH with denied/403, no secret/docId/URL in logs, isCurrent=false skips fetch', async () => {
  const uid = uidFor('commit_403');
  const date = '2026-11-25';
  const secret = 'chunk_secret_marker_' + 'd'.repeat(28);
  const docId = feedDocId(secret);
  const dir = path.join(DATA_DIR, 'lectures', uid);
  const audioPath = path.join(dir, `${date}.m4a`);
  const realFetch = globalThis.fetch;
  const origWarn = console.warn;
  const origLog = console.log;
  const origErr = console.error;
  const logs: string[] = [];
  console.warn = (...a: any[]) => logs.push(a.map(String).join(' '));
  console.log = (...a: any[]) => logs.push(a.map(String).join(' '));
  console.error = (...a: any[]) => logs.push(a.map(String).join(' '));

  let fetchCalls = 0;
  let patchBody: any = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(audioPath, Buffer.from('m4a-data'));
    const st = sampleState(uid, date, 'bak-403');
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(st));

    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      fetchCalls += 1;
      if (String(url).endsWith(':commit')) {
        return { ok: false, status: 403 };
      }
      if (init.method === 'PATCH') {
        patchBody = JSON.parse(init.body);
        return { ok: true, status: 200 };
      }
      return { ok: false, status: 404 };
    };

    const notCurrent = await persistLectureBackups(secret, st, () => false);
    assert.equal(notCurrent.result, 'not_current');
    assert.equal(fetchCalls, 0);

    const res = await persistLectureBackups(secret, st, () => true);
    assert.equal(res.result, 'denied');
    assert.equal(res.httpStatus, 403);
    assert.equal(fetchCalls, 2); // 1 commit + 1 fallback PATCH
    assert.ok(patchBody);

    const dec = decryptLectureBackup(
      secret,
      patchBody.fields.iv.stringValue,
      patchBody.fields.data.stringValue
    );
    assert.equal(dec.audioBackupId, undefined);
    assert.equal(dec.audioChunks, undefined);
    assert.equal(dec.audioBackup?.result, 'denied');
    assert.equal(dec.audioBackup?.httpStatus, 403);

    const recorded = recordLectureBackupResult(
      uid,
      date,
      { createdAt: st.createdAt, audioBackupId: st.audioBackupId },
      res
    );
    assert.equal(recorded?.audioBackup?.result, 'denied');
    assert.equal(recorded?.audioBackupId, undefined);

    for (const msg of logs) {
      assert.equal(msg.includes(secret), false, 'secret leaked');
      assert.equal(msg.includes(docId), false, 'docId leaked');
      assert.equal(msg.includes('https://'), false, 'URL leaked');
    }
  } finally {
    (globalThis as any).fetch = realFetch;
    console.warn = origWarn;
    console.log = origLog;
    console.error = origErr;
    cleanup(uid);
  }
});

test('5) loadLectureAudioChunks returns null on 404 chunk, mixed chunk from another upload, or audioBackupId mismatch', async () => {
  const secret = 'e'.repeat(48);
  const date = '2026-11-25';
  const raw = crypto.randomBytes(700_000); // 2 chunks
  const blobA = encryptLectureAudio(
    secret,
    {
      v: 1,
      date,
      audioBackupId: 'id-A',
      ext: 'm4a',
      mime: 'audio/mp4',
      durationSec: 360,
      bytes: raw.length,
    },
    raw
  );
  const blobB = encryptLectureAudio(
    secret,
    {
      v: 1,
      date,
      audioBackupId: 'id-B',
      ext: 'm4a',
      mime: 'audio/mp4',
      durationSec: 360,
      bytes: raw.length,
    },
    raw
  );
  const chunksA = splitAudioBlob(blobA);
  const chunksB = splitAudioBlob(blobB);
  assert.equal(chunksA.length, 2);

  const realFetch = globalThis.fetch;
  try {
    // Success case
    (globalThis as any).fetch = async (url: string) => {
      const idx = Number(String(url).split('/audio/')[1]);
      return {
        ok: true,
        status: 200,
        json: async () => ({ fields: { data: { stringValue: chunksA[idx] } } }),
      };
    };
    const ok = await loadLectureAudioChunks(secret, date, 'id-A', 2);
    assert.deepEqual(ok?.buffer, raw);

    // id mismatch
    assert.equal(await loadLectureAudioChunks(secret, date, 'id-wrong', 2), null);

    // chunk 1 is 404
    (globalThis as any).fetch = async (url: string) => {
      const idx = Number(String(url).split('/audio/')[1]);
      if (idx === 1) return { ok: false, status: 404 };
      return {
        ok: true,
        status: 200,
        json: async () => ({ fields: { data: { stringValue: chunksA[idx] } } }),
      };
    };
    assert.equal(await loadLectureAudioChunks(secret, date, 'id-A', 2), null);

    // chunk 1 mixed from upload B
    (globalThis as any).fetch = async (url: string) => {
      const idx = Number(String(url).split('/audio/')[1]);
      const data = idx === 0 ? chunksA[0] : chunksB[1];
      return {
        ok: true,
        status: 200,
        json: async () => ({ fields: { data: { stringValue: data } } }),
      };
    };
    assert.equal(await loadLectureAudioChunks(secret, date, 'id-A', 2), null);
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test('6) ensureTodayLecture installs chunk backup with 0 synth calls, and calls restore 1 time on missing chunk', async () => {
  const uid = uidFor('ensure_chunks');
  const date = '2026-11-25';
  const secret = 'f'.repeat(48);
  const st: FeedSyncState = {
    uid,
    secret,
    quizCount: 0,
    newMistakes: [],
    reviewMistakes: [],
    syncedAt: '2026-11-25T00:00:00.000Z',
  };
  const raw = crypto.randomBytes(700_000);
  const blob = encryptLectureAudio(
    secret,
    {
      v: 1,
      date,
      audioBackupId: 'bak-ensure',
      ext: 'm4a',
      mime: 'audio/mp4',
      durationSec: 365,
      bytes: raw.length,
    },
    raw
  );
  const chunks = splitAudioBlob(blob);
  const backup: LectureState = {
    ...sampleState(uid, date, 'bak-ensure'),
    audioChunks: chunks.length,
  };

  const realFetch = globalThis.fetch;
  try {
    (globalThis as any).fetch = async (url: string) => {
      const idx = Number(String(url).split('/audio/')[1]);
      return {
        ok: true,
        status: 200,
        json: async () => ({ fields: { data: { stringValue: chunks[idx] } } }),
      };
    };
    let synthCalls = 0;
    let restoreCalls = 0;
    await ensureTodayLecture(ai, st, date, {
      loadBackup: async () => backup,
      restoreLecture: (() => {
        restoreCalls += 1;
        return null;
      }) as any,
      synthesizeFn: async () => {
        synthCalls += 1;
        return { data: Buffer.alloc(100), rate: 24000 };
      },
    });
    assert.equal(synthCalls, 0);
    assert.equal(restoreCalls, 0);
    assert.deepEqual(fs.readFileSync(lectureAudioPath(uid, date)!), raw);

    cleanup(uid);
    (globalThis as any).fetch = async (url: string) => {
      const idx = Number(String(url).split('/audio/')[1]);
      if (idx === 1) return { ok: false, status: 404 };
      return {
        ok: true,
        status: 200,
        json: async () => ({ fields: { data: { stringValue: chunks[idx] } } }),
      };
    };
    await ensureTodayLecture(ai, st, date, {
      loadBackup: async () => backup,
      restoreLecture: (() => {
        restoreCalls += 1;
        return null;
      }) as any,
    });
    assert.equal(restoreCalls, 1);
  } finally {
    (globalThis as any).fetch = realFetch;
    cleanup(uid);
  }
});
