/**
 * B-10 Usage tracking: users/{uid}/usage/{yyyy-mm}
 * { liveMinutes, sttMinutes, textTokens, ttsChars, estCostUsd, days: { "DD": { estCostUsd, ... } } }
 * Unit prices come only from PRICING_RATES in src/config/models.ts (single source).
 */
import { doc, getDoc, setDoc, increment } from "firebase/firestore";
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
}

export interface UsageMonth {
  liveMinutes: number;
  sttMinutes: number;
  textTokens: number;
  ttsChars: number;
  estCostUsd: number;
  days?: Record<string, { liveMinutes?: number; sttMinutes?: number; textTokens?: number; ttsChars?: number; estCostUsd?: number }>;
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
    ((d.ttsChars || 0) / 1000) * tts
  );
}

export async function recordUsage(uid: string, d: UsageDelta): Promise<void> {
  const today = getKSTToday(); // YYYY-MM-DD (KST)
  const month = today.slice(0, 7);
  const day = today.slice(8, 10);
  const tokens = (d.textInputTokens || 0) + (d.textOutputTokens || 0) + (d.textTokens || 0);
  const cost = estimateCostUsd(d);
  const fields = {
    liveMinutes: increment(d.liveMinutes || 0),
    sttMinutes: increment(d.sttMinutes || 0),
    textTokens: increment(tokens),
    ttsChars: increment(d.ttsChars || 0),
    estCostUsd: increment(cost),
  };
  try {
    await setDoc(
      doc(db, "users", uid, "usage", month),
      { ...fields, days: { [day]: fields }, updatedAt: new Date().toISOString() },
      { merge: true }
    );
  } catch (err) {
    console.warn("[usage] record failed (non-fatal):", err);
  }
}

export async function getUsageMonth(uid: string, month = getKSTToday().slice(0, 7)): Promise<UsageMonth | null> {
  const snap = await getDoc(doc(db, "users", uid, "usage", month));
  return snap.exists() ? (snap.data() as UsageMonth) : null;
}
