import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { DATA_DIR, readLectureState, toSpeechParts } from '../server/lecture.ts';
import { isValidFeedSecret } from '../server/feed.ts';
import { checkGeminiCall, RATE_LIMITS } from '../server/rateLimit.ts';
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
