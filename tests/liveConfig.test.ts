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
  // H1-보수: explicit 12k trigger / 6k target (API default 80% of the window never fires in 10 minutes).
  assert.deepEqual(attempts[0].config.contextWindowCompression, {
    triggerTokens: "12000",
    slidingWindow: { targetTokens: "6000" },
  });
  assert.equal("sessionResumption" in attempts[1].config, false);
  assert.equal("contextWindowCompression" in attempts[1].config, false);
});

test("live compression config: 12k/6k as int64 strings, fresh object, target < trigger, estimate average", async () => {
  const m = await import("../src/config/liveCompression.ts");
  const { USAGE_ASSUMPTIONS } = await import("../src/config/models.ts");
  const a = m.buildLiveContextWindowCompression();
  const b = m.buildLiveContextWindowCompression();
  assert.deepEqual(a, { triggerTokens: "12000", slidingWindow: { targetTokens: "6000" } });
  assert.notEqual(a, b);
  a.slidingWindow.targetTokens = "1";
  assert.equal(b.slidingWindow.targetTokens, "6000");
  assert.ok(m.LIVE_COMPRESSION_TARGET_TOKENS < m.LIVE_COMPRESSION_TRIGGER_TOKENS);
  assert.equal(m.LIVE_COMPRESSED_CONTEXT_AVG_TOKENS, 9000);
  assert.equal(USAGE_ASSUMPTIONS.liveContextWindowTokens, m.LIVE_COMPRESSED_CONTEXT_AVG_TOKENS);
});

test("direct setup sends the same compression config as the server relay", async () => {
  const { buildDirectSetup } = await import("../src/services/providers/liveWire.ts");
  const setup = buildDirectSetup({ model: "gemini-3.8-live", voiceName: "Kore", systemInstruction: "s" }) as any;
  const attempts = buildLiveConfigAttempts({ voiceName: "Kore", systemInstruction: "s" });
  assert.deepEqual(setup.setup.contextWindowCompression, attempts[0].config.contextWindowCompression);
});

test("relay attempts report whether they carry compression (ready.contextCompression)", () => {
  const attempts = buildLiveConfigAttempts({ voiceName: "Kore", systemInstruction: "s" });
  assert.equal(attempts[0].contextCompression, true);
  assert.equal("contextWindowCompression" in attempts[0].config, true);
  assert.equal(attempts[1].contextCompression, false);
  assert.equal("contextWindowCompression" in attempts[1].config, false);
});

test("compression state: one connection without compression makes the call off; old servers are unknown", async () => {
  const { mergeLiveContextCompression: merge, compressionFromReady } = await import("../src/config/liveCompression.ts");
  assert.equal(compressionFromReady(true), "on");
  assert.equal(compressionFromReady(false), "off");
  assert.equal(compressionFromReady(undefined), "unknown");
  assert.equal(merge("unknown", "on"), "on");
  assert.equal(merge("on", "on"), "on");
  assert.equal(merge("on", "off"), "off");
  assert.equal(merge("off", "on"), "off");
  assert.equal(merge("unknown", "unknown"), "unknown");
  assert.equal(merge("on", "unknown"), "on");
});
