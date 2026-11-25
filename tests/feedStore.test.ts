import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../server/lecture.ts';
import {
  FEED_BACKUP_RECHECK_MS,
  feedForSecret,
  loadFeedForSecret,
  resetFeedBackupCheckCache,
  writeFeedSync,
} from '../server/feed.ts';
import {
  feedDocId,
  saveFeedBackup,
  deleteFeedBackup,
  decryptFeed,
  saveLectureBackup,
  loadLectureBackup,
  decryptLectureBackup,
  acquireLectureGenLease,
  releaseLectureGenLease,
  createFeedGenRemote,
} from '../server/feedStore.ts';
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

async function withFeedTestEnv(fn: () => Promise<void>): Promise<void> {
  const saved = fs.existsSync(FEED_FILE) ? fs.readFileSync(FEED_FILE) : null;
  const realFetch = globalThis.fetch;
  resetFeedBackupCheckCache();
  try {
    await fn();
  } finally {
    resetFeedBackupCheckCache();
    (globalThis as any).fetch = realFetch;
    if (saved) fs.writeFileSync(FEED_FILE, saved);
    else fs.rmSync(FEED_FILE, { force: true });
  }
}

test('loadFeedForSecret: stale local feed.json older than backup returns backup state and rewrites local file', async () => {
  await withFeedTestEnv(async () => {
    const { fetchFn } = fakeFirestore();
    (globalThis as any).fetch = fetchFn;
    const secret = 'e'.repeat(48);
    const localState = {
      uid: 'u1', secret, quizCount: 2,
      newMistakes: [{ id: 'old1', myPhrase: 'a', naturalPhrase: 'b', reason: 'c' }],
      reviewMistakes: [], syncedAt: '2026-11-24T03:03:19.000Z',
    };
    const backupState = {
      uid: 'u1', secret, quizCount: 2,
      newMistakes: [{ id: 'new1', myPhrase: 'a2', naturalPhrase: 'b2', reason: 'c2' }],
      reviewMistakes: [], syncedAt: '2026-11-24T08:11:17.000Z',
    };
    writeFeedSync(localState);
    await saveFeedBackup('token', { state: backupState });

    const loaded = await loadFeedForSecret(secret, { now: 1_000_000 });
    assert.equal(loaded?.syncedAt, '2026-11-24T08:11:17.000Z');
    assert.equal(loaded?.newMistakes[0].id, 'new1');
    assert.equal(feedForSecret(secret)?.newMistakes[0].id, 'new1');
  });
});

test('loadFeedForSecret: local feed.json newer than backup keeps local', async () => {
  await withFeedTestEnv(async () => {
    const { fetchFn } = fakeFirestore();
    (globalThis as any).fetch = fetchFn;
    const secret = 'f'.repeat(48);
    const localState = {
      uid: 'u1', secret, quizCount: 2,
      newMistakes: [{ id: 'localNew', myPhrase: 'a', naturalPhrase: 'b', reason: 'c' }],
      reviewMistakes: [], syncedAt: '2026-11-24T09:00:00.000Z',
    };
    const backupState = {
      uid: 'u1', secret, quizCount: 2,
      newMistakes: [{ id: 'backupOld', myPhrase: 'a2', naturalPhrase: 'b2', reason: 'c2' }],
      reviewMistakes: [], syncedAt: '2026-11-24T08:11:17.000Z',
    };
    writeFeedSync(localState);
    await saveFeedBackup('token', { state: backupState });

    const loaded = await loadFeedForSecret(secret, { now: 1_000_000 });
    assert.equal(loaded?.syncedAt, '2026-11-24T09:00:00.000Z');
    assert.equal(loaded?.newMistakes[0].id, 'localNew');
    assert.equal(feedForSecret(secret)?.newMistakes[0].id, 'localNew');
  });
});

test('loadFeedForSecret: second call within 5 min does not fetch backup again', async () => {
  await withFeedTestEnv(async () => {
    const { fetchFn } = fakeFirestore();
    let getCount = 0;
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      if (!init.method || init.method === 'GET') getCount++;
      return fetchFn(url, init);
    };
    const secret = 'g'.repeat(48);
    const localState = {
      uid: 'u1', secret, quizCount: 2,
      newMistakes: [{ id: 'local1', myPhrase: 'a', naturalPhrase: 'b', reason: 'c' }],
      reviewMistakes: [], syncedAt: '2026-11-24T03:03:19.000Z',
    };
    writeFeedSync(localState);
    await saveFeedBackup('token', { state: localState });

    const t0 = 1_000_000;
    await loadFeedForSecret(secret, { now: t0 });
    assert.equal(getCount, 1);

    // Update backup after first check; a call within 5 min skips fetching and keeps local.
    const newerBackup = {
      ...localState,
      newMistakes: [{ id: 'backup2', myPhrase: 'a2', naturalPhrase: 'b2', reason: 'c2' }],
      syncedAt: '2026-11-24T08:11:17.000Z',
    };
    await saveFeedBackup('token', { state: newerBackup });

    const withinWindow = await loadFeedForSecret(secret, { now: t0 + FEED_BACKUP_RECHECK_MS - 1 });
    assert.equal(getCount, 1);
    assert.equal(withinWindow?.newMistakes[0].id, 'local1');

    // Once 5 min have elapsed, re-check fetches and adopts the newer backup.
    const afterWindow = await loadFeedForSecret(secret, { now: t0 + FEED_BACKUP_RECHECK_MS });
    assert.equal(getCount, 2);
    assert.equal(afterWindow?.newMistakes[0].id, 'backup2');
  });
});

test('loadFeedForSecret: backup read failure returns local', async () => {
  await withFeedTestEnv(async () => {
    (globalThis as any).fetch = async () => ({ ok: false, status: 500 });
    const secret = 'h'.repeat(48);
    const localState = {
      uid: 'u1', secret, quizCount: 2,
      newMistakes: [{ id: 'local1', myPhrase: 'a', naturalPhrase: 'b', reason: 'c' }],
      reviewMistakes: [], syncedAt: '2026-11-24T03:03:19.000Z',
    };
    writeFeedSync(localState);

    const loaded = await loadFeedForSecret(secret, { now: 1_000_000 });
    assert.equal(loaded?.syncedAt, '2026-11-24T03:03:19.000Z');
    assert.equal(loaded?.newMistakes[0].id, 'local1');
  });
});

test('loadFeedForSecret: restores apiKey via injected setUserKey only when uid matches local', async () => {
  await withFeedTestEnv(async () => {
    const secret = 'i'.repeat(48);
    const localState = {
      uid: 'u1', secret, quizCount: 2,
      newMistakes: [{ id: 'local1', myPhrase: 'a', naturalPhrase: 'b', reason: 'c' }],
      reviewMistakes: [], syncedAt: '2026-11-24T03:03:19.000Z',
    };
    writeFeedSync(localState);

    const keyCalls: Array<[string, string]> = [];
    const setUserKey = (uid: string, key: string) => { keyCalls.push([uid, key]); };

    await loadFeedForSecret(secret, {
      now: 1_000_000,
      setUserKey,
      loadBackup: async () => ({ state: { ...localState, uid: 'u2' }, apiKey: 'AIzaMismatchKey' }),
    });
    assert.deepEqual(keyCalls, []);

    resetFeedBackupCheckCache();
    await loadFeedForSecret(secret, {
      now: 1_000_000,
      setUserKey,
      loadBackup: async () => ({ state: { ...localState }, apiKey: 'AIzaRestoredKey' }),
    });
    assert.deepEqual(keyCalls, [['u1', 'AIzaRestoredKey']]);
  });
});

test('loadFeedForSecret: concurrent newer local sync during backup fetch is preserved and not overwritten', async () => {
  await withFeedTestEnv(async () => {
    const secret = 'j'.repeat(48);
    const staleLocal = {
      uid: 'u1', secret, quizCount: 2,
      newMistakes: [{ id: 'stale1', myPhrase: 'a', naturalPhrase: 'b', reason: 'c' }],
      reviewMistakes: [], syncedAt: '2026-11-24T03:03:19.000Z',
    };
    const backupState = {
      uid: 'u1', secret, quizCount: 2,
      newMistakes: [{ id: 'backup1', myPhrase: 'a2', naturalPhrase: 'b2', reason: 'c2' }],
      reviewMistakes: [], syncedAt: '2026-11-24T08:11:17.000Z',
    };
    const concurrentNewerLocal = {
      uid: 'u1', secret, quizCount: 2,
      newMistakes: [{ id: 'concurrent1', myPhrase: 'a3', naturalPhrase: 'b3', reason: 'c3' }],
      reviewMistakes: [], syncedAt: '2026-11-24T09:00:00.000Z',
    };
    writeFeedSync(staleLocal);

    const loaded = await loadFeedForSecret(secret, {
      now: 1_000_000,
      loadBackup: async () => {
        writeFeedSync(concurrentNewerLocal);
        return { state: backupState };
      },
    });
    assert.equal(loaded?.syncedAt, '2026-11-24T09:00:00.000Z');
    assert.equal(loaded?.newMistakes[0].id, 'concurrent1');
    assert.equal(feedForSecret(secret)?.syncedAt, '2026-11-24T09:00:00.000Z');
    assert.equal(feedForSecret(secret)?.newMistakes[0].id, 'concurrent1');
  });
});

/** CAS-aware Firestore REST fake for feeds/{id}/days/{date}. */
function fakeCasFirestore() {
  let seq = 0;
  const docs: Record<string, { fields: any; updateTime: string }> = {};
  const fetchFn = async (url: string, init: any = {}) => {
    const rawUrl = String(url);
    const [pathPart, queryPart = ''] = rawUrl.split('?');
    const id = pathPart.split('/feeds/')[1];
    const method = init.method || 'GET';
    if (method === 'GET') {
      if (!docs[id]) return { ok: false, status: 404 };
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...docs[id] }),
      };
    }
    if (method === 'PATCH') {
      const params = new URLSearchParams(queryPart);
      if (params.has('currentDocument.exists')) {
        const wantExists = params.get('currentDocument.exists') === 'true';
        const actuallyExists = Boolean(docs[id]);
        if (wantExists !== actuallyExists) {
          return {
            ok: false,
            status: 400,
            text: async () => JSON.stringify({ error: { status: 'FAILED_PRECONDITION' } }),
          };
        }
      } else if (params.has('currentDocument.updateTime')) {
        const wantTime = params.get('currentDocument.updateTime');
        if (!docs[id] || docs[id].updateTime !== wantTime) {
          return {
            ok: false,
            status: 400,
            text: async () => JSON.stringify({ error: { status: 'FAILED_PRECONDITION' } }),
          };
        }
      }
      seq += 1;
      const body = JSON.parse(init.body);
      docs[id] = {
        fields: body.fields,
        updateTime: `2026-11-25T00:00:${String(seq).padStart(2, '0')}.000Z`,
      };
      return { ok: true, status: 200 };
    }
    return { ok: false, status: 404 };
  };
  return { docs, fetchFn };
}

function sampleReadyLectureForCas(uid: string, date: string): LectureState {
  const now = '2026-11-25T00:00:00.000Z';
  return {
    uid,
    date,
    status: 'ready',
    title: '기존 준비된 강의',
    script: [
      {
        mistakeId: 'm1',
        kind: 'new',
        myPhrase: 'I go',
        naturalPhrase: 'I went',
        explanation: '과거 시제',
        dialogue: [{ speaker: 'Coach', line: 'I went.' }],
        meaningKo: '갔다',
        answerEnglish: 'I went',
      },
    ],
    coachNote: '첫 문장. 둘째 문장.',
    itemCount: 1,
    newMistakeIds: ['m1'],
    reviewMistakeIds: [],
    ttsEngine: 'gemini',
    createdAt: now,
    updatedAt: now,
  };
}

test('gen lease: concurrent acquire of two owners lets one succeed and preserves existing ready backup', async () => {
  const realFetch = globalThis.fetch;
  const { docs, fetchFn } = fakeCasFirestore();
  (globalThis as any).fetch = fetchFn;
  try {
    const secret = 'k'.repeat(48);
    const date = '2026-11-25';
    const ready = sampleReadyLectureForCas(`u_cas_${process.pid}`, date);
    await saveLectureBackup(secret, ready);

    const now = Date.parse('2026-11-25T01:00:00.000Z');
    const [a, b] = await Promise.all([
      acquireLectureGenLease(secret, date, {
        owner: 'owner-A',
        token: 'tok-A',
        kind: 'rebuild',
        ttlMs: 60_000,
        cap: 2,
        now,
        ignoreCooldown: false,
      }),
      acquireLectureGenLease(secret, date, {
        owner: 'owner-B',
        token: 'tok-B',
        kind: 'rebuild',
        ttlMs: 60_000,
        cap: 2,
        now,
        ignoreCooldown: false,
      }),
    ]);

    const oks = [a, b].filter((r) => r.ok === true);
    const skips = [a, b].filter((r) => r.ok === false);
    assert.equal(oks.length, 1);
    assert.equal(skips.length, 1);
    if (skips[0].ok === false) {
      assert.equal(skips[0].skip.reason, 'lease');
    }

    const doc = Object.values(docs)[0];
    assert.deepEqual(Object.keys(doc.fields).sort(), ['data', 'iv', 'updatedAt']);
    const dec = decryptLectureBackup(secret, doc.fields.iv.stringValue, doc.fields.data.stringValue) as any;
    assert.equal(dec.title, '기존 준비된 강의');
    assert.equal(dec.script.length, 1);
    assert.equal(dec.genControl.genCount, 1);
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test('ready backup write preserves cached genControl and loadLectureBackup never exposes genControl', async () => {
  const realFetch = globalThis.fetch;
  const { docs, fetchFn } = fakeCasFirestore();
  (globalThis as any).fetch = fetchFn;
  try {
    const secret = 'l'.repeat(48);
    const date = '2026-11-25';
    const now = Date.parse('2026-11-25T01:00:00.000Z');
    const acq = await acquireLectureGenLease(secret, date, {
      owner: 'owner-cache',
      token: 'tok-cache',
      kind: 'job',
      ttlMs: 60_000,
      cap: 2,
      now,
      ignoreCooldown: false,
    });
    assert.equal(acq.ok, true);

    const ready = sampleReadyLectureForCas(`u_cache_${process.pid}`, date);
    await saveLectureBackup(secret, ready);

    const doc = Object.values(docs)[0];
    const dec = decryptLectureBackup(secret, doc.fields.iv.stringValue, doc.fields.data.stringValue) as any;
    assert.equal(dec.title, '기존 준비된 강의');
    assert.equal(dec.genControl.genCount, 1);
    assert.equal(dec.genControl.lease.token, 'tok-cache');

    const loaded = await loadLectureBackup(secret, date);
    assert.ok(loaded);
    assert.equal('genControl' in loaded, false);
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test('gen lease release keeps lease on token mismatch, takes over expired foreign lease, and treats undecryptable doc as unavailable', async () => {
  const realFetch = globalThis.fetch;
  const { docs, fetchFn } = fakeCasFirestore();
  (globalThis as any).fetch = fetchFn;
  try {
    const secret = 'm'.repeat(48);
    const date = '2026-11-25';
    const t0 = Date.parse('2026-11-25T01:00:00.000Z');
    await acquireLectureGenLease(secret, date, {
      owner: 'owner-1',
      token: 'tok-1',
      kind: 'job',
      ttlMs: 60_000,
      cap: 2,
      now: t0,
      ignoreCooldown: false,
    });

    // Release with wrong token -> lease remains, refund and cooldown apply
    const cdIso = new Date(t0 + 1800_000).toISOString();
    await releaseLectureGenLease(secret, date, {
      token: 'tok-wrong',
      refund: true,
      success: false,
      cooldownUntil: cdIso,
      cooldownCode: 'QUOTA',
    });
    const doc = Object.values(docs)[0];
    const dec = decryptLectureBackup(secret, doc.fields.iv.stringValue, doc.fields.data.stringValue) as any;
    assert.equal(dec.genControl.genCount, 0);
    assert.equal(dec.genControl.lease.token, 'tok-1');
    assert.equal(dec.genControl.cooldownUntil, cdIso);

    // Expired foreign lease (now = t0 + 120s > t0 + 60s) can be taken over (with ignoreCooldown)
    const takeover = await acquireLectureGenLease(secret, date, {
      owner: 'owner-2',
      token: 'tok-2',
      kind: 'job',
      ttlMs: 60_000,
      cap: 2,
      now: t0 + 120_000,
      ignoreCooldown: true,
    });
    assert.equal(takeover.ok, true);
    if (takeover.ok) {
      assert.equal(takeover.gc.lease?.owner, 'owner-2');
      assert.equal(takeover.gc.lease?.token, 'tok-2');
    }

    // Undecryptable doc -> unavailable and NOT overwritten
    const badSecret = 'n'.repeat(48);
    const badKey = `${feedDocId(badSecret)}/days/${date}`;
    docs[badKey] = {
      updateTime: '2026-11-25T00:00:99.000Z',
      fields: {
        iv: { stringValue: Buffer.from('123456789012').toString('base64') },
        data: { stringValue: Buffer.from('corrupt-ciphertext-payload').toString('base64') },
        updatedAt: { stringValue: '2026-11-25T00:00:00.000Z' },
      },
    };
    const beforeSnapshot = JSON.stringify(docs[badKey]);
    const resBad = await acquireLectureGenLease(badSecret, date, {
      owner: 'owner-x',
      token: 'tok-x',
      kind: 'job',
      ttlMs: 60_000,
      cap: 2,
      now: t0,
      ignoreCooldown: false,
    });
    assert.deepEqual(resBad, { ok: 'unavailable' });
    assert.equal(JSON.stringify(docs[badKey]), beforeSnapshot);

    // LECTURE_GEN_LEASE=off disables remote
    const prevLeaseEnv = process.env.LECTURE_GEN_LEASE;
    process.env.LECTURE_GEN_LEASE = 'off';
    assert.equal(createFeedGenRemote(secret), null);
    if (prevLeaseEnv === undefined) delete process.env.LECTURE_GEN_LEASE;
    else process.env.LECTURE_GEN_LEASE = prevLeaseEnv;
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});
