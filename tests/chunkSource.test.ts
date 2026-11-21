import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createChunkDownloadTracker,
  extractDownloadToken,
  failureReasonForStatus,
  formatChunkDownloadWarning,
  isFirebaseStorageUrl,
  planChunkSources,
  shouldUseDownloadedChunks,
} from "../src/services/review/chunkSource.ts";

test("isFirebaseStorageUrl: firebase 호스트만 true", () => {
  assert.equal(
    isFirebaseStorageUrl(
      "https://firebasestorage.googleapis.com/v0/b/my-bucket/o/users%2Fu1%2Frecordings%2Fcall-1%2Fchunk_0000_123.webm?alt=media&token=abc"
    ),
    true
  );
  assert.equal(isFirebaseStorageUrl("/api/recordings/file?path=recordings%2Fcall-1%2Fchunk_0000_123.webm"), false);
  assert.equal(isFirebaseStorageUrl("https://evil.com/firebasestorage.googleapis.com"), false);
  assert.equal(isFirebaseStorageUrl("not-a-url"), false);
  assert.equal(isFirebaseStorageUrl(undefined), false);
});

test("extractDownloadToken: token 쿼리 추출, 없으면 undefined", () => {
  assert.equal(
    extractDownloadToken("https://firebasestorage.googleapis.com/v0/b/b/o/x?alt=media&token=550e8400-e29b-41d4-a716-446655440000"),
    "550e8400-e29b-41d4-a716-446655440000"
  );
  assert.equal(extractDownloadToken("https://firebasestorage.googleapis.com/v0/b/b/o/x?alt=media"), undefined);
  assert.equal(extractDownloadToken("bad-url"), undefined);
});

test("planChunkSources: firebase URL, serverFile, skip, 로컬 우선 및 오름차순, 외부 직접 URL 없음", () => {
  const sources = planChunkSources(
    [
      {
        index: 3,
        path: "recordings/call-1/chunk_0003_1732170003000.webm",
        storageUrl: "/api/recordings/file?path=recordings%2Fcall-1%2Fchunk_0003_1732170003000.webm",
        uploaded: true,
      },
      {
        index: 1,
        path: "recordings/call-1/chunk_0001_1732170001000.webm",
        storageUrl:
          "https://firebasestorage.googleapis.com/v0/b/my-bucket/o/users%2Fu1%2Frecordings%2Fcall-1%2Fchunk_0001_1732170001000.webm?alt=media&token=tok-123",
        uploaded: true,
      },
      {
        index: 2,
        path: "recordings/call-1/chunk_0002_1732170002000.webm",
        uploaded: false,
      },
      {
        index: 0,
        path: "recordings/call-1/chunk_0000_1732170000000.webm",
        storageUrl:
          "https://firebasestorage.googleapis.com/v0/b/my-bucket/o/users%2Fu1%2Frecordings%2Fcall-1%2Fchunk_0000_1732170000000.webm?alt=media",
        uploaded: true,
      },
    ],
    [1, 4]
  );

  assert.deepEqual(sources, [
    {
      kind: "storageRelay",
      index: 0,
      url: "/api/recordings/storage-file?path=recordings%2Fcall-1%2Fchunk_0000_1732170000000.webm",
    },
    { kind: "local", index: 1 },
    { kind: "skip", index: 2, reason: "not_uploaded" },
    {
      kind: "serverFile",
      index: 3,
      url: "/api/recordings/file?path=recordings%2Fcall-1%2Fchunk_0003_1732170003000.webm",
    },
    { kind: "local", index: 4 },
  ]);

  // firebase URL에 토큰이 있으면 storageRelay에 path·token 모두 인코딩 포함
  const withToken = planChunkSources(
    [
      {
        index: 0,
        path: "recordings/call-1/chunk_0000_1732170000000.webm",
        storageUrl:
          "https://firebasestorage.googleapis.com/v0/b/my-bucket/o/x?alt=media&token=tok-abc",
        uploaded: true,
      },
    ],
    []
  );
  assert.deepEqual(withToken, [
    {
      kind: "storageRelay",
      index: 0,
      url: "/api/recordings/storage-file?path=recordings%2Fcall-1%2Fchunk_0000_1732170000000.webm&token=tok-abc",
    },
  ]);

  // 모든 원격 URL은 /api/로 시작하며 브라우저 직접 다운로드 URL이 없다
  for (const src of [...sources, ...withToken]) {
    if ("url" in src) {
      assert.ok(src.url.startsWith("/api/"), `expected /api/ url, got ${src.url}`);
    }
  }
});

test("tracker: forbidden 1회면 즉시 중단, 남은 개수 skipped", () => {
  const tracker = createChunkDownloadTracker(5);
  tracker.success();
  tracker.failure("forbidden");
  assert.equal(tracker.shouldStop(), true);
  const summary = tracker.finish();
  assert.deepEqual(summary, {
    total: 5,
    downloaded: 1,
    failed: 1,
    skipped: 3,
    stoppedEarly: true,
    reasons: { forbidden: 1 },
  });
  assert.equal(shouldUseDownloadedChunks(summary), false);
});

test("tracker: 연속 3회 실패 시 중단, 성공이 끼면 초기화, skip은 연속 실패에 안 셈", () => {
  const tracker = createChunkDownloadTracker(10);
  tracker.failure("network");
  tracker.failure("not_found");
  assert.equal(tracker.shouldStop(), false);
  tracker.skip("not_uploaded"); // 연속 실패 유지 (아직 2)
  assert.equal(tracker.shouldStop(), false);
  tracker.success(); // 연속 실패 0으로 초기화
  assert.equal(tracker.shouldStop(), false);
  tracker.failure("http_error");
  tracker.skip("not_uploaded"); // skip은 카운트에 넣지 않음
  tracker.failure("network");
  assert.equal(tracker.shouldStop(), false); // 아직 연속 2회
  tracker.failure("network");
  assert.equal(tracker.shouldStop(), true); // 연속 3회 → 중단
  const summary = tracker.finish();
  assert.equal(summary.downloaded, 1);
  assert.equal(summary.failed, 5);
  assert.equal(summary.skipped, 4); // 명시적 skip 2회 + 남은 2개
  assert.equal(summary.stoppedEarly, true);
});

test("failureReasonForStatus 및 formatChunkDownloadWarning, shouldUseDownloadedChunks", () => {
  assert.equal(failureReasonForStatus(403), "forbidden");
  assert.equal(failureReasonForStatus(404), "not_found");
  assert.equal(failureReasonForStatus(500), "http_error");

  assert.equal(
    formatChunkDownloadWarning({
      total: 4,
      downloaded: 4,
      failed: 0,
      skipped: 0,
      stoppedEarly: false,
      reasons: {},
    }),
    null
  );

  const partialOk = {
    total: 14,
    downloaded: 11,
    failed: 3,
    skipped: 0,
    stoppedEarly: false,
    reasons: { network: 2, not_found: 1 },
  };
  assert.equal(shouldUseDownloadedChunks(partialOk), true);
  assert.equal(
    formatChunkDownloadWarning(partialOk),
    "[ReviewPipeline] Chunk download: 3/14 failed (network×2, not_found×1)"
  );

  assert.equal(
    formatChunkDownloadWarning({
      total: 14,
      downloaded: 1,
      failed: 3,
      skipped: 10,
      stoppedEarly: true,
      reasons: { forbidden: 1, network: 2 },
    }),
    "[ReviewPipeline] Chunk download: 3/14 failed (forbidden×1, network×2), 10 skipped, stopped early"
  );
});
