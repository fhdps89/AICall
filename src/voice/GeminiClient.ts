import { ChatTurn } from '../types';

export const GeminiErrors = {
  TIMEOUT: '시간 초과',
  NO_INTERNET: '인터넷 없음',
  EMPTY: '빈 응답',
  CANCELLED: '취소됨',

  parseApiError(body: string): { code?: number; status?: string; reason?: string; message?: string } {
    try {
      const parsed = JSON.parse(body);
      const err = parsed.error;
      if (!err) return {};
      let reason: string | undefined;
      if (Array.isArray(err.details)) {
        for (const d of err.details) {
          if (d?.reason && typeof d.reason === 'string') {
            reason = d.reason.trim();
            break;
          }
        }
      }
      return {
        code: err.code,
        status: err.status,
        reason,
        message: err.message,
      };
    } catch {
      return {};
    }
  },

  httpReason(httpCode: number, body: string): string {
    const e = this.parseApiError(body);
    const status = e.status;
    const reason = e.reason;
    const rawDetail = e.message || (body && body.length < 200 ? body.trim() : '');
    const message = rawDetail ? `\n구글 메시지: ${rawDetail}` : '';
    const keyProblem = reason?.startsWith('API_KEY');

    if (keyProblem) return `키 오류(${reason})${message}`;
    if (httpCode === 404) return `모델 없음(404 ${status || 'NOT_FOUND'})${message}`;
    if (httpCode === 429) return `한도 초과(429)${message}`;
    if (httpCode === 401 || httpCode === 403) {
      if (e.message && (e.message.includes('Generative Language API') || e.message.includes('has not been used in project') || e.message.includes('disabled'))) {
        return `권한 없음: 프로젝트에 Generative Language API가 활성화되지 않았습니다.${message}`;
      }
      return `권한 없음(${httpCode} ${reason || status || 'PERMISSION_DENIED'})${message}`;
    }
    if (httpCode === 400 && status === 'FAILED_PRECONDITION') return `사용 불가(400 FAILED_PRECONDITION)${message}`;
    if (httpCode === 400) return `요청 오류(400 ${reason || status || 'INVALID_ARGUMENT'})${message}`;
    if (httpCode === 408 || httpCode === 504) return `${this.TIMEOUT}(${httpCode})`;
    if (httpCode >= 500 && httpCode <= 599) return `서버 오류(${httpCode}${status ? ' ' + status : ''})${message}`;
    return `HTTP 오류(${httpCode}${status ? ' ' + status : ''})${message}`;
  },

  emptyReason(body: string): string {
    try {
      const root = JSON.parse(body);
      const block = root.promptFeedback?.blockReason || '';
      const finish = root.candidates?.[0]?.finishReason || '';
      const why = block || (finish && finish !== 'STOP' ? finish : '');
      return why ? `${this.EMPTY}(${why})` : this.EMPTY;
    } catch {
      return this.EMPTY;
    }
  },

  exceptionReason(e: unknown, cancelled = false): string {
    if (cancelled) return this.CANCELLED;
    if (e instanceof Error) {
      if (e.name === 'AbortError') return this.TIMEOUT;
      if (!navigator.onLine) return this.NO_INTERNET;
      return `오류(${e.message.slice(0, 30)})`;
    }
    return '오류';
  },
};

export const GeminiClient = {
  MODEL_ID: 'gemini-3.8-flash',
  MODEL_NAME: 'Gemini 2.5 Flash Native Audio Dialog',
  LIVE_MODEL_ID: 'gemini-2.5-flash-native-audio-latest',
  TTS_MODEL_ID: 'gemini-3.8-flash-lite-tts',
  TRANSCRIBE_MODEL_ID: 'gemini-3.5-transcribe',
  TIMEOUT_MS: 12000,
  MAX_OUTPUT_TOKENS: 256,

  sanitizeForSpeech(text: string): string {
    if (!text) return '';
    // Strip emojis
    let clean = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '');
    // Strip markdown headings, bullet points, numbered lists
    clean = clean.replace(/^[ \t]*([-*•]|\d+[.)])[ \t]+/gm, '');
    clean = clean.replace(/[*_#`>~|[\]]/g, '');
    clean = clean.replace(/\s+/g, ' ');
    return clean.trim();
  },

  async checkStatus(): Promise<{ available: boolean; defaultModel: string; modelName?: string; gdpConnected: boolean; liveSupported?: boolean }> {
    try {
      const res = await fetch('/api/gemini/status');
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // ignore
    }
    return {
      available: false,
      defaultModel: this.MODEL_ID,
      modelName: this.MODEL_NAME,
      gdpConnected: false,
      liveSupported: true,
    };
  },

  async executeRequest(
    apiKey: string,
    systemInstruction: string,
    turns: ChatTurn[],
    signal?: AbortSignal
  ): Promise<{ text: string; networkMs: number; modelVersion?: string }> {
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.TIMEOUT_MS);
    if (signal) {
      signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const res = await fetch('/api/gemini/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction,
          turns,
          customApiKey: apiKey?.trim() || undefined,
        }),
        signal: controller.signal,
      });

      const elapsed = Math.round(performance.now() - startedAt);
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || `HTTP 오류(${res.status})`);
      }

      const rawReply = data.reply || '';
      const sanitized = this.sanitizeForSpeech(rawReply);
      if (!sanitized) {
        throw new Error(GeminiErrors.EMPTY);
      }

      return {
        text: sanitized,
        networkMs: data.elapsedMs || elapsed,
        modelVersion: data.modelVersion || this.MODEL_ID,
      };
    } catch (e: any) {
      if (controller.signal.aborted) {
        throw new Error(GeminiErrors.TIMEOUT);
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  },

  async testKey(apiKey?: string): Promise<{ ok: boolean; label: string }> {
    try {
      const res = await fetch('/api/gemini/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey?.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.ok) {
        return {
          ok: true,
          label: `연결 성공 (${data.model || this.MODEL_ID} · GDP 크레딧 연동됨)`,
        };
      }
      return {
        ok: false,
        label: `연결 실패: ${data.error || '응답 오류'}`,
      };
    } catch (e: any) {
      return {
        ok: false,
        label: `연결 실패: ${e?.message || '서버 통신 오류'}`,
      };
    }
  },

  async executeTts(
    text: string,
    voiceName = 'Kore',
    apiKey?: string,
    signal?: AbortSignal
  ): Promise<{ audioBase64: string; mimeType: string; elapsedMs: number } | null> {
    try {
      const res = await fetch('/api/gemini/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voiceName,
          customApiKey: apiKey?.trim() || undefined,
        }),
        signal,
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      if (data.audioBase64) {
        return {
          audioBase64: data.audioBase64,
          mimeType: data.mimeType || 'audio/wav',
          elapsedMs: data.elapsedMs || 0,
        };
      }
      return null;
    } catch {
      return null;
    }
  },

  async executeTranscribe(
    audioBase64: string,
    mimeType = 'audio/webm',
    apiKey?: string,
    signal?: AbortSignal
  ): Promise<{ transcript: string; elapsedMs: number } | null> {
    try {
      const res = await fetch('/api/gemini/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64,
          mimeType,
          customApiKey: apiKey?.trim() || undefined,
        }),
        signal,
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      if (data.ok && typeof data.transcript === 'string') {
        return {
          transcript: data.transcript.trim(),
          elapsedMs: data.elapsedMs || 0,
        };
      }
      return null;
    } catch {
      return null;
    }
  },
};
