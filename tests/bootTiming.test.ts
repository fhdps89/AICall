import { test } from "node:test";
import assert from "node:assert/strict";
import { createBootTimer } from "../src/services/perf/bootTiming.ts";

test("records only first call per phase and logs once when mistakes and lectureServer are marked", () => {
  let tick = 10;
  const logs: string[] = [];
  let timerCb: (() => void) | undefined;

  const mark = createBootTimer(
    () => (tick += 10),
    (msg) => logs.push(msg),
    (cb) => {
      timerCb = cb;
      return 1;
    }
  );

  mark("auth"); // 20
  mark("auth"); // ignored (first 1 only)
  mark("data"); // 30
  mark("home"); // 40
  mark("lectureLocal"); // 50
  assert.equal(logs.length, 0);

  mark("mistakes"); // 60
  assert.equal(logs.length, 0);

  mark("lectureServer"); // 70 -> triggers log
  assert.equal(logs.length, 1);
  assert.equal(
    logs[0],
    "[boot] auth=20ms data=30ms home=40ms mistakes=60ms lectureLocal=50ms lectureServer=70ms"
  );

  // Subsequent marks or timer callback do not re-log
  mark("lectureServer");
  timerCb?.();
  assert.equal(logs.length, 1);
});

test("logs once after 60s timeout when not all phases finish and ignores later marks", () => {
  let tick = 0;
  const logs: string[] = [];
  let capturedCb: (() => void) | undefined;
  let capturedMs: number | undefined;

  const mark = createBootTimer(
    () => (tick += 25),
    (msg) => logs.push(msg),
    (cb, ms) => {
      capturedCb = cb;
      capturedMs = ms;
      return 1;
    }
  );

  mark("auth"); // 25
  mark("mistakes"); // 50 (lectureServer missing)
  assert.equal(capturedMs, 60_000);
  assert.equal(logs.length, 0);

  capturedCb?.();
  assert.equal(logs.length, 1);
  assert.equal(
    logs[0],
    "[boot] auth=25ms data=- home=- mistakes=50ms lectureLocal=- lectureServer=-"
  );

  mark("lectureServer");
  assert.equal(logs.length, 1);
});

test("calls clearTimer with timer handle when flushed before 60s timeout", () => {
  let tick = 0;
  const logs: string[] = [];
  const cleared: unknown[] = [];
  const timerHandle = { id: "boot-timer-1" };
  let capturedCb: (() => void) | undefined;

  const mark = createBootTimer(
    () => (tick += 10),
    (msg) => logs.push(msg),
    (cb) => {
      capturedCb = cb;
      return timerHandle;
    },
    (handle) => {
      cleared.push(handle);
    }
  );

  mark("mistakes");
  assert.deepEqual(cleared, []);

  mark("lectureServer");
  assert.equal(logs.length, 1);
  assert.deepEqual(cleared, [timerHandle]);

  // Late timer callback or extra mark neither re-logs nor clears again
  capturedCb?.();
  mark("home");
  assert.equal(logs.length, 1);
  assert.deepEqual(cleared, [timerHandle]);
});
