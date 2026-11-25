import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import { DATA_DIR, type LectureState } from '../server/lecture.ts';
import { buildFeedDiag, type FeedSyncState } from '../server/feed.ts';
import { feedDocId } from '../server/feedStore.ts';

function uidFor(name: string): string {
  return `test_diag_${name}_${process.pid}`;
}

function cleanup(uid: string) {
  fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
}

const EXPECTED_DIAG_KEYS = [
  'date',
  'status',
  'error',
  'audioRestoring',
  'hasAudio',
  'generatedAt',
  'durationSec',
  'itemCount',
  'newMistakeCount',
  'reviewCount',
  'inputNewCount',
  'inputReviewCount',
  'latestInputCreatedAt',
  'syncedAt',
  'syncNewCount',
  'syncReviewCount',
  'latestSyncCandidateAt',
  'pendingNewCount',
  'autoRegenerateEligible',
  'audioError',
  'audioRetryAfter',
  'audioBackup',
  'dailyGenCount',
  'dailyGenCap',
  'genSkipReason',
  'genSkipAt',
  'genBlockedUntil',
  'genLeaseMode',
];

const EXPECTED_AUDIO_ERROR_KEYS = [
  'stage',
  'code',
  'httpStatus',
  'googleStatus',
  'quota',
  'retryDelaySec',
  'attempts',
  'completed',
  'total',
  'at',
  'origin',
];

const EXPECTED_AUDIO_BACKUP_KEYS = [
  'target',
  'result',
  'httpStatus',
  'chunks',
  'bytes',
  'at',
];

test('1-3) buildFeedDiag matches exact allow-list, leaks no text/ids/secrets, and counts items accurately', () => {
  const uid = uidFor('allowlist');
  const date = '2026-11-24';
  const secret = 'secret_diag_marker_' + 'x'.repeat(30);
  const now = Date.parse('2026-11-24T02:00:00.000Z');
  const dir = path.join(DATA_DIR, 'lectures', uid);

  try {
    fs.mkdirSync(dir, { recursive: true });
    const lecture: LectureState = {
      uid,
      date,
      status: 'ready',
      title: 'UNIQUE_DIAG_TITLE_MARKER',
      coachNote: 'UNIQUE_COACH_NOTE_MARKER. 둘째 문장.',
      itemCount: 3,
      durationSec: 364,
      newMistakeIds: ['id-new-1', 'id-new-2'],
      reviewMistakeIds: ['id-rev-1'],
      inputNewIds: ['id-new-1', 'id-new-2', 'id-new-dropped'],
      inputReviewIds: ['id-rev-1'],
      inputLatestCreatedAt: '2026-11-24T00:10:00.000Z',
      script: [
        {
          mistakeId: 'id-new-1',
          kind: 'new',
          myPhrase: 'UNIQUE_MY_PHRASE_1',
          naturalPhrase: 'UNIQUE_NAT_PHRASE_1',
          explanation: '설명',
          dialogue: [],
          meaningKo: '뜻',
          answerEnglish: 'UNIQUE_NAT_PHRASE_1',
        },
        {
          mistakeId: 'id-new-2',
          kind: 'new',
          myPhrase: 'UNIQUE_MY_PHRASE_2',
          naturalPhrase: 'UNIQUE_NAT_PHRASE_2',
          explanation: '설명',
          dialogue: [],
          meaningKo: '뜻',
          answerEnglish: 'UNIQUE_NAT_PHRASE_2',
        },
        {
          mistakeId: 'id-rev-1',
          kind: 'review',
          myPhrase: 'UNIQUE_MY_PHRASE_3',
          naturalPhrase: 'UNIQUE_NAT_PHRASE_3',
          explanation: '설명',
          dialogue: [],
          meaningKo: '뜻',
          answerEnglish: 'UNIQUE_NAT_PHRASE_3',
        },
      ],
      ttsEngine: 'gemini',
      audioFile: `${date}.wav`,
      createdAt: '2026-11-24T00:30:00.000Z',
      updatedAt: '2026-11-24T00:32:00.000Z',
    };
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(lecture, null, 2));
    fs.writeFileSync(path.join(dir, `${date}.wav`), Buffer.from('RIFF'));

    const st: FeedSyncState = {
      uid,
      secret,
      quizCount: 3,
      newMistakes: [
        { id: 'id-new-1', myPhrase: 'a', naturalPhrase: 'b', createdAt: '2026-11-24T00:05:00.000Z' },
        { id: 'id-new-pending', myPhrase: 'c', naturalPhrase: 'd', createdAt: '2026-11-24T01:20:00.000Z' },
      ],
      reviewMistakes: [{ id: 'id-rev-1', myPhrase: 'e', naturalPhrase: 'f' }],
      syncedAt: '2026-11-24T01:30:00.000Z',
    };

    const diag = buildFeedDiag(st, { date, now });
    assert.deepEqual(Object.keys(diag), EXPECTED_DIAG_KEYS);

    const raw = JSON.stringify(diag);
    for (const forbidden of [
      'UNIQUE_MY_PHRASE_1',
      'UNIQUE_NAT_PHRASE_1',
      'UNIQUE_DIAG_TITLE_MARKER',
      'UNIQUE_COACH_NOTE_MARKER',
      uid,
      secret,
      feedDocId(secret),
      'id-new-1',
      'id-new-2',
      'id-new-dropped',
      'id-new-pending',
      'id-rev-1',
    ]) {
      assert.equal(raw.includes(forbidden), false, `diag leaked ${forbidden}`);
    }

    assert.equal(diag.status, 'ready');
    assert.equal(diag.hasAudio, true);
    assert.equal(diag.audioRestoring, false);
    assert.equal(diag.error, null);
    assert.equal(diag.durationSec, 364);
    assert.equal(diag.itemCount, 3);
    assert.equal(diag.newMistakeCount, 2);
    assert.equal(diag.reviewCount, 1);
    assert.equal(diag.inputNewCount, 3);
    assert.equal(diag.inputReviewCount, 1);
    assert.equal(diag.pendingNewCount, 1);
    assert.equal(diag.autoRegenerateEligible, true);
    assert.equal(diag.audioError, null);
    assert.equal(diag.audioRetryAfter, null);
    assert.equal(diag.audioBackup, null);
  } finally {
    cleanup(uid);
  }
});

test('6) buildFeedDiag enforces nested allow-lists for audioError and audioBackup without leaking text/secrets/ids', () => {
  const uid = uidFor('nested_allowlist');
  const date = '2026-11-24';
  const secret = 'secret_nested_marker_' + 'y'.repeat(30);
  const dir = path.join(DATA_DIR, 'lectures', uid);

  try {
    fs.mkdirSync(dir, { recursive: true });
    const lecture: any = {
      uid,
      date,
      status: 'ready',
      audioStatus: 'missing',
      title: 'NESTED_TITLE_SECRET',
      script: [
        {
          mistakeId: 'm1',
          kind: 'new',
          myPhrase: 'a',
          naturalPhrase: 'b',
          explanation: 'c',
          dialogue: [],
          meaningKo: 'd',
          answerEnglish: 'b',
        },
      ],
      newMistakeIds: ['m1'],
      reviewMistakeIds: [],
      ttsEngine: 'gemini',
      audioRetryAfter: '2026-11-24T03:00:00.000Z',
      audioError: {
        stage: 'tts',
        code: 'QUOTA',
        httpStatus: 429,
        googleStatus: 'RESOURCE_EXHAUSTED',
        quota: 'minute',
        retryDelaySec: 20,
        attempts: 3,
        completed: 2,
        total: 10,
        at: '2026-11-24T02:00:00.000Z',
        origin: 'local',
        rawMessage: 'LEAKY_RAW_ERROR_MARKER',
      },
      audioBackup: {
        target: 'firestore',
        result: 'denied',
        httpStatus: 403,
        chunks: 4,
        bytes: 2100000,
        at: '2026-11-24T01:59:00.000Z',
        url: 'https://leaky.example.com/' + secret,
      },
      createdAt: '2026-11-24T00:30:00.000Z',
      updatedAt: '2026-11-24T02:00:00.000Z',
    };
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(lecture));
    const st: FeedSyncState = {
      uid,
      secret,
      quizCount: 0,
      newMistakes: [],
      reviewMistakes: [],
      syncedAt: '2026-11-24T01:00:00.000Z',
    };

    const diag = buildFeedDiag(st, { date, now: Date.parse('2026-11-24T02:05:00.000Z') });
    assert.deepEqual(Object.keys(diag), EXPECTED_DIAG_KEYS);
    assert.ok(diag.audioError);
    assert.deepEqual(Object.keys(diag.audioError), EXPECTED_AUDIO_ERROR_KEYS);
    assert.ok(diag.audioBackup);
    assert.deepEqual(Object.keys(diag.audioBackup), EXPECTED_AUDIO_BACKUP_KEYS);
    assert.equal(diag.audioRetryAfter, '2026-11-24T03:00:00.000Z');

    const raw = JSON.stringify(diag);
    for (const forbidden of ['NESTED_TITLE_SECRET', 'LEAKY_RAW_ERROR_MARKER', secret, feedDocId(secret), uid]) {
      assert.equal(raw.includes(forbidden), false, `diag leaked ${forbidden}`);
    }
  } finally {
    cleanup(uid);
  }
});

test('4) buildFeedDiag is strictly read-only on a ready lecture with missing audio', () => {
  const uid = uidFor('readonly');
  const date = '2026-11-24';
  const dir = path.join(DATA_DIR, 'lectures', uid);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const lecture: LectureState = {
      uid,
      date,
      status: 'ready',
      title: '제목',
      script: [
        {
          mistakeId: 'm1',
          kind: 'new',
          myPhrase: 'a',
          naturalPhrase: 'b',
          explanation: 'c',
          dialogue: [],
          meaningKo: 'd',
          answerEnglish: 'b',
        },
      ],
      newMistakeIds: ['m1'],
      reviewMistakeIds: [],
      ttsEngine: 'gemini',
      createdAt: '2026-11-24T00:30:00.000Z',
      updatedAt: '2026-11-24T00:30:00.000Z',
    };
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(lecture));
    const st: FeedSyncState = {
      uid,
      secret: 'r'.repeat(48),
      quizCount: 0,
      newMistakes: [],
      reviewMistakes: [],
      syncedAt: '2026-11-24T01:00:00.000Z',
    };

    const filesBefore = fs.readdirSync(dir);
    const diag = buildFeedDiag(st, { date, now: Date.parse('2026-11-24T02:00:00.000Z') });
    const filesAfter = fs.readdirSync(dir);

    assert.deepEqual(filesAfter, filesBefore);
    assert.equal(fs.existsSync(path.join(dir, `${date}.gen.json`)), false);
    assert.equal(diag.status, 'ready');
    assert.equal(diag.hasAudio, false);
    assert.equal(diag.audioRestoring, false);
  } finally {
    cleanup(uid);
  }
});

test('5) buildFeedDiag returns waiting before 05:00 KST when there is no lecture', () => {
  const uid = uidFor('waiting');
  const date = '2026-11-24';
  const st: FeedSyncState = {
    uid,
    secret: 'w'.repeat(48),
    quizCount: 0,
    newMistakes: [{ id: 'm1', myPhrase: 'a', naturalPhrase: 'b' }],
    reviewMistakes: [],
    syncedAt: '2026-11-23T19:00:00.000Z',
  };
  const diag = buildFeedDiag(st, { date, now: Date.parse('2026-11-23T19:30:00.000Z') }); // 04:30 KST
  assert.equal(diag.status, 'waiting');
  assert.equal(diag.autoRegenerateEligible, false);
});
