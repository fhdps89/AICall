/**
 * B-10 Usage tracking: users/{uid}/usage/{yyyy-mm}
 * { liveMinutes, qaLiveMinutes, liveMinutesSq, qaLiveMinutesSq, sttMinutes, textTokens, textInputTokens, textOutputTokens, ttsChars, ttsAudioSec, ttsAudioChars, estCostUsd, days: { "DD": { ... } } }
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
  sttMinutes?: number;
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
  sttMinutes?: number;
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
  sttMinutes: number;
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

function geminiSttPerMinute(): number {
  const r = PRICING_RATES;
  const a = USAGE_ASSUMPTIONS;
  return (a.audioTokensPerSec * 60 * r.sttInAudioPer1M + a.sttOutTokensPerMin * r.sttOutTextPer1M) / 1_000_000;
}

export function priceUsage(u: UsageDay | UsageMonth | null | undefined): UsageCostBreakdown {
  const r = PRICING_RATES;
  const a = USAGE_ASSUMPTIONS;

  const liveMin = nonNeg(u?.liveMinutes);
  const calls = nonNeg(u?.calls);
  // Lower bound for months/days recorded before liveMinutesSq existed: every call at the average length
  // (Cauchy–Schwarz), with the same context-window cap as per-call recording.
  const liveSq = Math.max(nonNeg(u?.liveMinutesSq), calls > 0 ? calls * liveContextMinutesSq(liveMin / calls) : 0);
  const live = liveCost(liveMin, liveSq);

  const qaMin = nonNeg(u?.qaLiveMinutes);
  const qaSqRaw = nonNeg(u?.qaLiveMinutesSq);
  // qaCalls is not stored separately; when qaLiveMinutesSq is missing on positive qaLiveMinutes,
  // use qaMin^2 as a 1-call lower bound so context re-billing is not dropped.
  const qaSq = qaMin > 0 ? (qaSqRaw > 0 ? qaSqRaw : liveContextMinutesSq(qaMin)) : 0;
  const qaLive = liveCost(qaMin, qaSq);

  const sttMin = nonNeg(u?.sttMinutes);
  const stt = (sttMin + liveMin + qaMin) * geminiSttPerMinute();

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
  const total = live + qaLive + stt + text + tts + sie;
  return { live, qaLive, stt, text, tts, sie, total };
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
    sttMinutes: d.sttMinutes,
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
        (nonNeg(d.liveMinutes) + nonNeg(d.qaLiveMinutes)) * geminiSttPerMinute()
      : base.stt;

  const tts =
    d.ttsEngine === "elevenlabs"
      ? (nonNeg(d.ttsChars) / 1000) * PRICING_RATES.ttsPer1kCharsElevenLabs
      : base.tts;

  return base.live + base.qaLive + stt + base.text + tts + base.sie;
}

export interface UsageFields<T> {
  liveMinutes: T;
  qaLiveMinutes: T;
  liveMinutesSq: T;
  qaLiveMinutesSq: T;
  sttMinutes: T;
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
    sttMinutes: inc(nonNeg(d.sttMinutes)),
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
