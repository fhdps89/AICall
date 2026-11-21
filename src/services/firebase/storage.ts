import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "./config";
import { authFetch } from "../api/authFetch";
import { createChunkUploader } from "./uploadPolicy";

interface UploadPayload {
  userId: string;
  data: Blob | Uint8Array;
}

function getRelayFileUrl(path: string): string {
  return `/api/recordings/file?path=${encodeURIComponent(path)}`;
}

const chunkUploader = createChunkUploader<UploadPayload>({
  direct: async (path, { userId, data }) => {
    const storageRef = ref(storage, `users/${userId}/${path}`);
    const snapshot = await uploadBytes(storageRef, data);
    return await getDownloadURL(snapshot.ref);
  },
  relay: async (path, { data }) => {
    const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
    // 서버 중계 엔드포인트는 로그인한 사용자 토큰 기준으로 사용자 폴더에 원시 바이트를 저장한다.
    const response = await authFetch(`/api/recordings/upload-chunk?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: blob,
    });

    if (!response.ok) {
      throw new Error(`Server chunk upload returned HTTP ${response.status}`);
    }

    const json = await response.json();
    return json.url || getRelayFileUrl(path);
  },
});

/**
 * 오디오 조각 또는 전체 녹음을 저장소에 업로드한다.
 * 직접 업로드(Firebase Storage)를 제한 시간 내에 시도하고, 실패·지연 시 쿨다운 동안 서버 중계 경로를 우선 사용한다.
 */
export async function uploadAudioFile(
  userId: string,
  path: string,
  blobOrBuffer: Blob | Uint8Array
): Promise<string> {
  return chunkUploader.upload(path, { userId, data: blobOrBuffer });
}

/**
 * 저장된 파일의 다운로드 URL을 조회한다.
 * 직접 업로드 불가(쿨다운) 상태에서는 getDownloadURL을 호출하지 않고 즉시 서버 중계 URL을 반환한다.
 */
export async function getStorageFileUrl(userId: string, path: string): Promise<string> {
  const relayUrl = getRelayFileUrl(path);
  if (chunkUploader.isDirectBlocked()) {
    return relayUrl;
  }

  try {
    const storageRef = ref(storage, `users/${userId}/${path}`);
    return await getDownloadURL(storageRef);
  } catch {
    return relayUrl;
  }
}
