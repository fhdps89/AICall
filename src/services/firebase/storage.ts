import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "./config";

/**
 * Upload an audio chunk or full recording to Cloud Storage
 */
export async function uploadAudioFile(
  userId: string,
  path: string,
  blobOrBuffer: Blob | Uint8Array
): Promise<string> {
  const storageRef = ref(storage, `users/${userId}/${path}`);
  const snapshot = await uploadBytes(storageRef, blobOrBuffer);
  return getDownloadURL(snapshot.ref);
}

/**
 * Get direct download URL for stored asset
 */
export async function getStorageFileUrl(userId: string, path: string): Promise<string> {
  const storageRef = ref(storage, `users/${userId}/${path}`);
  return getDownloadURL(storageRef);
}
