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

export type TrackPickerMode = "switchTrack" | "startCall";

export type TrackPickAction =
  | { type: "selectTrack"; goalId: string | null }
  | { type: "startCall"; goalId: string; lessonIndex: number }
  | { type: "none" };

const NO_NEXT_LESSON_REASON = "진행할 과가 없어요";

function sortablePriority(priority: unknown): number {
  return typeof priority === "number" && Number.isFinite(priority)
    ? priority
    : Number.POSITIVE_INFINITY;
}

/**
 * 진행할 과가 있으면 그 과, 없으면(status done 또는 nextLessonIndex에 맞는 과 없음) null.
 */
export function nextPlayableLesson(goal: GoalData): { index: number; title: string } | null {
  if (goal.status === "done") return null;
  const nextIndex = goal.nextLessonIndex || 1;
  const lessons = Array.isArray(goal.lessons) ? goal.lessons : [];
  const nextLesson = lessons.find((lesson) => lesson.index === nextIndex);
  if (!nextLesson) return null;
  return { index: nextLesson.index, title: nextLesson.title };
}

/**
 * 트랙 피커에서 항목을 눌렀을 때 실행할 동작을 결정한다.
 */
export function resolveTrackPick(input: {
  mode: TrackPickerMode;
  pickedGoalId: string | null;
  goals: GoalData[];
}): TrackPickAction {
  if (input.pickedGoalId === null) {
    return { type: "selectTrack", goalId: null };
  }
  const goal = input.goals.find((g) => g.id === input.pickedGoalId);
  if (!goal) {
    return { type: "none" };
  }
  const nextLesson = nextPlayableLesson(goal);
  if (!nextLesson) {
    return { type: "none" };
  }
  if (input.mode === "startCall") {
    return { type: "startCall", goalId: goal.id, lessonIndex: nextLesson.index };
  }
  return { type: "selectTrack", goalId: goal.id };
}

/**
 * 피커 모드에 따른 부제를 반환한다.
 */
export function trackPickerSubtitle(mode: TrackPickerMode): string {
  return mode === "startCall"
    ? "수업 트랙을 고르면 바로 통화 준비로 넘어가요"
    : "오늘 통화할 수업 트랙을 골라보세요";
}

/**
 * 주간 복기 행의 부제를 피커 모드에 따라 반환한다.
 */
export function reviewDayRowSubtitle(mode: TrackPickerMode): string {
  return mode === "startCall"
    ? "선택하면 복기 카드에 머물러요"
    : "실수 복습 · 오늘 강의 · 퀴즈";
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
    const nextLesson = nextPlayableLesson(goal);

    return {
      id: goal.id,
      title: goal.title,
      nextLabel: nextLesson ? `${nextLesson.index}과. ${nextLesson.title}` : "",
      isRoutine: !isPlanReviewDay && Boolean(routineGoalId) && goal.id === routineGoalId,
      isSelected: Boolean(selectedGoalId) && goal.id === selectedGoalId,
      disabledReason: nextLesson ? null : NO_NEXT_LESSON_REASON,
    };
  });

  return { options, reviewDaySelected };
}
