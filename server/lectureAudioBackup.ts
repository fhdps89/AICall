/**
 * Encrypted Firebase Storage backup for morning lecture audio.
 * Blob layout: "OCA1"(4) | iv(12) | ciphertext | authTag(16), AES-256-GCM with feedCipherKey(secret)
 * and AAD = `aicall-lecture-audio:${date}`. Never logs secrets, feed doc ids, or storage paths.
 */
import crypto from 'crypto';
import fs from 'fs';
import { feedDocId, feedCipherKey } from './feedStore.ts';
import { mimeForAudioFile } from './lectureAudioEncode.ts';
import { readStorageBucket, storageMediaUrl, storageUploadUrl, readStreamWithLimit } from './storageRelay.ts';
import type { LectureState } from './lecture.ts';

export const LECTURE_AUDIO_BACKUP_MAX_BYTES = 24 * 1024 * 1024;
export const AUDIO_BACKUP_UPLOAD_TIMEOUT_MS = 120_000;
export const AUDIO_BACKUP_DOWNLOAD_TIMEOUT_MS = 30_000;

const MAGIC = Buffer.from('OCA1', 'ascii');

export interface LectureAudioBackupHeader {
  v: 1;
  date: string;
  audioBackupId: string;
  ext: 'm4a' | 'mp3' | 'wav';
  mime: string;
  durationSec: number;
  bytes: number;
}

export function lectureAudioObjectPath(secret: string, date: string): string {
  return `feeds/${feedDocId(secret)}/days/${date}.audio.enc`;
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

export async function uploadLectureAudioBackup(
  secret: string,
  state: LectureState,
  audioPath: string,
  isCurrent: () => boolean,
  opts: { bucket?: string } = {}
): Promise<boolean> {
  if (!secret || !state.audioBackupId || !isCurrent()) return false;
  const bucket = opts.bucket ?? readStorageBucket();
  if (!bucket) return false;
  const url = storageUploadUrl(bucket, lectureAudioObjectPath(secret, state.date));
  if (!url) return false;

  let audio: Buffer;
  try {
    audio = fs.readFileSync(audioPath);
  } catch {
    return false;
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
  if (blob.length > LECTURE_AUDIO_BACKUP_MAX_BYTES) return false;
  if (!isCurrent()) return false;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), AUDIO_BACKUP_UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(blob),
      signal: ac.signal,
    });
    if (!res.ok) {
      console.warn('[lecture] audio backup upload failed', res.status);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn('[lecture] audio backup upload failed', err?.name || 'error');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadLectureAudioBackup(
  secret: string,
  date: string,
  expectId: string,
  opts: { bucket?: string } = {}
): Promise<{ ext: 'm4a' | 'mp3' | 'wav'; mime: string; buffer: Buffer; durationSec: number } | null> {
  if (!secret || !expectId) return null;
  const bucket = opts.bucket ?? readStorageBucket();
  if (!bucket) return null;
  const url = storageMediaUrl(bucket, lectureAudioObjectPath(secret, date));
  if (!url) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), AUDIO_BACKUP_DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    let blob: Buffer;
    if (res.body) {
      blob = await readStreamWithLimit(res.body, LECTURE_AUDIO_BACKUP_MAX_BYTES);
    } else if (typeof (res as any).arrayBuffer === 'function') {
      const ab = await res.arrayBuffer();
      if (ab.byteLength > LECTURE_AUDIO_BACKUP_MAX_BYTES) return null;
      blob = Buffer.from(ab);
    } else {
      return null;
    }
    const dec = decryptLectureAudio(secret, date, blob);
    if (!dec || dec.header.audioBackupId !== expectId) return null;
    return {
      ext: dec.header.ext,
      mime: dec.header.mime,
      buffer: dec.audio,
      durationSec: dec.header.durationSec,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
