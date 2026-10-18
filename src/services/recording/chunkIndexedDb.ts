/**
 * IndexedDB storage for offline/resilient 10-second audio recording chunks.
 * Ensures no audio is lost during network dropouts or Live reconnects.
 * Once successfully uploaded to Cloud Storage, the chunk is removed from IndexedDB.
 */

import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "../firebase/config";
import { uploadAudioFile } from "../firebase/storage";

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

/**
 * Get all unuploaded chunks across all sessions (for recovery)
 */
export async function getAllPendingChunks(): Promise<LocalRecordingChunk[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("[IndexedDB] Failed to get all pending chunks:", err);
    return [];
  }
}

/**
 * B-4 Requirement 0: Automatically retry uploading pending/failed chunks on app launch.
 * On success, marks uploaded: true in Firestore sessions.recordingChunks and deletes from IndexedDB.
 */
export async function retryPendingUploads(userId: string): Promise<number> {
  const pending = await getAllPendingChunks();
  if (pending.length === 0) return 0;

  console.log(`[IndexedDB] Found ${pending.length} pending unuploaded chunks. Retrying upload...`);
  let successCount = 0;

  for (const chunk of pending) {
    try {
      const storagePath = `recordings/${chunk.sessionId}/chunk_${String(chunk.index).padStart(4, "0")}_${chunk.timestamp}.webm`;
      const storageUrl = await uploadAudioFile(userId, storagePath, chunk.blob);

      // Successfully uploaded -> update Firestore session recordingChunks
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
          // If chunk not present in recordingChunks array, append it
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

      // Delete from IndexedDB upon success
      await deleteChunkLocally(chunk.id);
      successCount++;
      console.log(`[IndexedDB] Re-uploaded and removed chunk #${chunk.index} (${chunk.sessionId})`);
    } catch (uploadErr) {
      console.warn(`[IndexedDB] Retry upload failed for chunk #${chunk.index}:`, uploadErr);
    }
  }

  return successCount;
}

