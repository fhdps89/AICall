import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionReviewData } from '../src/services/firebase/db.ts';
import {
  isEmptyReview,
  levelBadge,
  outcomeItems,
  reviewSaveNotice,
  shouldShowLessonAdvanced,
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

test('reviewSaveNotice handles QA, save failure, saved count, and zero mistakes (A10-A14)', () => {
  const qa = reviewSaveNotice({ qaCall: true, visibleCount: 2 });
  assert.equal(qa.tone, 'info');
  assert.ok(qa.text.includes('QA 통화'));
  assert.ok(qa.text.includes('저장하지 않았어요'));
  assert.ok(!qa.text.includes('저장하지 못했어요'));
  assert.ok(!qa.text.includes('자동으로 저장됐어요'));
  assert.equal(qa.showNextSteps, false);

  const qaEvenWithSavedFalse = reviewSaveNotice({ qaCall: true, mistakesSaved: false, visibleCount: 1 });
  assert.deepEqual(qaEvenWithSavedFalse, qa);

  const failed = reviewSaveNotice({ mistakesSaved: false, visibleCount: 1 });
  assert.equal(failed.tone, 'warn');
  assert.equal(
    failed.text,
    '실수를 앱 복습 목록에 저장하지 못했어요. 아래 "Keep에 붙여넣기용 복사"로 따로 남겨 두세요.'
  );
  assert.equal(failed.showNextSteps, true);

  const saved = reviewSaveNotice({ mistakesSaved: true, visibleCount: 3 });
  assert.equal(saved.tone, 'ok');
  assert.equal(saved.text, '오늘 실수 3개는 앱 복습 목록에 자동으로 저장됐어요. 따로 옮겨 적지 않아도 돼요.');
  assert.equal(saved.showNextSteps, true);

  const zero = reviewSaveNotice({ visibleCount: 0 });
  assert.equal(zero.tone, 'ok');
  assert.equal(zero.text, '오늘은 저장할 실수가 없어요.');
  assert.equal(zero.showNextSteps, true);
});

test('shouldShowLessonAdvanced requires lessonAdvanced=true and qaCall!=true (A15)', () => {
  assert.equal(shouldShowLessonAdvanced({ lessonAdvanced: true }), true);
  assert.equal(shouldShowLessonAdvanced({ lessonAdvanced: true, qaCall: true }), false);
  assert.equal(shouldShowLessonAdvanced({}), false);
  assert.equal(shouldShowLessonAdvanced(null), false);
});

test('isEmptyReview does not treat a QA review as empty when transcript source is valid (A16)', () => {
  const qaReview: Partial<SessionReviewData> = { qaCall: true };
  assert.equal(isEmptyReview(qaReview, 'sttFinal'), false);
});
