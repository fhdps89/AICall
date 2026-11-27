/**
 * Gemini Live context window compression (H1-보수, docs/plan/live-cost-optimization-proposal.md 3·6장 2단계).
 *
 * gemini-3.8-live has no context caching, so every turn re-bills the whole conversation so far.
 * Without explicit values the API compresses only at 80% of the model's context window (~105k tokens),
 * which a 10-minute call (~22.5k tokens) never reaches. 12k/6k keeps the re-billed context between
 * ~6k and ~12k tokens (about 2 compressions per 10-minute call).
 *
 * API (https://ai.google.dev/api/live#ContextWindowCompressionConfig):
 *   contextWindowCompression: { triggerTokens: int64, slidingWindow: { targetTokens: int64 } }
 * The sliding window drops the oldest turns; system instructions always stay at the start.
 * int64 values are sent as decimal strings (proto3 JSON form; @google/genai types them as string).
 */
export const LIVE_COMPRESSION_TRIGGER_TOKENS = 12_000;
export const LIVE_COMPRESSION_TARGET_TOKENS = 6_000;

export interface LiveContextWindowCompression {
  triggerTokens: string;
  slidingWindow: { targetTokens: string };
}

/** Fresh object each call so callers can't mutate a shared config. */
export function buildLiveContextWindowCompression(): LiveContextWindowCompression {
  return {
    triggerTokens: String(LIVE_COMPRESSION_TRIGGER_TOKENS),
    slidingWindow: { targetTokens: String(LIVE_COMPRESSION_TARGET_TOKENS) },
  };
}

/**
 * Average re-billed history used by the duration-based estimate (usageService/learningLog).
 * After the first compression the history saw-tooths between target and trigger, so the mean is
 * about (target + trigger) / 2. Matches the proposal's 12k/6k figure (~$1.03 Live per 10-min call).
 */
export const LIVE_COMPRESSED_CONTEXT_AVG_TOKENS =
  (LIVE_COMPRESSION_TRIGGER_TOKENS + LIVE_COMPRESSION_TARGET_TOKENS) / 2;
