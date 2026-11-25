/**
 * Firestore backup of the Grok Bot feed sync.
 *
 * Cloud Run wipes .data/ whenever it starts a fresh server (after a quiet night, or a
 * Publish), so the feed URL used to 404 until the user opened the app again. On every
 * /api/feed/sync the server now also writes feeds/{id} with the user's own ID token,
 * and a fresh server reads it back with no login when the feed URL is opened.
 *
 * The document is readable by anyone who knows its id (rules: get only, no list), so
 * everything in it except uid is AES-256-GCM encrypted with a key derived from the feed
 * secret; the id is a different hash of the secret. Without the secret the document
 * reveals nothing, and whoever holds the secret could already use the feed.
 * The user's Gemini key from Settings rides along inside the ciphertext (user's choice,
 * 2026-10-19), so a fresh server can make the morning lecture before anyone signs in.
 * Whoever holds the feed secret can therefore recover that key.
 */
import crypto from 'crypto';
import { firestoreCommitUrl, firestoreDocName, firestoreDocUrl } from './userKey.ts';
import type { FeedSyncState } from './feed.ts';
import { lectureAudioPath, type LectureState } from './lecture.ts';
import {
  AUDIO_BACKUP_COMMIT_TIMEOUT_MS,
  AUDIO_CHUNK_MAX,
  buildAudioChunkWrites,
  prepareLectureAudioChunks,
} from './lectureAudioBackup.ts';
import {
  sanitizeAudioBackupResult,
  sanitizeAudioError,
  type AudioBackupResult,
} from './lectureAudioError.ts';

export interface FeedBackup {
  state: FeedSyncState;
  /** Gemini key the user saved in Settings, only when that is the key the server uses. */
  apiKey?: string;
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest();

export function feedDocId(secret: string): string {
  return sha256(`aicall-feed-id:${secret}`).toString('hex');
}

export function feedCipherKey(secret: string): Buffer {
  return sha256(`aicall-feed-key:${secret}`);
}

function encryptJson<T>(secret: string, payload: T): { iv: string; data: string } {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', feedCipherKey(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final(), c.getAuthTag()]);
  return { iv: iv.toString('base64'), data: body.toString('base64') };
}

function decryptJson<T>(secret: string, iv: string, data: string): T {
  const raw = Buffer.from(data, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', feedCipherKey(secret), Buffer.from(iv, 'base64'));
  d.setAuthTag(raw.subarray(raw.length - 16));
  const json = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8');
  return JSON.parse(json) as T;
}

export function encryptFeed(secret: string, backup: FeedBackup): { iv: string; data: string } {
  return encryptJson(secret, backup);
}

export function decryptFeed(secret: string, iv: string, data: string): FeedBackup {
  return decryptJson<FeedBackup>(secret, iv, data);
}

export function encryptLectureBackup(secret: string, state: LectureState): { iv: string; data: string } {
  return encryptJson(secret, state);
}

export function decryptLectureBackup(secret: string, iv: string, data: string): LectureState {
  return decryptJson<LectureState>(secret, iv, data);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validIsoOrUndef(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 40) return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function sanitizeReadyLectureForBackup(
  state: LectureState,
  opts: { originOverride?: 'local' | 'backup' } = {}
): LectureState | null {
  if (!state || state.status !== 'ready') return null;
  if (typeof state.uid !== 'string' || !state.uid) return null;
  if (typeof state.date !== 'string' || !DATE_RE.test(state.date)) return null;
  if (!Array.isArray(state.script) || state.script.length === 0) return null;
  const audioChunks =
    typeof state.audioChunks === 'number' &&
    Number.isInteger(state.audioChunks) &&
    state.audioChunks >= 1 &&
    state.audioChunks <= AUDIO_CHUNK_MAX
      ? state.audioChunks
      : undefined;
  const audioRebuildFailedAt = validIsoOrUndef(state.audioRebuildFailedAt);
  const audioRetryAfter = validIsoOrUndef(state.audioRetryAfter);
  const rawAudioError = sanitizeAudioError(state.audioError);
  const audioError = rawAudioError
    ? opts.originOverride
      ? { ...rawAudioError, origin: opts.originOverride }
      : rawAudioError
    : undefined;
  const audioBackup = sanitizeAudioBackupResult(state.audioBackup);
  return {
    uid: state.uid,
    date: state.date,
    status: 'ready',
    ...(typeof state.title === 'string' ? { title: state.title } : {}),
    script: state.script,
    ...(typeof state.coachNote === 'string' ? { coachNote: state.coachNote } : {}),
    ...(typeof state.itemCount === 'number' ? { itemCount: state.itemCount } : {}),
    newMistakeIds: Array.isArray(state.newMistakeIds) ? state.newMistakeIds : [],
    reviewMistakeIds: Array.isArray(state.reviewMistakeIds) ? state.reviewMistakeIds : [],
    ...(Array.isArray(state.inputNewIds) ? { inputNewIds: state.inputNewIds } : {}),
    ...(Array.isArray(state.inputReviewIds) ? { inputReviewIds: state.inputReviewIds } : {}),
    ...(typeof state.inputLatestCreatedAt === 'string'
      ? { inputLatestCreatedAt: state.inputLatestCreatedAt }
      : {}),
    ttsEngine: state.ttsEngine === 'elevenlabs' ? 'elevenlabs' : 'gemini',
    ...(typeof state.chars === 'number' ? { chars: state.chars } : {}),
    ...(typeof state.textTokens === 'number' ? { textTokens: state.textTokens } : {}),
    ...(typeof state.durationSec === 'number' ? { durationSec: state.durationSec } : {}),
    ...(typeof state.audioBackupId === 'string' && state.audioBackupId
      ? { audioBackupId: state.audioBackupId }
      : {}),
    ...(audioChunks !== undefined ? { audioChunks } : {}),
    ...(audioRebuildFailedAt ? { audioRebuildFailedAt } : {}),
    ...(audioRetryAfter ? { audioRetryAfter } : {}),
    ...(audioError ? { audioError } : {}),
    ...(audioBackup ? { audioBackup } : {}),
    ...(state.durationFit && typeof state.durationFit === 'object'
      ? { durationFit: state.durationFit }
      : {}),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt || new Date().toISOString(),
  };
}

/**
 * Commit encrypted audio chunks + days backup atomically via Firestore `documents:commit`.
 * Falls back to pointer-free days PATCH on commit failure or when audio exceeds 8 chunks.
 */
export async function persistLectureBackups(
  secret: string,
  state: LectureState,
  isCurrent: () => boolean = () => true
): Promise<AudioBackupResult> {
  const nowIso = new Date().toISOString();
  const notCurrentResult = (): AudioBackupResult => ({
    target: 'firestore',
    result: 'not_current',
    httpStatus: null,
    chunks: null,
    bytes: null,
    at: nowIso,
  });
  if (!secret || !isCurrent()) return notCurrentResult();

  const saveWithoutPointers = async (result: AudioBackupResult): Promise<AudioBackupResult> => {
    if (!isCurrent()) return { ...result, result: 'not_current', httpStatus: null };
    const noPointers: LectureState = {
      ...state,
      audioBackupId: undefined,
      audioChunks: undefined,
      audioBackup: result,
    };
    try {
      await saveLectureBackup(secret, noPointers);
    } catch (err: any) {
      console.warn('[lecture] fallback days backup failed:', err?.name || 'error');
    }
    return result;
  };

  const audioPath = lectureAudioPath(state.uid, state.date);
  if (!audioPath || !state.audioBackupId) {
    return saveWithoutPointers({
      target: 'firestore',
      result: 'no_file',
      httpStatus: null,
      chunks: null,
      bytes: null,
      at: nowIso,
    });
  }

  const prep = prepareLectureAudioChunks(secret, state, audioPath);
  if (!prep.ok) {
    if (prep.tooLarge) {
      return saveWithoutPointers({
        target: 'firestore',
        result: 'too_large',
        httpStatus: null,
        chunks: prep.chunks,
        bytes: prep.bytes,
        at: nowIso,
      });
    }
    return saveWithoutPointers({
      target: 'firestore',
      result: 'no_file',
      httpStatus: null,
      chunks: null,
      bytes: null,
      at: nowIso,
    });
  }

  const commitUrl = firestoreCommitUrl();
  const daysDocName = firestoreDocName(`feeds/${feedDocId(secret)}/days/${state.date}`);
  const chunkWrites = buildAudioChunkWrites(
    secret,
    state.date,
    prep.chunks,
    state.updatedAt || nowIso
  );
  if (!commitUrl || !daysDocName || !chunkWrites) {
    return saveWithoutPointers({
      target: 'firestore',
      result: 'http_error',
      httpStatus: null,
      chunks: prep.chunks.length,
      bytes: prep.bytes,
      at: nowIso,
    });
  }

  const okResult: AudioBackupResult = {
    target: 'firestore',
    result: 'ok',
    httpStatus: 200,
    chunks: prep.chunks.length,
    bytes: prep.bytes,
    at: nowIso,
  };
  const nextState: LectureState = {
    ...state,
    audioChunks: prep.chunks.length,
    audioBackup: okResult,
  };
  const clean = sanitizeReadyLectureForBackup(nextState);
  if (!clean) {
    return {
      target: 'firestore',
      result: 'http_error',
      httpStatus: null,
      chunks: prep.chunks.length,
      bytes: prep.bytes,
      at: nowIso,
    };
  }
  const { iv, data } = encryptLectureBackup(secret, clean);
  if (!isCurrent()) return notCurrentResult();

  let failResult: AudioBackupResult;
  try {
    const res = await fetch(commitUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        writes: [
          ...chunkWrites,
          {
            update: {
              name: daysDocName,
              fields: {
                iv: { stringValue: iv },
                data: { stringValue: data },
                updatedAt: { stringValue: clean.updatedAt },
              },
            },
          },
        ],
      }),
      signal: AbortSignal.timeout(AUDIO_BACKUP_COMMIT_TIMEOUT_MS),
    });
    if (res.ok) {
      return isCurrent() ? okResult : { ...okResult, result: 'not_current', httpStatus: null };
    }
    console.warn('[lecture] audio backup commit failed', res.status);
    failResult = {
      target: 'firestore',
      result: res.status === 401 || res.status === 403 ? 'denied' : 'http_error',
      httpStatus: res.status,
      chunks: prep.chunks.length,
      bytes: prep.bytes,
      at: nowIso,
    };
  } catch (err: any) {
    console.warn('[lecture] audio backup commit failed', err?.name || 'error');
    const kind =
      err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network';
    failResult = {
      target: 'firestore',
      result: kind,
      httpStatus: null,
      chunks: prep.chunks.length,
      bytes: prep.bytes,
      at: nowIso,
    };
  }

  return saveWithoutPointers(failResult);
}

/**
 * Save failure diagnostics (audioRebuildFailedAt, audioRetryAfter, sanitized audioError)
 * without audio pointers so fresh instances honor cooldown instead of retrying TTS.
 */
export async function saveLectureFailureBackup(
  secret: string,
  state: LectureState,
  isCurrent: () => boolean = () => true
): Promise<void> {
  if (!secret || !isCurrent()) return;
  const noPointers: LectureState = {
    ...state,
    audioBackupId: undefined,
    audioChunks: undefined,
  };
  await saveLectureBackup(secret, noPointers);
}

/**
 * Write (or replace) a ready lecture script/state backup without user login.
 * Firestore rules gate writes on a valid parent feed doc and strictly typed {iv, data, updatedAt}.
 */
export async function saveLectureBackup(secret: string, state: LectureState): Promise<void> {
  if (!secret) return;
  const clean = sanitizeReadyLectureForBackup(state);
  if (!clean) return;
  const url = firestoreDocUrl(`feeds/${feedDocId(secret)}/days/${clean.date}`);
  if (!url) return;
  const { iv, data } = encryptLectureBackup(secret, clean);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          iv: { stringValue: iv },
          data: { stringValue: data },
          updatedAt: { stringValue: clean.updatedAt },
        },
      }),
    });
  } catch (err: any) {
    throw new Error(err?.name ? `Firestore fetch ${err.name}` : 'Firestore fetch failed');
  }
  if (!res.ok) throw new Error(`Firestore ${res.status}`);
}

/** Read and verify a ready lecture backup for the requested date without login. */
export async function loadLectureBackup(secret: string, date: string): Promise<LectureState | null> {
  if (!secret || !DATE_RE.test(date)) return null;
  const url = firestoreDocUrl(`feeds/${feedDocId(secret)}/days/${date}`);
  if (!url) return null;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err: any) {
    throw new Error(err?.name ? `Firestore fetch ${err.name}` : 'Firestore fetch failed');
  }
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`Firestore ${res.status}`);
  const json: any = await res.json();
  const iv = String(json?.fields?.iv?.stringValue || '');
  const data = String(json?.fields?.data?.stringValue || '');
  if (!iv || !data) return null;
  let backup: LectureState;
  try {
    backup = decryptLectureBackup(secret, iv, data);
  } catch {
    return null;
  }
  if (!backup || typeof backup !== 'object') return null;
  if (backup.date !== date) return null;
  return sanitizeReadyLectureForBackup(backup, { originOverride: 'backup' });
}

/** Write (or replace) the backup as the signed-in user. */
export async function saveFeedBackup(idToken: string, backup: FeedBackup): Promise<void> {
  const url = firestoreDocUrl(`feeds/${feedDocId(backup.state.secret)}`);
  if (!url) return;
  const { iv, data } = encryptFeed(backup.state.secret, backup);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        uid: { stringValue: backup.state.uid },
        iv: { stringValue: iv },
        data: { stringValue: data },
        updatedAt: { stringValue: backup.state.syncedAt },
      },
    }),
  });
  if (!res.ok) throw new Error(`Firestore ${res.status}`);
}

/** Remove the backup of a secret that was replaced in Settings, so the old URL stops working. */
export async function deleteFeedBackup(idToken: string, secret: string): Promise<void> {
  const url = firestoreDocUrl(`feeds/${feedDocId(secret)}`);
  if (!url) return;
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${idToken}` } });
  if (!res.ok && res.status !== 404) throw new Error(`Firestore ${res.status}`);
}

/** Read the backup with no login (the feed URL has only the secret). */
export async function loadFeedBackup(secret: string): Promise<FeedBackup | null> {
  const url = firestoreDocUrl(`feeds/${feedDocId(secret)}`);
  if (!url) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`Firestore ${res.status}`);
  const json: any = await res.json();
  const iv = String(json?.fields?.iv?.stringValue || '');
  const data = String(json?.fields?.data?.stringValue || '');
  if (!iv || !data) return null;
  const backup = decryptFeed(secret, iv, data);
  if (backup?.state?.secret !== secret) return null;
  return backup;
}
