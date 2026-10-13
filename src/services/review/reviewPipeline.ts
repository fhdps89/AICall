import { authFetch } from "../api/authFetch";
/**
 * B-4 Post-Call Review Pipeline
 * 
 * 1. Final Audio Transcription (기록용 받아쓰기):
 *    - Concatenates 10-second recording chunks in chronological order.
 *    - Calls gemini-3.5-transcribe VERBATIM (word-for-word, no corrections).
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
} from "../firebase/db";
import { PromptPlaceholders } from "../../data/promptCustomizer";
import { buildTodayLessonSystemPrompt } from "../../data/lessonPromptBuilder";

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

  // Step 1: Obtain or merge recording audio
  let finalAudioBlob: Blob | null = null;

  if (audioBlobs.length > 0) {
    const mime = audioBlobs[0].type || "audio/webm";
    finalAudioBlob = new Blob(audioBlobs, { type: mime });
  } else {
    // Attempt to download chunks from Cloud Storage / server endpoint
    try {
      const sessionDoc = await getSessionById(userId, sessionId);
      if (sessionDoc && sessionDoc.recordingChunks && sessionDoc.recordingChunks.length > 0) {
        const sortedChunks = [...sessionDoc.recordingChunks].sort((a, b) => a.index - b.index);
        const downloaded: Blob[] = [];

        for (const chunk of sortedChunks) {
          try {
            const url = chunk.storageUrl || `/api/recordings/file?path=${encodeURIComponent(chunk.path)}`;
            const res = await fetch(url);
            if (res.ok) {
              const b = await res.blob();
              downloaded.push(b);
            }
          } catch (dlErr) {
            console.warn(`[ReviewPipeline] Could not download chunk #${chunk.index}:`, dlErr);
          }
        }

        if (downloaded.length > 0) {
          finalAudioBlob = new Blob(downloaded, { type: downloaded[0].type || "audio/webm" });
        }
      }
    } catch (fetchErr) {
      console.warn("[ReviewPipeline] Failed to fetch session chunks:", fetchErr);
    }
  }

  // Step 2: Final Transcription (VERBATIM) via /api/gemini/transcribe-final
  let sttFinalText = "";
  let sourceStt: "sttFinal" | "sttPartial_fallback" | "liveTranscript_fallback" = "sttFinal";

  if (finalAudioBlob && finalAudioBlob.size > 1000) {
    try {
      const base64 = await blobToBase64(finalAudioBlob);
      const res = await authFetch("/api/gemini/transcribe-final", {
        method: "POST",
        body: JSON.stringify({
          audioBase64: base64,
          mimeType: finalAudioBlob.type || "audio/webm",
        }),
      });

      const data = await res.json();
      if (data.ok && typeof data.transcript === "string" && data.transcript.trim()) {
        sttFinalText = data.transcript.trim();
        sourceStt = "sttFinal";
        // B-10 usage: verbatim transcription minutes (from session start/end)
        getSessionById(userId, sessionId)
          .then((sd) => {
            const end = sd?.endedAt || sd?.lastChunkAt;
            const mins = sd?.startedAt && end ? Math.max(0, (Date.parse(end) - Date.parse(sd.startedAt)) / 60000) : 0;
            if (mins > 0) return recordUsage(userId, { sttMinutes: mins, sttEngine: "gemini" });
          })
          .catch(() => {});
        console.log(`[ReviewPipeline] Final verbatim transcribe successful (${sttFinalText.length} chars)`);
      }
    } catch (sttErr) {
      console.warn("[ReviewPipeline] Final audio transcribe failed, preparing fallback:", sttErr);
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
      sttFinalText = "(통화 녹음 및 실시간 발화 기록이 충분하지 않습니다)";
    }
  }

  onProgress?.("2/3 AI 튜터 복기 리포트 생성 중 (gemini-3.8-flash)...");

  // Step 3: Fetch existing mistakes for usedCorrectly / repeatedMistakes detection
  let reviewingMistakes: MistakeData[] = [];
  let graduatedMistakes: MistakeData[] = [];

  try {
    const existing = await getUserMistakes(userId);
    // B-6 requirement 5: Include both reviewing and deferred so deferred mistakes can also graduate quickly
    reviewingMistakes = existing.filter((m) => m.status === "reviewing" || m.status === "deferred");
    graduatedMistakes = existing.filter((m) => m.status === "graduated");
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
      reviewingMistakes,
      graduatedMistakes,
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
    if (mistakeDocs.length > 0) {
      await saveCallMistakes(userId, mistakeDocs);
      console.log(`[ReviewPipeline] Saved ${mistakeDocs.length} new mistakes to mistakes collection.`);
    }
  } catch (mistakeErr) {
    console.error("[ReviewPipeline] Failed to save mistakes collection:", mistakeErr);
  }

  // B-5 Requirement 3: 빠른 졸업 & 다시 복습 (usedCorrectly -> graduated, repeatedMistakes -> reviewing stage 1)
  try {
    const usedList = Array.isArray(review.usedCorrectly) ? review.usedCorrectly : [];
    const repeatedList = Array.isArray(review.repeatedMistakes) ? review.repeatedMistakes : [];
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
    sourceStt: sourceStt === "sttFinal" ? "sttFinal" : "sttPartial_fallback",
    createdAt: new Date().toISOString(),
    engine: "gemini-3.5-transcribe",
    mode: "VERBATIM",
  };

  try {
    await saveSessionReview(userId, sessionId, review, sttFinalData);
    console.log(`[ReviewPipeline] Updated session ${sessionId} to status 'done' with review report.`);
  } catch (saveErr) {
    console.error("[ReviewPipeline] Failed to save session review:", saveErr);
  }

  return {
    review,
    sttFinal: sttFinalData,
    mistakes: mistakeDocs,
  };
}
