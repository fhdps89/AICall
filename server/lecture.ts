/**
 * B-7 Morning Lecture generator (server side).
 * - Script: gemini-3.8-flash with responseSchema
 * - Voice: gemini-3.8-flash-tts, 2 speakers (Coach / Partner), raw PCM per segment
 * - Concatenate PCM, insert 3s silence before each answer, save one WAV file
 * - Jobs run in the background; state is persisted under .data/lectures/{uid}/{date}.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import { TEXT_MODEL, GEMINI_TTS_MODEL } from '../src/config/models.ts';
import { stripSpeechDirections, cleanLectureScriptItem } from './speechText.ts';
import { encodeLectureAudio, mimeForAudioFile, type LectureEncodeFn } from './lectureAudioEncode.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, '..', '.data');
const LECTURE_DIR = path.join(DATA_DIR, 'lectures');

const SCRIPT_MODEL = TEXT_MODEL;
const LECTURE_TTS_MODEL = GEMINI_TTS_MODEL;
const VOICE_COACH = 'Kore';
const VOICE_PARTNER = 'Puck';
const SILENCE_SEC = 3;
const MAX_NEW = 6;
const MAX_REVIEW = 3;

/** Whole job (script + TTS). A hung Gemini call must not leave status=generating all day. */
export const LECTURE_JOB_TIMEOUT_MS = 15 * 60 * 1000;
/** One generateContent call (script or one TTS segment). Lets the 3-try loop actually retry. */
export const LECTURE_STEP_TIMEOUT_MS = 90 * 1000;

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

export interface LectureMistakeInput {
  id: string;
  myPhrase: string;
  naturalPhrase: string;
  reason?: string;
}

export interface LectureScriptItem {
  mistakeId: string;
  kind: 'new' | 'review';
  myPhrase: string;
  naturalPhrase: string;
  explanation: string;
  dialogue: { speaker: 'Coach' | 'Partner'; line: string }[];
  meaningKo: string;
  answerEnglish: string;
  startSec?: number;
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
  ttsEngine: 'gemini' | 'elevenlabs';
  chars?: number;
  textTokens?: number;
  durationSec?: number;
  audioFile?: string; // relative file name inside LECTURE_DIR/{uid}
  audioMime?: string;
  /** Audio generation only. Do not use status=generating for a TTS rebuild of a ready script. */
  audioStatus?: 'ready' | 'rebuilding' | 'missing';
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

export function readLectureState(uid: string, date: string): LectureState | null {
  const file = path.join(userDir(uid), `${safeDate(date)}.json`);
  if (!fs.existsSync(file)) return null;
  let state: LectureState;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  // "generating" but no job is running (the server restarted mid-job): report it as failed so
  // the app offers 「다시 만들기」 and the feed retries, instead of waiting forever.
  if (state.status === 'generating' && !running.has(`${uid}:${date}`)) {
    return { ...state, status: 'failed', error: 'INTERRUPTED' };
  }
  if (state.status === 'ready' && state.audioStatus === 'rebuilding' && !running.has(`${uid}:${date}`)) {
    return { ...state, audioStatus: 'missing', error: 'INTERRUPTED' };
  }
  return state;
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
export const MAX_LECTURE_SCRIPT_ITEMS = MAX_NEW + MAX_REVIEW;

export type LecturePcm = { data: Buffer; rate: number };
export type LectureSynthesizeFn = (
  ai: GoogleGenAI,
  engine: 'gemini' | 'elevenlabs',
  text: string,
  twoSpeakers: boolean
) => Promise<LecturePcm>;

export interface LectureAudioScriptPayload {
  title?: string;
  coachNote?: string;
  script: LectureScriptItem[];
  itemCount?: number;
  newMistakeIds?: string[];
  reviewMistakeIds?: string[];
  ttsEngine?: 'gemini' | 'elevenlabs';
  createdAt?: string;
  textTokens?: number;
}

export type LectureScriptSanitizeResult =
  | { ok: true; payload: LectureAudioScriptPayload }
  | { ok: false; error: string };

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
      ? it.dialogue.slice(0, 4).flatMap((d) => {
          if (!d || typeof d !== 'object') return [];
          const line = d as Record<string, unknown>;
          if (typeof line.line !== 'string') return [];
          const speaker = line.speaker === 'Partner' ? 'Partner' : 'Coach';
          return [{ speaker: speaker as 'Coach' | 'Partner', line: String(line.line).slice(0, 400) }];
        })
      : [];
    items.push({
      mistakeId: String(it.mistakeId).slice(0, 80),
      kind,
      myPhrase: String(it.myPhrase).slice(0, 400),
      naturalPhrase: String(it.naturalPhrase).slice(0, 400),
      explanation: String(it.explanation || '').slice(0, 800),
      dialogue,
      meaningKo: String(it.meaningKo || '').slice(0, 400),
      answerEnglish: String(it.answerEnglish || it.naturalPhrase).slice(0, 400),
      startSec: typeof it.startSec === 'number' && Number.isFinite(it.startSec) ? it.startSec : undefined,
    });
  }
  const ids = (list: unknown) =>
    (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string').map((x) => String(x).slice(0, 80));
  return {
    ok: true,
    payload: {
      title: typeof obj.title === 'string' ? obj.title.slice(0, 80) : undefined,
      coachNote: typeof obj.coachNote === 'string' ? obj.coachNote.slice(0, 1200) : undefined,
      script: items,
      itemCount: items.length,
      newMistakeIds: ids(obj.newMistakeIds),
      reviewMistakeIds: ids(obj.reviewMistakeIds),
      ttsEngine: obj.ttsEngine === 'elevenlabs' ? 'elevenlabs' : 'gemini',
      createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : undefined,
      textTokens: typeof obj.textTokens === 'number' && Number.isFinite(obj.textTokens) ? obj.textTokens : undefined,
    },
  };
}

const rebuildDone = new Map<string, Promise<void>>();

export function lectureRebuildInFlight(uid: string, date: string): Promise<void> | undefined {
  return rebuildDone.get(`${uid}:${date}`);
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
  opts: { synthesizeFn?: LectureSynthesizeFn; encodeFn?: LectureEncodeFn } = {}
): LectureState {
  safeDate(date);
  const key = `${uid}:${date}`;
  const existingPath = lectureAudioPath(uid, date);
  const existing = readLectureState(uid, date);
  if (existingPath && existing) {
    return { ...existing, status: 'ready', audioStatus: 'ready' };
  }
  if (running.has(key) && existing) {
    return { ...existing, audioStatus: 'rebuilding' };
  }

  let scriptItems = existing?.script;
  let title = existing?.title;
  let coachNote = existing?.coachNote;
  let newMistakeIds = existing?.newMistakeIds || [];
  let reviewMistakeIds = existing?.reviewMistakeIds || [];
  let ttsEngine: 'gemini' | 'elevenlabs' = existing?.ttsEngine || 'gemini';
  let createdAt = existing?.createdAt;
  let textTokens = existing?.textTokens;

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
        createdAt: createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
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
    ttsEngine = sanitized.payload.ttsEngine || ttsEngine;
    createdAt = sanitized.payload.createdAt || createdAt;
    textTokens = sanitized.payload.textTokens ?? textTokens;
  }

  if (!scriptItems || scriptItems.length === 0) {
    const st: LectureState = {
      uid,
      date,
      status: existing?.status === 'ready' ? 'ready' : 'failed',
      newMistakeIds,
      reviewMistakeIds,
      ttsEngine,
      createdAt: createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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

  const now = new Date().toISOString();
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
    ttsEngine,
    textTokens,
    createdAt: createdAt || existing?.createdAt || now,
    updatedAt: now,
    audioStatus: 'rebuilding',
  };
  delete state.error;
  delete state.audioFile;
  delete state.audioMime;
  delete state.audioProgress;
  writeLectureState(state);
  running.add(key);
  const done = renderAndSaveAudio(ai, state, { title: state.title || '오늘 아침 강의', items: scriptItems, coachNote: state.coachNote || '' }, opts.synthesizeFn, undefined, opts.encodeFn)
    .catch((err) => {
      console.error('[Lecture] audio rebuild failed:', err);
      state.audioStatus = 'missing';
      state.error = 'GENERATION_FAILED';
      writeLectureState(state);
    })
    .finally(() => {
      running.delete(key);
      rebuildDone.delete(key);
    });
  rebuildDone.set(key, done.then(() => undefined));
  return state;
}

const running = new Set<string>();
const jobEpoch = new Map<string, number>();

export interface LectureJobContext {
  key: string;
  epoch: number;
  write: (state: LectureState) => boolean;
}

function bumpJobEpoch(key: string): number {
  const n = (jobEpoch.get(key) || 0) + 1;
  jobEpoch.set(key, n);
  return n;
}

function isCurrentJob(key: string, epoch: number): boolean {
  return jobEpoch.get(key) === epoch;
}

function writeLectureStateForJob(state: LectureState, key: string, epoch: number): boolean {
  if (!isCurrentJob(key, epoch)) return false;
  writeLectureState(state);
  return true;
}


export interface StartLectureJobOpts {
  force?: boolean;
  /** Test hook: shorten the whole-job cap. */
  jobTimeoutMs?: number;
  /** Called once when the job finishes with status==='ready' and is still the current job. */
  onReady?: (state: LectureState) => void | Promise<void>;
  /** Test hook: replace script+TTS so tests do not call Gemini. */
  runJobFn?: (
    ai: GoogleGenAI,
    state: LectureState,
    newList: LectureMistakeInput[],
    reviewList: LectureMistakeInput[],
    ctx: LectureJobContext
  ) => Promise<void>;
}

/**
 * Restore a ready lecture from backup by bumping the job epoch (so any stale job cannot overwrite)
 * and re-rendering TTS audio from the backed-up script. Skips when a job is already running.
 */
export function restoreReadyLecture(
  ai: GoogleGenAI,
  uid: string,
  date: string,
  backup: LectureState,
  opts: { synthesizeFn?: LectureSynthesizeFn; encodeFn?: LectureEncodeFn } = {}
): LectureState | null {
  safeDate(date);
  const key = `${uid}:${date}`;
  if (running.has(key)) {
    return readLectureState(uid, date);
  }
  if (!backup || backup.status !== 'ready' || !Array.isArray(backup.script) || backup.script.length === 0) {
    return readLectureState(uid, date);
  }
  bumpJobEpoch(key);
  return startLectureAudioRebuild(ai, uid, date, backup, opts);
}

/**
 * Start (or return existing) lecture job. Never regenerates a ready lecture unless force=true.
 * A job that is still in memory is reused, even with force=true, until it finishes or hits the timeout.
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
  const existing = readLectureState(uid, date);
  if (existing && (running.has(key) || (existing.status === 'ready' && !opts.force))) {
    return existing;
  }
  const clean = (list: LectureMistakeInput[], max: number) =>
    (Array.isArray(list) ? list : [])
      .filter((m) => m && typeof m.id === 'string' && m.myPhrase && m.naturalPhrase)
      .slice(0, max)
      .map((m) => ({
        id: String(m.id),
        myPhrase: String(m.myPhrase).slice(0, 400),
        naturalPhrase: String(m.naturalPhrase).slice(0, 400),
        reason: String(m.reason || '').slice(0, 600),
      }));
  const newList = clean(newMistakes, MAX_NEW);
  const reviewList = clean(reviewMistakes, MAX_REVIEW).filter((r) => !newList.some((n) => n.id === r.id));

  const engine = process.env.LECTURE_TTS_ENGINE === 'elevenlabs' ? 'elevenlabs' : 'gemini';
  const now = new Date().toISOString();
  const state: LectureState = {
    uid,
    date,
    status: 'generating',
    newMistakeIds: newList.map((m) => m.id),
    reviewMistakeIds: reviewList.map((m) => m.id),
    ttsEngine: engine,
    createdAt: now,
    updatedAt: now,
  };
  if (newList.length + reviewList.length === 0) {
    state.status = 'failed';
    state.error = 'NOTHING_TO_TEACH';
    writeLectureState(state);
    return state;
  }
  const epoch = bumpJobEpoch(key);
  const ctx: LectureJobContext = {
    key,
    epoch,
    write: (st) => writeLectureStateForJob(st, key, epoch),
  };
  ctx.write(state);
  running.add(key);
  const work = (opts.runJobFn || runJob)(ai, state, newList, reviewList, ctx);
  const timeoutMs = opts.jobTimeoutMs ?? LECTURE_JOB_TIMEOUT_MS;
  withTimeout(work, timeoutMs, 'lecture job')
    .then(
      async () => {
        if (!isCurrentJob(key, epoch)) return;
        if (state.status !== 'ready') return;
        if (!opts.onReady) return;
        try {
          await opts.onReady(state);
        } catch (err: any) {
          console.warn('[Lecture] onReady failed:', err?.message || err);
        }
      },
      (err) => {
        if (!isCurrentJob(key, epoch)) return;
        console.error('[Lecture] job failed:', err);
        state.status = 'failed';
        // Shown in the app and on the public feed page: a code only, details stay in the log.
        state.error = /timed out/i.test(String(err?.message || err)) ? 'TIMED_OUT' : 'GENERATION_FAILED';
        ctx.write(state);
      }
    )
    .finally(() => {
      if (isCurrentJob(key, epoch)) running.delete(key);
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
  reviewList: LectureMistakeInput[]
): Promise<{ title: string; items: LectureScriptItem[]; coachNote: string; tokens: number }> {
  const sunday = isSundayKst(date);
  const fmt = (list: LectureMistakeInput[], kind: string) =>
    list
      .map((m) => `- id=${m.id} | kind=${kind} | myPhrase="${m.myPhrase}" | naturalPhrase="${m.naturalPhrase}" | reason="${m.reason || ''}"`)
      .join('\n');

  const prompt = `당신은 한국인 성인 학습자를 위한 5분짜리 아침 영어 오디오 강의 작가입니다.
아래 실수 목록으로 강의 대본을 만드세요. 해설자는 "Coach"(한국어로 설명), 대화 상대는 "Partner"(영어 원어민)입니다.

[실수 목록]
${fmt(newList, 'new')}
${fmt(reviewList, 'review')}

[대본 규칙 - 반드시 지킬 것]
1. 영어는 영어 철자 그대로 쓰세요. 영어를 한글 발음으로 적지 마세요(예: "땡큐" 금지, "thank you"로).
2. 항목마다 순서: 어젯밤 하신 말(myPhrase, 입력 그대로, 고치지 말 것) → 자연스러운 표현(naturalPhrase) → 이유 1~2문장(explanation, 한국어) → 짧은 2인 대화(dialogue, 2~4줄, Coach와 Partner가 번갈아 영어로, naturalPhrase가 자연스럽게 들어감) → 한국어 뜻(meaningKo, naturalPhrase의 한국어 뜻) → 정답 영어(answerEnglish = naturalPhrase). 한국어 뜻과 정답 사이의 무음은 시스템이 따로 넣으니, 대본에는 무음·쉼·초 표시를 쓰지 마세요.
3. 입력 목록 순서대로, 각 항목의 mistakeId와 kind는 입력 값 그대로 쓰세요. 항목을 빼거나 합치지 마세요.
4. 전체 분량은 5분 이내가 되도록 explanation과 dialogue를 짧게 유지하세요.
5. title: 오늘 강의 제목(한국어, 20자 이내).
6. coachNote: 끝에 코치 한마디(한국어 2~3문장).${sunday ? ' 오늘은 일요일이므로 한 주를 총정리하는 주간 리뷰 톤으로 쓰세요. 이번 주 완수한 수업 진도와 누적 복습/졸업 표현 성과를 짚어주고 다음 주 실전 통화를 응원하는 따뜻하고 구체적인 코칭 메시지로 작성하세요.' : ''}
7. 시험·교재의 상표나 문제를 복제하지 마세요.
8. 모든 문자열 값은 음성 합성기가 글자 그대로 소리 내어 읽습니다. 실제로 말할 문장만 쓰세요. 다음은 쓰지 마세요: ① 괄호나 대괄호로 된 연기·동작·효과 지시(예: (pause), (웃으며), [Coach smiles], (3초 무음)) ② "Narrator:", "내레이션:" 같은 해설자 줄 ③ "Say cheerfully:" 같은 말투 지시 ④ 마크다운 기호(**, *, \`, #, 목록 기호). dialogue.line에는 화자 이름을 붙이지 말고 대사만 쓰세요(화자는 speaker 필드에 씁니다). 뜻을 덧붙이는 괄호는 써도 됩니다(예: work for (소속)).`;

  const response = await withTimeout(ai.models.generateContent({
    model: SCRIPT_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
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
              },
              required: ['mistakeId', 'kind', 'myPhrase', 'naturalPhrase', 'explanation', 'dialogue', 'meaningKo', 'answerEnglish'],
            },
          },
          coachNote: { type: Type.STRING },
        },
        required: ['title', 'items', 'coachNote'],
      },
    },
  }), LECTURE_STEP_TIMEOUT_MS, 'lecture script');
  const parsed = JSON.parse(response.text?.trim() || '{}');
  const inputs = new Map([...newList, ...reviewList].map((m) => [m.id, m]));
  const items: LectureScriptItem[] = (parsed.items || [])
    .filter((it: any) => inputs.has(it.mistakeId))
    .map((it: any) => {
      const src = inputs.get(it.mistakeId)!;
      return {
        ...it,
        // myPhrase must stay verbatim (never let the model "fix" it)
        myPhrase: src.myPhrase,
        naturalPhrase: src.naturalPhrase,
        answerEnglish: it.answerEnglish || src.naturalPhrase,
        dialogue: Array.isArray(it.dialogue) ? it.dialogue.slice(0, 4) : [],
      };
    });
  if (items.length === 0) throw new Error('대본 생성 결과가 비어 있습니다.');
  return {
    title: stripSpeechDirections(String(parsed.title || '')) || '오늘 아침 강의',
    items: items.map(cleanLectureScriptItem),
    coachNote: stripSpeechDirections(String(parsed.coachNote || '')),
    tokens: Number(response.usageMetadata?.totalTokenCount || 0),
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

async function synthesizeGemini(ai: GoogleGenAI, text: string, twoSpeakers: boolean): Promise<Pcm> {
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
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await withTimeout(ai.models.generateContent({
        model: LECTURE_TTS_MODEL,
        contents: [{ role: 'user', parts: toSpeechParts(text, twoSpeakers) }],
        config: { responseModalities: ['AUDIO'], speechConfig },
      }), LECTURE_STEP_TIMEOUT_MS, 'lecture TTS');
      const part = response.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
      if (!part?.inlineData?.data) throw new Error('TTS 음성 데이터 없음');
      return parseAudio(part.inlineData.data, part.inlineData.mimeType || '');
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function synthesize(ai: GoogleGenAI, engine: 'gemini' | 'elevenlabs', text: string, twoSpeakers: boolean): Promise<Pcm> {
  if (engine === 'elevenlabs') {
    try {
      return await synthesizeElevenLabs(text, twoSpeakers);
    } catch (err: any) {
      console.warn('[Lecture] ElevenLabs unavailable, falling back to Gemini TTS:', err?.message);
    }
  }
  return synthesizeGemini(ai, text, twoSpeakers);
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

async function runJob(
  ai: GoogleGenAI,
  state: LectureState,
  newList: LectureMistakeInput[],
  reviewList: LectureMistakeInput[],
  ctx?: LectureJobContext
): Promise<void> {
  const write = ctx?.write || writeLectureState;
  const script = await generateScript(ai, state.date, newList, reviewList);
  if (ctx && !isCurrentJob(ctx.key, ctx.epoch)) return;
  state.title = script.title;
  state.coachNote = script.coachNote;
  state.itemCount = script.items.length;
  state.textTokens = script.tokens;
  write(state);

  await renderAndSaveAudio(ai, state, script, undefined, ctx);
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
  const RATE = 24000;
  const synth = synthesizeFn || synthesize;

  const title = stripSpeechDirections(script.title || '') || '오늘 아침 강의';
  const coachNote = stripSpeechDirections(script.coachNote || '');
  const items = script.items.map(cleanLectureScriptItem);

  type PlanSeg =
    | { kind: 'speech'; text: string; two: boolean; itemIndex?: number }
    | { kind: 'silence'; sec: number };
  const plan: PlanSeg[] = [];
  plan.push({
    kind: 'speech',
    text: `Coach: 좋은 아침이에요. 오늘 아침 강의, ${title}. 모두 ${items.length}개 표현을 함께 볼게요.`,
    two: false,
  });
  plan.push({ kind: 'silence', sec: 0.6 });

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const label = it.kind === 'review' ? '복습 표현' : '새 표현';
    const body = [
      `Coach: ${i + 1}번, ${label}이에요. 어젯밤 하신 말은 "${it.myPhrase}" 였어요.`,
      `Coach: 자연스러운 표현은 "${stripSpeechDirections(it.naturalPhrase)}" 입니다. ${it.explanation}`,
      `Coach: 짧은 대화로 들어 볼게요.`,
      ...it.dialogue.map((d) => `${d.speaker === 'Partner' ? 'Partner' : 'Coach'}: ${d.line}`),
      `Coach: 한국어 뜻은 "${it.meaningKo}". 영어로 말해 보세요.`,
    ].join('\n');
    plan.push({ kind: 'speech', text: body, two: true, itemIndex: i });
    plan.push({ kind: 'silence', sec: SILENCE_SEC });
    plan.push({ kind: 'speech', text: `Coach: ${it.answerEnglish}`, two: false });
    plan.push({ kind: 'silence', sec: 0.8 });
  }
  if (coachNote) {
    plan.push({ kind: 'speech', text: `Coach: 오늘의 코치 한마디. ${coachNote}`, two: false });
  }

  const speechTotal = plan.filter((s) => s.kind === 'speech').length;
  let speechDone = 0;
  let chars = 0;
  state.audioProgress = { completed: 0, total: speechTotal };
  write(state);

  const pcmParts: Buffer[] = new Array(plan.length);
  let cursor = 0;
  let aborted = false;
  const workers = Math.min(2, speechTotal || 1);
  const worker = async () => {
    while (!aborted) {
      if (ctx && !isCurrentJob(ctx.key, ctx.epoch)) {
        aborted = true;
        throw new Error('lecture job superseded');
      }
      const i = cursor++;
      if (i >= plan.length) return;
      const seg = plan[i];
      if (seg.kind === 'silence') {
        pcmParts[i] = Buffer.alloc(Math.round(seg.sec * RATE) * 2);
        continue;
      }
      chars += seg.text.length;
      try {
        pcmParts[i] = resample(await synth(ai, state.ttsEngine, seg.text, seg.two), RATE);
      } catch (err) {
        aborted = true;
        throw err;
      }
      if (aborted) return;
      speechDone += 1;
      state.audioProgress = { completed: speechDone, total: speechTotal };
      state.updatedAt = new Date().toISOString();
      write(state);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (ctx && !isCurrentJob(ctx.key, ctx.epoch)) throw new Error('lecture job superseded');

  let totalBytes = 0;
  for (let i = 0; i < plan.length; i++) {
    const seg = plan[i];
    if (seg.kind === 'speech' && typeof seg.itemIndex === 'number') {
      items[seg.itemIndex].startSec = Math.round((totalBytes / 2 / RATE) * 10) / 10;
    }
    totalBytes += pcmParts[i].length;
  }

  const pcm = Buffer.concat(pcmParts);
  const encoded = await (encodeFn || encodeLectureAudio)(pcm, RATE);
  const fileName = `${state.date}.${encoded.ext}`;
  const dir = userDir(state.uid);
  const finalPath = path.join(dir, fileName);
  const tmpPath = path.join(dir, `${fileName}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmpPath, encoded.buffer);
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  removeLegacyAudioFiles(dir, state.date, fileName);
  state.script = items;
  state.chars = chars;
  state.durationSec = Math.round(pcm.length / 2 / RATE);
  state.audioFile = fileName;
  state.audioMime = encoded.mime;
  state.status = 'ready';
  state.audioStatus = 'ready';
  state.audioProgress = { completed: speechTotal, total: speechTotal };
  delete state.error;
  write(state);
}
