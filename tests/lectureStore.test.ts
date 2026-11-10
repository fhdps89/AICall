import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DATA_DIR, kstToday } from '../server/lecture.ts';
import type { LectureState } from '../server/lecture.ts';
import {
  toFirestoreValue,
  lectureDocFields,
  saveLectureToAccount,
  setUserRefreshToken,
  isPlausibleRefreshToken,
} from '../server/lectureStore.ts';
import { buildFeedToday } from '../server/feed.ts';
import { encryptFeed, decryptFeed } from '../server/feedStore.ts';

const REFRESH = 'AMf-test_refresh.token-0123456789abcdef';

function readyState(uid: string, date: string): LectureState {
  const now = new Date().toISOString();
  return {
    uid, date, status: 'ready', title: 'T', coachNote: 'C', itemCount: 1,
    script: [{ mistakeId: 'm1', kind: 'new', myPhrase: 'a', naturalPhrase: 'b', explanation: 'e', dialogue: [{ speaker: 'Coach', line: 'hi' }], meaningKo: 'k', answerEnglish: 'b', startSec: 1.5 }],
    newMistakeIds: ['m1'], reviewMistakeIds: [], ttsEngine: 'gemini', chars: 10, textTokens: 20, durationSec: 30,
    createdAt: now, updatedAt: now,
  };
}

/** Stand-in for Google's token, Firestore and Storage endpoints. */
function fakeGoogle(opts: { userId: string; existingDoc?: any }) {
  const calls: { method: string; url: string; body?: any; auth?: string }[] = [];
  const docs: Record<string, any> = {};
  if (opts.existingDoc) docs.lecture = opts.existingDoc;
  const fetchFn = async (url: string, init: any = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url: String(url), body: init.body, auth: init.headers?.Authorization });
    if (String(url).startsWith('https://securetoken.googleapis.com/')) {
      return { ok: true, status: 200, json: async () => ({ id_token: 'ID-TOKEN', user_id: opts.userId, expires_in: '3600' }) };
    }
    if (String(url).startsWith('https://firebasestorage.googleapis.com/')) {
      return { ok: true, status: 200, json: async () => ({ downloadTokens: 'dl-token' }) };
    }
    if (String(url).includes('/lectures/')) {
      if (method === 'PATCH') { docs.lecture = JSON.parse(init.body); return { ok: true, status: 200 }; }
      if (!docs.lecture) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => docs.lecture };
    }
    if (method === 'PATCH') return { ok: true, status: 200 };
    return { ok: false, status: 404 };
  };
  return { calls, docs, fetchFn };
}

test('toFirestoreValue encodes nested lecture data the way the Firestore REST API expects', () => {
  assert.deepEqual(toFirestoreValue({ a: 1, b: 1.5, c: 'x', d: [true, null], e: undefined }), {
    mapValue: { fields: {
      a: { integerValue: '1' },
      b: { doubleValue: 1.5 },
      c: { stringValue: 'x' },
      d: { arrayValue: { values: [{ booleanValue: true }, { nullValue: null }] } },
    } },
  });
});

test('refresh token check rejects empty, huge or odd values', () => {
  assert.equal(isPlausibleRefreshToken(REFRESH), true);
  assert.equal(isPlausibleRefreshToken(''), false);
  assert.equal(isPlausibleRefreshToken('x'.repeat(5000)), false);
  assert.equal(isPlausibleRefreshToken('abc def ghi jkl mno pqr stu'), false);
  assert.equal(isPlausibleRefreshToken(undefined), false);
});

test('lectureDocFields matches the app LectureDoc shape and asks the app to count usage once', () => {
  const f = lectureDocFields(readyState('u', '2026-11-11'), 'https://storage/x');
  assert.equal(f.status, 'ready');
  assert.equal(f.audioUrl, 'https://storage/x');
  assert.equal(f.usageRecorded, false);
  assert.equal(f.savedBy, 'server');
  assert.deepEqual(f.newMistakeIds, ['m1']);
  assert.equal('listenedAt' in f, false, 'never resets 들음');
});

test('a ready lecture is uploaded and written into the account as the user', async () => {
  const realFetch = globalThis.fetch;
  const g = fakeGoogle({ userId: 'u-save' });
  (globalThis as any).fetch = g.fetchFn;
  const wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lec-')), 'a.wav');
  fs.writeFileSync(wav, Buffer.from('RIFF'));
  try {
    setUserRefreshToken('u-save', REFRESH);
    const url = await saveLectureToAccount(readyState('u-save', '2026-11-11'), wav);
    assert.match(String(url), /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/.+\/o\/users%2Fu-save%2Flectures%2F2026-11-11\.wav\?alt=media&token=dl-token$/);
    const upload = g.calls.find((c) => c.url.includes('firebasestorage') && c.method === 'POST');
    assert.equal(upload?.auth, 'Firebase ID-TOKEN');
    const docWrite = g.calls.find((c) => c.method === 'PATCH' && c.url.includes('/users/u-save/lectures/2026-11-11'));
    assert.ok(docWrite, 'lecture doc written');
    assert.match(docWrite!.url, /updateMask\.fieldPaths=audioUrl/);
    assert.doesNotMatch(docWrite!.url, /listenedAt/);
    assert.equal(docWrite!.auth, 'Bearer ID-TOKEN');
    assert.ok(g.calls.some((c) => c.method === 'PATCH' && c.url.includes('/users/u-save/mistakes/m1')), 'new mistake marked');
    assert.ok(g.calls.every((c) => !c.url.includes(REFRESH)), 'refresh token never goes into a URL');
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test('nothing is written when the app already copied the lecture, or when the token belongs to someone else', async () => {
  const realFetch = globalThis.fetch;
  const wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lec-')), 'a.wav');
  fs.writeFileSync(wav, Buffer.from('RIFF'));
  try {
    const existingDoc = { fields: { status: { stringValue: 'ready' }, audioUrl: { stringValue: 'https://app-copy' } } };
    const g1 = fakeGoogle({ userId: 'u-copied', existingDoc });
    (globalThis as any).fetch = g1.fetchFn;
    setUserRefreshToken('u-copied', REFRESH);
    assert.equal(await saveLectureToAccount(readyState('u-copied', '2026-11-11'), wav), 'https://app-copy');
    assert.equal(g1.calls.filter((c) => c.method !== 'GET' && !c.url.includes('securetoken')).length, 0);

    const g2 = fakeGoogle({ userId: 'someone-else' });
    (globalThis as any).fetch = g2.fetchFn;
    setUserRefreshToken('u-other', REFRESH);
    await assert.rejects(saveLectureToAccount(readyState('u-other', '2026-11-11'), wav), /another user/);
    assert.equal(g2.calls.filter((c) => !c.url.includes('securetoken')).length, 0);
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test('a fresh server answers the feed from the account copy instead of making a second lecture', async () => {
  const realFetch = globalThis.fetch;
  const uid = `u-fresh-${process.pid}`;
  const date = kstToday();
  const existingDoc = { fields: {
    status: { stringValue: 'ready' }, audioUrl: { stringValue: 'https://storage/today.wav' },
    title: { stringValue: '제목' }, coachNote: { stringValue: '한마디' }, itemCount: { integerValue: '3' },
  } };
  const g = fakeGoogle({ userId: uid, existingDoc });
  (globalThis as any).fetch = g.fetchFn;
  try {
    setUserRefreshToken(uid, REFRESH);
    let started = false;
    const ai: any = new Proxy({}, { get() { started = true; throw new Error('must not generate'); } });
    const st = { uid, secret: 's'.repeat(48), quizCount: 1, newMistakes: [{ id: 'm', myPhrase: 'a', naturalPhrase: 'b' }], reviewMistakes: [], syncedAt: '' };
    const today = await buildFeedToday(ai, st, 'https://app');
    assert.equal(today.status, 'ready');
    assert.equal(today.title, '제목');
    assert.equal(today.itemCount, 3);
    assert.equal(today.audioUrl, `https://app/feed/${st.secret}/audio/${date}.wav`);
    assert.equal(started, false);
    assert.equal(fs.existsSync(path.join(DATA_DIR, 'lectures', uid, `${date}.json`)), false);
  } finally {
    (globalThis as any).fetch = realFetch;
    fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
  }
});

test('the feed backup keeps the refresh token encrypted', () => {
  const secret = 'b'.repeat(48);
  const state = { uid: 'u', secret, quizCount: 0, newMistakes: [], reviewMistakes: [], syncedAt: '' };
  const { iv, data } = encryptFeed(secret, { state, refreshToken: REFRESH });
  assert.equal(Buffer.from(data, 'base64').toString('latin1').includes(REFRESH), false);
  assert.equal(decryptFeed(secret, iv, data).refreshToken, REFRESH);
});
