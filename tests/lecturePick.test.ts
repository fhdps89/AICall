import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickLectureCandidates,
  isQaMistake,
  kstDateOfIso,
  addDaysKst,
  formatLectureDuration,
  sessionCallSeconds,
  isShortSession,
  previousLectureCutoffIso,
  newCandidateCutoffMs,
  SHORT_SESSION_SEC,
  NEW_MISTAKE_FALLBACK_WINDOW_MS,
  MAX_REVIEW_PER_LECTURE,
  type LecturePickMistake,
  type SessionTiming,
} from '../src/services/lecture/lecturePick.ts';

const TODAY = '2026-11-22';
const NOW = '2026-11-22T05:00:00.000Z'; // 14:00 KST
const PRIOR_LECTURE = '2026-11-21T01:00:00.000Z'; // 10:00 KST 11/21, typical morning lecture

function m(partial: Partial<LecturePickMistake> & { id: string; createdAt?: string }): LecturePickMistake {
  return {
    myPhrase: `phrase-${partial.id}`,
    naturalPhrase: `natural-${partial.id}`,
    reason: '시제',
    status: 'reviewing',
    source: 'call',
    createdAt: '2026-11-21T15:00:00.000Z',
    ...partial,
  };
}

test('kstDateOfIso and addDaysKst: UTC+9 date and yesterday boundary', () => {
  assert.equal(kstDateOfIso('2026-11-20T15:00:00Z'), '2026-11-21');
  assert.equal(kstDateOfIso('2026-11-20T14:59:59Z'), '2026-11-20');
  assert.equal(kstDateOfIso('not-a-date'), undefined);
  assert.equal(kstDateOfIso(undefined), undefined);
  assert.equal(addDaysKst('2026-11-22', -1), '2026-11-21');
});

test('formatLectureDuration shows minutes and seconds, not a rounded minute', () => {
  assert.equal(formatLectureDuration(462), '7분 42초');
  assert.equal(formatLectureDuration(546), '9분 6초');
  assert.equal(formatLectureDuration(300), '5분');
  assert.equal(formatLectureDuration(9), '9초');
  assert.equal(formatLectureDuration(0), '0초');
});

test('sessionCallSeconds uses startedAt and endedAt, then last activity; isShortSession is under 3 minutes', () => {
  assert.equal(SHORT_SESSION_SEC, 180);
  // Owner travel/1: 14:22:32–14:28:41Z = 6m09s
  assert.equal(
    sessionCallSeconds({ startedAt: '2026-11-21T14:22:32Z', endedAt: '2026-11-21T14:28:41Z' }),
    6 * 60 + 9
  );
  // Longest QA in the 11/21–11/22 window: 07:39:33–07:42:05Z = 2m32s
  assert.equal(
    sessionCallSeconds({ startedAt: '2026-11-21T07:39:33Z', endedAt: '2026-11-21T07:42:05Z' }),
    2 * 60 + 32
  );
  assert.equal(
    isShortSession(sessionCallSeconds({ startedAt: '2026-11-21T14:22:32Z', endedAt: '2026-11-21T14:28:41Z' })),
    false
  );
  assert.equal(
    isShortSession(sessionCallSeconds({ startedAt: '2026-11-21T07:39:33Z', endedAt: '2026-11-21T07:42:05Z' })),
    true
  );
  assert.equal(isShortSession(179.9), true);
  assert.equal(isShortSession(180), false);
  assert.equal(isShortSession(null), false);
  assert.equal(isShortSession(undefined), false);
  assert.equal(
    sessionCallSeconds({
      startedAt: '2026-11-21T14:22:32Z',
      lastTranscriptAt: '2026-11-21T14:25:32Z',
    }),
    180
  );
  assert.equal(sessionCallSeconds({ startedAt: '2026-11-21T14:22:32Z' }), null);
  assert.equal(sessionCallSeconds(null), null);
});

test('previousLectureCutoffIso takes the latest ready lecture before today', () => {
  assert.equal(
    previousLectureCutoffIso(
      [
        { date: '2026-11-22', status: 'ready', createdAt: '2026-11-22T01:00:00Z' },
        { date: '2026-11-21', status: 'failed', createdAt: '2026-11-21T01:00:00Z' },
        { date: '2026-11-20', status: 'ready', createdAt: '2026-11-20T01:30:00Z' },
        { date: '2026-11-19', status: 'ready', createdAt: '2026-11-19T01:00:00Z' },
      ],
      TODAY
    ),
    '2026-11-20T01:30:00Z'
  );
  assert.equal(previousLectureCutoffIso([], TODAY), undefined);
  assert.equal(
    previousLectureCutoffIso([{ date: '2026-11-21', status: 'ready', createdAt: 'nope' }], TODAY),
    undefined
  );
});

test('newCandidateCutoffMs uses previous lecture createdAt, else now minus 24h', () => {
  assert.equal(newCandidateCutoffMs({ previousLectureCreatedAt: PRIOR_LECTURE }), Date.parse(PRIOR_LECTURE));
  assert.equal(
    newCandidateCutoffMs({ nowIso: NOW }),
    Date.parse(NOW) - NEW_MISTAKE_FALLBACK_WINDOW_MS
  );
  assert.equal(
    newCandidateCutoffMs({ previousLectureCreatedAt: 'nope', nowIso: NOW }),
    Date.parse(NOW) - NEW_MISTAKE_FALLBACK_WINDOW_MS
  );
});

test('pickLectureCandidates: empty in, empty out', () => {
  const got = pickLectureCandidates([], [], TODAY, { nowIso: NOW, previousLectureCreatedAt: PRIOR_LECTURE });
  assert.deepEqual(got, { newMistakes: [], reviewMistakes: [] });
});

test('new mistakes use previous lecture cutoff, not the whole previous calendar day', () => {
  const all: LecturePickMistake[] = [
    m({ id: 'before-cutoff', createdAt: '2026-11-20T16:00:00Z' }), // 01:00 KST 11/21, same calendar yesterday, before 10:00 lecture
    m({ id: 'older', createdAt: '2026-11-20T14:59:59Z' }), // KST 11/20
    m({ id: 'grad', createdAt: '2026-11-21T14:28:00Z', status: 'graduated' }),
    m({ id: 'used', createdAt: '2026-11-21T14:28:00Z', lectureDate: '2026-11-21' }),
    m({ id: 'nodate', createdAt: undefined }),
    m({ id: 'after-cutoff', createdAt: '2026-11-21T14:28:40Z' }), // 23:28 KST 11/21
    m({ id: 'today', createdAt: '2026-11-22T01:00:00Z' }),
  ];
  const got = pickLectureCandidates(all, [], TODAY, { previousLectureCreatedAt: PRIOR_LECTURE, nowIso: NOW });
  assert.deepEqual(got.newMistakes.map((x) => x.id), ['today', 'after-cutoff']);
  assert.equal(got.reviewMistakes.length, 0);
});

test('without a prior lecture, new mistakes are limited to the last 24 hours, not yesterday 00:00 KST', () => {
  const all: LecturePickMistake[] = [
    m({ id: 'inside', createdAt: '2026-11-21T06:00:00Z' }), // 15:00 KST 11/21, 23h before NOW
    m({ id: 'outside', createdAt: '2026-11-21T04:00:00Z' }), // 13:00 KST 11/21, 25h before NOW, still "yesterday"
  ];
  const got = pickLectureCandidates(all, [], TODAY, { nowIso: NOW });
  assert.deepEqual(got.newMistakes.map((x) => x.id), ['inside']);
});

test('new mistakes keep the newest 6 after filters', () => {
  const all = Array.from({ length: 8 }, (_, i) =>
    m({ id: `n${i}`, createdAt: `2026-11-21T1${i}:00:00Z` })
  );
  const got = pickLectureCandidates(all, [], TODAY, { previousLectureCreatedAt: PRIOR_LECTURE, nowIso: NOW });
  assert.equal(got.newMistakes.length, 6);
  assert.deepEqual(
    got.newMistakes.map((x) => x.id),
    ['n7', 'n6', 'n5', 'n4', 'n3', 'n2']
  );
});

test('source qa is dropped from new and review before the caps, untagged docs stay', () => {
  assert.equal(isQaMistake({ source: 'qa' }), true);
  assert.equal(isQaMistake({ source: 'call' }), false);
  const qaNew = m({ id: 'qa1', source: 'qa', createdAt: '2026-11-22T01:00:00Z' });
  const keep = Array.from({ length: 6 }, (_, i) =>
    m({ id: `k${i}`, createdAt: `2026-11-21T1${i}:00:00Z` })
  );
  const due = [
    m({ id: 'qa-due', source: 'qa' }),
    m({ id: 'due1' }),
    m({ id: 'legacy', source: undefined as unknown as 'call' }),
  ];
  const got = pickLectureCandidates([qaNew, ...keep], due, TODAY, {
    previousLectureCreatedAt: PRIOR_LECTURE,
    nowIso: NOW,
  });
  assert.equal(got.newMistakes.some((x) => x.id === 'qa1'), false);
  assert.equal(got.newMistakes.length, 6);
  assert.deepEqual(got.reviewMistakes.map((x) => x.id), ['due1']);
});

test('review drops ids already in new and caps at 1; payload keeps createdAt and lessonTitle', () => {
  assert.equal(MAX_REVIEW_PER_LECTURE, 1);
  const fresh = m({
    id: 'shared',
    createdAt: '2026-11-22T02:00:00Z',
    lessonTitle: '여행 1과',
  });
  const due = [
    fresh,
    m({ id: 'r1', createdAt: '2026-11-10T00:00:00Z' }),
    m({ id: 'r2', createdAt: '2026-11-10T00:00:00Z' }),
    m({ id: 'r3', createdAt: '2026-11-10T00:00:00Z' }),
    m({ id: 'r4', createdAt: '2026-11-10T00:00:00Z' }),
  ];
  const got = pickLectureCandidates([fresh], due, TODAY, {
    previousLectureCreatedAt: PRIOR_LECTURE,
    nowIso: NOW,
  });
  assert.deepEqual(got.newMistakes.map((x) => x.id), ['shared']);
  assert.equal(got.newMistakes[0].createdAt, fresh.createdAt);
  assert.equal(got.newMistakes[0].lessonTitle, '여행 1과');
  assert.deepEqual(got.reviewMistakes.map((x) => x.id), ['r1']);
});

test('short sessions are dropped from new and review; missing session docs are kept and reported', () => {
  const sessions: Record<string, SessionTiming | null> = {
    'call-short': { startedAt: '2026-11-21T13:30:43Z', endedAt: '2026-11-21T13:31:31Z' }, // 47s
    'call-real': { startedAt: '2026-11-21T14:22:32Z', endedAt: '2026-11-21T14:28:41Z' }, // 6m09s
    'call-review-short': { startedAt: '2026-11-15T01:00:00Z', endedAt: '2026-11-15T01:02:00Z' },
    'call-review-real': { startedAt: '2026-11-15T01:00:00Z', endedAt: '2026-11-15T01:10:00Z' },
    'call-missing': null,
  };
  const missing: Array<{ mistakeId: string; sessionId?: string }> = [];
  const all: LecturePickMistake[] = [
    m({ id: 'qa-short', sessionId: 'call-short', createdAt: '2026-11-21T13:31:31Z' }),
    m({ id: 'real', sessionId: 'call-real', createdAt: '2026-11-21T14:28:41Z' }),
    m({ id: 'no-doc', sessionId: 'call-missing', createdAt: '2026-11-21T15:00:00Z' }),
    m({ id: 'no-id', createdAt: '2026-11-21T16:00:00Z' }),
    m({ id: 'unknown-session', sessionId: 'call-never-fetched', createdAt: '2026-11-21T17:00:00Z' }),
  ];
  const due: LecturePickMistake[] = [
    m({ id: 'r-short', sessionId: 'call-review-short', createdAt: '2026-11-15T01:02:00Z' }),
    m({ id: 'r-real', sessionId: 'call-review-real', createdAt: '2026-11-15T01:10:00Z' }),
    m({ id: 'r-missing', sessionId: 'call-gone' }),
  ];
  const got = pickLectureCandidates(all, due, TODAY, {
    previousLectureCreatedAt: PRIOR_LECTURE,
    nowIso: NOW,
    sessionsById: sessions,
    onMissingSession: (info) => missing.push(info),
  });
  assert.deepEqual(got.newMistakes.map((x) => x.id), ['unknown-session', 'no-id', 'no-doc', 'real']);
  assert.deepEqual(got.reviewMistakes.map((x) => x.id), ['r-real']);
  assert.deepEqual(
    missing.map((x) => x.mistakeId).sort(),
    ['no-doc', 'no-id', 'r-missing', 'unknown-session']
  );
});

test('today 9 lecture items: only the owner travel/1 item (#8) is kept; short QA sessions are dropped from new and review', () => {
  const sessions: Record<string, SessionTiming> = {
    'call-1795313143294': { startedAt: '2026-11-22T02:06:07Z', endedAt: '2026-11-22T02:07:04Z' }, // 57s
    'call-1795319287720': { startedAt: '2026-11-22T03:48:35Z', endedAt: '2026-11-22T03:50:17Z' }, // 1m42s
    'call-1795267829709': { startedAt: '2026-11-21T13:30:43Z', endedAt: '2026-11-21T13:31:31Z' }, // 47s
    'call-1795246972341': { startedAt: '2026-11-21T07:42:53Z', endedAt: '2026-11-21T07:44:42Z' }, // 1m49s
    'call-1795246773176': { startedAt: '2026-11-21T07:39:33Z', endedAt: '2026-11-21T07:42:05Z' }, // 2m32s
    'call-1795270951478': { startedAt: '2026-11-21T14:22:32Z', endedAt: '2026-11-21T14:28:41Z' }, // 6m09s
    'call-1795253048358': { startedAt: '2026-11-21T09:24:26Z', endedAt: '2026-11-21T09:26:09Z' }, // 1m43s
  };
  const all: LecturePickMistake[] = [
    m({
      id: 'E77MwVYcUE0W6sLOqqGZ',
      myPhrase: 'Yesterday I go to the office and check the safety gear.',
      sessionId: 'call-1795313143294',
      createdAt: '2026-11-22T02:07:03.535Z',
      lessonTitle: 'Safety toolbox talk on the shop floor',
    }),
    m({
      id: 'B8KT9M8pMTNxcnFJPs3B',
      myPhrase: 'Yesterday I go to the office.',
      sessionId: 'call-1795319287720',
      createdAt: '2026-11-22T03:50:16.709Z',
      lessonTitle: 'Survey topic 3 from my list',
    }),
    m({
      id: 'RWqeyOQCro501C8nU8eO',
      myPhrase: 'industry in my city has moved to other countries',
      sessionId: 'call-1795267829709',
      createdAt: '2026-11-21T13:31:29.528Z',
      lessonTitle: 'Social issues & comparisons',
    }),
    m({
      id: 'oy2i5Q6QiuUnLQQcDW1J',
      myPhrase: 'because of cheap flights',
      sessionId: 'call-1795267829709',
      createdAt: '2026-11-21T13:31:29.528Z',
    }),
    m({
      id: 'wzPziHdjLq5t2ijP5sWX',
      myPhrase: 'much cheaper than now',
      sessionId: 'call-1795267829709',
      createdAt: '2026-11-21T13:31:29.528Z',
    }),
    m({
      id: 'o354SZhcobon5TyMevCc',
      myPhrase: 'you gave me a single room',
      sessionId: 'call-1795246972341',
      createdAt: '2026-11-21T07:44:41.293Z',
    }),
    m({
      id: 'yX5s0FLCuYHA5L0mqOum',
      myPhrase: 'o book a family trip to Jeju',
      sessionId: 'call-1795246773176',
      createdAt: '2026-11-21T07:42:04.267Z',
    }),
    m({
      id: '1tTjWrskCDWqZzEpvXnv',
      myPhrase: 'On Friday, I will I will come to my country',
      sessionId: 'call-1795270951478',
      createdAt: '2026-11-21T14:28:40.272Z',
      lessonTitle: 'USA: immigration at Philadelphia airport',
    }),
    m({
      id: '0ZWaPJtQeeSQ7ZGM9jA5',
      myPhrase: 'Can you fix it?',
      sessionId: 'call-1795246972341',
      createdAt: '2026-11-21T07:44:41.293Z',
      lectureDate: '2026-11-21',
    }),
    m({
      id: '5rNjps2Bc3LujVMxtMnl',
      myPhrase: 'Last holiday, my family went to the beach',
      sessionId: 'call-1795253048358',
      createdAt: '2026-11-21T09:26:07.354Z',
      lectureDate: '2026-11-21',
    }),
  ];
  const due = all.filter((x) => x.lectureDate === '2026-11-21');
  const got = pickLectureCandidates(all, due, TODAY, {
    previousLectureCreatedAt: PRIOR_LECTURE,
    nowIso: NOW,
    sessionsById: sessions,
  });
  assert.deepEqual(got.newMistakes.map((x) => x.id), ['1tTjWrskCDWqZzEpvXnv']);
  assert.equal(got.newMistakes[0].myPhrase, 'On Friday, I will I will come to my country');
  assert.deepEqual(got.reviewMistakes, []);
});
