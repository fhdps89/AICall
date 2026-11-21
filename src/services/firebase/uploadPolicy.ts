/**
 * 녹음 조각 업로드 정책 및 대기 조각 재시도 순수 모듈.
 * Firebase SDK와 DOM 전역에 의존하지 않으므로 단위 테스트에서 결정론적으로 검증할 수 있다.
 */

export const DEFAULT_DIRECT_TIMEOUT_MS = 12_000;
export const DEFAULT_DIRECT_COOLDOWN_MS = 10 * 60 * 1000;
export const RECENT_CHUNK_GRACE_MS = 30_000;

export interface ChunkUploaderOptions<TBlob = unknown> {
  direct: (path: string, blob: TBlob) => Promise<string>;
  relay: (path: string, blob: TBlob) => Promise<string>;
  now?: () => number;
  directTimeoutMs?: number;
  cooldownMs?: number;
  onWarn?: (message: string, error: unknown) => void;
}

export interface ChunkUploader<TBlob = unknown> {
  upload: (path: string, blob: TBlob) => Promise<string>;
  isDirectBlocked: () => boolean;
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }
  return String(err);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  // 타임아웃이 먼저 발생한 뒤 뒤늦게 direct Promise가 reject 되어도 미처리 거부(UnhandledRejection)가 나지 않도록 방지한다.
  promise.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`직접 업로드가 제한 시간(${timeoutMs}ms)을 초과했습니다.`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

/**
 * 직접 업로드(Firebase Storage)와 서버 중계 업로드(/api/recordings/upload-chunk)를 조합하는 업로더를 생성한다.
 * - direct가 제한 시간(기본 12초)을 넘기거나 실패하면 쿨다운(기본 10분) 동안 direct를 건너뛰고 바로 relay를 사용한다.
 * - 쿨다운 진입 시 경고 로그는 한 번만 남긴다.
 * - relay까지 실패하면 두 원인을 모두 포함한 Error를 던진다.
 */
export function createChunkUploader<TBlob = unknown>(
  options: ChunkUploaderOptions<TBlob>
): ChunkUploader<TBlob> {
  const {
    direct,
    relay,
    now = () => Date.now(),
    directTimeoutMs = DEFAULT_DIRECT_TIMEOUT_MS,
    cooldownMs = DEFAULT_DIRECT_COOLDOWN_MS,
    onWarn = (message, error) => console.warn(message, error),
  } = options;

  let directBlockedUntil: number | null = null;
  let lastDirectError: string | null = null;

  const isDirectBlocked = (): boolean => {
    return directBlockedUntil !== null && now() < directBlockedUntil;
  };

  const runRelayWithCombinedError = async (
    path: string,
    blob: TBlob,
    directReason: string
  ): Promise<string> => {
    try {
      return await relay(path, blob);
    } catch (relayErr) {
      throw new Error(
        `직접 업로드 실패(${directReason}) 및 서버 중계 업로드 실패(${formatErrorMessage(relayErr)})`
      );
    }
  };

  const upload = async (path: string, blob: TBlob): Promise<string> => {
    if (isDirectBlocked()) {
      const reason = lastDirectError
        ? `쿨다운 중 — 이전 직접 업로드 실패: ${lastDirectError}`
        : "쿨다운 중";
      return runRelayWithCombinedError(path, blob, reason);
    }

    try {
      const url = await withTimeout(direct(path, blob), directTimeoutMs);
      directBlockedUntil = null;
      lastDirectError = null;
      return url;
    } catch (directErr) {
      const wasBlocked = isDirectBlocked();
      const directReason = formatErrorMessage(directErr);
      lastDirectError = directReason;

      if (!wasBlocked) {
        directBlockedUntil = now() + cooldownMs;
        onWarn(
          "[Storage] 직접 업로드 실패로 쿨다운 동안 서버 중계 업로드를 우선 사용합니다:",
          directErr
        );
      }

      return runRelayWithCombinedError(path, blob, directReason);
    }
  };

  return { upload, isDirectBlocked };
}

/**
 * 방금 생성되어 통화 중 업로더가 처리하고 있을 가능성이 높은 조각(기본 30초 이내)을 제외한다.
 */
export function selectRetryableChunks<T extends { timestamp: number }>(
  chunks: T[],
  nowMs: number,
  minAgeMs: number = RECENT_CHUNK_GRACE_MS
): T[] {
  return chunks.filter((chunk) => nowMs - chunk.timestamp >= minAgeMs);
}

export interface RetryPendingOptions {
  force?: boolean;
}

export interface RetryPendingResult {
  total: number;
  uploaded: number;
  failed: number;
  skipped: boolean;
}

export interface PendingRetryRunnerOptions<
  TChunk extends { timestamp: number },
  TContext = void
> {
  getPending: () => Promise<TChunk[]>;
  uploadChunk: (chunk: TChunk, context: TContext) => Promise<void>;
  now?: () => number;
  minAgeMs?: number;
  onStart?: (count: number) => void;
  onChunkError?: (chunk: TChunk, error: unknown) => void;
}

/**
 * 대기 조각 재시도 실행기를 생성한다(force 옵션 및 상세 결과 반환 지원).
 * - 동시에 두 번 실행되지 않도록 진행 중 플래그로 보호한다(이미 실행 중이면 skipped: true 반환).
 * - force: true 이면 최근 30초 유예를 건너뛰고, 동시 실행 가드는 유지한다.
 * - 한 조각 업로드가 실패해도 나머지 조각 재시도를 계속 진행한다.
 */
export function createPendingRetryRunner<
  TChunk extends { timestamp: number },
  TContext = void
>(
  options: PendingRetryRunnerOptions<TChunk, TContext>
): (context: TContext, retryOptions?: RetryPendingOptions) => Promise<RetryPendingResult> {
  const {
    getPending,
    uploadChunk,
    now = () => Date.now(),
    minAgeMs = RECENT_CHUNK_GRACE_MS,
    onStart,
    onChunkError,
  } = options;

  let inFlight = false;

  return async (
    context: TContext,
    retryOptions?: RetryPendingOptions
  ): Promise<RetryPendingResult> => {
    if (inFlight) {
      return { total: 0, uploaded: 0, failed: 0, skipped: true };
    }

    inFlight = true;
    try {
      const pending = await getPending();
      const retryable = retryOptions?.force
        ? pending
        : selectRetryableChunks(pending, now(), minAgeMs);
      if (retryable.length === 0) {
        return { total: 0, uploaded: 0, failed: 0, skipped: false };
      }

      onStart?.(retryable.length);
      let uploaded = 0;
      let failed = 0;

      for (const chunk of retryable) {
        try {
          await uploadChunk(chunk, context);
          uploaded++;
        } catch (err) {
          failed++;
          onChunkError?.(chunk, err);
        }
      }

      return { total: retryable.length, uploaded, failed, skipped: false };
    } finally {
      inFlight = false;
    }
  };
}
