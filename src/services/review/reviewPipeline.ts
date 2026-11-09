import { authFetch } from "../api/authFetch";
/**
 * B-4 Post-Call Review Pipeline
 * 
 * 1. Final Audio Transcription (기록용 받아쓰기):
 *    - Decodes the 10-second recording chunks in order and merges them into 1-minute WAV files
 *      (standalone WebM chunks cannot be byte-joined; decoders would read only the first one).
 *    - Calls gemini-3.5-transcribe VERBATIM per minute (word-for-word, no corrections) and joins the text.
 *    - Saves to sessions.sttFinal.
 *    - Fallback: If final transcribe fails, stitches sttPartial together and marks sourceStt: 'sttPartial_fallback'.
 * 
 * 2. Structured Review Report Generation:
 *    - Calls gemini-3.8-flash with [sttFinal + Live dialogue log + today lesson directive + existing mistakes].
 *    - Strict rules:
 *      * mistakes[].myPhrase: EXACT word-for-word copy from sttFinal, never altered.
 *      * keyExpressions: exactly 5 items.
 *      * usedCorrectly: IDs of reviewing mistakes correctly spoken.
 *      * repeatedMistakes: IDs of graduated mistakes repeated.
 * 
 * 3. Persistence:
 *    - Saves mistakes to mistakes collection (stage 1, status reviewing, source call).
 *    - Updates session document with review data and status done.
 */

import { recordUsage } from "../usage/usageService";
import {
  getSessionById,
  saveSessionReview,
  saveCallMistakes,
  getUserMistakes,
  applyCallMistakeUpdates,
  getKSTTomorrow,
  SessionReviewData,
  SttFinalData,
  MistakeData,
  GoalData,
  advanceGoalAfterCompletedCall,
  deleteCallMistakesForSession,
} from "../firebase/db";
import { PromptPlaceholders } from "../../data/promptCustomizer";
import { buildTodayLessonSystemPrompt } from "../../data/lessonPromptBuilder";
import { mergeChunksToWav, groupChunks } from "../recording/audioMerge";
import { keepKnownIds, mergeMinuteTranscripts, MinutePartial } from "./reviewRules";

/** Most existing mistakes listed for the model per group (newest first). */
const MAX_LISTED_MISTAKES = 150;

function slimMistake(m: MistakeData) {
  return { id: m.id, myPhrase: m.myPhrase, naturalPhrase: m.naturalPhrase, reason: m.reason };
}

export interface RunReviewParams {
  userId: string;
  sessionId: string;
  goal: GoalData;
  lessonIndex: number;
  placeholders: PromptPlaceholders;
  audioBlobs?: Blob[];
  liveTranscript?: Array<{ role: "user" | "model"; text: string; timestamp?: number }>;
  onProgress?: (step: string) => void;
}

export interface ReviewPipelineResult {
  review: SessionReviewData;
  sttFinal: SttFinalData;
  mistakes: MistakeData[];
}

/**
 * Helper to convert Blob to base64 string
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1] || "";
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function runPostCallReview(params: RunReviewParams): Promise<ReviewPipelineResult> {
  const {
    userId,
    sessionId,
    goal,
    lessonIndex,
    placeholders,
    audioBlobs = [],
    liveTranscript = [],
    onProgress,
  } = params;

  onProgress?.("1/3 녹음 조각 병합 및 최종 받아쓰기(gemini-3.5-transcribe) 진행 중...");

  // Step 1: Obtain recording chunks in chronological order
  let chunkBlobs: Blob[] = audioBlobs.filter((b) => b && b.size > 0);

  if (chunkBlobs.length === 0) {
    // Attempt to download chunks from Cloud Storage / server endpoint
    try {
      const sessionDoc = await getSessionById(userId, sessionId);
      if (sessionDoc && sessionDoc.recordingChunks && sessionDoc.recordingChunks.length > 0) {
        const sortedChunks = [...sessionDoc.recordingChunks].sort((a, b) => a.index - b.index);
        const downloaded: Blob[] = [];

        for (const chunk of sortedChunks) {
          try {
            const url = chunk.storageUrl || `/api/recordings/file?path=${encodeURIComponent(chunk.path)}`;
            // Server-stored fallback chunks need the auth token; Firebase Storage URLs do not.
            const res = url.startsWith("/api/") ? await authFetch(url) : await fetch(url);
            if (res.ok) {
              const b = await res.blob();
              downloaded.push(b);
            }
          } catch (dlErr) {
            console.warn(`[ReviewPipeline] Could not download chunk #${chunk.index}:`, dlErr);
          }
        }

        chunkBlobs = downloaded;
      }
    } catch (fetchErr) {
      console.warn("[ReviewPipeline] Failed to fetch session chunks:", fetchErr);
    }
  }

  // Step 2: Final Transcription (VERBATIM) via /api/gemini/transcribe-final, one minute at a time
  let sttFinalText = "";
  let sourceStt: "sttFinal" | "sttPartial_fallback" | "liveTranscript_fallback" | "none" = "sttFinal";

  if (chunkBlobs.length > 0) {
    const groups = groupChunks(chunkBlobs);
    // One entry per minute: text ("" = silence) or null when the request failed twice.
    const minuteTexts: Array<string | null> = [];

    const transcribeMinute = async (group: Blob[]): Promise<string> => {
      const merged = await mergeChunksToWav(group);
      const audio = merged ? merged.wav : new Blob(group, { type: group[0].type || "audio/webm" });
      if (audio.size <= 1000) return "";
      const base64 = await blobToBase64(audio);
      const res = await authFetch("/api/gemini/transcribe-final", {
        method: "POST",
        body: JSON.stringify({ audioBase64: base64, mimeType: (audio.type || "audio/webm").split(";")[0] }),
      });
      const data = await res.json();
      if (!data.ok || typeof data.transcript !== "string") throw new Error(`transcribe-final ${res.status}`);
      return data.transcript.trim();
    };

    for (let i = 0; i < groups.length; i++) {
      onProgress?.(`1/3 받아쓰는 중 (${i + 1}/${groups.length}분)...`);
      let text: string | null = null;
      // One retry: a single dropped request must not cost the whole verbatim transcript.
      for (let attempt = 0; attempt < 2 && text === null; attempt++) {
        try {
          text = await transcribeMinute(groups[i]);
        } catch (minuteErr) {
          console.warn(`[ReviewPipeline] Final transcribe for minute ${i + 1} failed (try ${attempt + 1}):`, minuteErr);
        }
      }
      minuteTexts.push(text);
    }

    let partials: MinutePartial[] = [];
    if (minuteTexts.some((t) => t === null)) {
      try {
        partials = (await getSessionById(userId, sessionId))?.sttPartial || [];
      } catch (partErr) {
        console.warn("[ReviewPipeline] Could not load sttPartial to fill failed minutes:", partErr);
      }
    }
    const mergedStt = mergeMinuteTranscripts(minuteTexts, partials);
    if (mergedStt.missingMinutes.length > 0) {
      console.warn(`[ReviewPipeline] ${mergedStt.missingMinutes.length}/${groups.length} minutes could not be transcribed`);
    }
    if (mergedStt.text) {
      sttFinalText = mergedStt.text;
      sourceStt = mergedStt.source;
      // B-10 usage: verbatim transcription minutes (from session start/end)
      getSessionById(userId, sessionId)
        .then((sd) => {
          const end = sd?.endedAt || sd?.lastChunkAt;
          const mins = sd?.startedAt && end ? Math.max(0, (Date.parse(end) - Date.parse(sd.startedAt)) / 60000) : 0;
          if (mins > 0) return recordUsage(userId, { sttMinutes: mins, sttEngine: "gemini" });
        })
        .catch(() => {});
      console.log(`[ReviewPipeline] Final transcribe done (${groups.length} min, ${sttFinalText.length} chars, source=${sourceStt})`);
    }
  }

  // Fallback 1: If final transcribe failed or no audio, use sttPartial
  if (!sttFinalText) {
    try {
      const sessionDoc = await getSessionById(userId, sessionId);
      if (sessionDoc?.sttPartial && sessionDoc.sttPartial.length > 0) {
        const sortedPartial = [...sessionDoc.sttPartial].sort((a, b) => a.minuteIndex - b.minuteIndex);
        sttFinalText = sortedPartial
          .map((p) => `[${p.timeRange}] ${p.transcript}`)
          .join("\n\n");
        sourceStt = "sttPartial_fallback";
        console.log(`[ReviewPipeline] Using sttPartial fallback (${sortedPartial.length} segments)`);
      }
    } catch (partErr) {
      console.warn("[ReviewPipeline] Could not load sttPartial fallback:", partErr);
    }
  }

  // Fallback 2: If still no transcript, extract learner lines from liveTranscript
  if (!sttFinalText) {
    const userUtterances = liveTranscript
      .filter((t) => t.role === "user")
      .map((t) => t.text.trim())
      .filter(Boolean);

    if (userUtterances.length > 0) {
      sttFinalText = userUtterances.join("\n");
      sourceStt = "liveTranscript_fallback";
      console.log(`[ReviewPipeline] Using liveTranscript fallback (${userUtterances.length} turns)`);
    } else {
      sourceStt = "none";
    }
  }

  // Nothing the learner said was captured (hung up right away, or the mic was silent). There
  // is nothing to review: do not ask the model to invent mistakes, and do not count the lesson
  // as done (the next call offers the same lesson again).
  if (sourceStt === "none") {
    const emptyReview: SessionReviewData = {
      overallEvaluation:
        "이번 통화에서는 내가 말한 내용이 기록되지 않았어요. 그래서 진도는 그대로 두었어요. 마이크를 확인하고 같은 과로 다시 걸어 주세요.",
      estimatedLevel: "-",
      mistakes: [],
      keyExpressions: [],
      usedCorrectly: [],
      repeatedMistakes: [],
      keepSyncText: "",
      generatedAt: new Date().toISOString(),
      mistakesSaved: true,
      lessonAdvanced: false,
    };
    const emptyStt: SttFinalData = {
      transcript: "",
      sourceStt: "none",
      createdAt: new Date().toISOString(),
      engine: "gemini-3.5-transcribe",
      mode: "VERBATIM",
    };
    try {
      await saveSessionReview(userId, sessionId, emptyReview, emptyStt);
    } catch (saveErr) {
      console.error("[ReviewPipeline] Failed to save empty review:", saveErr);
    }
    return { review: emptyReview, sttFinal: emptyStt, mistakes: [] };
  }

  onProgress?.("2/3 AI 튜터 복기 리포트 생성 중 (gemini-3.8-flash)...");

  // Step 3: Fetch existing mistakes for usedCorrectly / repeatedMistakes detection
  let reviewingMistakes: MistakeData[] = [];
  let graduatedMistakes: MistakeData[] = [];

  try {
    const existing = await getUserMistakes(userId);
    // B-6 requirement 5: Include both reviewing and deferred so deferred mistakes can also graduate quickly
    // Mistakes from an earlier run of this same call's review are not "existing" ones: they are
    // replaced below, so they must not be graded as used correctly / repeated.
    const others = existing.filter((m) => m.sessionId !== sessionId);
    const newestFirst = (a: MistakeData, b: MistakeData) => (b.createdAt || "").localeCompare(a.createdAt || "");
    reviewingMistakes = others.filter((m) => m.status === "reviewing" || m.status === "deferred").sort(newestFirst).slice(0, MAX_LISTED_MISTAKES);
    graduatedMistakes = others.filter((m) => m.status === "graduated").sort(newestFirst).slice(0, MAX_LISTED_MISTAKES);
  } catch (err) {
    console.warn("[ReviewPipeline] Could not load user mistakes:", err);
  }

  // Step 4: Build today lesson directive prompt
  const todayLessonPrompt = buildTodayLessonSystemPrompt(goal, lessonIndex, placeholders, []);
  const currentLessonTitle = goal.lessons.find((l) => l.index === lessonIndex)?.title || `${lessonIndex}과`;

  // Step 5: Call /api/review
  const reviewResponse = await authFetch("/api/review", {
    method: "POST",
    body: JSON.stringify({
      trackId: goal.id,
      goalId: goal.id,
      lessonNum: lessonIndex,
      lessonTitle: currentLessonTitle,
      sttFinal: sttFinalText,
      sourceStt,
      liveTranscript,
      todayLessonPrompt,
      // Only what the prompt uses, and a bounded number, so the request does not grow with
      // every call the user has ever made.
      reviewingMistakes: reviewingMistakes.map(slimMistake),
      graduatedMistakes: graduatedMistakes.map(slimMistake),
    }),
  });

  const reviewJson = await reviewResponse.json().catch(() => ({} as any));
  if (!reviewJson.ok || !reviewJson.review) {
    throw new Error(reviewJson.error || "복기 리포트 생성에 실패했습니다.");
  }

  const review: SessionReviewData = reviewJson.review;
  if (reviewJson.usage) {
    recordUsage(userId, {
      textInputTokens: reviewJson.usage.inputTokens || 0,
      textOutputTokens: reviewJson.usage.outputTokens || 0,
    });
  }

  onProgress?.("3/3 복기 결과 및 실수 보관함 저장 중...");

  // Step 6: Save mistakes to mistakes collection (stage 1, status reviewing, nextReviewAt=내일)
  const tomorrow = getKSTTomorrow();
  const mistakeDocs: MistakeData[] = (review.mistakes || []).map((m) => ({
    myPhrase: m.myPhrase,
    naturalPhrase: m.naturalPhrase,
    reason: m.reason,
    sourceStt: m.sourceStt || sourceStt,
    stage: 1,
    status: "reviewing",
    nextReviewAt: tomorrow,
    nextReviewDate: tomorrow,
    source: "call",
    sessionId,
    goalId: goal.id,
    lessonIndex,
    lessonTitle: currentLessonTitle,
    createdAt: new Date().toISOString(),
  }));

  try {
    // Re-running the review for the same call (after an earlier failure) replaces what that run
    // saved instead of adding duplicates.
    const removed = await deleteCallMistakesForSession(userId, sessionId);
    if (removed > 0) console.log(`[ReviewPipeline] Replaced ${removed} mistakes from an earlier review of this call.`);
    if (mistakeDocs.length > 0) {
      const ids = await saveCallMistakes(userId, mistakeDocs);
      // Keep each mistake's id in the saved review, so 「이건 내가 한 말이 아니에요」 can remove it.
      review.mistakes = (review.mistakes || []).map((m, i) => (ids[i] ? { ...m, id: ids[i] } : m));
      console.log(`[ReviewPipeline] Saved ${mistakeDocs.length} new mistakes to mistakes collection.`);
    }
    review.mistakesSaved = true;
  } catch (mistakeErr) {
    review.mistakesSaved = false;
    console.error("[ReviewPipeline] Failed to save mistakes collection:", mistakeErr);
  }

  // B-5 Requirement 3: 빠른 졸업 & 다시 복습 (usedCorrectly -> graduated, repeatedMistakes -> reviewing stage 1)
  try {
    // The model returns ids; trust only ids from the lists it was given, and only in the right
    // direction (a "reviewing" item can graduate, a "graduated" one can be reopened).
    const usedList = keepKnownIds(review.usedCorrectly, reviewingMistakes.map((m) => m.id));
    const repeatedList = keepKnownIds(review.repeatedMistakes, graduatedMistakes.map((m) => m.id));
    review.usedCorrectly = usedList;
    review.repeatedMistakes = repeatedList;
    if (usedList.length > 0 || repeatedList.length > 0) {
      const updateResult = await applyCallMistakeUpdates(userId, usedList, repeatedList);
      console.log(`[ReviewPipeline] Applied B-5 mistake updates: ${updateResult.graduatedCount} graduated, ${updateResult.reopenedCount} reopened.`);
    }
  } catch (b5Err) {
    console.error("[ReviewPipeline] Failed to apply B-5 usedCorrectly/repeatedMistakes:", b5Err);
  }

  // Step 7: Save review & sttFinal to session document, mark done
  const sttFinalData: SttFinalData = {
    transcript: sttFinalText,
    sourceStt,
    createdAt: new Date().toISOString(),
    engine: "gemini-3.5-transcribe",
    mode: "VERBATIM",
  };

  review.lessonAdvanced = true;
  try {
    await saveSessionReview(userId, sessionId, review, sttFinalData);
    console.log(`[ReviewPipeline] Updated session ${sessionId} to status 'done' with review report.`);
    // B-9 Requirement 2: 완료한 날만 nextLessonIndex += 1 (스케줄 규칙: 하루 빠진 날은 과를 건너뛰지 않음)
    await advanceGoalAfterCompletedCall(userId, goal.id, lessonIndex).catch((advErr) => {
      console.warn("[ReviewPipeline] advanceGoalAfterCompletedCall error:", advErr);
    });
  } catch (saveErr) {
    console.error("[ReviewPipeline] Failed to save session review:", saveErr);
  }

  return {
    review,
    sttFinal: sttFinalData,
    mistakes: mistakeDocs,
  };
}
