import { ChatTurn } from '../types';

export const GeminiErrors = {
  TIMEOUT: '시간 초과',
  NO_INTERNET: '인터넷 없음',
  EMPTY: '빈 응답',
  CANCELLED: '취소됨',

  parseApiError(body: string): { code?: number; status?: string; reason?: string } {
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
      };
    } catch {
      return {};
    }
  },

  httpReason(httpCode: number, body: string): string {
    const e = this.parseApiError(body);
    const status = e.status;
    const reason = e.reason;
    const keyProblem = reason?.startsWith('API_KEY');

    if (keyProblem) return `키 오류(${reason})`;
    if (httpCode === 404) return `모델 없음(404 ${status || 'NOT_FOUND'})`;
    if (httpCode === 429) return '한도 초과(429)';
    if (httpCode === 401 || httpCode === 403) return `권한 없음(${httpCode} ${reason || status || 'PERMISSION_DENIED'})`;
    if (httpCode === 400 && status === 'FAILED_PRECONDITION') return '사용 불가(400 FAILED_PRECONDITION)';
    if (httpCode === 400) return `요청 오류(400 ${reason || status || 'INVALID_ARGUMENT'})`;
    if (httpCode === 408 || httpCode === 504) return `${this.TIMEOUT}(${httpCode})`;
    if (httpCode >= 500 && httpCode <= 599) return `서버 오류(${httpCode}${status ? ' ' + status : ''})`;
    return `HTTP 오류(${httpCode}${status ? ' ' + status : ''})`;
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
  MODEL_ID: 'gemini-2.5-flash-lite',
  LEGACY_MODEL_ID: 'gemini-3.5-flash-lite',
  TIMEOUT_MS: 8000,
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

  buildRequestBody(systemInstruction: string, turns: ChatTurn[]) {
    const merged: ChatTurn[] = [];
    for (const turn of turns) {
      const t = turn.text.trim();
      if (!t) continue;
      const last = merged[merged.length - 1];
      if (last && last.role === turn.role) {
        last.text = last.text + '\n' + t;
      } else {
        merged.push({ role: turn.role, text: t });
      }
    }
    if (merged.length > 0 && merged[0].role === 'model') {
      merged.unshift({ role: 'user', text: '(통화 연결됨)' });
    }

    const contents = merged.map((turn) => ({
      role: turn.role === 'model' ? 'model' : 'user',
      parts: [{ text: turn.text }],
    }));

    return {
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      contents,
      generationConfig: {
        maxOutputTokens: this.MAX_OUTPUT_TOKENS,
        candidateCount: 1,
      },
    };
  },

  async executeRequest(
    apiKey: string,
    systemInstruction: string,
    turns: ChatTurn[],
    signal?: AbortSignal
  ): Promise<{ text: string; networkMs: number; modelVersion?: string }> {
    const startedAt = performance.now();
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.MODEL_ID}:generateContent`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.TIMEOUT_MS);
    if (signal) {
      signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const body = this.buildRequestBody(systemInstruction, turns);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const elapsed = Math.round(performance.now() - startedAt);
      const responseText = await res.text();

      if (!res.ok) {
        throw new Error(GeminiErrors.httpReason(res.status, responseText));
      }

      const parsed = JSON.parse(responseText);
      const candidate = parsed.candidates?.[0];
      if (!candidate || !candidate.content?.parts) {
        throw new Error(GeminiErrors.emptyReason(responseText));
      }

      let reply = '';
      for (const part of candidate.content.parts) {
        if (part.thought) continue;
        if (part.text) reply += part.text;
      }

      const sanitized = this.sanitizeForSpeech(reply);
      if (!sanitized) {
        throw new Error(GeminiErrors.emptyReason(responseText));
      }

      return {
        text: sanitized,
        networkMs: elapsed,
        modelVersion: parsed.modelVersion || this.MODEL_ID,
      };
    } catch (e) {
      if (e instanceof Error && (e.message.startsWith('키 오류') || e.message.startsWith('권한 없음') || e.message.startsWith('한도 초과') || e.message.startsWith('빈 응답'))) {
        throw e;
      }
      throw new Error(GeminiErrors.exceptionReason(e, controller.signal.aborted));
    } finally {
      clearTimeout(timeout);
    }
  },

  async testKey(apiKey: string): Promise<{ ok: boolean; label: string }> {
    try {
      const res = await this.executeRequest(
        apiKey,
        '짧게 한 단어로만 답해.',
        [{ role: 'user', text: '연결 테스트야. 응 이라고만 답해.' }]
      );
      return {
        ok: true,
        label: `연결 성공 (${res.modelVersion || this.MODEL_ID})`,
      };
    } catch (e) {
      return {
        ok: false,
        label: `연결 실패: ${e instanceof Error ? e.message : '오류'}`,
      };
    }
  },
};
