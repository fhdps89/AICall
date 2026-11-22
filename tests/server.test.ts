import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { DATA_DIR, TTS_STYLE, readLectureState, toSpeechParts } from '../server/lecture.ts';
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

test('toSpeechParts single and multi-speaker behavior (T1–T10)', () => {
  const STYLE_LEAK_RE = /Read this morning English lesson|Korean-accented transliteration/;

  // T1 & T3: single speaker puts style in speechMetadata, no speaker key
  const t1 = toSpeechParts('Coach: 좋은 아침이에요.', false);
  assert.deepEqual(t1, [{ text: '좋은 아침이에요.', speechMetadata: { style: TTS_STYLE } }]);
  assert.equal('speaker' in t1[0].speechMetadata, false);
  assert.ok(t1[0].speechMetadata.style.includes('Korean-accented transliteration'));

  // T2: single-speaker inputs never leak TTS_STYLE into text
  for (const sample of [
    'Coach: 좋은 아침이에요. 오늘 아침 강의, 테스트. 모두 1개 표현을 함께 볼게요.',
    "Coach: I'm here on a business trip.",
    'Coach: 오늘의 코치 한마디. 잘하고 있어요.',
  ]) {
    const parts = toSpeechParts(sample, false);
    for (const p of parts) {
      assert.equal(STYLE_LEAK_RE.test(p.text), false);
    }
  }

  // T4: single speaker merges all lines with \n and strips labels
  assert.deepEqual(toSpeechParts('Coach: A\nPartner: B', false), [
    { text: 'A\nB', speechMetadata: { style: TTS_STYLE } },
  ]);

  // T5: empty or label-only inputs yield []
  assert.deepEqual(toSpeechParts('', false), []);
  assert.deepEqual(toSpeechParts('Coach: ', false), []);
  assert.deepEqual(toSpeechParts('', true), []);

  // T7: alternating speakers keep order, strip labels, attach TTS_STYLE
  const t7 = toSpeechParts('Coach: A\nPartner: B\nCoach: C', true);
  assert.equal(t7.length, 3);
  assert.deepEqual(
    t7.map((p) => p.speechMetadata.speaker),
    ['Coach', 'Partner', 'Coach']
  );
  for (const p of t7) {
    assert.equal(/^(Coach|Partner)\s*:/.test(p.text), false);
    assert.equal(p.speechMetadata.style, TTS_STYLE);
  }

  // T8: empty Partner line is dropped and adjacent Coach lines merge
  assert.deepEqual(toSpeechParts('Coach: A\nPartner: \nCoach: B', true), [
    { text: 'A B', speechMetadata: { speaker: 'Coach', style: TTS_STYLE } },
  ]);

  // T9: unlabeled line in two-speaker mode defaults to Coach
  const t9 = toSpeechParts('라벨 없는 줄', true);
  assert.equal(t9[0].speechMetadata.speaker, 'Coach');

  // T10: toSpeechParts does not strip directions (preserves myPhrase verbatim)
  const t10 = toSpeechParts('Coach: 어젯밤 하신 말은 "I go (pause) home" 였어요.', false);
  assert.ok(t10[0].text.includes('(pause)'));
});

test('lecture prompt source guards (P1–P2)', () => {
  const src = fs.readFileSync(path.resolve(DATA_DIR, '..', 'server', 'lecture.ts'), 'utf-8');
  assert.equal(src.includes('(3초 무음은 시스템이 넣음)'), false);
  assert.ok(src.includes('글자 그대로 소리 내어 읽습니다'));
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
