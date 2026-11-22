import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUICK_APPROVE_MAX_AGE_MS,
  FUTURE_SKEW_MS,
  canApplyPendingProposal,
  selectQuickReplyTarget,
  type GateChange,
} from "../src/data/coachProposalGate.ts";

const BASE_NOW = Date.parse("2026-11-22T12:00:00.000Z");

function makeChange(id: string, ageMs: number, status = "proposed"): GateChange {
  return {
    id,
    status,
    at: new Date(BASE_NOW - ageMs).toISOString(),
  };
}

test("25. quick reply with in-session card enforces exact 10-minute window", () => {
  const session = new Set(["c1"]);
  assert.deepEqual(
    canApplyPendingProposal(makeChange("c1", QUICK_APPROVE_MAX_AGE_MS - 1000), {
      nowMs: BASE_NOW,
      sessionChangeIds: session,
      viaQuickReply: true,
    }),
    { ok: true }
  );
  assert.deepEqual(
    canApplyPendingProposal(makeChange("c1", QUICK_APPROVE_MAX_AGE_MS), {
      nowMs: BASE_NOW,
      sessionChangeIds: session,
      viaQuickReply: true,
    }),
    { ok: true }
  );

  const expired = canApplyPendingProposal(makeChange("c1", QUICK_APPROVE_MAX_AGE_MS + 1), {
    nowMs: BASE_NOW,
    sessionChangeIds: session,
    viaQuickReply: true,
  });
  assert.equal(expired.ok, false);
  if (!expired.ok) {
    assert.equal(expired.reason, "expired");
    assert.match(expired.reply, /10분/);
  }
});

test("26. quick reply with out-of-session card returns not_in_session even when fresh", () => {
  const res = canApplyPendingProposal(makeChange("c-old", 3 * 60 * 1000), {
    nowMs: BASE_NOW,
    sessionChangeIds: new Set(["c-other"]),
    viaQuickReply: true,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "not_in_session");
});

test("27. button apply (viaQuickReply=false) allows out-of-session within 10m and expires after 10m", () => {
  const ok = canApplyPendingProposal(makeChange("c-old", 5 * 60 * 1000), {
    nowMs: BASE_NOW,
    sessionChangeIds: new Set(),
    viaQuickReply: false,
  });
  assert.deepEqual(ok, { ok: true });

  const expired = canApplyPendingProposal(makeChange("c-old", 11 * 60 * 1000), {
    nowMs: BASE_NOW,
    sessionChangeIds: new Set(),
    viaQuickReply: false,
  });
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.reason, "expired");
});

test("28. missing, malformed, or >60s future timestamps expire; <=30s future skew is allowed", () => {
  for (const badAt of [undefined, "garbage"]) {
    const res = canApplyPendingProposal(
      { id: "c1", status: "proposed", at: badAt },
      { nowMs: BASE_NOW, sessionChangeIds: new Set(["c1"]), viaQuickReply: false }
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "expired");
  }

  const future2m = canApplyPendingProposal(makeChange("c1", -(2 * 60 * 1000)), {
    nowMs: BASE_NOW,
    sessionChangeIds: new Set(["c1"]),
    viaQuickReply: false,
  });
  assert.equal(future2m.ok, false);
  if (!future2m.ok) assert.equal(future2m.reason, "expired");

  assert.ok(30_000 <= FUTURE_SKEW_MS);
  const future30s = canApplyPendingProposal(makeChange("c1", -30_000), {
    nowMs: BASE_NOW,
    sessionChangeIds: new Set(["c1"]),
    viaQuickReply: false,
  });
  assert.deepEqual(future30s, { ok: true });
});

test("29. approved or rejected changes return not_pending", () => {
  for (const status of ["approved", "rejected"]) {
    const res = canApplyPendingProposal(makeChange("c1", 1000, status), {
      nowMs: BASE_NOW,
      sessionChangeIds: new Set(["c1"]),
      viaQuickReply: false,
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "not_pending");
  }
});

test("30. selectQuickReplyTarget selects only valid in-session pending proposals", () => {
  const s1 = makeChange("s1", 1000);
  const s2 = makeChange("s2", 2000);
  const sExp = makeChange("sExp", QUICK_APPROVE_MAX_AGE_MS + 5000);
  const out1 = makeChange("out1", 1000);
  const out2 = makeChange("out2", 1000);
  const out3 = makeChange("out3", 1000);

  assert.deepEqual(
    selectQuickReplyTarget([out1], { nowMs: BASE_NOW, sessionChangeIds: new Set() }),
    { kind: "none" }
  );

  assert.deepEqual(
    selectQuickReplyTarget([s1], { nowMs: BASE_NOW, sessionChangeIds: new Set(["s1"]) }),
    { kind: "one", change: s1 }
  );

  assert.deepEqual(
    selectQuickReplyTarget([s1, s2], {
      nowMs: BASE_NOW,
      sessionChangeIds: new Set(["s1", "s2"]),
    }),
    { kind: "many" }
  );

  assert.deepEqual(
    selectQuickReplyTarget([sExp], { nowMs: BASE_NOW, sessionChangeIds: new Set(["sExp"]) }),
    { kind: "expired" }
  );

  assert.deepEqual(
    selectQuickReplyTarget([sExp, s1], {
      nowMs: BASE_NOW,
      sessionChangeIds: new Set(["sExp", "s1"]),
    }),
    { kind: "one", change: s1 }
  );

  assert.deepEqual(
    selectQuickReplyTarget([out1, out2, out3, s1], {
      nowMs: BASE_NOW,
      sessionChangeIds: new Set(["s1"]),
    }),
    { kind: "one", change: s1 }
  );
});
