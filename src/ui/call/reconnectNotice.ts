/**
 * 재연결 안내 배너·상태 표시 지연 판정(순수 모듈, React 비의존).
 * 순간적인 소켓 전환 시 배너가 깜빡이지 않도록 일정 시간(기본 1500ms) 이후에만 표시한다.
 */

export const RECONNECT_NOTICE_DELAY_MS = 1500;

export type CallUiStatus = "connecting" | "connected" | "reconnecting" | "closed" | "error";

export function shouldShowReconnectNotice(a: {
  status: CallUiStatus;
  reconnectingSinceMs: number | null;
  nowMs: number;
  delayMs?: number;
}): boolean {
  if (a.status !== "reconnecting" || a.reconnectingSinceMs === null) {
    return false;
  }
  const delay = a.delayMs ?? RECONNECT_NOTICE_DELAY_MS;
  return a.nowMs - a.reconnectingSinceMs >= delay;
}

export function reconnectNoticeRemainingMs(a: {
  reconnectingSinceMs: number;
  nowMs: number;
  delayMs?: number;
}): number {
  const delay = a.delayMs ?? RECONNECT_NOTICE_DELAY_MS;
  return Math.max(0, a.reconnectingSinceMs + delay - a.nowMs);
}

/**
 * 타이머로 확정된 boolean 상태(`noticeVisible`)를 바탕으로 배너 노출과 표시 상태를 결정한다.
 * `Date.now()` 재판정 시 브라우저 타이머 지터로 경계값(1499ms)에서 숨겨지는 문제를 피한다.
 */
export function resolveReconnectUiState(a: {
  status: CallUiStatus;
  noticeVisible: boolean;
}): { showReconnectNotice: boolean; displayStatus: CallUiStatus } {
  const showReconnectNotice = a.status === "reconnecting" && a.noticeVisible;
  const displayStatus = a.status === "reconnecting" && !showReconnectNotice ? "connected" : a.status;
  return { showReconnectNotice, displayStatus };
}
