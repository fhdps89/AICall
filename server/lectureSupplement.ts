/**
 * Phase 2 supplemental transcript analysis for morning lecture material.
 * Finds remaining unnatural/incorrect learner utterances missed by the primary post-call review,
 * enforcing strict cost, timeout, verification, and deduplication guards.
 */
import { GoogleGenAI, Type } from '@google/genai';
import { TEXT_MODEL } from '../src/config/models.ts';
import { SHORT_SESSION_SEC } from '../src/services/lecture/lecturePick.ts';
import { hasLearnerSpeech } from '../src/services/review/speechCheck.ts';
import {
  SUPPLEMENT_MAX_ITEMS,
  mergeSupplementItems,
  type MergedSupplementItem,
} from '../src/services/lecture/lectureSource.ts';
import { LECTURE_STEP_TIMEOUT_MS, withTimeout } from './lecture.ts';

export const SUPPLEMENT_TIMEOUT_MS = LECTURE_STEP_TIMEOUT_MS;
export const SUPPLEMENT_MAX_CORPUS_CHARS = 8000;
export { SUPPLEMENT_MAX_ITEMS };

export interface ShouldSkipSupplementInput {
  qa?: boolean;
  durationSec?: number | null;
  corpus?: string;
}

/**
 * Returns a skip reason string when supplemental analysis should not run, or null otherwise.
 */
export function shouldSkipSupplement(input: ShouldSkipSupplementInput): string | null {
  if (input.qa === true) return 'qa';
  if (
    typeof input.durationSec === 'number' &&
    Number.isFinite(input.durationSec) &&
    input.durationSec < SHORT_SESSION_SEC
  ) {
    return 'short_session';
  }
  const corpus = String(input.corpus || '').trim();
  if (!corpus || !hasLearnerSpeech(corpus)) {
    return 'no_usable_speech';
  }
  return null;
}

export interface BuildSupplementPromptInput {
  corpus: string;
  knownPhrases?: string[];
  lessonTitle?: string;
  sourceStt?: string;
}

export function buildSupplementPrompt(input: BuildSupplementPromptInput): string {
  const knownList = (input.knownPhrases || [])
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  const formattedKnown = knownList.length > 0
    ? knownList.map((p, i) => `${i + 1}. "${p}"`).join('\n')
    : '(None)';
  const sourceStt = input.sourceStt || 'sttFinal';

  return `You are an expert 1:1 English speaking coach and post-call review analyst.
The primary post-call review has already extracted some mistakes from this call.
Your job is to scan the ENTIRE learner transcript below and find any REMAINING grammatical errors, awkward collocations, missing prepositions/articles, or unnatural phrasing that were NOT already covered.

Lesson Topic: ${input.lessonTitle || '(General conversation)'}

[Already Known Mistakes (DO NOT repeat or return STT variants of these)]:
${formattedKnown}

[Learner Transcript (VERBATIM)]:
${input.corpus}

STRICT RULES:
1. "myPhrase" MUST be copied WORD-FOR-WORD, EXACTLY VERBATIM from [Learner Transcript (VERBATIM)]. NEVER invent, edit, correct, or combine non-contiguous words.
2. "naturalPhrase": How an American native speaker / OPIc AL speaker would naturally express this thought.
3. "reason": 1-2 concise Korean sentences explaining why naturalPhrase is better (grammar, preposition, nuance, collocation).
4. "sourceStt": Set to "${sourceStt}".
5. SKIP all of the following:
   - Phrases already in [Already Known Mistakes] (including minor punctuation/filler differences).
   - Incomplete fragments or filler-only utterances ("uh", "um", "okay", "yeah").
   - Person names or proper nouns alone (e.g., "David Kim").
   - STT noise, sound tags, or non-English / CJK-only utterances.
   - Self-corrections where the learner quickly fixes themselves and ends with a correct sentence.
   - Meta talk about the lesson or timer being too short.
6. Return AT MOST ${SUPPLEMENT_MAX_ITEMS} items as a JSON array of {myPhrase, naturalPhrase, reason, sourceStt}. If no remaining mistakes exist, return [].`;
}

export type KnownPhraseInput = string | { myPhrase?: string; hidden?: boolean };

export interface RunLectureSupplementOpts {
  corpus: string;
  validationCorpus?: string;
  knownPhrases?: KnownPhraseInput[];
  lessonTitle?: string;
  durationSec?: number | null;
  qa?: boolean;
  sourceStt?: string;
}

export interface RunLectureSupplementResult {
  items: MergedSupplementItem[];
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

function normalizeKnown(
  known: KnownPhraseInput[] | undefined
): Array<{ myPhrase?: string; hidden?: boolean }> {
  return (known || []).map((k) =>
    typeof k === 'string' ? { myPhrase: k } : { myPhrase: k?.myPhrase, hidden: k?.hidden }
  );
}

/**
 * Run the supplemental Gemini pass with cost guards, 90s timeout, and transcript verification.
 * Never throws; failures fall back cleanly to status='failed' and empty items.
 */
export async function runLectureSupplement(
  ai: GoogleGenAI,
  opts: RunLectureSupplementOpts
): Promise<RunLectureSupplementResult> {
  const rawCorpus = String(opts.corpus || '').trim();
  const truncatedCorpus = rawCorpus.slice(0, SUPPLEMENT_MAX_CORPUS_CHARS).trim();
  if (!rawCorpus || !truncatedCorpus) {
    return { items: [], status: 'skipped', reason: 'empty_corpus' };
  }
  const skipReason = shouldSkipSupplement({
    qa: opts.qa,
    durationSec: opts.durationSec,
    corpus: truncatedCorpus,
  });
  if (skipReason) {
    return { items: [], status: 'skipped', reason: skipReason };
  }

  const known = normalizeKnown(opts.knownPhrases);
  const knownStrings = known.map((k) => String(k.myPhrase || '').trim()).filter(Boolean);
  const sourceStt = opts.sourceStt || 'sttFinal';
  const prompt = buildSupplementPrompt({
    corpus: truncatedCorpus,
    knownPhrases: knownStrings,
    lessonTitle: opts.lessonTitle,
    sourceStt,
  });

  try {
    const response = await withTimeout(
      ai.models.generateContent({
        model: TEXT_MODEL,
        contents: [{ role: 'user', parts: [{ text: 'Find remaining learner mistakes and return JSON.' }] }],
        config: {
          systemInstruction: prompt,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                myPhrase: { type: Type.STRING },
                naturalPhrase: { type: Type.STRING },
                reason: { type: Type.STRING },
                sourceStt: { type: Type.STRING },
              },
              required: ['myPhrase', 'naturalPhrase', 'reason', 'sourceStt'],
            },
          },
        },
      }),
      SUPPLEMENT_TIMEOUT_MS,
      'lecture supplement'
    );

    const parsed = JSON.parse(typeof response?.text === 'string' ? response.text.trim() || '[]' : '[]');
    const validationCorpus = opts.validationCorpus ? `${truncatedCorpus}\n${opts.validationCorpus}` : truncatedCorpus;
    const items = mergeSupplementItems(known, parsed, validationCorpus).map((it) => ({
      ...it,
      sourceStt: it.sourceStt || sourceStt,
    }));

    const usage = response?.usageMetadata
      ? {
          inputTokens: Number(response.usageMetadata.promptTokenCount || 0),
          outputTokens: Number(response.usageMetadata.candidatesTokenCount || 0),
        }
      : undefined;

    return {
      items,
      status: 'ok',
      ...(usage ? { usage } : {}),
    };
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    console.warn('[LectureSupplement] failed:', msg);
    return {
      items: [],
      status: 'failed',
      error: /timed out/i.test(msg) ? 'TIMED_OUT' : 'SUPPLEMENT_FAILED',
    };
  }
}
