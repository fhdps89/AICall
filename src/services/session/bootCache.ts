import type { GoalData } from "../firebase/db";

export const BOOT_CACHE_PREFIX = "onecall_boot_v1:";
export const BOOT_CACHE_VERSION = 1;
export const BOOT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** savedAt가 이 값보다 미래면 시계 오류로 보고 캐시를 쓰지 않는다. */
export const BOOT_CACHE_FUTURE_SKEW_MS = 60 * 1000;

export interface BootCacheStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

interface BootCachePayload {
  v: number;
  uid: string;
  goals: GoalData[];
  savedAt: number;
}

export function bootCacheKey(uid: string): string {
  return `${BOOT_CACHE_PREFIX}${uid}`;
}

function safeRemove(store: BootCacheStore, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    // 저장소 삭제 실패는 무시한다.
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 홈이 `lessons.find`에서 죽지 않는 과 항목인지 확인한다. */
function isCachedLesson(lesson: unknown): boolean {
  if (typeof lesson !== "object" || lesson === null || Array.isArray(lesson)) return false;
  const item = lesson as Record<string, unknown>;
  if (!isFiniteNumber(item.index) || typeof item.title !== "string") return false;
  if ("completed" in item && typeof item.completed !== "boolean") return false;
  return true;
}

/**
 * 홈 표시에 필요한 최소 구조인지 확인한다.
 * id·title·why 문자열, nextLessonIndex 유한 수, lessons의 각 원소가 과 객체여야 한다.
 * null 과나 객체형 why는 홈 렌더를 중단시키므로 캐시 전체를 버린다.
 */
function isCachedGoalShape(g: unknown): boolean {
  if (typeof g !== "object" || g === null || Array.isArray(g)) return false;
  const goal = g as Record<string, unknown>;
  return (
    typeof goal.id === "string" &&
    goal.id.length > 0 &&
    typeof goal.title === "string" &&
    typeof goal.why === "string" &&
    isFiniteNumber(goal.nextLessonIndex) &&
    Array.isArray(goal.lessons) &&
    goal.lessons.every(isCachedLesson)
  );
}

/** 홈에 보이는 필드만 남긴다. tutorPrompt와 문서에 섞인 그 외 필드는 저장하지 않는다. */
function toCachedGoal(goal: GoalData): GoalData {
  const lessons = Array.isArray(goal.lessons) ? goal.lessons.filter(isCachedLesson) : [];
  const cached: GoalData = {
    id: typeof goal.id === "string" ? goal.id : "",
    title: typeof goal.title === "string" ? goal.title : "",
    type: typeof goal.type === "string" ? goal.type : "",
    why: typeof goal.why === "string" ? goal.why : "",
    priority: isFiniteNumber(goal.priority) ? goal.priority : 0,
    tutorPrompt: "",
    lessons: lessons.map((lesson) => ({
      index: lesson.index,
      title: lesson.title,
      ...(typeof lesson.completed === "boolean" ? { completed: lesson.completed } : {}),
    })),
    nextLessonIndex: isFiniteNumber(goal.nextLessonIndex) ? goal.nextLessonIndex : 1,
    status: goal.status === "paused" || goal.status === "done" ? goal.status : "active",
    updatedAt: typeof goal.updatedAt === "string" ? goal.updatedAt : "",
  };
  if (isFiniteNumber(goal.lessonsPerCall)) cached.lessonsPerCall = goal.lessonsPerCall;
  if (typeof goal.deadline === "string" && goal.deadline) cached.deadline = goal.deadline;
  return cached;
}

function peekSavedAt(store: BootCacheStore, uid: string): number | null {
  try {
    const raw = store.getItem(bootCacheKey(uid));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { savedAt?: unknown };
    return isFiniteNumber(parsed?.savedAt) ? parsed.savedAt : null;
  } catch {
    return null;
  }
}

/**
 * 이 조회가 시작되기 전에 저장된 캐시만 교체한다.
 * 조회 도중 다른 탭·진도 저장이 남긴 더 새로운 savedAt는 덮지 않는다.
 * 미래 시각(시계 오류)은 교체를 막지 않는다.
 */
export function mayReplaceBootCache(
  existingSavedAt: number | null,
  readStartedAt: number,
  now: number
): boolean {
  if (!isFiniteNumber(readStartedAt) || !isFiniteNumber(now)) return false;
  if (!isFiniteNumber(existingSavedAt)) return true;
  if (existingSavedAt > now + BOOT_CACHE_FUTURE_SKEW_MS) return true;
  return existingSavedAt <= readStartedAt;
}

/**
 * 기기에 저장된 마지막 목표(goals) 목록을 읽는다.
 * 손상·버전 불일치·uid 불일치·빈 배열·7일(TTL) 경과 시 캐시를 지우고 null을 반환한다.
 */
export function readBootCache(
  store: BootCacheStore | undefined,
  uid: string,
  now: number
): GoalData[] | null {
  if (!store || !uid || !Number.isFinite(now)) return null;
  const key = bootCacheKey(uid);
  try {
    const raw = store.getItem(key);
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      safeRemove(store, key);
      return null;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      safeRemove(store, key);
      return null;
    }

    const record = parsed as Partial<BootCachePayload>;
    if (
      record.v !== BOOT_CACHE_VERSION ||
      record.uid !== uid ||
      !Array.isArray(record.goals) ||
      record.goals.length === 0 ||
      typeof record.savedAt !== "number" ||
      !Number.isFinite(record.savedAt) ||
      !record.goals.every(isCachedGoalShape)
    ) {
      safeRemove(store, key);
      return null;
    }

    if (record.savedAt > now + BOOT_CACHE_FUTURE_SKEW_MS || now - record.savedAt > BOOT_CACHE_TTL_MS) {
      safeRemove(store, key);
      return null;
    }

    return record.goals;
  } catch {
    return null;
  }
}

/**
 * 목표(goals) 목록만 최소 페이로드로 기기 저장소에 기록한다.
 * 캐시 목록은 홈 표시용이며 통화에 쓰지 않으므로 긴 튜터 프롬프트(tutorPrompt)는 빈 문자열로 비워 저장한다. 홈에 보이는 짧은 목표 설명(why)은 남긴다.
 * 빈 배열은 저장하지 않는다. 용량 초과 등 예외는 삼키고 기존 값은 건드리지 않는다.
 * 서버 조회 결과를 반영할 때는 commitBootGoals를 쓴다.
 */
export function writeBootCache(
  store: BootCacheStore | undefined,
  uid: string,
  goals: GoalData[],
  now: number
): void {
  if (!store || !uid || !Array.isArray(goals) || goals.length === 0 || !Number.isFinite(now)) {
    return;
  }
  const key = bootCacheKey(uid);
  const payload: BootCachePayload = {
    v: BOOT_CACHE_VERSION,
    uid,
    goals: goals.map(toCachedGoal),
    savedAt: now,
  };
  try {
    store.setItem(key, JSON.stringify(payload));
  } catch {
    // 용량 초과 등 저장소 예외는 무시한다.
  }
}

/**
 * 서버·로컬 진도 결과를 캐시에 반영한다.
 * 조회 시작 시각보다 나중에 저장된 캐시가 있으면 쓰지 않는다.
 * 확인된 목록이 비어 있으면 그 캐시를 지워 삭제된 목표가 다음 방문에 되살아나지 않게 한다.
 * 용량 초과로 새 목록을 쓰지 못하면, 여전히 더 오래된 값일 때만 키를 지운다.
 */
export function commitBootGoals(
  store: BootCacheStore | undefined,
  uid: string,
  goals: GoalData[],
  now: number,
  readStartedAt: number
): void {
  if (!store || !uid || !Number.isFinite(now) || !Number.isFinite(readStartedAt)) return;
  if (!mayReplaceBootCache(peekSavedAt(store, uid), readStartedAt, now)) return;
  if (!Array.isArray(goals) || goals.length === 0) {
    clearBootCache(store, uid);
    return;
  }
  const key = bootCacheKey(uid);
  const payload: BootCachePayload = {
    v: BOOT_CACHE_VERSION,
    uid,
    goals: goals.map(toCachedGoal),
    // 쓴 시각이 아니라 조회를 시작한 시각. 먼저 끝난 옛 조회가 나중에 끝난 새 조회를 막지 않는다.
    savedAt: readStartedAt,
  };
  try {
    store.setItem(key, JSON.stringify(payload));
  } catch {
    if (mayReplaceBootCache(peekSavedAt(store, uid), readStartedAt, now)) {
      safeRemove(store, key);
    }
  }
}

/**
 * 부트 캐시를 비운다. uid를 주면 해당 키만, 생략하면 `onecall_boot_v1:` 접두 키를 모두 지운다.
 */
export function clearBootCache(store: BootCacheStore | undefined, uid?: string): void {
  if (!store) return;
  try {
    if (uid !== undefined) {
      if (uid) {
        store.removeItem(bootCacheKey(uid));
      }
      return;
    }
    if (typeof store.length !== "number" || typeof store.key !== "function") {
      return;
    }
    const keysToRemove: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const k = store.key(i);
      if (typeof k === "string" && k.startsWith(BOOT_CACHE_PREFIX)) {
        keysToRemove.push(k);
      }
    }
    for (const k of keysToRemove) {
      store.removeItem(k);
    }
  } catch {
    // 저장소 예외는 무시한다.
  }
}

/**
 * 브라우저 localStorage를 안전하게 반환한다. 없거나 접근이 차단되면 undefined를 반환한다.
 */
export function defaultBootStore(): BootCacheStore | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    return localStorage;
  } catch {
    return undefined;
  }
}
