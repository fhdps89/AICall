import express from 'express';
import type { Request, Response } from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Type } from '@google/genai';
import { requireAuth, verifyFirebaseIdToken, setAfterAuthHook } from './server/auth.ts';
import { ensureUserGeminiKey, getUserSuppliedKey } from './server/userKey.ts';
import { saveFeedBackup, deleteFeedBackup, persistLectureBackups, saveLectureFailureBackup, createFeedGenRemote } from './server/feedStore.ts';
import { geminiLimit, clusterLimit, checkLiveSessionStart } from './server/rateLimit.ts';
import { DATA_DIR, startLectureJob, startLectureAudioRebuild, readLectureState, lectureAudioPath, lectureHasLocalScript, lectureStatusPayload, recordLectureBackupResult, kstToday, LECTURE_AUDIO_MISSING, LECTURE_AUDIO_SCRIPT_MISSING, LECTURE_AUDIO_REBUILD_TIMED_OUT, LECTURE_GEN_SKIPPED } from './server/lecture.ts';
import type { LectureState } from './server/lecture.ts';
import { sanitizeLectureInputs } from './server/lectureMaterial.ts';
import { mimeForAudioFile } from './server/lectureAudioEncode.ts';
import { computeMistakeClusters, validateClusterRequestBody } from './server/mistakeClusters.ts';
import { runLectureSupplement } from './server/lectureSupplement.ts';
import { tokensFromUsageMetadata, sanitizeLiveUsageMetadata } from './server/usageMeta.ts';
import { preferredUserTranscript, buildUserCorpus } from './src/services/lecture/lectureSource.ts';
import { assemblyAvailable, transcribeGemini, transcribeAssembly, transcribeLive } from './server/sttBench.ts';
import { LIVE_MODEL, TEXT_MODEL, GEMINI_STT_MODEL, GEMINI_TTS_LITE_MODEL } from './src/config/models.ts';
import { LIVE_LANGUAGE_CODE, normalizeVoiceName } from './src/config/voices.ts';
import { buildLiveConfigAttempts } from './server/liveConfig.ts';
import { userRecordingPath as userRecordingPathIn } from './server/recordingPath.ts';
import { apiError, noKey, NO_KEY_MESSAGE } from './server/errors.ts';
import { buildProgressProposal, finalizeCoachProgressResponse, sanitizeTodayGoalId, type CoachProgressChatOut } from './src/data/progressAdjust.ts';
import { sanitizePlanChangeAfter, isEmptyPlanChange, normalizeLessonsPerCall } from './src/data/planValidation.ts';
import {
  MAX_STORAGE_FILE_BYTES,
  STORAGE_FETCH_TIMEOUT_MS,
  StorageFileTooLargeError,
  firebaseAuthHeader,
  isValidDownloadToken,
  readStorageBucket,
  readStreamWithLimit,
  relayContentType,
  relayErrorFor,
  storageMediaUrl,
  storageObjectPath,
} from './server/storageRelay.ts';
import { isValidFeedSecret, writeFeedSync, loadFeedForSecret, feedForUid, ensureTodayLecture, buildFeedToday, buildFeedDiag, maybeAutoRegenerateToday, feedAudioFile, renderFeedHtml, publicFeedBaseUrl } from './server/feed.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// First hop is the Cloud Run / AI Studio proxy that terminates TLS.
app.set('trust proxy', 1);
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isProd = process.env.NODE_ENV === 'production';

// CORS: no cross-origin access needed (SPA is same-origin; feed is fetched server-to-server),
// so no Access-Control-Allow-Origin header is ever sent.
app.disable('x-powered-by');
app.use((_req: Request, res: Response, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Feed URLs carry the secret in the path: never send them on as a referrer.
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '10mb' }));

// Model names come from the single config file (Part B-1: src/config/models.ts).
const LIVE_MODELS: string[] = [LIVE_MODEL];
const NATIVE_AUDIO_MODEL: string = LIVE_MODEL;
// Server-side Live connect timeout; shorter than the client's proxy ready timeout.
const LIVE_CONNECT_TIMEOUT_MS = 10000;
const FALLBACK_CHAT_MODEL = TEXT_MODEL;
const FALLBACK_TTS_MODEL = GEMINI_TTS_LITE_MODEL;
const TRANSCRIBE_MODEL = GEMINI_STT_MODEL;

// Dynamic Build Version tracking mtime in KST
export function getBuildVersion(): string {
  try {
    const stat = fs.statSync(__filename);
    const mtime = new Date(stat.mtime.getTime() + 9 * 3600000); // KST
    const Y = mtime.getUTCFullYear();
    const M = String(mtime.getUTCMonth() + 1).padStart(2, '0');
    const D = String(mtime.getUTCDate()).padStart(2, '0');
    const h = String(mtime.getUTCHours()).padStart(2, '0');
    const m = String(mtime.getUTCMinutes()).padStart(2, '0');
    return `${Y}${M}${D}-multilingual-${h}${m}`;
  } catch {
    return '20261013-multilingual-1633';
  }
}

// Resolve real Gemini API key from environment, file, or parent container
// Names AI Studio / Cloud Run / SDK conventions may use for the Gemini key.
const GEMINI_KEY_NAMES = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'API_KEY', 'GOOGLE_GENAI_API_KEY', 'VITE_GEMINI_API_KEY'];
let lastKeySource: string = 'none';
let loggedKeySource = '';

function isUsableKey(v: string | undefined | null): v is string {
  if (!v) return false;
  const t = v.trim().replace(/^["']|["']$/g, '');
  return t.length >= 10 && !t.startsWith('MY_') && !/^(undefined|null|your_|placeholder)/i.test(t);
}

function pickFromEnvPairs(pairs: Array<[string, string]>, origin: string): string | undefined {
  for (const name of GEMINI_KEY_NAMES) {
    const hit = pairs.find(([k]) => k === name);
    if (hit && isUsableKey(hit[1])) {
      lastKeySource = `${origin}:${name}`;
      return hit[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  return undefined;
}

function parseDotenv(content: string): Array<[string, string]> {
  return content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).replace(/^export\s+/, '').trim(), l.slice(i + 1).trim()] as [string, string]; });
}

/**
 * Resolve the Gemini key at call time (secrets can be injected after boot).
 * Order: process.env (all known names) -> key/.env files -> parent processes' /proc environ
 * (cached 1 min) -> key saved by the user in app Settings.
 * Never writes the key to disk.
 */
function resolveGeminiApiKey(): string | undefined {
  const found = resolveGeminiApiKeyInner();
  if (found && lastKeySource !== 'firestore:user-settings' && (!process.env.GEMINI_API_KEY || !isUsableKey(process.env.GEMINI_API_KEY))) {
    process.env.GEMINI_API_KEY = found;
    process.env.GOOGLE_API_KEY = found;
    process.env.GOOGLE_GENAI_API_KEY = found;
  }
  if (!found) lastKeySource = 'none';
  if (loggedKeySource !== lastKeySource) {
    loggedKeySource = lastKeySource;
    console.log(`[Gemini key] source=${lastKeySource}` + (found ? ` len=${found.length}` : ` (checked env names: ${GEMINI_KEY_NAMES.join(', ')})`));
  }
  return found;
}

// Searching files and parent processes is slow, and the result rarely changes: remember it
// for a minute (hits and misses), instead of repeating the scan on every request.
const KEY_SCAN_CACHE_MS = 60 * 1000;
let keyScanCache: { key: string | undefined; source: string; at: number } | null = null;

function resolveGeminiApiKeyInner(): string | undefined {
  // 1. process.env: cheap, checked every time (secrets can be injected after boot)
  const fromEnv = pickFromEnvPairs(Object.entries(process.env).map(([k, v]) => [k, v ?? '']), 'env');
  if (fromEnv) return fromEnv;

  // 2. Key / .env files and parent-process environments (cached)
  if (!keyScanCache || Date.now() - keyScanCache.at > KEY_SCAN_CACHE_MS) {
    const key = scanFilesAndParentsForKey();
    keyScanCache = { key, source: key ? lastKeySource : 'none', at: Date.now() };
  }
  if (keyScanCache.key) {
    lastKeySource = keyScanCache.source;
    return keyScanCache.key;
  }

  // 3. Last resort: key the signed-in user saved in app Settings (server/userKey.ts).
  const userKey = getUserSuppliedKey();
  if (isUsableKey(userKey)) {
    lastKeySource = 'firestore:user-settings';
    return userKey.trim();
  }

  return undefined;
}

/** Parent process ids of this server (nearest first), read from /proc/<pid>/status. */
function ancestorPids(max = 8): string[] {
  const out: string[] = [];
  let pid = String(process.pid);
  for (let i = 0; i < max; i++) {
    try {
      const m = /^PPid:\s*(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf-8'));
      if (!m || m[1] === '0') break;
      pid = m[1];
      out.push(pid);
    } catch {
      break;
    }
  }
  return out;
}

function scanFilesAndParentsForKey(): string | undefined {
  const dirs = Array.from(new Set([
    __dirname,
    process.cwd(),
    path.resolve(__dirname, '..'),
    '/app',
    '/secrets',
    '/etc/secrets',
    '/var/run/secrets',
    '/var/secrets',
  ]));
  for (const dir of dirs) {
    // Check .dev.env.json written by container/environment
    try {
      const devEnvFile = path.resolve(dir, '.dev.env.json');
      if (fs.existsSync(devEnvFile)) {
        const json = JSON.parse(fs.readFileSync(devEnvFile, 'utf-8'));
        for (const name of GEMINI_KEY_NAMES) {
          if (isUsableKey(json[name])) {
            lastKeySource = `json:${devEnvFile}:${name}`;
            return json[name].trim().replace(/^["']|["']$/g, '');
          }
        }
      }
    } catch { /* ignore */ }

    for (const kf of ['.gemini_api_key', 'gemini_api_key', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'api_key']) {
      try {
        const keyFile = path.resolve(dir, kf);
        if (fs.existsSync(keyFile) && fs.statSync(keyFile).isFile()) {
          const v = fs.readFileSync(keyFile, 'utf-8').trim();
          if (isUsableKey(v)) { lastKeySource = `file:${keyFile}`; return v; }
        }
      } catch { /* ignore */ }
    }

    for (const f of ['.env.local', '.env']) {
      try {
        const envFile = path.resolve(dir, f);
        if (fs.existsSync(envFile)) {
          const v = pickFromEnvPairs(parseDotenv(fs.readFileSync(envFile, 'utf-8')), `file:${envFile}`);
          if (v) return v;
        }
      } catch { /* ignore */ }
    }
  }

  // Check /etc/environment
  try {
    if (fs.existsSync('/etc/environment')) {
      const v = pickFromEnvPairs(parseDotenv(fs.readFileSync('/etc/environment', 'utf-8')), 'file:/etc/environment');
      if (v) return v;
    }
  } catch { /* ignore */ }

  // Environment of the processes that started this server (the container launcher may hold
  // the secret). Only this server's own parent chain, never unrelated processes.
  for (const p of ancestorPids()) {
    try {
      const pairs = fs.readFileSync(`/proc/${p}/environ`, 'utf-8').split('\0').filter((x) => x.includes('='))
        .map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)] as [string, string]; });
      const v = pickFromEnvPairs(pairs, `proc:${p}`);
      if (v) return v;
    } catch { /* ignore */ }
  }

  return undefined;
}

/** True when the platform environment gave no key, so the user-saved key is needed. */
function needsUserKey(): boolean {
  const k = resolveGeminiApiKey();
  return !k || lastKeySource === 'firestore:user-settings';
}

setAfterAuthHook(async (idToken, user) => {
  if (needsUserKey()) await ensureUserGeminiKey(idToken, user.uid);
});

// Initialize GoogleGenAI client with official header
// Server key only: client-supplied API keys are no longer accepted (no client sends one).
function createGenAI() {
  const apiKey = resolveGeminiApiKey();

  if (!isUsableKey(apiKey)) return null;

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

/** "file:/app/.env" -> "file", "env:GEMINI_API_KEY" -> "env", "firestore:user-settings" stays. */
function publicKeySource(src: string): string {
  if (src === 'none' || src === 'firestore:user-settings') return src;
  return src.split(':')[0];
}

// 1. Check Gemini server connectivity and GDP credit status
app.get('/api/gemini/status', async (req: Request, res: Response) => {
  const key = resolveGeminiApiKey();
  const hasServerKey = isUsableKey(key);
  res.json({
    available: hasServerKey,
    buildVersion: getBuildVersion(),
    defaultModel: NATIVE_AUDIO_MODEL,
    liveModel: NATIVE_AUDIO_MODEL,
    modelName: `${NATIVE_AUDIO_MODEL} (Live native audio)`,
    ttsModel: FALLBACK_TTS_MODEL,
    transcribeModel: TRANSCRIBE_MODEL,
    liveSupported: true,
    gdpConnected: hasServerKey,
    hasServerKey,
    // Public (no login): only the kind of source, never file paths or the value.
    keySource: publicKeySource(lastKeySource),
  });
});

// Re-read the key saved in app Settings right after the user saves or deletes it.
app.post('/api/gemini/key-refresh', requireAuth, async (req: Request, res: Response) => {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (m && needsUserKey()) await ensureUserGeminiKey(m[1].trim(), res.locals.user.uid, true);
  const key = resolveGeminiApiKey();
  res.json({ ok: true, hasServerKey: isUsableKey(key), keySource: lastKeySource });
});

// Ephemeral token endpoint for browser-direct Gemini Live connection (B-2 requirement 3 & 2-1)
app.post('/api/gemini/token', requireAuth, geminiLimit, async (req: Request, res: Response) => {
  try {
    const key = resolveGeminiApiKey();
    if (!key || key.startsWith('MY_')) {
      apiError(res, 503, 'NO_SERVER_KEY', NO_KEY_MESSAGE, { fallback: true });
      return;
    }

    // GoogleGenAI with apiVersion v1alpha for authTokens support
    const ai = new GoogleGenAI({
      apiKey: key,
      apiVersion: 'v1alpha',
      httpOptions: {
        apiVersion: 'v1alpha',
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    if (typeof (ai as any).authTokens?.create === 'function') {
      const now = Date.now();
      const token = await (ai as any).authTokens.create({
        config: {
          uses: 1,
          expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
          newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
        },
      });

      const tokenName = typeof token?.name === 'string' ? token.name : (typeof token === 'string' ? token : null);
      if (tokenName) {
        res.json({ ok: true, token: tokenName });
        return;
      }
    }

    res.json({ ok: false, fallback: true, message: 'Direct ephemeral token not supported in this environment, using server proxy' });
  } catch (err: any) {
    console.warn('[Gemini Token] Ephemeral token creation failed, falling back to server proxy:', err?.message || err);
    res.json({ ok: false, fallback: true, code: 'TOKEN_FAILED' });
  }
});



// 4. Native Gemini Voice Speech (TTS) endpoint
app.post('/api/gemini/tts', requireAuth, geminiLimit, async (req: Request, res: Response) => {
  const start = performance.now();
  const { text, voiceName } = req.body || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: '변환할 텍스트가 없습니다.' });
    return;
  }

  const ai = createGenAI();
  if (!ai) {
    noKey(res);
    return;
  }

  try {
    const voice = normalizeVoiceName(voiceName);

    const response = await ai.models.generateContent({
      model: FALLBACK_TTS_MODEL,
      contents: [{
        role: 'user',
        parts: [{ text: text.trim() }],
      }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
        },
      },
    });

    const candidate = response.candidates?.[0];
    const audioPart = candidate?.content?.parts?.find((p: any) => p.inlineData?.mimeType?.startsWith('audio/'));

    if (!audioPart || !audioPart.inlineData?.data) {
      res.status(500).json({ error: '음성 생성 데이터 없음' });
      return;
    }

    const elapsed = Math.round(performance.now() - start);
    res.json({
      audioBase64: audioPart.inlineData.data,
      mimeType: audioPart.inlineData.mimeType || 'audio/wav',
      model: FALLBACK_TTS_MODEL,
      voice,
      elapsedMs: elapsed,
    });
  } catch (error: any) {
    console.error('Gemini TTS error:', error);
    apiError(res, 500, 'TTS_FAILED', '발음 듣기 음성을 만들지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
});


// Directory for server-stored chunk fallback
// Outside public/ so recordings are never served statically; per-user subfolders.
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// B-3 Requirement 2: 1-minute asynchronous partial transcription via gemini-3.5-transcribe VERBATIM
app.post('/api/gemini/transcribe-partial', requireAuth, geminiLimit, async (req: Request, res: Response) => {
  const start = performance.now();
  const { sessionId, userId, minuteIndex, timeRange, audioBase64, mimeType = 'audio/webm' } = req.body || {};

  if (!audioBase64 || typeof audioBase64 !== 'string') {
    res.status(400).json({ ok: false, error: '변환할 오디오 데이터가 없습니다.' });
    return;
  }

  const ai = createGenAI();
  if (!ai) {
    noKey(res);
    return;
  }

  try {
    const response = await ai.models.generateContent({
      model: TRANSCRIBE_MODEL, // gemini-3.5-transcribe
      contents: {
        parts: [
          {
            inlineData: {
              data: audioBase64,
              mimeType,
            },
          },
          {
            text: '언어: 영어 및 한국어 혼합 대화. 모드: VERBATIM(있는 그대로 음성 전사). 생략, 요약, 문법 교정 없이 화자가 실제로 말한 단어, 감탄사, 망설임, 추임새를 있는 그대로 빠짐없이 정확하게 텍스트로 옮겨 적으시오. 부가 설명이나 서두/결말 문구 없이 전사 결과만 출력하시오.',
          },
        ],
      },
    });

    const elapsed = Math.round(performance.now() - start);
    const transcript = response.text?.trim() || '';

    console.log(`[TranscribePartial] 1-min partial transcribe complete for ${timeRange} (${elapsed}ms): "${transcript.slice(0, 50)}..."`);
    res.json({
      ok: true,
      sessionId,
      minuteIndex,
      timeRange,
      transcript,
      elapsedMs: elapsed,
    });
  } catch (error: any) {
    console.warn('[TranscribePartial] gemini-3.5-transcribe error:', error?.message || error);
    apiError(res, 500, 'TRANSCRIBE_FAILED', '받아쓰기에 실패했어요.');
  }
});

// Interrupted calls are detected in the app from Firestore (sessions.lastChunkAt older than
// 2 minutes -> pending_review, see checkAndMarkInterruptedSessions in src/services/firebase/db.ts).
// The old in-memory server watchdog was never read by the app and was removed.

// Resilient chunk upload endpoint (fallback when client Firebase Storage direct upload is restricted)
function userRecordingPath(uid: string, relPath: string): string | null {
  return userRecordingPathIn(RECORDINGS_DIR, uid, relPath);
}

app.post('/api/recordings/upload-chunk', requireAuth, express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '20mb' }), (req: Request, res: Response) => {
  try {
    const rawBuffer = Buffer.isBuffer(req.body) ? req.body : null;
    const relPath = String(req.query.path || req.headers['x-chunk-path'] || `chunk_${Date.now()}.webm`);
    const safePath = userRecordingPath(res.locals.user.uid, relPath);
    if (!safePath) {
      res.status(400).json({ ok: false, error: 'invalid path' });
      return;
    }
    // An empty body (wrong Content-Type, cut-off upload) must not be reported as saved: the app
    // would delete its local copy of the chunk.
    if (!rawBuffer || rawBuffer.length === 0) {
      apiError(res, 400, 'BAD_REQUEST', '녹음 조각이 비어 있어요.');
      return;
    }
    const safeDir = path.dirname(safePath);
    if (!fs.existsSync(safeDir)) {
      fs.mkdirSync(safeDir, { recursive: true });
    }
    fs.writeFileSync(safePath, rawBuffer);

    const fileUrl = `/api/recordings/file?path=${encodeURIComponent(relPath)}`;
    res.json({
      ok: true,
      url: fileUrl,
      path: relPath,
      sizeBytes: rawBuffer.length,
    });
  } catch (err: any) {
    console.error('[UploadChunk] Server chunk upload error:', err);
    apiError(res, 500, 'UPLOAD_FAILED', '녹음 조각을 저장하지 못했어요.');
  }
});

// Files under .data/ must be sent with dotfiles allowed: Express's sendFile refuses any path
// with a segment starting with "." by default and answers 404 "Not Found".
const SEND_DATA_FILE = { dotfiles: 'allow' as const };

app.get('/api/recordings/file', requireAuth, (req: Request, res: Response) => {
  const relPath = String(req.query.path || '');
  if (!relPath) {
    res.status(400).send('Path parameter is required');
    return;
  }
  const safePath = userRecordingPath(res.locals.user.uid, relPath);
  if (safePath && fs.existsSync(safePath)) {
    res.sendFile(safePath, SEND_DATA_FILE);
  } else {
    res.status(404).send('Audio file not found');
  }
});

const STORAGE_BUCKET = readStorageBucket();

// Firebase Storage에 올라간 조각을 서버가 대신 읽어 준다(서버 간 호출이라 버킷 CORS와 무관).
app.get('/api/recordings/storage-file', requireAuth, async (req: Request, res: Response) => {
  const objectPath = storageObjectPath(res.locals.user.uid, String(req.query.path || ''));
  const token = req.query.token;
  if (!objectPath || (token !== undefined && !isValidDownloadToken(token))) {
    apiError(res, 400, 'BAD_REQUEST', '녹음 조각 경로가 올바르지 않아요.');
    return;
  }
  const url = storageMediaUrl(STORAGE_BUCKET, objectPath, typeof token === 'string' ? token : undefined);
  if (!url) {
    apiError(res, 503, 'STORAGE_FAILED', '저장소 설정을 찾지 못했어요.');
    return;
  }
  const headers: Record<string, string> = {};
  if (!token) {
    const h = firebaseAuthHeader(req.headers.authorization);
    if (h) headers.Authorization = h;
  }
  try {
    const up = await fetch(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(STORAGE_FETCH_TIMEOUT_MS),
    });
    if (!up.ok) {
      const e = relayErrorFor(up.status);
      console.warn(`[StorageRelay] upstream ${up.status} (${path.basename(objectPath)})`);
      apiError(res, e.status, e.code, e.message);
      return;
    }
    if (Number(up.headers.get('content-length') || 0) > MAX_STORAGE_FILE_BYTES) {
      await up.body?.cancel().catch(() => {});
      apiError(res, 413, 'STORAGE_FAILED', '녹음 조각이 너무 커요.');
      return;
    }
    const buf = await readStreamWithLimit(up.body, MAX_STORAGE_FILE_BYTES);
    res.setHeader('Content-Type', relayContentType(up.headers.get('content-type')));
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  } catch (err: any) {
    if (err instanceof StorageFileTooLargeError) {
      apiError(res, 413, 'STORAGE_FAILED', '녹음 조각이 너무 커요.');
      return;
    }
    console.warn('[StorageRelay] fetch failed:', err?.name || 'error'); // URL·토큰 출력 금지
    apiError(
      res,
      err?.name === 'TimeoutError' ? 504 : 502,
      'STORAGE_FAILED',
      '저장소에서 녹음 조각을 가져오지 못했어요. 잠시 후 다시 시도해 주세요.'
    );
  }
});

// B-4 Final Full-Audio Transcription endpoint via gemini-3.5-transcribe (VERBATIM)
app.post('/api/gemini/transcribe-final', requireAuth, geminiLimit, async (req: Request, res: Response) => {
  const start = performance.now();
  const { audioBase64, mimeType = 'audio/webm' } = req.body || {};

  if (!audioBase64 || typeof audioBase64 !== 'string') {
    res.status(400).json({ ok: false, error: '변환할 오디오 데이터가 없습니다.' });
    return;
  }

  const ai = createGenAI();
  if (!ai) {
    noKey(res);
    return;
  }

  try {
    const response = await ai.models.generateContent({
      model: TRANSCRIBE_MODEL, // gemini-3.5-transcribe
      contents: {
        parts: [
          {
            inlineData: {
              data: audioBase64,
              mimeType,
            },
          },
          {
            text: '언어: 영어 및 한국어 대화. 모드: VERBATIM(있는 그대로 음성 전사). 생략, 요약, 문법 교정 없이 화자가 실제로 말한 단어, 문법적 실수, 감탄사, 망설임을 있는 그대로 토씨 하나 틀리지 않고 텍스트로 옮겨 적으시오. 부가 설명이나 인사말 없이 전사 텍스트만 단독 출력하시오.',
          },
        ],
      },
    });

    const elapsed = Math.round(performance.now() - start);
    const transcript = response.text?.trim() || '';

    res.json({
      ok: true,
      transcript,
      elapsedMs: elapsed,
    });
  } catch (err: any) {
    console.warn('[TranscribeFinal] gemini-3.5-transcribe error:', err?.message || err);
    apiError(res, 500, 'TRANSCRIBE_FAILED', '받아쓰기에 실패했어요.');
  }
});

// 6. Post-Call Review & Mistake Log Generation (Gemini 3.8 Flash structured JSON) - B-4 Specification
app.post('/api/review', requireAuth, geminiLimit, async (req: Request, res: Response) => {
  const start = performance.now();
  const {
    trackId,
    goalId,
    lessonNum,
    lessonTitle,
    sttFinal, // Verbatim recording transcript (기록용 받아쓰기)
    sourceStt = 'sttFinal',
    sttPartial = [],
    liveTranscript = [],
    todayLessonPrompt = '',
    reviewingMistakes = [], // Existing reviewing mistakes for detecting usedCorrectly
    graduatedMistakes = [], // Existing graduated mistakes for detecting repeatedMistakes
    callDurationSec,
    qa,
    skipSupplement,
  } = req.body || {};

  const ai = createGenAI();
  if (!ai) {
    noKey(res);
    return;
  }

  try {
    const formattedLiveTranscript = Array.isArray(liveTranscript) && liveTranscript.length > 0
      ? liveTranscript.map((t: any) => `${t.role === 'model' ? 'AI Tutor' : 'Learner'}: ${t.text}`).join('\n')
      : '(No live turns recorded)';

    const formattedReviewingMistakes = Array.isArray(reviewingMistakes) && reviewingMistakes.length > 0
      ? reviewingMistakes.map((m: any) => `ID: ${m.id} | Awkward: "${m.myPhrase}" -> Natural: "${m.naturalPhrase}" (${m.reason})`).join('\n')
      : '(None)';

    const formattedGraduatedMistakes = Array.isArray(graduatedMistakes) && graduatedMistakes.length > 0
      ? graduatedMistakes.map((m: any) => `ID: ${m.id} | Awkward: "${m.myPhrase}" -> Natural: "${m.naturalPhrase}"`).join('\n')
      : '(None)';

    const systemInstruction = `You are an expert 1:1 English speaking coach and post-call review analyst.
Analyze this completed call session to produce a structured review report.

Input Materials:
1. [기록용 받아쓰기 (VERBATIM sttFinal)]:
${sttFinal || '(No audio transcription available)'}

2. [Live 대화 로그 (Live transcript)]:
${formattedLiveTranscript}

3. [오늘 수업 지시서 (Lesson Prompt Directive)]:
${todayLessonPrompt || `Goal: ${trackId || goalId}, Lesson: ${lessonNum} (${lessonTitle})`}

4. [현재 복습 중인 실수 목록 (Reviewing Mistakes)]:
${formattedReviewingMistakes}

5. [이미 졸업한 실수 목록 (Graduated Mistakes)]:
${formattedGraduatedMistakes}

STRICT ANALYSIS RULES (Part B-4):
1. mistakes[]: Identify grammatical errors, awkward collocations, word choice blunders, or unnatural patterns made by the learner.
   CRITICAL REQUIREMENT FOR "myPhrase":
   - "myPhrase" MUST be copied WORD-FOR-WORD, EXACTLY VERBATIM from the learner's sentences in [기록용 받아쓰기 (VERBATIM sttFinal)].
   - NEVER edit, correct, sanitize, or rephrase "myPhrase". Keep all grammar mistakes, missing prepositions, or broken phrasing exactly as the learner spoke.
   - "naturalPhrase": How an American native speaker / OPIc AL speaker would naturally express this thought.
   - "reason": 1-2 concise Korean sentences explaining why naturalPhrase is better (grammar, preposition, nuance, collocation).
   - "sourceStt": Set to "${sourceStt}".
2. keyExpressions[]: EXACTLY 5 high-impact English expressions to memorize from this lesson:
   - "expression": English phrase/idiom.
   - "situation": When to use this in Korean.
   - "exampleSentence": Natural example sentence.
3. estimatedLevel: One of "IM2", "IH", "AL", "Native" (Note: AI estimate only, not official).
4. usedCorrectly[]: Array of string IDs from [현재 복습 중인 실수 목록] that the learner used correctly and naturally during this call.
5. repeatedMistakes[]: Array of string IDs from [이미 졸업한 실수 목록] that the learner made a mistake on again during this call.
6. overallEvaluation: 1-2 sentence overall evaluation in Korean of the learner's spoken English performance + priority improvement area.
7. keepSyncText: Text block formatted for Google Keep:
   For each mistake, one per line: "[myPhrase] -> [naturalPhrase]".`;

    const response = await ai.models.generateContent({
      model: FALLBACK_CHAT_MODEL, // gemini-3.8-flash
      contents: [{
        role: 'user',
        parts: [{ text: `Generate the B-4 post-call review report now.` }],
      }],
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            overallEvaluation: { type: Type.STRING },
            estimatedLevel: { type: Type.STRING },
            mistakes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  myPhrase: { type: Type.STRING },
                  naturalPhrase: { type: Type.STRING },
                  reason: { type: Type.STRING },
                  sourceStt: { type: Type.STRING },
                },
                required: ['myPhrase', 'naturalPhrase', 'reason', 'sourceStt'],
              },
            },
            keyExpressions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  expression: { type: Type.STRING },
                  situation: { type: Type.STRING },
                  exampleSentence: { type: Type.STRING },
                },
                required: ['expression', 'situation', 'exampleSentence'],
              },
            },
            usedCorrectly: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            repeatedMistakes: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            keepSyncText: { type: Type.STRING },
          },
          required: [
            'overallEvaluation',
            'estimatedLevel',
            'mistakes',
            'keyExpressions',
            'usedCorrectly',
            'repeatedMistakes',
            'keepSyncText',
          ],
        },
      },
    });

    const parsed = JSON.parse(response.text?.trim() || '{}');
    const sttFinalText =
      typeof sttFinal === 'string'
        ? sttFinal
        : sttFinal && typeof sttFinal === 'object' && typeof sttFinal.transcript === 'string'
          ? sttFinal.transcript
          : '';
    const corpus = preferredUserTranscript({
      sttFinal: { transcript: sttFinalText },
      liveTranscript: Array.isArray(liveTranscript) ? liveTranscript : [],
    });
    const validationCorpus = buildUserCorpus({
      sttFinal: { transcript: sttFinalText },
      sttPartial: Array.isArray(sttPartial) ? sttPartial : [],
      liveTranscript: Array.isArray(liveTranscript) ? liveTranscript : [],
    });
    const supp = skipSupplement
      ? { items: [], status: 'skipped' as const }
      : await runLectureSupplement(ai, {
          corpus,
          validationCorpus,
          knownPhrases: Array.isArray(parsed.mistakes) ? parsed.mistakes : [],
          lessonTitle,
          durationSec: typeof callDurationSec === 'number' ? callDurationSec : undefined,
          qa: qa === true,
          sourceStt,
        });

    const { inputTokens: mainInput, outputTokens: mainOutput } = tokensFromUsageMetadata(response.usageMetadata);
    const suppInput = supp.usage?.inputTokens || 0;
    const suppOutput = supp.usage?.outputTokens || 0;
    const elapsed = Math.round(performance.now() - start);

    res.json({
      ok: true,
      review: {
        ...parsed,
        extraMistakes: supp.items,
        extraMistakesStatus: supp.status,
        ...(supp.error ? { extraMistakesError: supp.error } : {}),
        trackId: trackId || goalId || 'opic',
        lessonNum: lessonNum || 1,
        lessonTitle: lessonTitle || '',
        generatedAt: new Date().toISOString(),
      },
      usage: {
        inputTokens: mainInput + suppInput,
        outputTokens: mainOutput + suppOutput,
        supplementInputTokens: suppInput,
        supplementOutputTokens: suppOutput,
      },
      elapsedMs: elapsed,
    });
  } catch (err: any) {
    console.error('Review generation error:', err);
    apiError(res, 500, 'REVIEW_FAILED', '복기 리포트를 만들지 못했어요. 잠시 후 다시 만들어 주세요.');
  }
});

// Phase 2 backfill: supplemental transcript analysis for already-reviewed sessions
app.post('/api/review/supplement', requireAuth, geminiLimit, async (req: Request, res: Response) => {
  const start = performance.now();
  const {
    sessionId,
    sttFinal,
    sttPartial = [],
    liveTranscript = [],
    knownMistakes = [],
    lessonTitle,
    callDurationSec,
    qa,
    sourceStt = 'sttFinal',
  } = req.body || {};

  const ai = createGenAI();
  if (!ai) {
    noKey(res);
    return;
  }

  const sttFinalText =
    typeof sttFinal === 'string'
      ? sttFinal
      : sttFinal && typeof sttFinal === 'object' && typeof sttFinal.transcript === 'string'
        ? sttFinal.transcript
        : '';
  const corpus = preferredUserTranscript({
    sttFinal: { transcript: sttFinalText },
    liveTranscript: Array.isArray(liveTranscript) ? liveTranscript : [],
  });
  const validationCorpus = buildUserCorpus({
    sttFinal: { transcript: sttFinalText },
    sttPartial: Array.isArray(sttPartial) ? sttPartial : [],
    liveTranscript: Array.isArray(liveTranscript) ? liveTranscript : [],
  });
  const supp = await runLectureSupplement(ai, {
    corpus,
    validationCorpus,
    knownPhrases: Array.isArray(knownMistakes) ? knownMistakes : [],
    lessonTitle,
    durationSec: typeof callDurationSec === 'number' ? callDurationSec : undefined,
    qa: qa === true,
    sourceStt: typeof sourceStt === 'string' ? sourceStt : 'sttFinal',
  });

  res.json({
    ok: true,
    ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
    extraMistakes: supp.items,
    status: supp.status,
    ...(supp.reason ? { reason: supp.reason } : {}),
    ...(supp.error ? { error: supp.error } : {}),
    usage: supp.usage || { inputTokens: 0, outputTokens: 0 },
    elapsedMs: Math.round(performance.now() - start),
  });
});

// B-6 Requirement 3: Quiz Grading endpoint (TEXT_MODEL = gemini-3.8-flash)
app.post('/api/quiz/grade', requireAuth, geminiLimit, async (req: Request, res: Response) => {
  const { mistakeId, myPhrase, naturalPhrase, reason, answer } = req.body || {};

  if (!naturalPhrase || answer === undefined) {
    res.status(400).json({ ok: false, error: 'naturalPhrase and answer are required' });
    return;
  }

  const ai = createGenAI();
  if (!ai) {
    noKey(res);
    return;
  }

  try {
    const prompt = `당신은 공정하고 격려하는 영어 학습 튜터입니다.
사용자가 영어 표현 퀴즈에 응답했습니다.

[목표 자연스러운 표현 (naturalPhrase)]:
"${naturalPhrase}"

[핵심 교정 포인트 및 이유 (reason)]:
"${reason || ''}"

[사용자가 과거에 했던 오답 (myPhrase)]:
"${myPhrase || ''}"

[사용자가 이번 퀴즈에 제출한 답변 (answer)]:
"${answer}"

[채점 규칙 - 엄격 준수]:
1. "핵심 교정 포인트(reason이 고친 부분)가 맞으면 통과(passed: true)" 처리합니다.
2. 사소한 철자(minor typo), 관사(a/an/the 누락 또는 교체), 구두점, 대소문자 차이는 통과(passed: true)로 너그럽게 허용합니다.
3. 반면 핵심 교정 포인트를 여전히 틀렸거나 과거 오답("${myPhrase || ''}") 패턴을 반복한 경우, 또는 문장의 핵심 의미가 통하지 않는 경우에는 불통과(passed: false)로 처리합니다.
4. feedback: 사용자가 잘한 부분이나 고칠 핵심을 다정하게 격려하는 한국어 1~2문장으로 작성하십시오.
5. correctAnswer: "${naturalPhrase}"를 정확히 전달하십시오.`;

    const response = await ai.models.generateContent({
      model: FALLBACK_CHAT_MODEL, // gemini-3.8-flash
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            passed: { type: Type.BOOLEAN },
            feedback: { type: Type.STRING },
            correctAnswer: { type: Type.STRING },
          },
          required: ['passed', 'feedback', 'correctAnswer'],
        },
      },
    });

    const parsed = JSON.parse(response.text?.trim() || '{}');
    res.json({
      ok: true,
      mistakeId,
      passed: Boolean(parsed.passed),
      feedback: parsed.feedback || '',
      correctAnswer: parsed.correctAnswer || naturalPhrase,
    });
  } catch (err: any) {
    console.error('Quiz grading error:', err);
    apiError(res, 500, 'QUIZ_FAILED', '퀴즈 채점에 실패했어요. 다시 시도해 주세요.');
  }
});

// B-6 Requirement 2: Quiz Flashcard Korean Meaning generator (gemini-3.8-flash)
app.post('/api/quiz/meaning-ko', requireAuth, geminiLimit, async (req: Request, res: Response) => {
  const { items } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ ok: false, error: 'items array is required' });
    return;
  }

  const ai = createGenAI();
  if (!ai) {
    noKey(res);
    return;
  }

  try {
    const listStr = items.map((it: any, idx: number) => `${idx + 1}. [ID: ${it.id}] "${it.naturalPhrase}" (참고 이유: ${it.reason || ''})`).join('\n');
    const prompt = `각 영어 표현을 학습용 플래시카드 앞면에 들어갈 자연스럽고 간결한 한국어 뜻(1문장 또는 짧은 구)으로 번역해 주세요.

목록:
${listStr}

각 항목의 id와 간결한 한국어 뜻(meaningKo)을 반환하세요.`;

    const response = await ai.models.generateContent({
      model: FALLBACK_CHAT_MODEL, // gemini-3.8-flash
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            meanings: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  meaningKo: { type: Type.STRING },
                },
                required: ['id', 'meaningKo'],
              },
            },
          },
          required: ['meanings'],
        },
      },
    });

    const parsed = JSON.parse(response.text?.trim() || '{"meanings":[]}');
    res.json({
      ok: true,
      meanings: parsed.meanings || [],
    });
  } catch (err: any) {
    console.error('Quiz meaning generation error:', err);
    apiError(res, 500, 'QUIZ_FAILED', '한국어 뜻을 만들지 못했어요.');
  }
});

// B-9 Requirement 4: Coach LLM chat endpoint (gemini-3.8-flash + function calling)
app.post('/api/coach/chat', requireAuth, geminiLimit, async (req: Request, res: Response) => {
  const { text, plan, goals, mistakeStats, recentSessions, memory, history = [], todayGoalId: rawTodayGoalId } = req.body || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ ok: false, error: '메시지를 입력해 주세요.' });
    return;
  }

  const ai = createGenAI();
  if (!ai) {
    noKey(res);
    return;
  }

  try {
    const safeGoals = Array.isArray(goals)
      ? goals
          .filter((g: any) => g && typeof g.id === 'string')
          .map((g: any) => ({
            id: g.id,
            title: typeof g.title === 'string' ? g.title : undefined,
            nextLessonIndex: typeof g.nextLessonIndex === 'number' ? g.nextLessonIndex : 1,
            lessonsPerCall: normalizeLessonsPerCall(g.lessonsPerCall),
            status: g.status,
            lessons: Array.isArray(g.lessons)
              ? g.lessons
                  .filter((l: any) => l && typeof l.index === 'number')
                  .map((l: any) => ({ index: l.index }))
              : [],
          }))
      : [];
    const todayGoalId = sanitizeTodayGoalId(rawTodayGoalId, safeGoals.map((g) => g.id));

    const systemInstruction = `당신은 '찬식'님(episode.kim@gmail.com)의 전담 1:1 영어 학습 스케줄/목표 코치입니다.
[코칭 원칙 - 절대 규칙]:
1. 오직 학습 계획, 요일별 루틴, 목표(OPIc AL, 필리조선소 주재원, Bluey 듣기, 미국·호주 여행), 진도 및 실수 패턴만 다룹니다.
2. 답변은 친절하고 격려하는 한국어 구어체로 2~4문장으로 간결하게 작성합니다.
3. 사용자가 일정 변경, 출장, 야근, 휴식, 요일 변경, 시험일 접수 등을 언급하면 반드시 'propose_plan_change' 도구를 호출해 변경 제안 카드를 생성하세요.
4. 중요: 사용자 승인(클라이언트의 승인 버튼) 없이 실제 계획이나 목표를 절대 직접 바꾸거나 완료하지 마세요. 변경을 적용하는 도구는 없으며, 제안만 할 수 있습니다.
5. '시험이 11/29로 잡혔어'와 같이 OPIc 시험 날짜(deadline)를 언급하면:
   - goalPatches에 { opic: { deadline: "2026-11-29" } }를 넣고,
   - 시험 1~2주 전 구간에 OPIc 실전 모의고사(14과)를 월·토 OPIc 슬롯에 집중 배치하는 제안을 만드세요.
6. 사용자가 학습 제약(출장, 시간 부족 등), 선호도(선호 시간대, 선호 과목 등), 본인의 취약점(문법, 발음 등)을 언급하면 memoryPatch({ constraints?, preferences?, weakPoints? })에 포함시켜 기록하도록 제안하세요.
7. 진도 미루기·땡기기·속도("N과씩")·"N과로"·되돌리기는 반드시 'propose_progress_adjust'만 쓰고 nextLessonIndex를 직접 계산하지 않는다.
   - "씩·매 통화·앞으로·속도"는 set_pace(days 1~3), "한 번만·점프"는 pull_forward다.
   - "원래 속도로"는 set_pace(days 1), "미뤄"는 postpone이다.
   - 날수만 있고 둘 다 없으면 그대로 호출한다(서버가 되묻는다).
   - 되묻기에 대한 답이면 이전 대화의 트랙과 과 수를 goalId·days에 명시한다.
   - "시험"이 나오면 goalId는 opic, "전부"는 all, 트랙이 불분명하면 today. 진도는 통화를 마칠 때 트랙별 페이스만큼 오르고 요일 패턴은 바꾸지 않는다.
8. 앱은 구글 캘린더를 바꾸지 않는다.

[현재 사용자 상태]:
- 현재 주간 계획(plan.weeklyPattern): ${JSON.stringify(plan?.weeklyPattern || { mon:['opic'], tue:['philly'], wed:['bluey'], thu:['philly'], fri:['travel'], sat:['opic'], sun:[] })}
- 목표별 진도: ${JSON.stringify((goals || []).map((g: any) => ({ id: g.id, title: g.title, nextLessonIndex: g.nextLessonIndex, lessonsPerCall: g.lessonsPerCall ?? 1, status: g.status, deadline: g.deadline || null })))}
- 오늘 고른 트랙: ${todayGoalId || '없음(요일 패턴대로)'}
- 복습 통계: ${JSON.stringify(mistakeStats || { reviewing: 0, graduated: 0, dueToday: 0 })}
- 최근 7일 세션: ${JSON.stringify(recentSessions || [])}
- 코치 메모리: ${JSON.stringify(memory || { constraints: [], preferences: [], weakPoints: [] })}`;

    const proposePlanChangeDeclaration: any = {
      name: 'propose_plan_change',
      description: '학습 계획, 루틴, 목표 설정 변경 제안을 생성합니다. 사용자 승인 전에는 실제 데이터가 변경되지 않습니다.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          summary: {
            type: Type.STRING,
            description: '변경 제안에 대한 요약 설명 (한국어 1문장)',
          },
          afterPlan: {
            type: Type.OBJECT,
            description: '변경될 주간 계획 ({ weeklyPattern?: { mon: string[], tue: string[], wed: string[], thu: string[], fri: string[], sat: string[], sun: string[] }, minutesPerDay?: number })',
          },
          goalPatches: {
            type: Type.OBJECT,
            description: '목표별 변경 사항 (예: { opic: { deadline: "2026-11-29" } }, { philly: { status: "paused" } }, { travel: { nextLessonIndex: 4 } })',
          },
          memoryPatch: {
            type: Type.OBJECT,
            description: '새로 기억할 제약/선호/취약점 ({ constraints?: string[], preferences?: string[], weakPoints?: string[] })',
          },
        },
        required: ['summary'],
      },
    };

    const getProgressDeclaration: any = {
      name: 'get_progress',
      description: '목표별 nextLessonIndex, status, deadline 및 최근 7일 세션 요약을 확인합니다.',
      parameters: { type: Type.OBJECT, properties: {} },
    };

    const getMistakeStatsDeclaration: any = {
      name: 'get_mistake_stats',
      description: '복습 중, 보류, 졸업 실수 수 및 오늘 due 수를 확인합니다.',
      parameters: { type: Type.OBJECT, properties: {} },
    };

    const proposeProgressAdjustDeclaration: any = {
      name: 'propose_progress_adjust',
      description: '목표별 진도(nextLessonIndex) 미루기·앞당기기·특정 과로 바꾸기·되돌리기를 구조화된 인자로 제안합니다.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          intent: {
            type: Type.STRING,
            enum: ['postpone', 'pull_forward', 'set_lesson', 'set_pace', 'undo'],
            description: '진도 조정 의도',
          },
          days: {
            type: Type.INTEGER,
            description: 'pull_forward: 한 번에 앞당길 과 수(1~7) / set_pace: 매 통화 올라갈 과 수(1~3)',
          },
          goalId: {
            type: Type.STRING,
            enum: ['opic', 'philly', 'bluey', 'travel', 'today', 'all'],
            description: '대상 목표 id, 오늘 트랙(today), 또는 전체(all)',
          },
          lessonIndex: {
            type: Type.INTEGER,
            description: 'set_lesson 시 이동할 과 번호',
          },
        },
        required: ['intent'],
      },
    };

    // Prepare message turns from history
    const contents: any[] = [];
    if (Array.isArray(history)) {
      for (const h of history.slice(-6)) {
        if (!h.text) continue;
        contents.push({
          role: h.role === 'user' ? 'user' : 'model',
          parts: [{ text: h.text }],
        });
      }
    }
    contents.push({
      role: 'user',
      parts: [{ text: text.trim() }],
    });

    const response = await ai.models.generateContent({
      model: FALLBACK_CHAT_MODEL, // gemini-3.8-flash
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: [proposePlanChangeDeclaration, proposeProgressAdjustDeclaration, getProgressDeclaration, getMistakeStatsDeclaration] }],
      },
    });

    let reply = response.text || '';
    let proposal: any = null;
    let progressPayload: CoachProgressChatOut['progress'] = undefined;

    const functionCalls = response.functionCalls;
    if (Array.isArray(functionCalls) && functionCalls.length > 0) {
      for (const call of functionCalls) {
        if (call.name === 'propose_plan_change') {
          const args: any = call.args || {};
          const currentGoalsMap: Record<string, any> = {};
          if (Array.isArray(goals)) {
            for (const g of goals) {
              currentGoalsMap[g.id] = {
                nextLessonIndex: g.nextLessonIndex,
                deadline: g.deadline,
                status: g.status,
              };
            }
          }
          proposal = {
            summary: args.summary || '학습 일정 변경 제안',
            before: {
              plan: plan ? { weeklyPattern: plan.weeklyPattern, minutesPerDay: plan.minutesPerDay } : undefined,
              goals: currentGoalsMap,
            },
            after: {
              plan: args.afterPlan ? args.afterPlan : undefined,
              goals: args.goalPatches ? args.goalPatches : undefined,
            },
            memoryPatch: args.memoryPatch,
            status: 'proposed',
          };
          if (!reply) {
            reply = `요청하신 내용을 바탕으로 계획 변경 제안 카드를 준비했어요. 아래 카드를 확인하시고 [승인]해 주세요.`;
          }
        }
      }

      const progressCall = functionCalls.find((c: any) => c.name === 'propose_progress_adjust');
      if (progressCall) {
        const progressResult = buildProgressProposal((progressCall.args as any) || {}, {
          goals: safeGoals,
          weeklyPattern: plan?.weeklyPattern,
          todayKst: kstToday(),
          userText: text,
          todayGoalId,
        });

        const sanitized = progressResult.type === 'proposal'
          ? sanitizePlanChangeAfter(progressResult.after, safeGoals)
          : {};
        const finalized = finalizeCoachProgressResponse({
          progressResult,
          sanitizedAfter: sanitized,
          isEmptyAfter: progressResult.type === 'proposal' ? isEmptyPlanChange(sanitized) : true,
          existingMemoryPatch: proposal?.memoryPatch,
          existingSummary: proposal?.summary,
        });
        reply = finalized.reply;
        proposal = finalized.proposal;
        if (finalized.progress) {
          progressPayload = finalized.progress;
        }
      }
    }

    if (!reply && !proposal) {
      reply = '네, 말씀해 주신 내용 잘 확인했습니다. 학습 계획이나 목표에 대해 언제든 편하게 말씀해 주세요!';
    }

    res.json({
      ok: true,
      reply,
      proposal,
      ...(progressPayload ? { progress: progressPayload } : {}),
    });
  } catch (err: any) {
    console.error('[CoachChat] error:', err);
    apiError(res, 500, 'COACH_FAILED', '코치 답변을 만들지 못했어요. 잠시 후 다시 보내 주세요.');
  }
});



// Health check endpoints for Cloud Run container probes
// B-7 Morning Lecture (auth required: Firebase ID token of the single allowed user)
app.post('/api/lecture/generate', requireAuth, geminiLimit, async (req: Request, res: Response) => {
  const uid = res.locals.user.uid as string;
  const { date, newMistakes, reviewMistakes, force } = req.body || {};
  const ai = createGenAI();
  if (!ai) {
    noKey(res);
    return;
  }
  const day = typeof date === 'string' ? date : kstToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    apiError(res, 400, 'BAD_REQUEST', '날짜 형식이 올바르지 않아요.');
    return;
  }
  const isForce = Boolean(force);
  const feed = feedForUid(uid);
  if (!isForce && feed) {
    try {
      await ensureTodayLecture(ai, feed, day);
    } catch (err: any) {
      console.warn('[Lecture] backup check before generate failed:', err?.message || err);
      apiError(res, 503, 'LECTURE_FAILED', '오늘 강의를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.');
      return;
    }
  }
  try {
    const state = startLectureJob(ai, uid, day, newMistakes || [], reviewMistakes || [], {
      force: isForce,
      ignoreCooldown: isForce,
      genRemote: feed ? createFeedGenRemote(feed.secret) : undefined,
      onReady: async (s: LectureState, isCurrent: () => boolean) => {
        const f = feedForUid(uid);
        if (!f) return;
        try {
          const result = await persistLectureBackups(f.secret, s, isCurrent);
          if (isCurrent()) {
            recordLectureBackupResult(uid, s.date, { createdAt: s.createdAt, audioBackupId: s.audioBackupId }, result);
          }
        } catch (err: any) {
          console.warn('[Lecture] backup save failed:', err?.name || 'error');
        }
      },
      onFailed: async (s: LectureState, isCurrent: () => boolean) => {
        const f = feedForUid(uid);
        if (!f) return;
        try {
          await saveLectureFailureBackup(f.secret, s, isCurrent);
        } catch (err: any) {
          console.warn('[Lecture] failure backup save failed:', err?.name || 'error');
        }
      },
    });
    res.json({ ok: true, lecture: state });
  } catch (err: any) {
    console.warn('[Lecture] start failed:', err?.message || err);
    apiError(res, 400, 'LECTURE_FAILED', '강의 만들기를 시작하지 못했어요.');
  }
});

app.get('/api/lecture/status', requireAuth, async (req: Request, res: Response) => {
  const uid = res.locals.user.uid as string;
  const date = typeof req.query.date === 'string' ? req.query.date : kstToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    apiError(res, 400, 'BAD_REQUEST', '날짜 형식이 올바르지 않아요.');
    return;
  }
  const feed = feedForUid(uid);
  if (feed) {
    try {
      await ensureTodayLecture(createGenAI(), feed, date);
    } catch (err: any) {
      console.warn('[Lecture] backup check on status failed:', err?.message || err);
    }
  }
  try {
    res.json({ ok: true, lecture: lectureStatusPayload(uid, date) });
  } catch (err: any) {
    apiError(res, 400, 'BAD_REQUEST', '날짜 형식이 올바르지 않아요.');
  }
});

app.get('/api/lecture/audio', requireAuth, (req: Request, res: Response) => {
  const uid = res.locals.user.uid as string;
  try {
    const date = typeof req.query.date === 'string' ? req.query.date : kstToday();
    const file = lectureAudioPath(uid, date);
    if (!file) {
      res.status(404).json({
        ok: false,
        error: '강의 오디오가 없습니다.',
        code: LECTURE_AUDIO_MISSING,
        hasLocalScript: lectureHasLocalScript(uid, date),
      });
      return;
    }
    const st = readLectureState(uid, date);
    const mime = st?.audioMime || mimeForAudioFile(st?.audioFile || file);
    res.setHeader('Accept-Ranges', 'bytes');
    res.type(mime).sendFile(file, SEND_DATA_FILE);
  } catch (err: any) {
    apiError(res, 400, 'BAD_REQUEST', '날짜 형식이 올바르지 않아요.');
  }
});


app.post('/api/lecture/audio/rebuild', requireAuth, geminiLimit, (req: Request, res: Response) => {
  const uid = res.locals.user.uid as string;
  const {
    date,
    script,
    title,
    coachNote,
    newMistakeIds,
    reviewMistakeIds,
    inputNewIds,
    inputReviewIds,
    inputLatestCreatedAt,
    ttsEngine,
    createdAt,
    textTokens,
    textInputTokens,
    textOutputTokens,
    ttsAudioSec,
    ttsAudioChars,
    itemCount,
  } = req.body || {};
  const ai = createGenAI();
  if (!ai) {
    noKey(res);
    return;
  }
  try {
    const day = typeof date === 'string' ? date : kstToday();
    const payload = script
      ? {
          script,
          title,
          coachNote,
          newMistakeIds,
          reviewMistakeIds,
          inputNewIds,
          inputReviewIds,
          inputLatestCreatedAt,
          ttsEngine,
          createdAt,
          textTokens,
          textInputTokens,
          textOutputTokens,
          ttsAudioSec,
          ttsAudioChars,
          itemCount,
        }
      : undefined;
    const feed = feedForUid(uid);
    const state = startLectureAudioRebuild(ai, uid, day, payload, {
      ignoreCooldown: true,
      genRemote: feed ? createFeedGenRemote(feed.secret) : undefined,
      onReady: async (s, isCurrent) => {
        const f = feedForUid(uid);
        if (!f) return;
        try {
          const result = await persistLectureBackups(f.secret, s, isCurrent);
          if (isCurrent()) {
            recordLectureBackupResult(uid, s.date, { createdAt: s.createdAt, audioBackupId: s.audioBackupId }, result);
          }
        } catch (err: any) {
          console.warn('[Lecture] rebuild backup save failed:', err?.name || 'error');
        }
      },
      onFailed: async (s, isCurrent) => {
        const f = feedForUid(uid);
        if (!f) return;
        try {
          await saveLectureFailureBackup(f.secret, s, isCurrent);
        } catch (err: any) {
          console.warn('[Lecture] rebuild failure backup save failed:', err?.name || 'error');
        }
      },
    });
    if (state.audioStatus === 'missing' && state.error === LECTURE_AUDIO_SCRIPT_MISSING) {
      res.status(409).json({ ok: false, error: '강의 대본이 없어 오디오를 다시 만들 수 없어요.', code: LECTURE_AUDIO_SCRIPT_MISSING, lecture: state });
      return;
    }
    if (
      state.audioStatus === 'missing' &&
      state.error &&
      state.error !== 'GENERATION_FAILED' &&
      state.error !== LECTURE_AUDIO_REBUILD_TIMED_OUT &&
      state.error !== LECTURE_GEN_SKIPPED
    ) {
      apiError(res, 400, 'BAD_REQUEST', '강의 대본 형식이 올바르지 않아요.');
      return;
    }
    res.json({ ok: true, lecture: state });
  } catch (err: any) {
    console.warn('[Lecture] audio rebuild failed to start:', err?.message || err);
    apiError(res, 400, 'LECTURE_FAILED', '강의 오디오를 다시 만들지 못했어요.');
  }
});

// B-8 Grok Bot feed: app syncs secret + candidates (auth), feed URLs need only the secret
app.post('/api/feed/sync', requireAuth, async (req: Request, res: Response) => {
  const uid = res.locals.user.uid as string;
  const { secret, previousSecret, quizCount, newMistakes, reviewMistakes, autoRegenerate } = req.body || {};
  if (!isValidFeedSecret(secret)) {
    res.status(400).json({ ok: false, error: 'feed secret 형식 오류' });
    return;
  }
  const { newList, reviewList } = sanitizeLectureInputs(newMistakes, reviewMistakes);
  const state = {
    uid,
    secret,
    quizCount: Math.max(0, Math.min(100, Number(quizCount) || 0)),
    newMistakes: newList,
    reviewMistakes: reviewList,
    syncedAt: new Date().toISOString(),
    autoRegenerate: autoRegenerate !== false,
  };
  writeFeedSync(state);
  const today = kstToday();
  const ai = createGenAI();
  try {
    await ensureTodayLecture(ai, state, today);
  } catch (err: any) {
    console.warn('[feed] ensure lecture after sync failed:', err?.message || err);
  }
  try {
    maybeAutoRegenerateToday(ai, state, today);
  } catch (err: any) {
    console.warn('[feed] auto-regenerate after sync failed:', err?.message || err);
  }
  // Firestore backup so the feed URL survives a fresh server (see server/feedStore.ts).
  const idToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  let backedUp = false;
  try {
    // Back up the user's Settings key too, but only when it is the key this server runs on.
    const apiKey = resolveGeminiApiKey() && lastKeySource === 'firestore:user-settings' ? getUserSuppliedKey() : undefined;
    await saveFeedBackup(idToken, { state, apiKey });
    if (isValidFeedSecret(previousSecret) && previousSecret !== secret) await deleteFeedBackup(idToken, previousSecret);
    backedUp = true;
  } catch (err: any) {
    console.warn('[feed] Firestore backup failed:', err?.message || err);
  }
  res.json({ ok: true, backedUp });
});

function feedBaseUrl(req: Request): string {
  return publicFeedBaseUrl({
    forwardedProto: req.headers['x-forwarded-proto'],
    forwarded: req.headers['forwarded'],
    forwardedHost: req.headers['x-forwarded-host'],
    host: req.headers.host,
    protocol: req.protocol,
  });
}

app.get(['/feed/:secret/today', '/feed/:secret/today.json'], async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
  const st = await loadFeedForSecret(String(req.params.secret));
  if (!st) {
    res.status(404).send('Not found');
    return;
  }
  const date = kstToday();
  const ai = createGenAI();
  let skipStart = false;
  try {
    await ensureTodayLecture(ai, st, date);
  } catch (err: any) {
    skipStart = true;
    console.warn('[feed] could not check lecture backup:', err?.message || err);
  }
  const today = buildFeedToday(ai, st, feedBaseUrl(req), { date, skipStart });
  if (req.path.endsWith('.json')) res.json(today);
  else res.type('html').send(renderFeedHtml(today));
});

app.get('/feed/:secret/today/diag.json', async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
  const st = await loadFeedForSecret(String(req.params.secret));
  if (!st) {
    res.status(404).send('Not found');
    return;
  }
  res.json(buildFeedDiag(st, { date: kstToday() }));
});

app.get('/feed/:secret/audio/:file', async (req: Request, res: Response) => {
  const st = await loadFeedForSecret(String(req.params.secret));
  const m = /^(\d{4}-\d{2}-\d{2})\.(wav|m4a|mp3)$/.exec(String(req.params.file));
  if (!st || !m) {
    res.status(404).send('Not found');
    return;
  }
  const date = m[1];
  if (date === kstToday()) {
    try {
      await ensureTodayLecture(createGenAI(), st, date);
    } catch (err: any) {
      console.warn('[feed] could not check lecture backup:', err?.message || err);
    }
  }
  const file = feedAudioFile(st, date);
  if (!file) {
    res.status(404).send('Not found');
    return;
  }
  res.set('X-Robots-Tag', 'noindex');
  res.set('Accept-Ranges', 'bytes');
  res.type(mimeForAudioFile(file)).sendFile(file, SEND_DATA_FILE);
});

// B-10 Keep import: split pasted Keep "English mistake log" text into [내가 한 말 / 자연스러운 표현 / 이유]
app.post('/api/keep/parse', requireAuth, geminiLimit, async (req: Request, res: Response) => {
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ ok: false, error: '붙여넣은 Keep 텍스트가 없습니다.' });
    return;
  }
  if (text.length > 60000) {
    res.status(400).json({ ok: false, error: '텍스트가 너무 깁니다(6만 자 이하로 나눠 주세요).' });
    return;
  }
  const ai = createGenAI();
  if (!ai) {
    noKey(res);
    return;
  }
  try {
    const prompt = `아래는 사용자가 Google Keep "English mistake log" 목록에서 복사한 텍스트입니다.
각 실수 항목을 [내가 한 말 / 자연스러운 표현 / 이유]로 나누세요.

규칙:
1. myPhrase(내가 한 말)는 텍스트에 적힌 틀린 문장을 글자 그대로 옮기세요. 절대 고치거나 다듬지 마세요.
2. naturalPhrase(자연스러운 표현)가 텍스트에 있으면 그대로, 없으면 자연스러운 영어로 제안하세요.
3. reason(이유)은 텍스트에 있으면 그대로, 없으면 한국어 1문장으로 쓰세요.
4. 실수가 아닌 줄(제목, 날짜, 빈 줄, 메모)은 버리세요. 항목 수를 임의로 합치거나 나누지 마세요.
5. 원래 순서를 지키세요.

[Keep 텍스트]
${text}`;
    const response = await ai.models.generateContent({
      model: FALLBACK_CHAT_MODEL, // gemini-3.8-flash
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  myPhrase: { type: Type.STRING },
                  naturalPhrase: { type: Type.STRING },
                  reason: { type: Type.STRING },
                },
                required: ['myPhrase', 'naturalPhrase', 'reason'],
              },
            },
          },
          required: ['items'],
        },
      },
    });
    const parsed = JSON.parse(response.text?.trim() || '{}');
    const items = (Array.isArray(parsed.items) ? parsed.items : [])
      .filter((it: any) => it && typeof it.myPhrase === 'string' && it.myPhrase.trim())
      .map((it: any) => ({
        myPhrase: String(it.myPhrase).trim(),
        naturalPhrase: String(it.naturalPhrase || '').trim(),
        reason: String(it.reason || '').trim(),
      }));
    res.json({
      ok: true,
      items,
      usage: tokensFromUsageMetadata(response.usageMetadata),
    });
  } catch (err: any) {
    console.error('[KeepParse] error:', err);
    apiError(res, 500, 'KEEP_PARSE_FAILED', 'Keep 내용을 나누지 못했어요. 다시 시도해 주세요.');
  }
});

// 1-F STT quality benchmark (auth required)
app.get('/api/stt-bench/engines', requireAuth, (_req: Request, res: Response) => {
  res.json({ ok: true, engines: { live: true, gemini_transcribe: true, assemblyai: assemblyAvailable() } });
});

app.post('/api/stt-bench/transcribe', requireAuth, geminiLimit, async (req: Request, res: Response) => {
  const { engine, audioBase64, mimeType = 'audio/webm', pcm16kBase64 } = req.body || {};
  const ai = createGenAI();
  const start = performance.now();
  try {
    let output = '';
    if (engine === 'gemini_transcribe') {
      if (!ai || typeof audioBase64 !== 'string') throw new Error('Gemini 또는 오디오 없음');
      output = await transcribeGemini(ai, TRANSCRIBE_MODEL, audioBase64, String(mimeType));
    } else if (engine === 'assemblyai') {
      if (!assemblyAvailable()) {
        res.json({ ok: false, skipped: true, error: 'ASSEMBLYAI_API_KEY 없음' });
        return;
      }
      if (typeof audioBase64 !== 'string') throw new Error('오디오 없음');
      output = await transcribeAssembly(Buffer.from(audioBase64, 'base64'));
    } else if (engine === 'live') {
      if (!ai || typeof pcm16kBase64 !== 'string') throw new Error('Gemini 또는 PCM 오디오 없음');
      output = await transcribeLive(ai, NATIVE_AUDIO_MODEL, pcm16kBase64);
    } else {
      res.status(400).json({ ok: false, error: 'unknown engine' });
      return;
    }
    res.json({ ok: true, engine, output, elapsedMs: Math.round(performance.now() - start) });
  } catch (err: any) {
    console.warn(`[SttBench] ${engine} error:`, err?.message || err);
    apiError(res, 500, 'STT_BENCH_FAILED', '받아쓰기에 실패했어요.', { engine });
  }
});

app.post('/api/mistakes/clusters', requireAuth, clusterLimit, async (req: Request, res: Response) => {
  const validated = validateClusterRequestBody(req.body);
  if (!validated.ok) {
    apiError(res, 400, 'BAD_REQUEST', '잘못된 요청이에요.');
    return;
  }

  try {
    const result = await computeMistakeClusters(
      { getGenAI: createGenAI },
      res.locals.user.uid,
      validated.items
    );
    res.json(result);
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    console.warn(`[MistakeClusters] unexpected error name=${name}`);
    res.json({
      ok: true,
      enabled: false,
      clusters: [],
      disabledReason: 'unavailable',
      usage: { inputTokens: 0, outputTokens: 0, sieEmbeddingTokens: 0 },
    });
  }
});

app.get(['/healthz', '/api/health', '/health'], (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Unknown /api routes: JSON 404 instead of falling through to the SPA index.html
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: 'not found' });
});

// Setup Server & WebSockets for the Gemini Live native audio dialog (LIVE_MODEL)
async function startServer() {
  const server = http.createServer(app);

  // Setup WebSocket Server for Live Native Audio Dialog
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    try {
      const pathname = new URL(request.url || '/', 'http://localhost').pathname;
      if (pathname === '/live' || pathname === '/api/gemini/live') {
        // Auth: Firebase ID token in ?token= (browsers cannot set headers on WebSocket).
        const token = new URL(request.url || '/', 'http://localhost').searchParams.get('token') || '';
        verifyFirebaseIdToken(token)
          .then(async (user) => {
            if (needsUserKey()) await ensureUserGeminiKey(token, user.uid).catch(() => {});
            const lim = checkLiveSessionStart(user.uid);
            if (!lim.ok) {
              console.warn('[Gemini Live] stage=ws_rate_limited', user.uid);
              const body = JSON.stringify({ ok: false, error: lim.error, code: 'rate_limited' });
              socket.write(`HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
              socket.destroy();
              return;
            }
            wss.handleUpgrade(request, socket, head, (ws) => {
              wss.emit('connection', ws, request);
            });
          })
          .catch((err) => {
            console.warn('[Gemini Live] stage=ws_auth_failed', err?.message || err);
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
          });
      } else {
        socket.destroy();
      }
    } catch {
      socket.destroy();
    }
  });

  wss.on('connection', async (clientWs: WebSocket, req) => {
    let liveSession: any = null;
    let initStarted = false;
    let isConnected = true;

    clientWs.on('close', () => {
      isConnected = false;
      try {
        liveSession?.close?.();
      } catch {
        // ignore
      }
    });

    clientWs.on('error', (err) => {
      console.error('Client WS error:', err);
    });

    clientWs.on('message', async (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString());

        // Init message to start Native Audio session
        if (msg.type === 'init') {
          // One Live session per socket: a repeated init would leave the first session open.
          if (liveSession || initStarted) return;
          initStarted = true;
          const voiceName = normalizeVoiceName(msg.voiceName);
          const systemInstruction = msg.systemInstruction || 'You are a friendly English conversation tutor on a phone call. Speak natural, simple American English in short turns, and keep the learner talking.';

          console.log('[Gemini Live] stage=init_received');
          const ai = createGenAI();
          if (!ai) {
            console.warn('[Gemini Live] stage=no_api_key -> fallback_required');
            clientWs.send(JSON.stringify({
              type: 'fallback_required',
              error: 'API Key not configured',
              userMessage: NO_KEY_MESSAGE,
            }));
            setTimeout(() => { try { clientWs.close(1011, 'no api key'); } catch { /* ignore */ } }, 100);
            return;
          }

          const createLiveCallbacks = () => ({
            onmessage: (serverMsg: any) => {
              if (!isConnected) return;
              const parts = serverMsg.serverContent?.modelTurn?.parts;
              if (Array.isArray(parts)) {
                for (const part of parts) {
                  if (part.inlineData?.data) {
                    clientWs.send(JSON.stringify({
                      type: 'audio',
                      audio: part.inlineData.data,
                      mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000',
                    }));
                  }
                  if (part.text) {
                    clientWs.send(JSON.stringify({
                      type: 'text',
                      text: part.text,
                    }));
                  }
                }
              }

              // Forward official Gemini Live speech-to-text transcriptions
              if (serverMsg.serverContent?.inputTranscription?.text) {
                clientWs.send(JSON.stringify({
                  type: 'input_transcript',
                  text: serverMsg.serverContent.inputTranscription.text,
                }));
              }

              if (serverMsg.serverContent?.outputTranscription?.text) {
                clientWs.send(JSON.stringify({
                  type: 'output_transcript',
                  text: serverMsg.serverContent.outputTranscription.text,
                }));
              }

              if (serverMsg.usageMetadata && typeof serverMsg.usageMetadata === 'object') {
                const usageMetadata = sanitizeLiveUsageMetadata(serverMsg.usageMetadata);
                if (usageMetadata) {
                  clientWs.send(JSON.stringify({
                    type: 'usage_metadata',
                    usageMetadata,
                  }));
                }
              }

              if (serverMsg.serverContent?.turnComplete) {
                clientWs.send(JSON.stringify({ type: 'turnComplete' }));
              }

              if (serverMsg.serverContent?.interrupted) {
                clientWs.send(JSON.stringify({ type: 'interrupted' }));
              }

              // Forward session resumption update
              if (serverMsg.sessionResumptionUpdate) {
                clientWs.send(JSON.stringify({
                  type: 'session_resumption_update',
                  handle: serverMsg.sessionResumptionUpdate.newHandle,
                  resumable: serverMsg.sessionResumptionUpdate.resumable,
                }));
              }

              // Forward GoAway event
              if (serverMsg.goAway) {
                clientWs.send(JSON.stringify({
                  type: 'go_away',
                  timeLimit: serverMsg.goAway.timeLimit,
                }));
              }
            },
            onerror: (err: any) => {
              console.error('Gemini Live session error:', err);
              if (isConnected) {
                clientWs.send(JSON.stringify({ type: 'error', error: 'live_session_error' }));
              }
            },
            onclose: () => {
              if (isConnected) {
                clientWs.send(JSON.stringify({ type: 'sessionClosed' }));
              }
            },
          });

          // Target Language configuration: ignore client languageCode, share fixed LIVE_LANGUAGE_CODE across paths
          const configsToTry = buildLiveConfigAttempts({
            voiceName,
            systemInstruction,
            resumeHandle: msg.resumeHandle,
          });

          let activeLock: string | null = LIVE_LANGUAGE_CODE;
          let activeModel = NATIVE_AUDIO_MODEL;
          let connectError: any = null;

          for (const modelToTry of LIVE_MODELS) {
            for (const attempt of configsToTry) {
              if (!isConnected) break;
              try {
                console.log(`[Gemini Live] stage=live_connect model=${modelToTry} (${attempt.desc})`);
                const connectPromise = ai.live.connect({
                  model: modelToTry,
                  config: attempt.config,
                  callbacks: createLiveCallbacks(),
                });
                let timedOut = false;
                let timeoutHandle: NodeJS.Timeout | undefined;
                const timeoutPromise = new Promise<never>((_, rej) => {
                  timeoutHandle = setTimeout(() => {
                    timedOut = true;
                    rej(new Error(`Live connect timeout after ${LIVE_CONNECT_TIMEOUT_MS}ms`));
                  }, LIVE_CONNECT_TIMEOUT_MS);
                });
                // If the connect resolves after we gave up, close that orphan session.
                connectPromise.then((late: any) => { if (timedOut) { try { late?.close?.(); } catch { /* ignore */ } } }).catch(() => {});
                try {
                  liveSession = await Promise.race([connectPromise, timeoutPromise]);
                } finally {
                  if (timeoutHandle) clearTimeout(timeoutHandle);
                }
                activeLock = attempt.lock;
                activeModel = modelToTry;
                console.log(`[Gemini Live] Successfully connected with ${modelToTry}: ${attempt.desc} (languageLock: ${activeLock})`);
                break;
              } catch (err: any) {
                connectError = err;
                console.warn(`[Gemini Live] Attempt with "${modelToTry}" / "${attempt.desc}" rejected:`, err?.message || err);
              }
            }
            if (liveSession) break;
          }

          if (liveSession && !isConnected) {
            try { liveSession.close?.(); } catch { /* ignore */ }
            liveSession = null;
          } else if (liveSession) {
            console.log('[Gemini Live] stage=ready_sent');
            clientWs.send(JSON.stringify({
              type: 'ready',
              model: activeModel,
              modelName: `${activeModel} (Live native audio)`,
              languageLock: activeLock,
            }));
          } else {
            console.error('Failed to establish Gemini Live session across all configurations:', connectError);
            clientWs.send(JSON.stringify({
              type: 'fallback_required',
              error: 'live_connect_failed',
              userMessage: /timeout/i.test(String(connectError?.message))
                ? '튜터 연결이 너무 오래 걸려요. 잠시 후 다시 시도해 주세요.'
                : '튜터 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.',
            }));
          }
        } else if (msg.type === 'realtime_audio' && liveSession) {
          // Forward mic PCM audio chunk to Gemini Native Audio
          try {
            liveSession.sendRealtimeInput({
              audio: {
                data: msg.audio,
                mimeType: msg.mimeType || 'audio/pcm;rate=16000',
              },
            });
          } catch (sendErr) {
            console.error('Error forwarding mic audio to Live session:', sendErr);
          }
        } else if (msg.type === 'text_prompt' && liveSession) {
          try {
            liveSession.sendRealtimeInput({
              text: msg.text,
            });
          } catch (sendErr) {
            console.error('Error forwarding text to Live session:', sendErr);
          }
        } else if (msg.type === 'control_command' && liveSession) {
          const commandPrompts: Record<string, string> = {
            Done: "Done. (I have finished my answer. Please provide concise feedback, estimated level, and AL upgrade expression under 40 seconds.)",
            Feedback: "Feedback. (Please provide quick feedback on what I just said.)",
            "Model answer": "Model answer. (Please give a 60-second AL model answer to this question using my details.)",
            Pause: "Pause. (Let's pause here. How did I sound in this scene?)",
            Slow: "Please speak a bit slower and enunciate clearly.",
          };
          const prompt = commandPrompts[msg.command] || msg.command;
          try {
            liveSession.sendRealtimeInput({ text: prompt });
          } catch (cmdErr) {
            console.error('Error forwarding control command to Live session:', cmdErr);
          }
        } else if (msg.type === 'interrupt' && liveSession) {
          try {
            // Signal liveSession client interrupt via official SDK method
            if (typeof liveSession.sendClientContent === 'function') {
              liveSession.sendClientContent({ turnComplete: true });
            } else if (typeof liveSession.send === 'function') {
              liveSession.send({ clientContent: { turnComplete: true } });
            }
          } catch (intErr) {
            console.error('Error forwarding interrupt to Live session:', intErr);
          }
        }
      } catch (parseErr: any) {
        console.error('WS message parse error:', parseErr);
        // Never leave the client waiting for 'ready' on an unexpected failure.
        if (!liveSession && clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'fallback_required', error: 'init_failed' }));
        }
      }
    });
  });

  const serveBuiltApp = () => {
    const distPath = path.resolve(__dirname, 'dist');
    const indexPath = path.resolve(distPath, 'index.html');
    app.use(express.static(distPath));
    app.use((_req: Request, res: Response) => {
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(200).send('<!doctype html><html><body>Initializing...</body></html>');
      }
    });
  };

  if (!isProd) {
    // Dev: Vite middleware. If NODE_ENV was not set on a deployed server where dev packages are
    // not installed, fall back to the built app instead of crashing on the missing vite import.
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          host: '0.0.0.0',
          port: PORT,
        },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } catch (err: any) {
      console.warn('[Server] Vite dev server unavailable, serving the built app from dist/:', err?.message || err);
      serveBuiltApp();
    }
  } else {
    serveBuiltApp();
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Full-Stack Server] One Call English (${NATIVE_AUDIO_MODEL}) running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

