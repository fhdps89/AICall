import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STORAGE_HOST,
  StorageFileTooLargeError,
  firebaseAuthHeader,
  isValidDownloadToken,
  readStorageBucket,
  readStreamWithLimit,
  relayContentType,
  relayErrorFor,
  storageMediaUrl,
  storageUploadUrl,
  storageObjectPath,
} from "../server/storageRelay.ts";

test("storageObjectPath: 정상 경로에 users/uid 접두", () => {
  assert.equal(
    storageObjectPath("u1", "recordings/call-1/chunk_0001_1732170000000.webm"),
    "users/u1/recordings/call-1/chunk_0001_1732170000000.webm"
  );
});

test("storageObjectPath: ../·절대경로·다른 확장자·빈 값·uid 특수문자 거부", () => {
  assert.equal(storageObjectPath("u1", "../u2/recordings/call-1/chunk_0001_1732170000000.webm"), null);
  assert.equal(storageObjectPath("u1", "recordings/../chunk_0001_1732170000000.webm"), null);
  assert.equal(storageObjectPath("u1", "/recordings/call-1/chunk_0001_1732170000000.webm"), null);
  assert.equal(storageObjectPath("u1", "recordings/call-1/chunk_0001_1732170000000.mp3"), null);
  assert.equal(storageObjectPath("u1", ""), null);
  assert.equal(storageObjectPath("", "recordings/call-1/chunk_0001_1732170000000.webm"), null);
  assert.equal(storageObjectPath("u1/../../etc", "recordings/call-1/chunk_0001_1732170000000.webm"), null);
});

test("storageMediaUrl: 객체 경로 전체 인코딩 및 고정 호스트", () => {
  const url = storageMediaUrl(
    "my-bucket.firebasestorage.app",
    "users/u1/recordings/call-1/chunk_0001_1732170000000.webm"
  );
  assert.ok(url);
  const parsed = new URL(url);
  assert.equal(parsed.hostname, STORAGE_HOST);
  assert.ok(
    url.includes("/v0/b/my-bucket.firebasestorage.app/o/users%2Fu1%2Frecordings%2Fcall-1%2Fchunk_0001_1732170000000.webm?alt=media")
  );
});

test("storageMediaUrl: 토큰 있으면 &token= 추가, 버킷 이상값·빈 값이면 null", () => {
  const withToken = storageMediaUrl(
    "my-bucket.firebasestorage.app",
    "users/u1/recordings/call-1/chunk_0001_1732170000000.webm",
    "550e8400-e29b-41d4-a716-446655440000"
  );
  assert.ok(withToken?.endsWith("&token=550e8400-e29b-41d4-a716-446655440000"));
  assert.equal(storageMediaUrl("", "users/u1/recordings/call-1/chunk_0001_1732170000000.webm"), null);
  assert.equal(storageMediaUrl("BAD_BUCKET!", "users/u1/recordings/call-1/chunk_0001_1732170000000.webm"), null);
  assert.equal(storageMediaUrl("my-bucket.firebasestorage.app", ""), null);
});

test("isValidDownloadToken: UUID 허용, '&'·'/'·공백·배열·129자 거부", () => {
  assert.equal(isValidDownloadToken("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(isValidDownloadToken("abc&foo=1"), false);
  assert.equal(isValidDownloadToken("abc/def"), false);
  assert.equal(isValidDownloadToken("abc def"), false);
  assert.equal(isValidDownloadToken(["550e8400-e29b-41d4-a716-446655440000"]), false);
  assert.equal(isValidDownloadToken("a".repeat(129)), false);
  assert.equal(isValidDownloadToken(""), false);
});

test("firebaseAuthHeader: Bearer 토큰만 Firebase 헤더로 변환", () => {
  assert.equal(firebaseAuthHeader("Bearer abc"), "Firebase abc");
  assert.equal(firebaseAuthHeader("bearer  xyz "), "Firebase xyz");
  assert.equal(firebaseAuthHeader(undefined), null);
  assert.equal(firebaseAuthHeader("Basic x"), null);
});

test("relayErrorFor: 업스트림 상태별 코드·메시지 매핑", () => {
  assert.deepEqual(relayErrorFor(404), {
    status: 404,
    code: "NOT_FOUND",
    message: "녹음 조각을 저장소에서 찾지 못했어요.",
  });
  assert.deepEqual(relayErrorFor(401), {
    status: 403,
    code: "STORAGE_FORBIDDEN",
    message: "저장소에서 녹음 조각을 읽을 권한이 없어요.",
  });
  assert.deepEqual(relayErrorFor(403), {
    status: 403,
    code: "STORAGE_FORBIDDEN",
    message: "저장소에서 녹음 조각을 읽을 권한이 없어요.",
  });
  assert.deepEqual(relayErrorFor(500), {
    status: 502,
    code: "STORAGE_FAILED",
    message: "저장소에서 녹음 조각을 가져오지 못했어요. 잠시 후 다시 시도해 주세요.",
  });
});

test("relayContentType: audio/* 유지, 그 외 application/octet-stream", () => {
  assert.equal(relayContentType("audio/webm;codecs=opus"), "audio/webm;codecs=opus");
  assert.equal(relayContentType("text/html"), "application/octet-stream");
  assert.equal(relayContentType(null), "application/octet-stream");
});

test("readStorageBucket: 존재하지 않는 경로면 환경변수 폴백", () => {
  const prev = process.env.FIREBASE_STORAGE_BUCKET;
  process.env.FIREBASE_STORAGE_BUCKET = "env-bucket.firebasestorage.app";
  try {
    assert.equal(readStorageBucket("/nonexistent/path/config.json"), "env-bucket.firebasestorage.app");
  } finally {
    if (prev === undefined) delete process.env.FIREBASE_STORAGE_BUCKET;
    else process.env.FIREBASE_STORAGE_BUCKET = prev;
  }
});

test("readStreamWithLimit: null·상한 이하·정확히 상한인 스트림을 버퍼로 반환", async () => {
  assert.equal((await readStreamWithLimit(null, 10)).length, 0);

  const chunks = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8, 9, 10])];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  const buf = await readStreamWithLimit(stream, 10);
  assert.deepEqual([...buf], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("readStreamWithLimit: 상한 초과 시 즉시 스트림 취소 및 StorageFileTooLargeError 발생", async () => {
  let pulled = 0;
  let cancelled = false;
  const pieces = [
    new Uint8Array(4),
    new Uint8Array(7), // 누적 11 > 10: 여기서 중단되어야 함
    new Uint8Array(5), // 절대 읽히면 안 됨
  ];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled < pieces.length) {
        controller.enqueue(pieces[pulled++]);
      } else {
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(() => readStreamWithLimit(stream, 10), (err) => err instanceof StorageFileTooLargeError);
  assert.equal(cancelled, true);
  assert.ok(pulled <= 2);
});

test("storageUploadUrl: 정상 버킷·경로 허용, 잘못된 버킷·빈 경로 거부", () => {
  const url = storageUploadUrl("my-bucket.firebasestorage.app", "feeds/abcd/days/2026-11-24.audio.enc");
  assert.equal(
    url,
    "https://firebasestorage.googleapis.com/v0/b/my-bucket.firebasestorage.app/o?uploadType=media&name=feeds%2Fabcd%2Fdays%2F2026-11-24.audio.enc"
  );
  assert.equal(storageUploadUrl("", "feeds/abcd/days/2026-11-24.audio.enc"), null);
  assert.equal(storageUploadUrl("BAD_BUCKET!", "feeds/abcd/days/2026-11-24.audio.enc"), null);
  assert.equal(storageUploadUrl("my-bucket.firebasestorage.app", ""), null);
});
