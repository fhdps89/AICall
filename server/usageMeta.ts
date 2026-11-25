export interface UsageMetadataLike {
  promptTokenCount?: number | null;
  candidatesTokenCount?: number | null;
  thoughtsTokenCount?: number | null;
  totalTokenCount?: number | null;
}

function nonNegNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Extracts input/output token counts from Gemini usageMetadata, including thinking tokens in outputTokens.
 */
export function tokensFromUsageMetadata(m?: UsageMetadataLike | null): {
  inputTokens: number;
  outputTokens: number;
} {
  return {
    inputTokens: nonNegNum(m?.promptTokenCount),
    outputTokens: nonNegNum(m?.candidatesTokenCount) + nonNegNum(m?.thoughtsTokenCount),
  };
}
