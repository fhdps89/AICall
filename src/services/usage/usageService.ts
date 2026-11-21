/**
 * B-10 Usage tracking: users/{uid}/usage/{yyyy-mm}
 * { liveMinutes, sttMinutes, textTokens, ttsChars, estCostUsd, days: { "DD": { estCostUsd, ... } } }
 * Unit prices come only from PRICING_RATES in src/config/models.ts (single source).
 */
import { doc, getDoc, setDoc, increment, FieldValue } from "firebase/firestore";
import { db } from "../firebase/config";
import { PRICING_RATES, DEFAULT_STT_ENGINE, DEFAULT_TTS_ENGINE } from "../../config/models";
import { getKSTToday } from "../firebase/db";

export interface UsageDelta {
  liveMinutes?: number;
  sttMinutes?: number;
  sttEngine?: "gemini" | "assemblyai";
  textInputTokens?: number;
  textOutputTokens?: number;
  /** total tokens when the in/out split is unknown (priced at the input rate) */
  textTokens?: number;
  ttsChars?: number;
  ttsEngine?: "gemini" | "elevenlabs";
  sieEmbeddingTokens?: number;
  calls?: number;
}

export interface UsageDay {
  liveMinutes?: number;
  sttMinutes?: number;
  textTokens?: number;
  ttsChars?: number;
  sieEmbeddingTokens?: number;
  estCostUsd?: number;
  calls?: number;
}

export interface UsageMonth {
  liveMinutes: number;
  sttMinutes: number;
  textTokens: number;
  ttsChars: number;
  sieEmbeddingTokens?: number;
  estCostUsd: number;
  calls?: number;
  days?: Record<string, UsageDay>;
}

export function estimateCostUsd(d: UsageDelta): number {
  const r = PRICING_RATES;
  const stt = (d.sttEngine || DEFAULT_STT_ENGINE) === "assemblyai" ? r.sttPerMinuteAssembly : r.sttPerMinuteGemini;
  const tts = (d.ttsEngine || DEFAULT_TTS_ENGINE) === "elevenlabs" ? r.ttsPer1kCharsElevenLabs : r.ttsPer1kCharsGemini;
  return (
    (d.liveMinutes || 0) * r.livePerMinute +
    (d.sttMinutes || 0) * stt +
    ((d.textInputTokens || 0) / 1000) * r.textPer1kInputTokens +
    ((d.textOutputTokens || 0) / 1000) * r.textPer1kOutputTokens +
    ((d.textTokens || 0) / 1000) * r.textPer1kInputTokens +
    ((d.ttsChars || 0) / 1000) * tts +
    ((d.sieEmbeddingTokens || 0) / 1_000_000) * r.sieEmbedPer1MTokens
  );
}

export interface UsageFields<T> {
  liveMinutes: T;
  sttMinutes: T;
  textTokens: T;
  ttsChars: T;
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
  const tokens = (d.textInputTokens || 0) + (d.textOutputTokens || 0) + (d.textTokens || 0);
  const cost = estimateCostUsd(d);
  return {
    liveMinutes: inc(d.liveMinutes || 0),
    sttMinutes: inc(d.sttMinutes || 0),
    textTokens: inc(tokens),
    ttsChars: inc(d.ttsChars || 0),
    sieEmbeddingTokens: inc(d.sieEmbeddingTokens || 0),
    estCostUsd: inc(cost),
    calls: inc(d.calls || 0),
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
