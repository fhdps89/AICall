import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createChunkUploader,
  createPendingRetryRunner,
  selectRetryableChunks,
} from "../src/services/firebase/uploadPolicy.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("direct 성공 시 relay를 호출하지 않는다", async () => {
  let directCalls = 0;
  let relayCalls = 0;

  const uploader = createChunkUploader<string>({
    direct: async (path) => {
      directCalls++;
      return `https://firebase.example/${path}`;
    },
    relay: async (path) => {
      relayCalls++;
      return `/api/recordings/file?path=${path}`;
    },
  });

  const url = await uploader.upload("recordings/s1/chunk_0.webm", "audio");
  assert.equal(url, "https://firebase.example/recordings/s1/chunk_0.webm");
  assert.equal(directCalls, 1);
  assert.equal(relayCalls, 0);
  assert.equal(uploader.isDirectBlocked(), false);
});

test("direct 실패 시 relay로 폴백하고, 쿨다운 동안은 direct를 호출하지 않는다", async () => {
  let nowMs = 1_000;
  let directCalls = 0;
  let relayCalls = 0;
  let warnCalls = 0;

  const uploader = createChunkUploader<string>({
    now: () => nowMs,
    cooldownMs: 10 * 60 * 1000,
    onWarn: () => {
      warnCalls++;
    },
    direct: async () => {
      directCalls++;
      throw new Error("CORS blocked");
    },
    relay: async (path) => {
      relayCalls++;
      return `/api/recordings/file?path=${path}`;
    },
  });

  const url1 = await uploader.upload("c1.webm", "a");
  assert.equal(url1, "/api/recordings/file?path=c1.webm");
  assert.equal(directCalls, 1);
  assert.equal(relayCalls, 1);
  assert.equal(warnCalls, 1);
  assert.equal(uploader.isDirectBlocked(), true);

  // 쿨다운 이내 연속 호출: direct 미호출, 경고도 추가 발생 없음
  nowMs += 5 * 60 * 1000;
  const url2 = await uploader.upload("c2.webm", "b");
  const url3 = await uploader.upload("c3.webm", "c");
  assert.equal(url2, "/api/recordings/file?path=c2.webm");
  assert.equal(url3, "/api/recordings/file?path=c3.webm");
  assert.equal(directCalls, 1);
  assert.equal(relayCalls, 3);
  assert.equal(warnCalls, 1);
});

test("direct가 응답 없이 멈추면(never-resolving) 짧은 타임아웃 후 relay로 전환한다", async () => {
  let directCalls = 0;
  let relayCalls = 0;

  const uploader = createChunkUploader<string>({
    directTimeoutMs: 25,
    cooldownMs: 60_000,
    onWarn: () => {},
    direct: async () => {
      directCalls++;
      return new Promise<string>(() => {
        // intentionally never resolves
      });
    },
    relay: async (path) => {
      relayCalls++;
      return `/api/recordings/file?path=${path}`;
    },
  });

  const url = await uploader.upload("hang.webm", "x");
  assert.equal(url, "/api/recordings/file?path=hang.webm");
  assert.equal(directCalls, 1);
  assert.equal(relayCalls, 1);
  assert.equal(uploader.isDirectBlocked(), true);
});

test("쿨다운 경과 후 direct를 1회 재시도하고, 성공하면 직접 불가 기억을 해제한다", async () => {
  let nowMs = 10_000;
  let directShouldFail = true;
  let directCalls = 0;
  let relayCalls = 0;

  const uploader = createChunkUploader<string>({
    now: () => nowMs,
    cooldownMs: 60_000,
    onWarn: () => {},
    direct: async (path) => {
      directCalls++;
      if (directShouldFail) {
        throw new Error("bucket not found");
      }
      return `https://firebase.example/${path}`;
    },
    relay: async (path) => {
      relayCalls++;
      return `/api/recordings/file?path=${path}`;
    },
  });

  await uploader.upload("c1.webm", "a");
  assert.equal(directCalls, 1);
  assert.equal(relayCalls, 1);
  assert.equal(uploader.isDirectBlocked(), true);

  // 쿨다운 경과 전: relay 직행
  nowMs += 59_999;
  await uploader.upload("c2.webm", "b");
  assert.equal(directCalls, 1);
  assert.equal(relayCalls, 2);

  // 쿨다운 만료 후 복구: direct 재시도 성공 및 기억 해제
  nowMs += 1;
  directShouldFail = false;
  const recoveredUrl = await uploader.upload("c3.webm", "c");
  assert.equal(recoveredUrl, "https://firebase.example/c3.webm");
  assert.equal(directCalls, 2);
  assert.equal(relayCalls, 2);
  assert.equal(uploader.isDirectBlocked(), false);

  // 이후 호출도 direct 유지
  const nextUrl = await uploader.upload("c4.webm", "d");
  assert.equal(nextUrl, "https://firebase.example/c4.webm");
  assert.equal(directCalls, 3);
  assert.equal(relayCalls, 2);
});

test("direct와 relay가 모두 실패하면 두 오류 메시지를 모두 담은 Error를 던진다", async () => {
  const uploader = createChunkUploader<string>({
    onWarn: () => {},
    direct: async () => {
      throw new Error("direct-404-bucket");
    },
    relay: async () => {
      throw new Error("relay-http-502");
    },
  });

  await assert.rejects(
    () => uploader.upload("fail.webm", "x"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /direct-404-bucket/);
      assert.match(err.message, /relay-http-502/);
      return true;
    }
  );
});

test("동시 호출 여러 개가 쿨다운 상태를 일관되게 공유하고 경고는 한 번만 남긴다", async () => {
  let nowMs = 5_000;
  let directCalls = 0;
  let relayCalls = 0;
  let warnCalls = 0;

  const uploader = createChunkUploader<string>({
    now: () => nowMs,
    cooldownMs: 60_000,
    onWarn: () => {
      warnCalls++;
    },
    direct: async () => {
      directCalls++;
      await sleep(15);
      throw new Error("network error");
    },
    relay: async (path) => {
      relayCalls++;
      return `/api/recordings/file?path=${path}`;
    },
  });

  const results = await Promise.all([
    uploader.upload("p1.webm", "1"),
    uploader.upload("p2.webm", "2"),
    uploader.upload("p3.webm", "3"),
  ]);

  assert.deepEqual(results, [
    "/api/recordings/file?path=p1.webm",
    "/api/recordings/file?path=p2.webm",
    "/api/recordings/file?path=p3.webm",
  ]);
  assert.equal(directCalls, 3);
  assert.equal(relayCalls, 3);
  assert.equal(warnCalls, 1);
  assert.equal(uploader.isDirectBlocked(), true);

  // 직후 추가 호출은 direct를 부르지 않음
  const directCallsBeforeNext = directCalls;
  await uploader.upload("p4.webm", "4");
  assert.equal(directCalls, directCallsBeforeNext);
  assert.equal(relayCalls, 4);
  assert.equal(warnCalls, 1);
});

test("selectRetryableChunks는 30초 이내 조각을 건너뛰고 30초 이상 지난 조각만 고른다", () => {
  const nowMs = 100_000;
  const chunks = [
    { id: "old", timestamp: 69_999 },
    { id: "exact", timestamp: 70_000 },
    { id: "recent", timestamp: 70_001 },
    { id: "brand-new", timestamp: 99_500 },
  ];

  const selected = selectRetryableChunks(chunks, nowMs);
  assert.deepEqual(
    selected.map((c) => c.id),
    ["old", "exact"]
  );
});

test("createPendingRetryRunner는 동시 실행을 막고(skipped: true), 한 조각 실패 시에도 나머지를 계속 처리한다", async () => {
  const nowMs = 100_000;
  const uploaded: string[] = [];
  const errored: string[] = [];
  let getPendingCalls = 0;

  const chunks = [
    { id: "c1-fail", timestamp: 10_000 },
    { id: "c2-ok", timestamp: 20_000 },
    { id: "c3-recent-skip", timestamp: 95_000 },
  ];

  const run = createPendingRetryRunner<(typeof chunks)[number], string>({
    now: () => nowMs,
    getPending: async () => {
      getPendingCalls++;
      return chunks;
    },
    uploadChunk: async (chunk, userId) => {
      await sleep(20);
      if (chunk.id === "c1-fail") {
        throw new Error(`failed for ${userId}`);
      }
      uploaded.push(chunk.id);
    },
    onChunkError: (chunk) => {
      errored.push(chunk.id);
    },
  });

  // 동시에 2번 호출: 두 번째 호출은 즉시 skipped: true를 반환하고 중복 실행하지 않음
  const [firstResult, concurrentResult] = await Promise.all([run("u1"), run("u1")]);
  assert.deepEqual(firstResult, { total: 2, uploaded: 1, failed: 1, skipped: false });
  assert.deepEqual(concurrentResult, { total: 0, uploaded: 0, failed: 0, skipped: true });
  assert.equal(getPendingCalls, 1);
  assert.deepEqual(errored, ["c1-fail"]);
  assert.deepEqual(uploaded, ["c2-ok"]);

  // 첫 실행 종료 후 다시 호출하면 정상 실행됨
  const secondResult = await run("u1");
  assert.deepEqual(secondResult, { total: 2, uploaded: 1, failed: 1, skipped: false });
  assert.equal(getPendingCalls, 2);
});
