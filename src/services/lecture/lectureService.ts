/**
 * B-7 Morning Lecture client service.
 * Firestore: users/{uid}/lectures/{YYYY-MM-DD}
 * Server job: /api/lecture/* (auth required). Audio is copied to Cloud Storage; DB keeps audioUrl only.
 */
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "../firebase/config";
import {
  MistakeData,
  getUserMistakes,
  getDueMistakes,
  getKSTToday,
  addKSTDays,
  advanceMistakeAfterLesson,
} from "../firebase/db";
import { authFetch, authJson } from "../api/authFetch";
import { recordUsage } from "../usage/usageService";

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
  ttsEngine?: string;
  chars?: number;
  textTokens?: number;
  durationSec?: number;
  listenedAt?: string | null;
  createdAt: string;
  updatedAt?: string;
  error?: string;
}

const lectureRef = (uid: string, date: string) => doc(db, "users", uid, "lectures", date);

export async function getLecture(uid: string, date = getKSTToday()): Promise<LectureDoc | null> {
  const snap = await getDoc(lectureRef(uid, date));
  return snap.exists() ? (snap.data() as LectureDoc) : null;
}

function toPayload(m: MistakeData) {
  return { id: m.id!, myPhrase: m.myPhrase, naturalPhrase: m.naturalPhrase, reason: m.reason };
}

/** New = added since yesterday (KST) & never used in a lecture; review = due today (max 3). */
export async function pickLectureMistakes(uid: string, today = getKSTToday()) {
  const [all, due] = await Promise.all([getUserMistakes(uid), getDueMistakes(uid, today)]);
  const yesterday = addKSTDays(-1, today);
  const toKst = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const fresh = all
    .filter((m) => m.id && m.status !== "graduated" && !(m as any).lectureDate && m.createdAt && toKst(m.createdAt) >= yesterday)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 6);
  const freshIds = new Set(fresh.map((m) => m.id));
  const review = due.filter((m) => m.id && !freshIds.has(m.id)).slice(0, 3);
  return { newMistakes: fresh.map(toPayload), reviewMistakes: review.map(toPayload) };
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
    ttsEngine: lecture.ttsEngine,
    createdAt: lecture.createdAt,
    updatedAt: new Date().toISOString(),
    ...(lecture.error ? { error: lecture.error } : {}),
  };
  await setDoc(lectureRef(uid, date), docData, { merge: true });
  return docData;
}

/**
 * Sync server job → Firestore. When the server finished, copy WAV to Cloud Storage
 * and store audioUrl. Returns the up-to-date Firestore doc (or null).
 */
export async function syncLectureFromServer(uid: string, date = getKSTToday()): Promise<LectureDoc | null> {
  const current = await getLecture(uid, date);
  if (current?.status === "ready" && current.audioUrl) return current;
  const { lecture } = await authJson<{ lecture: any }>(`/api/lecture/status?date=${date}`, undefined, "GET");
  if (!lecture) return current;
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

  // ready → copy audio into Cloud Storage
  let audioUrl: string | null = null;
  try {
    const audioRes = await authFetch(`/api/lecture/audio?date=${date}`);
    if (!audioRes.ok) throw new Error(`audio ${audioRes.status}`);
    const blob = await audioRes.blob();
    const sref = ref(storage, `users/${uid}/lectures/${date}.wav`);
    await uploadBytes(sref, blob, { contentType: "audio/wav" });
    audioUrl = await getDownloadURL(sref);
  } catch (err) {
    console.warn("[Lecture] Cloud Storage upload failed; will stream from server:", err);
  }

  const readyDoc: LectureDoc = {
    date,
    status: "ready",
    title: lecture.title,
    script: lecture.script,
    audioUrl,
    coachNote: lecture.coachNote,
    itemCount: lecture.itemCount,
    newMistakeIds: lecture.newMistakeIds,
    reviewMistakeIds: lecture.reviewMistakeIds,
    ttsEngine: lecture.ttsEngine,
    chars: lecture.chars,
    textTokens: lecture.textTokens,
    durationSec: lecture.durationSec,
    listenedAt: current?.listenedAt || null,
    createdAt: lecture.createdAt,
    updatedAt: new Date().toISOString(),
  };
  await setDoc(lectureRef(uid, date), readyDoc, { merge: true });
  if (current?.status !== "ready") {
    // B-10 usage: lecture script tokens + TTS chars (once per lecture)
    recordUsage(uid, { textTokens: lecture.textTokens || 0, ttsChars: lecture.chars || 0, ttsEngine: "gemini" });
  }

  // Mark new mistakes as used so tomorrow's lecture won't repeat them
  for (const id of lecture.newMistakeIds || []) {
    try {
      await updateDoc(doc(db, "users", uid, "mistakes", id), { lectureDate: date });
    } catch {
      // ignore (mistake may be deleted)
    }
  }
  return readyDoc;
}

/** Get a playable URL: Cloud Storage first, server stream (authed blob) as fallback. */
export async function resolveLectureAudio(lecture: LectureDoc): Promise<string> {
  if (lecture.audioUrl) return lecture.audioUrl;
  const res = await authFetch(`/api/lecture/audio?date=${lecture.date}`);
  if (!res.ok) throw new Error("강의 오디오를 불러오지 못했어요.");
  return URL.createObjectURL(await res.blob());
}

const CACHE_NAME = "onecall-lectures-v1";

/** B-7 #5 Offline pre-download: Cache API, falls back to streaming. Returns object URL or null. */
export async function cacheLectureAudio(url: string): Promise<string | null> {
  if (!("caches" in window) || url.startsWith("blob:")) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    let hit = await cache.match(url);
    if (!hit) {
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) return null;
      await cache.put(url, res.clone());
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
