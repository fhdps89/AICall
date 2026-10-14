import type { Request, Response, NextFunction } from 'express';

/** Single config place for per-user Gemini cost limits (in-memory, reset on restart). */
export const RATE_LIMITS = {
  PER_MINUTE: 60, // Gemini-cost /api requests per user per rolling minute
  DAILY_GEMINI_CALLS: 1500, // Gemini-cost /api requests per user per day (KST)
  DAILY_LIVE_SESSIONS: 60, // Live WebSocket session starts per user per day (KST)
} as const;

const minuteHits = new Map<string, number[]>();
const daily = new Map<string, { day: string; calls: number; live: number }>();

function kstDay(now = Date.now()): string {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
}
function dayBucket(uid: string) {
  const day = kstDay();
  let b = daily.get(uid);
  if (!b || b.day !== day) {
    b = { day, calls: 0, live: 0 };
    daily.set(uid, b);
  }
  return b;
}

export type LimitResult = { ok: true } | { ok: false; error: string; retryAfterSec: number };

export function checkGeminiCall(uid: string, now = Date.now()): LimitResult {
  const hits = (minuteHits.get(uid) || []).filter((t) => now - t < 60_000);
  if (hits.length >= RATE_LIMITS.PER_MINUTE) {
    minuteHits.set(uid, hits);
    return { ok: false, error: '요청이 너무 많아요. 1분 뒤에 다시 시도해 주세요.', retryAfterSec: Math.ceil((60_000 - (now - hits[0])) / 1000) };
  }
  const b = dayBucket(uid);
  if (b.calls >= RATE_LIMITS.DAILY_GEMINI_CALLS) {
    return { ok: false, error: '오늘 사용 한도를 다 썼어요. 내일 다시 이용해 주세요.', retryAfterSec: 3600 };
  }
  hits.push(now);
  minuteHits.set(uid, hits);
  b.calls += 1;
  return { ok: true };
}

export function checkLiveSessionStart(uid: string): LimitResult {
  const b = dayBucket(uid);
  if (b.live >= RATE_LIMITS.DAILY_LIVE_SESSIONS) {
    return { ok: false, error: '오늘 통화 횟수 한도를 다 썼어요. 내일 다시 걸어 주세요.', retryAfterSec: 3600 };
  }
  b.live += 1;
  return { ok: true };
}

/** Express middleware; must run after requireAuth (uses res.locals.user.uid). */
export function geminiLimit(req: Request, res: Response, next: NextFunction): void {
  const uid = res.locals.user?.uid;
  if (!uid) {
    res.status(401).json({ ok: false, error: '로그인이 필요합니다.' });
    return;
  }
  const r = checkGeminiCall(uid);
  if (!r.ok) {
    res.setHeader('Retry-After', String(r.retryAfterSec));
    res.status(429).json({ ok: false, error: r.error, code: 'rate_limited' });
    return;
  }
  next();
}
