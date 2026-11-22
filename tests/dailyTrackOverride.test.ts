import { test } from "node:test";
import assert from "node:assert/strict";
import {
  kstDateKey,
  overrideStorageKey,
  loadDailyOverride,
  saveDailyOverride,
  type DailyOverrideStorage,
} from "../src/ui/home/dailyTrackOverride.ts";

function createMapStorage(initial?: Record<string, string>): DailyOverrideStorage & { map: Map<string, string> } {
  const map = new Map<string, string>(initial ? Object.entries(initial) : []);
  return {
    map,
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    removeItem(key: string) {
      map.delete(key);
    },
  };
}

test("kstDateKey converts UTC timestamps across KST midnight boundary", () => {
  const beforeKstMidnight = Date.UTC(2026, 10, 22, 14, 59, 59); // KST 2026-11-22 23:59:59
  const atKstMidnight = Date.UTC(2026, 10, 22, 15, 0, 0); // KST 2026-11-23 00:00:00

  assert.equal(kstDateKey(beforeKstMidnight), "2026-11-22");
  assert.equal(kstDateKey(atKstMidnight), "2026-11-23");
});

test("saveDailyOverride and loadDailyOverride persist selection on the same KST day", () => {
  const storage = createMapStorage();
  const morningMs = Date.UTC(2026, 10, 21, 22, 0, 0); // KST 2026-11-22 07:00:00
  const nightMs = Date.UTC(2026, 10, 22, 14, 59, 59); // KST 2026-11-22 23:59:59

  saveDailyOverride(storage, "user-1", morningMs, "opic");
  assert.equal(loadDailyOverride(storage, "user-1", nightMs), "opic");
  assert.equal(loadDailyOverride(storage, "user-1", nightMs, ["daily", "opic"]), "opic");
});

test("loadDailyOverride returns null and removes stale entry on the next KST day", () => {
  const storage = createMapStorage();
  const day1Ms = Date.UTC(2026, 10, 22, 14, 59, 59); // KST 2026-11-22 23:59:59
  const day2Ms = Date.UTC(2026, 10, 22, 15, 0, 0); // KST 2026-11-23 00:00:00

  saveDailyOverride(storage, "user-1", day1Ms, "opic");
  const key = overrideStorageKey("user-1");
  assert.equal(storage.map.has(key), true);

  assert.equal(loadDailyOverride(storage, "user-1", day2Ms), null);
  assert.equal(storage.map.has(key), false);
});

test("overrides are isolated by userId", () => {
  const storage = createMapStorage();
  const nowMs = Date.UTC(2026, 10, 22, 3, 0, 0);

  saveDailyOverride(storage, "user-a", nowMs, "opic");
  assert.equal(loadDailyOverride(storage, "user-a", nowMs), "opic");
  assert.equal(loadDailyOverride(storage, "user-b", nowMs), null);
});

test("saveDailyOverride with null deletes stored override", () => {
  const storage = createMapStorage();
  const nowMs = Date.UTC(2026, 10, 22, 3, 0, 0);
  const key = overrideStorageKey("user-1");

  saveDailyOverride(storage, "user-1", nowMs, "opic");
  assert.equal(storage.map.has(key), true);

  saveDailyOverride(storage, "user-1", nowMs, null);
  assert.equal(storage.map.has(key), false);
  assert.equal(loadDailyOverride(storage, "user-1", nowMs), null);
});

test("loadDailyOverride returns null and cleans up malformed JSON or wrong field types", () => {
  const nowMs = Date.UTC(2026, 10, 22, 3, 0, 0);
  const today = kstDateKey(nowMs);
  const key = overrideStorageKey("user-1");

  const brokenCases = [
    "{not-json",
    "null",
    "[]",
    JSON.stringify({ date: today, goalId: 123 }),
    JSON.stringify({ date: today, goalId: null }),
    JSON.stringify({ date: today, goalId: "" }),
    JSON.stringify({ date: 20261122, goalId: "opic" }),
  ];

  for (const raw of brokenCases) {
    const storage = createMapStorage({ [key]: raw });
    assert.equal(loadDailyOverride(storage, "user-1", nowMs), null);
    assert.equal(storage.map.has(key), false);
  }
});

test("loadDailyOverride returns null when goalId is not in validGoalIds", () => {
  const storage = createMapStorage();
  const nowMs = Date.UTC(2026, 10, 22, 3, 0, 0);

  saveDailyOverride(storage, "user-1", nowMs, "removed-goal");
  assert.equal(loadDailyOverride(storage, "user-1", nowMs, ["daily", "opic"]), null);
});

test("loadDailyOverride and saveDailyOverride do not throw when storage throws", () => {
  const throwingStorage: DailyOverrideStorage = {
    getItem() {
      throw new Error("storage disabled");
    },
    setItem() {
      throw new Error("quota exceeded");
    },
    removeItem() {
      throw new Error("storage disabled");
    },
  };
  const nowMs = Date.UTC(2026, 10, 22, 3, 0, 0);

  assert.doesNotThrow(() => saveDailyOverride(throwingStorage, "user-1", nowMs, "opic"));
  assert.doesNotThrow(() => saveDailyOverride(throwingStorage, "user-1", nowMs, null));
  assert.equal(loadDailyOverride(throwingStorage, "user-1", nowMs), null);
});
