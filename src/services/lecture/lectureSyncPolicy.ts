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

export type LectureCardPresence = "unknown" | "none" | "lecture";

export interface LectureCardFlags {
  loading: boolean;
  serverChecking: boolean;
  serverSlow: boolean;
}

/** A missing local doc stays unknown while the server check is still in flight. */
export function lectureCardFlagsAfterLocal(
  lecture: { status?: string } | null,
  needsServer: boolean
): LectureCardFlags {
  return {
    loading: needsServer && lecture == null,
    serverChecking: needsServer,
    serverSlow: false,
  };
}

/** Timeout is not confirmation that there is no lecture. */
export function lectureCardFlagsAfterServer(
  server: "skipped" | "ok" | "failed" | "timeout"
): LectureCardFlags {
  return {
    loading: false,
    serverChecking: false,
    serverSlow: server === "timeout",
  };
}

export interface LectureCardView {
  presence: LectureCardPresence;
  headline: string;
  checking: boolean;
  slow: boolean;
}

const LECTURE_LOADING_HEADLINE = "불러오는 중…";
const LECTURE_EMPTY_HEADLINE = "아직 오늘 강의가 없어요";

/**
 * Three-way card state. "none" only after loading, the server check, and a slow
 * timeout have all finished without a lecture document.
 */
export function lectureCardView(opts: LectureCardFlags & {
  lecture: { status?: string; title?: string } | null;
}): LectureCardView {
  const status = opts.lecture?.status;
  const checking = shouldShowLectureChecking({
    loading: opts.loading,
    status,
    serverChecking: opts.serverChecking,
  });
  const slow = shouldShowLectureSlow({
    loading: opts.loading,
    status,
    serverChecking: opts.serverChecking,
    serverSlow: opts.serverSlow,
  });

  if (opts.lecture && status === "ready") {
    return {
      presence: "lecture",
      headline: opts.lecture.title || "오늘 강의 준비 완료",
      checking,
      slow,
    };
  }
  if (opts.lecture && status === "generating") {
    return { presence: "lecture", headline: "강의 만드는 중…", checking, slow };
  }
  if (opts.lecture && status === "failed") {
    return { presence: "lecture", headline: "강의 만들기 실패", checking, slow };
  }
  if (!opts.lecture && (opts.loading || opts.serverChecking || opts.serverSlow)) {
    return { presence: "unknown", headline: LECTURE_LOADING_HEADLINE, checking, slow };
  }
  if (!opts.lecture) {
    return { presence: "none", headline: LECTURE_EMPTY_HEADLINE, checking: false, slow: false };
  }
  return { presence: "unknown", headline: LECTURE_LOADING_HEADLINE, checking, slow };
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
