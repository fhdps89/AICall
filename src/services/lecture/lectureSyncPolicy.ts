/** Pure helpers for when to show, overwrite, or copy a morning lecture. No Firebase imports. */

export const LECTURE_UPLOAD_BACKOFF_MS = 6 * 60 * 60 * 1000;

export function lectureUploadFailKey(uid: string, date: string): string {
  return `aicall:lectureUploadFail:${uid}:${date}`;
}

export function shouldShowLectureImmediately(lecture: { status?: string } | null | undefined): boolean {
  return lecture?.status === "ready";
}

export function isLectureAudioRestoring(
  lecture: { status?: string; audioStatus?: string; audioUrl?: string | null; hasAudio?: boolean } | null | undefined
): boolean {
  return lecture?.status === "ready" && lecture.audioStatus === "rebuilding" && !lecture.audioUrl && !lecture.hasAudio;
}

export function shouldPollLecture(
  lecture: { status?: string; audioStatus?: string; audioUrl?: string | null; hasAudio?: boolean } | null | undefined
): boolean {
  return lecture?.status === "generating" || isLectureAudioRestoring(lecture);
}

export function shouldCopyLectureAudio(
  lecture: { status?: string; audioUrl?: string | null } | null | undefined,
  now: number,
  lastFailAt: number | null
): boolean {
  if (!lecture || lecture.status !== "ready") return false;
  if (lecture.audioUrl) return false;
  if (lastFailAt != null && now - lastFailAt < LECTURE_UPLOAD_BACKOFF_MS) return false;
  return true;
}

/** Keep the app's ready lecture when the server has a different ready lecture (e.g. after a redeploy). */
export function shouldOverwriteFirestoreLecture(
  current: { status?: string; createdAt?: string } | null | undefined,
  server: { status?: string; createdAt?: string } | null | undefined
): boolean {
  if (
    current?.status === "ready" &&
    server?.status === "ready" &&
    current.createdAt &&
    server.createdAt &&
    current.createdAt !== server.createdAt
  ) {
    return false;
  }
  return true;
}

export function listenedAtToKeep(
  current: { createdAt?: string; listenedAt?: string | null } | null | undefined,
  serverCreatedAt?: string
): string | null {
  if (current?.listenedAt && current.createdAt && current.createdAt === serverCreatedAt) {
    return current.listenedAt;
  }
  return null;
}

export function shouldMarkLectureDate(previousStatus: string | undefined, nextStatus: string): boolean {
  return nextStatus === "ready" && previousStatus !== "ready";
}

/** Drop leftover audioUrl/listenedAt when a new generate job starts (force rebuild of a ready lecture). */
export function shouldClearStaleLectureMedia(
  status: string | undefined,
  force: boolean,
  opts: { genSkipped?: boolean } = {}
): boolean {
  if (opts.genSkipped) return false;
  return force === true || status === "generating";
}

export function readUploadFailAt(storage: { getItem(k: string): string | null } | undefined, uid: string, date: string): number | null {
  if (!storage) return null;
  const raw = storage.getItem(lectureUploadFailKey(uid, date));
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function writeUploadFailAt(storage: { setItem(k: string, v: string): void } | undefined, uid: string, date: string, at: number): void {
  storage?.setItem(lectureUploadFailKey(uid, date), String(at));
}

export function clearUploadFailAt(storage: { removeItem(k: string): void } | undefined, uid: string, date: string): void {
  storage?.removeItem(lectureUploadFailKey(uid, date));
}

export function shouldStartPollRefresh(inFlight: boolean, busy = false): boolean {
  return !inFlight && !busy;
}

export function isLatestRequest(reqId: number, currentReqId: number): boolean {
  return reqId === currentReqId;
}

export function shouldShowLectureChecking(opts: {
  loading: boolean;
  status?: string;
  serverChecking: boolean;
}): boolean {
  return !opts.loading && opts.serverChecking && (!opts.status || opts.status === "failed");
}

export function shouldShowLectureSlow(opts: {
  loading: boolean;
  status?: string;
  serverChecking: boolean;
  serverSlow: boolean;
}): boolean {
  return (
    !opts.loading &&
    !opts.serverChecking &&
    opts.serverSlow &&
    (!opts.status || opts.status === "failed")
  );
}

/** Avoid force-overwriting an unconfirmed server job while the status check is still slow. */
export function shouldForceStartLecture(status?: string, serverSlow = false): boolean {
  return status === "failed" && !serverSlow;
}

export interface AutoOpenDecision {
  openModal: boolean;
  markHandled: boolean;
  markFirstRefreshDone: boolean;
}

export function resolveLectureAutoOpen(opts: {
  autoOpen: boolean;
  alreadyHandled: boolean;
  serverStatus: "skipped" | "ok" | "failed" | "timeout";
  lectureStatus?: string;
}): AutoOpenDecision {
  if (opts.serverStatus === "timeout") {
    return { openModal: false, markHandled: false, markFirstRefreshDone: false };
  }
  if (!opts.autoOpen || opts.alreadyHandled) {
    return { openModal: false, markHandled: false, markFirstRefreshDone: true };
  }
  return {
    openModal: opts.lectureStatus === "ready",
    markHandled: true,
    markFirstRefreshDone: true,
  };
}
