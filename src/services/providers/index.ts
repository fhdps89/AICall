/**
 * Provider Accessor & Registry
 * Screen components access providers via these factories without referencing vendor specifics.
 */
import {
  LIVE_MODEL,
  TEXT_MODEL,
  GEMINI_STT_MODEL,
  GEMINI_STT_MODE,
  GEMINI_TTS_MODEL,
  DEFAULT_STT_ENGINE,
  DEFAULT_TTS_ENGINE,
  SttEngineType,
  TtsEngineType,
} from "../../config/models";
import {
  LiveProvider,
  SttProvider,
  LlmProvider,
  TtsProvider,
  LiveSessionOptions,
  SttTranscriptionOptions,
  SttResult,
  LlmGenerateOptions,
  LlmResult,
  TtsSynthesisOptions,
  TtsResult,
} from "./types";

import { GeminiLiveProvider } from "./geminiLiveProvider";

/**
 * Skeleton Implementation of SttProvider
 */
class GeminiSttProvider implements SttProvider {
  name = `${GEMINI_STT_MODEL} (${GEMINI_STT_MODE})`;

  async transcribe(_options: SttTranscriptionOptions): Promise<SttResult> {
    return {
      text: "",
      engine: this.name,
      durationSec: 0,
    };
  }
}

/**
 * Skeleton Implementation of LlmProvider
 */
class GeminiLlmProvider implements LlmProvider {
  name = TEXT_MODEL;

  async generateText(_options: LlmGenerateOptions): Promise<LlmResult<string>> {
    return {
      content: "",
      tokensUsed: { prompt: 0, completion: 0, total: 0 },
    };
  }

  async generateJson<T>(_options: LlmGenerateOptions): Promise<LlmResult<T>> {
    return {
      content: {} as T,
      tokensUsed: { prompt: 0, completion: 0, total: 0 },
    };
  }
}

/**
 * Skeleton Implementation of TtsProvider
 */
class GeminiTtsProvider implements TtsProvider {
  name = GEMINI_TTS_MODEL;

  async synthesize(_options: TtsSynthesisOptions): Promise<TtsResult> {
    return {
      audioBuffer: new ArrayBuffer(0),
      durationSec: 0,
      engine: this.name,
    };
  }
}

// Singletons / Factory accessors
let activeLiveProvider: LiveProvider = new GeminiLiveProvider();
let activeSttProvider: SttProvider = new GeminiSttProvider();
let activeLlmProvider: LlmProvider = new GeminiLlmProvider();
let activeTtsProvider: TtsProvider = new GeminiTtsProvider();

export function getLiveProvider(): LiveProvider {
  return activeLiveProvider;
}

export function getSttProvider(_engine: SttEngineType = DEFAULT_STT_ENGINE): SttProvider {
  return activeSttProvider;
}

export function getLlmProvider(): LlmProvider {
  return activeLlmProvider;
}

export function getTtsProvider(_engine: TtsEngineType = DEFAULT_TTS_ENGINE): TtsProvider {
  return activeTtsProvider;
}

export * from "./types";
