/**
 * 끊긴 통화 복구 시 누락된 통화 횟수·통화 분을 계산하는 순수 모듈 (Firebase·React 비의존).
 */
import type { SessionData } from "../firebase/db";
import { callsForDuration } from "../usage/learningLog";

export const MAX_RECOVERED_CALL_SEC = 3 * 60 * 60;

/** UTC ms 타임스탬프를 KST YYYY-MM-DD 문자열로 변환한다. */
export function toKstDateStr(ms: number): string {
  const kst = new Date(ms + 9 * 3600000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 정상 종료(`endedAt`)나 복구 집계(`usageRecordedAt`)가 없는 오늘(KST) 통화의 사용량을 산출한다.
 * 다른 날 시작한 통화나 길이 0 이하 통화는 null을 반환한다.
 */
export function recoveredCallUsage(
  s: Pick<SessionData, "startedAt" | "endedAt" | "lastChunkAt" | "liveTranscript"> & { usageRecordedAt?: string },
  todayKst: string
): { liveMinutes: number; calls: number } | null {
  if (s.endedAt || s.usageRecordedAt) return null;

  const startMs = Date.parse(s.startedAt);
  if (!Number.isFinite(startMs)) return null;
  if (toKstDateStr(startMs) !== todayKst) return null;

  let endMs = startMs;
  if (s.lastChunkAt) {
    const chunkMs = Date.parse(s.lastChunkAt);
    if (Number.isFinite(chunkMs) && chunkMs > endMs) {
      endMs = chunkMs;
    }
  }
  for (const item of s.liveTranscript ?? []) {
    if (typeof item.timestamp === "number" && Number.isFinite(item.timestamp) && item.timestamp > endMs) {
      endMs = item.timestamp;
    }
  }

  const rawSec = (endMs - startMs) / 1000;
  if (!Number.isFinite(rawSec) || rawSec <= 0) return null;

  const sec = Math.min(rawSec, MAX_RECOVERED_CALL_SEC);
  return {
    liveMinutes: sec / 60,
    calls: callsForDuration(sec),
  };
}

export type RecoveredUsageSession = Pick<
  SessionData,
  "startedAt" | "endedAt" | "lastChunkAt" | "liveTranscript"
> & { usageRecordedAt?: string };

export interface RecoveredUsageRecorderDeps {
  getSession: (uid: string, sessionId: string) => Promise<RecoveredUsageSession | null>;
  markRecorded: (uid: string, sessionId: string) => Promise<void>;
  recordUsage: (uid: string, usage: { liveMinutes: number; calls: number }) => Promise<void>;
  todayKst: () => string;
  onError?: (err: unknown) => void;
}

/**
 * 같은 sessionId로 복구 사용량 기록이 이미 진행 중이면 두 번째 동시 호출을 건너뛰는 실행기를 만든다.
 */
export function createRecoveredUsageRecorder(deps: RecoveredUsageRecorderDeps) {
  const inFlight = new Set<string>();

  return async (uid: string, sessionId: string): Promise<boolean> => {
    if (inFlight.has(sessionId)) return false;
    inFlight.add(sessionId);
    try {
      const fresh = await deps.getSession(uid, sessionId);
      const usage = fresh ? recoveredCallUsage(fresh, deps.todayKst()) : null;
      if (!usage) return false;
      await deps.markRecorded(uid, sessionId); // 표시 먼저: 실패하면 기록하지 않음(두 번 세는 것보다 낫다)
      await deps.recordUsage(uid, usage);
      return true;
    } catch (err) {
      deps.onError?.(err);
      return false;
    } finally {
      inFlight.delete(sessionId);
    }
  };
}
