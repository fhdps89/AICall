/**
 * B-7 Morning Lecture client service.
 * Firestore: users/{uid}/lectures/{YYYY-MM-DD}
 * Server job: /api/lecture/* (auth required). Audio is copied to Cloud Storage; DB keeps audioUrl only.
 */
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "../firebase/config";
import {
  getUserMistakes,
  getDueMistakes,
  getKSTToday,
  getSessionById,
  listRecentSessions,
  saveCallMistakes,
  updateSessionExtraMistakes,
  advanceMistakeAfterLesson,
  type MistakeData,
  type ReviewMistakeItem,
  type SessionData,
} from "../firebase/db";
import { authFetch, authJson } from "../api/authFetch";
import { recordUsage } from "../usage/usageService";
import {
  shouldCopyLectureAudio,
  shouldOverwriteFirestoreLecture,
  listenedAtToKeep,
  shouldMarkLectureDate,
  shouldClearStaleLectureMedia,
  readUploadFailAt,
  writeUploadFailAt,
  clearUploadFailAt,
} from "./lectureSyncPolicy";
import {
  addDaysKst,
  previousLectureCutoffIso,
  newCandidateCutoffMs,
  isQaMistake,
  sessionCallSeconds,
  isShortSession,
  PREVIOUS_LECTURE_LOOKBACK_DAYS,
  MAX_REVIEW_PER_LECTURE,
  type LectureCandidate,
  type SessionTiming,
} from "./lecturePick";
import {
  collectNewLectureItems,
  needsSupplementalPass,
  planBackfill,
  planBackfillExtras,
} from "./lectureSource";

export type LectureStatus = "generating" | "ready" | "failed";

export interface LectureScriptItem {
  mistakeId: string;
  kind: "new" | "review";
  myPhrase: string;
  naturalPhrase: string;
  explanation: string;
  dialogue: { speaker: "Coach" | "Partner"; line: string }[];
  meaningKo: string;
  answerEnglish: string;
  similarExample?: string;
  extraExamples?: string[];
  sourceDateKst?: string;
  lessonTitle?: string;
  startSec?: number;
}

export interface LectureDoc {
  date: string;
  status: LectureStatus;
  title?: string;
  script?: LectureScriptItem[];
  audioUrl?: string | null;
  coachNote?: string;
  itemCount?: number;
  newMistakeIds?: string[];
  reviewMistakeIds?: string[];
  inputNewIds?: string[];
  inputReviewIds?: string[];
  inputLatestCreatedAt?: string;
  ttsEngine?: string;
  chars?: number;
  textTokens?: number;
  textInputTokens?: number;
  textOutputTokens?: number;
  ttsAudioSec?: number;
  ttsAudioChars?: number;
  durationSec?: number;
  listenedAt?: string | null;
  createdAt: string;
  updatedAt?: string;
  error?: string;
  audioStatus?: "ready" | "rebuilding" | "missing";
  audioMime?: string;
  hasAudio?: boolean;
  audioProgress?: { completed: number; total: number };
}

const lectureRef = (uid: string, date: string) => doc(db, "users", uid, "lectures", date);

export async function getLecture(uid: string, date = getKSTToday()): Promise<LectureDoc | null> {
  const snap = await getDoc(lectureRef(uid, date));
  return snap.exists() ? (snap.data() as LectureDoc) : null;
}


/** Load startedAt/endedAt (and last activity fallbacks) for the given session ids. Missing docs are null. */
async function loadSessionsById(
  uid: string,
  sessionIds: Array<string | undefined>
): Promise<Record<string, SessionTiming | null>> {
  const unique = [...new Set(sessionIds.filter((id): id is string => !!id))];
  const entries = await Promise.all(
    unique.map(async (id) => {
      try {
        const s = await getSessionById(uid, id);
        if (!s) return [id, null] as const;
        return [
          id,
          {
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            lastTranscriptAt: s.lastTranscriptAt,
            lastChunkAt: s.lastChunkAt,
          },
        ] as const;
      } catch {
        return [id, null] as const;
      }
    })
  );
  return Object.fromEntries(entries);
}

/** Walk back up to 30 KST days and stop at the latest ready lecture before `today`. */
async function loadPreviousLectureCutoff(uid: string, today: string): Promise<string | undefined> {
  const lectures: Array<{ date: string; status?: string; createdAt?: string }> = [];
  for (let i = 1; i <= PREVIOUS_LECTURE_LOOKBACK_DAYS; i++) {
    const date = addDaysKst(today, -i);
    try {
      const lec = await getLecture(uid, date);
      if (lec) lectures.push({ date, status: lec.status, createdAt: lec.createdAt });
    } catch {
      // Skip a failed lookup and keep walking; missing cutoff falls back to 24h.
    }
    const cutoff = previousLectureCutoffIso(lectures, today);
    if (cutoff) return cutoff;
  }
  return undefined;
}

async function backfillList(
  uid: string,
  s: SessionData,
  list: ReviewMistakeItem[],
  source: "call" | "transcript_analysis",
  known: MistakeData[]
): Promise<ReviewMistakeItem[] | undefined> {
  if (!s.id || !list.length) return undefined;
  const plan =
    source === "transcript_analysis"
      ? planBackfillExtras(s.id, list, known)
      : planBackfill(s.id, list, known);
  if (plan.toCreate.length === 0) return undefined;
  const docs: MistakeData[] = plan.toCreate.map(({ id, item }) => ({
    id,
    myPhrase: String(item.myPhrase || ""),
    naturalPhrase: String(item.naturalPhrase || ""),
    reason: String(item.reason || ""),
    sourceStt: item.sourceStt || "sttFinal",
    stage: 1,
    status: "reviewing",
    source,
    sessionId: s.id,
    goalId: s.goalId,
    lessonIndex: s.lessonIndex,
    lessonTitle: s.review?.lessonTitle,
    createdAt: s.endedAt || s.startedAt || new Date().toISOString(),
  }));
  try {
    const ids = await saveCallMistakes(uid, docs);
    const idByIndex = new Map<number, string>();
    plan.toCreate.forEach((entry, i) => {
      const mid = ids[i] || entry.id;
      known.push({ ...docs[i], id: mid });
      idByIndex.set(entry.index, mid);
    });
    return list.map((m, idx) => (idByIndex.has(idx) ? { ...m, id: idByIndex.get(idx) } : m));
  } catch (err) {
    console.warn(`[lectureSource] backfill (${source}) failed for session`, s.id, err);
    return undefined;
  }
}

async function ensureSessionSupplementalMistakes(
  uid: string,
  sessions: SessionData[],
  cutoffMs: number | undefined
): Promise<void> {
  for (const s of sessions) {
    if (!s.id || !s.review) continue;
    if (!needsSupplementalPass(s, cutoffMs)) continue;
    try {
      const res = await authJson<{
        ok: boolean;
        extraMistakes?: ReviewMistakeItem[];
        status?: "ok" | "skipped" | "failed";
        usage?: { inputTokens?: number; outputTokens?: number };
      }>("/api/review/supplement", {
        sessionId: s.id,
        sttFinal: s.sttFinal?.transcript || "",
        sttPartial: s.sttPartial,
        liveTranscript: s.liveTranscript,
        knownMistakes: s.review.mistakes || [],
        lessonTitle: s.review.lessonTitle,
        callDurationSec: sessionCallSeconds(s) ?? undefined,
        qa: isQaMistake(s),
      });
      if (res.usage && ((res.usage.inputTokens || 0) + (res.usage.outputTokens || 0) > 0)) {
        recordUsage(uid, {
          textInputTokens: res.usage.inputTokens || 0,
          textOutputTokens: res.usage.outputTokens || 0,
        });
      }
      if (!res.ok) continue;
      const status = res.status === "skipped" ? "skipped" : res.status === "failed" ? "failed" : "ok";
      const extras = Array.isArray(res.extraMistakes) ? res.extraMistakes : [];
      s.review.extraMistakes = status === "failed" ? s.review.extraMistakes : extras;
      s.review.extraMistakesStatus = status;
      s.review.extraMistakesAttemptedAt = new Date().toISOString();
      await updateSessionExtraMistakes(uid, s.id, extras, status);
    } catch (err) {
      console.warn("[lectureSource] supplemental pass failed for session", s.id, err);
    }
  }
}

async function backfillReviewMistakes(uid: string, sessions: SessionData[], existing: MistakeData[]): Promise<void> {
  const known = [...existing];
  for (const s of sessions) {
    if (!s.id || isQaMistake(s)) continue;
    if (s.review?.mistakes?.length) {
      await backfillList(uid, s, s.review.mistakes, "call", known);
    }
    if (s.review?.extraMistakes?.length) {
      const patched = await backfillList(uid, s, s.review.extraMistakes, "transcript_analysis", known);
      if (patched) {
        s.review.extraMistakes = patched;
        await updateSessionExtraMistakes(uid, s.id, patched, s.review.extraMistakesStatus || "ok").catch((err) => {
          console.warn("[lectureSource] failed to update extraMistakes ids for session", s.id, err);
        });
      }
    }
  }
}

/**
 * New lecture items come from each qualifying session's post-call review (full-transcript
 * analysis + supplemental pass), not from scanning the mistakes collection. Due reviews still come from the list.
 */
export async function pickLectureMistakes(uid: string, today = getKSTToday(), nowIso = new Date().toISOString()) {
  const [all, due, recent, previousLectureCreatedAt] = await Promise.all([
    getUserMistakes(uid),
    getDueMistakes(uid, today),
    listRecentSessions(uid, 30),
    loadPreviousLectureCutoff(uid, today),
  ]);
  const cutoffMs = newCandidateCutoffMs({ nowIso, previousLectureCreatedAt });
  await ensureSessionSupplementalMistakes(uid, recent, cutoffMs);
  await backfillReviewMistakes(uid, recent, all);

  const newItems = collectNewLectureItems(recent, cutoffMs);
  const newMistakes: LectureCandidate[] = newItems.map((it) => ({
    id: it.id,
    myPhrase: it.myPhrase,
    naturalPhrase: it.naturalPhrase,
    reason: it.reason,
    createdAt: it.createdAt,
    source: it.source,
    lessonTitle: it.lessonTitle,
  }));
  const newIds = new Set(newMistakes.map((m) => m.id));

  const [sessionsById] = await Promise.all([
    loadSessionsById(uid, due.map((m) => m.sessionId)),
  ]);
  const review = (due || []).filter((m) => {
    if (!m?.id || isQaMistake(m) || newIds.has(m.id)) return false;
    const sid = m.sessionId;
    if (!sid || !(sid in sessionsById) || sessionsById[sid] == null) {
      console.warn("[lecturePick] session doc missing or has no usable duration; keeping review mistake", {
        mistakeId: m.id,
        sessionId: sid,
      });
      return true;
    }
    const sec = sessionCallSeconds(sessionsById[sid]);
    if (sec == null) return true;
    return !isShortSession(sec);
  }).slice(0, MAX_REVIEW_PER_LECTURE);

  return {
    newMistakes,
    reviewMistakes: review.map((m) => ({
      id: m.id!,
      myPhrase: m.myPhrase,
      naturalPhrase: m.naturalPhrase,
      reason: m.reason,
      createdAt: m.createdAt,
      source: m.source,
      lessonTitle: m.lessonTitle,
    })),
  };
}

export async function startLecture(uid: string, date = getKSTToday(), force = false): Promise<LectureDoc> {
  const picked = await pickLectureMistakes(uid, date);
  if (picked.newMistakes.length + picked.reviewMistakes.length === 0) {
    throw new Error("오늘 강의에 넣을 새 실수나 복습 대상이 없어요.");
  }
  const { lecture } = await authJson<{ lecture: any }>("/api/lecture/generate", { date, force, ...picked });
  const docData: LectureDoc = {
    date,
    status: lecture.status,
    newMistakeIds: lecture.newMistakeIds,
    reviewMistakeIds: lecture.reviewMistakeIds,
    ...(Array.isArray(lecture.inputNewIds) ? { inputNewIds: lecture.inputNewIds } : {}),
    ...(Array.isArray(lecture.inputReviewIds) ? { inputReviewIds: lecture.inputReviewIds } : {}),
    ...(typeof lecture.inputLatestCreatedAt === "string" ? { inputLatestCreatedAt: lecture.inputLatestCreatedAt } : {}),
    ttsEngine: lecture.ttsEngine,
    createdAt: lecture.createdAt,
    updatedAt: new Date().toISOString(),
    ...(shouldClearStaleLectureMedia(lecture.status, force, {
        genSkipped: lecture.error === "GEN_SKIPPED",
      })
      ? { audioUrl: null, listenedAt: null }
      : {}),
    ...(lecture.error ? { error: lecture.error } : {}),
  };
  await setDoc(lectureRef(uid, date), docData, { merge: true });
  return docData;
}

/**
 * Sync server job metadata → Firestore. Does not download the WAV.
 * A different ready lecture on the server does not replace an already-ready Firestore doc.
 */
export async function syncLectureStatus(uid: string, date = getKSTToday()): Promise<LectureDoc | null> {
  const current = await getLecture(uid, date);
  if (current?.status === "ready" && current.audioUrl) return current;
  const { lecture } = await authJson<{ lecture: any }>(`/api/lecture/status?date=${date}`, undefined, "GET");
  if (!lecture) {
    // The server has no record (its .data/ folder was wiped on restart). A Firestore doc still
    // saying "generating" would otherwise keep the card spinning forever.
    if (current?.status === "generating") {
      const failed: LectureDoc = { ...current, status: "failed", error: "INTERRUPTED", updatedAt: new Date().toISOString() };
      await setDoc(lectureRef(uid, date), failed, { merge: true });
      return failed;
    }
    return current;
  }
  if (current?.status === "ready" && !shouldOverwriteFirestoreLecture(current, lecture)) {
    return current;
  }
  if (lecture.status !== "ready") {
    const patch: LectureDoc = {
      ...(current || { createdAt: lecture.createdAt }),
      date,
      status: lecture.status,
      title: lecture.title || current?.title || "",
      newMistakeIds: lecture.newMistakeIds,
      reviewMistakeIds: lecture.reviewMistakeIds,
      updatedAt: new Date().toISOString(),
      ...(lecture.error ? { error: lecture.error } : {}),
    } as LectureDoc;
    await setDoc(lectureRef(uid, date), patch, { merge: true });
    return patch;
  }

  const readyDoc: LectureDoc = {
    date,
    status: "ready",
    title: lecture.title,
    script: lecture.script,
    audioUrl: current?.createdAt === lecture.createdAt ? (current?.audioUrl || null) : null,
    coachNote: lecture.coachNote,
    itemCount: lecture.itemCount,
    newMistakeIds: lecture.newMistakeIds,
    reviewMistakeIds: lecture.reviewMistakeIds,
    ...(Array.isArray(lecture.inputNewIds) ? { inputNewIds: lecture.inputNewIds } : {}),
    ...(Array.isArray(lecture.inputReviewIds) ? { inputReviewIds: lecture.inputReviewIds } : {}),
    ...(typeof lecture.inputLatestCreatedAt === "string" ? { inputLatestCreatedAt: lecture.inputLatestCreatedAt } : {}),
    ttsEngine: lecture.ttsEngine,
    chars: lecture.chars,
    textTokens: lecture.textTokens,
    ...(typeof lecture.textInputTokens === "number" ? { textInputTokens: lecture.textInputTokens } : {}),
    ...(typeof lecture.textOutputTokens === "number" ? { textOutputTokens: lecture.textOutputTokens } : {}),
    ...(typeof lecture.ttsAudioSec === "number" ? { ttsAudioSec: lecture.ttsAudioSec } : {}),
    ...(typeof lecture.ttsAudioChars === "number" ? { ttsAudioChars: lecture.ttsAudioChars } : {}),
    durationSec: lecture.durationSec,
    listenedAt: listenedAtToKeep(current, lecture.createdAt),
    createdAt: lecture.createdAt,
    updatedAt: new Date().toISOString(),
    audioStatus: (lecture as LectureDoc).audioStatus,
    audioMime: (lecture as LectureDoc).audioMime,
    hasAudio: Boolean((lecture as LectureDoc).hasAudio),
    audioProgress: (lecture as LectureDoc).audioProgress,
  };
  await setDoc(lectureRef(uid, date), readyDoc, { merge: true });
  if (shouldMarkLectureDate(current?.status, "ready")) {
    // B-10 usage: lecture script tokens + TTS chars/audio (once per lecture)
    const hasSplitTokens =
      typeof lecture.textInputTokens === "number" || typeof lecture.textOutputTokens === "number";
    recordUsage(uid, {
      ...(hasSplitTokens
        ? {
            textInputTokens: lecture.textInputTokens || 0,
            textOutputTokens: lecture.textOutputTokens || 0,
          }
        : { textTokens: lecture.textTokens || 0 }),
      ttsChars: lecture.chars || 0,
      // ttsAudioSec is the measured (cache-miss) audio for the whole lecture, so all of its chars are
      // covered by it; marking them prevents the legacy chars→seconds fallback from billing cache hits.
      ...(typeof lecture.ttsAudioSec === "number"
        ? { ttsAudioSec: lecture.ttsAudioSec, ttsAudioChars: lecture.chars || 0 }
        : {}),
      ttsEngine: "gemini",
    });
    for (const id of lecture.newMistakeIds || []) {
      try {
        await updateDoc(doc(db, "users", uid, "mistakes", id), { lectureDate: date });
      } catch {
        // ignore (mistake may be deleted)
      }
    }
  }
  return readyDoc;
}

const audioCopyInFlight = new Map<string, Promise<LectureDoc | null>>();

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Download the server WAV and upload to Cloud Storage. Single-flight + backoff on failure. */
export async function copyLectureAudio(uid: string, date: string, current?: LectureDoc | null): Promise<LectureDoc | null> {
  const key = `${uid}:${date}`;
  const existing = audioCopyInFlight.get(key);
  if (existing) return existing;
  const work = (async () => {
    const latest = current ?? (await getLecture(uid, date));
    if (!latest || latest.status !== "ready") return latest;
    if (latest.audioUrl) return latest;
    if (latest.hasAudio === false) return latest;
    let audioUrl: string | null = null;
    try {
      const audioRes = await authFetch(`/api/lecture/audio?date=${date}`);
      if (!audioRes.ok) throw new Error(`audio ${audioRes.status}`);
      const blob = await audioRes.blob();
      const mime = audioRes.headers.get("content-type") || latest.audioMime || "audio/wav";
      const ext = mime.includes("mpeg") || mime.includes("mp3") ? "mp3" : mime.includes("wav") ? "wav" : "m4a";
      const sref = ref(storage, `users/${uid}/lectures/${date}.${ext}`);
      await uploadBytes(sref, blob, { contentType: mime });
      audioUrl = await getDownloadURL(sref);
      clearUploadFailAt(browserStorage(), uid, date);
    } catch (err) {
      writeUploadFailAt(browserStorage(), uid, date, Date.now());
      console.warn("[Lecture] Cloud Storage upload failed; will stream from server:", err);
      return latest;
    }
    const readyDoc: LectureDoc = { ...latest, audioUrl, updatedAt: new Date().toISOString() };
    await setDoc(lectureRef(uid, date), { audioUrl, updatedAt: readyDoc.updatedAt }, { merge: true });
    return readyDoc;
  })().finally(() => {
    if (audioCopyInFlight.get(key) === work) audioCopyInFlight.delete(key);
  });
  audioCopyInFlight.set(key, work);
  return work;
}

/**
 * Sync server job → Firestore. Metadata first; WAV copy is optional and skipped during backoff.
 */
export async function syncLectureFromServer(uid: string, date = getKSTToday()): Promise<LectureDoc | null> {
  const docData = await syncLectureStatus(uid, date);
  const store = browserStorage();
  if (shouldCopyLectureAudio(docData, Date.now(), readUploadFailAt(store, uid, date))) {
    return copyLectureAudio(uid, date, docData);
  }
  return docData;
}

export async function rebuildLectureAudio(lecture: LectureDoc): Promise<void> {
  const body: Record<string, unknown> = { date: lecture.date };
  if (lecture.script && lecture.script.length > 0) {
    body.script = lecture.script;
    body.title = lecture.title;
    body.coachNote = lecture.coachNote;
    body.newMistakeIds = lecture.newMistakeIds;
    body.reviewMistakeIds = lecture.reviewMistakeIds;
    if (lecture.inputNewIds) body.inputNewIds = lecture.inputNewIds;
    if (lecture.inputReviewIds) body.inputReviewIds = lecture.inputReviewIds;
    if (lecture.inputLatestCreatedAt) body.inputLatestCreatedAt = lecture.inputLatestCreatedAt;
    body.ttsEngine = lecture.ttsEngine;
    body.createdAt = lecture.createdAt;
    body.textTokens = lecture.textTokens;
    if (typeof lecture.textInputTokens === "number") body.textInputTokens = lecture.textInputTokens;
    if (typeof lecture.textOutputTokens === "number") body.textOutputTokens = lecture.textOutputTokens;
    if (typeof lecture.ttsAudioSec === "number") body.ttsAudioSec = lecture.ttsAudioSec;
    if (typeof lecture.ttsAudioChars === "number") body.ttsAudioChars = lecture.ttsAudioChars;
    body.itemCount = lecture.itemCount;
  }
  await authJson<{ lecture: unknown }>("/api/lecture/audio/rebuild", body);
}

export async function fetchLectureStatus(date: string): Promise<LectureDoc | null> {
  const { lecture } = await authJson<{ lecture: LectureDoc | null }>(
    `/api/lecture/status?date=${date}`,
    undefined,
    "GET"
  );
  return lecture ?? null;
}

export async function waitForLectureAudio(
  date: string,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    stallMs?: number;
    signal?: AbortSignal;
    onProgress?: (lecture: LectureDoc | null) => void;
  } = {}
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const intervalMs = opts.intervalMs ?? 3000;
  const stallMs = opts.stallMs ?? 3 * 60_000;
  const started = Date.now();
  let lastSig = "";
  let lastChange = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (opts.signal?.aborted) return false;
    const st = await fetchLectureStatus(date).catch(() => null);
    opts.onProgress?.(st);
    if (st?.hasAudio || st?.audioStatus === "ready") {
      const res = await authFetch(`/api/lecture/audio?date=${date}`);
      if (res.ok) return true;
    }
    if (st?.audioStatus === "missing" && st.error && st.error !== "GENERATION_FAILED") {
      return false;
    }
    const sig = `${st?.audioStatus ?? ""}:${st?.audioProgress?.completed ?? ""}:${st?.updatedAt ?? ""}`;
    if (sig !== lastSig) {
      lastSig = sig;
      lastChange = Date.now();
    } else if (Date.now() - lastChange > stallMs && st?.audioStatus !== "rebuilding") {
      return false;
    } else if (st?.audioStatus === "rebuilding" && Date.now() - lastChange > stallMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export async function fetchLectureAudioBlob(date: string): Promise<{ url: string; blob: Blob; mime: string } | null> {
  const res = await authFetch(`/api/lecture/audio?date=${date}`);
  if (!res.ok) return null;
  const blob = await res.blob();
  const mime = res.headers.get("content-type") || "audio/mp4";
  return { url: URL.createObjectURL(blob), blob, mime };
}

/** Get a playable URL: Cloud Storage first, server stream as fallback. If the file was lost on the server, rebuild TTS from the saved script and poll status until ready. */
export async function resolveLectureAudio(
  lecture: LectureDoc,
  opts: {
    onRebuilding?: () => void;
    onProgress?: (lecture: LectureDoc | null) => void;
    signal?: AbortSignal;
  } = {}
): Promise<{ url: string; blob?: Blob; mime?: string }> {
  if (lecture.audioUrl) return { url: lecture.audioUrl };
  const existing = await fetchLectureAudioBlob(lecture.date);
  if (existing) return existing;
  if ((lecture.script?.length || 0) > 0) {
    opts.onRebuilding?.();
    await rebuildLectureAudio(lecture);
    const ready = await waitForLectureAudio(lecture.date, {
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    if (ready) {
      const again = await fetchLectureAudioBlob(lecture.date);
      if (again) return again;
    }
  }
  throw new Error("강의 오디오를 불러오지 못했어요.");
}

const CACHE_NAME = "onecall-lectures-v2";

/** Offline pre-download: Cache API, including blob: results from an authenticated fetch. */
export async function cacheLectureAudio(
  url: string,
  opts?: { blob?: Blob; mime?: string; cacheKey?: string }
): Promise<string | null> {
  if (!("caches" in window)) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const key = opts?.cacheKey || url;
    if (url.startsWith("blob:") && !opts?.blob) return null;
    let hit = !url.startsWith("blob:") ? await cache.match(key) : undefined;
    if (!hit) {
      const blob =
        opts?.blob ||
        (await (async () => {
          const res = await fetch(url, { mode: "cors" });
          if (!res.ok) return null;
          return res.blob();
        })());
      if (!blob) return null;
      const res = new Response(blob, { headers: { "Content-Type": opts?.mime || blob.type || "audio/mp4" } });
      await cache.put(key, res.clone());
      hit = res;
    }
    return URL.createObjectURL(await hit.blob());
  } catch (err) {
    console.warn("[Lecture] offline cache failed, streaming instead:", err);
    return null;
  }
}

/** Called when the lecture was fully heard (or 「강의 완료」). Advances only included review mistakes, once. */
export async function completeLecture(uid: string, lecture: LectureDoc): Promise<number> {
  if (lecture.listenedAt) return 0;
  let advanced = 0;
  for (const id of lecture.reviewMistakeIds || []) {
    try {
      await advanceMistakeAfterLesson(uid, id);
      advanced++;
    } catch (err) {
      console.warn("[Lecture] advance failed", id, err);
    }
  }
  await updateDoc(lectureRef(uid, lecture.date), { listenedAt: new Date().toISOString() });
  return advanced;
}
