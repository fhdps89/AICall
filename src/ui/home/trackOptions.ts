import type { GoalData } from "../../services/firebase/db";

export interface TrackOption {
  id: string;
  title: string;
  nextLabel: string;
  isRoutine: boolean;
  isSelected: boolean;
  disabledReason: string | null;
}

export interface BuildTrackOptionsInput {
  goals: GoalData[];
  routineGoalId: string | null;
  overrideGoalId: string | null;
  isPlanReviewDay: boolean;
}

export interface BuildTrackOptionsResult {
  options: TrackOption[];
  reviewDaySelected: boolean;
}

const NO_NEXT_LESSON_REASON = "진행할 과가 없어요";

function sortablePriority(priority: unknown): number {
  return typeof priority === "number" && Number.isFinite(priority)
    ? priority
    : Number.POSITIVE_INFINITY;
}

/**
 * 홈 트랙 선택 시트에 표시할 트랙 목록과 주간 복기 선택 상태를 계산한다.
 */
export function buildTrackOptions({
  goals,
  routineGoalId,
  overrideGoalId,
  isPlanReviewDay,
}: BuildTrackOptionsInput): BuildTrackOptionsResult {
  const reviewDaySelected = Boolean(isPlanReviewDay && !overrideGoalId);
  const selectedGoalId = overrideGoalId || (isPlanReviewDay ? null : routineGoalId);

  const sortedGoals = goals
    .map((goal, index) => ({ goal, index }))
    .sort((a, b) => {
      const diff = sortablePriority(a.goal.priority) - sortablePriority(b.goal.priority);
      return diff !== 0 ? diff : a.index - b.index;
    });

  const options: TrackOption[] = sortedGoals.map(({ goal }) => {
    const nextIndex = goal.nextLessonIndex || 1;
    const lessons = Array.isArray(goal.lessons) ? goal.lessons : [];
    const nextLesson = lessons.find((lesson) => lesson.index === nextIndex);
    const isFinished = goal.status === "done" || !nextLesson;

    return {
      id: goal.id,
      title: goal.title,
      nextLabel: isFinished ? "" : `${nextLesson.index}과. ${nextLesson.title}`,
      isRoutine: !isPlanReviewDay && Boolean(routineGoalId) && goal.id === routineGoalId,
      isSelected: Boolean(selectedGoalId) && goal.id === selectedGoalId,
      disabledReason: isFinished ? NO_NEXT_LESSON_REASON : null,
    };
  });

  return { options, reviewDaySelected };
}
