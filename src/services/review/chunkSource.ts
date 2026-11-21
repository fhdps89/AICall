/**
 * 복기용 녹음 조각 출처 계획 및 다운로드 추적 순수 모듈 (Firebase·React 비의존).
 * 브라우저에서 Firebase Storage를 직접 fetch하지 않고 서버 중계(/api/recordings/storage-file)로 보낸다.
 */
import type { RecordingChunkMeta } from "../firebase/db";

export type ChunkFailureReason =
  | "forbidden"
  | "not_found"
  | "http_error"
  | "network"
  | "not_uploaded"
  | "unknown_source";

export type ChunkSource =
  | { kind: "local"; index: number }
  | { kind: "storageRelay"; index: number; url: string }
  | { kind: "serverFile"; index: number; url: string }
  | { kind: "skip"; index: number; reason: "not_uploaded" | "unknown_source" };

export interface ChunkDownloadSummary {
  total: number;
  downloaded: number;
  failed: number;
  skipped: number;
  stoppedEarly: boolean;
  reasons: Partial<Record<ChunkFailureReason, number>>;
}

/** Firebase Storage 다운로드 URL 호스트인지 판별한다. */
export function isFirebaseStorageUrl(url?: string): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    return new URL(url).hostname === "firebasestorage.googleapis.com";
  } catch {
    return false;
  }
}

/** Firebase Storage 다운로드 URL에서 token 쿼리 값을 추출한다. */
export function extractDownloadToken(url: string): string | undefined {
  try {
    const token = new URL(url).searchParams.get("token");
    return token && token.trim() ? token.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 원격 메타데이터와 로컬 대기 조각 인덱스를 합쳐 인덱스 오름차순으로 조각별 획득 경로를 정한다.
 * 브라우저 직접 외부 URL은 반환하지 않고 로컬 또는 `/api/...` 경로만 생성한다.
 */
export function planChunkSources(
  chunks: readonly Pick<RecordingChunkMeta, "index" | "path" | "storageUrl" | "uploaded">[] | undefined,
  localIndices: readonly number[]
): ChunkSource[] {
  const remoteByIndex = new Map<number, Pick<RecordingChunkMeta, "index" | "path" | "storageUrl" | "uploaded">>();
  for (const chunk of chunks ?? []) {
    remoteByIndex.set(chunk.index, chunk);
  }
  const localSet = new Set(localIndices);
  const allIndices = Array.from(new Set([...remoteByIndex.keys(), ...localSet])).sort((a, b) => a - b);

  return allIndices.map((index): ChunkSource => {
    if (localSet.has(index)) {
      return { kind: "local", index };
    }
    const chunk = remoteByIndex.get(index)!;
    if (isFirebaseStorageUrl(chunk.storageUrl)) {
      const token = extractDownloadToken(chunk.storageUrl!);
      const url = `/api/recordings/storage-file?path=${encodeURIComponent(chunk.path)}${
        token ? `&token=${encodeURIComponent(token)}` : ""
      }`;
      return { kind: "storageRelay", index, url };
    }
    if (chunk.storageUrl && chunk.storageUrl.startsWith("/api/recordings/file")) {
      return { kind: "serverFile", index, url: chunk.storageUrl };
    }
    if (!chunk.storageUrl && chunk.uploaded === false) {
      return { kind: "skip", index, reason: "not_uploaded" };
    }
    if (!chunk.storageUrl && chunk.uploaded === true && chunk.path) {
      return {
        kind: "serverFile",
        index,
        url: `/api/recordings/file?path=${encodeURIComponent(chunk.path)}`,
      };
    }
    return { kind: "skip", index, reason: "unknown_source" };
  });
}

/** HTTP 상태 코드를 조각 다운로드 실패 사유로 매핑한다. */
export function failureReasonForStatus(status: number): ChunkFailureReason {
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  return "http_error";
}

/**
 * 조각 다운로드 성공·실패·건너뜀을 추적하고, 권한 오류(403) 1회 또는 연속 N회 실패 시 조기 중단을 알린다.
 */
export function createChunkDownloadTracker(
  total: number,
  opts?: { maxConsecutiveFailures?: number }
): {
  success(): void;
  failure(r: ChunkFailureReason): void;
  skip(r: ChunkFailureReason): void;
  shouldStop(): boolean;
  finish(): ChunkDownloadSummary;
} {
  const maxConsecutive = opts?.maxConsecutiveFailures ?? 3;
  let downloaded = 0;
  let failed = 0;
  let skipped = 0;
  let consecutiveFailures = 0;
  let stopped = false;
  const reasons: Partial<Record<ChunkFailureReason, number>> = {};

  return {
    success() {
      downloaded += 1;
      consecutiveFailures = 0;
    },
    failure(r: ChunkFailureReason) {
      failed += 1;
      reasons[r] = (reasons[r] ?? 0) + 1;
      consecutiveFailures += 1;
      if (r === "forbidden" || consecutiveFailures >= maxConsecutive) {
        stopped = true;
      }
    },
    skip(r: ChunkFailureReason) {
      skipped += 1;
      reasons[r] = (reasons[r] ?? 0) + 1;
    },
    shouldStop() {
      return stopped;
    },
    finish(): ChunkDownloadSummary {
      const remaining = Math.max(0, total - (downloaded + failed + skipped));
      return {
        total,
        downloaded,
        failed,
        skipped: skipped + remaining,
        stoppedEarly: stopped,
        reasons: { ...reasons },
      };
    },
  };
}

/** 실패 또는 건너뜀이 있을 때만 한 줄 요약 경고를 만든다. */
export function formatChunkDownloadWarning(s: ChunkDownloadSummary): string | null {
  if (s.failed === 0 && s.skipped === 0) return null;

  const reasonEntries = Object.entries(s.reasons).filter(([, count]) => (count ?? 0) > 0);
  const reasonText =
    reasonEntries.length > 0
      ? ` (${reasonEntries.map(([reason, count]) => `${reason}×${count}`).join(", ")})`
      : "";

  const parts: string[] = [];
  if (s.failed > 0) {
    parts.push(`${s.failed}/${s.total} failed${reasonText}`);
    if (s.skipped > 0) parts.push(`${s.skipped} skipped`);
  } else if (s.skipped > 0) {
    parts.push(`${s.skipped}/${s.total} skipped${reasonText}`);
  }
  if (s.stoppedEarly) {
    parts.push("stopped early");
  }
  return `[ReviewPipeline] Chunk download: ${parts.join(", ")}`;
}

/** 조기 중단 없이 1개 이상 확보됐을 때만 녹음 조각을 받아쓰기에 사용한다. */
export function shouldUseDownloadedChunks(s: ChunkDownloadSummary): boolean {
  return s.downloaded > 0 && !s.stoppedEarly;
}
