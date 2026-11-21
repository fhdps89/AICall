import { Modality } from '@google/genai';
import { LIVE_LANGUAGE_CODE, normalizeVoiceName } from '../src/config/voices.ts';

export interface LiveConfigAttemptInput {
  voiceName?: unknown;
  systemInstruction: string;
  resumeHandle?: string | null;
}

export interface LiveConfigAttempt {
  desc: string;
  config: Record<string, unknown>;
  lock: string | null;
}

/**
 * 직접 연결(buildDirectSetup)과 동일한 구조의 speechConfig를 생성한다.
 * LIVE_LANGUAGE_CODE가 null이면 languageCode 키를 넣지 않는다.
 */
export function buildSpeechConfig(
  voiceName: unknown,
  languageCode: string | null = LIVE_LANGUAGE_CODE,
): Record<string, unknown> {
  const normalized = normalizeVoiceName(voiceName);
  const speechConfig: Record<string, unknown> = {
    voiceConfig: {
      prebuiltVoiceConfig: {
        voiceName: normalized,
      },
    },
  };
  if (languageCode) {
    speechConfig.languageCode = languageCode;
  }
  return speechConfig;
}

/**
 * 서버 중계(/api/gemini/live)에서 순차 시도할 Live 세션 설정 목록을 만든다.
 */
export function buildLiveConfigAttempts({
  voiceName,
  systemInstruction,
  resumeHandle,
}: LiveConfigAttemptInput): LiveConfigAttempt[] {
  return [
    {
      desc: 'gemini-3.8-live with session resumption & context compression',
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        sessionResumption: {
          handle: resumeHandle || undefined,
        },
        contextWindowCompression: {
          slidingWindow: {},
        },
        speechConfig: buildSpeechConfig(voiceName),
        systemInstruction,
      },
      lock: LIVE_LANGUAGE_CODE,
    },
    {
      desc: 'gemini-3.8-live standard audio session',
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: buildSpeechConfig(voiceName),
        systemInstruction,
      },
      lock: LIVE_LANGUAGE_CODE,
    },
  ];
}
