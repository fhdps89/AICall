/**
 * Pure candidate picker for the morning lecture feed.
 * Kept free of firebase runtime imports so node tests can load it.
 */
import type { MistakeData } from "../firebase/db";

export interface LectureCandidate {
  id: string;
  myPhrase: string;
  naturalPhrase: string;
  reason?: string;
  createdAt?: string;
  source?: string;
  lessonTitle?: string;
}

export type LecturePickMistake = Pick<
  MistakeData,
  | "id"
  | "myPhrase"
  | "naturalPhrase"
  | "reason"
  | "createdAt"
  | "source"
  | "status"
  | "lessonTitle"
  | "sessionId"
> & { lectureDate?: string };

/** Call time below this is treated as a test/probe, not real practice. */
export const SHORT_SESSION_SEC = 3 * 60;

/**
 * Owner's 11/21 travel/1 call was 6m09s; same-window QA test calls were 47s–2m32s
 * (see /workspace/collab/onecall_lecture_source_20261122/firestore_provenance.md).
 * 3 minutes sits in that gap. Equal-to-3-minutes calls are kept.
 */
export const SHORT_SESSION_THRESHOLD_REASON =
  "Owner real call 6m09s; QA test calls were 47s–2m32s; threshold 3 minutes sits in the gap.";

/** When there is no prior ready lecture, new candidates must be created within this window. */
export const NEW_MISTAKE_FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

export const PREVIOUS_LECTURE_LOOKBACK_DAYS = 30;

export type SessionTiming = {
  startedAt?: string;
  endedAt?: string;
  lastTranscriptAt?: string;
  lastChunkAt?: string;
};

export type LecturePickOptions = {
  nowIso?: string;
  previousLectureCreatedAt?: string | null;
  /** sessionId → timing, or null when the session doc was looked up and missing. */
  sessionsById?: Record<string, SessionTiming | null>;
  onMissingSession?: (info: { mistakeId: string; sessionId?: string }) => void;
};

export type PreviousLectureHint = {
  date: string;
  status?: string;
  createdAt?: string;
};

export function isQaMistake(m: { source?: string }): boolean {
  return m.source === "qa";
}

export function kstDateOfIso(iso?: string): string | undefined {
  if (!iso || typeof iso !== "string") return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t + 9 * 3600000).toISOString().slice(0, 10);
}

export function addDaysKst(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  const Y = base.getUTCFullYear();
  const M = String(base.getUTCMonth() + 1).padStart(2, "0");
  const D = String(base.getUTCDate()).padStart(2, "0");
  return `${Y}-${M}-${D}`;
}

function toCandidate(m: LecturePickMistake): LectureCandidate {
  return {
    id: m.id!,
    myPhrase: m.myPhrase,
    naturalPhrase: m.naturalPhrase,
    reason: m.reason,
    createdAt: m.createdAt,
    source: m.source,
    lessonTitle: m.lessonTitle,
  };
}

const MAX_NEW = 6;
export const MAX_REVIEW_PER_LECTURE = 1;

/** Duration in seconds from startedAt to endedAt (or last transcript/chunk). Null if unknown. */
export function sessionCallSeconds(session: SessionTiming | null | undefined): number | null {
  if (!session) return null;
  const start = Date.parse(session.startedAt || "");
  if (!Number.isFinite(start)) return null;
  const endRaw = session.endedAt || session.lastTranscriptAt || session.lastChunkAt || "";
  const end = Date.parse(endRaw);
  if (!Number.isFinite(end) || end < start) return null;
  return (end - start) / 1000;
}

/** Unknown duration is not short (fail open). */
export function isShortSession(sec: number | null | undefined): boolean {
  if (sec == null || !Number.isFinite(sec)) return false;
  return sec < SHORT_SESSION_SEC;
}

/** Latest ready lecture strictly before `today`, using its createdAt as the new-candidate cutoff. */
export function previousLectureCutoffIso(
  lectures: PreviousLectureHint[],
  today: string
): string | undefined {
  const ready = (Array.isArray(lectures) ? lectures : [])
    .filter((l) => l?.date && l.date < today && l.status === "ready" && l.createdAt)
    .sort((a, b) => b.date.localeCompare(a.date));
  const cutoff = ready[0]?.createdAt;
  return cutoff && Number.isFinite(Date.parse(cutoff)) ? cutoff : undefined;
}

export function newCandidateCutoffMs(opts: {
  nowIso?: string;
  previousLectureCreatedAt?: string | null;
}): number | undefined {
  const prior = opts.previousLectureCreatedAt
    ? Date.parse(opts.previousLectureCreatedAt)
    : Number.NaN;
  if (Number.isFinite(prior)) return prior;
  const now = opts.nowIso ? Date.parse(opts.nowIso) : Date.now();
  if (!Number.isFinite(now)) return undefined;
  return now - NEW_MISTAKE_FALLBACK_WINDOW_MS;
}

function isCreatedAfterCutoff(createdAt: string | undefined, cutoffMs: number | undefined): boolean {
  if (!createdAt || cutoffMs == null) return false;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return false;
  return t > cutoffMs;
}

function keepBySession(
  m: LecturePickMistake,
  sessionsById: Record<string, SessionTiming | null> | undefined,
  onMissingSession?: LecturePickOptions["onMissingSession"]
): boolean {
  if (!sessionsById) return true;
  const sessionId = m.sessionId;
  if (!sessionId || !(sessionId in sessionsById) || sessionsById[sessionId] == null) {
    onMissingSession?.({ mistakeId: m.id!, sessionId });
    return true;
  }
  const sec = sessionCallSeconds(sessionsById[sessionId]);
  if (sec == null) {
    onMissingSession?.({ mistakeId: m.id!, sessionId });
    return true;
  }
  return !isShortSession(sec);
}

/**
 * New = created after the previous ready lecture (or within the last 24h if none)
 * and never used in a lecture. Review = due today. Both drop QA and short sessions
 * (call time under SHORT_SESSION_SEC). Missing session docs are kept (fail open).
 */
export function pickLectureCandidates(
  all: LecturePickMistake[],
  due: LecturePickMistake[],
  today: string,
  opts: LecturePickOptions = {}
): { newMistakes: LectureCandidate[]; reviewMistakes: LectureCandidate[] } {
  const cutoffMs = newCandidateCutoffMs(opts);
  const sessionsById = opts.sessionsById;
  const onMissingSession = opts.onMissingSession;
  const fresh = (Array.isArray(all) ? all : [])
    .filter((m) => {
      if (!m?.id || isQaMistake(m)) return false;
      if (m.status === "graduated") return false;
      if (m.lectureDate) return false;
      if (!isCreatedAfterCutoff(m.createdAt, cutoffMs)) return false;
      return keepBySession(m, sessionsById, onMissingSession);
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, MAX_NEW);
  const freshIds = new Set(fresh.map((m) => m.id));
  const review = (Array.isArray(due) ? due : [])
    .filter((m) => {
      if (!m?.id || isQaMistake(m) || freshIds.has(m.id)) return false;
      return keepBySession(m, sessionsById, onMissingSession);
    })
    .slice(0, MAX_REVIEW_PER_LECTURE);
  return {
    newMistakes: fresh.map(toCandidate),
    reviewMistakes: review.map(toCandidate),
  };
}

export function formatLectureDuration(sec: number): string {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(total / 60);
  const r = total % 60;
  if (m === 0) return `${r}초`;
  if (r === 0) return `${m}분`;
  return `${m}분 ${r}초`;
}
