import type { SessionReviewData } from "../firebase/db";

/** Return true when no learner speech was captured or the lesson did not advance. */
export function isEmptyReview(
  review: Pick<SessionReviewData, "lessonAdvanced"> | undefined | null,
  sttSource?: string
): boolean {
  return sttSource === "none" || review?.lessonAdvanced === false;
}

/** Map an internal STT source key to a user-facing Korean label. */
export function sourceSttLabel(src: string | undefined): string {
  switch (src) {
    case "sttFinal":
      return "최종 받아쓰기";
    case "sttPartial_fallback":
      return "통화 중 임시 받아쓰기";
    case "liveTranscript_fallback":
      return "통화 로그";
    case "none":
      return "기록 없음";
    default:
      return "받아쓰기";
  }
}

/** Format an estimated speaking level and its visual tone without inventing a fallback level. */
export function levelBadge(
  level: string | undefined
): { text: string; tone: "good" | "mid" | "base" | "none" } {
  const trimmed = level?.trim();
  if (!trimmed || trimmed === "-") {
    return { text: "—", tone: "none" };
  }
  if (trimmed === "AL" || trimmed === "Native") {
    return { text: trimmed, tone: "good" };
  }
  if (trimmed === "IH" || trimmed === "IM2") {
    return { text: trimmed, tone: "mid" };
  }
  return { text: trimmed, tone: "base" };
}

/** Resolve outcome IDs against a pool in ID order, skipping any IDs not found. */
export function outcomeItems<T extends { id?: string }>(ids: string[], pool: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of pool) {
    if (item.id && !byId.has(item.id)) {
      byId.set(item.id, item);
    }
  }
  const result: T[] = [];
  for (const id of ids) {
    const found = byId.get(id);
    if (found) result.push(found);
  }
  return result;
}
