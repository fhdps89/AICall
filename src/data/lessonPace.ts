/**
 * Pure lesson-pace calculation shared by progressAdjust and db.ts.
 * Kept free of Firebase and DOM so plain node can load it directly.
 */
import { normalizeLessonsPerCall } from "./planValidation.ts";

/** Returns the highest numeric lesson index in a goal's lessons array, or null when unknown/empty. */
export function lastLessonIndex(lessons: unknown): number | null {
  if (!Array.isArray(lessons) || lessons.length === 0) return null;
  let max: number | null = null;
  for (const lesson of lessons) {
    if (lesson && typeof lesson === "object") {
      const idx = (lesson as { index?: unknown }).index;
      if (typeof idx === "number" && Number.isFinite(idx)) {
        if (max === null || idx > max) max = idx;
      }
    }
  }
  return max;
}

/**
 * Computes the next lesson index after completing `completedLessonIndex` with `lessonsPerCall`.
 * Never skips the final lesson (`lastLesson`): if already at/past `lastLesson` or `lastLesson === null`,
 * advances by 1; otherwise advances by pace up to `lastLesson`.
 */
export function paceTarget(
  completedLessonIndex: number,
  lessonsPerCall: unknown,
  lastLesson: number | null
): number {
  const pace = normalizeLessonsPerCall(lessonsPerCall);
  if (lastLesson === null || completedLessonIndex >= lastLesson) {
    return completedLessonIndex + 1;
  }
  return Math.min(completedLessonIndex + pace, lastLesson);
}

/**
 * Returns the new `nextLessonIndex` to store after a completed call, or `null` if `currentNext`
 * is already at or ahead of the target (so reviewing an older call never moves progress backwards).
 */
export function nextIndexAfterCompletedCall(o: {
  completedLessonIndex: number;
  currentNext: number;
  lessonsPerCall: unknown;
  lastLesson: number | null;
}): number | null {
  const t = paceTarget(o.completedLessonIndex, o.lessonsPerCall, o.lastLesson);
  if (o.currentNext >= t) return null;
  return t;
}
