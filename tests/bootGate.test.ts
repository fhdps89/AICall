import { test } from "node:test";
import assert from "node:assert/strict";
import { canStartCall, nextGoalsSyncState } from "../src/services/session/bootGate.ts";

test("nextGoalsSyncState stays syncing while booting from cache, retrying, or signed out", () => {
  assert.equal(nextGoalsSyncState("cache"), "syncing");
  assert.equal(nextGoalsSyncState("retry"), "syncing");
  assert.equal(nextGoalsSyncState("signedOut"), "syncing");
  assert.equal(canStartCall("syncing"), false);
});

test("nextGoalsSyncState: fresh load unlocks call start, failure is failed with or without cache", () => {
  assert.equal(nextGoalsSyncState("fresh"), "fresh");
  assert.equal(canStartCall("fresh"), true);
  assert.equal(nextGoalsSyncState("failed"), "failed");
  assert.equal(canStartCall("failed"), false);
});

test("goals sync transitions: cache→failed→retry→fresh and first visit (no cache)→failed", () => {
  // 캐시 있음: 캐시 표시 → 서버 실패 → 다시 확인 → 성공
  const withCache = (["cache", "failed", "retry", "fresh"] as const).map(nextGoalsSyncState);
  assert.deepEqual(withCache, ["syncing", "failed", "syncing", "fresh"]);
  // 캐시 없음(첫 방문): 서버 실패 시 영구 "확인 중"이 아니라 failed
  const noCache = (["cache", "failed"] as const).map(nextGoalsSyncState);
  assert.deepEqual(noCache, ["syncing", "failed"]);
  assert.equal(canStartCall(noCache[1]), false);
});
