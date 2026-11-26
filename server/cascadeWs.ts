/**
 * EL-18 Google-streaming test mode (PoC): one browser WebSocket on POC_WS_PATH = one
 * CascadeSession. Auth and the Live session rate limit run in server.ts before the upgrade.
 * The API key stays inside the injected GoogleGenAI client; nothing here logs keys or audio.
 */
import {
  POC_STT_MODEL,
  POC_TEXT_VARIANTS,
  POC_TTS_MODEL,
  parsePocFirstTts,
  parsePocTextVariant,
  pocFirstTtsModel,
} from '../src/config/cascadePoc.ts';
import { normalizeVoiceName } from '../src/config/voices.ts';
import { CascadeSession, createGeminiCascadeAi } from './cascadeSession.ts';
import type { CascadeAi, CascadeModels } from './cascadeSession.ts';

/** Minimal socket surface used here (ws.WebSocket satisfies it). */
export interface CascadeClientSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: unknown) => void): unknown;
}

export interface CascadeWsDeps {
  /** GoogleGenAI client or null when the server has no usable key. */
  getGenAI: () => unknown | null;
  /** v1beta client for 3.8 TTS streaming (Interactions API); falls back to getGenAI's client. */
  getTtsGenAI?: () => unknown | null;
  /** Test seam: build the cascade AI from the client (defaults to the real Gemini adapter). */
  makeAi?: (genAI: unknown, models: CascadeModels) => CascadeAi;
  log?: (line: string) => void;
}

const OPEN = 1;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export function handleCascadeConnection(clientWs: CascadeClientSocket, deps: CascadeWsDeps): void {
  const log = deps.log ?? console.log;
  let session: CascadeSession | null = null;
  let initStarted = false;

  const send = (msg: Record<string, unknown>) => {
    if (clientWs.readyState !== OPEN) return;
    try {
      clientWs.send(JSON.stringify(msg));
    } catch {
      // ignore: the socket is closing
    }
  };

  clientWs.on('close', () => {
    session?.close('client_closed');
    session = null;
  });
  clientWs.on('error', (err) => {
    log(`[poc] stage=client_ws_error msg=${(err as any)?.message || String(err)}`);
  });

  clientWs.on('message', (data) => {
    let msg: any;
    try {
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      if (text.length > MAX_MESSAGE_BYTES) return;
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'init') {
      if (initStarted) return;
      initStarted = true;
      // Only "a"/"b" and "full"/"lite" are read from the client; model IDs always come from cascadePoc.ts.
      const textVariant = parsePocTextVariant(msg.textVariant);
      const firstTts = parsePocFirstTts(msg.firstTts);
      const ttsFirstModel = pocFirstTtsModel(firstTts);
      const variant = POC_TEXT_VARIANTS[textVariant];
      const models: CascadeModels = {
        stt: POC_STT_MODEL,
        text: variant.model,
        tts: POC_TTS_MODEL,
        ttsFirst: ttsFirstModel,
        thinkingLevel: variant.thinkingLevel,
      };
      log(`[poc] stage=init_received variant=${textVariant} textModel=${models.text} firstTts=${firstTts} ttsFirstModel=${ttsFirstModel}`);
      const genAI = deps.getGenAI();
      if (!genAI) {
        log('[poc] stage=no_api_key -> fallback_required');
        send({ type: 'fallback_required', error: 'cascade_connect_failed' });
        return;
      }
      const ai = deps.makeAi
        ? deps.makeAi(genAI, models)
        : createGeminiCascadeAi(genAI, models, deps.getTtsGenAI?.() ?? undefined);
      session = new CascadeSession(
        { ai, send, log },
        {
          systemInstruction: typeof msg.systemInstruction === 'string' ? msg.systemInstruction : '',
          voiceName: normalizeVoiceName(msg.voiceName),
          history: msg.history,
          textVariant,
          firstTts,
        }
      );
      session.start().catch((err) => {
        log(`[poc] stage=start_failed msg=${(err as any)?.message || String(err)}`);
        send({ type: 'fallback_required', error: 'cascade_connect_failed' });
      });
      return;
    }
    session?.handleClientMessage(msg);
  });
}
