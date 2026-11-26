import type { LectureDoc } from "./lectureService";
import {
  isLectureAudioRestoring,
  shouldShowLectureImmediately,
} from "./lectureSyncPolicy";

export interface LoadLectureForCardDeps {
  readLocal: () => Promise<LectureDoc | null>;
  syncServer: (current: LectureDoc | null) => Promise<LectureDoc | null>;
  onLocal: (l: LectureDoc | null, needsServer: boolean) => void;
  onServerSettled?: (lecture: LectureDoc | null, status: "ok" | "failed") => void;
  timeoutMs?: number;
}

export type LectureCardServerStatus = "skipped" | "ok" | "failed" | "timeout";

/**
 * Show local lecture state immediately via `onLocal`, then consult the server
 * only when needed (missing, generating, failed, or restoring audio), bounded by `timeoutMs`.
 * If `syncServer` settles after `timeoutMs` has already elapsed, `onServerSettled` fires once.
 */
export async function loadLectureForCard(
  deps: LoadLectureForCardDeps
): Promise<{ lecture: LectureDoc | null; server: LectureCardServerStatus }> {
  const local = await deps.readLocal();
  const needsServer = !(shouldShowLectureImmediately(local) && !isLectureAudioRestoring(local));
  deps.onLocal(local, needsServer);

  if (!needsServer) {
    return { lecture: local, server: "skipped" };
  }

  const timeoutMs = deps.timeoutMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let settledBeforeTimeout = false;

  const serverPromise = deps.syncServer(local).then(
    (lecture) => {
      const resolved = lecture ?? local;
      if (timedOut) {
        deps.onServerSettled?.(resolved, "ok");
      } else {
        settledBeforeTimeout = true;
      }
      return { kind: "ok" as const, lecture: resolved };
    },
    () => {
      if (timedOut) {
        deps.onServerSettled?.(local, "failed");
      } else {
        settledBeforeTimeout = true;
      }
      return { kind: "failed" as const, lecture: local };
    }
  );

  try {
    const outcome = await Promise.race([
      serverPromise,
      new Promise<{ kind: "timeout"; lecture: LectureDoc | null }>((resolve) => {
        timer = setTimeout(() => {
          if (!settledBeforeTimeout) {
            timedOut = true;
            resolve({ kind: "timeout", lecture: local });
          }
        }, timeoutMs);
      }),
    ]);

    if (outcome.kind === "timeout") {
      return { lecture: local, server: "timeout" };
    }
    if (outcome.kind === "failed") {
      return { lecture: local, server: "failed" };
    }
    return { lecture: outcome.lecture, server: "ok" };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
