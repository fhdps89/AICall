import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import {
  DATA_DIR,
  lectureAudioPath,
  readLectureState,
  startLectureJob,
  type LectureState,
} from '../server/lecture.ts';
import { ensureTodayLecture, type FeedSyncState } from '../server/feed.ts';
import { decryptLectureBackup, feedDocId, persistLectureBackups } from '../server/feedStore.ts';
import {
  LECTURE_AUDIO_BACKUP_MAX_BYTES,
  decryptLectureAudio,
  encryptLectureAudio,
  loadLectureAudioBackup,
  uploadLectureAudioBackup,
} from '../server/lectureAudioBackup.ts';

const ai = {} as GoogleGenAI;

function uidFor(name: string): string {
  return `test_audiobak_${name}_${process.pid}`;
}

function cleanup(uid: string) {
  fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
}

function sampleState(uid: string, date: string, audioBackupId = 'uuid-backup-1'): LectureState {
  return {
    uid,
    date,
    status: 'ready',
    title: '백업 테스트',
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
    audioFile: `${date}.wav`,
    audioMime: 'audio/wav',
    audioStatus: 'ready',
    audioBackupId,
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:05:00.000Z',
  };
}

test('1-2) encrypt/decrypt round-trip fails on wrong secret, wrong date, flipped byte, and audioBackupId mismatch', async () => {
  const secret = 'e'.repeat(48);
  const date = '2026-11-24';
  const audio = Buffer.from('RIFFfake-audio-bytes');
  const header = {
    v: 1 as const,
    date,
    audioBackupId: 'id-123',
    ext: 'wav' as const,
    mime: 'audio/wav',
    durationSec: 365,
    bytes: audio.length,
  };
  const blob = encryptLectureAudio(secret, header, audio);

  const ok = decryptLectureAudio(secret, date, blob);
  assert.ok(ok);
  assert.equal(ok.header.audioBackupId, 'id-123');
  assert.deepEqual(ok.audio, audio);

  assert.equal(decryptLectureAudio('f'.repeat(48), date, blob), null);
  assert.equal(decryptLectureAudio(secret, '2026-11-23', blob), null);

  const tampered = Buffer.from(blob);
  tampered[tampered.length - 20] ^= 0xff;
  assert.equal(decryptLectureAudio(secret, date, tampered), null);

  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => blob,
  });
  try {
    const mismatch = await loadLectureAudioBackup(secret, date, 'other-id', { bucket: 'test-bucket.firebasestorage.app' });
    assert.equal(mismatch, null);
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test('3, 6, 7) 403 upload returns false, omits audioBackupId in Firestore backup, isCurrent=false skips fetch, logs leak no secrets', async () => {
  const uid = uidFor('upload403');
  const date = '2026-11-24';
  const secret = 'super_secret_feed_token_' + 'x'.repeat(28);
  const docId = feedDocId(secret);
  const dir = path.join(DATA_DIR, 'lectures', uid);
  const audioPath = path.join(dir, `${date}.wav`);
  const realFetch = globalThis.fetch;
  const origWarn = console.warn;
  const origLog = console.log;
  const logs: string[] = [];
  console.warn = (...a: any[]) => logs.push(a.map(String).join(' '));
  console.log = (...a: any[]) => logs.push(a.map(String).join(' '));

  let patchBody: any = null;
  let storageCalls = 0;

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(audioPath, Buffer.from('RIFFdata'));
    const st = sampleState(uid, date, 'uuid-1');
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(st));

    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      if (String(url).includes('firebasestorage.googleapis.com')) {
        storageCalls += 1;
        return { ok: false, status: 403 };
      }
      if (init.method === 'PATCH') {
        patchBody = JSON.parse(init.body);
        return { ok: true, status: 200 };
      }
      return { ok: false, status: 404 };
    };

    // isCurrent() false -> 0 fetches
    await persistLectureBackups(secret, st, () => false);
    assert.equal(storageCalls, 0);
    assert.equal(patchBody, null);

    // 403 upload -> false, Firestore PATCH lacks audioBackupId
    await persistLectureBackups(secret, st, () => true);
    assert.equal(storageCalls, 1);
    assert.ok(patchBody);
    const body: any = patchBody;
    const decrypted = decryptLectureBackup(
      secret,
      body.fields.iv.stringValue,
      body.fields.data.stringValue
    );
    assert.equal(decrypted.audioBackupId, undefined);

    for (const msg of logs) {
      assert.equal(msg.includes(secret), false, 'secret leaked to log');
      assert.equal(msg.includes(docId), false, 'docId leaked to log');
    }
  } finally {
    (globalThis as any).fetch = realFetch;
    console.warn = origWarn;
    console.log = origLog;
    cleanup(uid);
  }
});

test('4-5) ensureTodayLecture installs Storage audio backup with 0 synth calls, and falls back to TTS on 404 or oversize', async () => {
  const uid = uidFor('restore_storage');
  const date = '2026-11-24';
  const secret = 'h'.repeat(48);
  const st: FeedSyncState = {
    uid,
    secret,
    quizCount: 0,
    newMistakes: [],
    reviewMistakes: [],
    syncedAt: '2026-11-24T00:00:00Z',
  };
  const backup = sampleState(uid, date, 'bak-match-1');
  const rawAudio = Buffer.from('RIFFvalid-wav-payload');
  const encBlob = encryptLectureAudio(
    secret,
    {
      v: 1,
      date,
      audioBackupId: 'bak-match-1',
      ext: 'wav',
      mime: 'audio/wav',
      durationSec: 365,
      bytes: rawAudio.length,
    },
    rawAudio
  );

  try {
    // 200 Storage backup -> installed directly, 0 synth calls
    let synthCalls = 0;
    await ensureTodayLecture(ai, st, date, {
      loadBackup: async () => backup,
      loadAudio: async (_s, _d, expectId) => {
        assert.equal(expectId, 'bak-match-1');
        return { ext: 'wav', mime: 'audio/wav', buffer: rawAudio, durationSec: 365 };
      },
      synthesizeFn: async () => {
        synthCalls += 1;
        return { data: Buffer.alloc(2400 * 2), rate: 24000 };
      },
    });
    assert.equal(synthCalls, 0);
    assert.ok(lectureAudioPath(uid, date));
    assert.deepEqual(fs.readFileSync(lectureAudioPath(uid, date)!), rawAudio);
    assert.equal(readLectureState(uid, date)?.audioStatus, 'ready');

    // Clean local files and test 404 / oversized fallback -> TTS synth called
    cleanup(uid);
    const realFetch = globalThis.fetch;
    try {
      // 404 from Storage
      (globalThis as any).fetch = async () => ({ ok: false, status: 404 });
      let restoredCalls = 0;
      await ensureTodayLecture(ai, st, date, {
        loadBackup: async () => backup,
        restoreLecture: (() => {
          restoredCalls += 1;
          return null;
        }) as any,
      });
      assert.equal(restoredCalls, 1);

      // Oversized stream from Storage -> loadLectureAudioBackup returns null -> TTS fallback
      const overStream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(LECTURE_AUDIO_BACKUP_MAX_BYTES + 1));
          c.close();
        },
      });
      (globalThis as any).fetch = async () => ({ ok: true, status: 200, body: overStream });
      const loadedOver = await loadLectureAudioBackup(secret, date, 'bak-match-1', {
        bucket: 'test-bucket.firebasestorage.app',
      });
      assert.equal(loadedOver, null);

      // Verify valid blob decrypts via loadLectureAudioBackup
      (globalThis as any).fetch = async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(encBlob));
            c.close();
          },
        }),
      });
      const loadedOk = await loadLectureAudioBackup(secret, date, 'bak-match-1', {
        bucket: 'test-bucket.firebasestorage.app',
      });
      assert.deepEqual(loadedOk?.buffer, rawAudio);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  } finally {
    cleanup(uid);
  }
});

test('6) ensureTodayLecture refuses to install downloaded audio if a job started and finished during loadAudio', async () => {
  const uid = uidFor('race_loadaudio');
  const date = '2026-11-24';
  const secret = 'r'.repeat(48);
  const st: FeedSyncState = {
    uid,
    secret,
    quizCount: 0,
    newMistakes: [],
    reviewMistakes: [],
    syncedAt: '2026-11-24T00:00:00Z',
  };
  const backup = sampleState(uid, date, 'bak-old');
  const rawAudio = Buffer.from('RIFFold-backup');

  try {
    await ensureTodayLecture(ai, st, date, {
      loadBackup: async () => backup,
      loadAudio: async () => {
        // Simulate a newer job starting and finishing while loadAudio is downloading
        startLectureJob(
          ai,
          uid,
          date,
          [{ id: 'm-new', myPhrase: 'I go', naturalPhrase: 'I went' }],
          [],
          {
            runJobFn: async (_ai, state, _n, _r, ctx) => {
              state.status = 'ready';
              state.title = '새 강의';
              state.audioStatus = 'ready';
              ctx.write(state);
            },
          }
        );
        await new Promise((r) => setTimeout(r, 20));
        return { ext: 'wav', mime: 'audio/wav', buffer: rawAudio, durationSec: 365 };
      },
    });
    const final = readLectureState(uid, date);
    assert.equal(final?.title, '새 강의');
    assert.equal(lectureAudioPath(uid, date), null);
  } finally {
    cleanup(uid);
  }
});
