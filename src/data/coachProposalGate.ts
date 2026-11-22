/**
 * Pure expiry and quick-reply gating for coach plan/progress proposals.
 * Kept free of Firebase and DOM so plain node can load it directly.
 */

export const QUICK_APPROVE_MAX_AGE_MS = 10 * 60 * 1000;
export const FUTURE_SKEW_MS = 60 * 1000;

export interface GateChange {
  id: string;
  status: string;
  at?: string;
}

const EXPIRED_REPLY = "이 제안은 10분이 지나 만료됐어요. 코치에게 다시 요청해 주세요.";

/**
 * Checks whether a proposal card can be applied right now.
 * Enforces status === "proposed", session ownership for quick replies, and the 10-minute window.
 */
export function canApplyPendingProposal(
  change: GateChange,
  o: {
    nowMs: number;
    sessionChangeIds: ReadonlySet<string>;
    viaQuickReply: boolean;
  }
):
  | { ok: true }
  | { ok: false; reason: "not_pending" | "not_in_session" | "expired"; reply: string } {
  if (change.status !== "proposed") {
    return { ok: false, reason: "not_pending", reply: "이미 처리된 제안이에요" };
  }
  if (o.viaQuickReply && !o.sessionChangeIds.has(change.id)) {
    return {
      ok: false,
      reason: "not_in_session",
      reply: "이번 대화에서 만든 제안만 바로 답장으로 승인할 수 있어요. 카드의 버튼을 눌러 주세요.",
    };
  }
  const parsedAt = typeof change.at === "string" ? Date.parse(change.at) : Number.NaN;
  if (!Number.isFinite(parsedAt)) {
    return { ok: false, reason: "expired", reply: EXPIRED_REPLY };
  }
  if (o.nowMs - parsedAt > QUICK_APPROVE_MAX_AGE_MS) {
    return { ok: false, reason: "expired", reply: EXPIRED_REPLY };
  }
  if (parsedAt > o.nowMs + FUTURE_SKEW_MS) {
    return { ok: false, reason: "expired", reply: EXPIRED_REPLY };
  }
  return { ok: true };
}

/**
 * Picks the target proposal for a quick-reply ("응", "아니" 등) within the current chat session.
 */
export function selectQuickReplyTarget<T extends GateChange>(
  changes: readonly T[],
  o: {
    nowMs: number;
    sessionChangeIds: ReadonlySet<string>;
  }
): { kind: "none" } | { kind: "one"; change: T } | { kind: "many" } | { kind: "expired" } {
  const inSessionPending = changes.filter(
    (c) => c.status === "proposed" && o.sessionChangeIds.has(c.id)
  );
  if (inSessionPending.length === 0) {
    return { kind: "none" };
  }
  const valid = inSessionPending.filter(
    (c) => canApplyPendingProposal(c, { ...o, viaQuickReply: true }).ok
  );
  if (valid.length === 1) {
    return { kind: "one", change: valid[0] };
  }
  if (valid.length >= 2) {
    return { kind: "many" };
  }
  return { kind: "expired" };
}
