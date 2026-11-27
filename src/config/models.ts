/**
 * Model Configuration & Provider Constants
 * Strictly follows Part B-1 and Part B-10 specifications.
 * Single source of model names for BOTH the client and the server (server.ts, server/*.ts import this file).
 * DO NOT change the model names!
 */

export const LIVE_MODEL = "gemini-3.8-live" as const;
export const TEXT_MODEL = "gemini-3.8-flash" as const;
export const EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-4B" as const;
export const SIE_EMBEDDING_URL = "https://api.superlinked.com/v1/embeddings" as const;

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
 * Standard pricing unit rates (USD per 1M tokens unless noted), aistudio pricing 2026-11-25.
 * Single source of unit rates for Part B-10 usage & cost estimation.
 */
export const PRICING_RATES = {
  liveInTextPer1M: 0.75,
  liveInAudioPer1M: 3,
  liveOutAudioPer1M: 12,
  liveOutTextPer1M: 4.5,
  sttInAudioPer1M: 2,
  sttOutTextPer1M: 12,
  textInPer1M: 0.75,
  textOutPer1M: 3.75,
  ttsInPer1M: 0.5,
  ttsOutAudioPer1M: 9,
  sttPerMinuteAssembly: 0.006,
  ttsPer1kCharsElevenLabs: 0.015,
  sieEmbedPer1MTokens: 0.06,
} as const;

/**
 * Modeling assumptions used when exact token/audio counts are unavailable or re-billed per turn.
 */
export const USAGE_ASSUMPTIONS = {
  /** Gemini native audio tokenization rate (25 tok/s = 1,500 tok/min). */
  audioTokensPerSec: 25,
  /** Tutor speaks ~50% of call duration for explanations and corrections. */
  liveModelTalkShare: 0.5,
  /** ~1 user/tutor turn exchange every 15s (4 turns/min). */
  liveTurnsPerMin: 4,
  /**
   * Average re-billed Live history once compression runs (contextWindowCompression 12k trigger / 6k target,
   * src/config/liveCompression.ts LIVE_COMPRESSED_CONTEXT_AVG_TOKENS = (12k + 6k) / 2). Used only for calls
   * recorded without measured usageMetadata; each call stores its own liveMinutesSq, so earlier calls keep theirs.
   * Was 128_000 (API default trigger = 80% of the window, never reached in a 10-minute call).
   */
  liveContextWindowTokens: 9_000,
  /** lessonPromptBuilder (~4.3KB) + goal context re-billed on every Live turn. */
  liveSystemPromptTokens: 1500,
  /** ~150 spoken words/min plus speaker labels and timestamps. */
  sttOutTokensPerMin: 175,
  /** Blended 70% input / 30% output for legacy textTokens; partially offsets missing thinking tokens. */
  legacyTextOutputShare: 0.3,
  /** Blended English (~14 chars/s) & Korean (~7-8 chars/s) when ttsAudioSec is absent. */
  legacyTtsCharsPerSec: 10,
  /** Approximate input text tokens per character for mixed Korean/English lecture scripts. */
  ttsInTokensPerChar: 0.5,
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
