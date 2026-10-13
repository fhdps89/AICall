import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  getDocs,
  writeBatch,
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
