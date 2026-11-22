import type { SessionReviewData } from "../firebase/db";
import { hasLearnerSpeech } from "./speechCheck";

/** Return true when no learner speech was captured or the lesson did not advance. */
export function isEmptyReview(
  review: Pick<SessionReviewData, "lessonAdvanced"> | undefined | null,
  sttSource?: string,
  transcript?: string
): boolean {
  if (sttSource === "none" || review?.lessonAdvanced === false) {
    return true;
  }
  if (transcript !== undefined && !hasLearnerSpeech(transcript)) {
    return true;
  }
  return false;
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

/** Return true only when the lesson advanced for a real (non-QA) call. */
export function shouldShowLessonAdvanced(
  review: { lessonAdvanced?: boolean; qaCall?: boolean } | null | undefined
): boolean {
  return review?.lessonAdvanced === true && review?.qaCall !== true;
}

export interface ReviewSaveNotice {
  tone: "info" | "warn" | "ok";
  text: string;
  showNextSteps: boolean;
}

/** Pick the post-call save status notice and whether next-step bullets should appear. */
export function reviewSaveNotice(input: {
  qaCall?: boolean;
  mistakesSaved?: boolean;
  visibleCount: number;
}): ReviewSaveNotice {
  if (input.qaCall === true) {
    return {
      tone: "info",
      text: "QA 통화라서 실수를 복습 목록에 저장하지 않았어요. 진도와 학습 기록도 그대로예요.",
      showNextSteps: false,
    };
  }
  if (input.mistakesSaved === false) {
    return {
      tone: "warn",
      text: '실수를 앱 복습 목록에 저장하지 못했어요. 아래 "Keep에 붙여넣기용 복사"로 따로 남겨 두세요.',
      showNextSteps: true,
    };
  }
  if (input.visibleCount > 0) {
    return {
      tone: "ok",
      text: `오늘 실수 ${input.visibleCount}개는 앱 복습 목록에 자동으로 저장됐어요. 따로 옮겨 적지 않아도 돼요.`,
      showNextSteps: true,
    };
  }
  return {
    tone: "ok",
    text: "오늘은 저장할 실수가 없어요.",
    showNextSteps: true,
  };
}
