import { test } from "node:test";
import assert from "node:assert/strict";
import { createPendingRetryRunner } from "../src/services/firebase/uploadPolicy.ts";
import {
  deletePendingChunks,
  retryPendingUploads,
  retryPendingUploadsDetailed,
  selectChunksToDelete,
  type LocalRecordingChunk,
} from "../src/services/recording/chunkIndexedDb.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeChunk(overrides: Partial<LocalRecordingChunk> = {}): LocalRecordingChunk {
  return {
    id: "sess1_chunk_0",
    sessionId: "sess1",
    userId: "u1",
    index: 0,
    blob: new Blob(["audio"]),
    mimeType: "audio/webm",
    durationSeconds: 10,
    timestamp: 10_000,
    createdAt: "2026-11-21T00:00:00.000Z",
    uploaded: false,
    ...overrides,
  };
}

function createFakeIndexedDb(initialChunks: LocalRecordingChunk[]) {
  const storeMap = new Map(initialChunks.map((c) => [c.id, c]));

  const fakeIndexedDB = {
    open: () => {
      const openReq: Record<string, any> = {};
      queueMicrotask(() => {
        openReq.result = {
          objectStoreNames: { contains: () => true },
          transaction: (_name: string, _mode: string) => {
            const tx: Record<string, any> = {};
            let pendingOps = 0;
            const finishOp = () => {
              pendingOps--;
              if (pendingOps === 0) {
                queueMicrotask(() => tx.oncomplete?.());
              }
            };
            const store = {
              getAll: () => {
                const req: Record<string, any> = {};
                pendingOps++;
                queueMicrotask(() => {
                  req.result = Array.from(storeMap.values());
                  req.onsuccess?.();
                  finishOp();
                });
                return req;
              },
              delete: (id: string) => {
                const req: Record<string, any> = {};
                pendingOps++;
                queueMicrotask(() => {
                  storeMap.delete(id);
                  req.onsuccess?.();
                  finishOp();
                });
                return req;
              },
            };
            tx.objectStore = () => store;
            return tx;
          },
        };
        openReq.onsuccess?.();
      });
      return openReq;
    },
  };

  return { fakeIndexedDB, storeMap };
}

test("selectChunksToDelete와 deletePendingChunks는 필터 유무에 따라 대기 조각을 선택·삭제한다", async () => {
  const chunks = [
    makeChunk({ id: "s1_0", sessionId: "s1", index: 0 }),
    makeChunk({ id: "s1_1", sessionId: "s1", index: 1 }),
    makeChunk({ id: "s2_0", sessionId: "s2", index: 0 }),
  ];

  // 순수 선택 로직 검증 (필터 없음 → 전체 복사, 필터 있음 → 조건 일치만)
  const allSelected = selectChunksToDelete(chunks);
  assert.deepEqual(
    allSelected.map((c) => c.id),
    ["s1_0", "s1_1", "s2_0"]
  );
  assert.notEqual(allSelected, chunks);

  const s1Only = selectChunksToDelete(chunks, (c) => c.sessionId === "s1");
  assert.deepEqual(
    s1Only.map((c) => c.id),
    ["s1_0", "s1_1"]
  );

  // 가짜 window.indexedDB로 deletePendingChunks 부분 삭제 및 전체 삭제 검증
  const prevWindow = (globalThis as any).window;
  const { fakeIndexedDB, storeMap } = createFakeIndexedDb(chunks);
  (globalThis as any).window = { indexedDB: fakeIndexedDB };

  try {
    const partialDeleted = await deletePendingChunks((c) => c.sessionId === "s1");
    assert.equal(partialDeleted, 2);
    assert.deepEqual(Array.from(storeMap.keys()), ["s2_0"]);

    const remainingDeleted = await deletePendingChunks();
    assert.equal(remainingDeleted, 1);
    assert.equal(storeMap.size, 0);

    const emptyDeleted = await deletePendingChunks();
    assert.equal(emptyDeleted, 0);
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
  }
});

test("createPendingRetryRunner는 force: true일 때 30초 유예를 건너뛴다", async () => {
  const nowMs = 100_000;
  const chunks = [
    { id: "old", timestamp: 50_000 },
    { id: "recent", timestamp: 90_000 }, // 10초 전 생성 → 기본 모드에서는 건너뜀
  ];
  const attempted: string[] = [];

  const run = createPendingRetryRunner<(typeof chunks)[number], string>({
    now: () => nowMs,
    getPending: async () => chunks,
    uploadChunk: async (chunk) => {
      attempted.push(chunk.id);
    },
  });

  const normalResult = await run("u1");
  assert.deepEqual(attempted, ["old"]);
  assert.deepEqual(normalResult, { total: 1, uploaded: 1, failed: 0, skipped: false });

  attempted.length = 0;
  const forcedResult = await run("u1", { force: true });
  assert.deepEqual(attempted, ["old", "recent"]);
  assert.deepEqual(forcedResult, { total: 2, uploaded: 2, failed: 0, skipped: false });
});

test("createPendingRetryRunner는 force: true에서도 동시 실행 가드를 유지하고 건너뛰면 skipped: true를 반환한다", async () => {
  const nowMs = 100_000;
  const chunks = [{ id: "recent", timestamp: 99_000 }];
  let getPendingCalls = 0;
  let uploadCalls = 0;

  const run = createPendingRetryRunner<(typeof chunks)[number], string>({
    now: () => nowMs,
    getPending: async () => {
      getPendingCalls++;
      return chunks;
    },
    uploadChunk: async () => {
      uploadCalls++;
      await sleep(25);
    },
  });

  const [first, concurrentForced] = await Promise.all([
    run("u1", { force: true }),
    run("u1", { force: true }),
  ]);

  assert.deepEqual(first, { total: 1, uploaded: 1, failed: 0, skipped: false });
  assert.deepEqual(concurrentForced, { total: 0, uploaded: 0, failed: 0, skipped: true });
  assert.equal(getPendingCalls, 1);
  assert.equal(uploadCalls, 1);

  // 완료 후에는 force 재실행이 정상 동작함
  const afterDone = await run("u1", { force: true });
  assert.deepEqual(afterDone, { total: 1, uploaded: 1, failed: 0, skipped: false });
  assert.equal(getPendingCalls, 2);
  assert.equal(uploadCalls, 2);
});

test("createPendingRetryRunner와 retryPendingUploadsDetailed 결과는 total === uploaded + failed와 skipped 구분을 만족한다", async () => {
  const nowMs = 100_000;
  let currentChunks = [
    { id: "ok-1", timestamp: 95_000 },
    { id: "fail-1", timestamp: 96_000 },
    { id: "ok-2", timestamp: 97_000 },
  ];

  const run = createPendingRetryRunner<(typeof currentChunks)[number], string>({
    now: () => nowMs,
    getPending: async () => currentChunks,
    uploadChunk: async (chunk) => {
      if (chunk.id.startsWith("fail")) {
        throw new Error("upload failed");
      }
    },
  });

  const mixed = await run("u1", { force: true });
  assert.equal(mixed.total, 3);
  assert.equal(mixed.uploaded, 2);
  assert.equal(mixed.failed, 1);
  assert.equal(mixed.skipped, false);
  assert.equal(mixed.uploaded + mixed.failed, mixed.total);

  currentChunks = [];
  const empty = await run("u1", { force: true });
  assert.deepEqual(empty, { total: 0, uploaded: 0, failed: 0, skipped: false });
  assert.equal(empty.uploaded + empty.failed, empty.total);

  // 실제 chunkIndexedDb 래퍼 경로(빈 DB)에서도 동시 실행 가드(skipped: true)와 number 반환 유지 확인
  const prevWindow = (globalThis as any).window;
  const { fakeIndexedDB } = createFakeIndexedDb([]);
  (globalThis as any).window = { indexedDB: fakeIndexedDB };

  try {
    const [firstDetailed, concurrentDetailed] = await Promise.all([
      retryPendingUploadsDetailed("u1", { force: true }),
      retryPendingUploadsDetailed("u1", { force: true }),
    ]);
    assert.deepEqual(firstDetailed, { total: 0, uploaded: 0, failed: 0, skipped: false });
    assert.deepEqual(concurrentDetailed, { total: 0, uploaded: 0, failed: 0, skipped: true });

    const uploadedCount = await retryPendingUploads("u1");
    assert.equal(uploadedCount, 0);
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
  }
});
