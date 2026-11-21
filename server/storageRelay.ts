/**
 * Firebase Storage 릴레이(서버 중계) 순수 헬퍼 및 버킷 설정 읽기.
 * 클라이언트가 보낸 path·token만 검증해 고정 호스트·고정 버킷·사용자 폴더(users/{uid}/...) URL을 조립한다.
 * 전체 URL·토큰·인증 헤더는 절대 로그에 남기지 않는다.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ApiErrorCode } from './errors.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const STORAGE_HOST = 'firebasestorage.googleapis.com';
export const MAX_STORAGE_FILE_BYTES = 10 * 1024 * 1024;
export const STORAGE_FETCH_TIMEOUT_MS = 15_000;

/** firebase-applet-config.json 또는 환경변수에서 Storage 버킷 이름을 읽는다. */
export function readStorageBucket(
  configPath: string = path.resolve(__dirname, '..', 'firebase-applet-config.json')
): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const fromCfg = String(cfg?.storageBucket || '').trim();
    if (fromCfg) return fromCfg;
  } catch {
    // 설정 파일 읽기 실패 시 환경변수로 폴백
  }
  return String(process.env.FIREBASE_STORAGE_BUCKET || '').trim();
}

/** 사용자 폴더(users/{uid}/recordings/<sessionId>/chunk_NNNN_<ms>.webm) 안의 객체 경로만 허용한다. */
export function storageObjectPath(uid: string, relPath: string): string | null {
  if (typeof uid !== 'string' || typeof relPath !== 'string') return null;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return null;
  if (!/^recordings\/[A-Za-z0-9_-]{1,64}\/chunk_\d{4,6}_\d{10,16}\.webm$/.test(relPath)) return null;
  return `users/${uid}/${relPath}`;
}

/** Firebase Storage 다운로드 토큰(UUID 등) 형식을 검증한다. */
export function isValidDownloadToken(t: unknown): t is string {
  return typeof t === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(t);
}

/** 고정 호스트·버킷·인코딩된 객체 경로로 Firebase Storage 미디어 다운로드 URL을 만든다. */
export function storageMediaUrl(bucket: string, objectPath: string, token?: string): string | null {
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,220}$/.test(bucket)) return null;
  if (typeof objectPath !== 'string' || !objectPath) return null;
  if (token !== undefined && !isValidDownloadToken(token)) return null;
  const base = `https://${STORAGE_HOST}/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectPath)}?alt=media`;
  return token ? `${base}&token=${encodeURIComponent(token)}` : base;
}

/** Express Authorization Bearer 헤더를 Firebase Storage REST용 `Firebase <ID 토큰>` 헤더로 바꾼다. */
export function firebaseAuthHeader(authorization?: string): string | null {
  if (typeof authorization !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!m) return null;
  const tok = m[1].trim();
  return tok ? `Firebase ${tok}` : null;
}

/** Storage 업스트림 HTTP 상태 코드를 클라이언트에 돌려줄 고정 API 오류로 변환한다. */
export function relayErrorFor(upstreamStatus: number): { status: number; code: ApiErrorCode; message: string } {
  if (upstreamStatus === 404) {
    return { status: 404, code: 'NOT_FOUND', message: '녹음 조각을 저장소에서 찾지 못했어요.' };
  }
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return { status: 403, code: 'STORAGE_FORBIDDEN', message: '저장소에서 녹음 조각을 읽을 권한이 없어요.' };
  }
  return {
    status: 502,
    code: 'STORAGE_FAILED',
    message: '저장소에서 녹음 조각을 가져오지 못했어요. 잠시 후 다시 시도해 주세요.',
  };
}

/** 업스트림 Content-Type이 audio/*일 때만 그대로 전달하고 그 외에는 application/octet-stream을 반환한다. */
export function relayContentType(upstream: string | null): string {
  const trimmed = (upstream || '').trim();
  return /^audio\//i.test(trimmed) && !/[\r\n]/.test(trimmed) ? trimmed : 'application/octet-stream';
}

export class StorageFileTooLargeError extends Error {
  constructor() {
    super('Storage file exceeds limit');
    this.name = 'StorageFileTooLargeError';
  }
}

/**
 * 응답 본문 스트림을 읽으며 누적 바이트가 maxBytes를 넘기면 즉시 스트림을 취소하고 StorageFileTooLargeError를 던진다.
 */
export async function readStreamWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number = MAX_STORAGE_FILE_BYTES
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new StorageFileTooLargeError();
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}
