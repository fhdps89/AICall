/**
 * Pure progress-adjustment rules shared by server (/api/coach/chat) and CoachModal.
 * Kept free of Firebase and DOM so plain node can load it directly.
 */
import {
  MIN_LESSONS_PER_CALL,
  MAX_LESSONS_PER_CALL,
  normalizeLessonsPerCall,
  type DayKey,
} from "./planValidation.ts";
import { paceTarget, lastLessonIndex } from "./lessonPace.ts";

export type ProgressIntent = "postpone" | "pull_forward" | "set_lesson" | "set_pace" | "undo";

export interface ProgressGoal {
  id: string;
  title?: string;
  nextLessonIndex: number;
  lessonsPerCall?: number;
  status?: "active" | "paused" | "done";
  lessons: { index: number }[];
}

export interface ProgressContext {
  goals: ProgressGoal[];
  weeklyPattern?: Partial<Record<DayKey, string[]>>;
  todayKst: string; // YYYY-MM-DD
  userText?: string;
  todayGoalId?: string;
}

export interface ProgressArgs {
  intent?: unknown;
  days?: unknown;
  goalId?: unknown;
  lessonIndex?: unknown;
}

export type GoalProgressPatch = {
  nextLessonIndex?: number;
  lessonsPerCall?: number;
};

export type GoalIdx = Record<string, GoalProgressPatch>;

export interface PostponeInfoItem {
  goalId: string;
  name: string;
  lessonIndex: number;
  nextDate: string | null;
}

export interface PostponeInfo {
  reviewDay: boolean;
  items: PostponeInfoItem[];
}

export interface CoachInfoCard {
  kind: "postpone";
  title: string;
  lines: string[];
}

export type ProgressResult =
  | {
      type: "proposal";
      summary: string;
      reply: string;
      before: { goals: GoalIdx };
      after: { goals: GoalIdx };
    }
  | {
      type: "info";
      reply: string;
      info: PostponeInfo;
    }
  | {
      type: "noop" | "clarify" | "invalid" | "undo_request";
      reply: string;
    };

export type TargetResolutionVia =
  | "explicit"
  | "all"
  | "text"
  | "today_override"
  | "pattern";

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
export const APPROVE_HINT = "카드에서 [승인]하거나 '응'이라고 답해 주세요.";
export const QA_PREVIEW_HINT = "QA 미리보기라 실제 진도에는 반영하지 않아요.";

const BACK_RE = /미뤄|미루|늦춰|연기/;
const RESET_RE = /원래\s*(속도|페이스)|(하루|1과|한\s*과)씩으로/;
const ONCE_RE = /한\s*번만|이번만|한\s*번에|점프|건너뛰/;
const PACE_RE = /씩|매\s*(통화|번|수업)|앞으로\s*계속|속도|페이스/;
const AMOUNT_RE = /(하루|이틀|사흘|나흘)\s*치|\d+\s*일\s*치/;

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

/** Accepts a client-provided todayGoalId only when it is a non-empty <=64-char known goal id. */
export function sanitizeTodayGoalId(raw: unknown, goalIds: readonly string[]): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) return undefined;
  return goalIds.includes(raw) ? raw : undefined;
}

/** Extracts a Korean or numeric lesson/day count from user text, or null if absent. */
export function parseDayCount(text?: string): number | null {
  if (typeof text !== "string" || !text.trim()) return null;
  if (/나흘|네\s*(?:과|개|일)/.test(text)) return 4;
  if (/사흘|세\s*(?:과|개|일)/.test(text)) return 3;
  if (/이틀|두\s*(?:과|개|일)/.test(text)) return 2;
  if (/하루|한\s*(?:과|개|일)/.test(text)) return 1;
  const unitMatch = text.match(/(\d+)\s*(?:과|일\s*치|개|씩)/);
  if (unitMatch) return Number(unitMatch[1]);
  const dayMatch = text.match(/(?:^|[^월\d]\s*)(\d+)\s*일/);
  if (dayMatch) return Number(dayMatch[1]);
  return null;
}

/** Reconciles LLM-chosen pull_forward/set_pace intents against unambiguous Korean cues in userText. */
export function reconcileProgressIntent(
  intent: unknown,
  userText?: string
): { intent: unknown; ambiguousPace?: true; forceDays?: number } {
  if (typeof userText !== "string" || !userText.trim()) {
    return { intent };
  }
  if (intent !== "pull_forward" && intent !== "set_pace") {
    return { intent };
  }
  if (BACK_RE.test(userText)) {
    return { intent: "postpone" };
  }
  if (RESET_RE.test(userText)) {
    return { intent: "set_pace", forceDays: 1 };
  }
  if (ONCE_RE.test(userText)) {
    return { intent: "pull_forward" };
  }
  if (PACE_RE.test(userText)) {
    return { intent: "set_pace" };
  }
  if (AMOUNT_RE.test(userText)) {
    return { intent, ambiguousPace: true };
  }
  return { intent };
}

export function resolveTargetGoalIds(
  goalId: unknown,
  ctx: ProgressContext
): { ids: string[]; via: TargetResolutionVia } | { clarify: true } | { invalid: string } {
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
      return { ids: activeIds, via: "all" };
    }
    const found = goals.find((g) => g.id === goalId);
    if (!found) {
      return { invalid: `알 수 없는 목표(${goalId})예요.` };
    }
    return { ids: [found.id], via: "explicit" };
  }

  // Omitted or "today"
  const text = (ctx.userText || "").trim();
  if (/시험|오픽|opic/i.test(text) && goals.some((g) => g.id === "opic")) {
    return { ids: ["opic"], via: "text" };
  }

  const validTodayId = sanitizeTodayGoalId(
    ctx.todayGoalId,
    goals.map((g) => g.id)
  );
  if (validTodayId) {
    return { ids: [validTodayId], via: "today_override" };
  }

  const pattern = ctx.weeklyPattern ?? DEFAULT_WEEKLY_PATTERN;
  const todayKey = kstWeekdayKey(ctx.todayKst);
  const todayTracks = Array.isArray(pattern[todayKey]) ? pattern[todayKey]! : [];
  for (const trackId of todayTracks) {
    if (goals.some((g) => g.id === trackId)) {
      return { ids: [trackId], via: "pattern" };
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

function buildPaceSentences(opts: {
  name: string;
  cur?: number;
  oldPace: number;
  newPace: number;
  last: number | null;
}): string[] {
  const lines: string[] = [];
  if (opts.newPace > 1) {
    lines.push(`앞으로 매 통화마다 ${opts.name}은 ${opts.newPace}과씩 올라갑니다`);
    if (typeof opts.cur === "number") {
      const nextAfter = paceTarget(opts.cur, opts.newPace, opts.last);
      lines.push(`지금은 ${opts.cur}과 그대로이고, ${opts.cur}과를 마치면 다음은 ${nextAfter}과입니다`);
      if (nextAfter > opts.cur + 1) {
        lines.push(`건너뛰는 ${formatSkippedList(opts.cur + 1, nextAfter)}는 진도에서 완료로 봅니다`);
      }
    }
    if (opts.last !== null) {
      lines.push(`마지막 ${opts.last}과는 건너뛰지 않습니다`);
    }
  } else {
    lines.push(
      `앞으로는 통화를 마칠 때마다 ${opts.name}이 1과씩 올라갑니다(지금은 매 통화 ${opts.oldPace}과씩)`
    );
    if (typeof opts.cur === "number") {
      lines.push(`지금은 ${opts.cur}과 그대로입니다`);
    }
  }
  return lines;
}

export function describeProgressChange(
  before: { goals?: Record<string, GoalProgressPatch | undefined> } | null | undefined,
  after: { goals?: Record<string, GoalProgressPatch | undefined> } | null | undefined,
  ctx: {
    goals: readonly {
      id: string;
      title?: string;
      nextLessonIndex?: number;
      lessonsPerCall?: number;
      lessons?: { index: number }[];
    }[];
    weeklyPattern?: Partial<Record<DayKey, string[]>>;
    todayKst: string;
  }
): string[] {
  const afterGoals = after?.goals;
  if (!afterGoals || typeof afterGoals !== "object") return [];

  const lines: string[] = [];
  let hasNextChange = false;
  let hasPaceChange = false;
  const nextPaces = new Set<number>();

  for (const [goalId, patch] of Object.entries(afterGoals)) {
    if (!patch || typeof patch !== "object") continue;
    const goal = ctx.goals.find((g) => g.id === goalId);
    const name = goalShortName(goalId, ctx.goals);

    if (typeof patch.nextLessonIndex === "number") {
      hasNextChange = true;
      const to = patch.nextLessonIndex;
      const from = before?.goals?.[goalId]?.nextLessonIndex ?? goal?.nextLessonIndex;
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
      nextPaces.add(normalizeLessonsPerCall(goal?.lessonsPerCall));
    }

    if (typeof patch.lessonsPerCall === "number") {
      hasPaceChange = true;
      const oldPace = normalizeLessonsPerCall(
        before?.goals?.[goalId]?.lessonsPerCall ?? goal?.lessonsPerCall
      );
      const last = goal?.lessons ? lastLessonIndex(goal.lessons) : null;
      lines.push(
        ...buildPaceSentences({
          name,
          cur: goal?.nextLessonIndex,
          oldPace,
          newPace: patch.lessonsPerCall,
          last,
        })
      );
    }
  }

  if (hasNextChange) {
    if (nextPaces.size === 1) {
      const pace = [...nextPaces][0];
      lines.push(`통화를 마치면 지금처럼 ${pace}과씩 올라갑니다`);
    } else {
      lines.push("통화를 마치면 지금처럼 각 트랙 속도대로 올라갑니다");
    }
  }
  if (hasNextChange || hasPaceChange) {
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
    const infoItems: PostponeInfoItem[] = [];
    for (const goal of activeGoals) {
      const name = goalShortName(goal.id, ctx.goals);
      const nextDate = nextLessonDate(ctx.weeklyPattern, goal.id, ctx.todayKst, true);
      infoItems.push({
        goalId: goal.id,
        name,
        lessonIndex: goal.nextLessonIndex,
        nextDate,
      });
      if (nextDate) {
        upcoming.push(
          `${formatKstDay(nextDate)} 23:00 ${name} ${goal.nextLessonIndex}과`
        );
      }
    }
    const schedulePart = upcoming.length > 0 ? ` 다음 수업: ${upcoming.join(", ")}.` : "";
    return {
      type: "info",
      reply: `오늘(${formatKstDay(ctx.todayKst)})은 주간 복기 날이라 정해진 진도 수업이 없어요. 진도는 통화를 마칠 때만 올라가니 그대로 둘게요.${schedulePart} ${CALENDAR_INVARIANT}.`,
      info: { reviewDay: true, items: infoItems },
    };
  }

  if (resolved.via === "today_override" && resolved.ids.length === 1) {
    const goal = ctx.goals.find((g) => g.id === resolved.ids[0]);
    if (goal) {
      const name = goalShortName(goal.id, ctx.goals);
      const nextDate = nextLessonDate(ctx.weeklyPattern, goal.id, ctx.todayKst, false);
      const nextStr = nextDate ? `${formatKstDay(nextDate)} 23:00` : "다음 배정 요일";
      return {
        type: "info",
        reply: `오늘 고르신 ${name} ${goal.nextLessonIndex}과 그대로 둘게요. 다음 ${name} 수업: ${nextStr}. 진도는 통화를 마칠 때만 올라가니 오늘 못 하셔도 다음 수업에서 그대로 이어집니다. ${CALENDAR_INVARIANT}.`,
        info: {
          reviewDay: false,
          items: [
            {
              goalId: goal.id,
              name,
              lessonIndex: goal.nextLessonIndex,
              nextDate,
            },
          ],
        },
      };
    }
  }

  const items: string[] = [];
  const infoItems: PostponeInfoItem[] = [];
  for (const id of resolved.ids) {
    const goal = ctx.goals.find((g) => g.id === id);
    if (!goal) continue;
    const name = goalShortName(id, ctx.goals);
    const nextDate = nextLessonDate(ctx.weeklyPattern, id, ctx.todayKst, false);
    const nextStr = nextDate ? `${formatKstDay(nextDate)} 23:00` : "다음 배정 요일";
    items.push(`${name} ${goal.nextLessonIndex}과 그대로(다음 수업: ${nextStr})`);
    infoItems.push({
      goalId: id,
      name,
      lessonIndex: goal.nextLessonIndex,
      nextDate,
    });
  }

  return {
    type: "info",
    reply: `${items.join(", ")}으로 유지할게요. 진도는 통화를 마칠 때만 올라가니 오늘 못 하셔도 다음 수업에서 그대로 이어집니다. ${CALENDAR_INVARIANT}.`,
    info: { reviewDay: false, items: infoItems },
  };
}

function buildTargetClarify(ctx: ProgressContext, actionVerb: string): ProgressResult {
  const options = ctx.goals
    .filter((g) => (g.status ?? "active") === "active")
    .map((g) => `${goalShortName(g.id, ctx.goals)}(${g.nextLessonIndex}과)`)
    .join("·");
  return {
    type: "clarify",
    reply: `오늘은 복기 날이라 어떤 걸 ${actionVerb}지 골라 주세요: ${options}·전부`,
  };
}

function buildAmbiguousPaceClarify(args: ProgressArgs, ctx: ProgressContext): ProgressResult {
  const resolved = resolveTargetGoalIds(args.goalId, ctx);
  if ("invalid" in resolved) {
    return { type: "invalid", reply: resolved.invalid };
  }
  if ("clarify" in resolved) {
    return buildTargetClarify(ctx, "앞당길");
  }

  const label = resolved.ids.length === 1 ? goalShortName(resolved.ids[0], ctx.goals) : "전부";
  const parsedArgs = parseOptionalNumber(args.days);
  const count =
    Number.isInteger(parsedArgs) && parsedArgs > 0
      ? parsedArgs
      : (parseDayCount(ctx.userText) ?? 2);
  const paceCount = Math.min(Math.max(count, MIN_LESSONS_PER_CALL), MAX_LESSONS_PER_CALL);
  return {
    type: "clarify",
    reply: `「${label} 한 번만 ${count}과 점프」인지 「${label} 앞으로 매 통화 ${paceCount}과씩」인지 알려 주세요.`,
  };
}

function buildPullForwardResult(args: ProgressArgs, ctx: ProgressContext): ProgressResult {
  const resolved = resolveTargetGoalIds(args.goalId, ctx);
  if ("invalid" in resolved) {
    return { type: "invalid", reply: resolved.invalid };
  }
  if ("clarify" in resolved) {
    return buildTargetClarify(ctx, "앞당길");
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

  const paces = Array.from(
    new Set(changedGoals.map((c) => normalizeLessonsPerCall(c.goal.lessonsPerCall)))
  );
  const paceTail =
    paces.length === 1
      ? `그 뒤로는 지금처럼 통화를 마칠 때마다 ${paces[0]}과씩 올라갑니다`
      : "그 뒤로는 지금처럼 통화를 마칠 때마다 트랙별 설정 속도대로 올라갑니다";
  const paceNote = `이번 한 번만 ${days}과 앞당깁니다. ${paceTail}`;
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
      `${paceNote}.${clampNote} ${CALENDAR_INVARIANT}. ${APPROVE_HINT}`;

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
    `${paceNote}.${clampNote} ${CALENDAR_INVARIANT}. ${APPROVE_HINT}`;

  return {
    type: "proposal",
    summary,
    reply,
    before: { goals: beforeGoals },
    after: { goals: afterGoals },
  };
}

function buildSetPaceResult(
  args: ProgressArgs,
  ctx: ProgressContext,
  forceDays?: number
): ProgressResult {
  const resolved = resolveTargetGoalIds(args.goalId, ctx);
  if ("invalid" in resolved) {
    return { type: "invalid", reply: resolved.invalid };
  }
  if ("clarify" in resolved) {
    return buildTargetClarify(ctx, "바꿀");
  }

  let rawDays: number | null = null;
  if (typeof forceDays === "number" && Number.isInteger(forceDays)) {
    rawDays = forceDays;
  } else {
    const argN = parseOptionalNumber(args.days);
    if (Number.isInteger(argN)) {
      rawDays = argN;
    } else {
      rawDays = parseDayCount(ctx.userText);
    }
  }

  if (rawDays === null) {
    return {
      type: "clarify",
      reply: "매 통화 몇 과씩 올릴까요? 1~3과 중에서 골라 주세요.",
    };
  }

  const clampedOver3 = rawDays > MAX_LESSONS_PER_CALL;
  const newPace = Math.min(Math.max(rawDays, MIN_LESSONS_PER_CALL), MAX_LESSONS_PER_CALL);

  const beforeGoals: GoalIdx = {};
  const afterGoals: GoalIdx = {};
  const changedGoals: { goal: ProgressGoal; oldPace: number }[] = [];

  for (const id of resolved.ids) {
    const goal = ctx.goals.find((g) => g.id === id);
    if (!goal) continue;
    const curPace = normalizeLessonsPerCall(goal.lessonsPerCall);
    if (curPace === newPace) continue;
    beforeGoals[id] = { lessonsPerCall: curPace };
    afterGoals[id] = { lessonsPerCall: newPace };
    changedGoals.push({ goal, oldPace: curPace });
  }

  if (changedGoals.length === 0) {
    if (resolved.ids.length === 1) {
      const goal = ctx.goals.find((g) => g.id === resolved.ids[0]);
      const name = goal ? goalShortName(goal.id, ctx.goals) : resolved.ids[0];
      return {
        type: "noop",
        reply: `${name}은 이미 매 통화 ${newPace}과씩이에요.`,
      };
    }
    return {
      type: "noop",
      reply: `모든 목표가 이미 매 통화 ${newPace}과씩이에요.`,
    };
  }

  const clampNote = clampedOver3
    ? ` (매 통화 최대 3과까지라 3과씩으로 맞췄어요)`
    : "";

  if (changedGoals.length === 1) {
    const { goal, oldPace } = changedGoals[0];
    const name = goalShortName(goal.id, ctx.goals);
    const sentences = buildPaceSentences({
      name,
      cur: goal.nextLessonIndex,
      oldPace,
      newPace,
      last: lastLessonIndex(goal.lessons),
    });
    const summary = `${name} 매 통화 ${oldPace}과씩 → ${newPace}과씩`;
    const reply = `${sentences.join(". ")}.${clampNote} ${CALENDAR_INVARIANT}. ${APPROVE_HINT}`;
    return {
      type: "proposal",
      summary,
      reply,
      before: { goals: beforeGoals },
      after: { goals: afterGoals },
    };
  }

  const parts = changedGoals.map(
    ({ goal }) => `${goalShortName(goal.id, ctx.goals)} 매 통화 ${newPace}과씩`
  );
  const summary = parts.join(", ");
  const protectNote = newPace > 1 ? " 각 트랙의 마지막 과는 건너뛰지 않습니다." : "";
  const reply =
    `진행 중인 목표를 매 통화 ${newPace}과씩 올리도록 바꾸는 안을 준비했어요(${parts.join(", ")}).` +
    `${protectNote}${clampNote} ${CALENDAR_INVARIANT}. ${APPROVE_HINT}`;

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
        `${APPROVE_HINT}`,
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
    reply: `진도 변경 안을 준비했어요(${parts.join(", ")}). ${CALENDAR_INVARIANT}. ${APPROVE_HINT}`,
    before: { goals: beforeGoals },
    after: { goals: afterGoals },
  };
}

export function buildProgressProposal(args: ProgressArgs, ctx: ProgressContext): ProgressResult {
  const reconciled = reconcileProgressIntent(args?.intent, ctx.userText);
  const intent = reconciled.intent;
  if (intent === "undo") {
    return {
      type: "undo_request",
      reply: "방금 바꾼 진도를 되돌릴까요? 아래에서 확인해 주세요.",
    };
  }
  if (intent === "postpone") {
    return buildPostponeResult(args, ctx);
  }
  if (intent === "pull_forward" || intent === "set_pace") {
    if (reconciled.ambiguousPace) {
      return buildAmbiguousPaceClarify(args, ctx);
    }
    if (intent === "pull_forward") {
      return buildPullForwardResult(args, ctx);
    }
    return buildSetPaceResult(args, ctx, reconciled.forceDays);
  }
  if (intent === "set_lesson") {
    return buildSetLessonResult(args, ctx);
  }
  return {
    type: "invalid",
    reply: "지원하지 않는 진도 조정 요청이에요. 미루기, 앞당기기, 속도 변경, 특정 과 지정, 되돌리기만 도와드릴 수 있어요.",
  };
}

/** Builds display lines and approve button label for a progress/pace proposal card. */
export function buildProgressCardView(
  change: {
    before?: { goals?: Record<string, GoalProgressPatch | undefined> };
    after?: { goals?: Record<string, GoalProgressPatch | undefined> };
  },
  ctx: {
    goals: readonly {
      id: string;
      title?: string;
      nextLessonIndex?: number;
      lessonsPerCall?: number;
      lessons?: { index: number }[];
    }[];
    weeklyPattern?: Partial<Record<DayKey, string[]>>;
    todayKst: string;
  }
): {
  title: string;
  beforeLines: string[];
  afterLines: string[];
  detailLines: string[];
  approveLabel: string;
} {
  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  const labelParts: string[] = [];

  for (const [gid, patch] of Object.entries(change.after?.goals || {})) {
    if (!patch || typeof patch !== "object") continue;
    const goal = ctx.goals.find((g) => g.id === gid);
    const name = goalShortName(gid, ctx.goals);

    if (typeof patch.nextLessonIndex === "number") {
      const beforeIdx =
        change.before?.goals?.[gid]?.nextLessonIndex ?? goal?.nextLessonIndex ?? 1;
      beforeLines.push(`${name} ${beforeIdx}과`);
      afterLines.push(`${name} ${patch.nextLessonIndex}과`);
      labelParts.push(`${name} ${beforeIdx}과 → ${patch.nextLessonIndex}과`);
    }
    if (typeof patch.lessonsPerCall === "number") {
      const beforePace = normalizeLessonsPerCall(
        change.before?.goals?.[gid]?.lessonsPerCall ?? goal?.lessonsPerCall
      );
      beforeLines.push(`${name} 매 통화 ${beforePace}과씩`);
      afterLines.push(`${name} 매 통화 ${patch.lessonsPerCall}과씩`);
      labelParts.push(`${name} 매 통화 ${patch.lessonsPerCall}과씩`);
    }
  }

  return {
    title: "📋 진도 조정 제안",
    beforeLines,
    afterLines,
    detailLines: describeProgressChange(change.before, change.after, ctx),
    approveLabel:
      labelParts.length === 1 ? `승인 (${labelParts[0]})` : "승인 (진도 변경 적용)",
  };
}

/** Formats the coach confirmation reply after applying a plan/progress/pace change. */
export function formatAppliedProgressReply(
  change: {
    after?: { goals?: Record<string, GoalProgressPatch | undefined> };
  },
  ctx: {
    goals: readonly { id: string; title?: string }[];
    weeklyPattern?: Partial<Record<DayKey, string[]>>;
    todayKst: string;
  }
): string {
  if (!isProgressChange(change.after)) {
    return "요청하신 계획 변경을 적용했어요.";
  }
  const parts: string[] = [];
  for (const [gid, patch] of Object.entries(change.after?.goals || {})) {
    if (!patch || typeof patch !== "object") continue;
    const name = goalShortName(gid, ctx.goals);
    if (typeof patch.nextLessonIndex === "number") {
      const nextDate = nextLessonDate(ctx.weeklyPattern, gid, ctx.todayKst, true);
      const dateStr = nextDate ? `${formatKstDay(nextDate)}부터 ` : "다음 수업부터 ";
      parts.push(`${name}은 ${dateStr}${patch.nextLessonIndex}과예요`);
    }
    if (typeof patch.lessonsPerCall === "number") {
      parts.push(`${name}은 앞으로 매 통화 ${patch.lessonsPerCall}과씩 올라가요`);
    }
  }
  return `적용했어요. ${parts.join(", ")}. 구글 캘린더는 바뀌지 않습니다.`;
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
          (typeof (g as { nextLessonIndex?: unknown }).nextLessonIndex === "number" ||
            typeof (g as { lessonsPerCall?: unknown }).lessonsPerCall === "number")
      )
  );
}

export function isStaleProgressChange(
  change: {
    before?: { goals?: Record<string, GoalProgressPatch | undefined> };
    after?: { goals?: Record<string, GoalProgressPatch | undefined> };
  },
  liveGoals: readonly { id: string; nextLessonIndex: number; lessonsPerCall?: number }[]
): boolean {
  const afterGoals = change?.after?.goals;
  if (!afterGoals || typeof afterGoals !== "object") return false;

  for (const [goalId, afterPatch] of Object.entries(afterGoals)) {
    if (!afterPatch || typeof afterPatch !== "object") continue;
    if (typeof afterPatch.nextLessonIndex === "number") {
      const beforeIdx = change.before?.goals?.[goalId]?.nextLessonIndex;
      if (typeof beforeIdx === "number") {
        const live = liveGoals.find((g) => g.id === goalId);
        if (!live || live.nextLessonIndex !== beforeIdx) {
          return true;
        }
      }
    }
    if (typeof afterPatch.lessonsPerCall === "number") {
      const beforePace = change.before?.goals?.[goalId]?.lessonsPerCall ?? 1;
      const live = liveGoals.find((g) => g.id === goalId);
      if (!live || normalizeLessonsPerCall(live.lessonsPerCall) !== beforePace) {
        return true;
      }
    }
  }
  return false;
}

export interface UndoCandidateChange {
  id: string;
  status: string;
  at: string;
  appliedAt?: string;
  before?: { plan?: unknown; goals?: Record<string, GoalProgressPatch | undefined> };
  after?: { plan?: unknown; goals?: Record<string, GoalProgressPatch | undefined> };
}

export type UndoRestoreEntry = {
  from?: number;
  to?: number;
  paceFrom?: number;
  paceTo?: number;
};

export type PickUndoResult =
  | {
      ok: true;
      changeId: string;
      restore: Record<string, UndoRestoreEntry>;
    }
  | {
      ok: false;
      reason: "none" | "moved";
      reply: string;
    };

export function pickUndoTarget(
  changes: readonly UndoCandidateChange[],
  liveGoals: readonly { id: string; nextLessonIndex: number; lessonsPerCall?: number }[]
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

  const restore: Record<string, UndoRestoreEntry> = {};
  const afterGoals = latest.after?.goals || {};
  for (const [goalId, afterPatch] of Object.entries(afterGoals)) {
    if (!afterPatch || typeof afterPatch !== "object") continue;
    const hasLesson = typeof afterPatch.nextLessonIndex === "number";
    const hasPace = typeof afterPatch.lessonsPerCall === "number";
    if (!hasLesson && !hasPace) continue;

    const live = liveGoals.find((g) => g.id === goalId);
    const entry: UndoRestoreEntry = {};

    if (hasLesson) {
      if (!live || live.nextLessonIndex !== afterPatch.nextLessonIndex) {
        return {
          ok: false,
          reason: "moved",
          reply: "그 뒤로 수업을 하셔서 되돌리면 진도가 뒤로 가요. 진도 바꾸기로 직접 지정해 주세요",
        };
      }
      const beforeIdx = latest.before?.goals?.[goalId]?.nextLessonIndex;
      if (typeof beforeIdx === "number") {
        entry.from = afterPatch.nextLessonIndex;
        entry.to = beforeIdx;
      }
    }

    if (hasPace) {
      if (!live || normalizeLessonsPerCall(live.lessonsPerCall) !== afterPatch.lessonsPerCall) {
        return {
          ok: false,
          reason: "moved",
          reply: "그 뒤로 수업을 하셔서 되돌리면 진도가 뒤로 가요. 진도 바꾸기로 직접 지정해 주세요",
        };
      }
      const beforePace = latest.before?.goals?.[goalId]?.lessonsPerCall;
      if (typeof beforePace === "number") {
        entry.paceFrom = afterPatch.lessonsPerCall;
        entry.paceTo = beforePace;
      }
    }

    if (Object.keys(entry).length > 0) {
      restore[goalId] = entry;
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

/** Formats the confirmation prompt text for an undo offer card. */
export function describeUndoOffer(
  restore: Record<string, UndoRestoreEntry>,
  goals: readonly { id: string; title?: string }[]
): string {
  const parts = Object.entries(restore).map(([gid, r]) => {
    const name = goalShortName(gid, goals);
    const segs: string[] = [];
    if (typeof r.from === "number" && typeof r.to === "number") {
      segs.push(`${r.from}과 → ${r.to}과`);
    }
    if (typeof r.paceFrom === "number" && typeof r.paceTo === "number") {
      segs.push(`매 통화 ${r.paceFrom}과씩 → ${r.paceTo}과씩`);
    }
    return `${name} ${segs.join(", ")}`;
  });
  return `${parts.join(", ")}로 되돌릴까요? 구글 캘린더는 바뀌지 않습니다`;
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

export function buildPostponeInfoCard(info: PostponeInfo): CoachInfoCard {
  const title = info.reviewDay ? "오늘은 주간 복기" : "오늘 건너뜀";
  const lines = info.items.map((item) =>
    item.nextDate
      ? `다음 ${item.name} ${item.lessonIndex}과 · ${formatKstDay(item.nextDate)} 23:00`
      : `다음 ${item.name} ${item.lessonIndex}과 · 다음 배정 요일`
  );
  lines.push("구글 캘린더는 바뀌지 않습니다");
  return { kind: "postpone", title, lines };
}

export function sanitizeCoachInfoCard(raw: unknown): CoachInfoCard | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== "postpone") return null;
  if (typeof obj.title !== "string") return null;
  const title = obj.title.trim();
  if (title.length < 1 || title.length > 30) return null;
  if (!Array.isArray(obj.lines)) return null;
  const lines = obj.lines
    .filter((l): l is string => typeof l === "string")
    .slice(0, 6)
    .map((l) => l.slice(0, 80));
  return { kind: "postpone", title, lines };
}

export function progressReplyForDisplay(reply: string, opts: { qaPreview: boolean }): string {
  if (!opts.qaPreview) return reply;
  let out = reply.replaceAll(APPROVE_HINT, QA_PREVIEW_HINT);
  const kept = out
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence && !/\[승인\]|'응'/.test(sentence));
  out = kept.join(" ").trim();
  if (!out.includes(QA_PREVIEW_HINT)) {
    out = out ? `${out} ${QA_PREVIEW_HINT}` : QA_PREVIEW_HINT;
  }
  return out;
}

export function qaBlocksPlanChange(after: unknown, qa: boolean): boolean {
  return Boolean(qa) && isProgressChange(after);
}

export function proposalQaPreview(after: unknown, qa: boolean): boolean {
  return qaBlocksPlanChange(after, qa);
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
  progress?: { type: "undo_request" } | { type: "info"; card: CoachInfoCard };
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
  } else if (opts.progressResult.type === "info") {
    out.progress = {
      type: "info",
      card: buildPostponeInfoCard(opts.progressResult.info),
    };
  }
  return out;
}
