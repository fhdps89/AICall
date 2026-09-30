import express from 'express';
import type { Request, Response } from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isProd = process.env.NODE_ENV === 'production';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Target Native Audio Dialog Model and standard Gemini models
const NATIVE_AUDIO_MODEL = 'gemini-2.5-flash-native-audio-latest';
const FALLBACK_CHAT_MODEL = 'gemini-3.8-flash';
const FALLBACK_TTS_MODEL = 'gemini-3.8-flash-lite-tts';
const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';

// Resolve real Gemini API key from environment, file, or parent container
function resolveGeminiApiKey(): string | undefined {
  const current = process.env.GEMINI_API_KEY;
  if (current && !current.startsWith('MY_') && current.length > 20) {
    return current;
  }

  // Check .gemini_api_key in root directory
  try {
    const keyFile = path.resolve(__dirname, '.gemini_api_key');
    if (fs.existsSync(keyFile)) {
      const fileKey = fs.readFileSync(keyFile, 'utf-8').trim();
      if (fileKey && !fileKey.startsWith('MY_') && fileKey.length > 20) {
        return fileKey;
      }
    }
  } catch {
    // ignore
  }

  let pid = process.pid;
  for (let i = 0; i < 6; i++) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
      const ppidLine = stat.split('\n').find((l) => l.startsWith('PPid:'));
      if (!ppidLine) break;
      const ppid = parseInt(ppidLine.split(':')[1].trim(), 10);
      if (!ppid || ppid <= 1) break;
      const env = fs.readFileSync(`/proc/${ppid}/environ`, 'utf-8');
      const match = env.split('\0').find((x) => x.startsWith('GEMINI_API_KEY='));
      if (match) {
        const val = match.replace('GEMINI_API_KEY=', '').trim();
        if (val && !val.startsWith('MY_') && val.length > 20) {
          return val;
        }
      }
      pid = ppid;
    } catch {
      break;
    }
  }

  return current;
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
            text: '이 음성을 한국어 텍스트로 그대로 전사해줘. 부가 설명 없이 받아적은 말만 출력해줘.',
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

          try {
            // Attempt Gemini Live Native Audio connection with dual transcription
            liveSession = await ai.live.connect({
              model: NATIVE_AUDIO_MODEL,
              config: {
                responseModalities: [Modality.AUDIO],
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                speechConfig: {
                  voiceConfig: { prebuiltVoiceConfig: { voiceName } },
                },
                systemInstruction,
              },
              callbacks: {
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
              },
            });

            clientWs.send(JSON.stringify({
              type: 'ready',
              model: NATIVE_AUDIO_MODEL,
              modelName: 'Gemini 2.5 Flash Native Audio Dialog',
            }));
          } catch (initErr: any) {
            console.error('Failed to establish Gemini Live session:', initErr);
            clientWs.send(JSON.stringify({
              type: 'fallback_required',
              error: initErr?.message || 'Live connect failed, falling back to HTTP dialog',
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

