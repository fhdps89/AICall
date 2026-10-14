import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "./config";
import { authFetch } from "../api/authFetch";

/**
 * Upload an audio chunk or full recording to Cloud Storage
 * Attempts direct Firebase Storage first; if network or security rules deny,
 * seamlessly falls back to the server audio storage endpoint.
 */
export async function uploadAudioFile(
  userId: string,
  path: string,
  blobOrBuffer: Blob | Uint8Array
): Promise<string> {
  try {
    const storageRef = ref(storage, `users/${userId}/${path}`);
    const snapshot = await uploadBytes(storageRef, blobOrBuffer);
    return await getDownloadURL(snapshot.ref);
  } catch (directErr) {
    console.warn("[Storage] Direct Firebase Storage upload failed, attempting server relay:", directErr);

    // Fallback: server upload route
    try {
      const blob = blobOrBuffer instanceof Blob ? blobOrBuffer : new Blob([blobOrBuffer as any]);
      // Server stores raw bytes under the signed-in user's folder (auth required).
      const response = await authFetch(`/api/recordings/upload-chunk?path=${encodeURIComponent(path)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: blob,
      });

      if (!response.ok) {
        throw new Error(`Server chunk upload returned ${response.status}`);
      }

      const json = await response.json();
      return json.url || `/api/recordings/file?path=${encodeURIComponent(path)}`;
    } catch (serverErr) {
      console.error("[Storage] Both direct and server fallback chunk upload failed:", serverErr);
      throw directErr;
    }
  }
}

/**
 * Get direct download URL for stored asset
 */
export async function getStorageFileUrl(userId: string, path: string): Promise<string> {
  try {
    const storageRef = ref(storage, `users/${userId}/${path}`);
    return await getDownloadURL(storageRef);
  } catch {
    return `/api/recordings/file?path=${encodeURIComponent(path)}`;
  }
}

