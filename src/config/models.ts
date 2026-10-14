/**
 * Model Configuration & Provider Constants
 * Strictly follows Part B-1 and Part B-10 specifications.
 * Single source of model names for BOTH the client and the server (server.ts, server/*.ts import this file).
 * DO NOT change the model names!
 */

export const LIVE_MODEL = "gemini-3.8-live" as const;
export const TEXT_MODEL = "gemini-3.8-flash" as const;

export type SttEngineType = "gemini" | "assemblyai";
export const DEFAULT_STT_ENGINE: SttEngineType = "gemini";
export const GEMINI_STT_MODEL = "gemini-3.5-transcribe" as const;
export const GEMINI_STT_MODE = "VERBATIM" as const;
export const ASSEMBLYAI_STT_MODEL = "universal-3-5-pro" as const;

export type TtsEngineType = "gemini" | "elevenlabs";
export const DEFAULT_TTS_ENGINE: TtsEngineType = "gemini";
export const GEMINI_TTS_MODEL = "gemini-3.8-flash-tts" as const;
/** Short single-phrase playback ("발음 듣기" on the review screen): cheaper/faster lite TTS. */
export const GEMINI_TTS_LITE_MODEL = "gemini-3.8-flash-lite-tts" as const;

/**
 * Standard pricing unit rates for Part B-10 usage & cost estimation
 */
export const PRICING_RATES = {
  // USD per unit
  livePerMinute: 0.004,        // Gemini Live audio streaming per minute estimate
  sttPerMinuteGemini: 0.003,   // gemini-3.5-transcribe VERBATIM
  sttPerMinuteAssembly: 0.006, // AssemblyAI Universal-3.5 Pro
  textPer1kInputTokens: 0.00015,
  textPer1kOutputTokens: 0.0006,
  ttsPer1kCharsGemini: 0.0004, // gemini-3.8-flash-tts
  ttsPer1kCharsElevenLabs: 0.015,
} as const;

export interface ModelConfig {
  liveModel: typeof LIVE_MODEL;
  textModel: typeof TEXT_MODEL;
  sttEngine: SttEngineType;
  geminiSttModel: typeof GEMINI_STT_MODEL;
  geminiSttMode: typeof GEMINI_STT_MODE;
  assemblyAiSttModel: typeof ASSEMBLYAI_STT_MODEL;
  ttsEngine: TtsEngineType;
  geminiTtsModel: typeof GEMINI_TTS_MODEL;
}

export const CURRENT_MODEL_CONFIG: ModelConfig = {
  liveModel: LIVE_MODEL,
  textModel: TEXT_MODEL,
  sttEngine: DEFAULT_STT_ENGINE,
  geminiSttModel: GEMINI_STT_MODEL,
  geminiSttMode: GEMINI_STT_MODE,
  assemblyAiSttModel: ASSEMBLYAI_STT_MODEL,
  ttsEngine: DEFAULT_TTS_ENGINE,
  geminiTtsModel: GEMINI_TTS_MODEL,
};
