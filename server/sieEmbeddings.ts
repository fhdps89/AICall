import { EMBEDDING_MODEL, SIE_EMBEDDING_URL } from '../src/config/models.ts';

export const SIE_BATCH_SIZE = 32;
export const SIE_REQUEST_TIMEOUT_MS = 12_000;
export const SIE_TOTAL_DEADLINE_MS = 20_000;
export const SIE_MAX_RETRY_AFTER_SEC = 2;

export type SieFailureReason = 'unavailable' | 'timeout' | 'bad_response';

export interface EmbedTextsOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  deadlineMs?: number;
  batchSize?: number;
  onBatchSuccess?: (batchStartIndex: number, vectors: Float32Array[], promptTokens: number) => void;
  logger?: (message: string) => void;
}

export type EmbedTextsResult =
  | { ok: true; vectors: Float32Array[]; promptTokens: number }
  | { ok: false; reason: SieFailureReason; promptTokens: number };

class RequestTimeoutError extends Error {
  constructor() {
    super('SIE request timeout');
    this.name = 'AbortError';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseShortRetryAfterMs(headerVal: string | null): number | null {
  if (!headerVal) return null;
  const match = /^\s*(\d+)\s*$/.exec(headerVal);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > SIE_MAX_RETRY_AFTER_SEC) {
    return null;
  }
  return seconds * 1000;
}

function isAbortError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      ((err as { name?: unknown }).name === 'AbortError' ||
        (err as { name?: unknown }).name === 'TimeoutError')
  );
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RequestTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      timeoutPromise,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseAndValidateBatchResponse(
  raw: unknown,
  expectedCount: number,
  expectedDim: number | null
): { ok: true; vectors: Float32Array[]; dim: number; promptTokens: number } | { ok: false } {
  if (!raw || typeof raw !== 'object') return { ok: false };
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.data) || obj.data.length !== expectedCount) {
    return { ok: false };
  }

  const ordered = new Array<Float32Array | undefined>(expectedCount);
  let dim = expectedDim;

  for (const entry of obj.data) {
    if (!entry || typeof entry !== 'object') return { ok: false };
    const item = entry as Record<string, unknown>;
    const idx = item.index;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= expectedCount) {
      return { ok: false };
    }
    if (ordered[idx] !== undefined) return { ok: false };

    const emb = item.embedding;
    if (!Array.isArray(emb) || emb.length === 0) return { ok: false };
    if (dim === null) {
      dim = emb.length;
    } else if (emb.length !== dim) {
      return { ok: false };
    }

    const vec = new Float32Array(emb.length);
    for (let i = 0; i < emb.length; i++) {
      const v = emb[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return { ok: false };
      }
      vec[i] = v;
    }
    ordered[idx] = vec;
  }

  const vectors: Float32Array[] = [];
  for (let i = 0; i < expectedCount; i++) {
    const v = ordered[i];
    if (!v) return { ok: false };
    vectors.push(v);
  }

  const usageObj = obj.usage && typeof obj.usage === 'object' ? (obj.usage as Record<string, unknown>) : null;
  const rawPromptTokens = usageObj?.prompt_tokens;
  const promptTokens =
    typeof rawPromptTokens === 'number' && Number.isFinite(rawPromptTokens) && rawPromptTokens >= 0
      ? rawPromptTokens
      : 0;

  return { ok: true, vectors, dim: dim ?? 0, promptTokens };
}

export async function embedTexts(
  texts: string[],
  options: EmbedTextsOptions
): Promise<EmbedTextsResult> {
  if (texts.length === 0) {
    return { ok: true, vectors: [], promptTokens: 0 };
  }

  const endpoint = options.endpoint ?? SIE_EMBEDDING_URL;
  const model = options.model ?? EMBEDDING_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? SIE_REQUEST_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? SIE_TOTAL_DEADLINE_MS;
  const batchSize = options.batchSize ?? SIE_BATCH_SIZE;
  const log = options.logger ?? ((msg: string) => console.warn(msg));

  const deadlineAt = now() + deadlineMs;
  const allVectors: Float32Array[] = [];
  let totalPromptTokens = 0;
  let expectedDim: number | null = null;

  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    let retried = false;

    while (true) {
      const remaining = deadlineAt - now();
      if (remaining <= 0) {
        log('[SIE] total deadline exceeded');
        return { ok: false, reason: 'timeout', promptTokens: totalPromptTokens };
      }

      const reqTimeout = Math.min(timeoutMs, remaining);
      let res: Response;
      try {
        res = await fetchWithTimeout(
          fetchImpl,
          endpoint,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ model, input: batch }),
          },
          reqTimeout
        );
      } catch (err) {
        if (isAbortError(err)) {
          log('[SIE] request timeout');
          return { ok: false, reason: 'timeout', promptTokens: totalPromptTokens };
        }
        const name = err instanceof Error ? err.name : 'Error';
        log(`[SIE] network error name=${name}`);
        return { ok: false, reason: 'unavailable', promptTokens: totalPromptTokens };
      }

      if (!res.ok) {
        const sieCode = res.headers?.get?.('x-sie-error-code');
        log(`[SIE] status=${res.status}${sieCode ? ` code=${sieCode}` : ''}`);

        if ((res.status === 429 || res.status === 503) && !retried) {
          const retryDelayMs = parseShortRetryAfterMs(res.headers?.get?.('retry-after') ?? null);
          if (retryDelayMs !== null) {
            if (now() + retryDelayMs >= deadlineAt) {
              return { ok: false, reason: 'timeout', promptTokens: totalPromptTokens };
            }
            retried = true;
            await sleep(retryDelayMs);
            continue;
          }
        }
        return { ok: false, reason: 'unavailable', promptTokens: totalPromptTokens };
      }

      let rawJson: unknown;
      try {
        rawJson = await res.json();
      } catch {
        log('[SIE] invalid JSON response');
        return { ok: false, reason: 'bad_response', promptTokens: totalPromptTokens };
      }

      const parsed = parseAndValidateBatchResponse(rawJson, batch.length, expectedDim);
      if (!parsed.ok) {
        log('[SIE] malformed embedding payload');
        return { ok: false, reason: 'bad_response', promptTokens: totalPromptTokens };
      }

      expectedDim = parsed.dim;
      totalPromptTokens += parsed.promptTokens;
      for (const vec of parsed.vectors) {
        allVectors.push(vec);
      }
      options.onBatchSuccess?.(start, parsed.vectors, parsed.promptTokens);
      break;
    }
  }

  return { ok: true, vectors: allVectors, promptTokens: totalPromptTokens };
}
