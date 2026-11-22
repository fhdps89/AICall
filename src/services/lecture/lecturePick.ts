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
  "id" | "myPhrase" | "naturalPhrase" | "reason" | "createdAt" | "source" | "status" | "lessonTitle"
> & { lectureDate?: string };

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
const MAX_REVIEW = 3;

/** New = added since yesterday (KST) & never used in a lecture; review = due today (max 3). QA items are dropped before the caps. */
export function pickLectureCandidates(
  all: LecturePickMistake[],
  due: LecturePickMistake[],
  today: string
): { newMistakes: LectureCandidate[]; reviewMistakes: LectureCandidate[] } {
  const yesterday = addDaysKst(today, -1);
  const fresh = (Array.isArray(all) ? all : [])
    .filter((m) => {
      if (!m?.id || isQaMistake(m)) return false;
      if (m.status === "graduated") return false;
      if (m.lectureDate) return false;
      if (!m.createdAt) return false;
      const kst = kstDateOfIso(m.createdAt);
      return !!kst && kst >= yesterday;
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, MAX_NEW);
  const freshIds = new Set(fresh.map((m) => m.id));
  const review = (Array.isArray(due) ? due : [])
    .filter((m) => m?.id && !isQaMistake(m) && !freshIds.has(m.id))
    .slice(0, MAX_REVIEW);
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
