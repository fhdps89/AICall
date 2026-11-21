import type { RecordingChunkMeta, SessionData } from "../../services/firebase/db";

/**
 * 녹음 조각 개수와 총 길이를 "N개 (M초)" 또는 "N개 (M분)" 형태로 표기한다.
 */
export function formatRecordingChunksSummary(
  chunksOrCount: readonly Pick<RecordingChunkMeta, "durationSeconds">[] | number | undefined
): string {
  const chunkCount = typeof chunksOrCount === "number" ? Math.max(0, chunksOrCount) : (chunksOrCount?.length ?? 0);
  const totalSeconds =
    typeof chunksOrCount === "number"
      ? chunkCount * 10
      : (chunksOrCount ?? []).reduce(
          (sum, chunk) =>
            sum + (typeof chunk.durationSeconds === "number" && chunk.durationSeconds > 0 ? chunk.durationSeconds : 10),
          0
        );

  const roundedSeconds = Math.round(totalSeconds);
  if (roundedSeconds < 60) {
    return `${chunkCount}개 (${roundedSeconds}초)`;
  }
  return `${chunkCount}개 (${Math.round(roundedSeconds / 60)}분)`;
}

export interface RecordingStateDescription {
  tone: "saved" | "uploading" | "transcript_only" | "empty";
  text: string;
}

export interface SessionChunkCounts {
  total: number;
  uploaded: number;
  localPending: number;
}

/**
 * 원격 메타데이터와 로컬 대기 조각 인덱스를 합쳐 전체 조각 수·업로드 완료 수·로컬 대기 수를 계산한다.
 */
export function countSessionChunks(
  remote: readonly Pick<RecordingChunkMeta, "index" | "uploaded">[] | undefined,
  localIndices: readonly number[]
): SessionChunkCounts {
  const localSet = new Set(localIndices);
  const remoteUploadedByIndex = new Map<number, boolean>();
  for (const chunk of remote ?? []) {
    const prev = remoteUploadedByIndex.get(chunk.index);
    remoteUploadedByIndex.set(chunk.index, prev === true || chunk.uploaded !== false);
  }
  const allIndices = new Set<number>([...remoteUploadedByIndex.keys(), ...localSet]);
  let uploaded = 0;
  for (const [idx, isUploaded] of remoteUploadedByIndex.entries()) {
    if (isUploaded && !localSet.has(idx)) {
      uploaded += 1;
    }
  }
  return {
    total: allIndices.size,
    uploaded,
    localPending: localSet.size,
  };
}

/**
 * 끝나지 않은 통화의 녹음·대화 로그 저장 상태를 사용자 안내 문구로 정리한다.
 */
export function describeRecordingState(
  session: Pick<SessionData, "recordingChunks" | "liveTranscript">,
  counts?: SessionChunkCounts
): RecordingStateDescription {
  const chunks = session.recordingChunks ?? [];
  const chunkCount = counts ? counts.total : chunks.length;
  const transcriptCount = session.liveTranscript?.length ?? 0;

  if (chunkCount === 0) {
    if (transcriptCount === 0) {
      return {
        tone: "empty",
        text: "저장된 녹음이나 대화 기록이 없어요. 복기할 내용이 없으면 보관만 해 주세요.",
      };
    }
    return {
      tone: "transcript_only",
      text: `저장된 녹음 조각은 없어요. 실시간 대화 기록 ${transcriptCount}턴으로 복기할 수 있어요.`,
    };
  }

  const pendingCount = counts
    ? Math.max(0, counts.total - counts.uploaded)
    : chunks.filter((chunk) => chunk.uploaded === false).length;
  if (pendingCount > 0) {
    return {
      tone: "uploading",
      text: `녹음 조각 ${pendingCount}개는 아직 올라가지 않았어요. 앱을 켜 둔 채 잠시 기다린 뒤 복기해 주세요.`,
    };
  }

  return {
    tone: "saved",
    text: "녹음은 안전하게 저장돼 있어요.",
  };
}

/**
 * 통화 선택 칩 라벨을 "M/D HH:mm · N과" 형태로 만든다.
 */
export function formatSessionChipLabel(
  session: Pick<SessionData, "startedAt" | "lessonIndex">
): string {
  const lessonLabel = `${session.lessonIndex}과`;
  if (!session.startedAt) {
    return `최근 · ${lessonLabel}`;
  }
  const d = new Date(session.startedAt);
  if (Number.isNaN(d.getTime())) {
    return `최근 · ${lessonLabel}`;
  }
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hh}:${mm} · ${lessonLabel}`;
}
