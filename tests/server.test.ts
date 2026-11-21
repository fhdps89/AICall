import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { DATA_DIR, readLectureState, toSpeechParts } from '../server/lecture.ts';
import { isValidFeedSecret } from '../server/feed.ts';
import { checkGeminiCall, checkClusterCall, RATE_LIMITS } from '../server/rateLimit.ts';
import { validateClusterRequestBody } from '../server/mistakeClusters.ts';
import { userRecordingPath } from '../server/recordingPath.ts';
import { verifyFirebaseIdToken } from '../server/auth.ts';

test('a "generating" lecture with no running job (server restart) reads as INTERRUPTED', () => {
  const uid = `test_${process.pid}`;
  const dir = path.join(DATA_DIR, 'lectures', uid);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(dir, '2026-10-18.json'), JSON.stringify({ uid, date: '2026-10-18', status: 'generating', newMistakeIds: [], reviewMistakeIds: [], ttsEngine: 'gemini', createdAt: now, updatedAt: now }));
    const st = readLectureState(uid, '2026-10-18');
    assert.equal(st?.status, 'failed');
    assert.equal(st?.error, 'INTERRUPTED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two-speaker TTS: one part per speaker turn, same-speaker lines merged', () => {
  const parts = toSpeechParts('Coach: Hi\nCoach: again\nPartner: Hello', true);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].speechMetadata.speaker, 'Coach');
  assert.equal(parts[0].text, 'Hi again');
  assert.equal(parts[1].speechMetadata.speaker, 'Partner');
});

test('feed secret format', () => {
  assert.ok(isValidFeedSecret('a'.repeat(48)));
  assert.ok(!isValidFeedSecret('short'));
  assert.ok(!isValidFeedSecret('../../etc/passwd/aaaaaaaaaaaaaaaaaaaa'));
});

test('per-minute Gemini limit', () => {
  const uid = `limit_${Date.now()}`;
  const t = Date.now();
  for (let i = 0; i < RATE_LIMITS.PER_MINUTE; i++) assert.ok(checkGeminiCall(uid, t).ok);
  assert.equal(checkGeminiCall(uid, t).ok, false);
  assert.ok(checkGeminiCall(uid, t + 61_000).ok);
});

test('recording paths stay inside the user folder', () => {
  const root = '/data/recordings';
  assert.equal(userRecordingPath(root, 'u1', 'recordings/s1/chunk_0001.webm'), '/data/recordings/u1/recordings/s1/chunk_0001.webm');
  assert.equal(userRecordingPath(root, 'u1', '../u2/secret.webm'), null);
  assert.equal(userRecordingPath(root, 'u1', '/etc/passwd'), null);
});

test('malformed login tokens are rejected', async () => {
  await assert.rejects(verifyFirebaseIdToken('not-a-token'), /malformed/);
});

test('API error replies carry a fixed sentence and code, never the raw error', async () => {
  const { apiError, noKey, NO_KEY_MESSAGE } = await import('../server/errors.ts');
  const calls: any[] = [];
  const res: any = { status(c: number) { calls.push(c); return this; }, json(b: any) { calls.push(b); return this; } };
  apiError(res, 500, 'REVIEW_FAILED', '복기 리포트를 만들지 못했어요.');
  assert.deepEqual(calls, [500, { ok: false, code: 'REVIEW_FAILED', error: '복기 리포트를 만들지 못했어요.' }]);
  calls.length = 0;
  noKey(res);
  assert.deepEqual(calls, [503, { ok: false, code: 'NO_SERVER_KEY', error: NO_KEY_MESSAGE }]);
  // Guard against a regression: no route in server.ts may put err.message into a response.
  const src = fs.readFileSync(path.resolve(DATA_DIR, '..', 'server.ts'), 'utf-8');
  const leaks = src.split('\n').filter((l) => /(json|send)\(.*(err|error|parseErr|connectError)\??\.message/.test(l));
  assert.deepEqual(leaks, []);
});

test('validateClusterRequestBody rejects invalid payloads and normalizes valid ones', () => {
  assert.equal(validateClusterRequestBody(null).ok, false);
  assert.equal(validateClusterRequestBody({ items: 'not-array' }).ok, false);
  assert.equal(
    validateClusterRequestBody({
      items: Array.from({ length: 121 }, (_, i) => ({
        id: `id_${i}`,
        myPhrase: 'a',
        naturalPhrase: 'b',
      })),
    }).ok,
    false
  );
  assert.equal(
    validateClusterRequestBody({
      items: [{ id: 123, myPhrase: 'a', naturalPhrase: 'b' }],
    }).ok,
    false
  );
  assert.equal(
    validateClusterRequestBody({
      items: [{ id: '  ', myPhrase: 'a', naturalPhrase: 'b' }],
    }).ok,
    false
  );

  const valid = validateClusterRequestBody({
    items: [
      {
        id: 'm1',
        myPhrase: 'a'.repeat(250),
        naturalPhrase: 'b'.repeat(250),
        reason: 'c'.repeat(350),
      },
    ],
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.items.length, 1);
    assert.equal(valid.items[0].myPhrase.length, 200);
    assert.equal(valid.items[0].naturalPhrase.length, 200);
    assert.equal(valid.items[0].reason.length, 300);
  }
});

test('cluster limiter enforces separate per-minute bucket without spending Gemini quota', () => {
  const uid = `cluster_limit_${Date.now()}`;
  const t = Date.now();
  for (let i = 0; i < RATE_LIMITS.CLUSTER_PER_MINUTE; i++) {
    assert.ok(checkClusterCall(uid, t).ok);
  }
  assert.equal(checkClusterCall(uid, t).ok, false);
  // Gemini quota for the same uid must still be untouched
  assert.ok(checkGeminiCall(uid, t).ok);
  assert.ok(checkClusterCall(uid, t + 61_000).ok);
});
