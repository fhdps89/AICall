import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEmptyReview,
  levelBadge,
  outcomeItems,
  sourceSttLabel,
} from '../src/services/review/reviewView.ts';

test('sourceSttLabel maps four known values distinctly and falls back for unknown', () => {
  const known = [
    sourceSttLabel('sttFinal'),
    sourceSttLabel('sttPartial_fallback'),
    sourceSttLabel('liveTranscript_fallback'),
    sourceSttLabel('none'),
  ];
  assert.equal(new Set(known).size, 4);
  assert.equal(sourceSttLabel('sttFinal'), '최종 받아쓰기');
  assert.equal(sourceSttLabel('sttPartial_fallback'), '통화 중 임시 받아쓰기');
  assert.equal(sourceSttLabel('liveTranscript_fallback'), '통화 로그');
  assert.equal(sourceSttLabel('none'), '기록 없음');
  assert.equal(sourceSttLabel('something_else'), '받아쓰기');
  assert.equal(sourceSttLabel(undefined), '받아쓰기');
});

test('isEmptyReview detects none source or lessonAdvanced === false', () => {
  assert.equal(isEmptyReview({ lessonAdvanced: true }, 'none'), true);
  assert.equal(isEmptyReview({ lessonAdvanced: false }, 'sttFinal'), true);
  assert.equal(isEmptyReview({ lessonAdvanced: false }, 'none'), true);
  assert.equal(isEmptyReview({ lessonAdvanced: true }, 'sttFinal'), false);
  assert.equal(isEmptyReview({}, 'sttFinal'), false);
});

test('levelBadge handles missing/dash as none and AL as good', () => {
  assert.deepEqual(levelBadge(undefined), { text: '—', tone: 'none' });
  assert.deepEqual(levelBadge('-'), { text: '—', tone: 'none' });
  assert.deepEqual(levelBadge(''), { text: '—', tone: 'none' });
  assert.deepEqual(levelBadge('AL'), { text: 'AL', tone: 'good' });
  assert.deepEqual(levelBadge('Native'), { text: 'Native', tone: 'good' });
  assert.deepEqual(levelBadge('IH'), { text: 'IH', tone: 'mid' });
  assert.deepEqual(levelBadge('IM2'), { text: 'IM2', tone: 'mid' });
  assert.deepEqual(levelBadge('IM1'), { text: 'IM1', tone: 'base' });
});

test('outcomeItems drops unknown ids and preserves ids order', () => {
  const pool = [
    { id: 'a', myPhrase: 'first' },
    { id: 'b', myPhrase: 'second' },
    { myPhrase: 'no-id' },
    { id: 'c', myPhrase: 'third' },
  ];
  const result = outcomeItems(['c', 'missing', 'a', 'also-missing'], pool);
  assert.deepEqual(result, [
    { id: 'c', myPhrase: 'third' },
    { id: 'a', myPhrase: 'first' },
  ]);
});
