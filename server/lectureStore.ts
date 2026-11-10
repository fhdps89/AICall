/**
 * Saves a finished morning lecture into the user's own account (Firestore + Cloud Storage).
 *
 * Why: the lecture job writes its JSON and WAV to .data/, which lives only on one Cloud Run
 * server. When the Grok Bot feed starts the job at 7 a.m. and that server is shut down
 * before the app opens, both the app and the feed link lose the lecture (2026-11-11).
 *
 * How: the app hands the server its Firebase refresh token at /api/feed/sync. The server keeps
 * it in memory and inside the encrypted feed backup (server/feedStore.ts, user's choice
 * 2026-11-11), trades it for a short-lived ID token, and writes as the user, so the usual
 * security rules (users/{uid}/**, owner only) still apply. The token is never logged or sent
 * anywhere but Google's token, Firestore and Storage endpoints.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { firestoreDocUrl } from './userKey.ts';
import type { LectureState } from './lecture.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readConfig(): { apiKey: string; bucket: string } {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'firebase-applet-config.json'), 'utf-8'));
    return { apiKey: String(cfg.apiKey || ''), bucket: String(cfg.storageBucket || '') };
  } catch {
    return { apiKey: '', bucket: '' };
  }
}
const { apiKey, bucket } = readConfig();

const MAX_TOKEN_LEN = 4096;
const refreshTokens = new Map<string, string>();
const idTokens = new Map<string, { token: string; until: number }>();
let appOrigin = '';

export function isPlausibleRefreshToken(t: unknown): t is string {
  return typeof t === 'string' && t.length >= 20 && t.length <= MAX_TOKEN_LEN && /^[A-Za-z0-9_\-.:]+$/.test(t);
}

/** Remember the app's sign-in for background saves (memory only; the feed backup keeps its own copy). */
export function setUserRefreshToken(uid: string, token: string, origin?: string): void {
  if (!uid || !isPlausibleRefreshToken(token)) return;
  if (refreshTokens.get(uid) !== token) idTokens.delete(uid);
  refreshTokens.set(uid, token);
  if (origin) appOrigin = origin;
}

export function getUserRefreshToken(uid: string): string | undefined {
  return refreshTokens.get(uid);
}

export function hasLectureSaver(uid: string): boolean {
  return Boolean(apiKey && refreshTokens.has(uid));
}

/** Trade the refresh token for an ID token of the same user (cached until 5 min before expiry). */
async function idTokenFor(uid: string): Promise<string | null> {
  const hit = idTokens.get(uid);
  if (hit && hit.until > Date.now()) return hit.token;
  const refresh = refreshTokens.get(uid);
  if (!refresh || !apiKey) return null;
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  // The Firebase web key may be limited to the app's own site.
  if (appOrigin) headers.Referer = `${appOrigin}/`;
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }).toString(),
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}`);
  const json: any = await res.json();
  if (String(json?.user_id || '') !== uid || !json?.id_token) throw new Error('token exchange returned another user');
  const ttl = Math.max(60, Number(json.expires_in) || 3600) - 300;
  idTokens.set(uid, { token: String(json.id_token), until: Date.now() + ttl * 1000 });
  if (json.refresh_token && json.refresh_token !== refresh && isPlausibleRefreshToken(json.refresh_token)) {
    refreshTokens.set(uid, json.refresh_token);
  }
  return String(json.id_token);
}

/** JS value → Firestore REST value. */
export function toFirestoreValue(v: unknown): any {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object') {
    const fields: Record<string, any> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x !== undefined) fields[k] = toFirestoreValue(x);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

/** PATCH only the given fields (other fields such as listenedAt stay). */
async function patchDoc(idToken: string, docPath: string, data: Record<string, unknown>): Promise<void> {
  const url = firestoreDocUrl(docPath);
  if (!url) throw new Error('no Firestore project');
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  const qs = keys.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const fields: Record<string, any> = {};
  for (const k of keys) fields[k] = toFirestoreValue(data[k]);
  const res = await fetch(`${url}?${qs}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Firestore ${res.status}`);
}

async function uploadWav(idToken: string, uid: string, date: string, file: string): Promise<string> {
  if (!bucket) throw new Error('no Storage bucket');
  const name = `users/${uid}/lectures/${date}.wav`;
  const base = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o`;
  const res = await fetch(`${base}?uploadType=media&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { Authorization: `Firebase ${idToken}`, 'Content-Type': 'audio/wav' },
    body: fs.readFileSync(file),
  });
  if (!res.ok) throw new Error(`Storage ${res.status}`);
  const json: any = await res.json();
  const token = String(json?.downloadTokens || '').split(',')[0];
  if (!token) throw new Error('Storage returned no download token');
  return `${base}/${encodeURIComponent(name)}?alt=media&token=${encodeURIComponent(token)}`;
}

/** Firestore doc body for users/{uid}/lectures/{date}, in the app's LectureDoc shape. */
export function lectureDocFields(state: LectureState, audioUrl: string): Record<string, unknown> {
  return {
    date: state.date,
    status: 'ready',
    title: state.title || '',
    script: state.script || [],
    audioUrl,
    coachNote: state.coachNote || '',
    itemCount: state.itemCount || 0,
    newMistakeIds: state.newMistakeIds,
    reviewMistakeIds: state.reviewMistakeIds,
    ttsEngine: state.ttsEngine,
    chars: state.chars || 0,
    textTokens: state.textTokens || 0,
    durationSec: state.durationSec || 0,
    createdAt: state.createdAt,
    updatedAt: new Date().toISOString(),
    savedBy: 'server',
    // The app adds the usage counters once and flips this (src/services/lecture/lectureService.ts).
    usageRecorded: false,
  };
}

/**
 * Copy a ready lecture into the user's account. Returns the Storage URL, or null when this
 * server has no sign-in for the user. Throws on a failed save (caller logs the code only).
 */
export async function saveLectureToAccount(state: LectureState, wavFile: string): Promise<string | null> {
  if (state.status !== 'ready' || !hasLectureSaver(state.uid)) return null;
  const idToken = await idTokenFor(state.uid);
  if (!idToken) return null;
  // The app may have copied it already (it was open while the job ran): keep its copy.
  const existing = await readLectureDoc(idToken, state.uid, state.date);
  if (existing) return existing.audioUrl;
  const audioUrl = await uploadWav(idToken, state.uid, state.date, wavFile);
  await patchDoc(idToken, `users/${state.uid}/lectures/${state.date}`, lectureDocFields(state, audioUrl));
  for (const id of state.newMistakeIds) {
    try {
      await patchDoc(idToken, `users/${state.uid}/mistakes/${id}`, { lectureDate: state.date });
    } catch {
      // the mistake may have been deleted
    }
  }
  return audioUrl;
}

export interface SavedLecture {
  status: string;
  title: string;
  coachNote: string;
  itemCount: number;
  audioUrl: string;
}

/** Read a lecture saved in the account (fresh server: .data/ is empty). Null when none or no sign-in. */
export async function loadLectureFromAccount(uid: string, date: string): Promise<SavedLecture | null> {
  if (!hasLectureSaver(uid)) return null;
  const idToken = await idTokenFor(uid);
  return idToken ? readLectureDoc(idToken, uid, date) : null;
}

async function readLectureDoc(idToken: string, uid: string, date: string): Promise<SavedLecture | null> {
  const url = firestoreDocUrl(`users/${uid}/lectures/${date}`);
  if (!url) return null;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore ${res.status}`);
  const f: any = (await res.json())?.fields || {};
  const s = (k: string) => String(f[k]?.stringValue || '');
  if (s('status') !== 'ready' || !s('audioUrl')) return null;
  return {
    status: 'ready',
    title: s('title'),
    coachNote: s('coachNote'),
    itemCount: Number(f.itemCount?.integerValue || f.itemCount?.doubleValue || 0),
    audioUrl: s('audioUrl'),
  };
}
