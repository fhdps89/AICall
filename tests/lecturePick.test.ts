import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickLectureCandidates,
  isQaMistake,
  kstDateOfIso,
  addDaysKst,
  formatLectureDuration,
  type LecturePickMistake,
} from '../src/services/lecture/lecturePick.ts';

const TODAY = '2026-11-22';

function m(partial: Partial<LecturePickMistake> & { id: string; createdAt?: string }): LecturePickMistake {
  return {
    myPhrase: `phrase-${partial.id}`,
    naturalPhrase: `natural-${partial.id}`,
    reason: '시제',
    status: 'reviewing',
    source: 'call',
    createdAt: '2026-11-21T15:00:00.000Z', // KST 11/22 00:00? 15:00Z = 11/22 00:00 KST
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

test('pickLectureCandidates: empty in, empty out', () => {
  const got = pickLectureCandidates([], [], TODAY);
  assert.deepEqual(got, { newMistakes: [], reviewMistakes: [] });
});

test('new mistakes include yesterday KST and exclude the day before, graduated, lectureDate, missing createdAt', () => {
  const all: LecturePickMistake[] = [
    m({ id: 'yest', createdAt: '2026-11-20T15:00:00Z' }), // KST 11/21
    m({ id: 'older', createdAt: '2026-11-20T14:59:59Z' }), // KST 11/20
    m({ id: 'grad', createdAt: '2026-11-21T01:00:00Z', status: 'graduated' }),
    m({ id: 'used', createdAt: '2026-11-21T01:00:00Z', lectureDate: '2026-11-22' }),
    m({ id: 'nodate', createdAt: undefined }),
    m({ id: 'today', createdAt: '2026-11-22T01:00:00Z' }),
  ];
  const got = pickLectureCandidates(all, [], TODAY);
  assert.deepEqual(got.newMistakes.map((x) => x.id), ['today', 'yest']);
  assert.equal(got.reviewMistakes.length, 0);
});

test('new mistakes keep the newest 6 after filters', () => {
  const all = Array.from({ length: 8 }, (_, i) =>
    m({ id: `n${i}`, createdAt: `2026-11-21T0${i}:00:00Z` })
  );
  const got = pickLectureCandidates(all, [], TODAY);
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
  const got = pickLectureCandidates([qaNew, ...keep], due, TODAY);
  assert.equal(got.newMistakes.some((x) => x.id === 'qa1'), false);
  assert.equal(got.newMistakes.length, 6);
  assert.deepEqual(got.reviewMistakes.map((x) => x.id), ['due1', 'legacy']);
});

test('review drops ids already in new and caps at 3; payload keeps createdAt and lessonTitle', () => {
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
  const got = pickLectureCandidates([fresh], due, TODAY);
  assert.deepEqual(got.newMistakes.map((x) => x.id), ['shared']);
  assert.equal(got.newMistakes[0].createdAt, fresh.createdAt);
  assert.equal(got.newMistakes[0].lessonTitle, '여행 1과');
  assert.deepEqual(got.reviewMistakes.map((x) => x.id), ['r1', 'r2', 'r3']);
});
