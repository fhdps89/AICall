export const POC_STT_MODEL = "gemini-3.5-transcribe-live" as const;
export const POC_TTS_MODEL = "gemini-3.8-flash-tts" as const;

/** Reply-text A/B test (EL-18): the client sends only "a" or "b"; the server maps it here. */
export type PocTextVariant = "a" | "b";
export const POC_DEFAULT_TEXT_VARIANT: PocTextVariant = "a";
/**
 * Thinking level = lowest-latency level each model supports (ai.google.dev thinking, 2026-11-27):
 * - a: gemini-3.8-flash supports low/medium/high only ("minimal" returns an error); low is
 *   "fewest tokens, lowest latency" (whats-new-gemini-3.8).
 * - b: gemini-3.5-flash-lite supports minimal/low/medium/high, default minimal = "near-off
 *   thinking, lowest latency" (whats-new-gemini-3.6, migrate-to-gemini-3-5-flash-lite).
 */
export const POC_TEXT_VARIANTS = {
  a: { model: "gemini-3.8-flash", thinkingLevel: "low" },
  b: { model: "gemini-3.5-flash-lite", thinkingLevel: "minimal" },
} as const;

/** Anything other than "a"/"b" (any case, trimmed) falls back to A. */
export function parsePocTextVariant(raw: unknown): PocTextVariant {
  return typeof raw === "string" && raw.trim().toLowerCase() === "b" ? "b" : "a";
}

/** Default variant (A) model, kept for existing imports. */
export const POC_TEXT_MODEL = POC_TEXT_VARIANTS.a.model;
export const POC_TEXT_THINKING_LEVEL = POC_TEXT_VARIANTS.a.thinkingLevel;
export const POC_WS_PATH = "/api/gemini/cascade" as const;

/**
 * USD per 1M tokens (paid tier, standard), ai.google.dev/gemini-api/docs/pricing checked
 * 2026-11-27: transcribe-live $3.50 audio in / $21 text out; gemini-3.8-flash $0.75 in /
 * $3.75 out incl. thinking (2027: $1.50 / $7.50); gemini-3.5-flash-lite $0.30 in / $2.50 out
 * incl. thinking (no 2027 change listed); gemini-3.8-flash-tts $0.50 text in / $9.00 audio out
 * (2027: $1.00 / $18.00).
 * legacy* = models of test-mode records written before the A/B split (PR #63 on main:
 * gemini-3.1-flash-lite $0.25 / $1.50, gemini-3.8-flash-lite-tts $0.50 / $6.00, 2027 $1.00 / $12.00).
 */
export const POC_RATES = {
  sttInAudioPer1M: 3.5,
  sttOutTextPer1M: 21,
  textInPer1M_2026: 0.75,
  textOutPer1M_2026: 3.75,
  textInPer1M_2027: 1.5,
  textOutPer1M_2027: 7.5,
  textBInPer1M: 0.3,
  textBOutPer1M: 2.5,
  legacyTextInPer1M: 0.25,
  legacyTextOutPer1M: 1.5,
  legacyTtsInPer1M_2026: 0.5,
  legacyTtsOutAudioPer1M_2026: 6,
  legacyTtsInPer1M_2027: 1,
  legacyTtsOutAudioPer1M_2027: 12,
  ttsInPer1M_2026: 0.5,
  ttsOutAudioPer1M_2026: 9,
  ttsInPer1M_2027: 1,
  ttsOutAudioPer1M_2027: 18,
} as const;

export const POC_AUDIO_TOKENS_PER_SEC = 25;

/** 2027-01-01 00:00:00 KST (= 2026-12-31T15:00:00Z): text and TTS prices double. */
const POC_2027_START_MS = Date.UTC(2026, 11, 31, 15, 0, 0);

export interface PocUsageTotals {
  sttAudioSec: number;
  sttOutTokens: number;
  sttOutEstimated: boolean;
  textInTokens: number;
  textOutTokens: number;
  ttsInTokens: number;
  ttsAudioSec: number;
  turns: number;
}

function nonNeg(v: unknown): number {
  if (typeof v === "boolean" || v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function emptyPocUsage(): PocUsageTotals {
  return {
    sttAudioSec: 0,
    sttOutTokens: 0,
    sttOutEstimated: false,
    textInTokens: 0,
    textOutTokens: 0,
    ttsInTokens: 0,
    ttsAudioSec: 0,
    turns: 0,
  };
}

function is2027(nowMs: number): boolean {
  return Number.isFinite(nowMs) && nowMs >= POC_2027_START_MS;
}

/**
 * Which rate set prices a record: "a"/"b" = that text variant (+ current TTS), "legacy" = a
 * record without a variant tag (written before the A/B split: 3.1-flash-lite + flash-lite-tts).
 */
export type PocPricing = PocTextVariant | "legacy";

/** 2027 text rates apply from 2027-01-01 00:00 KST (= 2026-12-31T15:00:00Z) */
export function pocTextRates(
  nowMs: number,
  pricing: PocPricing = "a",
): { inPer1M: number; outPer1M: number } {
  if (pricing === "b") return { inPer1M: POC_RATES.textBInPer1M, outPer1M: POC_RATES.textBOutPer1M };
  if (pricing === "legacy") {
    return { inPer1M: POC_RATES.legacyTextInPer1M, outPer1M: POC_RATES.legacyTextOutPer1M };
  }
  return is2027(nowMs)
    ? { inPer1M: POC_RATES.textInPer1M_2027, outPer1M: POC_RATES.textOutPer1M_2027 }
    : { inPer1M: POC_RATES.textInPer1M_2026, outPer1M: POC_RATES.textOutPer1M_2026 };
}

/** 2027 TTS rates apply from 2027-01-01 00:00 KST (= 2026-12-31T15:00:00Z) */
export function pocTtsRates(
  nowMs: number,
  pricing: PocPricing = "a",
): { inPer1M: number; outAudioPer1M: number } {
  if (pricing === "legacy") {
    return is2027(nowMs)
      ? { inPer1M: POC_RATES.legacyTtsInPer1M_2027, outAudioPer1M: POC_RATES.legacyTtsOutAudioPer1M_2027 }
      : { inPer1M: POC_RATES.legacyTtsInPer1M_2026, outAudioPer1M: POC_RATES.legacyTtsOutAudioPer1M_2026 };
  }
  if (is2027(nowMs)) {
    return {
      inPer1M: POC_RATES.ttsInPer1M_2027,
      outAudioPer1M: POC_RATES.ttsOutAudioPer1M_2027,
    };
  }
  return {
    inPer1M: POC_RATES.ttsInPer1M_2026,
    outAudioPer1M: POC_RATES.ttsOutAudioPer1M_2026,
  };
}

/**
 * [cost] sttAudioSec*25*3.5/1M + sttOutTokens*21/1M + textIn*textInRate/1M + textOut*textOutRate/1M
 *        + ttsIn*ttsInRate/1M + ttsAudioSec*25*ttsOutRate/1M (text/TTS rates by date, see above).
 * Non-finite/negative inputs count as 0.
 */
export function pocCostUsd(
  u: Partial<PocUsageTotals> | null | undefined,
  nowMs: number = Date.now(),
  pricing: PocPricing = "a",
): number {
  if (!u || typeof u !== "object") return 0;
  const ts = Number.isFinite(nowMs) ? nowMs : Date.now();
  const text = pocTextRates(ts, pricing);
  const tts = pocTtsRates(ts, pricing);

  const sttAudioSec = nonNeg(u.sttAudioSec);
  const sttOutTokens = nonNeg(u.sttOutTokens);
  const textInTokens = nonNeg(u.textInTokens);
  const textOutTokens = nonNeg(u.textOutTokens);
  const ttsInTokens = nonNeg(u.ttsInTokens);
  const ttsAudioSec = nonNeg(u.ttsAudioSec);

  return (
    (sttAudioSec * POC_AUDIO_TOKENS_PER_SEC * POC_RATES.sttInAudioPer1M +
      sttOutTokens * POC_RATES.sttOutTextPer1M +
      textInTokens * text.inPer1M +
      textOutTokens * text.outPer1M +
      ttsInTokens * tts.inPer1M +
      ttsAudioSec * POC_AUDIO_TOKENS_PER_SEC * tts.outAudioPer1M) /
    1_000_000
  );
}

export function sanitizePocUsage(raw: unknown): PocUsageTotals {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyPocUsage();
  }
  const r = raw as Record<string, unknown>;
  return {
    sttAudioSec: nonNeg(r.sttAudioSec),
    sttOutTokens: nonNeg(r.sttOutTokens),
    sttOutEstimated: Boolean(r.sttOutEstimated),
    textInTokens: nonNeg(r.textInTokens),
    textOutTokens: nonNeg(r.textOutTokens),
    ttsInTokens: nonNeg(r.ttsInTokens),
    ttsAudioSec: nonNeg(r.ttsAudioSec),
    turns: Math.floor(nonNeg(r.turns)),
  };
}
