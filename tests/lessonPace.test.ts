import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLessonsPerCall } from "../src/data/planValidation.ts";
import {
  lastLessonIndex,
  paceTarget,
  nextIndexAfterCompletedCall,
} from "../src/data/lessonPace.ts";

test("1. normalizeLessonsPerCall clamps integers 1..3 and defaults non-integers/missing to 1", () => {
  assert.equal(normalizeLessonsPerCall(2), 2);
  assert.equal(normalizeLessonsPerCall(3), 3);
  assert.equal(normalizeLessonsPerCall(4), 3);
  assert.equal(normalizeLessonsPerCall(0), 1);
  assert.equal(normalizeLessonsPerCall(-2), 1);

  for (const bad of [1.5, "2", null, undefined, Number.NaN]) {
    assert.equal(normalizeLessonsPerCall(bad), 1);
  }
});

test("2. paceTarget and nextIndexAfterCompletedCall handle pace, last-lesson guard, and backward guard", () => {
  const last = 14;

  // pace 1: matches existing behavior
  assert.equal(
    nextIndexAfterCompletedCall({
      completedLessonIndex: 6,
      currentNext: 6,
      lessonsPerCall: 1,
      lastLesson: last,
    }),
    7
  );

  // pace 2 & 3
  assert.equal(
    nextIndexAfterCompletedCall({
      completedLessonIndex: 6,
      currentNext: 6,
      lessonsPerCall: 2,
      lastLesson: last,
    }),
    8
  );
  assert.equal(
    nextIndexAfterCompletedCall({
      completedLessonIndex: 6,
      currentNext: 6,
      lessonsPerCall: 3,
      lastLesson: last,
    }),
    9
  );

  // last lesson protection (never skips 14)
  assert.equal(paceTarget(13, 2, last), 14);
  assert.equal(paceTarget(12, 3, last), 14);

  // after last lesson: advances by 1
  assert.equal(paceTarget(14, 2, last), 15);
  assert.equal(paceTarget(15, 2, last), 16);

  // currentNext >= target -> null
  assert.equal(
    nextIndexAfterCompletedCall({
      completedLessonIndex: 6,
      currentNext: 8,
      lessonsPerCall: 2,
      lastLesson: last,
    }),
    null
  );
  assert.equal(
    nextIndexAfterCompletedCall({
      completedLessonIndex: 3,
      currentNext: 7,
      lessonsPerCall: 2,
      lastLesson: last,
    }),
    null
  );

  // lastLesson null -> +1 regardless of pace
  assert.equal(paceTarget(6, 2, null), 7);

  // out-of-range / invalid pace normalized
  assert.equal(paceTarget(6, 99, last), 9);
  assert.equal(paceTarget(6, "abc", last), 7);
});

test("3. lastLessonIndex handles empty/undefined, 14-item list, and shuffled indices", () => {
  assert.equal(lastLessonIndex([]), null);
  assert.equal(lastLessonIndex(undefined), null);
  assert.equal(
    lastLessonIndex(Array.from({ length: 14 }, (_, i) => ({ index: i + 1 }))),
    14
  );
  assert.equal(lastLessonIndex([{ index: 5 }, { index: 14 }, { index: 2 }]), 14);
});
