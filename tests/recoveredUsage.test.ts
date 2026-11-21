import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RECOVERED_CALL_SEC,
  createRecoveredUsageRecorder,
  parseTranscriptTimestamp,
  recoveredCallUsage,
  toKstDateStr,
} from "../src/services/session/recoveredUsage.ts";

test("recoveredCallUsage: endedAt 또는 usageRecordedAt 있으면 null", () => {
  const base = {
    startedAt: "2026-11-21T01:00:00.000Z",
    lastChunkAt: "2026-11-21T01:01:10.000Z",
    liveTranscript: [],
  };
  assert.equal(recoveredCallUsage({ ...base, endedAt: "2026-11-21T01:01:15.000Z" }, "2026-11-21"), null);
  assert.equal(recoveredCallUsage({ ...base, usageRecordedAt: "2026-11-21T01:02:00.000Z" }, "2026-11-21"), null);
});

test("recoveredCallUsage: lastChunkAt - startedAt = 70초 → calls 1, liveMinutes ≈ 70/60", () => {
  const usage = recoveredCallUsage(
    {
      startedAt: "2026-11-21T01:00:00.000Z",
      lastChunkAt: "2026-11-21T01:01:10.000Z",
      liveTranscript: [],
    },
    "2026-11-21"
  );
  assert.ok(usage);
  assert.equal(usage.calls, 1);
  assert.ok(Math.abs(usage.liveMinutes - 70 / 60) < 1e-9);
});

test("recoveredCallUsage: 9초 → calls 0 (분은 기록)", () => {
  const usage = recoveredCallUsage(
    {
      startedAt: "2026-11-21T01:00:00.000Z",
      lastChunkAt: "2026-11-21T01:00:09.000Z",
      liveTranscript: [],
    },
    "2026-11-21"
  );
  assert.ok(usage);
  assert.equal(usage.calls, 0);
  assert.ok(Math.abs(usage.liveMinutes - 9 / 60) < 1e-9);
});

test("recoveredCallUsage: liveTranscript 마지막 timestamp가 더 늦으면 그것을 끝으로 사용", () => {
  const start = Date.parse("2026-11-21T01:00:00.000Z");
  const usage = recoveredCallUsage(
    {
      startedAt: "2026-11-21T01:00:00.000Z",
      lastChunkAt: "2026-11-21T01:00:10.000Z",
      liveTranscript: [{ role: "user", text: "hello", timestamp: start + 120_000 }],
    },
    "2026-11-21"
  );
  assert.deepEqual(usage, { liveMinutes: 2, calls: 1 });
});

test("recoveredCallUsage: KST 날짜가 오늘과 다르면 null, KST 자정 넘긴 시각은 오늘로 기록", () => {
  // 2026-11-20T15:30:00Z = KST 2026-11-21 00:30:00
  assert.equal(toKstDateStr(Date.parse("2026-11-20T15:30:00.000Z")), "2026-11-21");

  const midnightUsage = recoveredCallUsage(
    {
      startedAt: "2026-11-20T15:30:00.000Z",
      lastChunkAt: "2026-11-20T15:31:00.000Z",
      liveTranscript: [],
    },
    "2026-11-21"
  );
  assert.deepEqual(midnightUsage, { liveMinutes: 1, calls: 1 });

  const yesterdayUsage = recoveredCallUsage(
    {
      startedAt: "2026-11-20T14:59:00.000Z", // KST 2026-11-20 23:59:00
      lastChunkAt: "2026-11-20T15:01:00.000Z",
      liveTranscript: [],
    },
    "2026-11-21"
  );
  assert.equal(yesterdayUsage, null);
});

test("recoveredCallUsage: 3시간 상한 및 startedAt 이상값 거부", () => {
  const capped = recoveredCallUsage(
    {
      startedAt: "2026-11-21T00:00:00.000Z",
      lastChunkAt: "2026-11-21T06:00:00.000Z",
      liveTranscript: [],
    },
    "2026-11-21"
  );
  assert.deepEqual(capped, { liveMinutes: MAX_RECOVERED_CALL_SEC / 60, calls: 1 });

  assert.equal(
    recoveredCallUsage(
      {
        startedAt: "invalid-date",
        lastChunkAt: "2026-11-21T01:00:00.000Z",
        liveTranscript: [],
      },
      "2026-11-21"
    ),
    null
  );
});

test("createRecoveredUsageRecorder: 같은 세션 동시 2회 호출 시 기록 1회만 수행", async () => {
  let recorded = false;
  let getCalls = 0;
  let markCalls = 0;
  let usageCalls = 0;
  let releaseGet!: () => void;
  const getGate = new Promise<void>((resolve) => {
    releaseGet = resolve;
  });

  const recordOnce = createRecoveredUsageRecorder({
    getSession: async () => {
      getCalls += 1;
      await getGate;
      return {
        startedAt: "2026-11-21T01:00:00.000Z",
        lastChunkAt: "2026-11-21T01:01:00.000Z",
        liveTranscript: [],
        ...(recorded ? { usageRecordedAt: "2026-11-21T01:02:00.000Z" } : {}),
      };
    },
    markRecorded: async () => {
      markCalls += 1;
      recorded = true;
    },
    recordUsage: async () => {
      usageCalls += 1;
    },
    todayKst: () => "2026-11-21",
  });

  const p1 = recordOnce("u1", "s1");
  const p2 = recordOnce("u1", "s1");
  releaseGet();

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, true);
  assert.equal(r2, false);
  assert.equal(getCalls, 1);
  assert.equal(markCalls, 1);
  assert.equal(usageCalls, 1);

  // 첫 호출 완료 후 재호출해도 이미 usageRecordedAt이 있어 추가 기록 없음
  const r3 = await recordOnce("u1", "s1");
  assert.equal(r3, false);
  assert.equal(markCalls, 1);
  assert.equal(usageCalls, 1);
});

test("createRecoveredUsageRecorder: 다른 세션은 병렬 진행, markRecorded 실패 시 recordUsage 미호출 및 재시도 가능", async () => {
  const recordedSessions: string[] = [];
  let shouldFail = true;

  const recordOnce = createRecoveredUsageRecorder({
    getSession: async () => ({
      startedAt: "2026-11-21T01:00:00.000Z",
      lastChunkAt: "2026-11-21T01:01:00.000Z",
      liveTranscript: [],
    }),
    markRecorded: async (_uid, sessionId) => {
      if (sessionId === "s-err" && shouldFail) {
        throw new Error("firestore offline");
      }
    },
    recordUsage: async (_uid, _usage) => {
      recordedSessions.push("ok");
    },
    todayKst: () => "2026-11-21",
    onError: () => {},
  });

  const [errRes, okRes] = await Promise.all([recordOnce("u1", "s-err"), recordOnce("u1", "s-ok")]);
  assert.equal(errRes, false);
  assert.equal(okRes, true);
  assert.equal(recordedSessions.length, 1);

  shouldFail = false;
  const retryRes = await recordOnce("u1", "s-err");
  assert.equal(retryRes, true);
  assert.equal(recordedSessions.length, 2);
});

test("recoveredCallUsage: 무마이크(lastChunkAt==startedAt, liveTranscript 비었음) + lastTranscriptAt=+105s → 1.75분, calls 1", () => {
  const usage = recoveredCallUsage(
    {
      startedAt: "2026-11-21T01:00:00.000Z",
      lastChunkAt: "2026-11-21T01:00:00.000Z",
      lastTranscriptAt: "2026-11-21T01:01:45.000Z",
      liveTranscript: [],
    },
    "2026-11-21"
  );
  assert.deepEqual(usage, { liveMinutes: 1.75, calls: 1 });
});

test("recoveredCallUsage: 무마이크·timestamp 없음 → lastTranscriptAt만 있으면 그것으로, 둘 다 없으면 null", () => {
  const withTranscriptAt = recoveredCallUsage(
    {
      startedAt: "2026-11-21T01:00:00.000Z",
      lastChunkAt: "2026-11-21T01:00:00.000Z",
      lastTranscriptAt: "2026-11-21T01:00:30.000Z",
      liveTranscript: [{ role: "user", text: "hi" }],
    },
    "2026-11-21"
  );
  assert.deepEqual(withTranscriptAt, { liveMinutes: 0.5, calls: 1 });

  const withNeither = recoveredCallUsage(
    {
      startedAt: "2026-11-21T01:00:00.000Z",
      lastChunkAt: "2026-11-21T01:00:00.000Z",
      liveTranscript: [{ role: "user", text: "hi" }],
    },
    "2026-11-21"
  );
  assert.equal(withNeither, null);
});

test("recoveredCallUsage & parseTranscriptTimestamp: 문자열(숫자·ISO)은 반영, 잘못된 문자열·객체·null은 무시", () => {
  const start = Date.parse("2026-11-21T01:00:00.000Z");

  assert.equal(parseTranscriptTimestamp(start + 1000), start + 1000);
  assert.equal(parseTranscriptTimestamp(String(start + 30_000)), start + 30_000);
  assert.equal(parseTranscriptTimestamp("2026-11-21T01:01:00.000Z"), start + 60_000);
  assert.equal(parseTranscriptTimestamp(""), null);
  assert.equal(parseTranscriptTimestamp("   "), null);
  assert.equal(parseTranscriptTimestamp("not-a-date"), null);
  assert.equal(parseTranscriptTimestamp(null), null);
  assert.equal(parseTranscriptTimestamp(NaN), null);
  assert.equal(parseTranscriptTimestamp({ seconds: 100 }), null);

  const numericStrUsage = recoveredCallUsage(
    {
      startedAt: "2026-11-21T01:00:00.000Z",
      lastChunkAt: "2026-11-21T01:00:00.000Z",
      liveTranscript: [
        { role: "user", text: "ok", timestamp: String(start + 45_000) },
        { role: "model", text: "bad1", timestamp: "not-a-date" },
        { role: "model", text: "bad2", timestamp: { ms: start + 999_000 } },
        { role: "model", text: "bad3", timestamp: null },
      ],
    },
    "2026-11-21"
  );
  assert.deepEqual(numericStrUsage, { liveMinutes: 0.75, calls: 1 });

  const isoStrUsage = recoveredCallUsage(
    {
      startedAt: "2026-11-21T01:00:00.000Z",
      lastChunkAt: "2026-11-21T01:00:00.000Z",
      liveTranscript: [{ role: "model", text: "iso", timestamp: "2026-11-21T01:01:30.000Z" }],
    },
    "2026-11-21"
  );
  assert.deepEqual(isoStrUsage, { liveMinutes: 1.5, calls: 1 });
});

test("recoveredCallUsage: 시작 이전 timestamp와 시작+3시간 초과 timestamp는 무시", () => {
  const start = Date.parse("2026-11-21T01:00:00.000Z");

  // 시작 이전·미래(3시간 초과)는 무시되고 유효한 lastTranscriptAt(+60s)만 반영
  const ignoredOutliers = recoveredCallUsage(
    {
      startedAt: "2026-11-21T01:00:00.000Z",
      lastChunkAt: "2026-11-21T01:00:00.000Z",
      lastTranscriptAt: "2026-11-21T01:01:00.000Z",
      liveTranscript: [
        { role: "model", text: "greeting", timestamp: start - 15_000 },
        { role: "user", text: "future", timestamp: start + MAX_RECOVERED_CALL_SEC * 1000 + 1 },
      ],
    },
    "2026-11-21"
  );
  assert.deepEqual(ignoredOutliers, { liveMinutes: 1, calls: 1 });

  // 시작 이전·3시간 초과만 있으면 후보가 없어 null
  const onlyOutliers = recoveredCallUsage(
    {
      startedAt: "2026-11-21T01:00:00.000Z",
      lastChunkAt: "2026-11-21T01:00:00.000Z",
      liveTranscript: [
        { role: "model", text: "before", timestamp: start - 5_000 },
        { role: "user", text: "too-late", timestamp: start + MAX_RECOVERED_CALL_SEC * 1000 + 5_000 },
      ],
    },
    "2026-11-21"
  );
  assert.equal(onlyOutliers, null);
});

test("recoveredCallUsage: updatedAt이 더 늦어도 결과 불변", () => {
  const session = {
    startedAt: "2026-11-21T01:00:00.000Z",
    lastChunkAt: "2026-11-21T01:00:00.000Z",
    lastTranscriptAt: "2026-11-21T01:01:00.000Z",
    updatedAt: "2026-11-21T03:00:00.000Z",
    liveTranscript: [],
  };
  assert.deepEqual(recoveredCallUsage(session, "2026-11-21"), { liveMinutes: 1, calls: 1 });
});

test("recoveredCallUsage: lastTranscriptAt이 있어도 endedAt 있으면 null", () => {
  assert.equal(
    recoveredCallUsage(
      {
        startedAt: "2026-11-21T01:00:00.000Z",
        endedAt: "2026-11-21T01:02:00.000Z",
        lastChunkAt: "2026-11-21T01:00:00.000Z",
        lastTranscriptAt: "2026-11-21T01:01:30.000Z",
        liveTranscript: [],
      },
      "2026-11-21"
    ),
    null
  );
});

test("createRecoveredUsageRecorder: 무마이크 세션 동시 2회 호출 → recordUsage 1회, 완료 후 재호출 0회", async () => {
  let recorded = false;
  let markCalls = 0;
  const recordedUsages: Array<{ liveMinutes: number; calls: number }> = [];
  let releaseGet!: () => void;
  const getGate = new Promise<void>((resolve) => {
    releaseGet = resolve;
  });

  const recordOnce = createRecoveredUsageRecorder({
    getSession: async () => {
      await getGate;
      return {
        startedAt: "2026-11-21T01:00:00.000Z",
        lastChunkAt: "2026-11-21T01:00:00.000Z",
        lastTranscriptAt: "2026-11-21T01:01:45.000Z",
        liveTranscript: [],
        ...(recorded ? { usageRecordedAt: "2026-11-21T01:02:00.000Z" } : {}),
      };
    },
    markRecorded: async () => {
      markCalls += 1;
      recorded = true;
    },
    recordUsage: async (_uid, usage) => {
      recordedUsages.push(usage);
    },
    todayKst: () => "2026-11-21",
  });

  const p1 = recordOnce("u1", "s-nomic");
  const p2 = recordOnce("u1", "s-nomic");
  releaseGet();

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, true);
  assert.equal(r2, false);
  assert.equal(markCalls, 1);
  assert.deepEqual(recordedUsages, [{ liveMinutes: 1.75, calls: 1 }]);

  const r3 = await recordOnce("u1", "s-nomic");
  assert.equal(r3, false);
  assert.equal(markCalls, 1);
  assert.equal(recordedUsages.length, 1);
});

test("recoveredCallUsage: 6초 무마이크 → calls 0, liveMinutes 0.1", () => {
  const usage = recoveredCallUsage(
    {
      startedAt: "2026-11-21T01:00:00.000Z",
      lastChunkAt: "2026-11-21T01:00:00.000Z",
      lastTranscriptAt: "2026-11-21T01:00:06.000Z",
      liveTranscript: [],
    },
    "2026-11-21"
  );
  assert.ok(usage);
  assert.equal(usage.calls, 0);
  assert.ok(Math.abs(usage.liveMinutes - 0.1) < 1e-9);
});
