import { test } from "node:test";
import assert from "node:assert/strict";
import { createFeedSyncGate } from "../src/services/feed/feedSyncGate.ts";

test("fromHome coalesces concurrent calls, throttles within 10m on same day, and runs after interval or day change", async () => {
  let currentTime = 1_000_000;
  let currentDay = "2026-11-26";
  let runs = 0;
  let releaseFirst!: () => void;

  const gate = createFeedSyncGate({
    run: async () => {
      runs++;
      if (runs === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    },
    now: () => currentTime,
    today: () => currentDay,
  });

  // Two concurrent fromHome calls share one in-flight run
  const p1 = gate.fromHome("u1");
  const p2 = gate.fromHome("u1");
  assert.equal(runs, 1);
  releaseFirst();
  await Promise.all([p1, p2]);

  // Within 10 minutes on the same day -> skipped
  currentTime += 5 * 60 * 1000;
  await gate.fromHome("u1");
  assert.equal(runs, 1);

  // After 10 minutes -> runs again
  currentTime += 5 * 60 * 1000;
  await gate.fromHome("u1");
  assert.equal(runs, 2);

  // Within 10 minutes but date rolled over -> runs immediately
  currentTime += 1000;
  currentDay = "2026-11-27";
  await gate.fromHome("u1");
  assert.equal(runs, 3);
});

test("explicit chains after in-flight work in order without reusing it", async () => {
  const order: string[] = [];
  let releaseHome!: () => void;

  const gate = createFeedSyncGate({
    run: async (_uid, opts) => {
      const tag = opts.mistakes ? "explicit" : "home";
      order.push(`start:${tag}`);
      if (tag === "home") {
        await new Promise<void>((resolve) => {
          releaseHome = resolve;
        });
      }
      order.push(`end:${tag}`);
    },
    now: () => 1_000_000,
    today: () => "2026-11-26",
  });

  const homePromise = gate.fromHome("u1");
  const explicitPromise = gate.explicit("u1", { mistakes: [] });

  // explicit must wait until home settles
  await Promise.resolve();
  assert.deepEqual(order, ["start:home"]);

  releaseHome();
  await Promise.all([homePromise, explicitPromise]);
  assert.deepEqual(order, ["start:home", "end:home", "start:explicit", "end:explicit"]);
});

test("failures do not record success timestamp and uids are isolated", async () => {
  let failNext = true;
  const calls: string[] = [];

  const gate = createFeedSyncGate({
    run: async (uid) => {
      calls.push(uid);
      if (failNext && uid === "u1") {
        failNext = false;
        throw new Error("sync failed");
      }
    },
    now: () => 1_000_000,
    today: () => "2026-11-26",
  });

  await assert.rejects(() => gate.fromHome("u1"), /sync failed/);
  // Failure did not record lastSuccess, so immediate retry executes
  await gate.fromHome("u1");
  // Different uid is independent
  await gate.fromHome("u2");
  // u1 is now throttled while u2 ran independently
  await gate.fromHome("u1");

  assert.deepEqual(calls, ["u1", "u1", "u2"]);
});

test("midnight rollover during run records startDate so next-day fromHome executes immediately", async () => {
  let currentTime = 1_000_000;
  let currentDay = "2026-11-26";
  let runs = 0;
  let releaseMidnightRun!: () => void;

  const gate = createFeedSyncGate({
    run: async () => {
      runs++;
      if (runs === 1) {
        await new Promise<void>((resolve) => {
          releaseMidnightRun = resolve;
        });
      }
    },
    now: () => currentTime,
    today: () => currentDay,
  });

  // Start at 23:59 on 2026-11-26
  const p = gate.fromHome("u1");
  assert.equal(runs, 1);

  // Clock crosses midnight before run finishes
  currentTime += 2 * 60 * 1000;
  currentDay = "2026-11-27";
  releaseMidnightRun();
  await p;

  // Still within 10 minutes, but recorded date was 2026-11-26 -> runs immediately on 2026-11-27
  currentTime += 60 * 1000;
  await gate.fromHome("u1");
  assert.equal(runs, 2);
});

test("explicit failure clears prior home throttle so returning home retries", async () => {
  let currentTime = 1_000_000;
  let shouldFail = false;
  const calls: string[] = [];

  const gate = createFeedSyncGate({
    run: async (_uid, opts) => {
      calls.push(opts.mistakes ? "explicit" : "home");
      if (shouldFail) {
        throw new Error("explicit boom");
      }
    },
    now: () => currentTime,
    today: () => "2026-11-26",
  });

  // Initial home mount succeeds and sets throttle
  await gate.fromHome("u1");
  currentTime += 60 * 1000;
  await gate.fromHome("u1");
  assert.deepEqual(calls, ["home"]);

  // Explicit sync fails -> must clear lastSuccess
  shouldFail = true;
  await assert.rejects(() => gate.explicit("u1", { mistakes: [] }), /explicit boom/);

  // Returning home within 10 minutes must retry instead of throttling
  shouldFail = false;
  currentTime += 30 * 1000;
  await gate.fromHome("u1");
  assert.deepEqual(calls, ["home", "explicit", "home"]);
});

test("three consecutive explicit calls serialize in order", async () => {
  const events: string[] = [];
  const releases: Array<() => void> = [];

  const gate = createFeedSyncGate({
    run: async (_uid, opts) => {
      const id = opts.mistakes?.[0]?.id ?? "unknown";
      events.push(`start:${id}`);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      events.push(`end:${id}`);
    },
    now: () => 1_000_000,
    today: () => "2026-11-26",
  });

  const makeTag = (id: string) => [
    {
      id,
      createdAt: "2026-11-26T00:00:00.000Z",
      source: "call" as const,
      myPhrase: "a",
      naturalPhrase: "b",
      reason: "r",
      sourceStt: "s",
      stage: 1 as const,
      status: "reviewing" as const,
    },
  ];

  const p1 = gate.explicit("u1", { mistakes: makeTag("e1") });
  const p2 = gate.explicit("u1", { mistakes: makeTag("e2") });
  const p3 = gate.explicit("u1", { mistakes: makeTag("e3") });

  await Promise.resolve();
  assert.deepEqual(events, ["start:e1"]);

  releases[0]();
  await p1;
  await Promise.resolve();
  assert.deepEqual(events, ["start:e1", "end:e1", "start:e2"]);

  releases[1]();
  await p2;
  await Promise.resolve();
  assert.deepEqual(events, ["start:e1", "end:e1", "start:e2", "end:e2", "start:e3"]);

  releases[2]();
  await p3;
  assert.deepEqual(events, [
    "start:e1",
    "end:e1",
    "start:e2",
    "end:e2",
    "start:e3",
    "end:e3",
  ]);
});

test("queued explicit runs normally and receives opts after preceding explicit fails", async () => {
  const received: Array<{ uid: string; opts: unknown }> = [];
  let releaseFirst!: () => void;
  let callIndex = 0;

  const gate = createFeedSyncGate<string>({
    run: async (uid, opts) => {
      const idx = ++callIndex;
      received.push({ uid, opts });
      if (idx === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        throw new Error("first explicit failed");
      }
      return opts.secretOverride ?? "secret-from-server";
    },
    now: () => 1_000_000,
    today: () => "2026-11-26",
  });

  const firstOpts = { secretOverride: "new-sec", previousSecret: "old-sec" };
  const secondOpts = {
    mistakes: [
      {
        id: "m1",
        createdAt: "2026-11-26T00:00:00.000Z",
        source: "call" as const,
        myPhrase: "a",
        naturalPhrase: "b",
        reason: "r",
        sourceStt: "s",
        stage: 1 as const,
        status: "reviewing" as const,
      },
    ],
    autoRegenerate: false,
  };

  const p1 = gate.explicit("u1", firstOpts);
  const p2 = gate.explicit("u1", secondOpts);

  await Promise.resolve();
  assert.equal(received.length, 1);

  releaseFirst();
  await assert.rejects(() => p1, /first explicit failed/);
  const secondResult = await p2;

  assert.equal(secondResult, "secret-from-server");
  assert.deepEqual(received, [
    { uid: "u1", opts: firstOpts },
    { uid: "u1", opts: secondOpts },
  ]);

  // Successful second explicit recorded lastSuccess, so immediate fromHome is throttled
  await gate.fromHome("u1", secondOpts.mistakes);
  assert.equal(received.length, 2);
});

test("invalidate clears lastSuccess for that uid so fromHome runs even within 10 minutes", async () => {
  let currentTime = 1_000_000;
  const calls: string[] = [];

  const gate = createFeedSyncGate({
    run: async (uid) => {
      calls.push(uid);
    },
    now: () => currentTime,
    today: () => "2026-11-26",
  });

  await gate.fromHome("u1");
  await gate.fromHome("u2");
  assert.deepEqual(calls, ["u1", "u2"]);

  // Within 10 minutes -> both throttled
  currentTime += 60 * 1000;
  await gate.fromHome("u1");
  await gate.fromHome("u2");
  assert.deepEqual(calls, ["u1", "u2"]);

  // Invalidate u1 only -> u1 runs immediately within 10m, u2 remains throttled
  gate.invalidate("u1");
  currentTime += 1000;
  await gate.fromHome("u1");
  await gate.fromHome("u2");
  assert.deepEqual(calls, ["u1", "u2", "u1"]);
});
