/**
 * B-8 Grok Bot feed (no scheduler server).
 * The app (logged in) syncs {feedSecret, quizCount, candidate mistakes} to the server.
 * GET /feed/{secret}/today[.json] needs only the secret; if there is no lecture today and
 * there are candidates, generation starts right there and "generating" is returned.
 */
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import {
  DATA_DIR,
  kstToday,
  readLectureState,
  startLectureJob,
  restoreReadyLecture,
  lectureAudioPath,
  lectureRebuildInFlight,
  LECTURE_AUDIO_MISSING,
} from './lecture.ts';
import type { LectureMistakeInput, LectureState, LectureSynthesizeFn } from './lecture.ts';
import { safeEqual } from './auth.ts';
import { loadFeedBackup, loadLectureBackup, saveLectureBackup } from './feedStore.ts';
import { setUserKeyFromFeed } from './userKey.ts';

const FEED_FILE = path.join(DATA_DIR, 'feed.json');
const FAILED_RETRY_COOLDOWN_MS = 30 * 60 * 1000;

export interface FeedSyncState {
  uid: string;
  secret: string;
  quizCount: number;
  newMistakes: LectureMistakeInput[];
  reviewMistakes: LectureMistakeInput[];
  syncedAt: string;
}

export function isValidFeedSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && /^[A-Za-z0-9_-]{24,128}$/.test(secret);
}

function readFeed(): FeedSyncState | null {
  try {
    return JSON.parse(fs.readFileSync(FEED_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeFeedSync(state: FeedSyncState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FEED_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Returns the synced state only when the secret matches (constant-time). */
export function feedForSecret(secret: string): FeedSyncState | null {
  const st = readFeed();
  if (!st || !isValidFeedSecret(secret) || !safeEqual(st.secret, secret)) return null;
  return st;
}

/** Returns the local synced state when it belongs to uid and holds a valid secret. */
export function feedForUid(uid: string): FeedSyncState | null {
  const st = readFeed();
  if (!st || st.uid !== uid || !isValidFeedSecret(st.secret)) return null;
  return st;
}

/**
 * Like feedForSecret, but a fresh server (empty .data/) restores the state, and the user's
 * Gemini key when it was backed up, from Firestore first.
 */
export async function loadFeedForSecret(secret: string): Promise<FeedSyncState | null> {
  const local = feedForSecret(secret);
  if (local || !isValidFeedSecret(secret)) return local;
  try {
    const backup = await loadFeedBackup(secret);
    if (!backup) return null;
    writeFeedSync(backup.state);
    if (backup.apiKey) setUserKeyFromFeed(backup.state.uid, backup.apiKey);
    console.log('[feed] restored feed state from Firestore backup');
    return backup.state;
  } catch (err: any) {
    console.warn('[feed] could not read Firestore backup:', err?.message || err);
    return null;
  }
}

export interface FeedToday {
  date: string;
  status: 'ready' | 'generating' | 'nothing';
  title: string | null;
  itemCount: number;
  coachNote: string | null;
  audioUrl: string | null;
  quizCount: number;
  error?: string;
}

export interface EnsureTodayLectureDeps {
  loadBackup?: (secret: string, date: string) => Promise<LectureState | null>;
  restoreLecture?: typeof restoreReadyLecture;
  synthesizeFn?: LectureSynthesizeFn;
}

const ensureInFlight = new Map<string, Promise<void>>();

/**
 * Ensure today's lecture is restored from Firestore backup if local state is missing or failed
 * and no generation job is actively running. Single-flight per uid:date.
 * Rejects on transient backup read failures (5xx/network) so callers do not start a duplicate job.
 */
export async function ensureTodayLecture(
  ai: GoogleGenAI | null,
  st: FeedSyncState,
  date: string,
  deps: EnsureTodayLectureDeps = {}
): Promise<void> {
  const key = `${st.uid}:${date}`;
  const inflight = ensureInFlight.get(key);
  if (inflight) return inflight;
  const work = ensureTodayLectureOnce(ai, st, date, deps).finally(() => {
    if (ensureInFlight.get(key) === work) ensureInFlight.delete(key);
  });
  ensureInFlight.set(key, work);
  return work;
}

async function ensureTodayLectureOnce(
  ai: GoogleGenAI | null,
  st: FeedSyncState,
  date: string,
  deps: EnsureTodayLectureDeps
): Promise<void> {
  const local = readLectureState(st.uid, date);
  if (local?.status === 'ready' && lectureAudioPath(st.uid, date)) return;
  // readLectureState only returns 'generating' when an active job is in memory.
  if (local?.status === 'generating') return;
  if (lectureRebuildInFlight(st.uid, date)) return;

  if (local?.status === 'ready' && Array.isArray(local.script) && local.script.length > 0) {
    if (!ai && !deps.synthesizeFn) return;
    const restore = deps.restoreLecture || restoreReadyLecture;
    restore(ai as GoogleGenAI, st.uid, date, local, { synthesizeFn: deps.synthesizeFn });
    return;
  }

  const load = deps.loadBackup || loadLectureBackup;
  const backup = await load(st.secret, date);
  if (
    !backup ||
    backup.uid !== st.uid ||
    backup.date !== date ||
    backup.status !== 'ready' ||
    !Array.isArray(backup.script) ||
    backup.script.length === 0
  ) {
    return;
  }
  if (!ai && !deps.synthesizeFn) return;
  const restore = deps.restoreLecture || restoreReadyLecture;
  restore(ai as GoogleGenAI, st.uid, date, backup, { synthesizeFn: deps.synthesizeFn });
}


/**
 * Absolute origin for public feed links (today.json audioUrl).
 * Behind Cloud Run / AI Studio the container sees HTTP, so req.protocol is http
 * unless trust proxy is on and X-Forwarded-Proto is present. Public hosts always
 * get https; localhost / loopback keep http unless the forwarded proto is https.
 */
export function publicFeedBaseUrl(input: {
  forwardedProto?: string | string[];
  forwarded?: string | string[];
  forwardedHost?: string | string[];
  host?: string | string[];
  protocol?: string;
}): string {
  const first = (v?: string | string[]) =>
    String(Array.isArray(v) ? v[0] : v || '').split(',')[0].trim();
  const fwdRaw = first(input.forwarded);
  const fwdProto = (fwdRaw.match(/(?:^|[;,\s])proto="?([A-Za-z]+)"?/i) || [])[1]?.toLowerCase() || '';
  const fwdHost = (fwdRaw.match(/(?:^|[;,\s])host="?([^;,"\s]+)"?/i) || [])[1] || '';
  const host = first(input.forwardedHost) || fwdHost || first(input.host);
  const xf = first(input.forwardedProto).toLowerCase();
  const declared = xf || fwdProto || String(input.protocol || '').toLowerCase();
  const isLocal = !host || /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
  let proto = declared === 'http' || declared === 'https' ? declared : isLocal ? 'http' : 'https';
  if (!isLocal) proto = 'https';
  return `${proto}://${host}`;
}

export interface BuildFeedTodayOpts {
  date?: string;
  skipStart?: boolean;
  startJob?: typeof startLectureJob;
}

export function buildFeedToday(
  ai: GoogleGenAI | null,
  st: FeedSyncState,
  baseUrl: string,
  opts: BuildFeedTodayOpts = {}
): FeedToday {
  const date = opts.date || kstToday();
  let lecture = readLectureState(st.uid, date);
  const hasCandidates = st.newMistakes.length + st.reviewMistakes.length > 0;
  // Retry a failed lecture at most once per FAILED_RETRY_COOLDOWN_MS, so a feed that is
  // polled repeatedly does not restart a costly, failing generation on every request.
  const failedLongAgo = lecture?.status === 'failed' && lecture.error !== 'NOTHING_TO_TEACH'
    && Date.now() - Date.parse(lecture.updatedAt || lecture.createdAt) > FAILED_RETRY_COOLDOWN_MS;
  // A job cut off by a server restart did not fail on its own, so it is retried right away.
  const interrupted = lecture?.status === 'failed' && (lecture.error === 'INTERRUPTED' || lecture.error === 'TIMED_OUT');
  const startJob = opts.startJob || startLectureJob;
  if (!opts.skipStart && (!lecture || failedLongAgo || interrupted) && hasCandidates && ai) {
    lecture = startJob(ai, st.uid, date, st.newMistakes, st.reviewMistakes, {
      onReady: async (s) => {
        try {
          await saveLectureBackup(st.secret, s);
        } catch (err: any) {
          console.warn('[feed] lecture backup failed:', err?.message || err);
        }
      },
    });
  }
  const base: FeedToday = {
    date,
    status: 'nothing',
    title: null,
    itemCount: 0,
    coachNote: null,
    audioUrl: null,
    quizCount: st.quizCount,
  };
  if (!lecture) return base;
  if (lecture.status === 'generating') return { ...base, status: 'generating', title: lecture.title || null };
  if (lecture.status === 'ready') {
    if (lectureAudioPath(st.uid, date)) {
      return {
        ...base,
        status: 'ready',
        title: lecture.title || null,
        itemCount: lecture.itemCount || 0,
        coachNote: lecture.coachNote || null,
        audioUrl: `${baseUrl}/feed/${st.secret}/audio/${lecture.audioFile || `${date}.wav`}`,
      };
    }
    if (lecture.audioStatus === 'rebuilding' || lectureRebuildInFlight(st.uid, date)) {
      return { ...base, status: 'generating', title: lecture.title || null };
    }
    return { ...base, error: lecture.error || LECTURE_AUDIO_MISSING };
  }
  return { ...base, ...(lecture.error && lecture.error !== 'NOTHING_TO_TEACH' ? { error: lecture.error } : {}) };
}

export function feedAudioFile(st: FeedSyncState, date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return lectureAudioPath(st.uid, date);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function renderFeedHtml(f: FeedToday): string {
  const statusKo = f.status === 'ready' ? '준비 완료' : f.status === 'generating' ? '생성 중' : '오늘은 강의 없음';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>원콜 오늘 아침 강의</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;line-height:1.6}</style></head><body>
<h1>원콜 오늘 아침 강의</h1>
<p>날짜: ${esc(f.date)}<br>상태: <b>${statusKo}</b> (${f.status})</p>
${f.title ? `<p>제목: ${esc(f.title)}</p>` : ''}
${f.status === 'ready' ? `<p>항목 수: ${f.itemCount}</p>` : ''}
${f.coachNote ? `<p>코치 한마디: ${esc(f.coachNote)}</p>` : ''}
${f.audioUrl ? `<p>강의 재생: <a href="${esc(f.audioUrl)}">${esc(f.audioUrl)}</a></p><audio controls preload="none" src="${esc(f.audioUrl)}"></audio>` : ''}
<p>오늘 퀴즈: ${f.quizCount}개</p>
</body></html>`;
}
