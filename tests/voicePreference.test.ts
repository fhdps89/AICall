import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VOICE } from "../src/config/voices.ts";
import {
  VOICE_STORAGE_KEY,
  createVoicePreference,
  type VoiceStorage,
} from "../src/services/settings/voicePreference.ts";

function makeMemoryStorage(initial: Record<string, string> = {}): VoiceStorage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

test("memory cache takes priority over localStorage and remote", async () => {
  let remoteCalls = 0;
  const storage = makeMemoryStorage();
  const pref = createVoicePreference({
    storage,
    readRemote: async () => {
      remoteCalls += 1;
      return "Charon";
    },
  });

  const first = await pref.getPreferredVoice("u1");
  assert.equal(first, "Charon");
  assert.equal(remoteCalls, 1);

  // Change storage and remote behavior; cache must win without calling remote again
  storage.setItem(VOICE_STORAGE_KEY, "Fenrir");
  const second = await pref.getPreferredVoice("u1");
  assert.equal(second, "Charon");
  assert.equal(remoteCalls, 1);
});

test("falls back to localStorage before remote", async () => {
  let remoteCalls = 0;
  const storage = makeMemoryStorage({ [VOICE_STORAGE_KEY]: "Zephyr" });
  const pref = createVoicePreference({
    storage,
    readRemote: async () => {
      remoteCalls += 1;
      return "Puck";
    },
  });

  const voice = await pref.getPreferredVoice("u1");
  assert.equal(voice, "Zephyr");
  assert.equal(remoteCalls, 0);
});

test("falls back to DEFAULT_VOICE when remote exceeds timeoutMs", async () => {
  const storage = makeMemoryStorage();
  const pref = createVoicePreference({
    storage,
    readRemote: () =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve("Fenrir"), 150);
        t.unref?.();
      }),
  });

  const voice = await pref.getPreferredVoice("u1", { timeoutMs: 20 });
  assert.equal(voice, DEFAULT_VOICE);
  assert.equal(storage.getItem(VOICE_STORAGE_KEY), null);
});

test("setPreferredVoice normalizes valid values and rejects out-of-list values to Kore", async () => {
  const storage = makeMemoryStorage();
  const remoteWrites: string[] = [];
  const pref = createVoicePreference({
    storage,
    writeRemote: async (_uid, voiceName) => {
      remoteWrites.push(voiceName);
    },
  });

  const saved = await pref.setPreferredVoice("u1", "  fenrir ");
  assert.equal(saved, "Fenrir");
  assert.equal(storage.getItem(VOICE_STORAGE_KEY), "Fenrir");
  assert.deepEqual(remoteWrites, ["Fenrir"]);
  assert.equal(await pref.getPreferredVoice("u1"), "Fenrir");

  const rejected = await pref.setPreferredVoice("u1", "Aoede");
  assert.equal(rejected, DEFAULT_VOICE);
  assert.equal(storage.getItem(VOICE_STORAGE_KEY), DEFAULT_VOICE);
  assert.deepEqual(remoteWrites, ["Fenrir", DEFAULT_VOICE]);
  assert.equal(await pref.getPreferredVoice("u1"), DEFAULT_VOICE);
});

test("invalid value in localStorage normalizes to DEFAULT_VOICE", async () => {
  const storage = makeMemoryStorage({ [VOICE_STORAGE_KEY]: "BogusVoice" });
  const pref = createVoicePreference({ storage });
  assert.equal(await pref.getPreferredVoice("u1"), DEFAULT_VOICE);
});
