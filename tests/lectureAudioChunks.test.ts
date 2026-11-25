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
  prepareLectureAudioChunks,
  splitAudioBlob,
} from '../server/lectureAudioBackup.ts';
import {
  encodeLectureAudio,
  resetFfmpegCache,
  wavFromPcm,
} from '../server/lectureAudioEncode.ts';

const ai = {} as GoogleGenAI;

function uidFor(name: string): string {
  return `test_chunks_${name}_${process.pid}`;
}

function cleanup(uid: string) {
  fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
}

function withMissingFfmpeg<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = '/no/such/ffmpeg';
  resetFfmpegCache();
  return fn().finally(() => {
    if (prev === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prev;
    resetFfmpegCache();
  });
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

test('2) 17.5MB valid wav transcodes to mp3 before backup and commits <= 8 chunks (not too_large)', async () => {
  const uid = uidFor('wav_transcode_ok');
  const date = '2026-11-25';
  const secret = 'b'.repeat(48);
  const dir = path.join(DATA_DIR, 'lectures', uid);
  const wavPath = path.join(dir, `${date}.wav`);
  const mp3Path = path.join(dir, `${date}.mp3`);
  const realFetch = globalThis.fetch;

  let commitCalls = 0;
  let commitBody: any = null;
  let patchCalls = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 365s of 24kHz 16-bit mono PCM -> 17,520,044 byte WAV
    fs.writeFileSync(wavPath, wavFromPcm(Buffer.alloc(24000 * 2 * 365), 24000));
    const st: LectureState = {
      ...sampleState(uid, date, 'bak-175mb-wav'),
      audioFile: `${date}.wav`,
      audioMime: 'audio/wav',
    };
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(st));

    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      if (String(url).endsWith(':commit') && init.method === 'POST') {
        commitCalls += 1;
        commitBody = JSON.parse(init.body);
        return { ok: true, status: 200 };
      }
      if (init.method === 'PATCH') {
        patchCalls += 1;
        return { ok: true, status: 200 };
      }
      return { ok: false, status: 404 };
    };

    const res = await withMissingFfmpeg(() => persistLectureBackups(secret, st, () => true));
    assert.equal(res.target, 'firestore');
    assert.equal(res.result, 'ok');
    assert.equal(res.httpStatus, 200);
    assert.ok(res.chunks !== null && res.chunks >= 1 && res.chunks <= AUDIO_CHUNK_MAX);
    assert.equal(commitCalls, 1);
    assert.equal(patchCalls, 0);
    assert.equal(fs.existsSync(wavPath), false, 'legacy wav must be removed after mp3 transcode');
    assert.equal(fs.existsSync(mp3Path), true, 'transcoded mp3 must be saved');

    const local = readLectureState(uid, date);
    assert.equal(local?.audioFile, `${date}.mp3`);
    assert.equal(local?.audioMime, 'audio/mpeg');
    assert.equal(st.audioFile, `${date}.wav`, 'caller state must not be mutated');
    assert.equal(st.audioMime, 'audio/wav');

    const chunkCount = res.chunks!;
    assert.equal(commitBody.writes.length, chunkCount + 1);
    const chunkB64 = commitBody.writes
      .slice(0, chunkCount)
      .map((w: any) => w.update.fields.data.stringValue);
    const dec = decryptLectureAudio(secret, date, joinAudioChunks(chunkB64));
    assert.ok(dec);
    assert.equal(dec.header.ext, 'mp3');
    assert.equal(dec.header.mime, 'audio/mpeg');
    assert.deepEqual(dec.audio, fs.readFileSync(mp3Path));
  } finally {
    (globalThis as any).fetch = realFetch;
    cleanup(uid);
  }
});

test('2c) invalid 17MB wav transcode failure keeps wav and falls back as too_large', async () => {
  const uid = uidFor('wav_transcode_fail');
  const date = '2026-11-25';
  const secret = 'k'.repeat(48);
  const dir = path.join(DATA_DIR, 'lectures', uid);
  const wavPath = path.join(dir, `${date}.wav`);
  const mp3Path = path.join(dir, `${date}.mp3`);
  const realFetch = globalThis.fetch;
  let commitCalls = 0;
  let patchCalls = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(wavPath, Buffer.alloc(17 * 1024 * 1024, 7));
    const st: LectureState = {
      ...sampleState(uid, date, 'bak-bad-wav'),
      audioFile: `${date}.wav`,
      audioMime: 'audio/wav',
    };
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(st));
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      if (String(url).endsWith(':commit') && init.method === 'POST') {
        commitCalls += 1;
        return { ok: true, status: 200 };
      }
      if (init.method === 'PATCH') {
        patchCalls += 1;
        return { ok: true, status: 200 };
      }
      return { ok: false, status: 404 };
    };
    const res = await persistLectureBackups(secret, st, () => true);
    assert.equal(res.result, 'too_large');
    assert.equal(commitCalls, 0);
    assert.ok(patchCalls >= 1);
    assert.equal(fs.existsSync(wavPath), true);
    assert.equal(fs.existsSync(mp3Path), false);
  } finally {
    (globalThis as any).fetch = realFetch;
    cleanup(uid);
  }
});

test('2d) isCurrent becoming false after wav transcode leaves wav in place and returns not_current', async () => {
  const uid = uidFor('wav_transcode_stale');
  const date = '2026-11-25';
  const secret = 'n'.repeat(48);
  const dir = path.join(DATA_DIR, 'lectures', uid);
  const wavPath = path.join(dir, `${date}.wav`);
  const mp3Path = path.join(dir, `${date}.mp3`);
  const realFetch = globalThis.fetch;
  let commitCalls = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(wavPath, wavFromPcm(Buffer.alloc(24000 * 2 * 2), 24000));
    const st: LectureState = {
      ...sampleState(uid, date, 'bak-stale-wav'),
      audioFile: `${date}.wav`,
      audioMime: 'audio/wav',
    };
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(st));
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      if (String(url).endsWith(':commit') && init.method === 'POST') {
        commitCalls += 1;
        return { ok: true, status: 200 };
      }
      return { ok: true, status: 200 };
    };
    let calls = 0;
    const res = await withMissingFfmpeg(() =>
      persistLectureBackups(secret, st, () => {
        calls += 1;
        return calls === 1;
      })
    );
    assert.equal(res.result, 'not_current');
    assert.equal(commitCalls, 0);
    assert.equal(fs.existsSync(wavPath), true);
    assert.equal(fs.existsSync(mp3Path), false);
    assert.equal(readLectureState(uid, date)?.audioFile, `${date}.wav`);
  } finally {
    (globalThis as any).fetch = realFetch;
    cleanup(uid);
  }
});

test('2b) 6-minute (360s) 24kHz silence encoded with pure-JS lamejs prepares <= 8 chunks and not too_large', async () => {
  const uid = uidFor('6min_mp3_chunks');
  const date = '2026-11-25';
  const secret = 'm'.repeat(48);
  const dir = path.join(DATA_DIR, 'lectures', uid);
  const mp3Path = path.join(dir, `${date}.mp3`);
  const prevFfmpeg = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = '/no/such/ffmpeg';
  resetFfmpegCache();

  try {
    fs.mkdirSync(dir, { recursive: true });
    const pcm = Buffer.alloc(24000 * 2 * 360);
    const encoded = await encodeLectureAudio(pcm, 24000);
    assert.equal(encoded.ext, 'mp3');
    assert.equal(encoded.mime, 'audio/mpeg');
    fs.writeFileSync(mp3Path, encoded.buffer);

    const st: LectureState = {
      ...sampleState(uid, date, 'bak-6min-mp3'),
      durationSec: 360,
      audioFile: `${date}.mp3`,
      audioMime: 'audio/mpeg',
    };
    const prep = prepareLectureAudioChunks(secret, st, mp3Path);
    assert.equal(prep.ok, true);
    if (prep.ok) {
      assert.ok(prep.chunks.length >= 1 && prep.chunks.length <= AUDIO_CHUNK_MAX);
    }
  } finally {
    if (prevFfmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prevFfmpeg;
    resetFfmpegCache();
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
    assert.equal(ok.status, 'ok');
    if (ok.status === 'ok') assert.deepEqual(ok.buffer, raw);

    // id mismatch
    assert.equal((await loadLectureAudioChunks(secret, date, 'id-wrong', 2)).status, 'missing');

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
    assert.equal((await loadLectureAudioChunks(secret, date, 'id-A', 2)).status, 'missing');

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
    assert.equal((await loadLectureAudioChunks(secret, date, 'id-A', 2)).status, 'missing');

    // 503 and TimeoutError return transient (not missing)
    (globalThis as any).fetch = async () => ({ ok: false, status: 503 });
    assert.equal((await loadLectureAudioChunks(secret, date, 'id-A', 2)).status, 'transient');

    (globalThis as any).fetch = async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    };
    assert.equal((await loadLectureAudioChunks(secret, date, 'id-A', 2)).status, 'transient');
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

test('7) chunk boundary: 8 chunks commits ok, 9 chunks falls back as too_large (on .mp3)', async () => {
  const uid = uidFor('boundary_8_9');
  const date = '2026-11-25';
  const secret = 'b'.repeat(48);
  const dir = path.join(DATA_DIR, 'lectures', uid);
  const audioPath = path.join(dir, `${date}.mp3`);
  const realFetch = globalThis.fetch;

  let commitCalls = 0;
  let commitWrites = 0;
  let patchBody: any = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 4,500,000 raw bytes -> ~4,500,180 encrypted bytes -> ceil(4.5M / 600,000) = 8 chunks
    fs.writeFileSync(audioPath, Buffer.alloc(4_500_000));
    const st8: LectureState = {
      ...sampleState(uid, date, 'bak-8chunks'),
      audioFile: `${date}.mp3`,
      audioMime: 'audio/mpeg',
    };
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(st8));

    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      if (String(url).endsWith(':commit') && init.method === 'POST') {
        commitCalls += 1;
        commitWrites = JSON.parse(init.body).writes.length;
        return { ok: true, status: 200 };
      }
      if (init.method === 'PATCH') {
        patchBody = JSON.parse(init.body);
        return { ok: true, status: 200 };
      }
      return { ok: false, status: 404 };
    };

    const res8 = await persistLectureBackups(secret, st8, () => true);
    assert.equal(res8.result, 'ok');
    assert.equal(res8.chunks, 8);
    assert.equal(commitCalls, 1);
    assert.equal(commitWrites, 9); // 8 chunks + 1 days doc
    assert.equal(patchBody, null);

    // 4,800,500 raw bytes -> > 4,800,000 encrypted bytes -> 9 chunks -> too_large
    fs.writeFileSync(audioPath, Buffer.alloc(4_800_500));
    const st9: LectureState = {
      ...sampleState(uid, date, 'bak-9chunks'),
      audioFile: `${date}.mp3`,
      audioMime: 'audio/mpeg',
    };
    const res9 = await persistLectureBackups(secret, st9, () => true);
    assert.equal(res9.result, 'too_large');
    assert.equal(res9.chunks, 9);
    assert.equal(commitCalls, 1); // unchanged: no commit for 9 chunks
    assert.ok(patchBody);
    const body9: any = patchBody;
    const dec = decryptLectureBackup(
      secret,
      body9.fields.iv.stringValue,
      body9.fields.data.stringValue
    );
    assert.equal(dec.audioBackupId, undefined);
    assert.equal(dec.audioBackup?.result, 'too_large');
  } finally {
    (globalThis as any).fetch = realFetch;
    cleanup(uid);
  }
});

test('8) commit TimeoutError maps to result timeout and falls back to pointer-free days PATCH', async () => {
  const uid = uidFor('commit_timeout');
  const date = '2026-11-25';
  const secret = 't'.repeat(48);
  const dir = path.join(DATA_DIR, 'lectures', uid);
  const audioPath = path.join(dir, `${date}.m4a`);
  const realFetch = globalThis.fetch;

  let patchBody: any = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(audioPath, Buffer.from('m4a-timeout-test'));
    const st = sampleState(uid, date, 'bak-timeout');
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(st));

    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      if (String(url).endsWith(':commit')) {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }
      if (init.method === 'PATCH') {
        assert.ok(init.signal instanceof AbortSignal);
        patchBody = JSON.parse(init.body);
        return { ok: true, status: 200 };
      }
      return { ok: false, status: 404 };
    };

    const res = await persistLectureBackups(secret, st, () => true);
    assert.equal(res.result, 'timeout');
    assert.equal(res.httpStatus, null);
    assert.equal(res.chunks, 1);
    assert.ok(patchBody);
    const body9: any = patchBody;
    const dec = decryptLectureBackup(
      secret,
      body9.fields.iv.stringValue,
      body9.fields.data.stringValue
    );
    assert.equal(dec.audioBackupId, undefined);
    assert.equal(dec.audioBackup?.result, 'timeout');
  } finally {
    (globalThis as any).fetch = realFetch;
    cleanup(uid);
  }
});
