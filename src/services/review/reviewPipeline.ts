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
  saveReviewTiming,
  saveCallMistakes,
  getUserMistakes,
  applyCallMistakeUpdates,
  getKSTTomorrow,
  SessionReviewData,
  SttFinalData,
  SttPartialItem,
  RecordingChunkMeta,
  MistakeData,
  GoalData,
  advanceGoalAfterCompletedCall,
  deleteCallMistakesForSession,
} from "../firebase/db";
import { PromptPlaceholders } from "../../data/promptCustomizer";
import { buildTodayLessonSystemPrompt } from "../../data/lessonPromptBuilder";
import { mergeChunksToWav, groupChunks } from "../recording/audioMerge";
import { isQaCall, isQaMode } from "../../data/qaMode";
import { mergeMinuteTranscripts, MinutePartial } from "./reviewRules";
import { decideSttSource } from "./speechCheck";
import { createStepTimer, ReviewTiming } from "./reviewTiming";
import { persistReviewOutcome } from "./persistReview";
import {
  createChunkDownloadTracker,
  failureReasonForStatus,
  formatChunkDownloadWarning,
  planChunkSources,
  shouldUseDownloadedChunks,
} from "./chunkSource";

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
  localChunks?: Array<{ index: number; blob: Blob }>;
  liveTranscript?: Array<{ role: "user" | "model"; text: string; timestamp?: number }>;
  onProgress?: (step: string) => void;
}

export interface ReviewPipelineResult {
  review: SessionReviewData;
  sttFinal: SttFinalData;
  mistakes: MistakeData[];
  timing?: ReviewTiming;
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
    localChunks = [],
    liveTranscript = [],
    onProgress,
  } = params;

  const timer = createStepTimer();
  const startedAt = new Date().toISOString();
  let minutes = 0;
  let transcribeRequests = 0;
  let outcome: ReviewTiming["outcome"] = "failed";
  let knownSourceStt: SttFinalData["sourceStt"] | undefined;
  let pendingResult: ReviewPipelineResult | undefined;

  try {
    onProgress?.("1/3 녹음 조각 병합 및 최종 받아쓰기 진행 중...");

    // Step 1: Obtain recording chunks in chronological order
    let chunkBlobs: Blob[] = [];
    timer.start("collectChunks");
    try {
      chunkBlobs = audioBlobs.filter((b) => b && b.size > 0);

      if (chunkBlobs.length === 0) {
        const validLocal = localChunks.filter((c) => c && c.blob && c.blob.size > 0);
        const localMap = new Map<number, Blob>(validLocal.map((c) => [c.index, c.blob]));
        let remoteChunks: RecordingChunkMeta[] | undefined;
        try {
          const sessionDoc = await getSessionById(userId, sessionId);
          remoteChunks = sessionDoc?.recordingChunks;
        } catch (fetchErr) {
          console.warn("[ReviewPipeline] Failed to fetch session chunks:", fetchErr);
        }

        const sources = planChunkSources(remoteChunks, Array.from(localMap.keys()));
        if (sources.length > 0) {
          const tracker = createChunkDownloadTracker(sources.length);
          const downloaded: Blob[] = [];

          for (const item of sources) {
            if (tracker.shouldStop()) break;
            if (item.kind === "local") {
              const localBlob = localMap.get(item.index);
              if (localBlob && localBlob.size > 0) {
                downloaded.push(localBlob);
                tracker.success();
              } else {
                tracker.skip("not_uploaded");
              }
              continue;
            }
            if (item.kind === "skip") {
              tracker.skip(item.reason);
              continue;
            }
            try {
              const res = await authFetch(item.url);
              if (res.ok) {
                const b = await res.blob();
                if (b.size > 0) {
                  downloaded.push(b);
                  tracker.success();
                } else {
                  tracker.failure("http_error");
                }
              } else {
                tracker.failure(failureReasonForStatus(res.status));
              }
            } catch {
              tracker.failure("network");
            }
          }

          const summary = tracker.finish();
          const warning = formatChunkDownloadWarning(summary);
          if (warning) {
            console.warn(warning);
          }
          chunkBlobs = shouldUseDownloadedChunks(summary) ? downloaded : [];
        }
      }
    } finally {
      timer.end("collectChunks");
    }

    // Step 2: Final Transcription (VERBATIM) via /api/gemini/transcribe-final, one minute at a time
    let sttFinalText = "";
    let sourceStt: "sttFinal" | "sttPartial_fallback" | "liveTranscript_fallback" | "none" = "none";
    let finalTextCandidate = "";
    let finalSourceCandidate: "sttFinal" | "sttPartial_fallback" = "sttFinal";

    if (chunkBlobs.length > 0) {
      timer.start("transcribe");
      try {
        const groups = groupChunks(chunkBlobs);
        minutes = groups.length;
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
            transcribeRequests += 1;
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
          // B-10 usage: verbatim transcription minutes (from session start/end)
          getSessionById(userId, sessionId)
            .then((sd) => {
              const end = sd?.endedAt || sd?.lastChunkAt;
              const mins = sd?.startedAt && end ? Math.max(0, (Date.parse(end) - Date.parse(sd.startedAt)) / 60000) : 0;
              if (mins > 0) return recordUsage(userId, { sttMinutes: mins, sttEngine: "gemini" });
            })
            .catch(() => {});

          finalTextCandidate = mergedStt.text;
          finalSourceCandidate = mergedStt.source;
          const decidedFinal = decideSttSource({
            finalText: finalTextCandidate,
            finalSource: finalSourceCandidate,
          });
          if (decidedFinal.source !== "none") {
            sttFinalText = decidedFinal.text;
            sourceStt = decidedFinal.source;
            knownSourceStt = sourceStt;
            console.log(`[ReviewPipeline] Final transcribe done (${groups.length} min, ${sttFinalText.length} chars, source=${sourceStt})`);
          } else {
            console.log(`[ReviewPipeline] Final transcribe had no meaningful learner speech (${mergedStt.text.length} chars); trying fallback`);
          }
        }
      } finally {
        timer.end("transcribe");
      }
    }

    // Fallback 1 & 2: only time if fallback path actually runs
    if (!sttFinalText) {
      timer.start("fallback");
      try {
        let fallbackPartials: SttPartialItem[] = [];
        try {
          const sessionDoc = await getSessionById(userId, sessionId);
          if (sessionDoc?.sttPartial && sessionDoc.sttPartial.length > 0) {
            fallbackPartials = sessionDoc.sttPartial;
          }
        } catch (partErr) {
          console.warn("[ReviewPipeline] Could not load sttPartial fallback:", partErr);
        }

        const decided = decideSttSource({
          finalText: finalTextCandidate,
          finalSource: finalSourceCandidate,
          partials: fallbackPartials,
          liveTranscript,
        });
        sttFinalText = decided.text;
        sourceStt = decided.source;
        if (sourceStt === "sttPartial_fallback") {
          console.log(`[ReviewPipeline] Using sttPartial fallback (${fallbackPartials.length} segments)`);
        } else if (sourceStt === "liveTranscript_fallback") {
          console.log("[ReviewPipeline] Using liveTranscript fallback");
        }
        knownSourceStt = sourceStt;
      } finally {
        timer.end("fallback");
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
      timer.start("save");
      try {
        await saveSessionReview(userId, sessionId, emptyReview, emptyStt);
      } catch (saveErr) {
        console.error("[ReviewPipeline] Failed to save empty review:", saveErr);
      } finally {
        timer.end("save");
      }
      outcome = "empty";
      pendingResult = { review: emptyReview, sttFinal: emptyStt, mistakes: [] };
      return pendingResult;
    }

    onProgress?.("2/3 AI 튜터 복기 리포트 생성 중...");

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

    // Step 4 & 5: Build today lesson directive prompt and call /api/review
    let currentLessonTitle = "";
    let review!: SessionReviewData;
    const sess = await getSessionById(userId, sessionId).catch(() => null);
    const qaNow = sess?.source === "qa" || isQaMode();
    const startMs = sess?.startedAt ? Date.parse(sess.startedAt) : Number.NaN;
    const endMs = sess?.endedAt ? Date.parse(sess.endedAt) : Date.now();
    const callDurationSec =
      Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
        ? Math.round((endMs - startMs) / 1000)
        : undefined;

    timer.start("review");
    try {
      const todayLessonPrompt = buildTodayLessonSystemPrompt(goal, lessonIndex, placeholders, []);
      currentLessonTitle = goal.lessons.find((l) => l.index === lessonIndex)?.title || `${lessonIndex}과`;

      const reviewResponse = await authFetch("/api/review", {
        method: "POST",
        body: JSON.stringify({
          trackId: goal.id,
          goalId: goal.id,
          lessonNum: lessonIndex,
          lessonTitle: currentLessonTitle,
          sttFinal: sttFinalText,
          sourceStt,
          sttPartial: sess?.sttPartial,
          liveTranscript,
          todayLessonPrompt,
          callDurationSec,
          qa: qaNow,
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

      review = reviewJson.review;
      if (review.extraMistakesStatus === "failed") {
        // Leave extras unset so lecture-sync can retry; keep the primary review (phase 1).
        review.extraMistakes = undefined;
      } else if (!Array.isArray(review.extraMistakes)) {
        review.extraMistakes = [];
      }
      if (review.extraMistakesStatus) {
        review.extraMistakesAttemptedAt = new Date().toISOString();
      }
      if (reviewJson.usage) {
        recordUsage(userId, {
          textInputTokens: reviewJson.usage.inputTokens || 0,
          textOutputTokens: reviewJson.usage.outputTokens || 0,
        });
      }
    } finally {
      timer.end("review");
    }

    onProgress?.("3/3 복기 결과 및 실수 보관함 저장 중...");

    const isQa = isQaCall(sess, isQaMode());
    let mistakeDocs: MistakeData[] = [];
    let sttFinalData!: SttFinalData;
    timer.start("save");
    try {
      const tomorrow = getKSTTomorrow();
      const nowIso = new Date().toISOString();
      sttFinalData = {
        transcript: sttFinalText,
        sourceStt,
        createdAt: nowIso,
        engine: "gemini-3.5-transcribe",
        mode: "VERBATIM",
      };
      const persisted = await persistReviewOutcome(
        {
          deleteCallMistakesForSession,
          saveCallMistakes,
          applyCallMistakeUpdates,
          saveSessionReview,
          advanceGoalAfterCompletedCall,
        },
        {
          userId,
          sessionId,
          goalId: goal.id,
          lessonIndex,
          lessonTitle: currentLessonTitle,
          review,
          sttFinal: sttFinalData,
          sourceStt,
          isQa,
          tomorrow,
          nowIso,
          reviewingMistakes,
          graduatedMistakes,
        }
      );
      review = persisted.review;
      mistakeDocs = persisted.mistakeDocs;
    } finally {
      timer.end("save");
    }

    outcome = "ok";
    pendingResult = {
      review,
      sttFinal: sttFinalData,
      mistakes: mistakeDocs,
    };
    return pendingResult;
  } finally {
    const { steps, totalMs } = timer.snapshot();
    const timing: ReviewTiming = {
      startedAt,
      totalMs,
      steps,
      minutes,
      transcribeRequests,
      outcome,
      ...(knownSourceStt !== undefined ? { sourceStt: knownSourceStt } : {}),
    };
    if (pendingResult) {
      pendingResult.timing = timing;
    }
    // Do not await: an offline updateDoc may hang, delaying the review result/error UI.
    void saveReviewTiming(userId, sessionId, timing).catch((timingErr) => {
      console.warn("[ReviewPipeline] Failed to save review timing:", timingErr);
    });
  }
}
