import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeRecordingState,
  formatRecordingChunksSummary,
  formatSessionChipLabel,
} from "../src/ui/call/unfinishedSessionSummary.ts";
import {
  DEFAULT_STALE_SESSION_MS,
  isInterruptedSession,
} from "../src/services/session/interruptedSession.ts";

test("describeRecordingState: 조각 0개 & 대화 기록 0턴", () => {
  const res = describeRecordingState({
    recordingChunks: [],
    liveTranscript: [],
  });
  assert.equal(res.tone, "empty");
  assert.equal(
    res.text,
    "저장된 녹음이나 대화 기록이 없어요. 복기할 내용이 없으면 보관만 해 주세요."
  );
});

test("describeRecordingState: 조각 0개 & 대화 기록 있음", () => {
  const res = describeRecordingState({
    recordingChunks: [],
    liveTranscript: [
      { role: "model", text: "Hello!" },
      { role: "user", text: "Hi there." },
      { role: "model", text: "How are you?" },
    ],
  });
  assert.equal(res.tone, "transcript_only");
  assert.equal(
    res.text,
    "저장된 녹음 조각은 없어요. 실시간 대화 기록 3턴으로 복기할 수 있어요."
  );
});

test("describeRecordingState: 조각이 있고 전부 uploaded !== false", () => {
  const res = describeRecordingState({
    recordingChunks: [
      { index: 0, path: "a/0.webm", timestamp: "2026-11-21T04:00:00Z", uploaded: true, durationSeconds: 10 },
      { index: 1, path: "a/1.webm", timestamp: "2026-11-21T04:00:10Z", uploaded: true, durationSeconds: 10 },
    ],
    liveTranscript: [],
  });
  assert.equal(res.tone, "saved");
  assert.equal(res.text, "녹음은 안전하게 저장돼 있어요.");
});

test("describeRecordingState: 일부가 uploaded === false", () => {
  const res = describeRecordingState({
    recordingChunks: [
      { index: 0, path: "a/0.webm", timestamp: "2026-11-21T04:00:00Z", uploaded: true, durationSeconds: 10 },
      { index: 1, path: "a/1.webm", timestamp: "2026-11-21T04:00:10Z", uploaded: false, durationSeconds: 10 },
      { index: 2, path: "a/2.webm", timestamp: "2026-11-21T04:00:20Z", uploaded: false, durationSeconds: 10 },
    ],
    liveTranscript: [{ role: "user", text: "hello" }],
  });
  assert.equal(res.tone, "uploading");
  assert.equal(
    res.text,
    "녹음 조각 2개는 아직 올라가지 않았어요. 앱을 켜 둔 채 잠시 기다린 뒤 복기해 주세요."
  );
});

test("formatRecordingChunksSummary: 반올림한 초 기준으로 60초 미만은 초, 이상은 분으로 표기한다", () => {
  assert.equal(formatRecordingChunksSummary(0), "0개 (0초)");
  assert.equal(formatRecordingChunksSummary(1), "1개 (10초)");
  assert.equal(formatRecordingChunksSummary(2), "2개 (20초)");
  assert.equal(formatRecordingChunksSummary(5), "5개 (50초)");
  assert.equal(formatRecordingChunksSummary(6), "6개 (1분)");
  assert.equal(formatRecordingChunksSummary(12), "12개 (2분)");
  assert.equal(
    formatRecordingChunksSummary([
      { durationSeconds: 10 },
      { durationSeconds: 10 },
    ]),
    "2개 (20초)"
  );
  // 59.4초 → 59초, 59.5~59.9초 → 반올림 60초이므로 1분
  assert.equal(formatRecordingChunksSummary([{ durationSeconds: 59.4 }]), "1개 (59초)");
  assert.equal(formatRecordingChunksSummary([{ durationSeconds: 59.5 }]), "1개 (1분)");
  assert.equal(formatRecordingChunksSummary([{ durationSeconds: 59.9 }]), "1개 (1분)");
  assert.equal(
    formatRecordingChunksSummary([{ durationSeconds: 30 }, { durationSeconds: 29.6 }]),
    "2개 (1분)"
  );
});

test("isInterruptedSession: 기본 2분 임계값과 staleAfterMs: 0 동작", () => {
  const baseTime = new Date("2026-11-21T04:00:00.000Z").getTime();
  const inProgress = {
    status: "in-progress" as const,
    startedAt: "2026-11-21T04:00:00.000Z",
    lastChunkAt: "2026-11-21T04:00:00.000Z",
  };

  // 기본 2분: 정확히 2분(120초)까지는 false, 2분 초과부터 true
  assert.equal(isInterruptedSession(inProgress, baseTime + DEFAULT_STALE_SESSION_MS), false);
  assert.equal(isInterruptedSession(inProgress, baseTime + DEFAULT_STALE_SESSION_MS + 1), true);

  // staleAfterMs: 0(새로 열림): 경과 시간과 무관하게 즉시 true
  assert.equal(isInterruptedSession(inProgress, baseTime, 0), true);
  assert.equal(isInterruptedSession(inProgress, baseTime + 5_000, 0), true);

  // in-progress 외 상태는 항상 false
  assert.equal(
    isInterruptedSession({ ...inProgress, status: "pending_review" }, baseTime + 300_000, 0),
    false
  );
  assert.equal(
    isInterruptedSession({ ...inProgress, status: "done" }, baseTime + 300_000, 0),
    false
  );
});

test("formatSessionChipLabel: 날짜·시각과 과 번호를 간결하게 표기한다", () => {
  const localIso = new Date(2026, 10, 21, 13, 13, 0).toISOString();
  assert.equal(
    formatSessionChipLabel({ startedAt: localIso, lessonIndex: 4 }),
    "11/21 13:13 · 4과"
  );
});
