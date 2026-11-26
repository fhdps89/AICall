import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOOT_CACHE_PREFIX,
  BOOT_CACHE_TTL_MS,
  bootCacheKey,
  clearBootCache,
  defaultBootStore,
  readBootCache,
  writeBootCache,
  type BootCacheStore,
} from "../src/services/session/bootCache.ts";
import type { GoalData } from "../src/services/firebase/db.ts";

function makeMemoryStore(
  initial?: Record<string, string>,
  options?: { omitKeyLength?: boolean }
): BootCacheStore & { map: Map<string, string>; removed: string[] } {
  const map = new Map<string, string>(initial ? Object.entries(initial) : []);
  const removed: string[] = [];
  const base: BootCacheStore & { map: Map<string, string>; removed: string[] } = {
    map,
    removed,
    getItem(k: string) {
      return map.has(k) ? map.get(k)! : null;
    },
    setItem(k: string, v: string) {
      map.set(k, v);
    },
    removeItem(k: string) {
      removed.push(k);
      map.delete(k);
    },
  };
  if (!options?.omitKeyLength) {
    Object.defineProperty(base, "length", {
      get() {
        return map.size;
      },
    });
    base.key = (index: number) => Array.from(map.keys())[index] ?? null;
  }
  return base;
}

const SAMPLE_GOALS: GoalData[] = [
  {
    id: "opic",
    title: "OPIc 목표 달성",
    type: "opic",
    why: "실전 회화 연습",
    priority: 1,
    tutorPrompt: "Speak naturally",
    lessons: [
      { index: 1, title: "자기소개", completed: true },
      { index: 2, title: "집과 동네" },
    ],
    nextLessonIndex: 2,
    status: "active",
    updatedAt: "2026-11-25T00:00:00.000Z",
  },
];

// 저장본은 홈 표시용: tutorPrompt만 빈 문자열로 비우고 홈에 보이는 why는 남긴다.
const STORED_GOALS: GoalData[] = SAMPLE_GOALS.map((g) => ({ ...g, tutorPrompt: "" }));

test("writeBootCache and readBootCache round-trip goals within 7-day TTL", () => {
  const store = makeMemoryStore();
  const savedAt = Date.UTC(2026, 10, 20, 0, 0, 0);

  writeBootCache(store, "user-1", SAMPLE_GOALS, savedAt);

  assert.deepEqual(readBootCache(store, "user-1", savedAt), STORED_GOALS);
  assert.deepEqual(
    readBootCache(store, "user-1", savedAt + BOOT_CACHE_TTL_MS),
    STORED_GOALS
  );
});

test("writeBootCache does not store tutorPrompt but keeps why for home display", () => {
  const store = makeMemoryStore();
  const now = Date.UTC(2026, 10, 20, 0, 0, 0);

  writeBootCache(store, "user-1", SAMPLE_GOALS, now);
  const raw = store.map.get(bootCacheKey("user-1"));
  assert.ok(raw);
  assert.equal(raw.includes("Speak naturally"), false);
  assert.equal(raw.includes("실전 회화 연습"), true);
  const parsed = JSON.parse(raw) as { goals: Array<Record<string, unknown>> };
  for (const g of parsed.goals) {
    assert.equal(g.tutorPrompt, "");
    assert.notEqual(g.why, "");
  }
  // 원본 목록은 바뀌지 않는다.
  assert.equal(SAMPLE_GOALS[0].tutorPrompt, "Speak naturally");
});

test("readBootCache returns null and deletes entry when a goal element has a broken shape", () => {
  const now = Date.UTC(2026, 10, 20, 0, 0, 0);
  const key = bootCacheKey("user-1");
  const good = STORED_GOALS[0];

  const brokenGoalLists: unknown[] = [
    [{}],
    [null],
    ["opic"],
    [[]],
    [good, { ...good, id: 1 }],
    [{ ...good, title: undefined }],
    [{ ...good, lessons: "not-array" }],
    [{ id: "opic", title: "OPIc" }],
  ];

  for (const goals of brokenGoalLists) {
    const store = makeMemoryStore({
      [key]: JSON.stringify({ v: 1, uid: "user-1", goals, savedAt: now }),
    });
    assert.equal(readBootCache(store, "user-1", now), null);
    assert.equal(store.map.has(key), false);
  }
});

test("readBootCache returns null for missing entry or different uid", () => {
  const store = makeMemoryStore();
  const now = Date.UTC(2026, 10, 20, 0, 0, 0);

  assert.equal(readBootCache(store, "user-1", now), null);

  writeBootCache(store, "user-1", SAMPLE_GOALS, now);
  assert.equal(readBootCache(store, "user-2", now), null);

  // Even if someone stored user-1's payload under user-2's key, reject and delete it.
  const u2Key = bootCacheKey("user-2");
  store.setItem(u2Key, store.getItem(bootCacheKey("user-1"))!);
  assert.equal(readBootCache(store, "user-2", now), null);
  assert.equal(store.map.has(u2Key), false);
});

test("readBootCache returns null and removes entry after 7 days (TTL)", () => {
  const store = makeMemoryStore();
  const savedAt = Date.UTC(2026, 10, 10, 0, 0, 0);
  const key = bootCacheKey("user-1");

  writeBootCache(store, "user-1", SAMPLE_GOALS, savedAt);
  assert.equal(store.map.has(key), true);

  const expiredAt = savedAt + BOOT_CACHE_TTL_MS + 1;
  assert.equal(readBootCache(store, "user-1", expiredAt), null);
  assert.equal(store.map.has(key), false);
  assert.ok(store.removed.includes(key));
});

test("readBootCache returns null and deletes corrupted JSON, wrong version, non-array, or empty goals", () => {
  const now = Date.UTC(2026, 10, 20, 0, 0, 0);
  const key = bootCacheKey("user-1");

  const invalidPayloads = [
    "{broken-json",
    "null",
    "[]",
    JSON.stringify({ v: 2, uid: "user-1", goals: SAMPLE_GOALS, savedAt: now }),
    JSON.stringify({ v: 1, uid: "user-1", goals: "not-array", savedAt: now }),
    JSON.stringify({ v: 1, uid: "user-1", goals: [], savedAt: now }),
    JSON.stringify({ v: 1, uid: "user-1", goals: SAMPLE_GOALS, savedAt: "nan" }),
  ];

  for (const raw of invalidPayloads) {
    const store = makeMemoryStore({ [key]: raw });
    assert.equal(readBootCache(store, "user-1", now), null);
    assert.equal(store.map.has(key), false);
  }
});

test("writeBootCache ignores empty array and stores only v, uid, goals, savedAt", () => {
  const store = makeMemoryStore();
  const now = Date.UTC(2026, 10, 20, 0, 0, 0);

  writeBootCache(store, "user-1", [], now);
  assert.equal(store.map.size, 0);

  writeBootCache(store, "user-1", SAMPLE_GOALS, now);
  const raw = store.map.get(bootCacheKey("user-1"));
  assert.ok(raw);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ["goals", "savedAt", "uid", "v"]);
  assert.equal("feedSecret" in parsed, false);
  assert.equal("job" in parsed, false);
  assert.equal("profile" in parsed, false);
  assert.equal("placeholders" in parsed, false);
});

test("readBootCache, writeBootCache, and clearBootCache swallow store exceptions", () => {
  const throwingStore: BootCacheStore = {
    getItem() {
      throw new Error("read failed");
    },
    setItem() {
      throw new Error("quota exceeded");
    },
    removeItem() {
      throw new Error("remove failed");
    },
    get length(): number {
      throw new Error("length failed");
    },
    key() {
      throw new Error("key failed");
    },
  };
  const now = Date.UTC(2026, 10, 20, 0, 0, 0);

  assert.equal(readBootCache(throwingStore, "user-1", now), null);
  assert.doesNotThrow(() => writeBootCache(throwingStore, "user-1", SAMPLE_GOALS, now));
  assert.doesNotThrow(() => clearBootCache(throwingStore, "user-1"));
  assert.doesNotThrow(() => clearBootCache(throwingStore));
  assert.equal(readBootCache(undefined, "user-1", now), null);
  assert.doesNotThrow(() => writeBootCache(undefined, "user-1", SAMPLE_GOALS, now));
  assert.doesNotThrow(() => clearBootCache(undefined, "user-1"));
});

test("clearBootCache removes single uid or all boot cache keys without touching unrelated keys", () => {
  const store = makeMemoryStore({
    [`${BOOT_CACHE_PREFIX}u1`]: "a",
    [`${BOOT_CACHE_PREFIX}u2`]: "b",
    "onecall_today_track_override:u1": "keep-me",
  });

  clearBootCache(store, "u1");
  assert.equal(store.map.has(`${BOOT_CACHE_PREFIX}u1`), false);
  assert.equal(store.map.has(`${BOOT_CACHE_PREFIX}u2`), true);
  assert.equal(store.map.get("onecall_today_track_override:u1"), "keep-me");

  store.setItem(`${BOOT_CACHE_PREFIX}u1`, "a");
  clearBootCache(store);
  assert.equal(store.map.has(`${BOOT_CACHE_PREFIX}u1`), false);
  assert.equal(store.map.has(`${BOOT_CACHE_PREFIX}u2`), false);
  assert.equal(store.map.get("onecall_today_track_override:u1"), "keep-me");

  // Store without key/length supports uid-scoped removal and ignores prefix scan safely.
  const minimalStore = makeMemoryStore(
    {
      [`${BOOT_CACHE_PREFIX}u1`]: "a",
      [`${BOOT_CACHE_PREFIX}u2`]: "b",
    },
    { omitKeyLength: true }
  );
  assert.doesNotThrow(() => clearBootCache(minimalStore));
  assert.equal(minimalStore.map.size, 2);
  clearBootCache(minimalStore, "u1");
  assert.equal(minimalStore.map.has(`${BOOT_CACHE_PREFIX}u1`), false);
  assert.equal(minimalStore.map.has(`${BOOT_CACHE_PREFIX}u2`), true);
});

test("defaultBootStore safely returns undefined when localStorage is unavailable or throws", () => {
  assert.equal(defaultBootStore(), undefined);

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError");
    },
  });
  try {
    assert.equal(defaultBootStore(), undefined);
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "localStorage", descriptor);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  }
});
