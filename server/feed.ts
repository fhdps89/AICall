/**
 * B-8 Grok Bot feed (no scheduler server).
 * The app (logged in) syncs {feedSecret, quizCount, candidate mistakes} to the server.
 * GET /feed/{secret}/today[.json] needs only the secret; if there is no lecture today and
 * there are candidates, generation starts right there and "generating" is returned.
 */
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import { DATA_DIR, kstToday, readLectureState, startLectureJob, lectureAudioPath } from './lecture.ts';
import type { LectureMistakeInput } from './lecture.ts';
import { safeEqual } from './auth.ts';
import { loadFeedBackup } from './feedStore.ts';

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

/** Like feedForSecret, but a fresh server (empty .data/) restores the state from the Firestore backup first. */
export async function loadFeedForSecret(secret: string): Promise<FeedSyncState | null> {
  const local = feedForSecret(secret);
  if (local || !isValidFeedSecret(secret)) return local;
  try {
    const backup = await loadFeedBackup(secret);
    if (!backup) return null;
    writeFeedSync(backup.state);
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

export function buildFeedToday(ai: GoogleGenAI | null, st: FeedSyncState, baseUrl: string): FeedToday {
  const date = kstToday();
  let lecture = readLectureState(st.uid, date);
  const hasCandidates = st.newMistakes.length + st.reviewMistakes.length > 0;
  // Retry a failed lecture at most once per FAILED_RETRY_COOLDOWN_MS, so a feed that is
  // polled repeatedly does not restart a costly, failing generation on every request.
  const failedLongAgo = lecture?.status === 'failed' && lecture.error !== 'NOTHING_TO_TEACH'
    && Date.now() - Date.parse(lecture.updatedAt || lecture.createdAt) > FAILED_RETRY_COOLDOWN_MS;
  if ((!lecture || failedLongAgo) && hasCandidates && ai) {
    lecture = startLectureJob(ai, st.uid, date, st.newMistakes, st.reviewMistakes);
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
  if (lecture.status === 'ready' && lectureAudioPath(st.uid, date)) {
    return {
      ...base,
      status: 'ready',
      title: lecture.title || null,
      itemCount: lecture.itemCount || 0,
      coachNote: lecture.coachNote || null,
      audioUrl: `${baseUrl}/feed/${st.secret}/audio/${date}.wav`,
    };
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
