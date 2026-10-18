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
import { firestoreDocUrl } from './userKey.ts';
import type { FeedSyncState } from './feed.ts';

export interface FeedBackup {
  state: FeedSyncState;
  /** Gemini key the user saved in Settings, only when that is the key the server uses. */
  apiKey?: string;
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest();

export function feedDocId(secret: string): string {
  return sha256(`aicall-feed-id:${secret}`).toString('hex');
}

function feedCipherKey(secret: string): Buffer {
  return sha256(`aicall-feed-key:${secret}`);
}

export function encryptFeed(secret: string, backup: FeedBackup): { iv: string; data: string } {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', feedCipherKey(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify(backup), 'utf8'), c.final(), c.getAuthTag()]);
  return { iv: iv.toString('base64'), data: body.toString('base64') };
}

export function decryptFeed(secret: string, iv: string, data: string): FeedBackup {
  const raw = Buffer.from(data, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', feedCipherKey(secret), Buffer.from(iv, 'base64'));
  d.setAuthTag(raw.subarray(raw.length - 16));
  const json = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8');
  return JSON.parse(json);
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
  const res = await fetch(url);
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
