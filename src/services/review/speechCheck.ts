/**
 * Pure speech-presence guard and STT fallback source selector for post-call review.
 * Kept free of Firebase / React / browser globals so it can be unit-tested with `npm test`.
 */

/** Minimum number of word tokens (English words or Korean eojeol) to treat as learner speech. */
export const MIN_SPEECH_WORDS = 3;

/** Minimum total letter/digit characters (after stripping headers, sound tags, punctuation, spaces). */
export const MIN_SPEECH_CHARS = 8;

/** Short filler/backchannel words excluded from the word count so repeated fillers alone do not count as speech. */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  "uh",
  "uhh",
  "um",
  "umm",
  "hm",
  "hmm",
  "hmmm",
  "ah",
  "ahh",
  "er",
  "err",
  "oh",
  "eh",
  "mm",
  "mmm",
  "mhm",
  "huh",
  "yeah",
  "yep",
  "yup",
  "ok",
  "okay",
  "음",
  "어",
  "아",
  "으",
  "에",
  "응",
  "흠",
]);

const TIME_HEADER_PATTERN = /\[\s*\d{1,3}:\d{2}\s*-\s*\d{1,3}:\d{2}\s*\]/g;
const SOUND_ANNOTATION_PATTERN = /\[[^\]]*\]|\([^)]*\)|<[^>]*>/g;
const NON_WORD_CHAR_PATTERN = /[^\p{L}\p{N}\s]+/gu;
const HAS_LETTER_PATTERN = /\p{L}/u;

export type DecidedSttSourceKind =
  | "sttFinal"
  | "sttPartial_fallback"
  | "liveTranscript_fallback"
  | "none";

export interface PartialTranscriptSegment {
  minuteIndex: number;
  timeRange?: string;
  transcript: string;
}

export interface LiveTranscriptTurn {
  role: "user" | "model";
  text: string;
  timestamp?: number;
}

export interface DecideSttSourceInput {
  finalText?: string | null;
  finalSource?: "sttFinal" | "sttPartial_fallback";
  partials?: PartialTranscriptSegment[];
  liveTranscript?: LiveTranscriptTurn[];
}

export interface DecideSttSourceResult {
  text: string;
  source: DecidedSttSourceKind;
}

/** Remove `[mm:ss - mm:ss]` minute headers inserted into sttPartial fallback text. */
export function stripTimeHeaders(text: string): string {
  if (typeof text !== "string" || !text) return "";
  return text
    .replace(TIME_HEADER_PATTERN, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Return true only when the transcript contains actual learner speech rather than silence,
 * minute headers, sound tags (`[noise]`, `(silence)`, `[music]`, `<unk>`), or filler repetitions.
 */
export function hasLearnerSpeech(text: string): boolean {
  if (typeof text !== "string" || !text) return false;
  const withoutHeaders = stripTimeHeaders(text);
  const withoutAnnotations = withoutHeaders.replace(SOUND_ANNOTATION_PATTERN, " ");
  const normalized = withoutAnnotations
    .replace(/([\p{L}])['’](?=[\p{L}])/gu, "$1")
    .replace(NON_WORD_CHAR_PATTERN, " ")
    .trim();
  if (!normalized) return false;

  const words = normalized
    .split(/\s+/)
    .filter((w) => HAS_LETTER_PATTERN.test(w) && !FILLER_WORDS.has(w.toLowerCase()));
  if (words.length < MIN_SPEECH_WORDS) return false;

  const totalChars = words.reduce((sum, w) => sum + w.length, 0);
  return totalChars >= MIN_SPEECH_CHARS;
}

/**
 * Choose the best STT source that actually contains learner speech:
 * finalText -> sttPartial_fallback (checked without time headers) -> liveTranscript_fallback (user turns only) -> none.
 */
export function decideSttSource(input: DecideSttSourceInput): DecideSttSourceResult {
  const trimmedFinal = (input.finalText ?? "").trim();
  if (trimmedFinal && hasLearnerSpeech(trimmedFinal)) {
    return {
      text: trimmedFinal,
      source: input.finalSource ?? "sttFinal",
    };
  }

  const partials = input.partials ?? [];
  if (partials.length > 0) {
    const sorted = [...partials].sort((a, b) => a.minuteIndex - b.minuteIndex);
    // Judge speech using only the transcript bodies, ignoring `[mm:ss - mm:ss]` headers.
    const transcriptOnly = sorted
      .map((p) => (p.transcript ?? "").trim())
      .filter(Boolean)
      .join("\n");

    if (hasLearnerSpeech(transcriptOnly)) {
      const formatted = sorted
        .map((p) => (p.timeRange ? `[${p.timeRange}] ${p.transcript}` : p.transcript))
        .join("\n\n");
      return {
        text: formatted,
        source: "sttPartial_fallback",
      };
    }
  }

  const userUtterances = (input.liveTranscript ?? [])
    .filter((t) => t.role === "user")
    .map((t) => (t.text ?? "").trim())
    .filter(Boolean);
  const liveText = userUtterances.join("\n");
  if (liveText && hasLearnerSpeech(liveText)) {
    return {
      text: liveText,
      source: "liveTranscript_fallback",
    };
  }

  return {
    text: "",
    source: "none",
  };
}
