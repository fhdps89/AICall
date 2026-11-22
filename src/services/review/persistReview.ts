import type { MistakeData, SessionReviewData, SttFinalData } from "../firebase/db";
import { callSideEffects } from "../../data/qaMode";
import { keepKnownIds } from "./reviewRules";
import { outcomeItems } from "./reviewView";

export interface PersistReviewDeps {
  deleteCallMistakesForSession(userId: string, sessionId: string): Promise<number>;
  saveCallMistakes(userId: string, docs: MistakeData[]): Promise<string[]>;
  applyCallMistakeUpdates(
    userId: string,
    used: string[],
    repeated: string[]
  ): Promise<{ graduatedCount: number; reopenedCount: number }>;
  saveSessionReview(
    userId: string,
    sessionId: string,
    review: SessionReviewData,
    stt: SttFinalData
  ): Promise<void>;
  advanceGoalAfterCompletedCall(
    userId: string,
    goalId: string,
    lessonIndex: number
  ): Promise<void>;
}

export interface PersistReviewInput {
  userId: string;
  sessionId: string;
  goalId: string;
  lessonIndex: number;
  lessonTitle: string;
  review: SessionReviewData;
  sttFinal: SttFinalData;
  sourceStt: string;
  isQa: boolean;
  tomorrow: string;
  nowIso: string;
  reviewingMistakes: MistakeData[];
  graduatedMistakes: MistakeData[];
}

/**
 * Persist post-call review outcomes while isolating QA calls from user progress,
 * mistake storage, and graduation/reopen updates.
 */
export async function persistReviewOutcome(
  deps: PersistReviewDeps,
  input: PersistReviewInput
): Promise<{ review: SessionReviewData; mistakeDocs: MistakeData[] }> {
  const {
    userId,
    sessionId,
    goalId,
    lessonIndex,
    lessonTitle,
    sttFinal,
    sourceStt,
    isQa,
    tomorrow,
    nowIso,
    reviewingMistakes,
    graduatedMistakes,
  } = input;

  const review: SessionReviewData = { ...input.review };
  const effects = callSideEffects(isQa);

  const mistakeSource: MistakeData["source"] = isQa ? "qa" : "call";
  const toDoc = (
    m: { myPhrase: string; naturalPhrase: string; reason: string; sourceStt?: string },
    source: MistakeData["source"]
  ): MistakeData => ({
    myPhrase: m.myPhrase,
    naturalPhrase: m.naturalPhrase,
    reason: m.reason,
    sourceStt: m.sourceStt || sourceStt,
    stage: 1,
    status: "reviewing",
    nextReviewAt: tomorrow,
    nextReviewDate: tomorrow,
    source,
    sessionId,
    goalId,
    lessonIndex,
    lessonTitle,
    createdAt: nowIso,
  });

  const primaryDocs: MistakeData[] = (review.mistakes || []).map((m) => toDoc(m, mistakeSource));
  const extras = Array.isArray(review.extraMistakes) ? review.extraMistakes : [];
  const extraDocs: MistakeData[] = isQa
    ? []
    : extras.map((m) => toDoc(m, "transcript_analysis"));
  const mistakeDocs: MistakeData[] = [...primaryDocs, ...extraDocs];

  if (effects.saveMistakes) {
    try {
      // Re-running the review for the same call replaces what that run saved instead of adding duplicates.
      const removed = await deps.deleteCallMistakesForSession(userId, sessionId);
      if (removed > 0) {
        console.log(`[ReviewPipeline] Replaced ${removed} mistakes from an earlier review of this call.`);
      }
      if (mistakeDocs.length > 0) {
        const ids = await deps.saveCallMistakes(userId, mistakeDocs);
        // Keep each mistake's id in the saved review, so 「이건 내가 한 말이 아니에요」 can remove it.
        review.mistakes = (review.mistakes || []).map((m, i) => (ids[i] ? { ...m, id: ids[i] } : m));
        if (extraDocs.length > 0) {
          review.extraMistakes = extras.map((m, i) =>
            ids[primaryDocs.length + i] ? { ...m, id: ids[primaryDocs.length + i] } : m
          );
        }
        console.log(`[ReviewPipeline] Saved ${mistakeDocs.length} new mistakes to mistakes collection.`);
      }
      review.mistakesSaved = true;
    } catch (mistakeErr) {
      review.mistakesSaved = false;
      console.error("[ReviewPipeline] Failed to save mistakes collection:", mistakeErr);
    }
  } else {
    delete review.mistakesSaved;
  }

  // B-5: filter model-returned IDs against known pools regardless of QA mode
  const usedList = keepKnownIds(
    review.usedCorrectly,
    reviewingMistakes.map((m) => m.id)
  );
  const repeatedList = keepKnownIds(
    review.repeatedMistakes,
    graduatedMistakes.map((m) => m.id)
  );
  review.usedCorrectly = usedList;
  review.repeatedMistakes = repeatedList;

  if (effects.applyMistakeOutcomes) {
    try {
      review.usedCorrectlyItems = outcomeItems(usedList, reviewingMistakes).map((m) => ({
        id: m.id || "",
        myPhrase: m.myPhrase || "",
        naturalPhrase: m.naturalPhrase || "",
      }));
      review.repeatedItems = outcomeItems(repeatedList, graduatedMistakes).map((m) => ({
        id: m.id || "",
        myPhrase: m.myPhrase || "",
        naturalPhrase: m.naturalPhrase || "",
      }));
      if (usedList.length > 0 || repeatedList.length > 0) {
        const updateResult = await deps.applyCallMistakeUpdates(userId, usedList, repeatedList);
        console.log(
          `[ReviewPipeline] Applied B-5 mistake updates: ${updateResult.graduatedCount} graduated, ${updateResult.reopenedCount} reopened.`
        );
      }
    } catch (b5Err) {
      console.error("[ReviewPipeline] Failed to apply B-5 usedCorrectly/repeatedMistakes:", b5Err);
    }
  } else {
    review.usedCorrectlyItems = [];
    review.repeatedItems = [];
  }

  if (effects.advanceLesson) {
    review.lessonAdvanced = true;
  } else {
    delete review.lessonAdvanced;
  }

  if (isQa) {
    review.qaCall = true;
  } else {
    delete review.qaCall;
  }

  try {
    await deps.saveSessionReview(userId, sessionId, review, sttFinal);
    console.log(`[ReviewPipeline] Updated session ${sessionId} to status 'done' with review report.`);
    if (effects.advanceLesson) {
      await deps.advanceGoalAfterCompletedCall(userId, goalId, lessonIndex).catch((advErr) => {
        console.warn("[ReviewPipeline] advanceGoalAfterCompletedCall error:", advErr);
      });
    }
  } catch (saveErr) {
    console.error("[ReviewPipeline] Failed to save session review:", saveErr);
  }

  return { review, mistakeDocs };
}
