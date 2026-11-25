/**
 * B-8 Grok Bot feed (no scheduler server).
 * The app (logged in) syncs {feedSecret, quizCount, candidate mistakes} to the server.
 * GET /feed/{secret}/today[.json] needs only the secret; after 05:00 KST if there is no
 * lecture today and there are candidates, generation starts right there.
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
  lectureJobEpoch,
  lectureRebuildInFlight,
  installRestoredLectureAudio,
  installBackupLectureWithoutAudio,
  recordLectureBackupResult,
  retryCooldownUntilMs,
  maxCreatedAtIso,
  lectureGenDiag,
  lectureInputIdSet,
  peekLectureGenGate,
  LECTURE_AUDIO_MISSING,
} from './lecture.ts';
import type { LectureMistakeInput, LectureState, LectureSynthesizeFn } from './lecture.ts';
import type { GenRemote, GenSkipReason } from './lectureGenGuard.ts';
import { safeEqual } from './auth.ts';
import {
  createFeedGenRemote,
  loadFeedBackup,
  loadLectureBackup,
  persistLectureBackups,
  saveLectureFailureBackup,
  type FeedBackup,
} from './feedStore.ts';
import { loadLectureAudioChunks, type LoadLectureAudioResult } from './lectureAudioBackup.ts';
import {
  sanitizeAudioBackupResult,
  sanitizeAudioError,
  type AudioBackupResult,
  type LectureAudioError,
} from './lectureAudioError.ts';
import { setUserKeyFromFeed } from './userKey.ts';

const FEED_FILE = path.join(DATA_DIR, 'feed.json');
const FAILED_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
export const FEED_START_HOUR_KST = 5;

export function isBeforeFeedStartKst(now = Date.now()): boolean {
  return new Date(now + 9 * 3600e3).getUTCHours() < FEED_START_HOUR_KST;
}

export interface FeedSyncState {
  uid: string;
  secret: string;
  quizCount: number;
  newMistakes: LectureMistakeInput[];
  reviewMistakes: LectureMistakeInput[];
  syncedAt: string;
  autoRegenerate?: boolean;
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

export const FEED_BACKUP_RECHECK_MS = 5 * 60 * 1000;
const feedBackupLastCheck = new Map<string, number>();

export function resetFeedBackupCheckCache(): void {
  feedBackupLastCheck.clear();
}

export interface LoadFeedDeps {
  loadBackup?: (secret: string) => Promise<FeedBackup | null>;
  setUserKey?: (uid: string, key: string) => void;
  now?: number;
}

/**
 * Like feedForSecret, but a fresh server (empty .data/) restores the state, and the user's
 * Gemini key when it was backed up, from Firestore first. When local state exists, re-checks
 * the Firestore backup at most once per FEED_BACKUP_RECHECK_MS so stale packaged .data/ or
 * a missing in-memory key is recovered without hitting Firestore on every request.
 */
export async function loadFeedForSecret(
  secret: string,
  deps: LoadFeedDeps = {}
): Promise<FeedSyncState | null> {
  const local = feedForSecret(secret);
  if (!isValidFeedSecret(secret)) return null;
  const loadBackup = deps.loadBackup || loadFeedBackup;
  const setUserKey = deps.setUserKey || setUserKeyFromFeed;
  if (!local) {
    try {
      const backup = await loadBackup(secret);
      if (!backup) return null;
      writeFeedSync(backup.state);
      if (backup.apiKey) setUserKey(backup.state.uid, backup.apiKey);
      console.log('[feed] restored feed state from Firestore backup');
      return backup.state;
    } catch (err: any) {
      console.warn('[feed] could not read Firestore backup:', err?.message || err);
      return null;
    }
  }
  const now = deps.now ?? Date.now();
  const lastCheck = feedBackupLastCheck.get(secret);
  if (lastCheck !== undefined && now >= lastCheck && now - lastCheck < FEED_BACKUP_RECHECK_MS) {
    return local;
  }
  feedBackupLastCheck.set(secret, now);
  try {
    const backup = await loadBackup(secret);
    if (!backup?.state) return local;
    if (backup.apiKey && backup.state.uid === local.uid) {
      setUserKey(backup.state.uid, backup.apiKey);
    }
    const backupMs = Date.parse(backup.state.syncedAt || '');
    const freshLocal = feedForSecret(secret);
    const currentLocal = freshLocal ?? local;
    const localMs = Date.parse(currentLocal.syncedAt || '');
    if (Number.isFinite(backupMs) && (!Number.isFinite(localMs) || backupMs > localMs)) {
      writeFeedSync(backup.state);
      console.log('[feed] updated feed state from newer Firestore backup');
      return backup.state;
    }
    return currentLocal;
  } catch (err: any) {
    console.warn('[feed] could not recheck Firestore backup:', err?.message || err);
    return local;
  }
}

export interface FeedToday {
  date: string;
  status: 'ready' | 'generating' | 'waiting' | 'nothing';
  title: string | null;
  itemCount: number;
  coachNote: string | null;
  audioUrl: string | null;
  audioRestoring: boolean;
  quizCount: number;
  startsAt?: string;
  error?: string;
}

export interface FeedDiag {
  date: string;
  status: 'ready' | 'generating' | 'waiting' | 'nothing' | 'failed';
  error: string | null;
  audioRestoring: boolean;
  hasAudio: boolean;
  generatedAt: string | null;
  durationSec: number | null;
  itemCount: number;
  newMistakeCount: number;
  reviewCount: number;
  inputNewCount: number;
  inputReviewCount: number;
  latestInputCreatedAt: string | null;
  syncedAt: string | null;
  syncNewCount: number;
  syncReviewCount: number;
  latestSyncCandidateAt: string | null;
  pendingNewCount: number;
  autoRegenerateEligible: boolean;
  audioError: LectureAudioError | null;
  audioRetryAfter: string | null;
  audioBackup: AudioBackupResult | null;
  dailyGenCount: number;
  dailyGenCap: number;
  genSkipReason: GenSkipReason | null;
  genSkipAt: string | null;
  genBlockedUntil: string | null;
  genLeaseMode: 'firestore' | 'local' | null;
}

export function feedOnReady(st: FeedSyncState) {
  return async (s: LectureState, isCurrent: () => boolean) => {
    try {
      const result = await persistLectureBackups(st.secret, s, isCurrent);
      if (isCurrent()) {
        recordLectureBackupResult(
          st.uid,
          s.date,
          { createdAt: s.createdAt, audioBackupId: s.audioBackupId },
          result
        );
      }
    } catch (err: any) {
      console.warn('[feed] lecture backup failed:', err?.name || 'error');
    }
  };
}

export function feedOnFailed(st: FeedSyncState) {
  return async (s: LectureState, isCurrent: () => boolean) => {
    try {
      await saveLectureFailureBackup(st.secret, s, isCurrent);
    } catch (err: any) {
      console.warn('[feed] lecture failure backup failed:', err?.name || 'error');
    }
  };
}

export function shouldAutoRegenerate(
  lecture: LectureState | null,
  st: FeedSyncState,
  now = Date.now()
): boolean {
  if (isBeforeFeedStartKst(now)) return false;
  if (st.autoRegenerate === false) return false;
  if (!lecture || (lecture.status !== 'ready' && lecture.status !== 'generating')) return false;
  const syncedMs = Date.parse(st.syncedAt || '');
  const createdMs = Date.parse(lecture.createdAt || '');
  if (!Number.isFinite(syncedMs) || !Number.isFinite(createdMs) || syncedMs <= createdMs) return false;
  const inputs = lectureInputIdSet(lecture);
  const novel = (st.newMistakes || []).filter((m) => !inputs.has(m.id));
  return novel.length > 0;
}

export function maybeAutoRegenerateToday(
  ai: GoogleGenAI | null,
  st: FeedSyncState,
  date: string,
  opts: { now?: number; startJob?: typeof startLectureJob; genRemote?: GenRemote | null } = {}
): boolean {
  if (!ai) return false;
  const now = opts.now ?? Date.now();
  const lecture = readLectureState(st.uid, date, now);
  if (!lecture || lecture.status === 'generating' || lectureRebuildInFlight(st.uid, date)) return false;
  if (!shouldAutoRegenerate(lecture, st, now)) return false;
  const startJob = opts.startJob || startLectureJob;
  const genRemote = opts.genRemote !== undefined ? opts.genRemote : createFeedGenRemote(st.secret);
  startJob(ai, st.uid, date, st.newMistakes, st.reviewMistakes, {
    force: true,
    onReady: feedOnReady(st),
    onFailed: feedOnFailed(st),
    genRemote,
  });
  return true;
}

export interface EnsureTodayLectureDeps {
  loadBackup?: (secret: string, date: string) => Promise<LectureState | null>;
  loadAudio?: typeof loadLectureAudioChunks;
  restoreLecture?: typeof restoreReadyLecture;
  synthesizeFn?: LectureSynthesizeFn;
  genRemote?: GenRemote | null;
  now?: number;
}

const ensureInFlight = new Map<string, Promise<void>>();

/**
 * Ensure today's lecture is restored from Storage/Firestore backup if local audio is missing
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
  const now = deps.now ?? Date.now();
  const local = readLectureState(st.uid, date, now);
  if (local?.status === 'ready' && lectureAudioPath(st.uid, date)) return;
  // readLectureState only returns 'generating' when an active job is in memory.
  if (local?.status === 'generating') return;
  if (lectureRebuildInFlight(st.uid, date) && local?.audioStatus === 'rebuilding') return;
  const epochBefore = lectureJobEpoch(st.uid, date);
  const localCreatedAtBefore = local?.createdAt;
  const genRemote = deps.genRemote !== undefined ? deps.genRemote : createFeedGenRemote(st.secret);

  const hasScript = (s: LectureState | null | undefined): s is LectureState =>
    Boolean(s?.status === 'ready' && Array.isArray(s.script) && s.script.length > 0);
  const hasPointers = (s: LectureState | null | undefined): boolean =>
    Boolean(s?.audioBackupId && typeof s.audioChunks === 'number' && s.audioChunks >= 1);
  const isOlderThan = (backupCreatedAt: string | undefined, localCreatedAt: string | undefined): boolean => {
    if (!hasScript(local) || !localCreatedAt || !backupCreatedAt) return false;
    const bMs = Date.parse(backupCreatedAt);
    const lMs = Date.parse(localCreatedAt);
    return Number.isFinite(bMs) && Number.isFinite(lMs) && bMs < lMs;
  };

  let cand: LectureState | null = null;
  if (hasScript(local) && hasPointers(local)) {
    cand = local;
  } else {
    const load = deps.loadBackup || loadLectureBackup;
    let backup: LectureState | null = null;
    try {
      backup = await load(st.secret, date);
    } catch (err) {
      if (!hasScript(local)) throw err;
    }
    const validBackup =
      backup && backup.uid === st.uid && backup.date === date && hasScript(backup) ? backup : null;
    if (validBackup && hasPointers(validBackup) && !isOlderThan(validBackup.createdAt, local?.createdAt)) {
      cand = validBackup;
    } else if (hasScript(local)) {
      cand = local;
    } else if (validBackup) {
      cand = validBackup;
    } else {
      return;
    }
  }

  const cooldownUntil = retryCooldownUntilMs(cand);
  const inCooldown = cooldownUntil !== null && now < cooldownUntil;
  const hasAudioPointers = Boolean(
    cand.audioBackupId && typeof cand.audioChunks === 'number' && cand.audioChunks >= 1
  );
  const installWithoutAudio = (c: LectureState) => {
    if (c !== local || local?.audioStatus !== 'missing') {
      installBackupLectureWithoutAudio(st.uid, date, c, {
        expectedEpoch: epochBefore,
        expectedCreatedAt: localCreatedAtBefore,
        origin: c === local ? (c.audioError?.origin ?? 'local') : 'backup',
      });
    }
  };
  // Cooldown only gates TTS. A backup fetched on a cold start may still point at valid audio
  // chunks (downloading them costs no TTS quota), so try them once before honoring cooldown.
  if (inCooldown && (cand === local || !hasAudioPointers)) {
    installWithoutAudio(cand);
    return;
  }

  let pointersConfirmedMissing = false;
  if (hasAudioPointers && cand.audioBackupId && typeof cand.audioChunks === 'number') {
    const wasLocal = cand === local;
    const loadAudio = deps.loadAudio ?? loadLectureAudioChunks;
    const audioRes = await loadAudio(st.secret, date, cand.audioBackupId, cand.audioChunks).catch(
      (): LoadLectureAudioResult => ({ status: 'transient' })
    );
    if (
      audioRes.status === 'ok' &&
      installRestoredLectureAudio(st.uid, date, cand, audioRes, {
        expectedEpoch: epochBefore,
        expectedCreatedAt: localCreatedAtBefore,
      })
    ) {
      return;
    }
    if (
      lectureJobEpoch(st.uid, date) !== epochBefore ||
      readLectureState(st.uid, date, now)?.createdAt !== localCreatedAtBefore
    ) {
      return;
    }
    if (audioRes.status === 'missing') {
      pointersConfirmedMissing = true;
      cand = { ...cand };
      delete cand.audioBackupId;
      delete cand.audioChunks;
      if (wasLocal && !ai && !deps.synthesizeFn) {
        installBackupLectureWithoutAudio(st.uid, date, cand, {
          expectedEpoch: epochBefore,
          expectedCreatedAt: localCreatedAtBefore,
          origin: cand.audioError?.origin ?? 'local',
        });
        return;
      }
    }
  }

  if (inCooldown) {
    installWithoutAudio(cand);
    return;
  }

  if (peekLectureGenGate(st.uid, date, now, { ignoreCooldown: false })) {
    installWithoutAudio(cand);
    return;
  }

  if (!ai && !deps.synthesizeFn) return;
  const restore = deps.restoreLecture || restoreReadyLecture;
  restore(ai as GoogleGenAI, st.uid, date, cand, {
    synthesizeFn: deps.synthesizeFn,
    onReady: feedOnReady(st),
    onFailed: feedOnFailed(st),
    now,
    genRemote,
    ...(pointersConfirmedMissing ? { clearAudioBackupPointers: true } : {}),
  });
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
  genRemote?: GenRemote | null;
  now?: number;
}

export function buildFeedToday(
  ai: GoogleGenAI | null,
  st: FeedSyncState,
  baseUrl: string,
  opts: BuildFeedTodayOpts = {}
): FeedToday {
  const date = opts.date || kstToday();
  const now = opts.now ?? Date.now();
  let lecture = readLectureState(st.uid, date, now);
  const hasCandidates = st.newMistakes.length + st.reviewMistakes.length > 0;
  // Retry a failed lecture at most once per FAILED_RETRY_COOLDOWN_MS, so a feed that is
  // polled repeatedly does not restart a costly, failing generation on every request.
  const retryAfterMs = lecture?.audioRetryAfter ? Date.parse(lecture.audioRetryAfter) : NaN;
  const failedLongAgo =
    lecture?.status === 'failed' &&
    lecture.error !== 'NOTHING_TO_TEACH' &&
    (Number.isFinite(retryAfterMs)
      ? now >= retryAfterMs
      : now - Date.parse(lecture.updatedAt || lecture.createdAt) > FAILED_RETRY_COOLDOWN_MS);
  // A job cut off by a server restart did not fail on its own, so it is retried right away.
  const interrupted = lecture?.status === 'failed' && (lecture.error === 'INTERRUPTED' || lecture.error === 'TIMED_OUT');
  const startJob = opts.startJob || startLectureJob;
  const genRemote = opts.genRemote !== undefined ? opts.genRemote : createFeedGenRemote(st.secret);
  const beforeStart = isBeforeFeedStartKst(now);

  if (!opts.skipStart && !beforeStart && (!lecture || failedLongAgo || interrupted) && hasCandidates && ai) {
    lecture = startJob(ai, st.uid, date, st.newMistakes, st.reviewMistakes, {
      onReady: feedOnReady(st),
      onFailed: feedOnFailed(st),
      genRemote,
      now,
    });
  } else if (!opts.skipStart && ai) {
    let regenState: LectureState | undefined;
    const regen = maybeAutoRegenerateToday(ai, st, date, {
      now,
      genRemote,
      startJob: (...args) => {
        regenState = startJob(...args);
        return regenState;
      },
    });
    if (regen && regenState) lecture = regenState;
  }

  const base: FeedToday = {
    date,
    status: 'nothing',
    title: null,
    itemCount: 0,
    coachNote: null,
    audioUrl: null,
    audioRestoring: false,
    quizCount: st.quizCount,
  };
  if (!lecture) {
    return beforeStart
      ? { ...base, status: 'waiting', startsAt: `${date}T05:00:00+09:00` }
      : base;
  }
  if (lecture.status === 'generating') return { ...base, status: 'generating', title: lecture.title || null };
  if (lecture.status === 'ready') {
    if (lectureAudioPath(st.uid, date)) {
      return {
        ...base,
        status: 'ready',
        title: lecture.title || null,
        itemCount: lecture.itemCount || 0,
        coachNote: lecture.coachNote || null,
        audioUrl: `${baseUrl}/feed/${st.secret}/audio/${lecture.audioFile || `${date}.mp3`}`,
        audioRestoring: false,
      };
    }
    const restoring =
      lecture.audioStatus === 'rebuilding' ||
      Boolean(lectureRebuildInFlight(st.uid, date) && lecture.audioStatus !== 'missing');
    if (restoring) {
      return {
        ...base,
        status: 'ready',
        title: lecture.title || null,
        itemCount: lecture.itemCount || 0,
        coachNote: lecture.coachNote || null,
        audioUrl: null,
        audioRestoring: true,
      };
    }
    return {
      ...base,
      status: 'ready',
      title: lecture.title || null,
      itemCount: lecture.itemCount || 0,
      coachNote: lecture.coachNote || null,
      audioUrl: null,
      audioRestoring: false,
      error: lecture.error || LECTURE_AUDIO_MISSING,
    };
  }
  if (beforeStart) {
    return { ...base, status: 'waiting', startsAt: `${date}T05:00:00+09:00` };
  }
  return { ...base, ...(lecture.error && lecture.error !== 'NOTHING_TO_TEACH' ? { error: lecture.error } : {}) };
}

/** Read-only diagnostic summary for GET /feed/:secret/today/diag.json (no secrets, ids, or text). */
export function buildFeedDiag(
  st: FeedSyncState,
  opts: { date?: string; now?: number } = {}
): FeedDiag {
  const date = opts.date || kstToday();
  const now = opts.now ?? Date.now();
  const lecture = readLectureState(st.uid, date, now);
  const hasAudio = Boolean(lecture?.status === 'ready' && lectureAudioPath(st.uid, date));
  const audioRestoring = Boolean(
    lecture?.status === 'ready' &&
      !hasAudio &&
      (lecture.audioStatus === 'rebuilding' ||
        (lectureRebuildInFlight(st.uid, date) && lecture.audioStatus !== 'missing'))
  );

  let status: FeedDiag['status'];
  if (!lecture) {
    status = isBeforeFeedStartKst(now) ? 'waiting' : 'nothing';
  } else {
    status = lecture.status;
  }

  let error: string | null = null;
  if (lecture?.status === 'failed') {
    error = lecture.error || 'GENERATION_FAILED';
  } else if (lecture?.status === 'ready' && !hasAudio && !audioRestoring) {
    error = lecture.error || LECTURE_AUDIO_MISSING;
  }

  const script = Array.isArray(lecture?.script) ? lecture!.script! : [];
  const newMistakeCount =
    script.length > 0
      ? script.filter((it) => it.kind === 'new').length
      : (lecture?.newMistakeIds?.length ?? 0);
  const reviewCount =
    script.length > 0
      ? script.filter((it) => it.kind === 'review').length
      : (lecture?.reviewMistakeIds?.length ?? 0);
  const itemCount = lecture ? (lecture.itemCount ?? (script.length || newMistakeCount + reviewCount)) : 0;

  const inputNewIds = lecture ? (lecture.inputNewIds ?? lecture.newMistakeIds ?? []) : [];
  const inputReviewIds = lecture ? (lecture.inputReviewIds ?? lecture.reviewMistakeIds ?? []) : [];
  const inputSet = lecture ? lectureInputIdSet(lecture) : new Set<string>();
  const pendingNewCount = (st.newMistakes || []).filter((m) => !inputSet.has(m.id)).length;

  const audioError = lecture?.audioError ? (sanitizeAudioError(lecture.audioError) ?? null) : null;
  const audioRetryAfter =
    typeof lecture?.audioRetryAfter === 'string' && Number.isFinite(Date.parse(lecture.audioRetryAfter))
      ? new Date(Date.parse(lecture.audioRetryAfter)).toISOString()
      : null;
  const audioBackup = lecture?.audioBackup ? (sanitizeAudioBackupResult(lecture.audioBackup) ?? null) : null;
  const gen = lectureGenDiag(st.uid, date, now);

  return {
    date,
    status,
    error,
    audioRestoring,
    hasAudio,
    generatedAt: lecture?.createdAt ?? null,
    durationSec: typeof lecture?.durationSec === 'number' ? lecture.durationSec : null,
    itemCount,
    newMistakeCount,
    reviewCount,
    inputNewCount: inputNewIds.length,
    inputReviewCount: inputReviewIds.length,
    latestInputCreatedAt: lecture?.inputLatestCreatedAt ?? null,
    syncedAt: st.syncedAt || null,
    syncNewCount: st.newMistakes?.length ?? 0,
    syncReviewCount: st.reviewMistakes?.length ?? 0,
    latestSyncCandidateAt: maxCreatedAtIso([...(st.newMistakes || []), ...(st.reviewMistakes || [])]) ?? null,
    pendingNewCount,
    autoRegenerateEligible: shouldAutoRegenerate(lecture, st, now),
    audioError,
    audioRetryAfter,
    audioBackup,
    dailyGenCount: gen.dailyGenCount,
    dailyGenCap: gen.dailyGenCap,
    genSkipReason: gen.genSkipReason,
    genSkipAt: gen.genSkipAt,
    genBlockedUntil: gen.genBlockedUntil,
    genLeaseMode: gen.genLeaseMode,
  };
}

export function feedAudioFile(st: FeedSyncState, date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return lectureAudioPath(st.uid, date);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function renderFeedHtml(f: FeedToday): string {
  const statusKo =
    f.status === 'ready'
      ? f.audioRestoring
        ? '오디오 복원 중'
        : '준비 완료'
      : f.status === 'generating'
      ? '생성 중'
      : f.status === 'waiting'
      ? '05:00 이후 준비'
      : '오늘은 강의 없음';
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
