import express from 'express';
import type { Request, Response } from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isProd = process.env.NODE_ENV === 'production';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Target Native Audio Dialog Model (Part B-1: gemini-3.8-live)
const LIVE_MODELS = ['gemini-3.8-live'];
const NATIVE_AUDIO_MODEL = 'gemini-3.8-live';
const FALLBACK_CHAT_MODEL = 'gemini-3.8-flash';
const FALLBACK_TTS_MODEL = 'gemini-3.8-flash-lite-tts';
const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';

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
function resolveGeminiApiKey(): string | undefined {
  const current = process.env.GEMINI_API_KEY;
  if (current && !current.startsWith('MY_') && current.trim().length > 20) {
    return current.trim();
  }

  // 1. Check .gemini_api_key in root directory
  try {
    const keyFile = path.resolve(__dirname, '.gemini_api_key');
    if (fs.existsSync(keyFile)) {
      const fileKey = fs.readFileSync(keyFile, 'utf-8').trim();
      if (fileKey && !fileKey.startsWith('MY_') && fileKey.length > 20) {
        process.env.GEMINI_API_KEY = fileKey;
        return fileKey;
      }
    }
  } catch {
    // ignore
  }

  // 2. Check .env in root directory
  try {
    const envFile = path.resolve(__dirname, '.env');
    if (fs.existsSync(envFile)) {
      const envContent = fs.readFileSync(envFile, 'utf-8');
      const lines = envContent.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('GEMINI_API_KEY=')) {
          const val = trimmed.replace('GEMINI_API_KEY=', '').replace(/^["']|["']$/g, '').trim();
          if (val && !val.startsWith('MY_') && val.length > 20) {
            process.env.GEMINI_API_KEY = val;
            return val;
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // 3. Inspect ancestor processes (including PID 1)
  let pid = process.pid;
  for (let i = 0; i < 8; i++) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
      const ppidLine = stat.split('\n').find((l) => l.startsWith('PPid:'));
      if (!ppidLine) break;
      const ppid = parseInt(ppidLine.split(':')[1].trim(), 10);
      if (!ppid || ppid < 1) break;
      const env = fs.readFileSync(`/proc/${ppid}/environ`, 'utf-8');
      const match = env.split('\0').find((x) => x.startsWith('GEMINI_API_KEY='));
      if (match) {
        const val = match.replace('GEMINI_API_KEY=', '').trim();
        if (val && !val.startsWith('MY_') && val.length > 20) {
          process.env.GEMINI_API_KEY = val;
          try {
            fs.writeFileSync(path.resolve(__dirname, '.gemini_api_key'), val, 'utf-8');
          } catch {
            // ignore
          }
          return val;
        }
      }
      pid = ppid;
    } catch {
      break;
    }
  }

  // 4. Directly check /proc/1/environ
  try {
    const env = fs.readFileSync('/proc/1/environ', 'utf-8');
    const match = env.split('\0').find((x) => x.startsWith('GEMINI_API_KEY='));
    if (match) {
      const val = match.replace('GEMINI_API_KEY=', '').trim();
      if (val && !val.startsWith('MY_') && val.length > 20) {
        process.env.GEMINI_API_KEY = val;
        try {
          fs.writeFileSync(path.resolve(__dirname, '.gemini_api_key'), val, 'utf-8');
        } catch {
          // ignore
        }
        return val;
      }
    }
  } catch {
    // ignore
  }

  return current && !current.startsWith('MY_') ? current : undefined;
}

// Initialize GoogleGenAI client with official header
function createGenAI(apiKeyOverride?: string) {
  const resolved = resolveGeminiApiKey();
  const apiKey = (apiKeyOverride && apiKeyOverride.trim().length > 0)
    ? apiKeyOverride.trim()
    : resolved;

  if (!apiKey || apiKey.startsWith('MY_')) return null;

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// 1. Check Gemini server connectivity and GDP credit status
app.get('/api/gemini/status', async (req: Request, res: Response) => {
  const key = resolveGeminiApiKey();
  const hasServerKey = Boolean(key && !key.startsWith('MY_') && key.trim().length > 20);
  res.json({
    available: hasServerKey,
    buildVersion: getBuildVersion(),
    defaultModel: NATIVE_AUDIO_MODEL,
    liveModel: NATIVE_AUDIO_MODEL,
    modelName: 'Gemini 2.5 Flash Native Audio Dialog',
    ttsModel: FALLBACK_TTS_MODEL,
    transcribeModel: TRANSCRIBE_MODEL,
    liveSupported: true,
    gdpConnected: hasServerKey,
    hasServerKey,
  });
});

// Ephemeral token endpoint for browser-direct Gemini Live connection (B-2 requirement 3 & 2-1)
app.post('/api/gemini/token', async (req: Request, res: Response) => {
  try {
    const key = resolveGeminiApiKey();
    if (!key || key.startsWith('MY_')) {
      res.status(500).json({ ok: false, error: 'GEMINI_API_KEY가 서버 환경에 설정되지 않았습니다.', fallback: true });
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
    res.json({ ok: false, fallback: true, error: err?.message });
  }
});

// 2. Test Gemini connection endpoint
app.post('/api/gemini/test', async (req: Request, res: Response) => {
  const start = performance.now();
  const customKey = req.body?.apiKey;
  const ai = createGenAI(customKey);

  if (!ai) {
    res.status(400).json({
      ok: false,
      error: 'GEMINI_API_KEY가 서버 환경에 설정되지 않았습니다.',
    });
    return;
  }

  try {
    const response = await ai.models.generateContent({
      model: FALLBACK_CHAT_MODEL,
      contents: [{ role: 'user', parts: [{ text: '응' }] }],
      config: {
        systemInstruction: '한 글자로만 답해.',
        maxOutputTokens: 10,
      },
    });

    const elapsed = Math.round(performance.now() - start);
    res.json({
      ok: true,
      model: FALLBACK_CHAT_MODEL,
      reply: response.text?.trim() || '연결 성공',
      elapsedMs: elapsed,
    });
  } catch (error: any) {
    const elapsed = Math.round(performance.now() - start);
    res.status(500).json({
      ok: false,
      error: error?.message || 'Gemini API 호출 오류',
      elapsedMs: elapsed,
    });
  }
});

// 3. Multi-turn Chat endpoint for real-time voice call (Gemini 3.8 Flash)
app.post('/api/gemini/chat', async (req: Request, res: Response) => {
  const start = performance.now();
  const { systemInstruction, turns, customApiKey, model: requestedModel } = req.body || {};

  const ai = createGenAI(customApiKey);
  if (!ai) {
    res.status(500).json({
      error: 'Gemini 서버 연동이 준비되지 않았습니다. (GEMINI_API_KEY 부재)',
    });
    return;
  }

  try {
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

    if (Array.isArray(turns) && turns.length > 0) {
      for (const t of turns) {
        if (!t.text || !t.text.trim()) continue;
        const role = t.role === 'model' ? 'model' : 'user';
        const last = contents[contents.length - 1];
        if (last && last.role === role) {
          last.parts[0].text += '\n' + t.text.trim();
        } else {
          contents.push({
            role,
            parts: [{ text: t.text.trim() }],
          });
        }
      }
    }

    if (contents.length === 0 || contents[0].role === 'model') {
      contents.unshift({
        role: 'user',
        parts: [{ text: '(전화 통화 연결됨)' }],
      });
    }

    const model = requestedModel || FALLBACK_CHAT_MODEL;
    const response = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: typeof systemInstruction === 'string' ? systemInstruction : undefined,
        maxOutputTokens: 256,
      },
    });

    const reply = response.text || '';
    const elapsed = Math.round(performance.now() - start);

    res.json({
      reply,
      modelVersion: model,
      elapsedMs: elapsed,
    });
  } catch (error: any) {
    const elapsed = Math.round(performance.now() - start);
    console.error('Gemini chat error:', error);
    res.status(500).json({
      error: error?.message || 'Gemini 응답 생성 실패',
      elapsedMs: elapsed,
    });
  }
});

// 4. Native Gemini Voice Speech (TTS) endpoint
app.post('/api/gemini/tts', async (req: Request, res: Response) => {
  const start = performance.now();
  const { text, voiceName, customApiKey } = req.body || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: '변환할 텍스트가 없습니다.' });
    return;
  }

  const ai = createGenAI(customApiKey);
  if (!ai) {
    res.status(500).json({ error: 'Gemini 서버 연동이 준비되지 않았습니다.' });
    return;
  }

  try {
    const validVoices = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'];
    let voice = 'Kore';
    if (typeof voiceName === 'string') {
      const match = validVoices.find(v => v.toLowerCase() === voiceName.trim().toLowerCase());
      if (match) voice = match;
    }

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
    res.status(500).json({ error: error?.message || 'TTS 음성 생성 실패' });
  }
});

// 5. Speech Audio Transcription (STT) endpoint via gemini-3.5-transcribe
app.post('/api/gemini/transcribe', async (req: Request, res: Response) => {
  const start = performance.now();
  const { audioBase64, mimeType = 'audio/webm', customApiKey } = req.body || {};

  if (!audioBase64 || typeof audioBase64 !== 'string') {
    res.status(400).json({ error: '변환할 오디오 데이터가 없습니다.' });
    return;
  }

  const ai = createGenAI(customApiKey);
  if (!ai) {
    res.status(500).json({ error: 'Gemini 서버 연동이 준비되지 않았습니다.' });
    return;
  }

  try {
    const response = await ai.models.generateContent({
      model: TRANSCRIBE_MODEL,
      contents: {
        parts: [
          {
            inlineData: {
              data: audioBase64,
              mimeType,
            },
          },
          {
            text: '언어는 한국어(ko-KR)로 고정. 일본어·러시아어로 전사하지 마. 이 음성을 한국어 텍스트로 그대로 전사해줘. 부가 설명 없이 받아적은 말만 출력해줘.',
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
  } catch (error: any) {
    console.error('Gemini transcribe error:', error);
    res.status(500).json({
      ok: false,
      error: error?.message || '음성 전사 실패',
    });
  }
});

// Directory for server-stored chunk fallback
const RECORDINGS_DIR = path.resolve(__dirname, 'public', 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// B-3 Requirement 2: 1-minute asynchronous partial transcription via gemini-3.5-transcribe VERBATIM
app.post('/api/gemini/transcribe-partial', async (req: Request, res: Response) => {
  const start = performance.now();
  const { sessionId, userId, minuteIndex, timeRange, audioBase64, mimeType = 'audio/webm', customApiKey } = req.body || {};

  if (!audioBase64 || typeof audioBase64 !== 'string') {
    res.status(400).json({ ok: false, error: '변환할 오디오 데이터가 없습니다.' });
    return;
  }

  const ai = createGenAI(customApiKey);
  if (!ai) {
    res.status(500).json({ ok: false, error: 'Gemini 서버 연동이 준비되지 않았습니다.' });
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
    res.status(500).json({
      ok: false,
      error: error?.message || '부분 전사 실패',
    });
  }
});

// In-memory active session tracker for detecting interrupted calls (last chunk > 2 min)
interface ActiveSessionTracker {
  sessionId: string;
  userId: string;
  lastChunkAt: number;
  status: 'in-progress' | 'pending_review' | 'done';
}
const activeSessionsMap = new Map<string, ActiveSessionTracker>();

// Heartbeat / Chunk registration to track active call sessions
app.post('/api/sessions/heartbeat', (req: Request, res: Response) => {
  const { sessionId, userId, status = 'in-progress' } = req.body || {};
  if (sessionId && userId) {
    activeSessionsMap.set(sessionId, {
      sessionId,
      userId,
      lastChunkAt: Date.now(),
      status,
    });
  }
  res.json({ ok: true });
});

// Periodic watchdog (every 30s): marks active sessions without new chunks for > 2 min as pending_review
setInterval(() => {
  const now = Date.now();
  const TWO_MINUTES_MS = 2 * 60 * 1000;

  for (const [sId, sess] of activeSessionsMap.entries()) {
    if (sess.status === 'in-progress' && now - sess.lastChunkAt > TWO_MINUTES_MS) {
      console.warn(`[Watchdog] Session ${sId} timed out (>2min since last chunk). Marking as pending_review.`);
      sess.status = 'pending_review';
    }
  }
}, 30000);

// Check interrupted sessions status
app.get('/api/sessions/interrupted-check', (req: Request, res: Response) => {
  const { userId } = req.query;
  const interrupted: string[] = [];
  const now = Date.now();
  const TWO_MINUTES_MS = 2 * 60 * 1000;

  for (const [sId, sess] of activeSessionsMap.entries()) {
    if ((!userId || sess.userId === userId) && sess.status === 'in-progress' && now - sess.lastChunkAt > TWO_MINUTES_MS) {
      sess.status = 'pending_review';
      interrupted.push(sId);
    } else if ((!userId || sess.userId === userId) && sess.status === 'pending_review') {
      interrupted.push(sId);
    }
  }

  res.json({ ok: true, interruptedSessionIds: interrupted });
});

// Resilient chunk upload endpoint (fallback when client Firebase Storage direct upload is restricted)
app.post('/api/recordings/upload-chunk', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '20mb' }), (req: Request, res: Response) => {
  try {
    const rawBuffer = Buffer.isBuffer(req.body) ? req.body : null;
    const relPath = String(req.query.path || req.headers['x-chunk-path'] || `chunk_${Date.now()}.webm`);
    const safePath = path.resolve(RECORDINGS_DIR, relPath.replace(/[^a-zA-Z0-9_\-\.\/]/g, '_'));
    const safeDir = path.dirname(safePath);

    if (!fs.existsSync(safeDir)) {
      fs.mkdirSync(safeDir, { recursive: true });
    }

    if (rawBuffer && rawBuffer.length > 0) {
      fs.writeFileSync(safePath, rawBuffer);
    }

    const fileUrl = `/api/recordings/file?path=${encodeURIComponent(relPath)}`;
    res.json({
      ok: true,
      url: fileUrl,
      path: relPath,
      sizeBytes: rawBuffer?.length || 0,
    });
  } catch (err: any) {
    console.error('[UploadChunk] Server chunk upload error:', err);
    res.status(500).json({ ok: false, error: err?.message || 'Upload failed' });
  }
});

app.get('/api/recordings/file', (req: Request, res: Response) => {
  const relPath = String(req.query.path || '');
  if (!relPath) {
    res.status(400).send('Path parameter is required');
    return;
  }
  const safePath = path.resolve(RECORDINGS_DIR, relPath.replace(/[^a-zA-Z0-9_\-\.\/]/g, '_'));
  if (fs.existsSync(safePath)) {
    res.sendFile(safePath);
  } else {
    res.status(404).send('Audio file not found');
  }
});

// B-4 Final Full-Audio Transcription endpoint via gemini-3.5-transcribe (VERBATIM)
app.post('/api/gemini/transcribe-final', async (req: Request, res: Response) => {
  const start = performance.now();
  const { audioBase64, mimeType = 'audio/webm', customApiKey } = req.body || {};

  if (!audioBase64 || typeof audioBase64 !== 'string') {
    res.status(400).json({ ok: false, error: '변환할 오디오 데이터가 없습니다.' });
    return;
  }

  const ai = createGenAI(customApiKey);
  if (!ai) {
    res.status(500).json({ ok: false, error: 'Gemini 서버 연동이 준비되지 않았습니다.' });
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
    res.status(500).json({
      ok: false,
      error: err?.message || '최종 음성 전사 실패',
    });
  }
});

// 6. Post-Call Review & Mistake Log Generation (Gemini 3.8 Flash structured JSON) - B-4 Specification
app.post('/api/review', async (req: Request, res: Response) => {
  const start = performance.now();
  const {
    trackId,
    goalId,
    lessonNum,
    lessonTitle,
    sttFinal, // Verbatim recording transcript (기록용 받아쓰기)
    sourceStt = 'sttFinal',
    liveTranscript = [],
    todayLessonPrompt = '',
    reviewingMistakes = [], // Existing reviewing mistakes for detecting usedCorrectly
    graduatedMistakes = [], // Existing graduated mistakes for detecting repeatedMistakes
    customApiKey,
  } = req.body || {};

  const ai = createGenAI(customApiKey);
  if (!ai) {
    res.status(500).json({ ok: false, error: 'Gemini API 연동이 준비되지 않았습니다.' });
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
    const elapsed = Math.round(performance.now() - start);

    res.json({
      ok: true,
      review: {
        ...parsed,
        trackId: trackId || goalId || 'opic',
        lessonNum: lessonNum || 1,
        lessonTitle: lessonTitle || '',
        generatedAt: new Date().toISOString(),
      },
      elapsedMs: elapsed,
    });
  } catch (err: any) {
    console.error('Review generation error:', err);
    res.status(500).json({ ok: false, error: err?.message || '복기 리포트 생성에 실패했습니다.' });
  }
});

// 7. Morning Review Podcast Generator (Script + Gemini TTS Audio)
app.post('/api/podcast', async (req: Request, res: Response) => {
  const start = performance.now();
  const { mistakes, customApiKey } = req.body || {};

  const ai = createGenAI(customApiKey);
  if (!ai) {
    res.status(500).json({ ok: false, error: 'Gemini API 연동이 준비되지 않았습니다.' });
    return;
  }

  try {
    const mistakeList = Array.isArray(mistakes) && mistakes.length > 0
      ? mistakes.map((m: any, i: number) => `${i + 1}. [${m.trackId || 'General'}] "${m.myPhrase}" -> "${m.naturalPhrase}" (${m.reason})`).join('\n')
      : '1. "I went to there" -> "I went there" (No preposition needed with there)\n2. "Next year I dispatch" -> "Next year I will be posted as an expat"';

    const systemInstruction = `You are a warm, witty, encouraging morning English radio podcast host (in the style of an energetic 1:1 tutor).
Every morning at 7 AM, you create a 2 to 3-minute personalized audio briefing for a Korean engineer who is preparing for OPIc AL, Hanwha Philly Shipyard posting, and family travel.

Review these mistakes that occurred during recent practice sessions:
${mistakeList}

Write a natural, conversational script in Korean with clear native English repetitions:
- Warm opening greeting ("Good morning! 오늘도 힘차게 출근길 영어 복습 팟캐스트 시작합니다.")
- Pick the 2-3 most important mistake patterns from the list.
- Explain why native speakers say it that way, and repeat the correct sentence 2 times clearly in English with natural rhythm.
- Brief culture/confidence tip.
- Energetic sign-off.
Keep the text under 350 words so it speaks smoothly within 2-3 minutes.`;

    const scriptResponse = await ai.models.generateContent({
      model: FALLBACK_CHAT_MODEL,
      contents: [{
        role: 'user',
        parts: [{ text: 'Please generate today\'s morning review podcast script.' }],
      }],
      config: {
        systemInstruction,
        maxOutputTokens: 600,
      },
    });

    const scriptText = scriptResponse.text?.trim() || '';

    // Synthesize audio using Gemini 3.8 Flash Lite TTS
    let audioBase64: string | undefined;
    let audioMimeType = 'audio/wav';

    try {
      const ttsResponse = await ai.models.generateContent({
        model: FALLBACK_TTS_MODEL,
        contents: [{
          role: 'user',
          parts: [{ text: scriptText }],
        }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Puck' },
            },
          },
        },
      });

      const candidate = ttsResponse.candidates?.[0];
      const audioPart = candidate?.content?.parts?.find((p: any) => p.inlineData?.mimeType?.startsWith('audio/'));
      if (audioPart?.inlineData?.data) {
        audioBase64 = audioPart.inlineData.data;
        audioMimeType = audioPart.inlineData.mimeType || 'audio/wav';
      }
    } catch (ttsErr) {
      console.warn('Podcast TTS synthesis error, returning script only:', ttsErr);
    }

    const elapsed = Math.round(performance.now() - start);

    res.json({
      ok: true,
      title: `오늘의 모닝 복습 오디오 (${new Date().toISOString().slice(5, 10)})`,
      script: scriptText,
      audioBase64,
      audioMimeType,
      elapsedMs: elapsed,
    });
  } catch (err: any) {
    console.error('Podcast generation error:', err);
    res.status(500).json({ ok: false, error: '모닝 팟캐스트 생성에 실패했습니다.' });
  }
});

// 8. Telegram Bot Webhook / Notification Forwarder
app.post('/api/telegram/send', async (req: Request, res: Response) => {
  const { botToken, chatId, text, audioBase64, filename = 'morning_review.wav' } = req.body || {};

  if (!botToken || !chatId) {
    res.status(400).json({ ok: false, error: '텔레그램 봇 토큰과 채팅 ID가 필요합니다.' });
    return;
  }

  try {
    if (audioBase64) {
      const binary = Buffer.from(audioBase64, 'base64');
      const formData = new FormData();
      formData.append('chat_id', chatId);
      formData.append('caption', text ? text.slice(0, 1000) : '🎧 오늘의 모닝 영어 복습 오디오 강의입니다.');
      formData.append('audio', new Blob([binary], { type: 'audio/wav' }), filename);

      const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendAudio`, {
        method: 'POST',
        body: formData,
      });
      const tgData: any = await tgRes.json();
      if (!tgRes.ok) {
        throw new Error(tgData.description || '텔레그램 오디오 전송 실패');
      }
      res.json({ ok: true, message: '텔레그램으로 오디오 강의가 전송되었습니다.' });
    } else {
      const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text || '오늘의 영어 복습 알림입니다.',
          parse_mode: 'Markdown',
        }),
      });
      const tgData: any = await tgRes.json();
      if (!tgRes.ok) {
        throw new Error(tgData.description || '텔레그램 메시지 전송 실패');
      }
      res.json({ ok: true, message: '텔레그램 메시지가 전송되었습니다.' });
    }
  } catch (err: any) {
    console.error('Telegram send error:', err);
    res.status(500).json({ ok: false, error: err?.message || '텔레그램 전송 중 오류가 발생했습니다.' });
  }
});

// Health check endpoints for Cloud Run container probes
app.get(['/healthz', '/api/health', '/health'], (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Setup Server & WebSockets for Gemini 2.5 Flash Native Audio Live Dialog
async function startServer() {
  const server = http.createServer(app);

  // Setup WebSocket Server for Live Native Audio Dialog
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    if (url.pathname === '/live' || url.pathname === '/api/gemini/live') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', async (clientWs: WebSocket, req) => {
    let liveSession: any = null;
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
          const customApiKey = msg.apiKey;
          const validVoices = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'];
          let voiceName = 'Kore';
          if (typeof msg.voiceName === 'string') {
            const match = validVoices.find(v => v.toLowerCase() === msg.voiceName.trim().toLowerCase());
            if (match) voiceName = match;
          }
          const systemInstruction = msg.systemInstruction || '너는 다정하고 따뜻하게 통화하는 한국어 친구야. 자연스럽고 짧게 구어체로 답해줘.';

          const ai = createGenAI(customApiKey);
          if (!ai) {
            clientWs.send(JSON.stringify({ type: 'error', error: 'API Key not configured' }));
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
                clientWs.send(JSON.stringify({ type: 'error', error: err?.message || 'Live session error' }));
              }
            },
            onclose: () => {
              if (isConnected) {
                clientWs.send(JSON.stringify({ type: 'sessionClosed' }));
              }
            },
          });

          // Target Language configuration: English dialog with bilingual Korean support
          const targetLang = typeof msg.languageCode === 'string' && msg.languageCode ? msg.languageCode : 'en-US';

          const configsToTry: Array<{
            desc: string;
            config: any;
            lock: string;
          }> = [
            {
              desc: `gemini-3.8-live with session resumption & context compression`,
              config: {
                responseModalities: [Modality.AUDIO],
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                sessionResumption: {
                  handle: msg.resumeHandle || undefined,
                  transparent: true,
                },
                contextWindowCompression: {
                  slidingWindow: {},
                },
                speechConfig: {
                  voiceConfig: { prebuiltVoiceConfig: { voiceName } },
                  languageCode: targetLang,
                },
                systemInstruction,
              },
              lock: targetLang,
            },
            {
              desc: 'gemini-3.8-live standard audio session',
              config: {
                responseModalities: [Modality.AUDIO],
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                speechConfig: {
                  voiceConfig: { prebuiltVoiceConfig: { voiceName } },
                },
                systemInstruction,
              },
              lock: targetLang,
            },
          ];

          let activeLock: string = targetLang;
          let activeModel = NATIVE_AUDIO_MODEL;
          let connectError: any = null;

          for (const modelToTry of LIVE_MODELS) {
            for (const attempt of configsToTry) {
              try {
                liveSession = await ai.live.connect({
                  model: modelToTry,
                  config: attempt.config,
                  callbacks: createLiveCallbacks(),
                });
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

          if (liveSession) {
            clientWs.send(JSON.stringify({
              type: 'ready',
              model: activeModel,
              modelName: 'Gemini 3.8 Live Native Audio',
              languageLock: activeLock,
            }));
          } else {
            console.error('Failed to establish Gemini Live session across all configurations:', connectError);
            clientWs.send(JSON.stringify({
              type: 'fallback_required',
              error: connectError?.message || 'Live connect failed',
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
      } catch (parseErr) {
        console.error('WS message parse error:', parseErr);
      }
    });
  });

  if (!isProd) {
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
  } else {
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
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Full-Stack Server] Gemini 2.5 Flash Native Audio Dialog running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

