/**
 * Server-side Firebase ID token guard (single allowed user).
 * Verifies the RS256 ID token issued by Firebase Auth using Google's public JWKs —
 * no firebase-admin dependency and no service-account secret needed.
 * Same rule as client auth.ts / firestore.rules: email == ALLOWED_EMAIL && email_verified.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Request, Response, NextFunction } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ALLOWED_EMAIL = 'episode.kim@gmail.com';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

function readProjectId(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'firebase-applet-config.json'), 'utf-8'));
    return String(cfg.projectId || '');
  } catch {
    return process.env.FIREBASE_PROJECT_ID || '';
  }
}
const PROJECT_ID = readProjectId();

let jwkCache: { keys: Record<string, crypto.KeyObject>; expiresAt: number } | null = null;

async function getKeys(): Promise<Record<string, crypto.KeyObject>> {
  if (jwkCache && jwkCache.expiresAt > Date.now()) return jwkCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const json: any = await res.json();
  const keys: Record<string, crypto.KeyObject> = {};
  for (const k of json.keys || []) {
    keys[k.kid] = crypto.createPublicKey({ key: k, format: 'jwk' });
  }
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  jwkCache = { keys, expiresAt: Date.now() + (maxAge ? parseInt(maxAge[1], 10) : 3600) * 1000 };
  return keys;
}

function b64urlJson(part: string): any {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf-8'));
}

export interface AuthedUser {
  uid: string;
  email: string;
}

export async function verifyFirebaseIdToken(token: string): Promise<AuthedUser> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = b64urlJson(parts[0]);
  const payload = b64urlJson(parts[1]);
  if (header.alg !== 'RS256') throw new Error('bad alg');
  const keys = await getKeys();
  const key = keys[header.kid];
  if (!key) throw new Error('unknown kid');
  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key,
    Buffer.from(parts[2], 'base64url')
  );
  if (!ok) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (!PROJECT_ID || payload.aud !== PROJECT_ID) throw new Error('bad aud');
  if (payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) throw new Error('bad iss');
  if (typeof payload.exp !== 'number' || payload.exp < now - 30) throw new Error('expired');
  if (typeof payload.iat !== 'number' || payload.iat > now + 300) throw new Error('bad iat');
  if (!payload.sub) throw new Error('no sub');
  const email = String(payload.email || '').toLowerCase();
  if (email !== ALLOWED_EMAIL || payload.email_verified !== true) throw new Error('user not allowed');
  return { uid: String(payload.sub), email };
}

type AfterAuthHook = (idToken: string, user: AuthedUser) => Promise<void> | void;
let afterAuthHook: AfterAuthHook | null = null;

/** Run extra work after a successful login check (e.g. loading the user's saved Gemini key). */
export function setAfterAuthHook(fn: AfterAuthHook): void {
  afterAuthHook = fn;
}

/** Express middleware: requires `Authorization: Bearer <Firebase ID token>`. Sets res.locals.user. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) {
    res.status(401).json({ ok: false, error: '로그인이 필요합니다.' });
    return;
  }
  try {
    res.locals.user = await verifyFirebaseIdToken(m[1].trim());
  } catch (err: any) {
    res.status(401).json({ ok: false, error: '인증 실패', detail: err?.message });
    return;
  }
  if (afterAuthHook) {
    try {
      await afterAuthHook(m[1].trim(), res.locals.user);
    } catch (err: any) {
      console.warn('[auth] after-auth hook failed:', err?.message || err);
    }
  }
  next();
}

/** Constant-time string compare (for feed secrets). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
