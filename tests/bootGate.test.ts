import { test } from "node:test";
import assert from "node:assert/strict";
import { canStartCall, createGoalsCommitGate, nextGoalsSyncState } from "../src/services/session/bootGate.ts";

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

test("createGoalsCommitGate applies only a read that is not older than the newest applied one", () => {
  const gate = createGoalsCommitGate();

  assert.equal(gate.claim(1_000), true);
  assert.equal(gate.claim(500), false);
  assert.equal(gate.claim(1_000), true);
  assert.equal(gate.claim(1_500), true);
  assert.equal(gate.claim(Number.NaN), false);
  assert.equal(gate.claim(Number.POSITIVE_INFINITY), false);
  // 실패한 더 새로운 조회가 시각을 잡으면, 그 전에 시작한 성공 응답은 반영하지 않는다.
  assert.equal(gate.claim(2_000), true);
  assert.equal(gate.claim(1_500), false);
});
