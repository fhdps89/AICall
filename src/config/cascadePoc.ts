export const POC_STT_MODEL = "gemini-3.5-transcribe-live" as const;
export const POC_TEXT_MODEL = "gemini-3.1-flash-lite" as const;
export const POC_TTS_MODEL = "gemini-3.8-flash-lite-tts" as const;
export const POC_WS_PATH = "/api/gemini/cascade" as const;

/** USD per 1M tokens, ai.google.dev/gemini-api/docs/pricing checked 2026-11-26 */
export const POC_RATES = {
  sttInAudioPer1M: 3.5,
  sttOutTextPer1M: 21,
  textInPer1M: 0.25,
  textOutPer1M: 1.5,
  ttsInPer1M_2026: 0.5,
  ttsOutAudioPer1M_2026: 6,
  ttsInPer1M_2027: 1,
  ttsOutAudioPer1M_2027: 12,
} as const;

export const POC_AUDIO_TOKENS_PER_SEC = 25;

/** 2027-01-01 00:00:00 KST (= 2026-12-31T15:00:00Z) */
const POC_TTS_2027_START_MS = Date.UTC(2026, 11, 31, 15, 0, 0);

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

/** 2027 TTS rates apply from 2027-01-01 00:00 KST (= 2026-12-31T15:00:00Z) */
export function pocTtsRates(nowMs: number): { inPer1M: number; outAudioPer1M: number } {
  if (Number.isFinite(nowMs) && nowMs >= POC_TTS_2027_START_MS) {
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
 * [cost] sttAudioSec*25*3.5/1M + sttOutTokens*21/1M + textIn*0.25/1M + textOut*1.5/1M
 *        + ttsIn*ttsInRate/1M + ttsAudioSec*25*ttsOutRate/1M.
 * Non-finite/negative inputs count as 0.
 */
export function pocCostUsd(
  u: Partial<PocUsageTotals> | null | undefined,
  nowMs: number = Date.now(),
): number {
  if (!u || typeof u !== "object") return 0;
  const ts = Number.isFinite(nowMs) ? nowMs : Date.now();
  const tts = pocTtsRates(ts);

  const sttAudioSec = nonNeg(u.sttAudioSec);
  const sttOutTokens = nonNeg(u.sttOutTokens);
  const textInTokens = nonNeg(u.textInTokens);
  const textOutTokens = nonNeg(u.textOutTokens);
  const ttsInTokens = nonNeg(u.ttsInTokens);
  const ttsAudioSec = nonNeg(u.ttsAudioSec);

  return (
    (sttAudioSec * POC_AUDIO_TOKENS_PER_SEC * POC_RATES.sttInAudioPer1M +
      sttOutTokens * POC_RATES.sttOutTextPer1M +
      textInTokens * POC_RATES.textInPer1M +
      textOutTokens * POC_RATES.textOutPer1M +
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
