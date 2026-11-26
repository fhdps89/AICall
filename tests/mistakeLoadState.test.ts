import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  __resetMistakeCacheForTest,
  createLatestOnly,
  failMistakes,
  initialMistakeState,
  pickFeedSyncMode,
  rememberMistakes,
  reviewCardView,
  selectDueMistakes,
} from "../src/services/mistakes/mistakeLoadState.ts";
import type { MistakeData } from "../src/services/firebase/db.ts";

function makeMistake(overrides: Partial<MistakeData> = {}): MistakeData {
  return {
    id: overrides.id ?? "m1",
    createdAt: "2026-11-20T01:00:00.000Z",
    source: "call",
    myPhrase: "wrong",
    naturalPhrase: "right",
    reason: "reason",
    sourceStt: "stt",
    stage: 1,
    status: "reviewing",
    ...overrides,
  };
}

beforeEach(() => {
  __resetMistakeCacheForTest();
});

test("selectDueMistakes puts deferred first, respects today boundary & date fallbacks, and sorts reviewing", () => {
  const today = "2026-11-26";
  const all: MistakeData[] = [
    makeMistake({ id: "future", status: "reviewing", nextReviewAt: "2026-11-27", stage: 1 }),
    makeMistake({ id: "grad", status: "graduated", nextReviewAt: "2026-11-20", stage: 14 }),
    makeMistake({ id: "rev-today-s1", status: "reviewing", nextReviewAt: "2026-11-26", stage: 1 }),
    makeMistake({ id: "rev-today-s7", status: "reviewing", nextReviewAt: "2026-11-26", stage: 7 }),
    makeMistake({ id: "def-1", status: "deferred", nextReviewAt: "2026-11-30", stage: 14 }),
    makeMistake({ id: "rev-fallback-nextReviewDate", status: "reviewing", nextReviewDate: "2026-11-25", stage: 3 }),
    makeMistake({ id: "rev-fallback-createdAt", status: "reviewing", createdAt: "2026-11-24T12:00:00.000Z", stage: 1 }),
    makeMistake({ id: "rev-createdAt-future", status: "reviewing", createdAt: "2026-11-27T01:00:00.000Z", stage: 1 }),
  ];

  const due = selectDueMistakes(all, today);
  assert.deepEqual(
    due.map((m) => m.id),
    [
      "def-1",
      "rev-fallback-createdAt",
      "rev-fallback-nextReviewDate",
      "rev-today-s7",
      "rev-today-s1",
    ]
  );
});

test("reviewCardView handles loading, empty ready, 45-item cap, and error without emitting 0/0 during loading", () => {
  const today = "2026-11-26";

  const loadingView = reviewCardView({ status: "loading" }, today);
  assert.deepEqual(loadingView, { kind: "loading" });

  const emptyView = reviewCardView({ status: "ready", all: [], refreshing: false }, today);
  assert.deepEqual(emptyView, {
    kind: "counts",
    due: [],
    dueCount: 0,
    quizCount: 0,
    deferred: 0,
    reviewing: 0,
    total: 0,
    canQuiz: false,
    refreshing: false,
  });

  const many = Array.from({ length: 45 }, (_, i) =>
    makeMistake({
      id: `m-${i}`,
      status: i < 5 ? "deferred" : "reviewing",
      nextReviewAt: "2026-11-26",
    })
  );
  const fullView = reviewCardView({ status: "ready", all: many, refreshing: true }, today);
  assert.equal(fullView.kind, "counts");
  if (fullView.kind === "counts") {
    assert.equal(fullView.dueCount, 45);
    assert.equal(fullView.quizCount, 10);
    assert.equal(fullView.deferred, 5);
    assert.equal(fullView.reviewing, 40);
    assert.equal(fullView.total, 45);
    assert.equal(fullView.canQuiz, true);
    assert.equal(fullView.refreshing, true);
  }

  const errView = reviewCardView({ status: "error", message: "boom" }, today);
  assert.deepEqual(errView, { kind: "error", message: "boom" });
});

test("cache preserves state across remount per uid, failMistakes keeps previous ready, and date rollover updates due", () => {
  assert.deepEqual(initialMistakeState("u1"), { status: "loading" });

  const items = [
    makeMistake({ id: "today-only", status: "reviewing", nextReviewAt: "2026-11-27" }),
    makeMistake({ id: "already-due", status: "reviewing", nextReviewAt: "2026-11-26" }),
  ];
  rememberMistakes("u1", items);

  const remounted = initialMistakeState("u1");
  assert.equal(remounted.status, "ready");
  if (remounted.status === "ready") {
    assert.equal(remounted.refreshing, true);
    assert.deepEqual(remounted.all, items);
  }

  // Different uid still starts in loading
  assert.deepEqual(initialMistakeState("u2"), { status: "loading" });

  // Date rollover from 2026-11-26 -> 2026-11-27 derives new due list from cached all
  const day1 = reviewCardView(remounted, "2026-11-26");
  const day2 = reviewCardView(remounted, "2026-11-27");
  assert.equal(day1.kind === "counts" ? day1.dueCount : -1, 1);
  assert.equal(day2.kind === "counts" ? day2.dueCount : -1, 2);

  // failMistakes preserves previous ready state (clears refreshing) and returns error otherwise
  const preserved = failMistakes(remounted, "network error");
  assert.deepEqual(preserved, { status: "ready", all: items, refreshing: false });

  const errored = failMistakes({ status: "loading" }, "network error");
  assert.deepEqual(errored, { status: "error", message: "network error" });
});

test("createLatestOnly ignores stale responses, prefers newer requests, and ignores all after invalidate", () => {
  const tracker = createLatestOnly();
  assert.equal(tracker.isLatest(0), false);

  const req1 = tracker.begin();
  assert.equal(tracker.isLatest(req1), true);

  const req2 = tracker.begin();
  assert.equal(tracker.isLatest(req1), false);
  assert.equal(tracker.isLatest(req2), true);

  tracker.invalidate();
  assert.equal(tracker.isLatest(req1), false);
  assert.equal(tracker.isLatest(req2), false);

  // Remount after invalidate can start a new valid generation
  const req3 = tracker.begin();
  assert.equal(tracker.isLatest(req2), false);
  assert.equal(tracker.isLatest(req3), true);
});

test("pickFeedSyncMode truth table keeps pending changed intent across mount loads", () => {
  assert.equal(pickFeedSyncMode("mount", false), "fromHome");
  assert.equal(pickFeedSyncMode("mount", true), "now");
  assert.equal(pickFeedSyncMode("changed", false), "now");
  assert.equal(pickFeedSyncMode("changed", true), "now");
});
