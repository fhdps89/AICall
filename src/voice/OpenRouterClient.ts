import { ChatTurn, TtsVoice } from '../types';
import { GeminiClient, GeminiErrors } from './GeminiClient';

export const OpenRouterErrors = {
  httpReason(httpCode: number, body: string): string {
    let message = '';
    try {
      const parsed = JSON.parse(body);
      message = parsed.error?.message || '';
    } catch {
      // ignore
    }
    const short = message.replace(/\s+/g, ' ').trim().slice(0, 60);
    const detail = short ? ` ${short}` : '';

    switch (httpCode) {
      case 401:
        return '키 오류(401)';
      case 402:
        return '크레딧 부족(402)';
      case 403:
        return `권한 없음(403${detail})`;
      case 404:
        return `모델 없음(404${detail})`;
      case 408:
      case 504:
        return `${GeminiErrors.TIMEOUT}(${httpCode})`;
      case 429:
        return '한도 초과(429)';
      case 400:
        return `요청 오류(400${detail})`;
      default:
        if (httpCode >= 500 && httpCode <= 599) return `서버 오류(${httpCode})`;
        return `HTTP 오류(${httpCode})`;
    }
  },
};

export const OpenRouterClient = {
  CHAT_ENDPOINT: 'https://openrouter.ai/api/v1/chat/completions',
  TTS_ENDPOINT: 'https://openrouter.ai/api/v1/audio/speech',
  CHAT_MODEL: 'google/gemini-3.5-flash-lite',
  MAX_TOKENS: 256,
  CHAT_FIRST_TOKEN_TIMEOUT_MS: 8000,
  CHAT_TOTAL_TIMEOUT_MS: 15000,
  TTS_TIMEOUT_MS: 6000,
  DEFAULT_RATE: 24000,
  GEMINI_TTS_STYLE: 'warm, casual, natural tone of a close friend in their twenties chatting on the phone',

  buildChatPayload(systemPrompt: string, turns: ChatTurn[], stream = true) {
    const merged: { role: string; content: string }[] = [];
    for (const turn of turns) {
      const text = turn.text.trim();
      if (!text) continue;
      const role = turn.role === 'model' ? 'assistant' : 'user';
      const last = merged[merged.length - 1];
      if (last && last.role === role) {
        last.content = last.content + '\n' + text;
      } else {
        merged.push({ role, content: text });
      }
    }
    if (merged.length > 0 && merged[0].role === 'assistant') {
      merged.unshift({ role: 'user', content: '(통화 연결됨)' });
    }

    const messages = [{ role: 'system', content: systemPrompt }, ...merged];

    return {
      model: this.CHAT_MODEL,
      messages,
      max_tokens: this.MAX_TOKENS,
      stream,
    };
  },

  buildTtsPayload(voice: TtsVoice, text: string) {
    const payload: Record<string, unknown> = {
      model: voice.model,
      input: text,
      voice: voice.voice,
      response_format: 'pcm',
    };

    if (voice.googleStyle) {
      payload.provider = {
        options: {
          'google-ai-studio': {
            speech_metadata: {
              style: this.GEMINI_TTS_STYLE,
            },
          },
        },
      };
    }
    return payload;
  },

  async streamChat(
    apiKey: string,
    systemPrompt: string,
    turns: ChatTurn[],
    onDelta: (delta: string) => void,
    signal?: AbortSignal
  ): Promise<{ text: string; networkMs: number; firstTokenMs?: number; model?: string }> {
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.CHAT_TOTAL_TIMEOUT_MS);

    if (signal) {
      signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const payload = this.buildChatPayload(systemPrompt, turns, true);
      const res = await fetch(this.CHAT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${apiKey}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(OpenRouterErrors.httpReason(res.status, errText));
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('스트림 읽기 실패');

      const decoder = new TextDecoder('utf-8');
      let fullText = '';
      let firstTokenMs: number | undefined;
      let model = this.CHAT_MODEL;
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.model) model = parsed.model;
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              if (firstTokenMs === undefined) {
                firstTokenMs = Math.round(performance.now() - startedAt);
              }
              fullText += content;
              onDelta(content);
            }
          } catch {
            // ignore non-json
          }
        }
      }

      const clean = GeminiClient.sanitizeForSpeech(fullText);
      const networkMs = Math.round(performance.now() - startedAt);
      return { text: clean, networkMs, firstTokenMs, model };
    } catch (e) {
      if (controller.signal.aborted) {
        throw new Error(GeminiErrors.TIMEOUT);
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  },

  async testKey(
    apiKey: string,
    voice: TtsVoice
  ): Promise<{ ok: boolean; label: string }> {
    let chatSuccess = false;
    let ttsSuccess = false;
    let chatLabel = '';
    let ttsLabel = '';

    try {
      const payload = this.buildChatPayload('짧게 한 단어로만 답해.', [
        { role: 'user', text: '연결 테스트야. 응 이라고만 답해.' },
      ], false);

      const res = await fetch(this.CHAT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errText = await res.text();
        chatLabel = `대화 실패: ${OpenRouterErrors.httpReason(res.status, errText)}`;
      } else {
        const parsed = await res.json();
        chatSuccess = true;
        chatLabel = `대화 성공 (${parsed.model || this.CHAT_MODEL})`;
      }
    } catch (e) {
      chatLabel = `대화 실패: ${e instanceof Error ? e.message : '오류'}`;
    }

    try {
      const startedAt = performance.now();
      const payload = this.buildTtsPayload(voice, '응, 잘 들려.');
      const res = await fetch(this.TTS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errText = await res.text();
        ttsLabel = `음성 실패: ${OpenRouterErrors.httpReason(res.status, errText)}`;
      } else {
        const bytes = await res.arrayBuffer();
        const duration = ((performance.now() - startedAt) / 1000).toFixed(1);
        if (bytes.byteLength > 0) {
          ttsSuccess = true;
          ttsLabel = `음성 성공 (${voice.shortLabel}, 첫 소리 ${duration}초)`;
        } else {
          ttsLabel = '음성 실패: 빈 음성';
        }
      }
    } catch (e) {
      ttsLabel = `음성 실패: ${e instanceof Error ? e.message : '오류'}`;
    }

    return {
      ok: chatSuccess && ttsSuccess,
      label: `${chatLabel}\n${ttsLabel}`,
    };
  },
};
