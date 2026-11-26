/**
 * B-10 Usage tracking: users/{uid}/usage/{yyyy-mm}
 * {
 *   liveMinutes, qaLiveMinutes, liveMinutesSq, qaLiveMinutesSq,
 *   liveInputAudioTokens, liveInputTextTokens, liveOutputAudioTokens, liveOutputTextTokens, liveThoughtTokens,
 *   liveMeasuredMinutes, liveMeasuredMinutesSq, liveMeasuredCalls,
 *   qaLiveInputAudioTokens, qaLiveInputTextTokens, qaLiveOutputAudioTokens, qaLiveOutputTextTokens, qaLiveThoughtTokens,
 *   qaLiveMeasuredMinutes, qaLiveMeasuredMinutesSq,
 *   sttMinutes, partialSttMinutes,
 *   textTokens, textInputTokens, textOutputTokens,
 *   ttsChars, ttsAudioSec, ttsAudioChars,
 *   sieEmbeddingTokens, estCostUsd, calls,
 *   days: { "DD": { ... } }
 * }
 * Unit prices and assumptions come only from src/config/models.ts (single source).
 */
import { doc, getDoc, setDoc, increment, FieldValue } from "firebase/firestore";
import { db } from "../firebase/config";
import { PRICING_RATES, USAGE_ASSUMPTIONS } from "../../config/models";
import { getKSTToday } from "../firebase/db";
import { liveContextMinutesSq } from "./learningLog";

export interface UsageDelta {
  liveMinutes?: number;
  qaLiveMinutes?: number;
  liveMinutesSq?: number;
  qaLiveMinutesSq?: number;
  liveInputAudioTokens?: number;
  liveInputTextTokens?: number;
  liveOutputAudioTokens?: number;
  liveOutputTextTokens?: number;
  liveThoughtTokens?: number;
  liveMeasuredMinutes?: number;
  liveMeasuredMinutesSq?: number;
  liveMeasuredCalls?: number;
  qaLiveInputAudioTokens?: number;
  qaLiveInputTextTokens?: number;
  qaLiveOutputAudioTokens?: number;
  qaLiveOutputTextTokens?: number;
  qaLiveThoughtTokens?: number;
  qaLiveMeasuredMinutes?: number;
  qaLiveMeasuredMinutesSq?: number;
  sttMinutes?: number;
  /** minutes actually sent to /api/gemini/transcribe-partial successfully */
  partialSttMinutes?: number;
  sttEngine?: "gemini" | "assemblyai";
  textInputTokens?: number;
  textOutputTokens?: number;
  /** total tokens when the in/out split is unknown (priced at the legacy blended rate) */
  textTokens?: number;
  ttsChars?: number;
  ttsAudioSec?: number;
  /** chars whose audio length is already in ttsAudioSec (excluded from the legacy chars→seconds fallback) */
  ttsAudioChars?: number;
  ttsEngine?: "gemini" | "elevenlabs";
  sieEmbeddingTokens?: number;
  calls?: number;
}

export interface UsageDay {
  liveMinutes?: number;
  qaLiveMinutes?: number;
  liveMinutesSq?: number;
  qaLiveMinutesSq?: number;
  liveInputAudioTokens?: number;
  liveInputTextTokens?: number;
  liveOutputAudioTokens?: number;
  liveOutputTextTokens?: number;
  liveThoughtTokens?: number;
  liveMeasuredMinutes?: number;
  liveMeasuredMinutesSq?: number;
  liveMeasuredCalls?: number;
  qaLiveInputAudioTokens?: number;
  qaLiveInputTextTokens?: number;
  qaLiveOutputAudioTokens?: number;
  qaLiveOutputTextTokens?: number;
  qaLiveThoughtTokens?: number;
  qaLiveMeasuredMinutes?: number;
  qaLiveMeasuredMinutesSq?: number;
  sttMinutes?: number;
  partialSttMinutes?: number;
  textTokens?: number;
  textInputTokens?: number;
  textOutputTokens?: number;
  ttsChars?: number;
  ttsAudioSec?: number;
  ttsAudioChars?: number;
  sieEmbeddingTokens?: number;
  estCostUsd?: number;
  calls?: number;
}

export interface UsageMonth {
  liveMinutes: number;
  qaLiveMinutes?: number;
  liveMinutesSq?: number;
  qaLiveMinutesSq?: number;
  liveInputAudioTokens?: number;
  liveInputTextTokens?: number;
  liveOutputAudioTokens?: number;
  liveOutputTextTokens?: number;
  liveThoughtTokens?: number;
  liveMeasuredMinutes?: number;
  liveMeasuredMinutesSq?: number;
  liveMeasuredCalls?: number;
  qaLiveInputAudioTokens?: number;
  qaLiveInputTextTokens?: number;
  qaLiveOutputAudioTokens?: number;
  qaLiveOutputTextTokens?: number;
  qaLiveThoughtTokens?: number;
  qaLiveMeasuredMinutes?: number;
  qaLiveMeasuredMinutesSq?: number;
  sttMinutes: number;
  partialSttMinutes?: number;
  textTokens: number;
  textInputTokens?: number;
  textOutputTokens?: number;
  ttsChars: number;
  ttsAudioSec?: number;
  ttsAudioChars?: number;
  sieEmbeddingTokens?: number;
  estCostUsd: number;
  calls?: number;
  days?: Record<string, UsageDay>;
}

/**
 * Re-pricing limits (documented): QA minutes recorded before qaLiveMinutes was stored and the
 * AssemblyAI/ElevenLabs engine split are not in the usage doc, so priceUsage() prices only what is stored,
 * with gemini rates. ttsAudioChars here means "chars already covered by ttsAudioSec" (the client sends the
 * lecture's total chars), not the server's cache-miss char count.
 */
export interface UsageCostBreakdown {
  live: number;
  qaLive: number;
  stt: number;
  text: number;
  tts: number;
  sie: number;
  total: number;
}

type UsageCostComponentKey = Exclude<keyof UsageCostBreakdown, "total">;

const USAGE_COST_COMPONENT_LABELS = {
  live: "통화 비용",
  qaLive: "QA 통화 비용",
  stt: "받아쓰기 비용",
  text: "텍스트 비용",
  tts: "강의 음성 TTS 비용",
  sie: "실수 묶기 임베딩 비용",
} as const satisfies Record<UsageCostComponentKey, string>;

/** Ordered breakdown components (excluding total) shown in dev-mode usage cost tables. */
export const USAGE_COST_COMPONENTS: ReadonlyArray<{
  key: UsageCostComponentKey;
  label: string;
}> = (Object.keys(USAGE_COST_COMPONENT_LABELS) as UsageCostComponentKey[]).map((key) => ({
  key,
  label: USAGE_COST_COMPONENT_LABELS[key],
}));

/** Sum of every breakdown component; the single place the total is formed, so the UI rows always add up. */
export function sumUsageCostComponents(parts: Record<UsageCostComponentKey, number>): number {
  return USAGE_COST_COMPONENTS.reduce((acc, { key }) => acc + parts[key], 0);
}

export interface LiveTokenCounts {
  inAudio?: number;
  inText?: number;
  outAudio?: number;
  outText?: number;
  thoughts?: number;
}

export interface LiveUsageBasis {
  measuredMinutes: number;
  estimatedMinutes: number;
  measuredUsd: number;
  estimatedUsd: number;
}

function nonNeg(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function liveCost(minutes: number, sq: number): number {
  if (minutes <= 0) return 0;
  const r = PRICING_RATES;
  const a = USAGE_ASSUMPTIONS;
  const audioTokensPerMin = a.audioTokensPerSec * 60;
  const rho = a.liveModelTalkShare;
  const f = a.liveTurnsPerMin;
  const baseIn = (minutes * audioTokensPerMin * r.liveInAudioPer1M) / 1_000_000;
  const baseOut = (minutes * rho * audioTokensPerMin * r.liveOutAudioPer1M) / 1_000_000;
  const promptRebill = (minutes * f * a.liveSystemPromptTokens * r.liveInTextPer1M) / 1_000_000;
  const contextRebill =
    (f * audioTokensPerMin * (1 + rho) * (sq / 2) * r.liveInAudioPer1M) / 1_000_000;
  return baseIn + baseOut + promptRebill + contextRebill;
}

/** Duration/sq-based Live cost estimate (USD), used when measured tokens are unavailable or for comparison logs. */
export function liveCostEstimateUsd(minutes: number, sq: number): number {
  return liveCost(nonNeg(minutes), nonNeg(sq));
}

/** Exact Live cost (USD) computed from measured token counts (outText and thoughts share liveOutTextPer1M). */
export function liveMeasuredCostUsd(tokens: LiveTokenCounts | null | undefined): number {
  if (!tokens) return 0;
  const r = PRICING_RATES;
  const inAudio = nonNeg(tokens.inAudio);
  const inText = nonNeg(tokens.inText);
  const outAudio = nonNeg(tokens.outAudio);
  const outText = nonNeg(tokens.outText);
  const thoughts = nonNeg(tokens.thoughts);
  return (
    (inAudio * r.liveInAudioPer1M +
      inText * r.liveInTextPer1M +
      outAudio * r.liveOutAudioPer1M +
      (outText + thoughts) * r.liveOutTextPer1M) /
    1_000_000
  );
}

function geminiSttPerMinute(): number {
  const r = PRICING_RATES;
  const a = USAGE_ASSUMPTIONS;
  return (a.audioTokensPerSec * 60 * r.sttInAudioPer1M + a.sttOutTokensPerMin * r.sttOutTextPer1M) / 1_000_000;
}

function computeLiveParts(u: UsageDay | UsageMonth | null | undefined) {
  const liveMin = nonNeg(u?.liveMinutes);
  const calls = nonNeg(u?.calls);
  const liveMeasuredMin = nonNeg(u?.liveMeasuredMinutes);
  const liveMeasuredSq = nonNeg(u?.liveMeasuredMinutesSq);
  const liveMeasuredCalls = nonNeg(u?.liveMeasuredCalls);
  const liveMeasuredUsd = liveMeasuredCostUsd({
    inAudio: u?.liveInputAudioTokens,
    inText: u?.liveInputTextTokens,
    outAudio: u?.liveOutputAudioTokens,
    outText: u?.liveOutputTextTokens,
    thoughts: u?.liveThoughtTokens,
  });
  // Guard: if measured minutes >= liveMinutes, remainder is 0 (no double count, no negative).
  const remLiveMin = Math.max(0, liveMin - liveMeasuredMin);
  const remLiveCalls = Math.max(0, calls - liveMeasuredCalls);
  const remLiveSqRaw = Math.max(0, nonNeg(u?.liveMinutesSq) - liveMeasuredSq);
  // Lower bound for remainder recorded before liveMinutesSq existed: every remaining call at the
  // average length (Cauchy–Schwarz), with the same context-window cap as per-call recording.
  const remLiveSq =
    remLiveMin > 0
      ? Math.max(
          remLiveSqRaw,
          remLiveCalls > 0 ? remLiveCalls * liveContextMinutesSq(remLiveMin / remLiveCalls) : 0
        )
      : 0;
  const liveEstimatedUsd = liveCost(remLiveMin, remLiveSq);

  const qaMin = nonNeg(u?.qaLiveMinutes);
  const qaMeasuredMin = nonNeg(u?.qaLiveMeasuredMinutes);
  const qaMeasuredSq = nonNeg(u?.qaLiveMeasuredMinutesSq);
  const qaMeasuredUsd = liveMeasuredCostUsd({
    inAudio: u?.qaLiveInputAudioTokens,
    inText: u?.qaLiveInputTextTokens,
    outAudio: u?.qaLiveOutputAudioTokens,
    outText: u?.qaLiveOutputTextTokens,
    thoughts: u?.qaLiveThoughtTokens,
  });
  const remQaMin = Math.max(0, qaMin - qaMeasuredMin);
  const remQaSqRaw = Math.max(0, nonNeg(u?.qaLiveMinutesSq) - qaMeasuredSq);
  // qaCalls is not stored separately; qaLiveMinutes and qaLiveMinutesSq are written together, so this
  // fallback (all remaining QA minutes as one call, an upper bound) only guards malformed docs.
  const remQaSq = remQaMin > 0 ? (remQaSqRaw > 0 ? remQaSqRaw : liveContextMinutesSq(remQaMin)) : 0;
  const qaEstimatedUsd = liveCost(remQaMin, remQaSq);

  return {
    liveMeasuredMin,
    remLiveMin,
    liveMeasuredUsd,
    liveEstimatedUsd,
    live: liveMeasuredUsd + liveEstimatedUsd,
    qaMeasuredMin,
    remQaMin,
    qaMeasuredUsd,
    qaEstimatedUsd,
    qaLive: qaMeasuredUsd + qaEstimatedUsd,
  };
}

/** Breakdown of measured vs. estimated Live usage (normal + QA combined) for dev-mode UI. */
export function liveUsageBasis(u: UsageDay | UsageMonth | null | undefined): LiveUsageBasis {
  const parts = computeLiveParts(u);
  return {
    measuredMinutes: parts.liveMeasuredMin + parts.qaMeasuredMin,
    estimatedMinutes: parts.remLiveMin + parts.remQaMin,
    measuredUsd: parts.liveMeasuredUsd + parts.qaMeasuredUsd,
    estimatedUsd: parts.liveEstimatedUsd + parts.qaEstimatedUsd,
  };
}

export function priceUsage(u: UsageDay | UsageMonth | null | undefined): UsageCostBreakdown {
  const r = PRICING_RATES;
  const a = USAGE_ASSUMPTIONS;

  const { live, qaLive } = computeLiveParts(u);

  // Backward compatibility: legacy docs (before this change) never stored partialSttMinutes, so
  // months recorded while partial STT defaulted ON will now show lower STT cost than was actually
  // billed (by ≈ liveMinutes × per-minute STT). We accept this because the old unconditional
  // `+ liveMin + qaMin` also over-counted once partial STT was turned off; final-transcription
  // minutes are still stored in sttMinutes.
  const sttMin = nonNeg(u?.sttMinutes);
  const partialSttMin = nonNeg(u?.partialSttMinutes);
  const stt = (sttMin + partialSttMin) * geminiSttPerMinute();

  const textIn = nonNeg(u?.textInputTokens);
  const textOut = nonNeg(u?.textOutputTokens);
  const textTotal = nonNeg(u?.textTokens);
  const residual = Math.max(0, textTotal - textIn - textOut);
  const blendedPer1M =
    (1 - a.legacyTextOutputShare) * r.textInPer1M + a.legacyTextOutputShare * r.textOutPer1M;
  const text = (textIn * r.textInPer1M + textOut * r.textOutPer1M + residual * blendedPer1M) / 1_000_000;

  const ttsChars = nonNeg(u?.ttsChars);
  const ttsAudioSec = nonNeg(u?.ttsAudioSec);
  const ttsAudioChars = nonNeg(u?.ttsAudioChars);
  const legacyChars = Math.max(0, ttsChars - ttsAudioChars);
  const totalTtsSec = ttsAudioSec + legacyChars / a.legacyTtsCharsPerSec;
  const tts =
    (totalTtsSec * a.audioTokensPerSec * r.ttsOutAudioPer1M +
      ttsChars * a.ttsInTokensPerChar * r.ttsInPer1M) /
    1_000_000;

  const sie = (nonNeg(u?.sieEmbeddingTokens) * r.sieEmbedPer1MTokens) / 1_000_000;
  const parts = { live, qaLive, stt, text, tts, sie };
  return { ...parts, total: sumUsageCostComponents(parts) };
}

/**
 * Effective Live USD/min for the usage footnote: uses this month's live cost / liveMinutes
 * when positive, otherwise falls back to a 3-minute single-call example.
 */
export function liveCostPerMinute(u?: UsageDay | UsageMonth | null): number {
  const min = nonNeg(u?.liveMinutes);
  if (min > 0) {
    return priceUsage(u).live / min;
  }
  return priceUsage({ liveMinutes: 3, liveMinutesSq: 9, calls: 1 }).live / 3;
}

/** Lecture TTS output audio USD per minute of generated audio (gemini-3.8-flash-tts). */
export function lectureAudioCostPerMinute(): number {
  return (USAGE_ASSUMPTIONS.audioTokensPerSec * 60 * PRICING_RATES.ttsOutAudioPer1M) / 1_000_000;
}

export function estimateCostUsd(d: UsageDelta): number {
  const textIn = nonNeg(d.textInputTokens);
  const textOut = nonNeg(d.textOutputTokens);
  const textTotal = textIn + textOut + nonNeg(d.textTokens);
  const base = priceUsage({
    liveMinutes: d.liveMinutes,
    qaLiveMinutes: d.qaLiveMinutes,
    liveMinutesSq: d.liveMinutesSq,
    qaLiveMinutesSq: d.qaLiveMinutesSq,
    liveInputAudioTokens: d.liveInputAudioTokens,
    liveInputTextTokens: d.liveInputTextTokens,
    liveOutputAudioTokens: d.liveOutputAudioTokens,
    liveOutputTextTokens: d.liveOutputTextTokens,
    liveThoughtTokens: d.liveThoughtTokens,
    liveMeasuredMinutes: d.liveMeasuredMinutes,
    liveMeasuredMinutesSq: d.liveMeasuredMinutesSq,
    liveMeasuredCalls: d.liveMeasuredCalls,
    qaLiveInputAudioTokens: d.qaLiveInputAudioTokens,
    qaLiveInputTextTokens: d.qaLiveInputTextTokens,
    qaLiveOutputAudioTokens: d.qaLiveOutputAudioTokens,
    qaLiveOutputTextTokens: d.qaLiveOutputTextTokens,
    qaLiveThoughtTokens: d.qaLiveThoughtTokens,
    qaLiveMeasuredMinutes: d.qaLiveMeasuredMinutes,
    qaLiveMeasuredMinutesSq: d.qaLiveMeasuredMinutesSq,
    sttMinutes: d.sttMinutes,
    partialSttMinutes: d.partialSttMinutes,
    textTokens: textTotal,
    textInputTokens: textIn,
    textOutputTokens: textOut,
    ttsChars: d.ttsChars,
    ttsAudioSec: d.ttsAudioSec,
    ttsAudioChars: d.ttsAudioChars,
    sieEmbeddingTokens: d.sieEmbeddingTokens,
    calls: d.calls,
  });

  const stt =
    d.sttEngine === "assemblyai"
      ? nonNeg(d.sttMinutes) * PRICING_RATES.sttPerMinuteAssembly +
        nonNeg(d.partialSttMinutes) * geminiSttPerMinute()
      : base.stt;

  const tts =
    d.ttsEngine === "elevenlabs"
      ? (nonNeg(d.ttsChars) / 1000) * PRICING_RATES.ttsPer1kCharsElevenLabs
      : base.tts;

  return sumUsageCostComponents({ ...base, stt, tts });
}

export interface UsageFields<T> {
  liveMinutes: T;
  qaLiveMinutes: T;
  liveMinutesSq: T;
  qaLiveMinutesSq: T;
  liveInputAudioTokens: T;
  liveInputTextTokens: T;
  liveOutputAudioTokens: T;
  liveOutputTextTokens: T;
  liveThoughtTokens: T;
  liveMeasuredMinutes: T;
  liveMeasuredMinutesSq: T;
  liveMeasuredCalls: T;
  qaLiveInputAudioTokens: T;
  qaLiveInputTextTokens: T;
  qaLiveOutputAudioTokens: T;
  qaLiveOutputTextTokens: T;
  qaLiveThoughtTokens: T;
  qaLiveMeasuredMinutes: T;
  qaLiveMeasuredMinutesSq: T;
  sttMinutes: T;
  partialSttMinutes: T;
  textTokens: T;
  textInputTokens: T;
  textOutputTokens: T;
  ttsChars: T;
  ttsAudioSec: T;
  ttsAudioChars: T;
  sieEmbeddingTokens: T;
  estCostUsd: T;
  calls: T;
}

export type UsagePayload<T> = UsageFields<T> & {
  days: Record<string, UsageFields<T>>;
  updatedAt: string;
};

export function buildUsageFields(d: UsageDelta): UsageFields<FieldValue>;
export function buildUsageFields<T>(d: UsageDelta, inc: (n: number) => T): UsageFields<T>;
export function buildUsageFields<T>(
  d: UsageDelta,
  inc: (n: number) => T = increment as unknown as (n: number) => T
): UsageFields<T> {
  const textIn = nonNeg(d.textInputTokens);
  const textOut = nonNeg(d.textOutputTokens);
  const tokens = textIn + textOut + nonNeg(d.textTokens);
  const cost = estimateCostUsd(d);
  return {
    liveMinutes: inc(nonNeg(d.liveMinutes)),
    qaLiveMinutes: inc(nonNeg(d.qaLiveMinutes)),
    liveMinutesSq: inc(nonNeg(d.liveMinutesSq)),
    qaLiveMinutesSq: inc(nonNeg(d.qaLiveMinutesSq)),
    liveInputAudioTokens: inc(nonNeg(d.liveInputAudioTokens)),
    liveInputTextTokens: inc(nonNeg(d.liveInputTextTokens)),
    liveOutputAudioTokens: inc(nonNeg(d.liveOutputAudioTokens)),
    liveOutputTextTokens: inc(nonNeg(d.liveOutputTextTokens)),
    liveThoughtTokens: inc(nonNeg(d.liveThoughtTokens)),
    liveMeasuredMinutes: inc(nonNeg(d.liveMeasuredMinutes)),
    liveMeasuredMinutesSq: inc(nonNeg(d.liveMeasuredMinutesSq)),
    liveMeasuredCalls: inc(nonNeg(d.liveMeasuredCalls)),
    qaLiveInputAudioTokens: inc(nonNeg(d.qaLiveInputAudioTokens)),
    qaLiveInputTextTokens: inc(nonNeg(d.qaLiveInputTextTokens)),
    qaLiveOutputAudioTokens: inc(nonNeg(d.qaLiveOutputAudioTokens)),
    qaLiveOutputTextTokens: inc(nonNeg(d.qaLiveOutputTextTokens)),
    qaLiveThoughtTokens: inc(nonNeg(d.qaLiveThoughtTokens)),
    qaLiveMeasuredMinutes: inc(nonNeg(d.qaLiveMeasuredMinutes)),
    qaLiveMeasuredMinutesSq: inc(nonNeg(d.qaLiveMeasuredMinutesSq)),
    sttMinutes: inc(nonNeg(d.sttMinutes)),
    partialSttMinutes: inc(nonNeg(d.partialSttMinutes)),
    textTokens: inc(tokens),
    textInputTokens: inc(textIn),
    textOutputTokens: inc(textOut),
    ttsChars: inc(nonNeg(d.ttsChars)),
    ttsAudioSec: inc(nonNeg(d.ttsAudioSec)),
    ttsAudioChars: inc(nonNeg(d.ttsAudioChars)),
    sieEmbeddingTokens: inc(nonNeg(d.sieEmbeddingTokens)),
    estCostUsd: inc(cost),
    calls: inc(nonNeg(d.calls)),
  };
}

/**
 * 월 합계와 일별(days[day])에 동일한 증분 필드를 넣어 Firestore 저장 payload를 만든다.
 */
export function buildUsagePayload(
  d: UsageDelta,
  day: string,
  inc?: undefined,
  updatedAt?: string
): UsagePayload<FieldValue>;
export function buildUsagePayload<T>(
  d: UsageDelta,
  day: string,
  inc: (n: number) => T,
  updatedAt?: string
): UsagePayload<T>;
export function buildUsagePayload<T>(
  d: UsageDelta,
  day: string,
  inc: (n: number) => T = increment as unknown as (n: number) => T,
  updatedAt: string = new Date().toISOString()
): UsagePayload<T> {
  const fields = buildUsageFields(d, inc);
  return {
    ...fields,
    days: { [day]: fields },
    updatedAt,
  };
}

export const USAGE_UPDATED_EVENT = "aicall:usage-updated";

export async function recordUsage(uid: string, d: UsageDelta): Promise<void> {
  const today = getKSTToday(); // YYYY-MM-DD (KST)
  const month = today.slice(0, 7);
  const day = today.slice(8, 10);
  try {
    await setDoc(
      doc(db, "users", uid, "usage", month),
      buildUsagePayload(d, day),
      { merge: true }
    );
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(USAGE_UPDATED_EVENT));
    }
  } catch (err) {
    console.warn("[usage] record failed (non-fatal):", err);
  }
}

export async function getUsageMonth(uid: string, month = getKSTToday().slice(0, 7)): Promise<UsageMonth | null> {
  const snap = await getDoc(doc(db, "users", uid, "usage", month));
  return snap.exists() ? (snap.data() as UsageMonth) : null;
}

export async function getUsageMonths(
  uid: string,
  months: string[]
): Promise<Record<string, UsageMonth | null>> {
  // 최근 14일·연속 학습일 계산용으로 최대 3개월까지만 읽어 불필요한 Firestore 문서 조회를 제한한다.
  const unique = Array.from(new Set(months)).slice(0, 3);
  const entries = await Promise.all(
    unique.map(async (m) => [m, await getUsageMonth(uid, m)] as const)
  );
  return Object.fromEntries(entries);
}
