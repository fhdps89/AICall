/**
 * Pure helpers: turn a call's post-review mistakes into lecture material,
 * validate phrases against the session's user transcript, and plan backfills.
 * Kept free of firebase so node tests can load it.
 */
import { sessionCallSeconds, SHORT_SESSION_SEC, isQaMistake } from "./lecturePick.ts";
import type { SessionTiming } from "./lecturePick.ts";
import { FILLER_WORDS } from "../review/speechCheck.ts";

export const MAX_NEW_FROM_SESSIONS = 20;
export const SUPPLEMENT_MAX_ITEMS = 8;
export const VERIFY_MIN_SCORE = 0.75;

const SOUND_TAG_RE = /\[[^\]]*\]|\([^)]*\)|<[^>]*>/g;
const TITLE_WORD_RE = /^[A-Z][a-z]+$/;

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
    extraMistakes?: ReviewMistakeLike[];
    extraMistakesStatus?: "ok" | "skipped" | "failed";
    extraMistakesError?: string;
    extraMistakesAttemptedAt?: string;
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

export function preferredUserTranscript(session: SessionSourceLike): string {
  const finalText = String(session?.sttFinal?.transcript || "").trim();
  if (finalText) {
    const norm = normalizeUtterance(finalText);
    const nonFillers = tokens(finalText).filter((t) => !FILLER_WORDS.has(t));
    if (norm.length >= 24 || (norm.length >= 6 && nonFillers.length >= 3)) {
      return finalText;
    }
  }
  const liveTurns = (session?.liveTranscript || [])
    .filter((t) => t?.role === "user" && t.text)
    .map((t) => String(t.text).trim())
    .filter(Boolean);
  if (liveTurns.length > 0) return liveTurns.join("\n");
  return finalText;
}

export function isUsableSupplementPhrase(phrase: string): boolean {
  if (typeof phrase !== "string") return false;
  const stripped = phrase.replace(SOUND_TAG_RE, " ").trim();
  if (!stripped) return false;

  const norm = normalizeUtterance(stripped);
  if (norm.length < 6) return false;

  const toks = tokens(stripped);
  if (toks.length < 3) return false;

  const nonFillers = toks.filter((t) => !FILLER_WORDS.has(t));
  if (nonFillers.length < 2) return false;

  const nonSpace = stripped.replace(/\s+/g, "");
  if (!nonSpace) return false;
  const asciiLetters = (stripped.match(/[a-zA-Z]/g) || []).length;
  const allLetters = (stripped.match(/\p{L}/gu) || []).length;
  if (asciiLetters === 0 || allLetters === 0) return false;
  if (asciiLetters / allLetters < 0.5) return false;
  if (allLetters / nonSpace.length < 0.4) return false;

  // Drop person-name-only fragments (e.g., "David Kim" or "Mr. David Kim" without a clause).
  const rawWords = stripped
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ""))
    .filter(Boolean)
    .filter((w) => !FILLER_WORDS.has(w.toLowerCase()));
  if (
    rawWords.length > 0 &&
    rawWords.length <= 3 &&
    rawWords.every((w) => TITLE_WORD_RE.test(w) || /^(mr|mrs|ms|dr)$/i.test(w))
  ) {
    return false;
  }

  return true;
}

export function phrasesAreDuplicate(a: string, b: string): boolean {
  const na = normalizeUtterance(a);
  const nb = normalizeUtterance(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ab = verifyAgainstTranscript(a, b);
  if (ab.ok && ab.score >= 0.9) return true;
  const ba = verifyAgainstTranscript(b, a);
  if (ba.ok && ba.score >= 0.9) return true;
  return false;
}

export interface MergedSupplementItem {
  myPhrase: string;
  naturalPhrase: string;
  reason: string;
  sourceStt?: string;
}

export function mergeSupplementItems(
  known: Array<{ myPhrase?: string; hidden?: boolean }>,
  raw: unknown,
  corpus: string
): MergedSupplementItem[] {
  if (!Array.isArray(raw)) return [];
  const knownPhrases = (known || [])
    .map((k) => String(k?.myPhrase || "").trim())
    .filter(Boolean);
  const kept: MergedSupplementItem[] = [];

  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    const myPhrase = String(obj.myPhrase || "").trim();
    const naturalPhrase = String(obj.naturalPhrase || "").trim();
    const reason = String(obj.reason || "").trim();
    if (!myPhrase || !naturalPhrase) continue;
    if (!isUsableSupplementPhrase(myPhrase)) continue;
    if (!verifyAgainstTranscript(myPhrase, corpus).ok) continue;
    if (knownPhrases.some((k) => phrasesAreDuplicate(myPhrase, k))) continue;
    if (kept.some((k) => phrasesAreDuplicate(myPhrase, k.myPhrase))) continue;

    const sourceStt =
      typeof obj.sourceStt === "string" && obj.sourceStt.trim()
        ? obj.sourceStt.trim()
        : undefined;
    kept.push({
      myPhrase,
      naturalPhrase,
      reason,
      ...(sourceStt ? { sourceStt } : {}),
    });
    if (kept.length >= SUPPLEMENT_MAX_ITEMS) break;
  }
  return kept;
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
  const extras = session.review?.extraMistakes;
  return (Array.isArray(mistakes) && mistakes.length > 0) || (Array.isArray(extras) && extras.length > 0);
}

/** Retry a failed supplemental pass after this wait, so home/feed sync does not hammer the model. */
export const SUPPLEMENT_RETRY_FAILED_MS = 30 * 60 * 1000;

/**
 * True when a reviewed session should run (or retry) the supplemental transcript pass.
 * Unlike isEligibleLectureSession, a session with zero primary mistakes can still qualify.
 * Failed passes are retried after SUPPLEMENT_RETRY_FAILED_MS; ok/skipped are not retried.
 */
export function needsSupplementalPass(
  session: SessionSourceLike,
  cutoffMs: number | undefined,
  nowMs = Date.now()
): boolean {
  if (!session?.id || !session.review) return false;
  const status = session.review.extraMistakesStatus;
  if (status === "ok" || status === "skipped") return false;
  if (status === "failed") {
    const attempted = Date.parse(String(session.review.extraMistakesAttemptedAt || ""));
    if (Number.isFinite(attempted) && nowMs - attempted < SUPPLEMENT_RETRY_FAILED_MS) return false;
  } else if (session.review.extraMistakes !== undefined) {
    return false;
  }
  if (isQaMistake(session)) return false;
  const sec = sessionCallSeconds(session);
  if (sec != null && sec < SHORT_SESSION_SEC) return false;
  const end = session.endedAt || session.lastTranscriptAt || session.lastChunkAt || session.startedAt;
  const t = Date.parse(end || "");
  if (!Number.isFinite(t)) return false;
  if (cutoffMs != null && Number.isFinite(cutoffMs) && t <= cutoffMs) return false;
  return Boolean(preferredUserTranscript(session).trim() || buildUserCorpus(session).trim());
}

export function backfillDocId(sessionId: string, index: number): string {
  return `call_${sessionId}_${index}`;
}

export function supplementBackfillDocId(sessionId: string, index: number): string {
  return `ta_${sessionId}_${index}`;
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

  const pushList = (
    list: ReviewMistakeLike[] | undefined,
    source: "call" | "transcript_analysis",
    idForIndex: (index: number) => string
  ) => {
    (list || []).forEach((m, index) => {
      if (!m || m.hidden) return;
      const myPhrase = String(m.myPhrase || "").trim();
      const naturalPhrase = String(m.naturalPhrase || "").trim();
      if (!myPhrase || !naturalPhrase) return;
      const verified = verifyAgainstTranscript(myPhrase, corpus);
      if (requireVerify && !verified.ok) return;
      items.push({
        id: m.id || idForIndex(index),
        sessionId,
        myPhrase,
        naturalPhrase,
        reason: m.reason ? String(m.reason) : undefined,
        lessonTitle,
        createdAt,
        source,
        sourceStt: m.sourceStt,
        matchScore: verified.score,
      });
    });
  };

  pushList(session.review?.mistakes, "call", (i) => backfillDocId(sessionId, i));
  pushList(session.review?.extraMistakes, "transcript_analysis", (i) => supplementBackfillDocId(sessionId, i));
  return items;
}

export interface ExistingMistakeLike {
  id?: string;
  sessionId?: string;
  source?: string;
  myPhrase?: string;
  naturalPhrase?: string;
}

export function planBackfill(
  sessionId: string,
  reviewMistakes: ReviewMistakeLike[],
  existing: ExistingMistakeLike[],
  opts: { source?: "call" | "transcript_analysis" } = {}
): { toCreate: Array<{ index: number; id: string; item: ReviewMistakeLike }>; idPatches: Array<{ index: number; id: string }> } {
  const source = opts.source === "transcript_analysis" ? "transcript_analysis" : "call";
  const existingForSession = (existing || []).filter((m) => m.sessionId === sessionId);
  // Supplemental transcript_analysis docs must not replace or suppress primary call docs.
  const matchPool =
    source === "transcript_analysis"
      ? existingForSession
      : existingForSession.filter((m) => m.source !== "transcript_analysis");
  const usedIds = new Set(existingForSession.map((m) => m.id).filter(Boolean) as string[]);
  const toCreate: Array<{ index: number; id: string; item: ReviewMistakeLike }> = [];
  const idPatches: Array<{ index: number; id: string }> = [];

  (reviewMistakes || []).forEach((item, index) => {
    if (!item || item.hidden) return;
    const phrase = normalizeUtterance(String(item.myPhrase || ""));
    if (!phrase) return;
    const match = matchPool.find(
      (m) => normalizeUtterance(String(m.myPhrase || "")) === phrase
    );
    if (match?.id) {
      const canPatchId = source === "call" || match.source === "transcript_analysis" || !match.source;
      if (canPatchId && item.id !== match.id) idPatches.push({ index, id: match.id });
      return;
    }
    if (item.id && usedIds.has(item.id)) {
      idPatches.push({ index, id: item.id });
      return;
    }
    const id =
      item.id ||
      (source === "transcript_analysis"
        ? supplementBackfillDocId(sessionId, index)
        : backfillDocId(sessionId, index));
    toCreate.push({ index, id, item });
    idPatches.push({ index, id });
    usedIds.add(id);
  });

  return { toCreate, idPatches };
}

export function planBackfillExtras(
  sessionId: string,
  extraMistakes: ReviewMistakeLike[],
  existing: ExistingMistakeLike[]
) {
  return planBackfill(sessionId, extraMistakes, existing, { source: "transcript_analysis" });
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
