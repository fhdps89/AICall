/**
 * Gemini Live WebSocket 송신 와이어 형식(direct / proxy) 빌더·검증기·URL 마스킹(순수 모듈, DOM/Firebase 비의존).
 */

import { normalizeVoiceName } from "../../config/voices";

export type LiveWireKind = "direct" | "proxy";

export const LIVE_INPUT_AUDIO_MIME = "audio/pcm;rate=16000";

export type DirectClientMessage =
  | { setup: Record<string, unknown> }
  | {
      realtimeInput: {
        audio?: { mimeType: string; data: string };
        text?: string;
        audioStreamEnd?: boolean;
      };
    }
  | { clientContent: Record<string, unknown> }
  | { toolResponse: Record<string, unknown> };

export type ProxyClientMessage =
  | {
      type: "init";
      systemInstruction: string;
      voiceName: string;
      resumeHandle: string | null;
      languageCode: string;
    }
  | { type: "realtime_audio"; audio: string; mimeType: string }
  | { type: "text_prompt"; text: string };

export type LiveClientMessage = DirectClientMessage | ProxyClientMessage;

export interface DirectSetupInput {
  model: string;
  voiceName: string;
  systemInstruction: string;
  resumeHandle: string | null;
  languageCode?: string | null;
}

export interface ProxyInitInput {
  systemInstruction: string;
  voiceName: string;
  resumeHandle: string | null;
  languageCode: string;
}

const DIRECT_TOP_KEYS = new Set([
  "setup",
  "clientContent",
  "realtimeInput",
  "toolResponse",
]);

const ALLOWED_REALTIME_INPUT_KEYS = new Set([
  "audio",
  "video",
  "text",
  "audioStreamEnd",
  "activityStart",
  "activityEnd",
]);

const ALLOWED_PROXY_TYPES = new Set([
  "init",
  "realtime_audio",
  "text_prompt",
  "control_command",
  "interrupt",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 직접 연결(BidiGenerateContentConstrained) 초기 setup 페이로드 생성.
 * 키 순서를 @google/genai SDK(live.connect) 와 동일하게 유지한다.
 */
export function buildDirectSetup(input: DirectSetupInput): DirectClientMessage {
  const speechConfig: Record<string, unknown> = {
    voiceConfig: {
      prebuiltVoiceConfig: {
        voiceName: normalizeVoiceName(input.voiceName),
      },
    },
  };
  if (input.languageCode) {
    speechConfig.languageCode = input.languageCode;
  }

  return {
    setup: {
      model: `models/${input.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig,
      },
      systemInstruction: {
        parts: [{ text: input.systemInstruction }],
      },
      sessionResumption: {
        handle: input.resumeHandle || undefined,
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: {
        slidingWindow: {},
      },
    },
  };
}

/**
 * 서버 중계(/api/gemini/live) 초기 init 페이로드 생성.
 */
export function buildProxyInit(input: ProxyInitInput): ProxyClientMessage {
  return {
    type: "init",
    systemInstruction: input.systemInstruction,
    voiceName: normalizeVoiceName(input.voiceName),
    resumeHandle: input.resumeHandle,
    languageCode: input.languageCode,
  };
}

/**
 * 16kHz PCM 오디오 청크 송신 페이로드를 wire 종류에 맞게 생성한다.
 */
export function buildAudioInput(wire: LiveWireKind, base64: string): LiveClientMessage {
  if (wire === "direct") {
    return {
      realtimeInput: {
        audio: {
          mimeType: LIVE_INPUT_AUDIO_MIME,
          data: base64,
        },
      },
    };
  }
  return {
    type: "realtime_audio",
    audio: base64,
    mimeType: LIVE_INPUT_AUDIO_MIME,
  };
}

/**
 * 텍스트 프롬프트 송신 페이로드를 wire 종류에 맞게 생성한다.
 */
export function buildTextInput(wire: LiveWireKind, text: string): LiveClientMessage {
  if (wire === "direct") {
    return {
      realtimeInput: {
        text,
      },
    };
  }
  return {
    type: "text_prompt",
    text,
  };
}

/**
 * wire 규격에 맞는지 검증한다.
 * @returns null = 통과, 문자열 = 거부 사유(키 이름만 담고 데이터는 넣지 않음)
 */
export function validateClientMessage(wire: LiveWireKind, msg: unknown): string | null {
  if (!isPlainObject(msg)) {
    return "not_plain_object";
  }

  if (wire === "direct") {
    const topKeys = Object.keys(msg);
    if (topKeys.length !== 1) {
      return `invalid_top_key_count:${topKeys.length}`;
    }
    const topKey = topKeys[0];
    if (!DIRECT_TOP_KEYS.has(topKey)) {
      return `invalid_top_key:${topKey}`;
    }

    const body = msg[topKey];
    if (!isPlainObject(body)) {
      return `invalid_${topKey}_body`;
    }

    if (topKey === "realtimeInput") {
      const riKeys = Object.keys(body);
      if (riKeys.length === 0) {
        return "empty_realtimeInput";
      }
      for (const k of riKeys) {
        if (k === "mediaChunks") {
          return "deprecated_realtimeInput_key:mediaChunks";
        }
        if (!ALLOWED_REALTIME_INPUT_KEYS.has(k)) {
          return `invalid_realtimeInput_key:${k}`;
        }
      }
      if ("audio" in body) {
        const audio = body.audio;
        if (
          !isPlainObject(audio) ||
          typeof audio.mimeType !== "string" ||
          !audio.mimeType.startsWith("audio/") ||
          typeof audio.data !== "string"
        ) {
          return "invalid_realtimeInput_audio";
        }
      }
      if ("text" in body && typeof body.text !== "string") {
        return "invalid_realtimeInput_text";
      }
      if ("audioStreamEnd" in body && typeof body.audioStreamEnd !== "boolean") {
        return "invalid_realtimeInput_audioStreamEnd";
      }
    }
    return null;
  }

  // proxy wire
  for (const directKey of DIRECT_TOP_KEYS) {
    if (directKey in msg) {
      return `unexpected_direct_key:${directKey}`;
    }
  }
  if (typeof msg.type !== "string" || !ALLOWED_PROXY_TYPES.has(msg.type)) {
    return "invalid_proxy_type";
  }
  if (msg.type === "realtime_audio") {
    if (typeof msg.audio !== "string" || typeof msg.mimeType !== "string") {
      return "invalid_proxy_realtime_audio";
    }
  } else if (msg.type === "text_prompt") {
    if (typeof msg.text !== "string") {
      return "invalid_proxy_text_prompt";
    }
  }
  return null;
}

/**
 * 로그용 메시지 요약. 키 이름만 남기고 데이터 본문·base64 는 포함하지 않는다.
 */
export function describeClientMessage(msg: unknown): string {
  if (!isPlainObject(msg)) {
    return Array.isArray(msg) ? "array" : typeof msg;
  }
  if (typeof msg.type === "string") {
    const safeType = ALLOWED_PROXY_TYPES.has(msg.type)
      ? msg.type
      : msg.type.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "unknown";
    return `type=${safeType}`;
  }
  const keys = Object.keys(msg);
  if (keys.length === 0) return "empty";
  if (keys.length === 1 && keys[0] === "realtimeInput" && isPlainObject(msg.realtimeInput)) {
    const riKeys = Object.keys(msg.realtimeInput);
    return riKeys.length > 0 ? `realtimeInput.${riKeys.join(",")}` : "realtimeInput";
  }
  return keys.join(",");
}

/**
 * origin + pathname 만 남기고 query(access_token/token) 및 해시를 제거한다.
 */
export function redactSocketUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}
