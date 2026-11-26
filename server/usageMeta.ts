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

export interface SanitizedModalityTokenCount {
  modality: string;
  tokenCount: number;
}

export interface SanitizedLiveUsageMetadata {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  responseTokenCount?: number;
  candidatesTokenCount?: number;
  toolUsePromptTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  promptTokensDetails?: SanitizedModalityTokenCount[];
  cacheTokensDetails?: SanitizedModalityTokenCount[];
  responseTokensDetails?: SanitizedModalityTokenCount[];
}

const LIVE_USAGE_NUMERIC_FIELDS = [
  'promptTokenCount',
  'cachedContentTokenCount',
  'responseTokenCount',
  'candidatesTokenCount',
  'toolUsePromptTokenCount',
  'thoughtsTokenCount',
  'totalTokenCount',
] as const;

const LIVE_USAGE_DETAILS_FIELDS = [
  'promptTokensDetails',
  'cacheTokensDetails',
  'responseTokensDetails',
] as const;

function sanitizeDetailsArray(raw: unknown): SanitizedModalityTokenCount[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SanitizedModalityTokenCount[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const modality = rec.modality;
    const tokenCount = rec.tokenCount;
    if (
      typeof modality === 'string' &&
      /^[A-Z0-9_]{1,32}$/i.test(modality) &&
      typeof tokenCount === 'number' &&
      Number.isFinite(tokenCount) &&
      tokenCount >= 0
    ) {
      out.push({ modality, tokenCount });
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Strips a Gemini Live usageMetadata object down to numeric token counts and
 * `{ modality, tokenCount }` detail arrays before forwarding over the proxy WS.
 */
export function sanitizeLiveUsageMetadata(m: unknown): SanitizedLiveUsageMetadata | null {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const src = m as Record<string, unknown>;
  const out: SanitizedLiveUsageMetadata = {};
  let hasField = false;

  for (const key of LIVE_USAGE_NUMERIC_FIELDS) {
    const val = src[key];
    if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
      out[key] = val;
      hasField = true;
    }
  }

  for (const key of LIVE_USAGE_DETAILS_FIELDS) {
    const arr = sanitizeDetailsArray(src[key]);
    if (arr) {
      out[key] = arr;
      hasField = true;
    }
  }

  return hasField ? out : null;
}
