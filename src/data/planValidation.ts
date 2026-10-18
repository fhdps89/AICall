/**
 * Checks a plan change written by the AI coach before it is shown or applied.
 * The coach (LLM) returns free-form JSON; anything that does not fit the app's data shape is
 * dropped, so a bad value can never break the home screen's 「오늘 수업」 card.
 * Pure functions (no Firebase) so they can be unit-tested.
 */

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

const GOAL_STATUSES = ["active", "paused", "done"] as const;
type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface GoalShape {
  id: string;
  lessons: { index: number }[];
}

export interface SanitizedPlanSnapshot {
  plan?: { weeklyPattern?: Partial<Record<DayKey, string[]>>; minutesPerDay?: number };
  goals?: Record<string, { nextLessonIndex?: number; deadline?: string; status?: GoalStatus }>;
}

const MIN_MINUTES = 5;
const MAX_MINUTES = 240;

function isRealDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Keep only valid parts of a coach "after" snapshot:
 * - weeklyPattern days: arrays of known goal ids (a single id string is accepted as [id])
 * - minutesPerDay: whole number 5..240
 * - goal patches: known goals only; nextLessonIndex must be one of that goal's lessons,
 *   deadline a real YYYY-MM-DD date, status active | paused | done
 */
export function sanitizePlanChangeAfter(after: unknown, goals: GoalShape[]): SanitizedPlanSnapshot {
  const out: SanitizedPlanSnapshot = {};
  if (!after || typeof after !== "object") return out;
  const a = after as any;
  const goalIds = new Set(goals.map((g) => g.id));

  if (a.plan && typeof a.plan === "object") {
    const plan: NonNullable<SanitizedPlanSnapshot["plan"]> = {};
    const wp = a.plan.weeklyPattern;
    if (wp && typeof wp === "object") {
      const pattern: Partial<Record<DayKey, string[]>> = {};
      for (const day of DAY_KEYS) {
        if (!(day in wp)) continue;
        const raw = typeof wp[day] === "string" ? [wp[day]] : wp[day];
        if (!Array.isArray(raw)) continue;
        pattern[day] = Array.from(new Set(raw.filter((id: unknown) => typeof id === "string" && goalIds.has(id))));
      }
      if (Object.keys(pattern).length > 0) plan.weeklyPattern = pattern;
    }
    const mins = Number(a.plan.minutesPerDay);
    if (Number.isInteger(mins) && mins >= MIN_MINUTES && mins <= MAX_MINUTES) plan.minutesPerDay = mins;
    if (Object.keys(plan).length > 0) out.plan = plan;
  }

  if (a.goals && typeof a.goals === "object") {
    const patches: NonNullable<SanitizedPlanSnapshot["goals"]> = {};
    for (const [goalId, raw] of Object.entries(a.goals as Record<string, any>)) {
      const goal = goals.find((g) => g.id === goalId);
      if (!goal || !raw || typeof raw !== "object") continue;
      const patch: { nextLessonIndex?: number; deadline?: string; status?: GoalStatus } = {};
      const idx = Number(raw.nextLessonIndex);
      if (raw.nextLessonIndex !== undefined && goal.lessons.some((l) => l.index === idx)) patch.nextLessonIndex = idx;
      if (isRealDate(raw.deadline)) patch.deadline = raw.deadline;
      if (GOAL_STATUSES.includes(raw.status)) patch.status = raw.status;
      if (Object.keys(patch).length > 0) patches[goalId] = patch;
    }
    if (Object.keys(patches).length > 0) out.goals = patches;
  }
  return out;
}

/** True when nothing usable is left (the change would do nothing). */
export function isEmptyPlanChange(s: SanitizedPlanSnapshot): boolean {
  return !s.plan && !s.goals;
}
