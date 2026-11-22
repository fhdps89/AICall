import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WEEKLY_PATTERN,
  addDaysKst,
  buildProgressProposal,
  clampDays,
  classifyQuickReply,
  describeProgressChange,
  formatKstDay,
  isProgressChange,
  isStaleProgressChange,
  nextLessonDate,
  pickUndoTarget,
  qaBlocksPlanChange,
  shouldPersistProposedChange,
  finalizeCoachProgressResponse,
  type ProgressContext,
  type ProgressGoal,
  type UndoCandidateChange,
} from "../src/data/progressAdjust.ts";
import { sanitizePlanChangeAfter } from "../src/data/planValidation.ts";

function makeLessons(count: number): { index: number }[] {
  return Array.from({ length: count }, (_, i) => ({ index: i + 1 }));
}

function makeGoals(overrides: Partial<Record<string, Partial<ProgressGoal>>> = {}): ProgressGoal[] {
  const base: ProgressGoal[] = [
    { id: "opic", title: "OPIc AL 달성", nextLessonIndex: 6, status: "active", lessons: makeLessons(14) },
    { id: "philly", title: "필리조선소 주재원", nextLessonIndex: 4, status: "active", lessons: makeLessons(15) },
    { id: "bluey", title: "Bluey 호주 리스닝", nextLessonIndex: 3, status: "active", lessons: makeLessons(12) },
    { id: "travel", title: "미국·호주 여행", nextLessonIndex: 2, status: "active", lessons: makeLessons(13) },
  ];
  return base.map((g) => ({ ...g, ...(overrides[g.id] || {}) }));
}

function makeCtx(overrides: Partial<ProgressContext> = {}): ProgressContext {
  return {
    goals: makeGoals(),
    weeklyPattern: DEFAULT_WEEKLY_PATTERN,
    todayKst: "2026-11-22",
    ...overrides,
  };
}

// 1. pull_forward opic 2
test("1. pull_forward opic 2: 6->8, reply has 6·7과, 11/23(월), 구글 캘린더, 매 통화마다", () => {
  const res = buildProgressProposal({ intent: "pull_forward", goalId: "opic", days: 2 }, makeCtx());
  assert.equal(res.type, "proposal");
  assert.deepEqual(res.before, { goals: { opic: { nextLessonIndex: 6 } } });
  assert.deepEqual(res.after, { goals: { opic: { nextLessonIndex: 8 } } });
  assert.match(res.reply, /6·7과/);
  assert.match(res.reply, /11\/23\(월\)/);
  assert.match(res.reply, /구글 캘린더/);
  assert.match(res.reply, /매 통화마다/);
  assert.match(res.reply, /이번에는 한 번에 2과 앞당깁니다\. 매 통화마다 2과씩 나가기는 아직 없습니다/);
  assert.match(res.summary, /이번에는 한 번에 2과 앞당깁니다\. 매 통화마다 2과씩 나가기는 아직 없습니다/);

  const lines = describeProgressChange(res.before, res.after, makeCtx());
  assert.ok(lines.some((l) => l.includes("OPIc 6과 → 8과")));
  assert.ok(lines.some((l) => l.includes("6·7과는 건너뜁니다")));
  assert.ok(lines.some((l) => l.includes("11/23(월)")));
});

// 2. pull_forward without goalId on Sunday -> clarify, no after
test("2. pull_forward without goalId on Sunday with '이틀치 땡겨줘' returns clarify without after", () => {
  const res = buildProgressProposal(
    { intent: "pull_forward", days: 2 },
    makeCtx({ todayKst: "2026-11-22", userText: "이틀치 땡겨줘" })
  );
  assert.equal(res.type, "clarify");
  assert.equal("after" in res, false);
  assert.match(res.reply, /OPIc\(6과\)/);
});

// 3. keyword '시험' picks opic when goalId omitted, explicit philly overrides keyword
test("3. '시험' keyword picks opic when goalId omitted; explicit philly overrides keyword", () => {
  const resAuto = buildProgressProposal(
    { intent: "pull_forward", days: 2 },
    makeCtx({ userText: "시험이 얼마 안 남아서 이틀치 땡겨줘" })
  );
  assert.equal(resAuto.type, "proposal");
  assert.deepEqual(resAuto.after, { goals: { opic: { nextLessonIndex: 8 } } });

  const resExplicit = buildProgressProposal(
    { intent: "pull_forward", goalId: "philly", days: 2 },
    makeCtx({ userText: "시험 때문에 Philly 이틀치 땡겨줘" })
  );
  assert.equal(resExplicit.type, "proposal");
  assert.deepEqual(resExplicit.after, { goals: { philly: { nextLessonIndex: 6 } } });
});

// 4. Tuesday today + goalId="today" -> philly 4->6
test("4. today='2026-11-24'(Tue) and goalId='today' resolves to philly 4->6", () => {
  const res = buildProgressProposal(
    { intent: "pull_forward", goalId: "today", days: 2 },
    makeCtx({ todayKst: "2026-11-24" })
  );
  assert.equal(res.type, "proposal");
  assert.deepEqual(res.before, { goals: { philly: { nextLessonIndex: 4 } } });
  assert.deepEqual(res.after, { goals: { philly: { nextLessonIndex: 6 } } });
});

// 5. clampDays
test("5. clampDays: 99->7 (opic 6->13 with note), 0/-1/'abc'/missing/1.5->1", () => {
  assert.equal(clampDays(99), 7);
  assert.equal(clampDays(0), 1);
  assert.equal(clampDays(-1), 1);
  assert.equal(clampDays("abc"), 1);
  assert.equal(clampDays(undefined), 1);
  assert.equal(clampDays(1.5), 1);

  const res99 = buildProgressProposal({ intent: "pull_forward", goalId: "opic", days: 99 }, makeCtx());
  assert.equal(res99.type, "proposal");
  assert.deepEqual(res99.after, { goals: { opic: { nextLessonIndex: 13 } } });
  assert.match(res99.reply, /최대 7과/);
});

// 6. near last lesson
test("6. near last lesson: opic 13+2->14, opic 14->noop('이미 마지막 과'), opic 15->noop without throw", () => {
  const r13 = buildProgressProposal(
    { intent: "pull_forward", goalId: "opic", days: 2 },
    makeCtx({ goals: makeGoals({ opic: { nextLessonIndex: 13 } }) })
  );
  assert.equal(r13.type, "proposal");
  assert.deepEqual(r13.after, { goals: { opic: { nextLessonIndex: 14 } } });

  const r14 = buildProgressProposal(
    { intent: "pull_forward", goalId: "opic", days: 2 },
    makeCtx({ goals: makeGoals({ opic: { nextLessonIndex: 14 } }) })
  );
  assert.equal(r14.type, "noop");
  assert.match(r14.reply, /이미 마지막 과/);

  const r15 = buildProgressProposal(
    { intent: "pull_forward", goalId: "opic", days: 2 },
    makeCtx({ goals: makeGoals({ opic: { nextLessonIndex: 15 } }) })
  );
  assert.equal(r15.type, "noop");
  assert.match(r15.reply, /이미 마지막 과/);
});

// 7. all +1 skips paused goals
test("7. goalId='all' +1 advances all 4 active goals and excludes paused goals", () => {
  const r4 = buildProgressProposal({ intent: "pull_forward", goalId: "all", days: 1 }, makeCtx());
  assert.equal(r4.type, "proposal");
  assert.deepEqual(r4.after, {
    goals: {
      opic: { nextLessonIndex: 7 },
      philly: { nextLessonIndex: 5 },
      bluey: { nextLessonIndex: 4 },
      travel: { nextLessonIndex: 3 },
    },
  });

  const rPaused = buildProgressProposal(
    { intent: "pull_forward", goalId: "all", days: 1 },
    makeCtx({ goals: makeGoals({ bluey: { status: "paused" } }) })
  );
  assert.equal(rPaused.type, "proposal");
  assert.deepEqual(rPaused.after, {
    goals: {
      opic: { nextLessonIndex: 7 },
      philly: { nextLessonIndex: 5 },
      travel: { nextLessonIndex: 3 },
    },
  });
});

// 8. set_lesson
test("8. set_lesson: philly 3 -> 4->3; 16/0/2.5 -> invalid('1~15과'); same -> noop", () => {
  const r3 = buildProgressProposal({ intent: "set_lesson", goalId: "philly", lessonIndex: 3 }, makeCtx());
  assert.equal(r3.type, "proposal");
  assert.deepEqual(r3.before, { goals: { philly: { nextLessonIndex: 4 } } });
  assert.deepEqual(r3.after, { goals: { philly: { nextLessonIndex: 3 } } });

  for (const bad of [16, 0, 2.5]) {
    const rBad = buildProgressProposal({ intent: "set_lesson", goalId: "philly", lessonIndex: bad }, makeCtx());
    assert.equal(rBad.type, "invalid");
    assert.match(rBad.reply, /1~15과/);
  }

  const rSame = buildProgressProposal({ intent: "set_lesson", goalId: "philly", lessonIndex: 4 }, makeCtx());
  assert.equal(rSame.type, "noop");
});

// 9. unknown goalId and unknown intent -> invalid
test("9. unknown goalId('toeic') and unknown intent return invalid", () => {
  const rGoal = buildProgressProposal({ intent: "pull_forward", goalId: "toeic", days: 1 }, makeCtx());
  assert.equal(rGoal.type, "invalid");

  const rIntent = buildProgressProposal({ intent: "reset_all", goalId: "opic" }, makeCtx());
  assert.equal(rIntent.type, "invalid");
});

// 10. postpone
test("10. postpone: Sunday is noop with 4 next lessons; 11/23(Mon) includeToday=false next OPIc is 11/28(토)", () => {
  const rSun = buildProgressProposal({ intent: "postpone" }, makeCtx({ todayKst: "2026-11-22" }));
  assert.equal(rSun.type, "noop");
  assert.match(rSun.reply, /주간 복기/);
  assert.match(rSun.reply, /그대로/);
  assert.match(rSun.reply, /11\/23\(월\)/);
  assert.match(rSun.reply, /11\/24\(화\)/);
  assert.match(rSun.reply, /11\/25\(수\)/);
  assert.match(rSun.reply, /11\/27\(금\)/);
  assert.match(rSun.reply, /구글 캘린더/);

  const rMon = buildProgressProposal({ intent: "postpone" }, makeCtx({ todayKst: "2026-11-23" }));
  assert.equal(rMon.type, "noop");
  assert.match(rMon.reply, /OPIc 6과/);
  assert.match(rMon.reply, /11\/28\(토\)/);
  assert.doesNotMatch(rMon.reply, /다음 수업: 11\/23\(월\)/);
  assert.match(rMon.reply, /그대로/);
  assert.match(rMon.reply, /구글 캘린더/);
});

// 11. result.after.plan is undefined across all intents
test("11. no intent produces after.plan", () => {
  const cases = [
    buildProgressProposal({ intent: "postpone" }, makeCtx()),
    buildProgressProposal({ intent: "pull_forward", goalId: "opic", days: 2 }, makeCtx()),
    buildProgressProposal({ intent: "set_lesson", goalId: "travel", lessonIndex: 5 }, makeCtx()),
    buildProgressProposal({ intent: "undo" }, makeCtx()),
  ];
  for (const r of cases) {
    if (r.type === "proposal") {
      assert.equal((r.after as { plan?: unknown }).plan, undefined);
    }
  }
});

// 12. sanitizePlanChangeAfter preserves proposal.after identically
test("12. proposal.after passes sanitizePlanChangeAfter unchanged", () => {
  const ctx = makeCtx();
  const res = buildProgressProposal({ intent: "pull_forward", goalId: "opic", days: 2 }, ctx);
  assert.equal(res.type, "proposal");
  const sanitized = sanitizePlanChangeAfter(res.after, ctx.goals);
  assert.deepEqual(sanitized, res.after);
});

// 13. nextLessonDate
test("13. nextLessonDate: 11/22 targets, includeToday on 11/23, missing track -> null, custom thu bluey", () => {
  assert.equal(nextLessonDate(DEFAULT_WEEKLY_PATTERN, "opic", "2026-11-22"), "2026-11-23");
  assert.equal(nextLessonDate(DEFAULT_WEEKLY_PATTERN, "philly", "2026-11-22"), "2026-11-24");
  assert.equal(nextLessonDate(DEFAULT_WEEKLY_PATTERN, "bluey", "2026-11-22"), "2026-11-25");
  assert.equal(nextLessonDate(DEFAULT_WEEKLY_PATTERN, "travel", "2026-11-22"), "2026-11-27");

  assert.equal(nextLessonDate(DEFAULT_WEEKLY_PATTERN, "opic", "2026-11-23", true), "2026-11-23");
  assert.equal(nextLessonDate(DEFAULT_WEEKLY_PATTERN, "toeic", "2026-11-22"), null);

  const customPattern = { ...DEFAULT_WEEKLY_PATTERN, wed: [], thu: ["philly", "bluey"] };
  assert.equal(nextLessonDate(customPattern, "bluey", "2026-11-22"), "2026-11-26");
});

// 14. date formatting and year boundary
test("14. formatKstDay('2026-11-23') is '11/23(월)' and addDaysKst handles year boundary", () => {
  assert.equal(formatKstDay("2026-11-23"), "11/23(월)");
  assert.equal(addDaysKst("2026-12-31", 1), "2027-01-01");
});

// 15. pickUndoTarget
test("15. pickUndoTarget: picks latest approved by appliedAt, skips non-approved/plan-only, detects none and moved", () => {
  const live = makeGoals({ travel: { nextLessonIndex: 5 } });
  const changes: UndoCandidateChange[] = [
    {
      id: "old-approved",
      status: "approved",
      at: "2026-11-20T10:00:00Z",
      appliedAt: "2026-11-20T10:05:00Z",
      before: { goals: { opic: { nextLessonIndex: 5 } } },
      after: { goals: { opic: { nextLessonIndex: 6 } } },
    },
    {
      id: "target",
      status: "approved",
      at: "2026-11-21T09:00:00Z",
      appliedAt: "2026-11-22T08:00:00Z",
      before: { goals: { travel: { nextLessonIndex: 2 } } },
      after: { goals: { travel: { nextLessonIndex: 5 } } },
    },
    {
      id: "plan-only",
      status: "approved",
      at: "2026-11-22T09:00:00Z",
      appliedAt: "2026-11-22T09:00:00Z",
      before: { plan: { weeklyPattern: { sun: [] } } },
      after: { plan: { weeklyPattern: { sun: ["opic"] } } },
    },
    {
      id: "rejected-later",
      status: "rejected",
      at: "2026-11-22T10:00:00Z",
      before: { goals: { opic: { nextLessonIndex: 6 } } },
      after: { goals: { opic: { nextLessonIndex: 8 } } },
    },
    {
      id: "reverted-later",
      status: "reverted",
      at: "2026-11-22T11:00:00Z",
      appliedAt: "2026-11-22T11:00:00Z",
      before: { goals: { opic: { nextLessonIndex: 6 } } },
      after: { goals: { opic: { nextLessonIndex: 8 } } },
    },
    {
      id: "proposed-later",
      status: "proposed",
      at: "2026-11-22T12:00:00Z",
      before: { goals: { opic: { nextLessonIndex: 6 } } },
      after: { goals: { opic: { nextLessonIndex: 8 } } },
    },
  ];

  const picked = pickUndoTarget(changes, live);
  assert.deepEqual(picked, {
    ok: true,
    changeId: "target",
    restore: { travel: { from: 5, to: 2 } },
  });

  // appliedAt ordering beats older at when applied later
  const appliedOrder = pickUndoTarget(
    [
      {
        id: "created-second-applied-first",
        status: "approved",
        at: "2026-11-22T10:00:00Z",
        appliedAt: "2026-11-22T10:01:00Z",
        before: { goals: { opic: { nextLessonIndex: 4 } } },
        after: { goals: { opic: { nextLessonIndex: 6 } } },
      },
      {
        id: "created-first-applied-second",
        status: "approved",
        at: "2026-11-22T09:00:00Z",
        appliedAt: "2026-11-22T10:05:00Z",
        before: { goals: { travel: { nextLessonIndex: 2 } } },
        after: { goals: { travel: { nextLessonIndex: 5 } } },
      },
    ],
    live
  );
  assert.equal(appliedOrder.ok, true);
  if (appliedOrder.ok) assert.equal(appliedOrder.changeId, "created-first-applied-second");

  // none
  const noneRes = pickUndoTarget([changes[2], changes[3]], live);
  assert.equal(noneRes.ok, false);
  if (!noneRes.ok) assert.equal(noneRes.reason, "none");

  // moved
  const movedLive = makeGoals({ travel: { nextLessonIndex: 6 } });
  const movedRes = pickUndoTarget(changes, movedLive);
  assert.equal(movedRes.ok, false);
  if (!movedRes.ok) assert.equal(movedRes.reason, "moved");
});

// 16. classifyQuickReply
test("16. classifyQuickReply: exact approve/reject/undo and pending vs non-pending", () => {
  for (const w of ["응", "네.", "응!!"]) {
    assert.equal(classifyQuickReply(w, { hasPending: true }), "approve");
    assert.equal(classifyQuickReply(w, { hasPending: false }), null);
  }
  assert.equal(classifyQuickReply("아니 3과로 해줘", { hasPending: true }), null);
  assert.equal(classifyQuickReply("취소", { hasPending: true }), "reject");
  assert.equal(classifyQuickReply("취소", { hasPending: false }), "undo");
  assert.equal(classifyQuickReply("되돌려줘", { hasPending: false }), "undo");
  assert.equal(classifyQuickReply("되돌려줘", { hasPending: true }), "undo");
});

// 17. qaBlocksPlanChange
test("17. qaBlocksPlanChange: true only when qa=true and progress change", () => {
  const progressAfter = { goals: { opic: { nextLessonIndex: 8 } } };
  const planOnlyAfter = { plan: { weeklyPattern: { sun: ["opic"] } } };
  assert.equal(qaBlocksPlanChange(progressAfter, true), true);
  assert.equal(qaBlocksPlanChange(planOnlyAfter, true), false);
  assert.equal(qaBlocksPlanChange(progressAfter, false), false);
});

// 18. isStaleProgressChange
test("18. isStaleProgressChange: true when before=6 and live=7, false when equal", () => {
  const change = {
    before: { goals: { opic: { nextLessonIndex: 6 } } },
    after: { goals: { opic: { nextLessonIndex: 8 } } },
  };
  assert.equal(isStaleProgressChange(change, makeGoals({ opic: { nextLessonIndex: 7 } })), true);
  assert.equal(isStaleProgressChange(change, makeGoals({ opic: { nextLessonIndex: 6 } })), false);
});

// 19. isProgressChange
test("19. isProgressChange: false for deadline-only, true when nextLessonIndex present", () => {
  assert.equal(isProgressChange({ goals: { opic: { deadline: "2026-11-29" } } }), false);
  assert.equal(isProgressChange({ goals: { opic: { nextLessonIndex: 8 } } }), true);
});


test("20. shouldPersistProposedChange: QA progress is preview-only; schedule-only and non-QA persist", () => {
  const progressAfter = { goals: { opic: { nextLessonIndex: 8 } } };
  const planOnlyAfter = { plan: { weeklyPattern: { mon: ["opic"] } } };
  assert.equal(shouldPersistProposedChange(progressAfter, true), false);
  assert.equal(shouldPersistProposedChange(planOnlyAfter, true), true);
  assert.equal(shouldPersistProposedChange(progressAfter, false), true);
});

test("21. finalizeCoachProgressResponse: proposal reply overwrites LLM text, empty after, undo_request, memoryPatch kept", () => {
  const proposal = buildProgressProposal({ intent: "pull_forward", goalId: "opic", days: 2 }, makeCtx());
  assert.equal(proposal.type, "proposal");
  const sanitized = sanitizePlanChangeAfter(proposal.after, makeGoals().map((g) => ({ id: g.id, lessons: g.lessons })));
  const ok = finalizeCoachProgressResponse({
    progressResult: proposal,
    sanitizedAfter: sanitized,
    isEmptyAfter: false,
    existingMemoryPatch: { constraints: ["야근"] },
    existingSummary: "이전 일정 제안",
  });
  assert.match(ok.reply, /8과/);
  assert.equal(ok.proposal?.status, "proposed");
  assert.deepEqual(ok.proposal?.after, sanitized);
  assert.deepEqual(ok.proposal?.before, proposal.before);
  assert.deepEqual(ok.proposal?.memoryPatch, { constraints: ["야근"] });
  assert.equal(ok.progress, undefined);

  const empty = finalizeCoachProgressResponse({
    progressResult: proposal,
    sanitizedAfter: {},
    isEmptyAfter: true,
    existingMemoryPatch: { constraints: ["야근"] },
  });
  assert.match(empty.reply, /적용할 수 없어요/);
  assert.deepEqual(empty.proposal?.after, {});
  assert.deepEqual(empty.proposal?.memoryPatch, { constraints: ["야근"] });

  const undo = finalizeCoachProgressResponse({
    progressResult: buildProgressProposal({ intent: "undo" }, makeCtx()),
    sanitizedAfter: {},
    isEmptyAfter: true,
  });
  assert.equal(undo.progress?.type, "undo_request");
  assert.equal(undo.proposal, null);
  assert.match(undo.reply, /되돌릴/);
});
