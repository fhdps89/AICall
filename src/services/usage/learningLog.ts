import type { UsageDelta, UsageMonth } from "./usageService";
import { USAGE_ASSUMPTIONS } from "../../config/models";

/**
 * Live 컨텍스트 재과금용 "유효 분²" (통화 1회). 컨텍스트는 slidingWindow 압축으로 창 크기(C분)에서 더 커지지 않으므로
 * T ≤ C이면 T², T > C이면 2CT − C² (턴별 컨텍스트 합 = ∫min(t, C)dt × 2).
 */
export function liveContextMinutesSq(minutes: number): number {
  const t = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
  const a = USAGE_ASSUMPTIONS;
  const tokensPerMin = a.audioTokensPerSec * 60 * (1 + a.liveModelTalkShare);
  const capMin = a.liveContextWindowTokens / tokensPerMin;
  return t <= capMin ? t * t : 2 * capMin * t - capMin * capMin;
}

export const REST_BANNER_MIN_DAYS = 2;

const KST_OFFSET_MS = 9 * 3600 * 1000;

export interface DailyLearningLog {
  date: string;
  calls: number;
  minutes: number;
}

export interface LearningLogSummary {
  today: {
    calls: number;
    minutes: number;
  };
  thisMonth: {
    calls: number;
    minutes: number;
    activeDays: number;
  };
  streakDays: number;
  bestStreakDays: number;
  recentDays: DailyLearningLog[];
  /** today 이하 마지막 학습일. 조회한 달 안에 학습 기록이 없으면 null */
  lastActiveDate: string | null;
  /** 오늘 포함 연속 미학습 일수. 오늘 학습=0, 어제가 마지막=1, 그제가 마지막=2. lastActiveDate null이면 null */
  restDays: number | null;
}

export interface HomeLearningStatus {
  /** 표시할 연속 학습일(>=1)이면 값, 아니면 null */
  streakDays: number | null;
  /** 휴식 배너에 쓸 일수(>=REST_BANNER_MIN_DAYS)이면 값, 아니면 null */
  restDays: number | null;
}

/**
 * epoch ms → KST 'YYYY-MM-DD' (getUTC* 사용, 기기 타임존 비의존).
 */
export function kstDateStr(nowMs: number): string {
  const kst = new Date(nowMs + KST_OFFSET_MS);
  return formatDateStr(kst.getUTCFullYear(), kst.getUTCMonth() + 1, kst.getUTCDate());
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const table = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[month - 1] ?? 0;
}

function parseDateStr(dateStr: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  const dim = daysInMonth(year, month);
  if (day < 1 || day > dim) return null;
  return { year, month, day };
}

function formatDateStr(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * YYYY-MM-DD 문자열 기준 순수 날짜 가감 (타임존/Date 객체 비의존).
 */
export function addDaysToDateStr(dateStr: string, deltaDays: number): string {
  const parsed = parseDateStr(dateStr);
  if (!parsed) throw new Error(`Invalid YYYY-MM-DD date: ${dateStr}`);
  let { year, month, day } = parsed;
  let rem = deltaDays;

  while (rem > 0) {
    const dim = daysInMonth(year, month);
    if (day + rem <= dim) {
      day += rem;
      rem = 0;
    } else {
      rem -= dim - day + 1;
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }

  while (rem < 0) {
    if (day + rem >= 1) {
      day += rem;
      rem = 0;
    } else {
      rem += day;
      month -= 1;
      if (month < 1) {
        month = 12;
        year -= 1;
      }
      day = daysInMonth(year, month);
    }
  }

  return formatDateStr(year, month, day);
}

/**
 * 기준일(today: YYYY-MM-DD) 포함 최근 N개월의 YYYY-MM 키 목록을 최신순으로 반환.
 */
export function getRecentMonthKeys(today: string, count = 3): string[] {
  const parsed = parseDateStr(today);
  if (!parsed || count <= 0) return [];
  let { year, month } = parsed;
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    keys.push(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`);
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  }
  return keys;
}

/**
 * 통화 시간(초) 기준으로 완료 통화 횟수를 계산한다 (10초 이상이면 1, 미만이면 0).
 */
export function callsForDuration(sec: number): number {
  return Number.isFinite(sec) && sec >= 10 ? 1 : 0;
}

/**
 * 통화 종료 시 기록할 사용량 증분을 계산한다.
 * QA 통화는 비용만 남기도록 qaLiveMinutes·qaLiveMinutesSq만 반환하고 liveMinutes·calls는 넣지 않는다.
 */
export function callUsageDelta(durationSec: number, isQa: boolean): UsageDelta {
  const sec = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const m = sec / 60;
  if (isQa) {
    return { qaLiveMinutes: m, qaLiveMinutesSq: liveContextMinutesSq(m) };
  }
  return { liveMinutes: m, liveMinutesSq: liveContextMinutesSq(m), calls: callsForDuration(sec) };
}

/**
 * 학습한 날 판정: 통화 횟수가 1회 이상이거나(옛 데이터 호환) 통화 시간이 0.5분 이상.
 */
export function isActiveLearningDay(calls: number, minutes: number): boolean {
  return calls > 0 || minutes >= 0.5;
}

/**
 * 최근 몇 개월의 usage 문서를 바탕으로 오늘/이번 달/연속 학습일/최근 14일 요약을 계산한다.
 */
export function summarizeLearningLog(
  months: Record<string, UsageMonth | null>,
  today: string
): LearningLogSummary {
  if (!parseDateStr(today)) {
    throw new Error(`Invalid today date: ${today}`);
  }

  const dayMap = new Map<string, { calls: number; minutes: number }>();
  const activeDates = new Set<string>();

  for (const [monthKey, monthDoc] of Object.entries(months)) {
    if (!monthDoc?.days || !/^\d{4}-\d{2}$/.test(monthKey)) continue;
    for (const [rawDay, dayStats] of Object.entries(monthDoc.days)) {
      if (!/^\d{1,2}$/.test(rawDay)) continue;
      const dd = rawDay.padStart(2, "0");
      const fullDate = `${monthKey}-${dd}`;
      if (!parseDateStr(fullDate)) continue;

      const calls = dayStats?.calls ?? 0;
      const minutes = dayStats?.liveMinutes ?? 0;
      const prev = dayMap.get(fullDate);
      const mergedCalls = (prev?.calls ?? 0) + calls;
      const mergedMinutes = (prev?.minutes ?? 0) + minutes;
      dayMap.set(fullDate, { calls: mergedCalls, minutes: mergedMinutes });

      if (isActiveLearningDay(mergedCalls, mergedMinutes)) {
        activeDates.add(fullDate);
      }
    }
  }

  const todayEntry = dayMap.get(today) ?? { calls: 0, minutes: 0 };

  const thisMonthKey = today.slice(0, 7);
  let monthDaysCalls = 0;
  let monthDaysMinutes = 0;
  let monthActiveDays = 0;

  for (const [date, stats] of dayMap.entries()) {
    if (date.startsWith(`${thisMonthKey}-`)) {
      monthDaysCalls += stats.calls;
      monthDaysMinutes += stats.minutes;
      if (activeDates.has(date)) {
        monthActiveDays += 1;
      }
    }
  }

  // 오늘 카드·막대 그래프와 어긋나지 않도록 이번 달 합계도 days 합 하나로 통일한다.
  const thisMonthCalls = monthDaysCalls;
  const thisMonthMinutes = monthDaysMinutes;

  // streak: 오늘 학습했으면 오늘부터, 아직 안 했으면 어제부터 거꾸로 연속일 계산 (어제도 없으면 0)
  let streakDays = 0;
  let cursor = activeDates.has(today) ? today : addDaysToDateStr(today, -1);
  while (activeDates.has(cursor)) {
    streakDays += 1;
    cursor = addDaysToDateStr(cursor, -1);
  }

  // bestStreak: 가져온 달들 안에서의 최장 연속 학습일
  const sortedActive = Array.from(activeDates).sort();
  let bestStreakDays = 0;
  let currentRun = 0;
  let prevActive: string | null = null;
  for (const date of sortedActive) {
    if (prevActive && addDaysToDateStr(prevActive, 1) === date) {
      currentRun += 1;
    } else {
      currentRun = 1;
    }
    if (currentRun > bestStreakDays) {
      bestStreakDays = currentRun;
    }
    prevActive = date;
  }

  // lastActiveDate & restDays: today 이하 마지막 학습일과 오늘 포함 연속 미학습 일수
  let lastActiveDate: string | null = null;
  for (let i = sortedActive.length - 1; i >= 0; i -= 1) {
    if (sortedActive[i] <= today) {
      lastActiveDate = sortedActive[i];
      break;
    }
  }

  let restDays: number | null = null;
  if (lastActiveDate !== null) {
    if (lastActiveDate === today) {
      restDays = 0;
    } else {
      let count = 0;
      let restCursor = today;
      while (restCursor > lastActiveDate) {
        count += 1;
        restCursor = addDaysToDateStr(restCursor, -1);
      }
      restDays = count;
    }
  }

  // recentDays: 최근 14일 (오래된 날짜 → 오늘)
  const recentDays: DailyLearningLog[] = [];
  for (let offset = -13; offset <= 0; offset += 1) {
    const date = addDaysToDateStr(today, offset);
    const stats = dayMap.get(date);
    recentDays.push({
      date,
      calls: stats?.calls ?? 0,
      minutes: stats?.minutes ?? 0,
    });
  }

  return {
    today: {
      calls: todayEntry.calls,
      minutes: todayEntry.minutes,
    },
    thisMonth: {
      calls: thisMonthCalls,
      minutes: thisMonthMinutes,
      activeDays: monthActiveDays,
    },
    streakDays,
    bestStreakDays,
    recentDays,
    lastActiveDate,
    restDays,
  };
}

/**
 * summary null(로딩·실패) → 둘 다 null.
 * 연속 학습일(>=1)과 휴식 배너 일수(>=REST_BANNER_MIN_DAYS)를 한 번에 파생해 동시 노출을 막는다.
 */
export function deriveHomeLearningStatus(
  summary: LearningLogSummary | null
): HomeLearningStatus {
  if (!summary) {
    return { streakDays: null, restDays: null };
  }
  return {
    streakDays: summary.streakDays >= 1 ? summary.streakDays : null,
    restDays:
      summary.restDays !== null && summary.restDays >= REST_BANNER_MIN_DAYS
        ? summary.restDays
        : null,
  };
}

/**
 * 휴식 배너 제목.
 * 전제: `deriveHomeLearningStatus`가 `REST_BANNER_MIN_DAYS`(2) 이상만 넘긴다.
 * 2 → "이틀째 쉬었어요. 오늘 수업만 해도 좋아요", n>=3 → `${n}일째 쉬었어요. 오늘 수업만 해도 좋아요`.
 */
export function restBannerTitle(restDays: number): string {
  if (restDays <= REST_BANNER_MIN_DAYS) {
    return "이틀째 쉬었어요. 오늘 수업만 해도 좋아요";
  }
  return `${restDays}일째 쉬었어요. 오늘 수업만 해도 좋아요`;
}
