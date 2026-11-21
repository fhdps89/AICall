/**
 * IndexedDB storage for offline/resilient 10-second audio recording chunks.
 * Ensures no audio is lost during network dropouts or Live reconnects.
 * Once successfully uploaded to Cloud Storage, the chunk is removed from IndexedDB.
 */

import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "../firebase/config";
import { uploadAudioFile } from "../firebase/storage";
import {
  createPendingRetryRunner,
  type RetryPendingOptions,
  type RetryPendingResult,
} from "../firebase/uploadPolicy";

export type { RetryPendingOptions, RetryPendingResult };

export interface LocalRecordingChunk {
  id: string; // `${sessionId}_chunk_${index}`
  sessionId: string;
  userId: string;
  index: number;
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  timestamp: number;
  createdAt: string;
  uploaded: boolean;
  uploadError?: string;
}

const DB_NAME = "OneCallRecordingsDB";
const STORE_NAME = "pending_chunks";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      reject(new Error("IndexedDB is not supported in this environment"));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("timestamp", "timestamp", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB"));
  });
}

/**
 * Save a 10s audio chunk locally before uploading to Cloud Storage
 */
export async function saveChunkLocally(chunk: LocalRecordingChunk): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(chunk);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error("[IndexedDB] Failed to save local chunk:", err);
    // Gracefully continue so recording flow is not interrupted
  }
}

/**
 * Remove chunk from IndexedDB once uploaded to Cloud Storage
 */
export async function deleteChunkLocally(id: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error("[IndexedDB] Failed to delete uploaded chunk:", err);
  }
}

/**
 * Get all unuploaded chunks for a specific session
 */
export async function getPendingChunksForSession(sessionId: string): Promise<LocalRecordingChunk[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const index = store.index("sessionId");
      const req = index.getAll(IDBKeyRange.only(sessionId));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("[IndexedDB] Failed to get pending chunks:", err);
    return [];
  }
}

async function readAllPendingChunksFromDb(): Promise<LocalRecordingChunk[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get all unuploaded chunks across all sessions (for recovery)
 */
export async function getAllPendingChunks(): Promise<LocalRecordingChunk[]> {
  try {
    return await readAllPendingChunksFromDb();
  } catch (err) {
    console.warn("[IndexedDB] Failed to get all pending chunks:", err);
    return [];
  }
}

/**
 * 삭제 대상 로컬 조각을 필터 조건에 따라 선택한다(필터가 없으면 전체 반환).
 */
export function selectChunksToDelete<T>(
  chunks: T[],
  filter?: (chunk: T) => boolean
): T[] {
  if (!filter) {
    return chunks.slice();
  }
  return chunks.filter(filter);
}

/**
 * IndexedDB의 대기 조각 중 조건에 맞는 것(없으면 전부)을 삭제하고 삭제 개수를 반환한다.
 */
export async function deletePendingChunks(
  filter?: (c: LocalRecordingChunk) => boolean
): Promise<number> {
  const allChunks = await readAllPendingChunksFromDb();
  const targets = selectChunksToDelete(allChunks, filter);
  if (targets.length === 0) {
    return 0;
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    let deletedCount = 0;

    tx.oncomplete = () => resolve(deletedCount);
    tx.onerror = () => reject(tx.error || new Error("Failed to delete pending chunks"));
    tx.onabort = () => reject(tx.error || new Error("Aborted deleting pending chunks"));

    for (const chunk of targets) {
      const req = store.delete(chunk.id);
      req.onsuccess = () => {
        deletedCount++;
      };
    }
  });
}

const pendingRetryRunner = createPendingRetryRunner<LocalRecordingChunk, string>({
  getPending: getAllPendingChunks,
  onStart: (count) => {
    console.log(`[IndexedDB] Found ${count} pending unuploaded chunks. Retrying upload...`);
  },
  uploadChunk: async (chunk, userId) => {
    const storagePath = `recordings/${chunk.sessionId}/chunk_${String(chunk.index).padStart(4, "0")}_${chunk.timestamp}.webm`;
    const storageUrl = await uploadAudioFile(userId, storagePath, chunk.blob);

    // 업로드 성공 시 Firestore 세션 문서의 recordingChunks 메타데이터 동기화
    try {
      const sessionRef = doc(db, "users", userId, "sessions", chunk.sessionId);
      const sessionSnap = await getDoc(sessionRef);
      if (sessionSnap.exists()) {
        const sessionData = sessionSnap.data();
        const existingChunks: any[] = sessionData.recordingChunks || [];
        const updatedChunks = existingChunks.map((c) => {
          if (c.index === chunk.index) {
            return { ...c, uploaded: true, storageUrl };
          }
          return c;
        });
        // recordingChunks 배열에 아직 없으면 새로 추가
        const found = updatedChunks.some((c) => c.index === chunk.index);
        if (!found) {
          updatedChunks.push({
            index: chunk.index,
            path: storagePath,
            storageUrl,
            timestamp: new Date(chunk.timestamp).toISOString(),
            uploaded: true,
            durationSeconds: chunk.durationSeconds || 10,
            sizeBytes: chunk.blob.size,
          });
        }
        await updateDoc(sessionRef, {
          recordingChunks: updatedChunks,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch (dbErr) {
      console.warn(`[IndexedDB] Could not sync re-uploaded chunk #${chunk.index} to Firestore:`, dbErr);
    }

    // 업로드 성공 후 IndexedDB에서 로컬 조각 제거
    await deleteChunkLocally(chunk.id);
    console.log(`[IndexedDB] Re-uploaded and removed chunk #${chunk.index} (${chunk.sessionId})`);
  },
  onChunkError: (chunk, uploadErr) => {
    console.warn(`[IndexedDB] Retry upload failed for chunk #${chunk.index}:`, uploadErr);
  },
});

/**
 * 미업로드 조각을 다시 올리고 상세 결과({ total, uploaded, failed, skipped })를 반환한다.
 * - 동시에 두 번 실행되지 않도록 모듈 전역 진행 중 가드를 사용한다(이미 실행 중이면 skipped: true 반환).
 * - options.force 가 true 이면 30초 유예를 건너뛴다.
 */
export async function retryPendingUploadsDetailed(
  userId: string,
  options?: RetryPendingOptions
): Promise<RetryPendingResult> {
  return pendingRetryRunner(userId, options);
}

/**
 * B-4 Requirement 0: 앱 시작 및 주기적 재시도 시 미업로드 조각을 다시 올린다.
 * - 동시에 두 번 실행되지 않도록 모듈 전역 진행 중 가드를 사용한다.
 * - options.force 가 true 이면 30초 유예를 건너뛰고, 기본값에서는 방금 생성된 조각(30초 이내)을 건너뛴다.
 */
export async function retryPendingUploads(
  userId: string,
  options?: RetryPendingOptions
): Promise<number> {
  const result = await retryPendingUploadsDetailed(userId, options);
  return result.uploaded;
}

