/**
 * Encrypted Firestore chunk backup for morning lecture audio.
 * Blob layout: "OCA1"(4) | iv(12) | ciphertext | authTag(16), AES-256-GCM with feedCipherKey(secret)
 * and AAD = `aicall-lecture-audio:${date}`. Never logs secrets, feed doc ids, or URLs.
 */
import crypto from 'crypto';
import fs from 'fs';
import { AUDIO_CHUNK_MAX } from './lectureAudioError.ts';
import { feedDocId, feedCipherKey } from './feedStore.ts';
import { mimeForAudioFile } from './lectureAudioEncode.ts';
import { firestoreDocName, firestoreDocUrl } from './userKey.ts';
import type { LectureState } from './lecture.ts';

export const AUDIO_CHUNK_RAW_BYTES = 600_000;
export { AUDIO_CHUNK_MAX };
export const AUDIO_BACKUP_COMMIT_TIMEOUT_MS = 60_000;
export const AUDIO_BACKUP_DOWNLOAD_TIMEOUT_MS = 30_000;

const MAGIC = Buffer.from('OCA1', 'ascii');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface LectureAudioBackupHeader {
  v: 1;
  date: string;
  audioBackupId: string;
  ext: 'm4a' | 'mp3' | 'wav';
  mime: string;
  durationSec: number;
  bytes: number;
}

export function encryptLectureAudio(
  secret: string,
  header: LectureAudioBackupHeader,
  audio: Buffer
): Buffer {
  const iv = crypto.randomBytes(12);
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(headerBuf.length, 0);
  const plaintext = Buffer.concat([lenBuf, headerBuf, audio]);

  const cipher = crypto.createCipheriv('aes-256-gcm', feedCipherKey(secret), iv);
  cipher.setAAD(Buffer.from(`aicall-lecture-audio:${header.date}`, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, ct, tag]);
}

export function decryptLectureAudio(
  secret: string,
  date: string,
  blob: Buffer
): { header: LectureAudioBackupHeader; audio: Buffer } | null {
  if (!Buffer.isBuffer(blob) || blob.length < 36) return null;
  if (!blob.subarray(0, 4).equals(MAGIC)) return null;
  const iv = blob.subarray(4, 16);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(16, blob.length - 16);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', feedCipherKey(secret), iv);
    decipher.setAAD(Buffer.from(`aicall-lecture-audio:${date}`, 'utf8'));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    if (pt.length < 4) return null;
    const headerLen = pt.readUInt32BE(0);
    if (headerLen <= 0 || 4 + headerLen > pt.length) return null;
    const header = JSON.parse(pt.subarray(4, 4 + headerLen).toString('utf8')) as LectureAudioBackupHeader;
    const audio = pt.subarray(4 + headerLen);
    if (
      !header ||
      header.v !== 1 ||
      header.date !== date ||
      typeof header.audioBackupId !== 'string' ||
      !header.audioBackupId ||
      header.bytes !== audio.length ||
      (header.ext !== 'm4a' && header.ext !== 'mp3' && header.ext !== 'wav')
    ) {
      return null;
    }
    return { header, audio };
  } catch {
    return null;
  }
}

function extForFile(filePath: string): 'm4a' | 'mp3' | 'wav' {
  if (filePath.endsWith('.m4a')) return 'm4a';
  if (filePath.endsWith('.mp3')) return 'mp3';
  return 'wav';
}

export function splitAudioBlob(blob: Buffer): string[] {
  if (!Buffer.isBuffer(blob) || blob.length === 0) return [];
  const chunks: string[] = [];
  for (let off = 0; off < blob.length; off += AUDIO_CHUNK_RAW_BYTES) {
    chunks.push(blob.subarray(off, off + AUDIO_CHUNK_RAW_BYTES).toString('base64'));
  }
  return chunks;
}

export function joinAudioChunks(chunks: string[]): Buffer {
  return Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64')));
}

export interface FirestoreChunkWrite {
  update: {
    name: string;
    fields: {
      data: { stringValue: string };
      updatedAt: { stringValue: string };
    };
  };
}

export function buildAudioChunkWrites(
  secret: string,
  date: string,
  chunks: string[],
  updatedAt: string
): FirestoreChunkWrite[] | null {
  if (!secret || !DATE_RE.test(date)) return null;
  if (chunks.length > AUDIO_CHUNK_MAX) return null;
  const docId = feedDocId(secret);
  const writes: FirestoreChunkWrite[] = [];
  for (let n = 0; n < chunks.length; n++) {
    const name = firestoreDocName(`feeds/${docId}/days/${date}/audio/${n}`);
    if (!name) return null;
    writes.push({
      update: {
        name,
        fields: {
          data: { stringValue: chunks[n] },
          updatedAt: { stringValue: updatedAt },
        },
      },
    });
  }
  return writes;
}

export type PreparedLectureAudioChunks =
  | { ok: true; chunks: string[]; bytes: number }
  | { ok: false; tooLarge: true; chunks: number; bytes: number }
  | { ok: false; tooLarge: false };

export function prepareLectureAudioChunks(
  secret: string,
  state: LectureState,
  audioPath: string
): PreparedLectureAudioChunks {
  if (!secret || !state.audioBackupId || !DATE_RE.test(state.date)) {
    return { ok: false, tooLarge: false };
  }
  let audio: Buffer;
  try {
    audio = fs.readFileSync(audioPath);
  } catch {
    return { ok: false, tooLarge: false };
  }
  const ext = extForFile(audioPath);
  const mime = state.audioMime || mimeForAudioFile(audioPath);
  const blob = encryptLectureAudio(
    secret,
    {
      v: 1,
      date: state.date,
      audioBackupId: state.audioBackupId,
      ext,
      mime,
      durationSec: state.durationSec || 0,
      bytes: audio.length,
    },
    audio
  );
  const chunks = splitAudioBlob(blob);
  if (chunks.length === 0) return { ok: false, tooLarge: false };
  if (chunks.length > AUDIO_CHUNK_MAX) {
    return { ok: false, tooLarge: true, chunks: chunks.length, bytes: blob.length };
  }
  return { ok: true, chunks, bytes: blob.length };
}

export interface LoadedLectureAudio {
  ext: 'm4a' | 'mp3' | 'wav';
  mime: string;
  buffer: Buffer;
  durationSec: number;
}

export type LoadLectureAudioResult =
  | ({ status: 'ok' } & LoadedLectureAudio)
  | { status: 'missing' }
  | { status: 'transient' };

export async function loadLectureAudioChunks(
  secret: string,
  date: string,
  expectId: string,
  count: number
): Promise<LoadLectureAudioResult> {
  if (!secret || !expectId || !DATE_RE.test(date)) return { status: 'missing' };
  if (!Number.isInteger(count) || count < 1 || count > AUDIO_CHUNK_MAX) return { status: 'missing' };

  const docId = feedDocId(secret);
  const urls: string[] = [];
  for (let n = 0; n < count; n++) {
    const url = firestoreDocUrl(`feeds/${docId}/days/${date}/audio/${n}`);
    if (!url) return { status: 'transient' };
    urls.push(url);
  }

  try {
    const signal = AbortSignal.timeout(AUDIO_BACKUP_DOWNLOAD_TIMEOUT_MS);
    const chunkResults = await Promise.all(
      urls.map(async (url) => {
        const res = await fetch(url, { signal });
        if (!res.ok) {
          await res.body?.cancel?.().catch(() => {});
          return res.status === 404
            ? ({ status: 'missing' } as const)
            : ({ status: 'transient' } as const);
        }
        const json: any = await res.json();
        const data = json?.fields?.data?.stringValue;
        if (typeof data !== 'string' || data.length === 0) {
          return { status: 'missing' } as const;
        }
        return { status: 'ok', data } as const;
      })
    );
    if (chunkResults.some((c) => c.status === 'missing')) return { status: 'missing' };
    if (chunkResults.some((c) => c.status === 'transient')) return { status: 'transient' };
    const b64Chunks = chunkResults.map((c) => (c as { status: 'ok'; data: string }).data);
    const blob = joinAudioChunks(b64Chunks);
    const dec = decryptLectureAudio(secret, date, blob);
    if (!dec || dec.header.audioBackupId !== expectId) return { status: 'missing' };
    return {
      status: 'ok',
      ext: dec.header.ext,
      mime: dec.header.mime,
      buffer: dec.audio,
      durationSec: dec.header.durationSec,
    };
  } catch {
    return { status: 'transient' };
  }
}
