import type { SessionData } from "../firebase/db";

export const DEFAULT_STALE_SESSION_MS = 2 * 60 * 1000;

/**
 * in-progress 통화가 중단된(복기 대기) 상태인지 판정한다.
 * staleAfterMs <= 0 이면 페이지가 새로 열린 시점 등으로 간주해 즉시 중단된 것으로 본다.
 */
function latestActivityMs(session: Pick<SessionData, "lastChunkAt" | "lastTranscriptAt" | "startedAt">): number | null {
  let latest = 0;
  for (const raw of [session.lastTranscriptAt, session.lastChunkAt, session.startedAt]) {
    if (!raw) continue;
    const ms = new Date(raw).getTime();
    if (!Number.isNaN(ms) && ms > latest) latest = ms;
  }
  return latest || null;
}

export function isInterruptedSession(
  session: Pick<SessionData, "status" | "lastChunkAt" | "lastTranscriptAt" | "startedAt">,
  now: number,
  staleAfterMs: number = DEFAULT_STALE_SESSION_MS
): boolean {
  if (session.status !== "in-progress") {
    return false;
  }
  if (staleAfterMs <= 0) {
    return true;
  }
  const lastMs = latestActivityMs(session);
  if (lastMs == null) {
    return false;
  }
  return now - lastMs > staleAfterMs;
}
