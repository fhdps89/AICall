import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore, initializeFirestore, doc, getDocFromServer, Firestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import firebaseConfig from "../../../firebase-applet-config.json";

// Initialize Firebase App
export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

// Initialize Services
export const auth = getAuth(app);
// ignoreUndefinedProperties: drop fields whose value is undefined instead of rejecting the
// whole write (optional fields like planChangeId / storageUrl were silently failing to save).
function createDb(): Firestore {
  try {
    return initializeFirestore(app, { ignoreUndefinedProperties: true }, firebaseConfig.firestoreDatabaseId);
  } catch {
    // Already initialized (e.g. dev hot reload)
    return getFirestore(app, firebaseConfig.firestoreDatabaseId);
  }
}
export const db = createDb();
const STORAGE_RETRY_TIMEOUT_MS = 8000;
export const storage = getStorage(app, firebaseConfig.storageBucket);
// Firebase Storage SDK 기본 재시도 시간(업로드 10분, 기타 작업 2분)이 너무 길어,
// 버킷 미생성·CORS·네트워크 장애 시 서버 중계 폴백이 지연되지 않도록 8초로 제한한다.
storage.maxUploadRetryTime = STORAGE_RETRY_TIMEOUT_MS;
storage.maxOperationRetryTime = STORAGE_RETRY_TIMEOUT_MS;

/**
 * Validate Firestore Connection on App Boot (MANDATORY per skill guidelines)
 */
export async function validateFirestoreConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, "test", "connection"));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("the client is offline")) {
      console.warn("Firestore connection check: client is offline or network is restricted.");
      return false;
    }
    // Permission denied is expected for test/connection due to default deny, but means server is connected!
    return true;
  }
}
