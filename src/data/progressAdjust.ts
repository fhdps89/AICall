/**
 * Pure progress-adjustment rules shared by server (/api/coach/chat) and CoachModal.
 * Kept free of Firebase and DOM so plain node can load it directly.
 */
import type { DayKey } from "./planValidation.ts";

export type ProgressIntent = "postpone" | "pull_forward" | "set_lesson" | "undo";

export interface ProgressGoal {
  id: string;
  title?: string;
  nextLessonIndex: number;
  status?: "active" | "paused" | "done";
  lessons: { index: number }[];
}

export interface ProgressContext {
  goals: ProgressGoal[];
  weeklyPattern?: Partial<Record<DayKey, string[]>>;
  todayKst: string; // YYYY-MM-DD
  userText?: string;
}

export interface ProgressArgs {
  intent?: unknown;
  days?: unknown;
  goalId?: unknown;
  lessonIndex?: unknown;
}

export type GoalIdx = Record<string, { nextLessonIndex: number }>;

export type ProgressResult =
  | {
      type: "proposal";
      summary: string;
      reply: string;
      before: { goals: GoalIdx };
      after: { goals: GoalIdx };
    }
  | {
      type: "noop" | "clarify" | "invalid" | "undo_request";
      reply: string;
    };

export const DEFAULT_WEEKLY_PATTERN: Record<DayKey, string[]> = {
  mon: ["opic"],
  tue: ["philly"],
  wed: ["bluey"],
  thu: ["philly"],
  fri: ["travel"],
  sat: ["opic"],
  sun: [],
};

const SHORT_GOAL_NAMES: Record<string, string> = {
  opic: "OPIc",
  philly: "Philly",
  bluey: "Bluey",
  travel: "여행",
};

const WEEKDAY_KEYS_UTC: readonly DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const WEEKDAY_KO: Record<DayKey, string> = {
  mon: "월",
  tue: "화",
  wed: "수",
  thu: "목",
  fri: "금",
  sat: "토",
  sun: "일",
};

const CALENDAR_INVARIANT = "구글 캘린더 「영어 코치」 일정은 바뀌지 않습니다";

export function goalShortName(
  goalId: string,
  goals?: readonly { id: string; title?: string }[]
): string {
  if (Object.prototype.hasOwnProperty.call(SHORT_GOAL_NAMES, goalId)) {
    return SHORT_GOAL_NAMES[goalId];
  }
  const found = goals?.find((g) => g.id === goalId);
  return found?.title || goalId;
}

function parseYmd(d: string): { year: number; month: number; day: number } | null {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [year, month, day] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function kstTodayStr(nowMs: number = Date.now()): string {
  return new Date(nowMs + 9 * 3600000).toISOString().slice(0, 10);
}

export function kstWeekdayKey(d: string): DayKey {
  const parsed = parseYmd(d);
  if (!parsed) return "mon";
  const dow = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
  return WEEKDAY_KEYS_UTC[dow];
}

export function addDaysKst(d: string, n: number): string {
  const parsed = parseYmd(d);
  if (!parsed || !Number.isFinite(n)) return d;
  const dt = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + Math.trunc(n)));
  return dt.toISOString().slice(0, 10);
}

export function formatKstDay(d: string): string {
  const parsed = parseYmd(d);
  if (!parsed) return d;
  const key = kstWeekdayKey(d);
  return `${parsed.month}/${parsed.day}(${WEEKDAY_KO[key]})`;
}

export function nextLessonDate(
  pattern: Partial<Record<DayKey, string[]>> | undefined,
  goalId: string,
  todayKst: string,
  includeToday = true
): string | null {
  if (!parseYmd(todayKst)) return null;
  const effective = pattern ?? DEFAULT_WEEKLY_PATTERN;
  const startOffset = includeToday ? 0 : 1;
  for (let offset = startOffset; offset < startOffset + 14; offset++) {
    const candidate = addDaysKst(todayKst, offset);
    const key = kstWeekdayKey(candidate);
    const tracks = effective[key];
    if (Array.isArray(tracks) && tracks.includes(goalId)) {
      return candidate;
    }
  }
  return null;
}

export function lessonRange(goal: { lessons: { index: number }[] }): { first: number; last: number } {
  if (!Array.isArray(goal.lessons) || goal.lessons.length === 0) {
    return { first: 1, last: 1 };
  }
  let first = Infinity;
  let last = -Infinity;
  for (const lesson of goal.lessons) {
    if (typeof lesson?.index === "number" && Number.isFinite(lesson.index)) {
      if (lesson.index < first) first = lesson.index;
      if (lesson.index > last) last = lesson.index;
    }
  }
  if (!Number.isFinite(first) || !Number.isFinite(last)) {
    return { first: 1, last: 1 };
  }
  return { first, last };
}

function parseOptionalNumber(v: unknown): number {
  if (v === undefined || v === null || typeof v === "boolean") return NaN;
  if (typeof v === "string" && v.trim() === "") return NaN;
  return Number(v);
}

export function clampDays(v: unknown): number {
  const n = parseOptionalNumber(v);
  if (!Number.isFinite(n)) return 1;
  const floored = Math.floor(n);
  if (floored <= 0) return 1;
  if (floored > 7) return 7;
  return floored;
}

export function resolveTargetGoalIds(
  goalId: unknown,
  ctx: ProgressContext
): { ids: string[] } | { clarify: true } | { invalid: string } {
  const goals = Array.isArray(ctx.goals) ? ctx.goals : [];

  if (goalId !== undefined && goalId !== null && goalId !== "" && goalId !== "today") {
    if (typeof goalId !== "string") {
      return { invalid: "대상 목표를 알 수 없어요." };
    }
    if (goalId === "all") {
      const activeIds = goals
        .filter((g) => (g.status ?? "active") === "active")
        .map((g) => g.id);
      if (activeIds.length === 0) {
        return { invalid: "진행 중인 목표가 없어요." };
      }
      return { ids: activeIds };
    }
    const found = goals.find((g) => g.id === goalId);
    if (!found) {
      return { invalid: `알 수 없는 목표(${goalId})예요.` };
    }
    return { ids: [found.id] };
  }

  // Omitted or "today"
  const text = (ctx.userText || "").trim();
  if (/시험|오픽|opic/i.test(text) && goals.some((g) => g.id === "opic")) {
    return { ids: ["opic"] };
  }

  const pattern = ctx.weeklyPattern ?? DEFAULT_WEEKLY_PATTERN;
  const todayKey = kstWeekdayKey(ctx.todayKst);
  const todayTracks = Array.isArray(pattern[todayKey]) ? pattern[todayKey]! : [];
  for (const trackId of todayTracks) {
    if (goals.some((g) => g.id === trackId)) {
      return { ids: [trackId] };
    }
  }

  return { clarify: true };
}

function formatSkippedPhrase(from: number, to: number): string {
  const skipped: number[] = [];
  for (let i = from; i < to; i++) {
    skipped.push(i);
  }
  return `${skipped.join("·")}과는 건너뜁니다`;
}

function formatSkippedList(from: number, to: number): string {
  const skipped: number[] = [];
  for (let i = from; i < to; i++) {
    skipped.push(i);
  }
  return `${skipped.join("·")}과`;
}

export function describeProgressChange(
  before: { goals?: Record<string, { nextLessonIndex?: number }> } | null | undefined,
  after: { goals?: Record<string, { nextLessonIndex?: number }> } | null | undefined,
  ctx: {
    goals: readonly { id: string; title?: string; nextLessonIndex?: number }[];
    weeklyPattern?: Partial<Record<DayKey, string[]>>;
    todayKst: string;
  }
): string[] {
  const afterGoals = after?.goals;
  if (!afterGoals || typeof afterGoals !== "object") return [];

  const lines: string[] = [];
  let hasAny = false;

  for (const [goalId, patch] of Object.entries(afterGoals)) {
    if (!patch || typeof patch.nextLessonIndex !== "number") continue;
    hasAny = true;
    const to = patch.nextLessonIndex;
    const from =
      before?.goals?.[goalId]?.nextLessonIndex ??
      ctx.goals.find((g) => g.id === goalId)?.nextLessonIndex;
    const name = goalShortName(goalId, ctx.goals);

    lines.push(typeof from === "number" ? `${name} ${from}과 → ${to}과` : `${name} ${to}과`);

    if (typeof from === "number") {
      if (to > from) {
        lines.push(formatSkippedPhrase(from, to));
      } else if (to < from) {
        lines.push(`${to}과로 돌아갑니다`);
      }
    }

    const nextDate = nextLessonDate(ctx.weeklyPattern, goalId, ctx.todayKst, true);
    lines.push(
      nextDate
        ? `다음 ${name} 수업: ${formatKstDay(nextDate)} 23:00부터 ${to}과`
        : `다음 ${name} 수업부터 ${to}과`
    );
  }

  if (hasAny) {
    lines.push("통화를 마치면 지금처럼 1과씩 올라갑니다");
    lines.push(CALENDAR_INVARIANT);
  }

  return lines;
}

function buildPostponeResult(args: ProgressArgs, ctx: ProgressContext): ProgressResult {
  const resolved = resolveTargetGoalIds(args.goalId, ctx);
  if ("invalid" in resolved) {
    return { type: "invalid", reply: resolved.invalid };
  }

  if ("clarify" in resolved) {
    const activeGoals = ctx.goals.filter((g) => (g.status ?? "active") === "active");
    const upcoming: string[] = [];
    for (const goal of activeGoals) {
      const nextDate = nextLessonDate(ctx.weeklyPattern, goal.id, ctx.todayKst, true);
      if (nextDate) {
        upcoming.push(
          `${formatKstDay(nextDate)} 23:00 ${goalShortName(goal.id, ctx.goals)} ${goal.nextLessonIndex}과`
        );
      }
    }
    const schedulePart =
      upcoming.length > 0 ? ` 다음 수업: ${upcoming.join(", ")}.` : "";
    return {
      type: "noop",
      reply: `오늘(${formatKstDay(ctx.todayKst)})은 주간 복기 날이라 정해진 진도 수업이 없어요. 진도는 통화를 끝낼 때만 1과 올라가니 그대로 둘게요.${schedulePart} ${CALENDAR_INVARIANT}.`,
    };
  }

  const items: string[] = [];
  for (const id of resolved.ids) {
    const goal = ctx.goals.find((g) => g.id === id);
    if (!goal) continue;
    const name = goalShortName(id, ctx.goals);
    const nextDate = nextLessonDate(ctx.weeklyPattern, id, ctx.todayKst, false);
    const nextStr = nextDate ? `${formatKstDay(nextDate)} 23:00` : "다음 배정 요일";
    items.push(`${name} ${goal.nextLessonIndex}과 그대로(다음 수업: ${nextStr})`);
  }

  return {
    type: "noop",
    reply: `${items.join(", ")}으로 유지할게요. 진도는 통화를 끝낼 때만 1과 올라가니 오늘 못 하셔도 다음 수업에서 그대로 이어집니다. ${CALENDAR_INVARIANT}.`,
  };
}

function buildPullForwardResult(args: ProgressArgs, ctx: ProgressContext): ProgressResult {
  const resolved = resolveTargetGoalIds(args.goalId, ctx);
  if ("invalid" in resolved) {
    return { type: "invalid", reply: resolved.invalid };
  }
  if ("clarify" in resolved) {
    const options = ctx.goals
      .filter((g) => (g.status ?? "active") === "active")
      .map((g) => `${goalShortName(g.id, ctx.goals)}(${g.nextLessonIndex}과)`)
      .join("·");
    return {
      type: "clarify",
      reply: `오늘은 복기 날이라 어떤 걸 앞당길지 골라 주세요: ${options}·전부`,
    };
  }

  const rawDays = parseOptionalNumber(args.days);
  const clampedOver7 = Number.isFinite(rawDays) && Math.floor(rawDays) > 7;
  const days = clampDays(args.days);

  const beforeGoals: GoalIdx = {};
  const afterGoals: GoalIdx = {};
  const changedGoals: { goal: ProgressGoal; from: number; to: number }[] = [];

  for (const id of resolved.ids) {
    const goal = ctx.goals.find((g) => g.id === id);
    if (!goal) continue;
    const { last } = lessonRange(goal);
    const cur = goal.nextLessonIndex;
    if (cur >= last) continue;
    const target = Math.min(cur + days, last);
    if (target <= cur) continue;
    beforeGoals[id] = { nextLessonIndex: cur };
    afterGoals[id] = { nextLessonIndex: target };
    changedGoals.push({ goal, from: cur, to: target });
  }

  if (changedGoals.length === 0) {
    if (resolved.ids.length === 1) {
      const goal = ctx.goals.find((g) => g.id === resolved.ids[0]);
      const name = goal ? goalShortName(goal.id, ctx.goals) : resolved.ids[0];
      return {
        type: "noop",
        reply: `${name}는 이미 마지막 과예요. 더 앞당길 과가 없습니다.`,
      };
    }
    return {
      type: "noop",
      reply: "모든 목표가 이미 마지막 과예요. 더 앞당길 과가 없습니다.",
    };
  }

  const paceNote = `이번에는 한 번에 ${days}과 앞당깁니다. 매 통화마다 ${days}과씩 나가기는 아직 없습니다`;
  const clampNote = clampedOver7
    ? " (한 번에 최대 7과까지만 앞당길 수 있어 7과로 맞췄어요)"
    : "";

  if (changedGoals.length === 1) {
    const { goal, from, to } = changedGoals[0];
    const name = goalShortName(goal.id, ctx.goals);
    const nextDate = nextLessonDate(ctx.weeklyPattern, goal.id, ctx.todayKst, true);
    const nextStr = nextDate ? `${formatKstDay(nextDate)} 23:00` : "다음";
    const skipped = formatSkippedList(from, to);
    const summary = `${name} ${from}과 → ${to}과 (${paceNote})`;
    const reply =
      `${name}을 ${from}과에서 ${to}과로 한 번에 앞당기는 안을 준비했어요. ` +
      `${skipped}는 건너뛰고 ${nextStr} 수업부터 ${to}과를 해요. ` +
      `${paceNote}.${clampNote} ${CALENDAR_INVARIANT}. 카드에서 [승인]하거나 '응'이라고 답해 주세요.`;

    return {
      type: "proposal",
      summary,
      reply,
      before: { goals: beforeGoals },
      after: { goals: afterGoals },
    };
  }

  const parts = changedGoals.map(
    ({ goal, from, to }) => `${goalShortName(goal.id, ctx.goals)} ${from}과 → ${to}과`
  );
  const summary = `${parts.join(", ")} (${paceNote})`;
  const reply =
    `진행 중인 목표를 한 번에 앞당기는 안을 준비했어요(${parts.join(", ")}). ` +
    `${paceNote}.${clampNote} ${CALENDAR_INVARIANT}. 카드에서 [승인]하거나 '응'이라고 답해 주세요.`;

  return {
    type: "proposal",
    summary,
    reply,
    before: { goals: beforeGoals },
    after: { goals: afterGoals },
  };
}

function buildSetLessonResult(args: ProgressArgs, ctx: ProgressContext): ProgressResult {
  const resolved = resolveTargetGoalIds(args.goalId, ctx);
  if ("invalid" in resolved) {
    return { type: "invalid", reply: resolved.invalid };
  }
  if ("clarify" in resolved) {
    const options = ctx.goals
      .filter((g) => (g.status ?? "active") === "active")
      .map((g) => `${goalShortName(g.id, ctx.goals)}(${g.nextLessonIndex}과)`)
      .join("·");
    return {
      type: "clarify",
      reply: `오늘은 복기 날이라 어떤 목표의 진도를 바꿀지 골라 주세요: ${options}`,
    };
  }

  const rawIdx = parseOptionalNumber(args.lessonIndex);
  const isInt = Number.isInteger(rawIdx);

  const firstGoal = ctx.goals.find((g) => g.id === resolved.ids[0]);
  if (!isInt && firstGoal) {
    const { first, last } = lessonRange(firstGoal);
    const name = goalShortName(firstGoal.id, ctx.goals);
    return {
      type: "invalid",
      reply: `${name}는 ${first}~${last}과까지 있어요. 정수 과 번호를 알려 주세요.`,
    };
  }
  if (!isInt) {
    return { type: "invalid", reply: "이동할 과 번호를 정수로 알려 주세요." };
  }

  const idx = rawIdx;
  const beforeGoals: GoalIdx = {};
  const afterGoals: GoalIdx = {};
  const changedGoals: { goal: ProgressGoal; from: number; to: number }[] = [];

  for (const id of resolved.ids) {
    const goal = ctx.goals.find((g) => g.id === id);
    if (!goal) continue;
    if (!goal.lessons.some((l) => l.index === idx)) {
      const { first, last } = lessonRange(goal);
      const name = goalShortName(goal.id, ctx.goals);
      return {
        type: "invalid",
        reply: `${name}는 ${first}~${last}과까지 있어요.`,
      };
    }
    if (goal.nextLessonIndex !== idx) {
      beforeGoals[id] = { nextLessonIndex: goal.nextLessonIndex };
      afterGoals[id] = { nextLessonIndex: idx };
      changedGoals.push({ goal, from: goal.nextLessonIndex, to: idx });
    }
  }

  if (changedGoals.length === 0) {
    const name = firstGoal ? goalShortName(firstGoal.id, ctx.goals) : "해당 목표";
    return {
      type: "noop",
      reply: `${name}는 이미 ${idx}과예요. 바꾸지 않고 그대로 둘게요.`,
    };
  }

  if (changedGoals.length === 1) {
    const { goal, from, to } = changedGoals[0];
    const name = goalShortName(goal.id, ctx.goals);
    const nextDate = nextLessonDate(ctx.weeklyPattern, goal.id, ctx.todayKst, true);
    const nextStr = nextDate ? `${formatKstDay(nextDate)} 23:00` : "다음";
    const direction =
      to > from ? `${formatSkippedPhrase(from, to)}.` : `${to}과로 돌아갑니다.`;

    return {
      type: "proposal",
      summary: `${name} ${from}과 → ${to}과`,
      reply:
        `${name}을 ${from}과에서 ${to}과로 바꾸는 안을 준비했어요. ${direction} ` +
        `다음 ${name} 수업은 ${nextStr}부터 ${to}과예요. ${CALENDAR_INVARIANT}. ` +
        `카드에서 [승인]하거나 '응'이라고 답해 주세요.`,
      before: { goals: beforeGoals },
      after: { goals: afterGoals },
    };
  }

  const parts = changedGoals.map(
    ({ goal, from, to }) => `${goalShortName(goal.id, ctx.goals)} ${from}과 → ${to}과`
  );
  return {
    type: "proposal",
    summary: parts.join(", "),
    reply: `진도 변경 안을 준비했어요(${parts.join(", ")}). ${CALENDAR_INVARIANT}. 카드에서 [승인]하거나 '응'이라고 답해 주세요.`,
    before: { goals: beforeGoals },
    after: { goals: afterGoals },
  };
}

export function buildProgressProposal(args: ProgressArgs, ctx: ProgressContext): ProgressResult {
  const intent = args?.intent;
  if (intent === "undo") {
    return {
      type: "undo_request",
      reply: "방금 바꾼 진도를 되돌릴까요? 아래에서 확인해 주세요.",
    };
  }
  if (intent === "postpone") {
    return buildPostponeResult(args, ctx);
  }
  if (intent === "pull_forward") {
    return buildPullForwardResult(args, ctx);
  }
  if (intent === "set_lesson") {
    return buildSetLessonResult(args, ctx);
  }
  return {
    type: "invalid",
    reply: "지원하지 않는 진도 조정 요청이에요. 미루기, 앞당기기, 특정 과 지정, 되돌리기만 도와드릴 수 있어요.",
  };
}

export function isProgressChange(after: unknown): boolean {
  if (!after || typeof after !== "object") return false;
  const goals = (after as { goals?: unknown }).goals;
  if (!goals || typeof goals !== "object") return false;
  return Object.values(goals as Record<string, unknown>).some(
    (g) =>
      Boolean(
        g &&
          typeof g === "object" &&
          typeof (g as { nextLessonIndex?: unknown }).nextLessonIndex === "number"
      )
  );
}

export function isStaleProgressChange(
  change: {
    before?: { goals?: Record<string, { nextLessonIndex?: number }> };
    after?: { goals?: Record<string, { nextLessonIndex?: number }> };
  },
  liveGoals: readonly { id: string; nextLessonIndex: number }[]
): boolean {
  const afterGoals = change?.after?.goals;
  if (!afterGoals || typeof afterGoals !== "object") return false;

  for (const [goalId, afterPatch] of Object.entries(afterGoals)) {
    if (!afterPatch || typeof afterPatch.nextLessonIndex !== "number") continue;
    const beforeIdx = change.before?.goals?.[goalId]?.nextLessonIndex;
    if (typeof beforeIdx !== "number") continue;
    const live = liveGoals.find((g) => g.id === goalId);
    if (!live || live.nextLessonIndex !== beforeIdx) {
      return true;
    }
  }
  return false;
}

export interface UndoCandidateChange {
  id: string;
  status: string;
  at: string;
  appliedAt?: string;
  before?: { plan?: unknown; goals?: Record<string, { nextLessonIndex?: number } | undefined> };
  after?: { plan?: unknown; goals?: Record<string, { nextLessonIndex?: number } | undefined> };
}

export type PickUndoResult =
  | {
      ok: true;
      changeId: string;
      restore: Record<string, { from: number; to: number }>;
    }
  | {
      ok: false;
      reason: "none" | "moved";
      reply: string;
    };

export function pickUndoTarget(
  changes: readonly UndoCandidateChange[],
  liveGoals: readonly { id: string; nextLessonIndex: number }[]
): PickUndoResult {
  const candidates = changes.filter(
    (c) => c.status === "approved" && isProgressChange(c.after)
  );

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "none",
      reply: "되돌릴 진도 조정이 없어요",
    };
  }

  let latest = candidates[0];
  let latestTs = latest.appliedAt ?? latest.at;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const ts = c.appliedAt ?? c.at;
    const cMs = Date.parse(ts);
    const lMs = Date.parse(latestTs);
    const isLater =
      Number.isFinite(cMs) && Number.isFinite(lMs) ? cMs > lMs : ts > latestTs;
    if (isLater) {
      latest = c;
      latestTs = ts;
    }
  }

  const restore: Record<string, { from: number; to: number }> = {};
  const afterGoals = latest.after?.goals || {};
  for (const [goalId, afterPatch] of Object.entries(afterGoals)) {
    if (!afterPatch || typeof afterPatch.nextLessonIndex !== "number") continue;
    const live = liveGoals.find((g) => g.id === goalId);
    if (!live || live.nextLessonIndex !== afterPatch.nextLessonIndex) {
      return {
        ok: false,
        reason: "moved",
        reply: "그 뒤로 수업을 하셔서 되돌리면 진도가 뒤로 가요. 진도 바꾸기로 직접 지정해 주세요",
      };
    }
    const beforeIdx = latest.before?.goals?.[goalId]?.nextLessonIndex;
    if (typeof beforeIdx === "number") {
      restore[goalId] = { from: afterPatch.nextLessonIndex, to: beforeIdx };
    }
  }

  if (Object.keys(restore).length === 0) {
    return {
      ok: false,
      reason: "none",
      reply: "되돌릴 진도 조정이 없어요",
    };
  }

  return {
    ok: true,
    changeId: latest.id,
    restore,
  };
}

const APPROVE_REPLIES = new Set([
  "응",
  "네",
  "예",
  "ㅇㅇ",
  "좋아",
  "그래",
  "승인",
  "적용해줘",
  "오케이",
  "ok",
]);

const REJECT_REPLIES = new Set(["아니", "아니요", "ㄴㄴ", "거절", "싫어"]);

const CANCEL_REPLIES = new Set(["취소", "취소해줘"]);

const UNDO_REPLIES = new Set(["되돌려", "되돌려줘", "원래대로", "방금 거 되돌려줘"]);

export function classifyQuickReply(
  text: string,
  opts: { hasPending: boolean }
): "approve" | "reject" | "undo" | null {
  if (typeof text !== "string") return null;
  const normalized = text
    .trim()
    .replace(/[\s\p{P}\p{S}\uFE0F\u200D]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!normalized) return null;

  if (APPROVE_REPLIES.has(normalized)) {
    return opts.hasPending ? "approve" : null;
  }
  if (REJECT_REPLIES.has(normalized)) {
    return opts.hasPending ? "reject" : null;
  }
  if (CANCEL_REPLIES.has(normalized)) {
    return opts.hasPending ? "reject" : "undo";
  }
  if (UNDO_REPLIES.has(normalized)) {
    return "undo";
  }
  return null;
}

export function qaBlocksPlanChange(after: unknown, qa: boolean): boolean {
  return Boolean(qa) && isProgressChange(after);
}

export function shouldPersistProposedChange(after: unknown, qa: boolean): boolean {
  return !qaBlocksPlanChange(after, qa);
}

export type CoachProgressChatOut = {
  reply: string;
  proposal: {
    summary: string;
    before: unknown;
    after: unknown;
    memoryPatch?: unknown;
    status: "proposed";
  } | null;
  progress?: { type: "undo_request" };
};

/** Builds the /api/coach/chat progress fields after the pure proposal + sanitize step. */
export function finalizeCoachProgressResponse(opts: {
  progressResult: ProgressResult;
  sanitizedAfter: { plan?: unknown; goals?: unknown };
  isEmptyAfter: boolean;
  existingMemoryPatch?: unknown;
  existingSummary?: string;
}): CoachProgressChatOut {
  const memoryPatch = opts.existingMemoryPatch;
  const memoryProposal = memoryPatch
    ? {
        summary: opts.existingSummary || "코치 메모",
        before: {},
        after: {},
        memoryPatch,
        status: "proposed" as const,
      }
    : null;

  if (opts.progressResult.type === "proposal") {
    if (opts.isEmptyAfter) {
      return {
        reply: "진도 변경 내용을 적용할 수 없어요. 과 번호를 다시 확인해 주세요.",
        proposal: memoryProposal,
      };
    }
    return {
      reply: opts.progressResult.reply,
      proposal: {
        summary: opts.progressResult.summary,
        before: opts.progressResult.before,
        after: opts.sanitizedAfter,
        memoryPatch,
        status: "proposed",
      },
    };
  }

  const out: CoachProgressChatOut = {
    reply: opts.progressResult.reply,
    proposal: memoryProposal,
  };
  if (opts.progressResult.type === "undo_request") {
    out.progress = { type: "undo_request" };
  }
  return out;
}
