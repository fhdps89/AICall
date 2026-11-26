import type { GoalData } from "../firebase/db";

export const BOOT_CACHE_PREFIX = "onecall_boot_v1:";
export const BOOT_CACHE_VERSION = 1;
export const BOOT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

/** 홈 표시에 필요한 최소 구조(객체, id·title 문자열, lessons 배열)인지 확인한다. */
function isCachedGoalShape(g: unknown): boolean {
  if (typeof g !== "object" || g === null || Array.isArray(g)) return false;
  const goal = g as Record<string, unknown>;
  return (
    typeof goal.id === "string" &&
    typeof goal.title === "string" &&
    Array.isArray(goal.lessons)
  );
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

    if (now - record.savedAt > BOOT_CACHE_TTL_MS) {
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
 * 빈 배열은 저장하지 않으며 용량 초과 등 예외는 삼킨다.
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
  const payload: BootCachePayload = {
    v: BOOT_CACHE_VERSION,
    uid,
    goals: goals.map((g) => ({ ...g, tutorPrompt: "" })),
    savedAt: now,
  };
  try {
    store.setItem(bootCacheKey(uid), JSON.stringify(payload));
  } catch {
    // 용량 초과 등 저장소 예외는 무시한다.
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
