import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLectureForCard } from "../src/services/lecture/lectureCardLoad.ts";
import {
  isLatestRequest,
  shouldShowLectureChecking,
  shouldStartPollRefresh,
} from "../src/services/lecture/lectureSyncPolicy.ts";
import type { LectureDoc } from "../src/services/lecture/lectureService.ts";

function makeLecture(overrides: Partial<LectureDoc> = {}): LectureDoc {
  return {
    date: "2026-11-26",
    status: "ready",
    createdAt: "2026-11-26T00:00:00.000Z",
    ...overrides,
  };
}

test("null local calls onLocal before server settles and passes local to syncServer", async () => {
  const events: string[] = [];
  let releaseServer!: (doc: LectureDoc | null) => void;
  const serverDoc = makeLecture({ title: "서버 강의" });

  const promise = loadLectureForCard({
    readLocal: async () => {
      events.push("readLocal");
      return null;
    },
    syncServer: (current) => {
      events.push(`syncServer:${current === null ? "null" : "doc"}`);
      return new Promise<LectureDoc | null>((resolve) => {
        releaseServer = resolve;
      });
    },
    onLocal: (l, needsServer) => {
      events.push(`onLocal:${l === null ? "null" : "doc"}:${needsServer}`);
    },
  });

  // Yield microtasks so readLocal + onLocal + syncServer invocation run
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events, ["readLocal", "onLocal:null:true", "syncServer:null"]);

  releaseServer(serverDoc);
  const res = await promise;
  assert.deepEqual(res, { lecture: serverDoc, server: "ok" });
});

test("ready local skips server without calling syncServer", async () => {
  const local = makeLecture({ status: "ready", audioUrl: "https://example.com/a.mp3" });
  let serverCalls = 0;
  let localArgs: [LectureDoc | null, boolean] | undefined;

  const res = await loadLectureForCard({
    readLocal: async () => local,
    syncServer: async () => {
      serverCalls++;
      return null;
    },
    onLocal: (l, needsServer) => {
      localArgs = [l, needsServer];
    },
  });

  assert.equal(serverCalls, 0);
  assert.deepEqual(localArgs, [local, false]);
  assert.deepEqual(res, { lecture: local, server: "skipped" });
});

test("server failure and timeout fall back to local lecture", async () => {
  const generating = makeLecture({ status: "generating" });

  const failedRes = await loadLectureForCard({
    readLocal: async () => generating,
    syncServer: async (cur) => {
      assert.equal(cur, generating);
      throw new Error("network");
    },
    onLocal: () => {},
  });
  assert.deepEqual(failedRes, { lecture: generating, server: "failed" });

  const timeoutRes = await loadLectureForCard({
    readLocal: async () => generating,
    syncServer: () => new Promise(() => {}),
    onLocal: () => {},
    timeoutMs: 20,
  });
  assert.deepEqual(timeoutRes, { lecture: generating, server: "timeout" });
});

test("restoring ready lecture checks server with local passed as current", async () => {
  const restoring = makeLecture({
    status: "ready",
    audioStatus: "rebuilding",
    audioUrl: null,
    hasAudio: false,
  });
  const restored = makeLecture({
    status: "ready",
    audioStatus: "ready",
    hasAudio: true,
  });
  let receivedCurrent: LectureDoc | null | undefined;
  let needsServerFlag: boolean | undefined;

  const res = await loadLectureForCard({
    readLocal: async () => restoring,
    syncServer: async (cur) => {
      receivedCurrent = cur;
      return restored;
    },
    onLocal: (_l, needsServer) => {
      needsServerFlag = needsServer;
    },
  });

  assert.equal(needsServerFlag, true);
  assert.equal(receivedCurrent, restoring);
  assert.deepEqual(res, { lecture: restored, server: "ok" });
});

test("onServerSettled fires once after timeout with late server result or local fallback", async () => {
  const local = makeLecture({ status: "failed" });
  const lateServer = makeLecture({ status: "generating", title: "생성 중" });
  let releaseLate!: (doc: LectureDoc | null) => void;
  const settled: Array<{ lecture: LectureDoc | null; status: "ok" | "failed" }> = [];

  const res = await loadLectureForCard({
    readLocal: async () => local,
    syncServer: () =>
      new Promise<LectureDoc | null>((resolve) => {
        releaseLate = resolve;
      }),
    onLocal: () => {},
    onServerSettled: (lecture, status) => {
      settled.push({ lecture, status });
    },
    timeoutMs: 15,
  });

  assert.deepEqual(res, { lecture: local, server: "timeout" });
  assert.equal(settled.length, 0);

  releaseLate(lateServer);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(settled, [{ lecture: lateServer, status: "ok" }]);

  // Late null resolution falls back to local; late rejection emits "failed" with local.
  let releaseNull!: (doc: LectureDoc | null) => void;
  const nullSettled: Array<{ lecture: LectureDoc | null; status: "ok" | "failed" }> = [];
  await loadLectureForCard({
    readLocal: async () => local,
    syncServer: () =>
      new Promise<LectureDoc | null>((resolve) => {
        releaseNull = resolve;
      }),
    onLocal: () => {},
    onServerSettled: (lecture, status) => {
      nullSettled.push({ lecture, status });
    },
    timeoutMs: 15,
  });
  releaseNull(null);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(nullSettled, [{ lecture: local, status: "ok" }]);

  let rejectLate!: (err: Error) => void;
  const failSettled: Array<{ lecture: LectureDoc | null; status: "ok" | "failed" }> = [];
  await loadLectureForCard({
    readLocal: async () => local,
    syncServer: () =>
      new Promise<LectureDoc | null>((_resolve, reject) => {
        rejectLate = reject;
      }),
    onLocal: () => {},
    onServerSettled: (lecture, status) => {
      failSettled.push({ lecture, status });
    },
    timeoutMs: 15,
  });
  rejectLate(new Error("late failure"));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(failSettled, [{ lecture: local, status: "failed" }]);
});

test("onServerSettled is not called when syncServer settles before timeout", async () => {
  const serverDoc = makeLecture({ status: "generating" });
  let calls = 0;

  const okRes = await loadLectureForCard({
    readLocal: async () => null,
    syncServer: async () => serverDoc,
    onLocal: () => {},
    onServerSettled: () => {
      calls++;
    },
    timeoutMs: 100,
  });
  assert.deepEqual(okRes, { lecture: serverDoc, server: "ok" });

  const failRes = await loadLectureForCard({
    readLocal: async () => null,
    syncServer: async () => {
      throw new Error("boom");
    },
    onLocal: () => {},
    onServerSettled: () => {
      calls++;
    },
    timeoutMs: 100,
  });
  assert.deepEqual(failRes, { lecture: null, server: "failed" });
  assert.equal(calls, 0);
});

test("lecture card pure policies guard poll overlap, request generations, and checking notice", () => {
  assert.equal(shouldStartPollRefresh(false), true);
  assert.equal(shouldStartPollRefresh(true), false);

  assert.equal(isLatestRequest(3, 3), true);
  assert.equal(isLatestRequest(2, 3), false);

  assert.equal(shouldShowLectureChecking({ loading: false, status: undefined, serverChecking: true }), true);
  assert.equal(shouldShowLectureChecking({ loading: false, status: "failed", serverChecking: true }), true);
  assert.equal(shouldShowLectureChecking({ loading: false, status: "generating", serverChecking: true }), false);
  assert.equal(shouldShowLectureChecking({ loading: false, status: "ready", serverChecking: true }), false);
  assert.equal(shouldShowLectureChecking({ loading: true, status: undefined, serverChecking: true }), false);
  assert.equal(shouldShowLectureChecking({ loading: false, status: "failed", serverChecking: false }), false);
});

test("readLocal rejection propagates without calling onLocal, syncServer, or onServerSettled", async () => {
  const boom = new Error("local read failed");
  let onLocalCalls = 0;
  let syncServerCalls = 0;
  let settledCalls = 0;

  await assert.rejects(
    () =>
      loadLectureForCard({
        readLocal: async () => {
          throw boom;
        },
        syncServer: async () => {
          syncServerCalls++;
          return null;
        },
        onLocal: () => {
          onLocalCalls++;
        },
        onServerSettled: () => {
          settledCalls++;
        },
      }),
    (err: unknown) => err === boom
  );

  assert.equal(onLocalCalls, 0);
  assert.equal(syncServerCalls, 0);
  assert.equal(settledCalls, 0);
});
