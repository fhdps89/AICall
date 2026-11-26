import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLectureForCard } from "../src/services/lecture/lectureCardLoad.ts";
import { settleBootPhase } from "../src/services/perf/bootTiming.ts";

/**
 * A thrown profile+goals read used to skip markBoot("data") in App's catch.
 * settleBootPhase marks in finally, before that rejection is handled, and the
 * summary stays unpublished until data joins mistakes and lectureServer.
 */
test("a thrown profile load records data before the caller returns, and flush waits for it", async () => {
  const logs: string[] = [];
  const original = console.info;
  console.info = (msg?: unknown) => {
    logs.push(String(msg));
  };

  try {
    await settleBootPhase("mistakes", async () => {
      throw new Error("firestore");
    }).catch(() => {
      const isCurrent = false;
      if (!isCurrent) return;
    });

    await loadLectureForCard({
      readLocal: async () => null,
      syncServer: async () => null,
      onLocal: () => {},
      timeoutMs: 20,
    }).then((result) => {
      const canApply = false;
      if (!canApply) return null;
      return result;
    });

    assert.equal(logs.length, 0, "flush waits until data settles");

    let passedGuard = false;
    const loaded = await settleBootPhase("data", async () => {
      throw new Error("firestore");
    }).then(
      (result) => result,
      (err: unknown) => {
        assert.equal(logs.length, 1, "data is marked before the error handler");
        assert.ok(err instanceof Error);
        const isActive = () => false;
        if (!isActive()) return null;
        passedGuard = true;
        return null;
      }
    );

    assert.equal(passedGuard, false);
    assert.equal(loaded, null);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[boot\] /);
    assert.match(logs[0], /data=\d+ms/);
    assert.match(logs[0], /mistakes=\d+ms/);
    assert.match(logs[0], /lectureServer=\d+ms/);
    assert.doesNotMatch(logs[0], /data=-/);
    assert.doesNotMatch(logs[0], /mistakes=-/);
    assert.doesNotMatch(logs[0], /lectureServer=-/);

    await settleBootPhase("data", async () => ({ profile: null, goals: [] })).catch(() => {});
    assert.equal(logs.length, 1);
  } finally {
    console.info = original;
  }
});
