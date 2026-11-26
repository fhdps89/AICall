/**
 * Provider accessor (Part B-1 provider abstraction).
 * Screens get the Live (real-time call) provider from here without referencing vendor code.
 *
 * Only the Live provider runs in the browser. Transcription (STT), text (LLM) and speech (TTS)
 * run on the server (server.ts, server/lecture.ts, server/sttBench.ts); their interfaces stay in
 * ./types for a future vendor switch. The empty browser-side placeholders that used to live here
 * returned blank results and were never used, so they were removed.
 */
import { LiveProvider } from "./types";
import { GeminiLiveProvider } from "./geminiLiveProvider";
import { CascadePocProvider } from "./cascadePocProvider";
import { PocFallbackProvider } from "./cascadeFallbackProvider";
import { isCascadePocEnabled } from "../settings/callEngineSetting";

/**
 * A fresh Live provider for one call. Each call needs its own instance: the provider keeps the
 * call's transcript and session resume handle, which must not leak into the next call.
 * The Google-streaming test mode is used ONLY when its developer switch is on (default off);
 * it falls back to the normal engine if the test mode is not ready within 8 s.
 */
export function createLiveProvider(
  pocEnabled: boolean = isCascadePocEnabled()
): LiveProvider {
  if (pocEnabled) {
    return new PocFallbackProvider(
      () => new CascadePocProvider(),
      () => new GeminiLiveProvider()
    );
  }
  return new GeminiLiveProvider();
}

export * from "./types";
