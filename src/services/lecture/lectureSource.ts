/**
 * Pure helpers: turn a call's post-review mistakes into lecture material,
 * validate phrases against the session's user transcript, and plan backfills.
 * Kept free of firebase so node tests can load it.
 */
import { sessionCallSeconds, SHORT_SESSION_SEC, isQaMistake } from "./lecturePick";
import type { SessionTiming } from "./lecturePick";

export const MAX_NEW_FROM_SESSIONS = 6;
export const VERIFY_MIN_SCORE = 0.75;

export interface ReviewMistakeLike {
  id?: string;
  myPhrase?: string;
  naturalPhrase?: string;
  reason?: string;
  hidden?: boolean;
  sourceStt?: string;
}

export interface SessionSourceLike extends SessionTiming {
  id?: string;
  source?: string;
  status?: string;
  lessonTitle?: string;
  goalId?: string;
  lessonIndex?: number;
  sttFinal?: { transcript?: string };
  sttPartial?: Array<{ transcript?: string }>;
  liveTranscript?: Array<{ role?: string; text?: string }>;
  review?: {
    mistakes?: ReviewMistakeLike[];
    mistakesSaved?: boolean;
    lessonTitle?: string;
  };
}

export interface LectureSourceItem {
  id: string;
  sessionId: string;
  myPhrase: string;
  naturalPhrase: string;
  reason?: string;
  lessonTitle?: string;
  createdAt?: string;
  source?: string;
  sourceStt?: string;
  matchScore: number;
}

export function normalizeUtterance(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildUserCorpus(session: SessionSourceLike): string {
  const parts: string[] = [];
  const finalText = session.sttFinal?.transcript;
  if (finalText) parts.push(finalText);
  for (const p of session.sttPartial || []) {
    if (p?.transcript) parts.push(p.transcript);
  }
  for (const t of session.liveTranscript || []) {
    if (t?.role === "user" && t.text) parts.push(t.text);
  }
  return parts.join("\n");
}

function tokens(s: string): string[] {
  return normalizeUtterance(s).split(" ").filter((t) => t.length > 1);
}

function dice(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) || 0) + 1);
  let overlap = 0;
  for (const t of b) {
    const n = counts.get(t) || 0;
    if (n > 0) {
      overlap += 1;
      counts.set(t, n - 1);
    }
  }
  return (2 * overlap) / (a.length + b.length);
}

/** True when needle tokens appear in order in hay (extra words allowed between). */
function tokensInOrder(needle: string[], hay: string[]): boolean {
  let i = 0;
  for (const t of hay) {
    if (t === needle[i]) i += 1;
    if (i >= needle.length) return true;
  }
  return false;
}

/**
 * Exact normalized substring, or a close token-window / in-order match for STT drift.
 * score 1 = exact, >= VERIFY_MIN_SCORE counts as present in the user transcript.
 */
export function verifyAgainstTranscript(
  phrase: string,
  corpus: string
): { ok: boolean; score: number } {
  const needle = normalizeUtterance(phrase);
  if (!needle || needle.length < 6) return { ok: false, score: 0 };
  const hay = normalizeUtterance(corpus);
  if (!hay) return { ok: false, score: 0 };
  if (hay.includes(needle)) return { ok: true, score: 1 };

  const nTok = tokens(needle);
  const hTok = tokens(hay);
  if (nTok.length < 3) return { ok: false, score: 0 };

  let best = 0;
  const span = Math.max(nTok.length, 3);
  const maxW = span + 3;
  for (let w = Math.max(3, span - 2); w <= maxW; w++) {
    for (let i = 0; i + w <= hTok.length; i++) {
      best = Math.max(best, dice(nTok, hTok.slice(i, i + w)));
    }
  }
  if (best >= VERIFY_MIN_SCORE) return { ok: true, score: best };
  // slightly looser in-order fallback for short phrases with filler around them
  if (nTok.length >= 4 && tokensInOrder(nTok, hTok)) return { ok: true, score: 0.76 };
  return { ok: false, score: best };
}

export function isEligibleLectureSession(
  session: SessionSourceLike,
  cutoffMs: number | undefined
): boolean {
  if (!session?.id) return false;
  if (isQaMistake(session)) return false;
  const sec = sessionCallSeconds(session);
  if (sec != null && sec < SHORT_SESSION_SEC) return false;
  const end = session.endedAt || session.lastTranscriptAt || session.lastChunkAt || session.startedAt;
  const t = Date.parse(end || "");
  if (!Number.isFinite(t)) return false;
  if (cutoffMs != null && Number.isFinite(cutoffMs) && t <= cutoffMs) return false;
  const mistakes = session.review?.mistakes;
  return Array.isArray(mistakes) && mistakes.length > 0;
}

export function backfillDocId(sessionId: string, index: number): string {
  return `call_${sessionId}_${index}`;
}

export function extractReviewLectureItems(
  session: SessionSourceLike,
  opts: { requireVerify?: boolean } = {}
): LectureSourceItem[] {
  const sessionId = session.id || "";
  const corpus = buildUserCorpus(session);
  const requireVerify = opts.requireVerify !== false;
  const lessonTitle = session.review?.lessonTitle || session.lessonTitle;
  const createdAt = session.endedAt || session.startedAt;
  const items: LectureSourceItem[] = [];
  (session.review?.mistakes || []).forEach((m, index) => {
    if (!m || m.hidden) return;
    const myPhrase = String(m.myPhrase || "").trim();
    const naturalPhrase = String(m.naturalPhrase || "").trim();
    if (!myPhrase || !naturalPhrase) return;
    const verified = verifyAgainstTranscript(myPhrase, corpus);
    if (requireVerify && !verified.ok) return;
    items.push({
      id: m.id || backfillDocId(sessionId, index),
      sessionId,
      myPhrase,
      naturalPhrase,
      reason: m.reason ? String(m.reason) : undefined,
      lessonTitle,
      createdAt,
      source: "call",
      sourceStt: m.sourceStt,
      matchScore: verified.score,
    });
  });
  return items;
}

export interface ExistingMistakeLike {
  id?: string;
  sessionId?: string;
  myPhrase?: string;
  naturalPhrase?: string;
}

export function planBackfill(
  sessionId: string,
  reviewMistakes: ReviewMistakeLike[],
  existing: ExistingMistakeLike[]
): { toCreate: Array<{ index: number; id: string; item: ReviewMistakeLike }>; idPatches: Array<{ index: number; id: string }> } {
  const existingForSession = (existing || []).filter((m) => m.sessionId === sessionId);
  const usedIds = new Set(existingForSession.map((m) => m.id).filter(Boolean) as string[]);
  const toCreate: Array<{ index: number; id: string; item: ReviewMistakeLike }> = [];
  const idPatches: Array<{ index: number; id: string }> = [];

  (reviewMistakes || []).forEach((item, index) => {
    if (!item || item.hidden) return;
    const phrase = normalizeUtterance(String(item.myPhrase || ""));
    if (!phrase) return;
    const match = existingForSession.find(
      (m) => normalizeUtterance(String(m.myPhrase || "")) === phrase
    );
    if (match?.id) {
      if (item.id !== match.id) idPatches.push({ index, id: match.id });
      return;
    }
    if (item.id && usedIds.has(item.id)) {
      idPatches.push({ index, id: item.id });
      return;
    }
    const id = item.id || backfillDocId(sessionId, index);
    toCreate.push({ index, id, item });
    idPatches.push({ index, id });
    usedIds.add(id);
  });

  return { toCreate, idPatches };
}

export function collectNewLectureItems(
  sessions: SessionSourceLike[],
  cutoffMs: number | undefined,
  max = MAX_NEW_FROM_SESSIONS
): LectureSourceItem[] {
  const eligible = (sessions || []).filter((s) => isEligibleLectureSession(s, cutoffMs));
  eligible.sort((a, b) => String(b.endedAt || b.startedAt || "").localeCompare(String(a.endedAt || a.startedAt || "")));
  const items = eligible.flatMap((s) => extractReviewLectureItems(s, { requireVerify: true }));
  return items.slice(0, max);
}
