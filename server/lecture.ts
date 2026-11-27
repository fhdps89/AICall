/**
 * B-7 Morning Lecture generator (server side).
 * - Script: gemini-3.8-flash with responseSchema
 * - Voice: gemini-3.8-flash-tts, 2 speakers (Coach / Partner), raw PCM per segment
 * - Concatenate PCM, insert 3s silence before each answer, save one WAV file
 * - Jobs run in the background; state is persisted under .data/lectures/{uid}/{date}.json
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ServiceTier, Type } from '@google/genai';
import { TEXT_MODEL, GEMINI_TTS_MODEL } from '../src/config/models.ts';
import { tokensFromUsageMetadata } from './usageMeta.ts';
import { stripSpeechDirections, cleanLectureScriptItem } from './speechText.ts';
import { encodeLectureAudio, mimeForAudioFile, type LectureEncodeFn } from './lectureAudioEncode.ts';
import {
  AUDIO_CHUNK_MAX,
  classifyLectureAudioError,
  cooldownMsFor,
  retryableFor,
  safeErrName,
  sanitizeAudioBackupResult,
  type AudioBackupResult,
  type AudioErrorStage,
  type LectureAudioError,
} from './lectureAudioError.ts';
import {
  MAX_NEW,
  MAX_REVIEW,
  MAX_DIALOGUE_LINES,
  MAX_EXTRA_EXAMPLES,
  normalizeCoachNote,
  sanitizeLectureInputs,
  applyModelScriptToInputs,
  buildLectureSpeechPlan,
  trimItemsToBudget,
  type LectureMistakeInput,
  type LectureScriptItem,
} from './lectureMaterial.ts';
import {
  RATE as DURATION_RATE,
  LECTURE_MIN_SEC,
  LECTURE_EST_MAX_SEC,
  DRILL_INTRO_TEXT,
  buildRecapText,
  fitLectureTimeline,
  assembleLecturePcm,
  type Extras,
  type LectureDurationFit,
  type MeasuredLecture,
  type MeasuredLectureItem,
} from './lectureDuration.ts';
import {
  GEN_LEASE_MARGIN_MS,
  acquireGenSlot,
  acquireGenSlotSync,
  peekGenGate,
  readGenDiag,
  type GenDiag,
  type GenRemote,
  type GenSkip,
  type GenSlot,
} from './lectureGenGuard.ts';

export type { LectureMistakeInput, LectureScriptItem } from './lectureMaterial.ts';
export {
  sanitizeLectureInputs,
  applyModelScriptToInputs,
  introLine,
  openingLine,
  buildLectureSpeechPlan,
  trimItemsToBudget,
  formatLectureDuration,
  estimatePlanDurationSec,
  LECTURE_MAX_SEC,
} from './lectureMaterial.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, '..', '.data');
const LECTURE_DIR = path.join(DATA_DIR, 'lectures');

const SCRIPT_MODEL = TEXT_MODEL;
const LECTURE_TTS_MODEL = GEMINI_TTS_MODEL;
const VOICE_COACH = 'Kore';
const VOICE_PARTNER = 'Puck';
/** Whole job (script + TTS). A hung Gemini call must not leave status=generating all day. */
export const LECTURE_JOB_TIMEOUT_MS = 15 * 60 * 1000;
/** One generateContent call (script or one TTS segment). Lets the 3-try loop actually retry. */
export const LECTURE_STEP_TIMEOUT_MS = 90 * 1000;
/**
 * Lecture TTS on the Flex tier (H1-보수, 50% price, preview, best-effort; https://ai.google.dev/gemini-api/docs/flex-inference).
 * Flex has no server-side fallback and can queue for minutes, while the whole lecture job has a 15-minute cap.
 * So each segment tries Flex once with a short cap, then falls back to the unchanged standard 3-try loop.
 * A failure or a slow Flex answer turns Flex off for 30 minutes (rest of the job), so a job loses at most ~20s.
 * LECTURE_TTS_FLEX=off disables it.
 */
export const LECTURE_TTS_FLEX_TIMEOUT_MS = 20_000;
export const LECTURE_TTS_FLEX_SLOW_MS = 15_000;
export const LECTURE_TTS_FLEX_COOLDOWN_MS = 30 * 60 * 1000;
export const LECTURE_AUDIO_REBUILD_TIMEOUT_MS = 30 * 60 * 1000;
export const LECTURE_AUDIO_RETRY_COOLDOWN_MS = 30 * 60 * 1000;

let lectureTtsFlexDisabledUntil = 0;

export function resetLectureTtsFlexStateForTest(): void {
  lectureTtsFlexDisabledUntil = 0;
}
export const LECTURE_AUDIO_REBUILD_TIMED_OUT = 'AUDIO_REBUILD_TIMED_OUT';
export const LECTURE_GEN_SKIPPED = 'GEN_SKIPPED';
const JOB_TIMED_OUT_RE = /^(lecture job|audio rebuild) timed out/;

function userDirNoMkdir(uid: string): string {
  const safe = uid.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(LECTURE_DIR, safe);
}

export function lectureGenDiag(uid: string, date: string, now = Date.now()): GenDiag {
  safeDate(date);
  return readGenDiag(userDirNoMkdir(uid), date, now);
}

export function peekLectureGenGate(
  uid: string,
  date: string,
  now = Date.now(),
  opts: { ignoreCooldown?: boolean } = {}
): GenSkip | null {
  safeDate(date);
  return peekGenGate(userDirNoMkdir(uid), date, now, opts);
}

export function lectureInputIdSet(lecture: LectureState): Set<string> {
  if (lecture.inputNewIds) {
    return new Set([...lecture.inputNewIds, ...(lecture.inputReviewIds ?? [])]);
  }
  return new Set([
    ...(lecture.newMistakeIds || []),
    ...(lecture.reviewMistakeIds || []),
    ...(lecture.inputReviewIds ?? []),
  ]);
}

function scriptCoversInputs(existing: LectureState, newList: LectureMistakeInput[]): boolean {
  const ids = lectureInputIdSet(existing);
  return newList.every((m) => ids.has(m.id));
}

class GenSkipError extends Error {
  skip: GenSkip;
  constructor(skip: GenSkip) {
    super(LECTURE_GEN_SKIPPED);
    this.name = 'GenSkipError';
    this.skip = skip;
  }
}

function formatAudioFailureLog(classified: LectureAudioError, err: unknown): string {
  const errName = classified.errName ?? safeErrName(err);
  return JSON.stringify({
    stage: classified.stage,
    code: classified.code,
    httpStatus: classified.httpStatus,
    googleStatus: classified.googleStatus,
    attempts: classified.attempts,
    completed: classified.completed,
    total: classified.total,
    ...(classified.segIndex !== undefined ? { segIndex: classified.segIndex } : {}),
    ...(classified.segChars !== undefined ? { segChars: classified.segChars } : {}),
    ...(classified.elapsedMs !== undefined ? { elapsedMs: classified.elapsedMs } : {}),
    ...(classified.attemptMs !== undefined ? { attemptMs: classified.attemptMs } : {}),
    ...(classified.loopDelayMaxMs !== undefined ? { loopDelayMaxMs: classified.loopDelayMaxMs } : {}),
    ...(errName ? { errName } : {}),
  });
}

export function retryCooldownUntilMs(
  state: Pick<LectureState, 'audioRetryAfter' | 'audioRebuildFailedAt'>
): number | null {
  if (state.audioRetryAfter) {
    const t = Date.parse(state.audioRetryAfter);
    if (Number.isFinite(t)) return t;
  }
  if (state.audioRebuildFailedAt) {
    const t = Date.parse(state.audioRebuildFailedAt);
    if (Number.isFinite(t)) return t + LECTURE_AUDIO_RETRY_COOLDOWN_MS;
  }
  return null;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Wall-clock age from job start. Process timers may be frozen while the host throttles CPU. */
export function lectureJobAgeMs(
  state: { createdAt?: string; updatedAt?: string },
  now = Date.now()
): number | null {
  const t = Date.parse(state.createdAt || state.updatedAt || '');
  return Number.isFinite(t) ? now - t : null;
}

/** True when the job has been generating longer than the wall-clock cap, even if `running` is still set. */
export function isLectureJobWallClockTimedOut(
  state: { createdAt?: string; updatedAt?: string },
  now = Date.now(),
  limitMs = LECTURE_JOB_TIMEOUT_MS
): boolean {
  const age = lectureJobAgeMs(state, now);
  return age != null && age > limitMs;
}

export interface LectureState {
  uid: string;
  date: string;
  status: 'generating' | 'ready' | 'failed';
  title?: string;
  script?: LectureScriptItem[];
  coachNote?: string;
  itemCount?: number;
  newMistakeIds: string[];
  reviewMistakeIds: string[];
  inputNewIds?: string[];
  inputReviewIds?: string[];
  inputLatestCreatedAt?: string;
  ttsEngine: 'gemini' | 'elevenlabs';
  chars?: number;
  textTokens?: number;
  textInputTokens?: number;
  textOutputTokens?: number;
  ttsAudioSec?: number;
  ttsAudioChars?: number;
  durationSec?: number;
  durationFit?: LectureDurationFit;
  audioFile?: string; // relative file name inside LECTURE_DIR/{uid}
  audioMime?: string;
  audioBackupId?: string;
  audioChunks?: number;
  /** Audio generation only. Do not use status=generating for a TTS rebuild of a ready script. */
  audioStatus?: 'ready' | 'rebuilding' | 'missing';
  audioRebuildStartedAt?: string;
  audioRebuildFailedAt?: string;
  audioRetryAfter?: string;
  audioError?: LectureAudioError;
  audioBackup?: AudioBackupResult;
  audioProgress?: { completed: number; total: number };
  error?: string;
  createdAt: string;
  updatedAt: string;
}

function userDir(uid: string): string {
  const safe = uid.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(LECTURE_DIR, safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  return date;
}

export function kstToday(): string {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

export function maxCreatedAtIso(items: ReadonlyArray<{ createdAt?: string }>): string | undefined {
  let maxMs = -Infinity;
  let maxIso: string | undefined;
  for (const it of items) {
    if (!it?.createdAt) continue;
    const ms = Date.parse(it.createdAt);
    if (Number.isFinite(ms) && ms > maxMs) {
      maxMs = ms;
      maxIso = it.createdAt;
    }
  }
  return maxIso;
}

export function audioRebuildOverlay(
  st: LectureState,
  isRunning: boolean,
  now = Date.now()
): LectureState {
  if (st.status !== 'ready' || st.audioStatus !== 'rebuilding') return st;
  if (!isRunning) {
    return { ...st, audioStatus: 'missing', error: 'INTERRUPTED' };
  }
  const startedMs = Date.parse(st.audioRebuildStartedAt ?? st.updatedAt ?? '');
  if (Number.isFinite(startedMs) && now - startedMs > LECTURE_AUDIO_REBUILD_TIMEOUT_MS) {
    return {
      ...st,
      audioStatus: 'missing',
      error: LECTURE_AUDIO_REBUILD_TIMED_OUT,
      audioRebuildFailedAt:
        st.audioRebuildFailedAt ?? new Date(startedMs + LECTURE_AUDIO_REBUILD_TIMEOUT_MS).toISOString(),
    };
  }
  return st;
}

export function readLectureState(uid: string, date: string, now = Date.now()): LectureState | null {
  const file = path.join(userDir(uid), `${safeDate(date)}.json`);
  if (!fs.existsSync(file)) return null;
  let state: LectureState;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  // "generating" with no in-memory job (server restarted mid-job): INTERRUPTED, even
  // if the wall-clock cap has also passed — the home card should say the server restarted.
  // "generating" past the wall-clock cap while `running` is still set (CPU-throttled
  // timers never fired): TIMED_OUT. The feed retries both immediately.
  const key = `${uid}:${date}`;
  if (state.status === 'generating') {
    if (!running.has(key)) {
      return { ...state, status: 'failed', error: 'INTERRUPTED' };
    }
    if (isLectureJobWallClockTimedOut(state, now)) {
      return { ...state, status: 'failed', error: 'TIMED_OUT' };
    }
  }
  return audioRebuildOverlay(state, running.has(key), now);
}

function writeLectureState(state: LectureState): void {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(userDir(state.uid), `${safeDate(state.date)}.json`), JSON.stringify(state, null, 2));
}

export function lectureAudioPath(uid: string, date: string): string | null {
  const st = readLectureState(uid, date);
  if (!st?.audioFile) return null;
  const p = path.join(userDir(uid), path.basename(st.audioFile));
  return fs.existsSync(p) ? p : null;
}

export function lectureHasLocalScript(uid: string, date: string): boolean {
  const st = readLectureState(uid, date);
  return Array.isArray(st?.script) && st!.script!.length > 0;
}

export interface LectureStatusPayload extends LectureState {
  hasAudio: boolean;
  audioMime?: string;
}

/** Safe status for the client to poll during TTS rebuild (no audio bytes). */
export function lectureStatusPayload(uid: string, date: string): LectureStatusPayload | null {
  const st = readLectureState(uid, date);
  if (!st) return null;
  const file = lectureAudioPath(uid, date);
  const audioStatus = st.audioStatus || (file ? 'ready' : st.status === 'ready' ? 'missing' : undefined);
  return {
    ...st,
    audioStatus,
    hasAudio: Boolean(file),
    audioMime: st.audioMime || mimeForAudioFile(st.audioFile),
  };
}

function removeLegacyAudioFiles(dir: string, date: string, keepName?: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  for (const ext of ['wav', 'm4a', 'mp3']) {
    const name = `${date}.${ext}`;
    if (keepName && name === keepName) continue;
    const p = path.join(dir, name);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
  }
}

export const LECTURE_AUDIO_MISSING = 'LECTURE_AUDIO_MISSING';
export const LECTURE_AUDIO_SCRIPT_MISSING = 'LECTURE_AUDIO_SCRIPT_MISSING';
// Keep literal 23 so legacy backups with 3 reviews still pass sanitizeLectureScriptPayload.
export const MAX_LECTURE_SCRIPT_ITEMS = MAX_NEW + 3;

export type LecturePcm = { data: Buffer; rate: number };
export type LectureSynthesizeFn = (
  ai: GoogleGenAI,
  engine: 'gemini' | 'elevenlabs',
  text: string,
  twoSpeakers: boolean,
  signal?: AbortSignal
) => Promise<LecturePcm>;

export interface LectureAudioScriptPayload {
  title?: string;
  coachNote?: string;
  script: LectureScriptItem[];
  itemCount?: number;
  newMistakeIds?: string[];
  reviewMistakeIds?: string[];
  inputNewIds?: string[];
  inputReviewIds?: string[];
  inputLatestCreatedAt?: string;
  ttsEngine?: 'gemini' | 'elevenlabs';
  createdAt?: string;
  textTokens?: number;
  textInputTokens?: number;
  textOutputTokens?: number;
  ttsAudioSec?: number;
  ttsAudioChars?: number;
  audioBackupId?: string;
  audioChunks?: number;
  durationFit?: LectureDurationFit;
}

export type LectureScriptSanitizeResult =
  | { ok: true; payload: LectureAudioScriptPayload }
  | { ok: false; error: string };

function sanitizeDurationFit(raw: unknown): LectureDurationFit | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const f = raw as Record<string, unknown>;
  const nums = [
    'baseSec',
    'droppedCount',
    'replayCount',
    'drillUnits',
    'padSec',
    'guardPadSec',
    'truncatedSec',
    'extraTtsCalls',
  ] as const;
  for (const k of nums) {
    if (typeof f[k] !== 'number' || !Number.isFinite(f[k])) return undefined;
  }
  if (typeof f.recap !== 'boolean') return undefined;
  return {
    baseSec: f.baseSec as number,
    droppedCount: f.droppedCount as number,
    replayCount: f.replayCount as number,
    recap: f.recap,
    drillUnits: f.drillUnits as number,
    padSec: f.padSec as number,
    guardPadSec: f.guardPadSec as number,
    truncatedSec: f.truncatedSec as number,
    extraTtsCalls: f.extraTtsCalls as number,
  };
}

export function sanitizeLectureScriptPayload(raw: unknown): LectureScriptSanitizeResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'script payload must be an object' };
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.script)) return { ok: false, error: 'script must be an array' };
  if (obj.script.length === 0) return { ok: false, error: 'script is empty' };
  if (obj.script.length > MAX_LECTURE_SCRIPT_ITEMS) {
    return { ok: false, error: `script must not exceed ${MAX_LECTURE_SCRIPT_ITEMS} items` };
  }
  const items: LectureScriptItem[] = [];
  for (const row of obj.script) {
    if (!row || typeof row !== 'object') return { ok: false, error: 'each script item must be an object' };
    const it = row as Record<string, unknown>;
    if (typeof it.mistakeId !== 'string' || !it.mistakeId.trim()) {
      return { ok: false, error: 'script item needs mistakeId' };
    }
    if (typeof it.myPhrase !== 'string' || typeof it.naturalPhrase !== 'string') {
      return { ok: false, error: 'script item needs myPhrase and naturalPhrase' };
    }
    const kind = it.kind === 'review' ? 'review' : 'new';
    const dialogue = Array.isArray(it.dialogue)
      ? it.dialogue.slice(0, MAX_DIALOGUE_LINES).flatMap((d) => {
          if (!d || typeof d !== 'object') return [];
          const line = d as Record<string, unknown>;
          if (typeof line.line !== 'string') return [];
          const speaker = line.speaker === 'Partner' ? 'Partner' : 'Coach';
          return [{ speaker: speaker as 'Coach' | 'Partner', line: String(line.line).slice(0, 400) }];
        })
      : [];
    const extraExamples = Array.isArray(it.extraExamples)
      ? it.extraExamples
          .slice(0, MAX_EXTRA_EXAMPLES)
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .map((x) => x.trim().slice(0, 400))
      : undefined;
    const sourceDateKst =
      typeof it.sourceDateKst === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(it.sourceDateKst)
        ? it.sourceDateKst
        : undefined;
    const similarExample = typeof it.similarExample === 'string' ? String(it.similarExample).slice(0, 400) : undefined;
    const lessonTitle = typeof it.lessonTitle === 'string' ? String(it.lessonTitle).slice(0, 80) : undefined;
    items.push({
      mistakeId: String(it.mistakeId).slice(0, 80),
      kind,
      myPhrase: String(it.myPhrase).slice(0, 400),
      naturalPhrase: String(it.naturalPhrase).slice(0, 400),
      explanation: String(it.explanation || '').slice(0, 800),
      dialogue,
      meaningKo: String(it.meaningKo || '').slice(0, 400),
      answerEnglish: String(it.answerEnglish || it.naturalPhrase).slice(0, 400),
      similarExample,
      ...(extraExamples && extraExamples.length > 0 ? { extraExamples } : {}),
      sourceDateKst,
      lessonTitle,
      startSec: typeof it.startSec === 'number' && Number.isFinite(it.startSec) ? it.startSec : undefined,
    });
  }
  const ids = (list: unknown) =>
    (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string').map((x) => String(x).slice(0, 80));
  const durationFit = sanitizeDurationFit(obj.durationFit);
  const audioChunks =
    typeof obj.audioChunks === 'number' &&
    Number.isInteger(obj.audioChunks) &&
    obj.audioChunks >= 1 &&
    obj.audioChunks <= AUDIO_CHUNK_MAX
      ? obj.audioChunks
      : undefined;
  return {
    ok: true,
    payload: {
      title: typeof obj.title === 'string' ? obj.title.slice(0, 80) : undefined,
      coachNote: typeof obj.coachNote === 'string' ? obj.coachNote.slice(0, 1200) : undefined,
      script: items,
      itemCount: items.length,
      newMistakeIds: ids(obj.newMistakeIds),
      reviewMistakeIds: ids(obj.reviewMistakeIds),
      ...(Array.isArray(obj.inputNewIds) ? { inputNewIds: ids(obj.inputNewIds) } : {}),
      ...(Array.isArray(obj.inputReviewIds) ? { inputReviewIds: ids(obj.inputReviewIds) } : {}),
      ...(typeof obj.inputLatestCreatedAt === 'string' ? { inputLatestCreatedAt: obj.inputLatestCreatedAt } : {}),
      ttsEngine: obj.ttsEngine === 'elevenlabs' ? 'elevenlabs' : 'gemini',
      createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : undefined,
      textTokens: typeof obj.textTokens === 'number' && Number.isFinite(obj.textTokens) ? obj.textTokens : undefined,
      textInputTokens:
        typeof obj.textInputTokens === 'number' && Number.isFinite(obj.textInputTokens) && obj.textInputTokens >= 0
          ? obj.textInputTokens
          : undefined,
      textOutputTokens:
        typeof obj.textOutputTokens === 'number' && Number.isFinite(obj.textOutputTokens) && obj.textOutputTokens >= 0
          ? obj.textOutputTokens
          : undefined,
      ttsAudioSec:
        typeof obj.ttsAudioSec === 'number' && Number.isFinite(obj.ttsAudioSec) && obj.ttsAudioSec >= 0
          ? obj.ttsAudioSec
          : undefined,
      ttsAudioChars:
        typeof obj.ttsAudioChars === 'number' && Number.isFinite(obj.ttsAudioChars) && obj.ttsAudioChars >= 0
          ? obj.ttsAudioChars
          : undefined,
      ...(typeof obj.audioBackupId === 'string' && obj.audioBackupId ? { audioBackupId: obj.audioBackupId } : {}),
      ...(audioChunks !== undefined ? { audioChunks } : {}),
      ...(durationFit ? { durationFit } : {}),
    },
  };
}

const rebuildDone = new Map<string, Promise<void>>();

export function lectureRebuildInFlight(uid: string, date: string): Promise<void> | undefined {
  return rebuildDone.get(`${uid}:${date}`);
}

export interface StartLectureAudioRebuildOpts {
  synthesizeFn?: LectureSynthesizeFn;
  encodeFn?: LectureEncodeFn;
  onReady?: (state: LectureState, isCurrent: () => boolean) => void | Promise<void>;
  onFailed?: (state: LectureState, isCurrent: () => boolean) => void | Promise<void>;
  now?: number;
  ignoreCooldown?: boolean;
  clearAudioBackupPointers?: boolean;
  genRemote?: GenRemote | null;
  /** Test hook: shorten the audio rebuild cap. */
  rebuildTimeoutMs?: number;
}

export function lectureJobEpoch(uid: string, date: string): number {
  return jobEpoch.get(`${uid}:${safeDate(date)}`) ?? 0;
}

/** Atomically install downloaded backup audio for a ready lecture unless a job is running or state changed. */
export function installRestoredLectureAudio(
  uid: string,
  date: string,
  backup: LectureState,
  audio: { ext: 'm4a' | 'mp3' | 'wav'; mime: string; buffer: Buffer; durationSec?: number },
  opts?: { expectedEpoch?: number; expectedCreatedAt?: string }
): LectureState | null {
  safeDate(date);
  const key = `${uid}:${date}`;
  if (running.has(key)) return null;
  if (opts?.expectedEpoch !== undefined && (jobEpoch.get(key) ?? 0) !== opts.expectedEpoch) {
    return null;
  }
  if (opts && 'expectedCreatedAt' in opts) {
    const currentLocal = readLectureState(uid, date);
    if (currentLocal?.createdAt !== opts.expectedCreatedAt) return null;
  }
  bumpJobEpoch(key);
  const dir = userDir(uid);
  const fileName = `${date}.${audio.ext}`;
  const finalPath = path.join(dir, fileName);
  const tmpPath = path.join(dir, `${fileName}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmpPath, audio.buffer);
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  removeLegacyAudioFiles(dir, date, fileName);
  const next: LectureState = {
    ...backup,
    uid,
    date,
    status: 'ready',
    audioStatus: 'ready',
    audioFile: fileName,
    audioMime: audio.mime || mimeForAudioFile(fileName),
    durationSec: audio.durationSec || backup.durationSec,
  };
  delete next.audioRebuildStartedAt;
  delete next.audioRebuildFailedAt;
  delete next.audioError;
  delete next.audioRetryAfter;
  delete next.error;
  delete next.audioProgress;
  writeLectureState(next);
  return next;
}

/**
 * Install a backed-up ready lecture locally in audioStatus='missing' state without audio files,
 * so cooldown-blocked instances do not trigger startLectureJob from scratch.
 */
export function installBackupLectureWithoutAudio(
  uid: string,
  date: string,
  backup: LectureState,
  opts?: { expectedEpoch?: number; expectedCreatedAt?: string; origin?: 'local' | 'backup' }
): LectureState | null {
  safeDate(date);
  const key = `${uid}:${date}`;
  if (running.has(key)) return null;
  if (opts?.expectedEpoch !== undefined && (jobEpoch.get(key) ?? 0) !== opts.expectedEpoch) {
    return null;
  }
  if (opts && 'expectedCreatedAt' in opts) {
    const currentLocal = readLectureState(uid, date);
    if (currentLocal?.createdAt !== opts.expectedCreatedAt) return null;
  }
  const next: LectureState = {
    ...backup,
    uid,
    date,
    status: 'ready',
    audioStatus: 'missing',
    ...(backup.audioError
      ? {
          audioError: { ...backup.audioError, origin: opts?.origin ?? 'backup' },
          error:
            backup.audioError.code === 'REBUILD_TIMEOUT'
              ? LECTURE_AUDIO_REBUILD_TIMED_OUT
              : 'GENERATION_FAILED',
        }
      : {}),
  };
  delete next.audioFile;
  delete next.audioMime;
  delete next.audioRebuildStartedAt;
  delete next.audioProgress;
  writeLectureState(next);
  return next;
}

/** Record backup upload outcome onto the matching local lecture state. */
export function recordLectureBackupResult(
  uid: string,
  date: string,
  match: { createdAt?: string; audioBackupId?: string },
  result: AudioBackupResult
): LectureState | null {
  safeDate(date);
  const current = readLectureState(uid, date);
  if (!current) return null;
  if (match.createdAt !== undefined && current.createdAt !== match.createdAt) return null;
  if (match.audioBackupId !== undefined && current.audioBackupId !== match.audioBackupId) return null;
  const cleanResult = sanitizeAudioBackupResult(result);
  if (!cleanResult) return null;
  const next: LectureState = {
    ...current,
    audioBackup: cleanResult,
  };
  if (cleanResult.result === 'ok' && cleanResult.chunks) {
    next.audioChunks = cleanResult.chunks;
  } else {
    delete next.audioBackupId;
    delete next.audioChunks;
  }
  writeLectureState(next);
  return next;
}

/**
 * Atomically save a transcoded MP3 file, update state.audioFile/audioMime, and remove legacy WAV/M4A files.
 * Returns null if the local state is missing or no longer matches `match`.
 */
export function replaceLectureAudioWithMp3(
  uid: string,
  date: string,
  mp3Buffer: Buffer,
  match?: { createdAt?: string; audioBackupId?: string }
): { audioPath: string; audioFile: string; audioMime: 'audio/mpeg'; updatedAt: string } | null {
  safeDate(date);
  const current = readLectureState(uid, date);
  if (!current) return null;
  if (match?.createdAt !== undefined && current.createdAt !== match.createdAt) return null;
  if (match?.audioBackupId !== undefined && current.audioBackupId !== match.audioBackupId) return null;

  const dir = userDir(uid);
  const fileName = `${date}.mp3`;
  const finalPath = path.join(dir, fileName);
  const tmpPath = path.join(dir, `${fileName}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmpPath, mp3Buffer);
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  const next: LectureState = {
    ...current,
    audioFile: fileName,
    audioMime: 'audio/mpeg',
  };
  writeLectureState(next);
  removeLegacyAudioFiles(dir, date, fileName);
  return { audioPath: finalPath, audioFile: fileName, audioMime: 'audio/mpeg', updatedAt: next.updatedAt! };
}

/**
 * Re-render TTS from an existing script when the WAV was lost (e.g. server disk wiped on redeploy).
 * Keeps status=ready so a ready lecture is not flipped to generating/INTERRUPTED.
 */
export function startLectureAudioRebuild(
  ai: GoogleGenAI,
  uid: string,
  date: string,
  payload?: unknown,
  opts: StartLectureAudioRebuildOpts = {}
): LectureState {
  safeDate(date);
  const key = `${uid}:${date}`;
  const nowMs = opts.now ?? Date.now();
  const existingPath = lectureAudioPath(uid, date);
  const existing = readLectureState(uid, date, nowMs);
  if (existingPath && existing) {
    return { ...existing, status: 'ready', audioStatus: 'ready' };
  }
  if (running.has(key) && existing) {
    if (existing.error !== LECTURE_AUDIO_REBUILD_TIMED_OUT) {
      return { ...existing, audioStatus: 'rebuilding' };
    }
    const cooldownUntil = retryCooldownUntilMs(existing);
    if (!opts.ignoreCooldown && cooldownUntil !== null && nowMs < cooldownUntil) {
      return existing;
    }
    abortCurrentJob(key);
  }

  const dir = userDirNoMkdir(uid);
  const blocked = peekGenGate(dir, date, nowMs, { ignoreCooldown: Boolean(opts.ignoreCooldown) });
  if (blocked) {
    return existing
      ? {
          ...existing,
          audioStatus: 'missing',
          error: LECTURE_GEN_SKIPPED,
          audioRetryAfter: blocked.until ?? existing.audioRetryAfter,
        }
      : {
          uid,
          date,
          status: 'failed',
          newMistakeIds: [],
          reviewMistakeIds: [],
          ttsEngine: 'gemini',
          audioStatus: 'missing',
          error: LECTURE_GEN_SKIPPED,
          audioRetryAfter:
            blocked.until ?? new Date(nowMs + LECTURE_AUDIO_RETRY_COOLDOWN_MS).toISOString(),
          createdAt: new Date(nowMs).toISOString(),
          updatedAt: new Date(nowMs).toISOString(),
        };
  }

  let scriptItems = existing?.script;
  let title = existing?.title;
  let coachNote = existing?.coachNote;
  let newMistakeIds = existing?.newMistakeIds || [];
  let reviewMistakeIds = existing?.reviewMistakeIds || [];
  let inputNewIds = existing?.inputNewIds;
  let inputReviewIds = existing?.inputReviewIds;
  let inputLatestCreatedAt = existing?.inputLatestCreatedAt;
  let ttsEngine: 'gemini' | 'elevenlabs' = existing?.ttsEngine || 'gemini';
  let createdAt = existing?.createdAt;
  let textTokens = existing?.textTokens;
  let textInputTokens = existing?.textInputTokens;
  let textOutputTokens = existing?.textOutputTokens;
  let ttsAudioSec = existing?.ttsAudioSec;
  let ttsAudioChars = existing?.ttsAudioChars;
  let audioBackupId = existing?.audioBackupId;
  let audioChunks = existing?.audioChunks;

  if ((!scriptItems || scriptItems.length === 0) && payload !== undefined) {
    const sanitized = sanitizeLectureScriptPayload(payload);
    if (!sanitized.ok) {
      const failed: LectureState = {
        uid,
        date,
        status: existing?.status === 'ready' ? 'ready' : 'failed',
        newMistakeIds,
        reviewMistakeIds,
        ttsEngine,
        createdAt: createdAt || new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
        audioStatus: 'missing',
        error: sanitized.error,
      };
      if (existing?.status === 'ready') {
        // Keep the ready lecture; just report that rebuild could not start.
        return { ...existing, audioStatus: 'missing', error: sanitized.error };
      }
      writeLectureState(failed);
      return failed;
    }
    scriptItems = sanitized.payload.script;
    title = sanitized.payload.title || title;
    coachNote = sanitized.payload.coachNote ?? coachNote;
    if (sanitized.payload.newMistakeIds?.length) newMistakeIds = sanitized.payload.newMistakeIds;
    if (sanitized.payload.reviewMistakeIds?.length) reviewMistakeIds = sanitized.payload.reviewMistakeIds;
    if (sanitized.payload.inputNewIds) inputNewIds = sanitized.payload.inputNewIds;
    if (sanitized.payload.inputReviewIds) inputReviewIds = sanitized.payload.inputReviewIds;
    if (sanitized.payload.inputLatestCreatedAt) inputLatestCreatedAt = sanitized.payload.inputLatestCreatedAt;
    ttsEngine = sanitized.payload.ttsEngine || ttsEngine;
    createdAt = sanitized.payload.createdAt || createdAt;
    textTokens = sanitized.payload.textTokens ?? textTokens;
    textInputTokens = sanitized.payload.textInputTokens ?? textInputTokens;
    textOutputTokens = sanitized.payload.textOutputTokens ?? textOutputTokens;
    ttsAudioSec = sanitized.payload.ttsAudioSec ?? ttsAudioSec;
    ttsAudioChars = sanitized.payload.ttsAudioChars ?? ttsAudioChars;
    audioBackupId = sanitized.payload.audioBackupId ?? audioBackupId;
    audioChunks = sanitized.payload.audioChunks ?? audioChunks;
  }

  if (!scriptItems || scriptItems.length === 0) {
    const st: LectureState = {
      uid,
      date,
      status: existing?.status === 'ready' ? 'ready' : 'failed',
      newMistakeIds,
      reviewMistakeIds,
      ttsEngine,
      createdAt: createdAt || new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      audioStatus: 'missing',
      error: LECTURE_AUDIO_SCRIPT_MISSING,
      ...(existing || {}),
    };
    st.status = existing?.status === 'ready' ? 'ready' : 'failed';
    st.audioStatus = 'missing';
    st.error = LECTURE_AUDIO_SCRIPT_MISSING;
    if (existing?.status !== 'ready') writeLectureState(st);
    return st;
  }

  const ac = new AbortController();
  const epoch = bumpJobEpoch(key);
  jobAbort.set(key, ac);
  const nowIso = new Date(nowMs).toISOString();
  const state: LectureState = {
    ...(existing || {}),
    uid,
    date,
    status: 'ready',
    title: title || existing?.title || '오늘 아침 강의',
    script: scriptItems,
    coachNote,
    itemCount: scriptItems.length,
    newMistakeIds,
    reviewMistakeIds,
    ...(inputNewIds ? { inputNewIds } : {}),
    ...(inputReviewIds ? { inputReviewIds } : {}),
    ...(inputLatestCreatedAt ? { inputLatestCreatedAt } : {}),
    ttsEngine,
    textTokens,
    ...(typeof textInputTokens === 'number' ? { textInputTokens } : {}),
    ...(typeof textOutputTokens === 'number' ? { textOutputTokens } : {}),
    ...(typeof ttsAudioSec === 'number' ? { ttsAudioSec } : {}),
    ...(typeof ttsAudioChars === 'number' ? { ttsAudioChars } : {}),
    ...(audioBackupId ? { audioBackupId } : {}),
    ...(audioChunks !== undefined ? { audioChunks } : {}),
    createdAt: createdAt || existing?.createdAt || nowIso,
    updatedAt: nowIso,
    audioStatus: 'rebuilding',
    audioRebuildStartedAt: nowIso,
  };
  delete state.error;
  delete state.audioError;
  delete state.audioRetryAfter;
  delete state.audioFile;
  delete state.audioMime;
  delete state.audioProgress;
  delete state.audioRebuildFailedAt;
  delete state.audioBackup;
  if (opts.clearAudioBackupPointers) {
    delete state.audioBackupId;
    delete state.audioChunks;
  }
  const ctx: LectureJobContext = {
    key,
    epoch,
    signal: ac.signal,
    write: (st) => writeLectureStateForJob(st, key, epoch),
    billable: { calls: 0 },
  };
  ctx.write(state);
  running.add(key);
  const cap = opts.rebuildTimeoutMs ?? LECTURE_AUDIO_REBUILD_TIMEOUT_MS;
  let slot: GenSlot | undefined;
  let releaseScheduled = false;
  const work = !opts.genRemote
    ? (() => {
        const r = acquireGenSlotSync(dir, date, {
          kind: 'rebuild',
          ttlMs: cap + GEN_LEASE_MARGIN_MS,
          ignoreCooldown: Boolean(opts.ignoreCooldown),
          now: opts.now ?? Date.now(),
        });
        if (!r.ok) return Promise.reject(new GenSkipError(r.skip));
        slot = r.slot;
        slot.billable = ctx.billable!;
        return renderAndSaveAudio(
          ai,
          state,
          { title: state.title || '오늘 아침 강의', items: scriptItems!, coachNote: state.coachNote || '' },
          opts.synthesizeFn,
          ctx,
          opts.encodeFn
        );
      })()
    : (async () => {
        const r = await acquireGenSlot(dir, date, {
          kind: 'rebuild',
          ttlMs: cap + GEN_LEASE_MARGIN_MS,
          remote: opts.genRemote,
          ignoreCooldown: Boolean(opts.ignoreCooldown),
          now: opts.now ?? Date.now(),
        });
        if (!r.ok) throw new GenSkipError(r.skip);
        slot = r.slot;
        slot.billable = ctx.billable!;
        if (ac.signal.aborted || !isCurrentJob(key, epoch)) return;
        await renderAndSaveAudio(
          ai,
          state,
          { title: state.title || '오늘 아침 강의', items: scriptItems!, coachNote: state.coachNote || '' },
          opts.synthesizeFn,
          ctx,
          opts.encodeFn
        );
      })();
  const done = withTimeout(work, cap, 'audio rebuild')
    .then(
      async () => {
        const currentFn = () => isCurrentJob(key, epoch);
        if (!currentFn()) return;
        running.delete(key);
        if (jobAbort.get(key) === ac) jobAbort.delete(key);
        if (opts.onReady) {
          try {
            await opts.onReady(state, currentFn);
          } catch (err: any) {
            console.warn('[Lecture] rebuild onReady failed:', err?.name || 'error');
          }
        }
        releaseScheduled = true;
        await slot?.release({ success: true });
      },
      async (err) => {
        const currentFn = () => isCurrentJob(key, epoch);
        if (!currentFn()) return;
        if (err instanceof GenSkipError) {
          running.delete(key);
          rebuildDone.delete(key);
          if (jobAbort.get(key) === ac) jobAbort.delete(key);
          state.audioStatus = 'missing';
          state.error = LECTURE_GEN_SKIPPED;
          state.audioRetryAfter =
            err.skip.until ?? new Date(Date.now() + LECTURE_AUDIO_RETRY_COOLDOWN_MS).toISOString();
          delete state.audioRebuildStartedAt;
          delete state.audioProgress;
          ctx.write(state);
          return;
        }
        const timedOut = JOB_TIMED_OUT_RE.test(String(err?.message || err));
        const failedNowMs = Date.now();
        const failedAtIso = new Date(failedNowMs).toISOString();
        const classified = classifyLectureAudioError(err, {
          stage: timedOut ? 'rebuild_timeout' : undefined,
          at: failedAtIso,
          origin: 'local',
        });
        console.error('[Lecture] audio rebuild failed:', formatAudioFailureLog(classified, err));
        try { ac.abort(); } catch { /* ignore */ }
        state.audioStatus = 'missing';
        state.error = timedOut ? LECTURE_AUDIO_REBUILD_TIMED_OUT : 'GENERATION_FAILED';
        state.audioRebuildFailedAt = failedAtIso;
        state.audioError = classified;
        state.audioRetryAfter = new Date(failedNowMs + cooldownMsFor(classified.code)).toISOString();
        ctx.write(state);
        if (isCurrentJob(key, epoch)) {
          running.delete(key);
          rebuildDone.delete(key);
          if (jobAbort.get(key) === ac) jobAbort.delete(key);
        }
        releaseScheduled = true;
        if (opts.onFailed) {
          let onFailPromise: Promise<unknown>;
          try {
            onFailPromise = Promise.resolve(opts.onFailed(state, currentFn)).catch((onFailErr: any) => {
              console.warn('[Lecture] rebuild onFailed failed:', onFailErr?.name || 'error');
            });
          } catch (onFailErr: any) {
            console.warn('[Lecture] rebuild onFailed failed:', onFailErr?.name || 'error');
            onFailPromise = Promise.resolve();
          }
          void onFailPromise.finally(() =>
            slot?.release({ success: false, code: classified.code, now: failedNowMs })
          );
        } else {
          await slot?.release({ success: false, code: classified.code, now: failedNowMs });
        }
      }
    )
    .finally(async () => {
      if (isCurrentJob(key, epoch)) {
        running.delete(key);
        rebuildDone.delete(key);
        if (jobAbort.get(key) === ac) jobAbort.delete(key);
      }
      if (!releaseScheduled) {
        releaseScheduled = true;
        await slot?.release({ success: false });
      }
    });
  rebuildDone.set(key, done.then(() => undefined));
  return state;
}

const running = new Set<string>();
const jobEpoch = new Map<string, number>();
const jobAbort = new Map<string, AbortController>();

export interface LectureJobContext {
  key: string;
  epoch: number;
  signal: AbortSignal;
  write: (state: LectureState) => boolean;
  billable?: { calls: number };
}

function bumpJobEpoch(key: string): number {
  const n = (jobEpoch.get(key) || 0) + 1;
  jobEpoch.set(key, n);
  return n;
}

function abortCurrentJob(key: string): void {
  const ac = jobAbort.get(key);
  if (ac) {
    jobAbort.delete(key);
    try { ac.abort(); } catch { /* ignore */ }
  }
  running.delete(key);
  rebuildDone.delete(key);
  bumpJobEpoch(key);
}

export function withAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new Error('lecture job superseded'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('lecture job superseded'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
}

function isCurrentJob(key: string, epoch: number): boolean {
  return jobEpoch.get(key) === epoch;
}

function writeLectureStateForJob(state: LectureState, key: string, epoch: number): boolean {
  if (!isCurrentJob(key, epoch)) return false;
  writeLectureState(state);
  return true;
}


export type LectureGenerateScriptFn = (
  ai: GoogleGenAI,
  date: string,
  newList: LectureMistakeInput[],
  reviewList: LectureMistakeInput[],
  signal?: AbortSignal
) => Promise<{
  title: string;
  items: LectureScriptItem[];
  coachNote: string;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}>;

export interface StartLectureJobOpts {
  force?: boolean;
  ignoreCooldown?: boolean;
  genRemote?: GenRemote | null;
  now?: number;
  /** Test hook: shorten the whole-job cap. */
  jobTimeoutMs?: number;
  /** Called once when the job finishes with status==='ready' and is still the current job. */
  onReady?: (state: LectureState, isCurrent: () => boolean) => void | Promise<void>;
  /** Called once when the job fails and is still the current job. */
  onFailed?: (state: LectureState, isCurrent: () => boolean) => void | Promise<void>;
  /** Test hook: replace script+TTS so tests do not call Gemini. */
  runJobFn?: (
    ai: GoogleGenAI,
    state: LectureState,
    newList: LectureMistakeInput[],
    reviewList: LectureMistakeInput[],
    ctx: LectureJobContext
  ) => Promise<void>;
  /** Test hook: replace script generation so tests do not call Gemini. */
  generateScriptFn?: LectureGenerateScriptFn;
  /** Test hook: replace TTS synthesis so tests do not call Gemini. */
  synthesizeFn?: LectureSynthesizeFn;
  /** Test hook: replace audio encoding (e.g. stub m4a). */
  encodeFn?: LectureEncodeFn;
}

/**
 * Restore a ready lecture from backup by re-rendering TTS audio from the backed-up script.
 * Skips when a non-timed-out job is already running.
 */
export function restoreReadyLecture(
  ai: GoogleGenAI,
  uid: string,
  date: string,
  backup: LectureState,
  opts: StartLectureAudioRebuildOpts = {}
): LectureState | null {
  safeDate(date);
  const key = `${uid}:${date}`;
  const existing = readLectureState(uid, date, opts.now);
  if (running.has(key) && existing?.error !== LECTURE_AUDIO_REBUILD_TIMED_OUT && existing?.status !== 'failed') {
    return existing;
  }
  if (!backup || backup.status !== 'ready' || !Array.isArray(backup.script) || backup.script.length === 0) {
    return existing;
  }
  return startLectureAudioRebuild(ai, uid, date, backup, opts);
}

/**
 * Start (or return existing) lecture job. Never regenerates a ready lecture unless force=true.
 * With force=true, aborts any running generation or audio rebuild and supersedes its epoch.
 */
export function startLectureJob(
  ai: GoogleGenAI,
  uid: string,
  date: string,
  newMistakes: LectureMistakeInput[],
  reviewMistakes: LectureMistakeInput[],
  opts: StartLectureJobOpts = {}
): LectureState {
  safeDate(date);
  const key = `${uid}:${date}`;
  const nowMs = opts.now ?? Date.now();
  const existing = readLectureState(uid, date, nowMs);
  const { newList, reviewList } = sanitizeLectureInputs(newMistakes, reviewMistakes);

  if (newList.length + reviewList.length === 0) {
    if (existing && ((running.has(key) && existing.status !== 'failed') || existing.status === 'ready')) {
      return existing;
    }
    const engine = process.env.LECTURE_TTS_ENGINE === 'elevenlabs' ? 'elevenlabs' : 'gemini';
    const now = new Date(nowMs).toISOString();
    const emptyState: LectureState = {
      uid,
      date,
      status: 'failed',
      newMistakeIds: [],
      reviewMistakeIds: [],
      inputNewIds: [],
      inputReviewIds: [],
      ttsEngine: engine,
      error: 'NOTHING_TO_TEACH',
      createdAt: now,
      updatedAt: now,
    };
    writeLectureState(emptyState);
    return emptyState;
  }

  if (existing && running.has(key) && existing.status !== 'failed' && !opts.force) {
    return existing;
  }
  if (existing?.status === 'ready' && !opts.force && !lectureRebuildInFlight(uid, date)) {
    return existing;
  }

  const dir = userDirNoMkdir(uid);
  const blocked = peekGenGate(dir, date, nowMs, { ignoreCooldown: Boolean(opts.ignoreCooldown) });
  if (blocked) {
    const engine = process.env.LECTURE_TTS_ENGINE === 'elevenlabs' ? 'elevenlabs' : 'gemini';
    const nowIso = new Date(nowMs).toISOString();
    const retryAfter =
      blocked.until ?? new Date(nowMs + LECTURE_AUDIO_RETRY_COOLDOWN_MS).toISOString();
    if (existing) {
      return {
        ...existing,
        error: LECTURE_GEN_SKIPPED,
        audioRetryAfter: retryAfter,
      };
    }
    return {
      uid,
      date,
      status: 'failed',
      newMistakeIds: newList.map((m) => m.id),
      reviewMistakeIds: reviewList.map((m) => m.id),
      inputNewIds: newList.map((m) => m.id),
      inputReviewIds: reviewList.map((m) => m.id),
      ttsEngine: engine,
      error: LECTURE_GEN_SKIPPED,
      audioRetryAfter: retryAfter,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }

  if (running.has(key)) {
    abortCurrentJob(key);
  }

  if (
    !opts.force &&
    !opts.runJobFn &&
    existing?.status === 'failed' &&
    Array.isArray(existing.script) &&
    existing.script.length > 0 &&
    scriptCoversInputs(existing, newList)
  ) {
    return startLectureAudioRebuild(ai, uid, date, undefined, {
      synthesizeFn: opts.synthesizeFn,
      encodeFn: opts.encodeFn,
      onReady: opts.onReady,
      onFailed: opts.onFailed,
      genRemote: opts.genRemote,
      ignoreCooldown: opts.ignoreCooldown,
      now: opts.now,
    });
  }

  const snapshot = existing;
  const engine = process.env.LECTURE_TTS_ENGINE === 'elevenlabs' ? 'elevenlabs' : 'gemini';
  const now = new Date(nowMs).toISOString();
  const inputNewIds = newList.map((m) => m.id);
  const inputReviewIds = reviewList.map((m) => m.id);
  const inputLatestCreatedAt = maxCreatedAtIso([...newList, ...reviewList]);
  const state: LectureState = {
    uid,
    date,
    status: 'generating',
    newMistakeIds: inputNewIds,
    reviewMistakeIds: inputReviewIds,
    inputNewIds,
    inputReviewIds,
    ...(inputLatestCreatedAt ? { inputLatestCreatedAt } : {}),
    ttsEngine: engine,
    createdAt: now,
    updatedAt: now,
  };

  const ac = new AbortController();
  const epoch = bumpJobEpoch(key);
  jobAbort.set(key, ac);
  const ctx: LectureJobContext = {
    key,
    epoch,
    signal: ac.signal,
    write: (st) => writeLectureStateForJob(st, key, epoch),
    billable: { calls: 0 },
  };
  ctx.write(state);
  running.add(key);
  const timeoutMs = opts.jobTimeoutMs ?? LECTURE_JOB_TIMEOUT_MS;
  let slot: GenSlot | undefined;
  let releaseScheduled = false;
  const work = !opts.genRemote
    ? (() => {
        const r = acquireGenSlotSync(dir, date, {
          kind: 'job',
          ttlMs: timeoutMs + GEN_LEASE_MARGIN_MS,
          ignoreCooldown: Boolean(opts.ignoreCooldown),
          now: opts.now ?? Date.now(),
        });
        if (!r.ok) return Promise.reject(new GenSkipError(r.skip));
        slot = r.slot;
        slot.billable = ctx.billable!;
        return opts.runJobFn
          ? opts.runJobFn(ai, state, newList, reviewList, ctx)
          : runJob(ai, state, newList, reviewList, ctx, {
              generateScriptFn: opts.generateScriptFn,
              synthesizeFn: opts.synthesizeFn,
              encodeFn: opts.encodeFn,
            });
      })()
    : (async () => {
        const r = await acquireGenSlot(dir, date, {
          kind: 'job',
          ttlMs: timeoutMs + GEN_LEASE_MARGIN_MS,
          remote: opts.genRemote,
          ignoreCooldown: Boolean(opts.ignoreCooldown),
          now: opts.now ?? Date.now(),
        });
        if (!r.ok) throw new GenSkipError(r.skip);
        slot = r.slot;
        slot.billable = ctx.billable!;
        if (ac.signal.aborted || !isCurrentJob(key, epoch)) return;
        await (opts.runJobFn
          ? opts.runJobFn(ai, state, newList, reviewList, ctx)
          : runJob(ai, state, newList, reviewList, ctx, {
              generateScriptFn: opts.generateScriptFn,
              synthesizeFn: opts.synthesizeFn,
              encodeFn: opts.encodeFn,
            }));
      })();
  withTimeout(work, timeoutMs, 'lecture job')
    .then(
      async () => {
        const currentFn = () => isCurrentJob(key, epoch);
        if (!currentFn()) return;
        running.delete(key);
        if (jobAbort.get(key) === ac) jobAbort.delete(key);
        if (state.status !== 'ready') return;
        if (opts.onReady) {
          try {
            await opts.onReady(state, currentFn);
          } catch (err: any) {
            console.warn('[Lecture] onReady failed:', err?.message || err);
          }
        }
        releaseScheduled = true;
        await slot?.release({ success: true });
      },
      async (err) => {
        const currentFn = () => isCurrentJob(key, epoch);
        if (!currentFn()) return;
        if (err instanceof GenSkipError) {
          running.delete(key);
          if (jobAbort.get(key) === ac) jobAbort.delete(key);
          if (snapshot?.status === 'ready') {
            ctx.write(snapshot);
          } else {
            const skipUntil =
              err.skip.until ??
              new Date(Date.now() + LECTURE_AUDIO_RETRY_COOLDOWN_MS).toISOString();
            ctx.write({
              ...(snapshot ?? state),
              status: 'failed',
              error: LECTURE_GEN_SKIPPED,
              audioRetryAfter: skipUntil,
            });
          }
          return;
        }
        const timedOut = JOB_TIMED_OUT_RE.test(String(err?.message || err));
        const failedNowMs = Date.now();
        const failedAtIso = new Date(failedNowMs).toISOString();
        const fallbackStage: AudioErrorStage = state.audioProgress ? 'tts' : 'script';
        const classified = classifyLectureAudioError(err, {
          stage: fallbackStage,
          at: failedAtIso,
          origin: 'local',
        });
        console.error('[Lecture] job failed:', formatAudioFailureLog(classified, err));
        running.delete(key);
        try { ac.abort(); } catch { /* ignore */ }
        if (jobAbort.get(key) === ac) jobAbort.delete(key);
        state.status = 'failed';
        // Shown in the app and on the public feed page: a code only, details stay in the log.
        state.error = timedOut ? 'TIMED_OUT' : 'GENERATION_FAILED';
        state.audioError = classified;
        state.audioRetryAfter = new Date(failedNowMs + cooldownMsFor(classified.code)).toISOString();
        writeLectureState(state);
        releaseScheduled = true;
        if (opts.onFailed) {
          let onFailPromise: Promise<unknown>;
          try {
            onFailPromise = Promise.resolve(opts.onFailed(state, currentFn)).catch((onFailErr: any) => {
              console.warn('[Lecture] onFailed failed:', onFailErr?.name || 'error');
            });
          } catch (onFailErr: any) {
            console.warn('[Lecture] onFailed failed:', onFailErr?.name || 'error');
            onFailPromise = Promise.resolve();
          }
          void onFailPromise.finally(() =>
            slot?.release({ success: false, code: classified.code, now: failedNowMs })
          );
        } else {
          await slot?.release({ success: false, code: classified.code, now: failedNowMs });
        }
        if (timedOut && currentFn()) {
          abortCurrentJob(key);
        }
      }
    )
    .finally(async () => {
      if (isCurrentJob(key, epoch)) {
        running.delete(key);
        if (jobAbort.get(key) === ac) jobAbort.delete(key);
      }
      if (!releaseScheduled) {
        releaseScheduled = true;
        await slot?.release({ success: false });
      }
    });
  return state;
}

function isSundayKst(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
}

async function generateScript(
  ai: GoogleGenAI,
  date: string,
  newList: LectureMistakeInput[],
  reviewList: LectureMistakeInput[],
  signal?: AbortSignal
): Promise<{
  title: string;
  items: LectureScriptItem[];
  coachNote: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
}> {
  const sunday = isSundayKst(date);
  const fmt = (list: LectureMistakeInput[], kind: string) =>
    list
      .map((m) => {
        const topic = m.lessonTitle ? ` | lessonTitle="${m.lessonTitle}"` : '';
        return `- id=${m.id} | kind=${kind} | myPhrase="${m.myPhrase}" | naturalPhrase="${m.naturalPhrase}" | reason="${m.reason || ''}"${topic}`;
      })
      .join('\n');
  const itemCount = newList.length + reviewList.length;
  const perItemSec = Math.max(35, Math.min(120, Math.round((365 - 30) / Math.max(1, itemCount))));
  const targetChars = perItemSec * 10;
  const depthGuide =
    perItemSec >= 100
      ? 'explanation은 6~10문장으로 자세히 쓰고, extraExamples에 추가 영어 예문 최대 2개를 넣으세요. dialogue는 최대 6줄까지 풍부하게 쓰세요.'
      : perItemSec >= 60
      ? 'explanation은 4~7문장으로 충분히 쓰고, extraExamples에 추가 영어 예문 최대 2개를 넣으세요. dialogue는 2~4줄로 쓰세요.'
      : 'explanation은 1~4문장으로 간결하게 쓰고, dialogue는 2~4줄로 쓰세요.';

  const prompt = `당신은 한국인 성인 학습자를 위한 아침 영어 오디오 강의 작가입니다. 전체 길이는 약 6분(최대 6분 10초)입니다.
아래 실수 목록으로 강의 대본을 만드세요. 해설자는 "Coach"(한국어로 설명), 대화 상대는 "Partner"(영어 원어민)입니다.

[실수 목록]
${fmt(newList, 'new')}
${fmt(reviewList, 'review')}

[대본 규칙 - 반드시 지킬 것]
1. 영어는 영어 철자 그대로 쓰세요. 영어를 한글 발음으로 적지 마세요(예: "땡큐" 금지, "thank you"로).
2. 항목마다 순서: 학습자의 원래 말(myPhrase, 입력 그대로, 고치지 말 것. 소개 문장은 시스템이 붙이므로 쓰지 마세요) → 자연스러운 표현(naturalPhrase) → 이유(explanation, 한국어) → 비슷한 예문 1개(similarExample, 영어 한 문장) → (필요 시) 추가 예문(extraExamples, 최대 2개) → 짧은 2인 대화(dialogue, 최대 6줄, Coach와 Partner가 번갈아 영어로, naturalPhrase가 자연스럽게 들어감. lessonTitle이 있으면 그 수업 상황을 따르고, 없으면 일반적인 상황) → 한국어 뜻(meaningKo, naturalPhrase의 한국어 뜻) → 정답 영어(answerEnglish = naturalPhrase). 한국어 뜻과 정답 사이의 무음은 시스템이 따로 넣으니, 대본에는 무음·쉼·초 표시를 쓰지 마세요.
3. 입력 목록 순서대로, 각 항목의 mistakeId와 kind는 입력 값 그대로 쓰세요. 항목을 빼거나 합치지 마세요. 목록에 없는 표현을 지어내지 마세요.
4. 전체 강의는 약 6분입니다. 항목 ${itemCount}개, 항목당 약 ${targetChars}자 분량으로 쓰세요. ${depthGuide} 예문과 해설을 짧게 줄이지 마세요. 시스템이 분량을 넘기면 우선순위가 낮은 항목을 빼므로, 넣은 항목의 깊이는 유지하세요.
5. title: 오늘 강의 제목(한국어, 20자 이내). title·explanation·dialogue·coachNote·similarExample·extraExamples에 '어젯밤', '어제', '오늘 아침 통화', '이번 주' 같은 시점 표현을 쓰지 마세요.
6. coachNote: 한국어 정확히 2문장. 각 문장은 마침표로 끝내고, 영어 문장은 넣지 마세요.${sunday ? ' 오늘은 일요일이므로 한 주를 마무리하는 따뜻한 톤으로 쓰세요. 위 목록에 있는 표현만 언급하고, 진도·횟수·졸업 수 같은 수치는 쓰지 마세요.' : ''}
7. 시험·교재의 상표나 문제를 복제하지 마세요.
8. 모든 문자열 값은 음성 합성기가 글자 그대로 소리 내어 읽습니다. 실제로 말할 문장만 쓰세요. 다음은 쓰지 마세요: ① 괄호나 대괄호로 된 연기·동작·효과 지시(예: (pause), (웃으며), [Coach smiles], (3초 무음)) ② "Narrator:", "내레이션:" 같은 해설자 줄 ③ "Say cheerfully:" 같은 말투 지시 ④ 마크다운 기호(**, *, \`, #, 목록 기호). dialogue.line에는 화자 이름을 붙이지 말고 대사만 쓰세요(화자는 speaker 필드에 씁니다). 뜻을 덧붙이는 괄호는 써도 됩니다(예: work for (소속)).`;

  const response = await withAbort(
    withTimeout(ai.models.generateContent({
      model: SCRIPT_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        abortSignal: signal,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  mistakeId: { type: Type.STRING },
                  kind: { type: Type.STRING, enum: ['new', 'review'] },
                  myPhrase: { type: Type.STRING },
                  naturalPhrase: { type: Type.STRING },
                  explanation: { type: Type.STRING },
                  dialogue: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        speaker: { type: Type.STRING, enum: ['Coach', 'Partner'] },
                        line: { type: Type.STRING },
                      },
                      required: ['speaker', 'line'],
                    },
                  },
                  meaningKo: { type: Type.STRING },
                  answerEnglish: { type: Type.STRING },
                  similarExample: { type: Type.STRING },
                  extraExamples: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                },
                required: ['mistakeId', 'kind', 'myPhrase', 'naturalPhrase', 'explanation', 'dialogue', 'meaningKo', 'answerEnglish', 'similarExample'],
              },
            },
            coachNote: { type: Type.STRING },
          },
          required: ['title', 'items', 'coachNote'],
        },
      },
    }), LECTURE_STEP_TIMEOUT_MS, 'lecture script'),
    signal
  );
  const parsed = JSON.parse(response.text?.trim() || '{}');
  const applied = applyModelScriptToInputs(newList, reviewList, parsed.items);
  if (applied.matched === 0) throw new Error('대본 생성 결과가 비어 있습니다.');
  const title = stripSpeechDirections(String(parsed.title || '')) || '오늘 아침 강의';
  const coachNote = normalizeCoachNote(String(parsed.coachNote || ''));
  const cleaned = applied.items.map(cleanLectureScriptItem);
  const { inputTokens, outputTokens } = tokensFromUsageMetadata(response.usageMetadata);
  return {
    title,
    items: trimItemsToBudget(cleaned, date, title, coachNote, LECTURE_EST_MAX_SEC),
    coachNote,
    tokens: Number(response.usageMetadata?.totalTokenCount || 0),
    inputTokens,
    outputTokens,
  };
}

interface Pcm {
  data: Buffer;
  rate: number;
}

function parseAudio(base64: string, mimeType: string): Pcm {
  let buf = Buffer.from(base64, 'base64');
  const rateMatch = /rate=(\d+)/i.exec(mimeType || '');
  let rate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
  if (/wav/i.test(mimeType) || buf.subarray(0, 4).toString('ascii') === 'RIFF') {
    rate = buf.readUInt32LE(24);
    // find "data" chunk
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.subarray(off, off + 4).toString('ascii');
      const size = buf.readUInt32LE(off + 4);
      if (id === 'data') {
        buf = buf.subarray(off + 8, off + 8 + size);
        break;
      }
      off += 8 + size;
    }
  }
  return { data: buf, rate };
}

/** ElevenLabs Text-to-Dialogue branch: skeleton only (no key, no call yet). */
async function synthesizeElevenLabs(_text: string, _twoSpeakers: boolean): Promise<Pcm> {
  throw new Error('ElevenLabs 경로는 아직 미구현(비교용 예정)');
}

export const TTS_STYLE = 'Read this morning English lesson warmly and clearly. Korean lines in natural Korean; English lines in natural American English (never Korean-accented transliteration).';

/**
 * Script lines look like "Coach: ..." / "Partner: ...". Both single- and multi-speaker TTS
 * receive style via speechMetadata so the model never reads style instructions aloud.
 */
export function toSpeechParts(text: string, twoSpeakers: boolean): any[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const parsed = lines
    .map((l) => {
      const m = /^(Coach|Partner)\s*:\s*(.*)$/.exec(l);
      return m ? { speaker: m[1], line: m[2].trim() } : { speaker: 'Coach', line: l };
    })
    .filter((p) => p.line.length > 0);
  if (!twoSpeakers) {
    const body = parsed.map((p) => p.line).join('\n');
    return body ? [{ text: body, speechMetadata: { style: TTS_STYLE } }] : [];
  }
  // Merge consecutive lines of the same speaker into one part.
  const parts: { text: string; speechMetadata: { speaker: string; style: string } }[] = [];
  for (const p of parsed) {
    const last = parts[parts.length - 1];
    if (last && last.speechMetadata.speaker === p.speaker) last.text += ' ' + p.line;
    else parts.push({ text: p.line, speechMetadata: { speaker: p.speaker, style: TTS_STYLE } });
  }
  return parts;
}

function attachErrorMeta(
  err: unknown,
  meta: {
    stage?: AudioErrorStage;
    attempts?: number;
    completed?: number;
    total?: number;
    segIndex?: number;
    segChars?: number;
    segElapsedMs?: number;
  }
): Error {
  const out = (
    err && typeof err === 'object'
      ? err
      : new Error(typeof err === 'string' ? err : 'error')
  ) as Error & Record<string, unknown>;
  if (meta.stage !== undefined && out.stage === undefined) out.stage = meta.stage;
  if (meta.attempts !== undefined && out.attempts === undefined) out.attempts = meta.attempts;
  if (meta.completed !== undefined) out.completed = meta.completed;
  if (meta.total !== undefined) out.total = meta.total;
  if (meta.segIndex !== undefined) out.segIndex = meta.segIndex;
  if (meta.segChars !== undefined) out.segChars = meta.segChars;
  if (meta.segElapsedMs !== undefined) out.segElapsedMs = meta.segElapsedMs;
  return out;
}

export interface SynthesizeGeminiOpts {
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  stepTimeoutMs?: number;
  loopDelayMonitor?: () => { stop(): number };
  flex?: boolean;
}

function clampLoopDelayMs(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(3_600_000, Math.round(v)));
}

function defaultLoopDelayMonitor(): { stop(): number } {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  return {
    stop: () => {
      h.disable();
      const ms = Number.isFinite(h.max) ? Math.round(h.max / 1e6) : 0;
      return clampLoopDelayMs(ms);
    },
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return withAbort(new Promise<void>((r) => setTimeout(r, ms)), signal);
}

export async function synthesizeGemini(
  ai: GoogleGenAI,
  text: string,
  twoSpeakers: boolean,
  signal?: AbortSignal,
  opts: SynthesizeGeminiOpts = {}
): Promise<Pcm> {
  const sleepFn = opts.sleepFn || defaultSleep;
  const nowFn = opts.now ?? Date.now;
  const stepTimeoutMs = opts.stepTimeoutMs ?? LECTURE_STEP_TIMEOUT_MS;
  const loopDelayMonitorFn = opts.loopDelayMonitor ?? defaultLoopDelayMonitor;
  const speechConfig: any = twoSpeakers
    ? {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: [
            { speaker: 'Coach', voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_COACH } } },
            { speaker: 'Partner', voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_PARTNER } } },
          ],
        },
      }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_COACH } } };
  const parts = toSpeechParts(text, twoSpeakers);
  const callTts = async (
    stepSig: AbortSignal,
    timeoutMs: number,
    serviceTier?: ServiceTier
  ): Promise<Pcm> => {
    const config: any = {
      abortSignal: stepSig,
      responseModalities: ['AUDIO'],
      speechConfig,
      ...(serviceTier !== undefined ? { serviceTier } : {}),
    };
    const response = await withAbort(
      withTimeout(
        ai.models.generateContent({
          model: LECTURE_TTS_MODEL,
          contents: [{ role: 'user', parts }],
          config,
        }),
        timeoutMs,
        'lecture TTS'
      ),
      signal
    );
    const part = response.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
    if (!part?.inlineData?.data) throw new Error('TTS 음성 데이터 없음');
    return parseAudio(part.inlineData.data, part.inlineData.mimeType || '');
  };

  const flexEnabled = opts.flex ?? process.env.LECTURE_TTS_FLEX !== 'off';
  if (flexEnabled) {
    if (signal?.aborted) throw new Error('lecture job superseded');
    const flexStart = nowFn();
    if (flexStart >= lectureTtsFlexDisabledUntil) {
      const flexTimeoutMs = Math.min(LECTURE_TTS_FLEX_TIMEOUT_MS, stepTimeoutMs);
      const timeoutSig = AbortSignal.timeout(flexTimeoutMs);
      const stepSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
      try {
        const pcm = await callTts(stepSig, flexTimeoutMs, ServiceTier.FLEX);
        const tookMs = nowFn() - flexStart;
        if (tookMs > LECTURE_TTS_FLEX_SLOW_MS) {
          // Slow queue: keep this segment, send the rest of the job to standard so the 15-minute cap holds.
          lectureTtsFlexDisabledUntil = nowFn() + LECTURE_TTS_FLEX_COOLDOWN_MS;
          console.warn('[Lecture] TTS flex slow, standard for 30m:', JSON.stringify({ elapsedMs: Math.round(tookMs) }));
        }
        return pcm;
      } catch (err: any) {
        if (signal?.aborted) throw err;
        const failedAt = nowFn();
        const elapsedMs = Math.max(0, Math.round(failedAt - flexStart));
        lectureTtsFlexDisabledUntil = failedAt + LECTURE_TTS_FLEX_COOLDOWN_MS;
        console.warn(
          '[Lecture] TTS flex fallback:',
          JSON.stringify({ elapsedMs, errName: safeErrName(err) })
        );
      }
    }
  }

  const attemptMs: number[] = [];
  let maxLoopDelayMs: number | undefined;
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new Error('lecture job superseded');
    const timeoutSig = AbortSignal.timeout(stepTimeoutMs);
    const stepSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
    const attemptStart = nowFn();
    const loopMonitor = loopDelayMonitorFn();
    let loopDelayMaxMs = 0;
    try {
      try {
        return await callTts(stepSig, stepTimeoutMs);
      } finally {
        loopDelayMaxMs = clampLoopDelayMs(loopMonitor.stop());
        maxLoopDelayMs =
          maxLoopDelayMs === undefined ? loopDelayMaxMs : Math.max(maxLoopDelayMs, loopDelayMaxMs);
      }
    } catch (err: any) {
      const elapsedMs = Math.max(0, Math.round(nowFn() - attemptStart));
      attemptMs.push(elapsedMs);
      const isAbortOrTimeout = err?.name === 'AbortError' || err?.name === 'TimeoutError';
      const normalized =
        timeoutSig.aborted && !signal?.aborted && isAbortOrTimeout
          ? Object.assign(new Error(`lecture TTS timed out after ${stepTimeoutMs}ms`, { cause: err }), {
              name: 'TimeoutError',
            })
          : err;
      lastErr = attachErrorMeta(normalized, { stage: 'tts' });
      (lastErr as any).attempts = attempt + 1;
      (lastErr as any).attemptMs = [...attemptMs];
      (lastErr as any).loopDelayMaxMs = maxLoopDelayMs;
      if (signal?.aborted) throw lastErr;
      const classified = classifyLectureAudioError(lastErr, { stage: 'tts', attempts: attempt + 1 });
      const errName = safeErrName(lastErr);
      console.warn(
        '[Lecture] TTS attempt failed:',
        JSON.stringify({
          attempt: attempt + 1,
          elapsedMs,
          loopDelayMaxMs,
          errName,
          code: classified.code,
        })
      );
      if (!retryableFor(classified.code) || attempt === 2) {
        throw lastErr;
      }
      const delayMs = 1500 * (attempt + 1);
      await withAbort(sleepFn(delayMs, signal), signal);
    }
  }
  throw lastErr;
}

async function synthesize(
  ai: GoogleGenAI,
  engine: 'gemini' | 'elevenlabs',
  text: string,
  twoSpeakers: boolean,
  signal?: AbortSignal
): Promise<Pcm> {
  if (engine === 'elevenlabs') {
    try {
      return await synthesizeElevenLabs(text, twoSpeakers);
    } catch (err: any) {
      console.warn('[Lecture] ElevenLabs unavailable, falling back to Gemini TTS:', err?.message);
    }
  }
  return synthesizeGemini(ai, text, twoSpeakers, signal);
}

function resample(p: Pcm, rate: number): Buffer {
  if (p.rate === rate) return p.data;
  // simple nearest-neighbour resample (all Gemini TTS output is 24kHz in practice)
  const inSamples = Math.floor(p.data.length / 2);
  const outSamples = Math.floor((inSamples * rate) / p.rate);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const src = Math.min(inSamples - 1, Math.floor((i * p.rate) / rate));
    out.writeInt16LE(p.data.readInt16LE(src * 2), i * 2);
  }
  return out;
}

function wavFromPcm(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function pruneSegmentCache(uid: string, keepDate: string, keepFp: string): void {
  try {
    const segRoot = path.join(userDir(uid), 'segcache');
    if (!fs.existsSync(segRoot)) return;
    for (const d of fs.readdirSync(segRoot)) {
      const datePath = path.join(segRoot, d);
      if (d !== keepDate) {
        fs.rmSync(datePath, { recursive: true, force: true });
        continue;
      }
      if (!fs.statSync(datePath).isDirectory()) continue;
      for (const f of fs.readdirSync(datePath)) {
        if (f !== keepFp) {
          fs.rmSync(path.join(datePath, f), { recursive: true, force: true });
        }
      }
    }
  } catch {
    // best-effort pruning
  }
}

async function runJob(
  ai: GoogleGenAI,
  state: LectureState,
  newList: LectureMistakeInput[],
  reviewList: LectureMistakeInput[],
  ctx?: LectureJobContext,
  hooks?: {
    generateScriptFn?: LectureGenerateScriptFn;
    synthesizeFn?: LectureSynthesizeFn;
    encodeFn?: LectureEncodeFn;
  }
): Promise<void> {
  const write = ctx?.write || writeLectureState;
  let script: {
    title: string;
    items: LectureScriptItem[];
    coachNote: string;
    tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  try {
    script = await (hooks?.generateScriptFn || generateScript)(
      ai,
      state.date,
      newList,
      reviewList,
      ctx?.signal
    );
  } catch (err) {
    throw attachErrorMeta(err, { stage: 'script', attempts: 0, completed: 0, total: 0 });
  }
  if (ctx?.billable) ctx.billable.calls += 1;
  if (ctx && (ctx.signal.aborted || !isCurrentJob(ctx.key, ctx.epoch))) return;
  state.title = script.title;
  state.script = script.items;
  state.coachNote = script.coachNote;
  state.itemCount = script.items.length;
  state.newMistakeIds = script.items.filter((it) => it.kind === 'new').map((it) => it.mistakeId);
  state.reviewMistakeIds = script.items.filter((it) => it.kind === 'review').map((it) => it.mistakeId);
  state.textTokens = script.tokens;
  if (typeof script.inputTokens === 'number') state.textInputTokens = script.inputTokens;
  if (typeof script.outputTokens === 'number') state.textOutputTokens = script.outputTokens;
  write(state);

  await renderAndSaveAudio(ai, state, script, hooks?.synthesizeFn, ctx, hooks?.encodeFn);
}

export interface SegmentSynthTracker {
  synth: (segKey: string | number, text: string, two: boolean) => Promise<Buffer>;
  billedSamples: () => number;
  billedChars: () => number;
}

/**
 * Wraps segment TTS synthesis with disk cache and counts only cache-miss samples/chars as billed TTS.
 */
export function createCachedSegmentSynth(opts: {
  segDir: string;
  rate: number;
  synthOne: (text: string, two: boolean) => Promise<LecturePcm>;
  onMiss?: () => void;
  onHit?: (segKey: string | number) => void;
}): SegmentSynthTracker {
  let samples = 0;
  let chars = 0;
  const synth = async (segKey: string | number, text: string, two: boolean): Promise<Buffer> => {
    const hash = crypto
      .createHash('sha256')
      .update(`${two ? 2 : 1}|${text}`)
      .digest('hex')
      .slice(0, 16);
    const filePath = path.join(opts.segDir, `${segKey}-${hash}.pcm`);
    try {
      if (fs.existsSync(filePath)) {
        const cached = fs.readFileSync(filePath);
        if (cached.length > 0 && cached.length % 2 === 0) {
          opts.onHit?.(segKey);
          return cached;
        }
      }
    } catch {
      // ignore cache read failures and re-synthesize
    }
    const pcm = resample(await opts.synthOne(text, two), opts.rate);
    opts.onMiss?.();
    samples += Math.floor(pcm.length / 2);
    chars += text.length;
    const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    try {
      fs.mkdirSync(opts.segDir, { recursive: true });
      fs.writeFileSync(tmpPath, pcm);
      fs.renameSync(tmpPath, filePath);
    } catch (err: any) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      console.warn('[Lecture] segment cache write failed:', err?.name || 'error');
    }
    return pcm;
  };
  return {
    synth,
    billedSamples: () => samples,
    billedChars: () => chars,
  };
}

async function renderAndSaveAudio(
  ai: GoogleGenAI,
  state: LectureState,
  script: { title: string; items: LectureScriptItem[]; coachNote: string },
  synthesizeFn?: LectureSynthesizeFn,
  ctx?: LectureJobContext,
  encodeFn?: LectureEncodeFn
): Promise<void> {
  const write = ctx?.write || writeLectureState;
  const RATE = DURATION_RATE;
  const synth = synthesizeFn || synthesize;
  const ensureCurrent = () => {
    if (ctx && (ctx.signal.aborted || !isCurrentJob(ctx.key, ctx.epoch))) {
      throw new Error('lecture job superseded');
    }
  };

  const title = stripSpeechDirections(script.title || '') || '오늘 아침 강의';
  const coachNote = normalizeCoachNote(script.coachNote || '');
  state.coachNote = coachNote;
  const items = script.items.map(cleanLectureScriptItem);
  const plan = buildLectureSpeechPlan(title, items, coachNote, state.date);

  const fp = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        model: LECTURE_TTS_MODEL,
        voices: [VOICE_COACH, VOICE_PARTNER],
        style: TTS_STYLE,
        engine: state.ttsEngine,
        rate: RATE,
        plan: plan.map((s) =>
          s.kind === 'speech' ? ['s', s.role ?? '', s.itemIndex ?? -1, s.two ? 1 : 0, s.text] : ['q', s.sec]
        ),
      })
    )
    .digest('hex')
    .slice(0, 24);
  pruneSegmentCache(state.uid, state.date, fp);
  const segDir = path.join(userDir(state.uid), 'segcache', safeDate(state.date), fp);

  const hitSegs = new Set<string | number>();
  const segSynth = createCachedSegmentSynth({
    segDir,
    rate: RATE,
    synthOne: (text, two) => synth(ai, state.ttsEngine, text, two, ctx?.signal),
    onMiss: () => {
      if (ctx?.billable) ctx.billable.calls += 1;
    },
    onHit: (segKey) => {
      hitSegs.add(segKey);
    },
  });
  const cachedSynth = segSynth.synth;

  const speechTotal = plan.filter((s) => s.kind === 'speech').length;
  let speechDone = 0;
  let chars = 0;
  state.audioProgress = { completed: 0, total: speechTotal };
  write(state);

  const pcmParts: Buffer[] = new Array(plan.length);
  let cursor = 0;
  let aborted = false;
  let firstErr: unknown = null;
  const workers = Math.min(2, speechTotal || 1);
  const worker = async () => {
    while (!aborted) {
      if (ctx && (ctx.signal.aborted || !isCurrentJob(ctx.key, ctx.epoch))) {
        aborted = true;
        if (!firstErr) firstErr = new Error('lecture job superseded');
        return;
      }
      const i = cursor++;
      if (i >= plan.length) return;
      const seg = plan[i];
      if (seg.kind === 'silence') {
        pcmParts[i] = Buffer.alloc(Math.round(seg.sec * RATE) * 2);
        continue;
      }
      chars += seg.text.length;
      const segStart = Date.now();
      try {
        pcmParts[i] = await cachedSynth(i, seg.text, seg.two);
      } catch (err) {
        aborted = true;
        if (!firstErr) {
          const segElapsedMs = Math.max(0, Math.round(Date.now() - segStart));
          firstErr = attachErrorMeta(err, {
            stage: 'tts',
            attempts: 1,
            completed: speechDone,
            total: speechTotal,
            segIndex: i,
            segChars: seg.text.length,
            segElapsedMs,
          });
        }
        return;
      }
      const elapsedMs = Math.max(0, Math.round(Date.now() - segStart));
      console.log(
        '[Lecture] TTS segment ok:',
        JSON.stringify({
          segIndex: i,
          segChars: seg.text.length,
          elapsedMs,
          cached: hitSegs.has(i),
        })
      );
      speechDone += 1;
      state.audioProgress = { completed: speechDone, total: speechTotal };
      state.updatedAt = new Date().toISOString();
      write(state);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (firstErr) throw firstErr;
  ensureCurrent();

  // Map synthesized speech segments into MeasuredLecture for N1 duration fitting
  let openingBuf: Buffer = Buffer.alloc(0);
  let closingBuf: Buffer = Buffer.alloc(0);
  const bodyByItem = new Map<number, Buffer>();
  const answerByItem = new Map<number, Buffer>();
  const bodyCharsByItem = new Map<number, number>();
  const answerCharsByItem = new Map<number, number>();
  let speechChars = 0;
  let speechSamples = 0;

  for (let i = 0; i < plan.length; i++) {
    const seg = plan[i];
    if (seg.kind !== 'speech') continue;
    const buf = pcmParts[i];
    speechChars += seg.text.length;
    speechSamples += Math.floor(buf.length / 2);
    if (seg.role === 'opening') {
      openingBuf = buf;
    } else if (seg.role === 'closing') {
      closingBuf = buf;
    } else if (seg.role === 'body' && typeof seg.itemIndex === 'number') {
      bodyByItem.set(seg.itemIndex, buf);
      bodyCharsByItem.set(seg.itemIndex, seg.text.length);
    } else if (seg.role === 'answer' && typeof seg.itemIndex === 'number') {
      answerByItem.set(seg.itemIndex, buf);
      answerCharsByItem.set(seg.itemIndex, seg.text.length);
    }
  }

  const measuredItems: MeasuredLectureItem[] = items.map((it, idx) => ({
    index: idx,
    kind: it.kind,
    bodySamples: Math.floor((bodyByItem.get(idx)?.length || 0) / 2),
    answerSamples: Math.floor((answerByItem.get(idx)?.length || 0) / 2),
    bodyChars: bodyCharsByItem.get(idx) || 0,
    answerChars: answerCharsByItem.get(idx) || 0,
  }));
  const measured: MeasuredLecture = {
    openingSamples: Math.floor(openingBuf.length / 2),
    closingSamples: Math.floor(closingBuf.length / 2),
    items: measuredItems,
    speechChars,
    speechSamples,
    recapChars: buildRecapText(items).length,
  };

  let fitRes: ReturnType<typeof fitLectureTimeline>;
  let pcm: Buffer;
  let bodyStartSecByItem: Map<number, number>;
  try {
    fitRes = fitLectureTimeline(measured);
    let recapBuf: Buffer | undefined;
    let drillIntroBuf: Buffer | undefined;
    const extras: Extras = {};

    const synthExtraWithRetry = async (segKey: 'recap' | 'drill', text: string): Promise<Buffer | null> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        ensureCurrent();
        try {
          return await cachedSynth(segKey, text, false);
        } catch (err) {
          if (ctx && (ctx.signal.aborted || !isCurrentJob(ctx.key, ctx.epoch))) throw err;
          if (!retryableFor(classifyLectureAudioError(err, { stage: 'tts' }).code)) return null;
          if (attempt === 1) return null;
        }
      }
      return null;
    };

    if (fitRes.want === 'recap') {
      const keptSet = new Set(fitRes.keptItems);
      const recapText = buildRecapText(items.filter((_, idx) => keptSet.has(idx)));
      const buf = await synthExtraWithRetry('recap', recapText);
      if (buf) {
        recapBuf = buf;
        chars += recapText.length;
        extras.recap = Math.floor(buf.length / 2);
      } else {
        extras.recap = 'failed';
      }
      fitRes = fitLectureTimeline(measured, extras);
    } else if (fitRes.want === 'drillIntro') {
      ensureCurrent();
      const buf = await synthExtraWithRetry('drill', DRILL_INTRO_TEXT);
      if (buf) {
        drillIntroBuf = buf;
        chars += DRILL_INTRO_TEXT.length;
        extras.drillIntro = Math.floor(buf.length / 2);
      } else {
        extras.drillIntro = 'failed';
      }
      fitRes = fitLectureTimeline(measured, extras);
    }

    ensureCurrent();
    if (fitRes.want) {
      throw new Error('duration fit did not converge');
    }
    const assembled = assembleLecturePcm(
      fitRes.timeline,
      {
        opening: openingBuf,
        closing: closingBuf,
        recap: recapBuf,
        drillIntro: drillIntroBuf,
        bodyByItem,
        answerByItem,
      },
      fitRes.totalSamples,
      RATE
    );
    pcm = assembled.pcm;
    bodyStartSecByItem = assembled.bodyStartSecByItem;
    const extraFailed = extras.recap === 'failed' || extras.drillIntro === 'failed';
    const assembledSec = Math.floor(pcm.length / 2) / RATE;
    if (extraFailed && assembledSec < LECTURE_MIN_SEC) {
      console.warn(`[Lecture] duration under 6:00 after recap/drill TTS failure: ${assembledSec.toFixed(1)}s`);
    }
  } catch (err) {
    throw attachErrorMeta(err, { stage: 'fit', attempts: 0, completed: speechDone, total: speechTotal });
  }
  const keptItems = fitRes.keptItems.map((origIdx) => ({
    ...items[origIdx],
    startSec: bodyStartSecByItem.get(origIdx),
  }));

  let encoded: Awaited<ReturnType<LectureEncodeFn>>;
  try {
    encoded = await (encodeFn || encodeLectureAudio)(pcm, RATE);
  } catch (err) {
    throw attachErrorMeta(err, { stage: 'encode', attempts: 0, completed: speechDone, total: speechTotal });
  }
  ensureCurrent();
  const fileName = `${state.date}.${encoded.ext}`;
  const dir = userDir(state.uid);
  const finalPath = path.join(dir, fileName);
  const tmpPath = path.join(dir, `${fileName}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmpPath, encoded.buffer);
    fs.renameSync(tmpPath, finalPath);
    removeLegacyAudioFiles(dir, state.date, fileName);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw attachErrorMeta(err, { stage: 'save', attempts: 0, completed: speechDone, total: speechTotal });
  }
  state.script = keptItems;
  state.itemCount = keptItems.length;
  state.newMistakeIds = keptItems.filter((it) => it.kind === 'new').map((it) => it.mistakeId);
  state.reviewMistakeIds = keptItems.filter((it) => it.kind === 'review').map((it) => it.mistakeId);
  state.chars = chars;
  state.ttsAudioSec = Math.round((segSynth.billedSamples() / RATE) * 10) / 10;
  state.ttsAudioChars = segSynth.billedChars();
  state.durationSec = Math.round(fitRes.totalSamples / RATE);
  state.durationFit = fitRes.fit;
  state.audioBackupId = crypto.randomUUID();
  state.audioFile = fileName;
  state.audioMime = encoded.mime;
  state.status = 'ready';
  state.audioStatus = 'ready';
  state.audioProgress = { completed: speechTotal, total: speechTotal };
  delete state.error;
  delete state.audioError;
  delete state.audioRetryAfter;
  delete state.audioChunks;
  delete state.audioBackup;
  delete state.audioRebuildStartedAt;
  delete state.audioRebuildFailedAt;
  write(state);
  try {
    fs.rmSync(path.join(userDir(state.uid), 'segcache', state.date), { recursive: true, force: true });
  } catch {
    // best-effort: the ready audio file is the source of truth
  }
}
