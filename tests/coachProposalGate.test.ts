import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUICK_APPROVE_MAX_AGE_MS,
  FUTURE_SKEW_MS,
  QA_PREVIEW_APPLY_REPLY,
  QA_PREVIEW_APPROVE_REPLY,
  QA_PREVIEW_REJECT_REPLY,
  canApplyPendingProposal,
  resolveQaProgressQuickReply,
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

test("31. canApplyPendingProposal blocks qaPreview in-session fresh docs for both quickReply true/false; not_pending wins first", () => {
  const preview: GateChange = { ...makeChange("qp1", 60_000), qaPreview: true };
  for (const viaQuickReply of [true, false]) {
    const res = canApplyPendingProposal(preview, {
      nowMs: BASE_NOW,
      sessionChangeIds: new Set(["qp1"]),
      viaQuickReply,
    });
    assert.deepEqual(res, {
      ok: false,
      reason: "qa_preview",
      reply: QA_PREVIEW_APPLY_REPLY,
    });
  }

  for (const status of ["approved", "rejected"]) {
    const res = canApplyPendingProposal(
      { ...makeChange("qp-done", 60_000, status), qaPreview: true },
      {
        nowMs: BASE_NOW,
        sessionChangeIds: new Set(["qp-done"]),
        viaQuickReply: false,
      }
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "not_pending");
  }
});

test("32. selectQuickReplyTarget excludes qaPreview docs so real pending proposals still resolve cleanly", () => {
  const qp: GateChange = { ...makeChange("qp1", 1000), qaPreview: true };
  const real = makeChange("real1", 1000);

  assert.deepEqual(
    selectQuickReplyTarget([qp], {
      nowMs: BASE_NOW,
      sessionChangeIds: new Set(["qp1"]),
    }),
    { kind: "none" }
  );

  assert.deepEqual(
    selectQuickReplyTarget([qp, real], {
      nowMs: BASE_NOW,
      sessionChangeIds: new Set(["qp1", "real1"]),
    }),
    { kind: "one", change: real }
  );
});

test("33. resolveQaProgressQuickReply handles approve/reject/closed/expired/real-pending/out-of-session/other intents", () => {
  const openPreview: GateChange = { ...makeChange("qp1", 60_000), qaPreview: true };
  const closedPreview: GateChange = { ...makeChange("qp2", 60_000, "rejected"), qaPreview: true };
  const expiredPreview: GateChange = {
    ...makeChange("qpExp", QUICK_APPROVE_MAX_AGE_MS + 60_000),
    qaPreview: true,
  };
  const realPending = makeChange("real1", 1000);

  // (a) approve + open preview -> reply(APPROVE), closeChangeIds=[id]
  assert.deepEqual(
    resolveQaProgressQuickReply("approve", [openPreview], {
      nowMs: BASE_NOW,
      sessionChangeIds: new Set(["qp1"]),
    }),
    { kind: "reply", text: QA_PREVIEW_APPROVE_REPLY, closeChangeIds: ["qp1"] }
  );

  // (b) closed preview -> reply, []
  assert.deepEqual(
    resolveQaProgressQuickReply("approve", [closedPreview], {
      nowMs: BASE_NOW,
      sessionChangeIds: new Set(["qp2"]),
    }),
    { kind: "reply", text: QA_PREVIEW_APPROVE_REPLY, closeChangeIds: [] }
  );

  // (c) reject -> REJECT text
  assert.deepEqual(
    resolveQaProgressQuickReply("reject", [openPreview], {
      nowMs: BASE_NOW,
      sessionChangeIds: new Set(["qp1"]),
    }),
    { kind: "reply", text: QA_PREVIEW_REJECT_REPLY, closeChangeIds: ["qp1"] }
  );

  // (d) real pending proposal also present -> pass
  assert.deepEqual(
    resolveQaProgressQuickReply("approve", [openPreview, realPending], {
      nowMs: BASE_NOW,
      sessionChangeIds: new Set(["qp1", "real1"]),
    }),
    { kind: "pass" }
  );

  // (e) out-of-session preview -> pass
  assert.deepEqual(
    resolveQaProgressQuickReply("approve", [openPreview], {
      nowMs: BASE_NOW,
      sessionChangeIds: new Set(),
    }),
    { kind: "pass" }
  );

  // (f) null / undo -> pass
  for (const q of [null, "undo"] as const) {
    assert.deepEqual(
      resolveQaProgressQuickReply(q, [openPreview], {
        nowMs: BASE_NOW,
        sessionChangeIds: new Set(["qp1"]),
      }),
      { kind: "pass" }
    );
  }

  // (g) expired preview -> still intercepts with reply
  assert.deepEqual(
    resolveQaProgressQuickReply("approve", [expiredPreview], {
      nowMs: BASE_NOW,
      sessionChangeIds: new Set(["qpExp"]),
    }),
    { kind: "reply", text: QA_PREVIEW_APPROVE_REPLY, closeChangeIds: ["qpExp"] }
  );
});
