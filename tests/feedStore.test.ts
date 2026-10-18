import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../server/lecture.ts';
import { loadFeedForSecret } from '../server/feed.ts';
import { saveFeedBackup, deleteFeedBackup, decryptFeed } from '../server/feedStore.ts';
import { getUserSuppliedKey } from '../server/userKey.ts';

const FEED_FILE = path.join(DATA_DIR, 'feed.json');

/** Stand-in for the Firestore REST API: PATCH/GET/DELETE on feeds/{id}. */
function fakeFirestore() {
  const docs: Record<string, any> = {};
  const fetchFn = async (url: string, init: any = {}) => {
    const id = String(url).split('/feeds/')[1];
    const method = init.method || 'GET';
    if (method === 'PATCH') { docs[id] = JSON.parse(init.body); return { ok: true, status: 200 }; }
    if (method === 'DELETE') { delete docs[id]; return { ok: true, status: 200 }; }
    if (!docs[id]) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => docs[id] };
  };
  return { docs, fetchFn };
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
