import { test } from "node:test";
import assert from "node:assert/strict";
import { LIVE_MODEL } from "../src/config/models.ts";
import { DEFAULT_VOICE, LIVE_LANGUAGE_CODE, VOICE_OPTIONS } from "../src/config/voices.ts";
import { buildDirectSetup } from "../src/services/providers/liveWire.ts";
import { buildLiveConfigAttempts, buildSpeechConfig } from "../server/liveConfig.ts";

test("buildLiveConfigAttempts speechConfig matches buildDirectSetup across all attempts and voices", () => {
  const inputs: Array<string | undefined> = [
    ...VOICE_OPTIONS.map((v) => v.id),
    "  puck  ",
    "ZEPHYR",
    "InvalidVoice",
    "",
    undefined,
  ];

  for (const voiceInput of inputs) {
    const direct = buildDirectSetup({
      model: LIVE_MODEL,
      voiceName: voiceInput ?? "",
      systemInstruction: "You are a tutor.",
      resumeHandle: "resume-123",
      languageCode: LIVE_LANGUAGE_CODE,
    }) as any;
    const directSpeechConfig = direct.setup.generationConfig.speechConfig;

    const attempts = buildLiveConfigAttempts({
      voiceName: voiceInput,
      systemInstruction: "You are a tutor.",
      resumeHandle: "resume-123",
    });

    assert.equal(attempts.length, 2);
    for (const attempt of attempts) {
      const attemptSpeechConfig = attempt.config.speechConfig as Record<string, unknown>;
      assert.deepEqual(attemptSpeechConfig, directSpeechConfig);
      assert.equal("languageCode" in attemptSpeechConfig, false);
    }
  }
});

test("out-of-list voiceName normalizes to Kore in both direct setup and server liveConfig", () => {
  const direct = buildDirectSetup({
    model: LIVE_MODEL,
    voiceName: "NotSupportedVoice",
    systemInstruction: "sys",
    resumeHandle: null,
    languageCode: LIVE_LANGUAGE_CODE,
  }) as any;

  const attempts = buildLiveConfigAttempts({
    voiceName: "NotSupportedVoice",
    systemInstruction: "sys",
    resumeHandle: null,
  });

  const expected = buildSpeechConfig(DEFAULT_VOICE);
  assert.deepEqual(direct.setup.generationConfig.speechConfig, expected);
  assert.deepEqual(attempts[0].config.speechConfig, expected);
  assert.deepEqual(attempts[1].config.speechConfig, expected);
  assert.equal(expected.voiceConfig && (expected.voiceConfig as any).prebuiltVoiceConfig.voiceName, "Kore");
});

test("buildLiveConfigAttempts preserves attempt 1 resumption/compression and attempt 2 standard structure", () => {
  const attempts = buildLiveConfigAttempts({
    voiceName: "Charon",
    systemInstruction: "sys",
    resumeHandle: "h-1",
  });

  assert.deepEqual(attempts[0].config.sessionResumption, { handle: "h-1" });
  assert.deepEqual(attempts[0].config.contextWindowCompression, { slidingWindow: {} });
  assert.equal("sessionResumption" in attempts[1].config, false);
  assert.equal("contextWindowCompression" in attempts[1].config, false);
});
