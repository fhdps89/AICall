import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../server/lecture.ts';
import { loadFeedForSecret } from '../server/feed.ts';
import { saveFeedBackup, deleteFeedBackup, decryptFeed, saveLectureBackup, loadLectureBackup, decryptLectureBackup } from '../server/feedStore.ts';
import type { LectureState } from '../server/lecture.ts';
import { getUserSuppliedKey } from '../server/userKey.ts';

const FEED_FILE = path.join(DATA_DIR, 'feed.json');

/** Stand-in for the Firestore REST API: PATCH/GET/DELETE on feeds/{id} and feeds/{id}/days/{date}. */
function fakeFirestore() {
  const docs: Record<string, any> = {};
  const headersByKey: Record<string, any> = {};
  const fetchFn = async (url: string, init: any = {}) => {
    const id = String(url).split('/feeds/')[1];
    const method = init.method || 'GET';
    if (method === 'PATCH') {
      docs[id] = JSON.parse(init.body);
      headersByKey[id] = init.headers || {};
      return { ok: true, status: 200 };
    }
    if (method === 'DELETE') { delete docs[id]; return { ok: true, status: 200 }; }
    if (!docs[id]) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => docs[id] };
  };
  return { docs, headersByKey, fetchFn };
}

test('feed backup: a fresh server restores the feed state and the user key; a wrong or rotated secret gets nothing', async () => {
  const saved = fs.existsSync(FEED_FILE) ? fs.readFileSync(FEED_FILE) : null;
  const realFetch = globalThis.fetch;
  const { docs, fetchFn } = fakeFirestore();
  (globalThis as any).fetch = fetchFn;
  try {
    const secret = 'a'.repeat(48);
    const state = {
      uid: 'u1', secret, quizCount: 2,
      newMistakes: [{ id: 'm1', myPhrase: 'x', naturalPhrase: 'y', reason: 'z' }],
      reviewMistakes: [], syncedAt: new Date().toISOString(),
    };
    await saveFeedBackup('token', { state, apiKey: 'AIzaTestKey123' });

    // Only uid/iv/data/updatedAt are stored; mistakes and the key stay encrypted.
    const doc = Object.values(docs)[0];
    assert.deepEqual(Object.keys(doc.fields).sort(), ['data', 'iv', 'uid', 'updatedAt']);
    assert.ok(!JSON.stringify(doc).includes('AIzaTestKey123'));
    assert.ok(!JSON.stringify(doc).includes('naturalPhrase'));
    assert.throws(() => decryptFeed('b'.repeat(48), doc.fields.iv.stringValue, doc.fields.data.stringValue));

    // Fresh server: empty .data/, no key in memory.
    fs.rmSync(FEED_FILE, { force: true });
    const restored = await loadFeedForSecret(secret);
    assert.equal(restored?.newMistakes[0].id, 'm1');
    assert.equal(getUserSuppliedKey(), 'AIzaTestKey123');

    fs.rmSync(FEED_FILE, { force: true });
    assert.equal(await loadFeedForSecret('b'.repeat(48)), null);

    await deleteFeedBackup('token', secret);
    assert.equal(await loadFeedForSecret(secret), null);
  } finally {
    (globalThis as any).fetch = realFetch;
    if (saved) fs.writeFileSync(FEED_FILE, saved);
    else fs.rmSync(FEED_FILE, { force: true });
  }
});

test('lecture backup: only iv/data/updatedAt without auth header, fails wrong secret, rejects copied yesterday doc, ignores non-ready', async () => {
  const realFetch = globalThis.fetch;
  const { docs, headersByKey, fetchFn } = fakeFirestore();
  (globalThis as any).fetch = fetchFn;
  try {
    const secret = 'c'.repeat(48);
    const date = '2026-11-22';
    const now = new Date().toISOString();
    const readyState: LectureState = {
      uid: `u_feed_${process.pid}`,
      date,
      status: 'ready',
      title: '비밀 아침 강의 제목',
      script: [
        {
          mistakeId: 'm1',
          kind: 'new',
          myPhrase: 'I go yesterday',
          naturalPhrase: 'I went yesterday',
          explanation: '시제',
          dialogue: [{ speaker: 'Coach', line: 'Try again' }],
          meaningKo: '어제 갔다',
          answerEnglish: 'I went yesterday',
        },
      ],
      coachNote: '화이팅',
      itemCount: 1,
      newMistakeIds: ['m1'],
      reviewMistakeIds: [],
      ttsEngine: 'gemini',
      audioFile: `${date}.wav`,
      createdAt: now,
      updatedAt: now,
    };

    // Non-ready or empty script must not write
    await saveLectureBackup(secret, { ...readyState, status: 'generating' });
    await saveLectureBackup(secret, { ...readyState, script: [] });
    assert.equal(Object.keys(docs).length, 0);

    await saveLectureBackup(secret, readyState);
    const keys = Object.keys(docs);
    assert.equal(keys.length, 1);
    const docKey = keys[0];
    assert.ok(docKey.endsWith(`/days/${date}`));
    // No Authorization header
    assert.equal(headersByKey[docKey]?.Authorization, undefined);
    // Only iv, data, updatedAt
    const doc = docs[docKey];
    assert.deepEqual(Object.keys(doc.fields).sort(), ['data', 'iv', 'updatedAt']);
    // No plaintext title/script/key/uid
    const raw = JSON.stringify(doc);
    assert.ok(!raw.includes('비밀 아침 강의 제목'));
    assert.ok(!raw.includes('I went yesterday'));
    assert.ok(!raw.includes(secret));
    assert.ok(!raw.includes(readyState.uid));

    // Wrong secret fails decryption
    assert.throws(() =>
      decryptLectureBackup('d'.repeat(48), doc.fields.iv.stringValue, doc.fields.data.stringValue)
    );

    // Valid load returns ready state without audioFile
    const loaded = await loadLectureBackup(secret, date);
    assert.equal(loaded?.title, '비밀 아침 강의 제목');
    assert.equal(loaded?.script?.length, 1);
    assert.equal(loaded?.audioFile, undefined);

    // Copying yesterday's document into today's path must be rejected (null)
    const yesterday = '2026-11-21';
    await saveLectureBackup(secret, { ...readyState, date: yesterday });
    const yKey = Object.keys(docs).find((k) => k.endsWith(`/days/${yesterday}`))!;
    const tomorrow = '2026-11-23';
    const tKey = yKey.replace(`/days/${yesterday}`, `/days/${tomorrow}`);
    docs[tKey] = docs[yKey];
    assert.equal(await loadLectureBackup(secret, tomorrow), null);
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});
