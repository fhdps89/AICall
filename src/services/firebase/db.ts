import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  getDocs,
  writeBatch,
  arrayUnion,
  query,
  where,
  orderBy,
  limit,
} from "firebase/firestore";
import { db, auth } from "./config";

export enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
    },
    operationType,
    path,
  };
  console.error("Firestore Error: ", JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export interface UserProfileData {
  email: string;
  job: string;
  surveyTopics: string;
  phillyRole: string;
  sttEngine: string;
  ttsEngine: string;
  lectureTime: string;
  feedSecret: string;
  initialProgressConfigured: boolean;
  updatedAt: string;
}

export interface GoalData {
  id: string;
  title: string;
  type: string;
  why: string;
  priority: number;
  tutorPrompt: string;
  lessons: { index: number; title: string; completed?: boolean }[];
  nextLessonIndex: number;
  status: "active" | "paused" | "done";
  updatedAt: string;
}

/**
 * Fetch or initialize the user's profile
 */
export async function getUserProfile(userId: string): Promise<UserProfileData | null> {
  const userRef = doc(db, "users", userId);
  try {
    const snap = await getDoc(userRef);
    if (!snap.exists()) return null;
    return snap.data() as UserProfileData;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `users/${userId}`);
  }
}

/**
 * Save or update user profile
 */
export async function saveUserProfile(
  userId: string,
  data: Partial<UserProfileData>
): Promise<void> {
  const userRef = doc(db, "users", userId);
  try {
    await setDoc(userRef, { ...data, updatedAt: new Date().toISOString() }, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${userId}`);
  }
}

/**
 * Fetch all goals for a user
 */
export async function getUserGoals(userId: string): Promise<GoalData[]> {
  const goalsCol = collection(db, "users", userId, "goals");
  try {
    const snap = await getDocs(goalsCol);
    return snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() as Omit<GoalData, "id">) }));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, `users/${userId}/goals`);
  }
}

/**
 * Save or update an individual goal
 */
export async function saveUserGoal(userId: string, goal: GoalData): Promise<void> {
  const goalRef = doc(db, "users", userId, "goals", goal.id);
  try {
    await setDoc(goalRef, { ...goal, updatedAt: new Date().toISOString() }, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${userId}/goals/${goal.id}`);
  }
}

/**
 * Update next lesson index for a goal
 */
export async function updateGoalProgress(
  userId: string,
  goalId: string,
  nextLessonIndex: number
): Promise<void> {
  const goalRef = doc(db, "users", userId, "goals", goalId);
  try {
    await updateDoc(goalRef, {
      nextLessonIndex,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${userId}/goals/${goalId}`);
  }
}

/**
 * Batch initialize default goals in Firestore for the first run
 */
export async function batchInitGoals(userId: string, goals: GoalData[]): Promise<void> {
  try {
    const batch = writeBatch(db);
    for (const g of goals) {
      const gRef = doc(db, "users", userId, "goals", g.id);
      batch.set(gRef, { ...g, updatedAt: new Date().toISOString() });
    }
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${userId}/goals (batch)`);
  }
}

// ----------------------------------------------------
// B-3 Call Session & Audio Recording Chunks Types & Helpers
// ----------------------------------------------------

export interface RecordingChunkMeta {
  index: number;
  path: string;
  storageUrl?: string;
  timestamp: string;
  uploaded: boolean;
  durationSeconds: number;
  sizeBytes?: number;
}

export interface SttPartialItem {
  minuteIndex: number;
  timeRange: string;
  transcript: string;
  timestamp: string;
  sourceChunkIndices: number[];
}

export interface SttFinalData {
  transcript: string;
  sourceStt: "sttFinal" | "sttPartial_fallback";
  createdAt: string;
  engine: string;
  mode: string;
}

export interface ReviewMistakeItem {
  id?: string;
  myPhrase: string; // copied verbatim from recording transcript, never corrected
  naturalPhrase: string;
  reason: string;
  sourceStt: string;
  hidden?: boolean;
}

export interface SessionReviewData {
  overallEvaluation: string;
  estimatedLevel: "IM2" | "IH" | "AL" | "Native";
  mistakes: ReviewMistakeItem[];
  keyExpressions: Array<{
    expression: string;
    situation: string;
    exampleSentence: string;
  }>;
  usedCorrectly: string[];
  repeatedMistakes: string[];
  keepSyncText: string;
  generatedAt: string;
}

export interface SessionData {
  id: string;
  goalId: string;
  lessonIndex: number;
  startedAt: string;
  endedAt?: string;
  lastChunkAt?: string;
  status: "in-progress" | "pending_review" | "done";
  liveTranscript: Array<{ role: "user" | "model"; text: string; timestamp?: number }>;
  recordingChunks: RecordingChunkMeta[];
  sttPartial: SttPartialItem[];
  sttFinal?: SttFinalData;
  review?: SessionReviewData;
  connectionPath?: "direct" | "proxy";
  directFailCount?: number;
  createdAt: string;
  updatedAt?: string;
}

export type MistakeStage = 1 | 3 | 7 | 14;
export type MistakeStatus = "reviewing" | "graduated" | "deferred" | "on_hold";

export interface MistakeData {
  id?: string;
  createdAt: string;
  source: "call" | "keep_import";
  sessionId?: string;
  goalId?: string;
  lessonIndex?: number;
  lessonTitle?: string;
  myPhrase: string;
  naturalPhrase: string;
  reason: string;
  sourceStt: string;
  meaningKo?: string; // Korean translation for B-6 Quiz flashcard
  stage: MistakeStage;
  status: MistakeStatus;
  nextReviewAt?: string; // YYYY-MM-DD
  nextReviewDate?: string; // backwards compatibility
  reopenCount?: number;
  graduatedAt?: string;
  graduatedReason?: string;
  reopenedAt?: string;
  lastLessonAdvanceAt?: string;
  updatedAt?: string;
}

export interface QualityReportData {
  id?: string;
  sessionId: string;
  myPhrase: string;
  sourceStt: string;
  reportedAt: string;
  reason?: string;
}

/**
 * Initialize a new call session document when a call starts
 */
export async function createCallSession(
  userId: string,
  sessionId: string,
  data: {
    goalId: string;
    lessonIndex: number;
    connectionPath?: "direct" | "proxy";
  }
): Promise<void> {
  const sessionRef = doc(db, "users", userId, "sessions", sessionId);
  const now = new Date().toISOString();
  try {
    await setDoc(sessionRef, {
      goalId: data.goalId,
      lessonIndex: data.lessonIndex,
      startedAt: now,
      lastChunkAt: now,
      status: "in-progress",
      liveTranscript: [],
      recordingChunks: [],
      sttPartial: [],
      connectionPath: data.connectionPath || "direct",
      directFailCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${userId}/sessions/${sessionId}`);
  }
}

/**
 * Append an audio recording chunk to session metadata and update lastChunkAt
 */
export async function appendSessionChunk(
  userId: string,
  sessionId: string,
  chunkMeta: RecordingChunkMeta
): Promise<void> {
  const sessionRef = doc(db, "users", userId, "sessions", sessionId);
  const now = new Date().toISOString();
  try {
    await updateDoc(sessionRef, {
      recordingChunks: arrayUnion(chunkMeta),
      lastChunkAt: now,
      updatedAt: now,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${userId}/sessions/${sessionId}`);
  }
}

/**
 * Append a 1-minute partial STT transcript to the session
 */
export async function appendSessionSttPartial(
  userId: string,
  sessionId: string,
  sttItem: SttPartialItem
): Promise<void> {
  const sessionRef = doc(db, "users", userId, "sessions", sessionId);
  const now = new Date().toISOString();
  try {
    await updateDoc(sessionRef, {
      sttPartial: arrayUnion(sttItem),
      updatedAt: now,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${userId}/sessions/${sessionId}`);
  }
}

/**
 * Update the continuous live transcript in Firestore
 */
export async function updateSessionLiveTranscript(
  userId: string,
  sessionId: string,
  liveTranscript: Array<{ role: "user" | "model"; text: string; timestamp?: number }>
): Promise<void> {
  const sessionRef = doc(db, "users", userId, "sessions", sessionId);
  try {
    await updateDoc(sessionRef, {
      liveTranscript,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${userId}/sessions/${sessionId}`);
  }
}

/**
 * Finalize a normal call session
 */
export async function finalizeCallSession(
  userId: string,
  sessionId: string,
  data: {
    liveTranscript: Array<{ role: "user" | "model"; text: string; timestamp?: number }>;
    connectionPath?: "direct" | "proxy";
    directFailCount?: number;
  }
): Promise<void> {
  const sessionRef = doc(db, "users", userId, "sessions", sessionId);
  const now = new Date().toISOString();
  try {
    await updateDoc(sessionRef, {
      status: "done",
      endedAt: now,
      liveTranscript: data.liveTranscript,
      connectionPath: data.connectionPath || "direct",
      directFailCount: data.directFailCount ?? 0,
      updatedAt: now,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${userId}/sessions/${sessionId}`);
  }
}

/**
 * Find unfinished or interrupted sessions for the user (for "끝나지 않은 통화가 있어요. 복기할까요?")
 */
export async function getUnfinishedSessions(userId: string): Promise<SessionData[]> {
  const sessionsCol = collection(db, "users", userId, "sessions");
  try {
    const q = query(
      sessionsCol,
      where("status", "in", ["in-progress", "pending_review"]),
      orderBy("startedAt", "desc"),
      limit(5)
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SessionData, "id">) }));
  } catch (error) {
    // If composite index is missing in development, fallback to fetching recent and filtering in-memory
    try {
      const snap = await getDocs(sessionsCol);
      const all = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SessionData, "id">) }));
      return all
        .filter((s) => s.status === "in-progress" || s.status === "pending_review")
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
        .slice(0, 5);
    } catch {
      return [];
    }
  }
}

/**
 * Mark an interrupted session as pending_review
 */
export async function markSessionPendingReview(userId: string, sessionId: string): Promise<void> {
  const sessionRef = doc(db, "users", userId, "sessions", sessionId);
  try {
    await updateDoc(sessionRef, {
      status: "pending_review",
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${userId}/sessions/${sessionId}`);
  }
}

/**
 * B-4 Requirement 0: Firestore-based interrupted session watchdog.
 * If status is in-progress and lastChunkAt is > 2 minutes ago, automatically transitions status to pending_review.
 */
export async function checkAndMarkInterruptedSessions(userId: string): Promise<SessionData[]> {
  const sessionsCol = collection(db, "users", userId, "sessions");
  const TWO_MINUTES_MS = 2 * 60 * 1000;
  const now = Date.now();

  try {
    const snap = await getDocs(sessionsCol);
    const sessions = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SessionData, "id">) }));
    const result: SessionData[] = [];

    for (const s of sessions) {
      if (s.status === "in-progress") {
        const lastActivity = s.lastChunkAt || s.startedAt;
        const diff = now - new Date(lastActivity).getTime();
        if (diff > TWO_MINUTES_MS) {
          console.log(`[Watchdog] Session ${s.id} in-progress but lastChunkAt > 2m (${Math.round(diff / 1000)}s ago). Marking as pending_review.`);
          await markSessionPendingReview(userId, s.id);
          s.status = "pending_review";
          result.push(s);
        }
      } else if (s.status === "pending_review") {
        result.push(s);
      }
    }

    return result.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  } catch (err) {
    console.warn("[Watchdog] Failed to check interrupted sessions in Firestore:", err);
    return [];
  }
}

/**
 * Get a specific session document by ID
 */
export async function getSessionById(userId: string, sessionId: string): Promise<SessionData | null> {
  const sessionRef = doc(db, "users", userId, "sessions", sessionId);
  try {
    const snap = await getDoc(sessionRef);
    if (!snap.exists()) return null;
    return { id: snap.id, ...(snap.data() as Omit<SessionData, "id">) };
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `users/${userId}/sessions/${sessionId}`);
  }
}

/**
 * Save review result & final STT transcript into the session document and mark status done
 */
export async function saveSessionReview(
  userId: string,
  sessionId: string,
  review: SessionReviewData,
  sttFinal?: SttFinalData
): Promise<void> {
  const sessionRef = doc(db, "users", userId, "sessions", sessionId);
  const now = new Date().toISOString();
  try {
    const updatePayload: Record<string, any> = {
      review,
      status: "done",
      endedAt: now,
      updatedAt: now,
    };
    if (sttFinal) {
      updatePayload.sttFinal = sttFinal;
    }
    await updateDoc(sessionRef, updatePayload);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${userId}/sessions/${sessionId}`);
  }
}

/**
 * Return today's date formatted as YYYY-MM-DD in KST (UTC+9)
 */
export function getKSTToday(): string {
  const nowKST = new Date(Date.now() + 9 * 3600000);
  const Y = nowKST.getUTCFullYear();
  const M = String(nowKST.getUTCMonth() + 1).padStart(2, "0");
  const D = String(nowKST.getUTCDate()).padStart(2, "0");
  return `${Y}-${M}-${D}`;
}

/**
 * Return tomorrow's date formatted as YYYY-MM-DD in KST (UTC+9)
 */
export function getKSTTomorrow(): string {
  return addKSTDays(1);
}

/**
 * Add N days to today (or baseDate YYYY-MM-DD) in KST
 */
export function addKSTDays(days: number, baseDateStr?: string): string {
  let base: Date;
  if (baseDateStr && /^\d{4}-\d{2}-\d{2}$/.test(baseDateStr)) {
    const [y, m, d] = baseDateStr.split("-").map(Number);
    base = new Date(Date.UTC(y, m - 1, d));
  } else {
    base = new Date(Date.now() + 9 * 3600000);
  }
  base.setUTCDate(base.getUTCDate() + days);
  const Y = base.getUTCFullYear();
  const M = String(base.getUTCMonth() + 1).padStart(2, "0");
  const D = String(base.getUTCDate()).padStart(2, "0");
  return `${Y}-${M}-${D}`;
}

/**
 * Save newly extracted mistakes to the mistakes collection
 * B-5: stage 1일, status reviewing, nextReviewAt=내일(YYYY-MM-DD)로 시작
 */
export async function saveCallMistakes(
  userId: string,
  mistakes: MistakeData[]
): Promise<string[]> {
  const mistakesCol = collection(db, "users", userId, "mistakes");
  const createdIds: string[] = [];
  const tomorrow = getKSTTomorrow();

  try {
    for (const m of mistakes) {
      const newDoc = doc(mistakesCol);
      const nextReviewAt = m.nextReviewAt || m.nextReviewDate || tomorrow;
      await setDoc(newDoc, {
        ...m,
        id: newDoc.id,
        stage: m.stage || 1,
        status: m.status || "reviewing",
        nextReviewAt,
        nextReviewDate: nextReviewAt,
        source: m.source || "call",
        createdAt: m.createdAt || new Date().toISOString(),
      });
      createdIds.push(newDoc.id);
    }
    return createdIds;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${userId}/mistakes`);
  }
}

/**
 * Get all existing mistakes for a user
 */
export async function getUserMistakes(userId: string): Promise<MistakeData[]> {
  const mistakesCol = collection(db, "users", userId, "mistakes");
  try {
    const snap = await getDocs(mistakesCol);
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<MistakeData, "id">) }));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, `users/${userId}/mistakes`);
  }
}

/**
 * B-5 Requirement 2: 아침 강의를 "들었다"는 신호로 단계 진행
 * reviewing이면 다음 stage로 올리고 nextReviewAt을 그에 맞게 갱신 (1→3→7→14일).
 * 14일에서 강의를 들었는데 퀴즈를 안 하면 status=deferred(보류).
 */
export async function advanceMistakeAfterLesson(
  userId: string,
  mistakeId: string
): Promise<{ prevStage: number; nextStage: number; nextStatus: MistakeStatus; nextReviewAt: string }> {
  const mistakeRef = doc(db, "users", userId, "mistakes", mistakeId);
  const snap = await getDoc(mistakeRef);
  if (!snap.exists()) {
    throw new Error(`Mistake ${mistakeId} not found`);
  }
  const data = snap.data() as MistakeData;
  const currentStage = (data.stage || 1) as MistakeStage;
  const currentStatus = data.status || "reviewing";

  // If already graduated, leave as is
  if (currentStatus === "graduated") {
    return {
      prevStage: currentStage,
      nextStage: currentStage,
      nextStatus: "graduated",
      nextReviewAt: data.nextReviewAt || data.nextReviewDate || "",
    };
  }

  let nextStage: MistakeStage = currentStage;
  let nextStatus: MistakeStatus = currentStatus;
  let nextReviewAt: string;

  if (currentStage === 1) {
    nextStage = 3;
    nextReviewAt = addKSTDays(3);
    nextStatus = "reviewing";
  } else if (currentStage === 3) {
    nextStage = 7;
    nextReviewAt = addKSTDays(7);
    nextStatus = "reviewing";
  } else if (currentStage === 7) {
    nextStage = 14;
    nextReviewAt = addKSTDays(14);
    nextStatus = "reviewing";
  } else {
    // currentStage === 14: 14일에서 강의를 들었는데 퀴즈를 안 하면 status=deferred
    nextStage = 14;
    nextStatus = "deferred";
    nextReviewAt = getKSTToday();
  }

  const now = new Date().toISOString();
  await updateDoc(mistakeRef, {
    stage: nextStage,
    status: nextStatus,
    nextReviewAt,
    nextReviewDate: nextReviewAt,
    lastLessonAdvanceAt: now,
    updatedAt: now,
  });

  return {
    prevStage: currentStage,
    nextStage,
    nextStatus,
    nextReviewAt,
  };
}

/**
 * B-5 Requirement 4: 퀴즈 통과 훅 (B-6용)
 * 호출 시 status=graduated
 */
export async function graduateMistakeAfterQuiz(
  userId: string,
  mistakeId: string
): Promise<void> {
  const mistakeRef = doc(db, "users", userId, "mistakes", mistakeId);
  const now = new Date().toISOString();
  try {
    await updateDoc(mistakeRef, {
      status: "graduated",
      graduatedAt: now,
      graduatedReason: "quiz_passed",
      updatedAt: now,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${userId}/mistakes/${mistakeId}`);
  }
}

/**
 * B-5 Requirement 3: 빠른 졸업 & 다시 복습 (복기 결과 반영)
 * - usedCorrectly[] 에 있는 id: status=graduated (퀴즈 없이 졸업)
 * - repeatedMistakes[] 에 있는 id: status=reviewing, stage=1일, nextReviewAt=내일 (다시 복습)
 */
export async function applyCallMistakeUpdates(
  userId: string,
  usedCorrectlyIds: string[] = [],
  repeatedMistakesIds: string[] = []
): Promise<{ graduatedCount: number; reopenedCount: number }> {
  let graduatedCount = 0;
  let reopenedCount = 0;
  const now = new Date().toISOString();
  const tomorrow = getKSTTomorrow();

  // 1. usedCorrectly -> status=graduated
  for (const id of usedCorrectlyIds) {
    if (!id || typeof id !== "string") continue;
    try {
      const mRef = doc(db, "users", userId, "mistakes", id);
      await updateDoc(mRef, {
        status: "graduated",
        graduatedAt: now,
        graduatedReason: "call_used_correctly",
        updatedAt: now,
      });
      graduatedCount++;
    } catch (err) {
      console.warn(`[db] Could not graduate mistake ${id}:`, err);
    }
  }

  // 2. repeatedMistakes -> status=reviewing, stage=1, nextReviewAt=내일
  for (const id of repeatedMistakesIds) {
    if (!id || typeof id !== "string") continue;
    try {
      const mRef = doc(db, "users", userId, "mistakes", id);
      const snap = await getDoc(mRef);
      const prevReopen = snap.exists() ? ((snap.data().reopenCount as number) || 0) : 0;
      await updateDoc(mRef, {
        status: "reviewing",
        stage: 1,
        nextReviewAt: tomorrow,
        nextReviewDate: tomorrow,
        reopenCount: prevReopen + 1,
        reopenedAt: now,
        updatedAt: now,
      });
      reopenedCount++;
    } catch (err) {
      console.warn(`[db] Could not reopen repeated mistake ${id}:`, err);
    }
  }

  return { graduatedCount, reopenedCount };
}

/**
 * B-5 Requirement 5: 오늘 복습 대상 조회
 * - status=reviewing 이고 nextReviewAt ≤ today 인 것 + status=deferred 인 것
 * - deferred는 목록 맨 앞
 */
export async function getDueMistakes(
  userId: string,
  todayStr: string = getKSTToday()
): Promise<MistakeData[]> {
  try {
    const all = await getUserMistakes(userId);
    const deferredList: MistakeData[] = [];
    const reviewingDueList: MistakeData[] = [];

    for (const m of all) {
      if (m.status === "deferred") {
        deferredList.push(m);
      } else if (m.status === "reviewing") {
        const targetDate = m.nextReviewAt || m.nextReviewDate || m.createdAt.slice(0, 10);
        if (targetDate <= todayStr) {
          reviewingDueList.push(m);
        }
      }
    }

    // deferred must be at the very front
    // sort reviewingDueList by nextReviewAt asc, then stage desc
    reviewingDueList.sort((a, b) => {
      const da = a.nextReviewAt || a.nextReviewDate || "";
      const db = b.nextReviewAt || b.nextReviewDate || "";
      if (da !== db) return da.localeCompare(db);
      return (b.stage || 1) - (a.stage || 1);
    });

    return [...deferredList, ...reviewingDueList];
  } catch (error) {
    console.warn("[db] Failed to get due mistakes:", error);
    return [];
  }
}

/**
 * Save quality report when user clicks "이건 내가 한 말이 아니에요"
 */
export async function createQualityReport(
  userId: string,
  report: QualityReportData
): Promise<string> {
  const col = collection(db, "users", userId, "qualityReports");
  const newDoc = doc(col);
  try {
    await setDoc(newDoc, {
      ...report,
      id: newDoc.id,
      reportedAt: report.reportedAt || new Date().toISOString(),
    });
    return newDoc.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${userId}/qualityReports`);
  }
}

/**
 * B-6 Quiz Attempt record model
 */
export interface QuizAttemptData {
  id?: string;
  mistakeId: string;
  mode: "speak" | "type";
  answer: string;
  passed: boolean;
  feedback: string;
  createdAt: string;
}

/**
 * Save or update mistake's meaningKo field for reuse across quiz sessions
 */
export async function updateMistakeMeaningKo(
  userId: string,
  mistakeId: string,
  meaningKo: string
): Promise<void> {
  const mRef = doc(db, "users", userId, "mistakes", mistakeId);
  try {
    await updateDoc(mRef, { meaningKo, updatedAt: new Date().toISOString() });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${userId}/mistakes/${mistakeId}`);
  }
}

/**
 * Save quiz attempt record to users/{uid}/quizAttempts
 */
export async function saveQuizAttempt(
  userId: string,
  attempt: QuizAttemptData
): Promise<string> {
  const col = collection(db, "users", userId, "quizAttempts");
  const newDoc = doc(col);
  try {
    await setDoc(newDoc, {
      ...attempt,
      id: newDoc.id,
      createdAt: attempt.createdAt || new Date().toISOString(),
    });
    return newDoc.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${userId}/quizAttempts`);
  }
}
