import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VOICE,
  LIVE_LANGUAGE_CODE,
  PREVIEW_PHRASE,
  VOICE_OPTIONS,
  normalizeVoiceName,
} from "../src/config/voices.ts";

test("normalizeVoiceName handles case, whitespace, out-of-list, and non-string inputs", () => {
  assert.equal(normalizeVoiceName("Kore"), "Kore");
  assert.equal(normalizeVoiceName("kore"), "Kore");
  assert.equal(normalizeVoiceName("PUCK"), "Puck");
  assert.equal(normalizeVoiceName("  charon  "), "Charon");
  assert.equal(normalizeVoiceName("\tFeNrIr\n"), "Fenrir");
  assert.equal(normalizeVoiceName("zephyr"), "Zephyr");

  assert.equal(normalizeVoiceName("Aoede"), DEFAULT_VOICE);
  assert.equal(normalizeVoiceName("unknown"), DEFAULT_VOICE);
  assert.equal(normalizeVoiceName(""), DEFAULT_VOICE);
  assert.equal(normalizeVoiceName("   "), DEFAULT_VOICE);
  assert.equal(normalizeVoiceName(undefined), DEFAULT_VOICE);
  assert.equal(normalizeVoiceName(null), DEFAULT_VOICE);
  assert.equal(normalizeVoiceName(123), DEFAULT_VOICE);
  assert.equal(normalizeVoiceName(0), DEFAULT_VOICE);
  assert.equal(normalizeVoiceName(NaN), DEFAULT_VOICE);
  assert.equal(normalizeVoiceName({ id: "Puck" }), DEFAULT_VOICE);
});

test("VOICE_OPTIONS ids match the 5 allowed server voices", () => {
  const ids = VOICE_OPTIONS.map((v) => v.id).slice().sort();
  assert.deepEqual(ids, ["Charon", "Fenrir", "Kore", "Puck", "Zephyr"]);
});

test("LIVE_LANGUAGE_CODE is null and PREVIEW_PHRASE is non-empty", () => {
  assert.equal(LIVE_LANGUAGE_CODE, null);
  assert.equal(typeof PREVIEW_PHRASE, "string");
  assert.ok(PREVIEW_PHRASE.trim().length > 0);
});
