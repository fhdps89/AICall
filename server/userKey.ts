/**
 * Fallback Gemini key saved by the signed-in user in app Settings.
 *
 * AI Studio Publish currently does not pass Secrets to the deployed server (env has no
 * usable GEMINI_API_KEY). The user can save their key in Firestore at
 * users/{uid}/private/gemini { apiKey }; the server reads it through the Firestore REST API
 * with the user's own ID token (security rules still apply) and keeps it in memory only.
 * A key from the platform environment always wins over this one.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CACHE_MS = 10 * 60 * 1000;
const MISS_CACHE_MS = 60 * 1000;

function readConfig(): { projectId: string; databaseId: string } {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'firebase-applet-config.json'), 'utf-8'));
    return { projectId: String(cfg.projectId || ''), databaseId: String(cfg.firestoreDatabaseId || '(default)') };
  } catch {
    return { projectId: process.env.FIREBASE_PROJECT_ID || '', databaseId: '(default)' };
  }
}
const { projectId, databaseId } = readConfig();

let cached: { key: string | null; uid: string; at: number } | null = null;
let inflight: Promise<void> | null = null;

/** Key loaded from the user's Firestore doc, if any (memory only). */
export function getUserSuppliedKey(): string | undefined {
  return cached?.key || undefined;
}

/** Firestore REST URL for a document path like `users/{uid}/private/gemini` (null when the project is unknown). */
export function firestoreDocUrl(docPath: string): string | null {
  if (!projectId) return null;
  const segs = docPath.split('/').map(encodeURIComponent).join('/');
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents/${segs}`;
}

async function fetchKey(idToken: string, uid: string): Promise<string | null> {
  const url = firestoreDocUrl(`users/${uid}/private/gemini`);
  if (!url) return null;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore ${res.status}`);
  const json: any = await res.json();
  const v = String(json?.fields?.apiKey?.stringValue || '').trim();
  return v || null;
}

/**
 * Key restored from the feed backup (server/feedStore.ts) on a fresh server that has had no
 * signed-in request yet. The next signed-in request reloads the key from Firestore as usual.
 */
export function setUserKeyFromFeed(uid: string, key: string): void {
  if (cached?.key) return;
  cached = { key, uid, at: 0 };
}

/**
 * Load (or refresh) the user's saved key. Cheap to call on every authed request:
 * it hits Firestore at most once per 10 minutes (once per minute when no key is saved).
 */
export async function ensureUserGeminiKey(idToken: string, uid: string, force = false): Promise<void> {
  const age = cached && cached.uid === uid ? Date.now() - cached.at : Infinity;
  if (!force && age < (cached?.key ? CACHE_MS : MISS_CACHE_MS)) return;
  if (inflight && !force) return inflight;
  inflight = (async () => {
    try {
      const key = await fetchKey(idToken, uid);
      if (key !== (cached?.key ?? null)) console.log(`[Gemini key] user-saved key ${key ? `loaded len=${key.length}` : 'not found'}`);
      cached = { key, uid, at: Date.now() };
    } catch (err: any) {
      console.warn('[Gemini key] could not read user-saved key:', err?.message || err);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
