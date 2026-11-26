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
import fs from 'fs';
import { firestoreCommitUrl, firestoreDocName, firestoreDocUrl } from './userKey.ts';
import type { FeedSyncState } from './feed.ts';
import { lectureAudioPath, replaceLectureAudioWithMp3, type LectureState } from './lecture.ts';
import { transcodeWavToMp3 } from './lectureAudioEncode.ts';
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
import {
  applyGenRelease,
  decideGenAcquire,
  sanitizeGenControl,
  type GenAcquireReq,
  type GenControl,
  type GenReleaseReq,
  type GenRemote,
  type GenSkip,
} from './lectureGenGuard.ts';

export interface FeedBackup {
  state: FeedSyncState;
  /** Gemini key the user saved in Settings, only when that is the key the server uses. */
  apiKey?: string;
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest();
const genControlCache = new Map<string, GenControl>();

export function feedDocId(secret: string): string {
  return sha256(`aicall-feed-id:${secret}`).toString('hex');
}

function gcCacheKey(secret: string, date: string): string {
  return `${feedDocId(secret)}:${date}`;
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
    ...(typeof state.textInputTokens === 'number' ? { textInputTokens: state.textInputTokens } : {}),
    ...(typeof state.textOutputTokens === 'number' ? { textOutputTokens: state.textOutputTokens } : {}),
    ...(typeof state.ttsAudioSec === 'number' ? { ttsAudioSec: state.ttsAudioSec } : {}),
    ...(typeof state.ttsAudioChars === 'number' ? { ttsAudioChars: state.ttsAudioChars } : {}),
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

  let workState = state;

  const saveWithoutPointers = async (result: AudioBackupResult): Promise<AudioBackupResult> => {
    if (!isCurrent()) return { ...result, result: 'not_current', httpStatus: null };
    const noPointers: LectureState = {
      ...workState,
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

  let audioPath = lectureAudioPath(state.uid, state.date);
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

  if (audioPath.toLowerCase().endsWith('.wav')) {
    try {
      const wavBuf = fs.readFileSync(audioPath);
      const mp3 = await transcodeWavToMp3(wavBuf);
      if (!isCurrent()) return notCurrentResult();
      const replaced = replaceLectureAudioWithMp3(workState.uid, workState.date, mp3.buffer, {
        createdAt: workState.createdAt,
        audioBackupId: workState.audioBackupId,
      });
      if (!replaced) return notCurrentResult();
      audioPath = replaced.audioPath;
      workState = {
        ...workState,
        audioFile: replaced.audioFile,
        audioMime: replaced.audioMime,
        updatedAt: replaced.updatedAt,
      };
    } catch (err: any) {
      console.warn('[lecture] wav transcode before backup failed:', err?.name || 'error');
    }
  }

  const prep = prepareLectureAudioChunks(secret, workState, audioPath);
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
    workState.updatedAt || nowIso
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
    ...workState,
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
  await ensureGenControlCache(secret, clean.date);
  const cached = genControlCache.get(gcCacheKey(secret, clean.date));
  const { iv, data } = encryptJson(secret, cached ? { ...clean, genControl: cached } : clean);
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
 * while preserving any existing audioBackupId/audioChunks pointers on state.
 */
export async function saveLectureFailureBackup(
  secret: string,
  state: LectureState,
  isCurrent: () => boolean = () => true
): Promise<void> {
  if (!secret || !isCurrent()) return;
  if (state?.status === 'failed') {
    // A job that failed after the script was written (e.g. TIMED_OUT during TTS) keeps
    // its script only on this container's disk. Back it up as a ready lecture with no
    // audio, so a redeployed container rebuilds just the audio instead of finding
    // nothing and starting a new generation (11/27). Never replace an existing ready backup.
    const scriptOnly = failedJobScriptBackup(state);
    if (!scriptOnly) return;
    let existing: LectureState | null;
    try {
      existing = await loadLectureBackup(secret, scriptOnly.date);
    } catch {
      return;
    }
    if (existing || !isCurrent()) return;
    await saveLectureBackup(secret, scriptOnly);
    return;
  }
  await saveLectureBackup(secret, state);
}

/** Ready-without-audio copy of a failed job that already has a script; null when there is no script. */
export function failedJobScriptBackup(state: LectureState): LectureState | null {
  if (!state || state.status !== 'failed') return null;
  if (!Array.isArray(state.script) || state.script.length === 0) return null;
  const next: LectureState = { ...state, status: 'ready', audioStatus: 'missing' };
  delete next.audioFile;
  delete next.audioMime;
  delete next.audioBackupId;
  delete next.audioChunks;
  delete next.audioBackup;
  delete next.audioProgress;
  // The feed retries TIMED_OUT / INTERRUPTED right away on the same server; keep that on a new one.
  if (state.error === 'TIMED_OUT' || state.error === 'INTERRUPTED') delete next.audioRetryAfter;
  return next;
}

/**
 * Write (or replace) a ready lecture script/state backup without user login.
 * Firestore rules gate writes on a valid parent feed doc and strictly typed {iv, data, updatedAt}.
 */
async function ensureGenControlCache(secret: string, date: string): Promise<void> {
  if (genControlCache.has(gcCacheKey(secret, date))) return;
  await casDaysDoc(secret, date, (_raw, _gc) => ({ write: false, result: undefined }));
}

export async function saveLectureBackup(secret: string, state: LectureState): Promise<void> {
  if (!secret) return;
  const clean = sanitizeReadyLectureForBackup(state);
  if (!clean) return;
  const url = firestoreDocUrl(`feeds/${feedDocId(secret)}/days/${clean.date}`);
  if (!url) return;
  await ensureGenControlCache(secret, clean.date);
  const cached = genControlCache.get(gcCacheKey(secret, clean.date));
  const { iv, data } = encryptJson(secret, cached ? { ...clean, genControl: cached } : clean);
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
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    throw new Error(err?.name ? `Firestore fetch ${err.name}` : 'Firestore fetch failed');
  }
  if (!res.ok) throw new Error(`Firestore ${res.status}`);
}

const GEN_CAS_TIMEOUT_MS = 5000;
const GEN_CAS_MAX_ATTEMPTS = 3;

type CasMutateResult<T> =
  | { write: false; result: T }
  | { write: true; next: GenControl; result: T };

async function isCasConflict(res: Response): Promise<boolean> {
  if (res.status === 409 || res.status === 412) return true;
  if (res.status !== 400) return false;
  try {
    const text = typeof (res as any).text === 'function' ? await (res as any).text() : '';
    if (!text) return true;
    return /FAILED_PRECONDITION|ALREADY_EXISTS|ABORTED/i.test(text);
  } catch {
    return true;
  }
}

async function casDaysDoc<T>(
  secret: string,
  date: string,
  mutate: (raw: Record<string, unknown>, gc: GenControl) => CasMutateResult<T>
): Promise<{ ok: true; gc: GenControl; result: T } | { ok: 'unavailable' } | { ok: false; conflict: true }> {
  if (!secret || !DATE_RE.test(date)) return { ok: 'unavailable' };
  const baseUrl = firestoreDocUrl(`feeds/${feedDocId(secret)}/days/${date}`);
  if (!baseUrl) return { ok: 'unavailable' };

  for (let attempt = 0; attempt < GEN_CAS_MAX_ATTEMPTS; attempt++) {
    let getRes: Response;
    try {
      getRes = await fetch(baseUrl, { signal: AbortSignal.timeout(GEN_CAS_TIMEOUT_MS) });
    } catch {
      return { ok: 'unavailable' };
    }

    let exists = false;
    let updateTime: string | undefined;
    let raw: Record<string, unknown> = { date };

    if (getRes.status === 404) {
      exists = false;
    } else if (!getRes.ok) {
      return { ok: 'unavailable' };
    } else {
      exists = true;
      let json: any;
      try {
        json = await getRes.json();
      } catch {
        return { ok: 'unavailable' };
      }
      updateTime = typeof json?.updateTime === 'string' && json.updateTime ? json.updateTime : undefined;
      const iv = String(json?.fields?.iv?.stringValue || '');
      const data = String(json?.fields?.data?.stringValue || '');
      if (!iv || !data) return { ok: 'unavailable' };
      let dec: unknown;
      try {
        dec = decryptJson<Record<string, unknown>>(secret, iv, data);
      } catch {
        return { ok: 'unavailable' };
      }
      if (!dec || typeof dec !== 'object') return { ok: 'unavailable' };
      const decObj = dec as Record<string, unknown>;
      raw = decObj.date === date ? decObj : { date };
    }

    const gc = sanitizeGenControl(raw.genControl);
    const mut = mutate(raw, gc);
    if (!mut.write) {
      genControlCache.set(gcCacheKey(secret, date), gc);
      return { ok: true, gc, result: mut.result };
    }

    const nextPayload = { ...raw, genControl: mut.next };
    const { iv, data } = encryptJson(secret, nextPayload);
    const nowIso = new Date().toISOString();
    const precond = updateTime
      ? `currentDocument.updateTime=${encodeURIComponent(updateTime)}`
      : exists
      ? 'currentDocument.exists=true'
      : 'currentDocument.exists=false';

    let patchRes: Response;
    try {
      patchRes = await fetch(`${baseUrl}?${precond}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            iv: { stringValue: iv },
            data: { stringValue: data },
            updatedAt: { stringValue: nowIso },
          },
        }),
        signal: AbortSignal.timeout(GEN_CAS_TIMEOUT_MS),
      });
    } catch {
      return { ok: 'unavailable' };
    }

    if (patchRes.ok) {
      genControlCache.set(gcCacheKey(secret, date), mut.next);
      return { ok: true, gc: mut.next, result: mut.result };
    }
    if (await isCasConflict(patchRes)) {
      continue;
    }
    return { ok: 'unavailable' };
  }

  return { ok: false, conflict: true };
}

export async function acquireLectureGenLease(
  secret: string,
  date: string,
  req: GenAcquireReq
): Promise<
  | { ok: true; gc: GenControl }
  | { ok: false; skip: GenSkip; gc: GenControl }
  | { ok: 'unavailable' }
> {
  const cas = await casDaysDoc<
    { ok: true; gc: GenControl } | { ok: false; skip: GenSkip; gc: GenControl }
  >(secret, date, (_raw, gc) => {
    const d = decideGenAcquire(gc, req);
    if (!d.ok) {
      return { write: false, result: { ok: false, skip: d.skip, gc } };
    }
    return { write: true, next: d.next, result: { ok: true, gc: d.next } };
  });
  if (cas.ok === 'unavailable') return { ok: 'unavailable' };
  if (!cas.ok) {
    return {
      ok: false,
      skip: {
        reason: 'lease',
        at: new Date(req.now).toISOString(),
        until: new Date(req.now + 30_000).toISOString(),
      },
      gc: genControlCache.get(gcCacheKey(secret, date)) ?? { genCount: 0 },
    };
  }
  return cas.result;
}

export async function releaseLectureGenLease(
  secret: string,
  date: string,
  rel: GenReleaseReq
): Promise<void> {
  const cas = await casDaysDoc<void>(secret, date, (_raw, gc) => ({
    write: true,
    next: applyGenRelease(gc, rel),
    result: undefined,
  }));
  if (cas.ok !== true) {
    console.warn('[feedStore] releaseLectureGenLease skipped:', cas.ok === 'unavailable' ? 'unavailable' : 'conflict');
  }
}

export function createFeedGenRemote(secret: string): GenRemote | null {
  if (!secret || process.env.LECTURE_GEN_LEASE === 'off') return null;
  if (!firestoreDocUrl(`feeds/${feedDocId(secret)}/days/2000-01-01`)) return null;
  return {
    acquire: (date, req) => acquireLectureGenLease(secret, date, req),
    release: (date, rel) => releaseLectureGenLease(secret, date, rel),
  };
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
