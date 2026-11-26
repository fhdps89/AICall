/**
 * Stored Firestore field names of the test-mode (PoC) usage counters per pricing set.
 * Shared by usageService (pricing, writes) and learningLog (per-call delta).
 */
import type { PocPricing, PocTextVariant, PocUsageTotals } from "../../config/cascadePoc";

export type PocCounter = "sttAudioSec" | "sttOutTokens" | "textInTokens" | "textOutTokens" | "ttsInTokens" | "ttsAudioSec";
export const POC_COUNTERS: readonly PocCounter[] = [
  "sttAudioSec",
  "sttOutTokens",
  "textInTokens",
  "textOutTokens",
  "ttsInTokens",
  "ttsAudioSec",
];

/** Stored field name of each test-mode counter per pricing set (legacy = untagged old records). */
export const POC_USAGE_FIELDS = {
  legacy: {
    sttAudioSec: "pocSttAudioSec",
    sttOutTokens: "pocSttOutTokens",
    textInTokens: "pocTextInTokens",
    textOutTokens: "pocTextOutTokens",
    ttsInTokens: "pocTtsInTokens",
    ttsAudioSec: "pocTtsAudioSec",
  },
  a: {
    sttAudioSec: "pocASttAudioSec",
    sttOutTokens: "pocASttOutTokens",
    textInTokens: "pocATextInTokens",
    textOutTokens: "pocATextOutTokens",
    ttsInTokens: "pocATtsInTokens",
    ttsAudioSec: "pocATtsAudioSec",
  },
  b: {
    sttAudioSec: "pocBSttAudioSec",
    sttOutTokens: "pocBSttOutTokens",
    textInTokens: "pocBTextInTokens",
    textOutTokens: "pocBTextOutTokens",
    ttsInTokens: "pocBTtsInTokens",
    ttsAudioSec: "pocBTtsAudioSec",
  },
} as const satisfies Record<PocPricing, Record<PocCounter, string>>;

export type PocVariantFieldName =
  | (typeof POC_USAGE_FIELDS)["a"][PocCounter]
  | (typeof POC_USAGE_FIELDS)["b"][PocCounter];

/** Per-variant test-mode counters (A/B), shared by the delta, day and month shapes. */
export type PocVariantUsage = Partial<Record<PocVariantFieldName, number>>;

function nonNeg(v: unknown): number {
  if (typeof v === "boolean" || v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Maps one call's test-mode totals to the stored field names of its variant. */
export function pocVariantUsageDelta(
  variant: PocTextVariant,
  poc: Partial<PocUsageTotals> | null | undefined
): PocVariantUsage {
  const names = POC_USAGE_FIELDS[variant === "b" ? "b" : "a"];
  const out: Record<string, number> = {};
  for (const c of POC_COUNTERS) {
    const v = nonNeg(poc?.[c] as number | undefined);
    if (v > 0) out[names[c]] = v;
  }
  return out as PocVariantUsage;
}

/** Stored field names of first-segment lite TTS counters (independent of text variant A/B). */
export const POC_TTS_LITE_FIELDS = {
  ttsLiteInTokens: "pocTtsLiteInTokens",
  ttsLiteAudioSec: "pocTtsLiteAudioSec",
} as const;

export type PocTtsLiteFieldName = (typeof POC_TTS_LITE_FIELDS)[keyof typeof POC_TTS_LITE_FIELDS];

export type PocTtsLiteUsage = Partial<Record<"pocTtsLiteInTokens" | "pocTtsLiteAudioSec", number>>;

/** Maps one call's lite TTS totals to stored field names (only positive values). */
export function pocTtsLiteUsageDelta(
  poc: Partial<PocUsageTotals> | null | undefined
): PocTtsLiteUsage {
  const out: PocTtsLiteUsage = {};
  const inTokens = nonNeg(poc?.ttsLiteInTokens);
  const audioSec = nonNeg(poc?.ttsLiteAudioSec);
  if (inTokens > 0) out.pocTtsLiteInTokens = inTokens;
  if (audioSec > 0) out.pocTtsLiteAudioSec = audioSec;
  return out;
}
