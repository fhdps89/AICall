import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVE_HINT,
  DEFAULT_WEEKLY_PATTERN,
  QA_PREVIEW_HINT,
  addDaysKst,
  buildPostponeInfoCard,
  buildProgressCardView,
  buildProgressProposal,
  clampDays,
  classifyQuickReply,
  describeProgressChange,
  describeUndoOffer,
  formatAppliedProgressReply,
  formatKstDay,
  isProgressChange,
  isStaleProgressChange,
  nextLessonDate,
  parseDayCount,
  pickUndoTarget,
  progressReplyForDisplay,
  proposalQaPreview,
  qaBlocksPlanChange,
  reconcileProgressIntent,
  sanitizeCoachInfoCard,
  sanitizeTodayGoalId,
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
test("1. pull_forward opic 2: 6->8, reply has 6·7과, 11/23(월), 구글 캘린더, 이번 한 번만 2과 앞당깁니다, 1과씩 올라갑니다", () => {
  const res = buildProgressProposal({ intent: "pull_forward", goalId: "opic", days: 2 }, makeCtx());
  assert.equal(res.type, "proposal");
  assert.deepEqual(res.before, { goals: { opic: { nextLessonIndex: 6 } } });
  assert.deepEqual(res.after, { goals: { opic: { nextLessonIndex: 8 } } });
  assert.match(res.reply, /6·7과/);
  assert.match(res.reply, /11\/23\(월\)/);
  assert.match(res.reply, /구글 캘린더/);
  assert.match(res.reply, /이번 한 번만 2과 앞당깁니다/);
  assert.match(res.reply, /1과씩 올라갑니다/);
  assert.match(res.summary, /이번 한 번만 2과 앞당깁니다/);
  assert.match(res.summary, /1과씩 올라갑니다/);

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

// 3. ambiguous '이틀치 땡겨줘' with resolved target returns clarify
test("3. ambiguous '이틀치 땡겨줘' returns clarify with both 한 번만/매 통화 and target name", () => {
  const resAuto = buildProgressProposal(
    { intent: "pull_forward", days: 2 },
    makeCtx({ userText: "시험이 얼마 안 남아서 이틀치 땡겨줘" })
  );
  assert.equal(resAuto.type, "clarify");
  assert.match(resAuto.reply, /한 번만/);
  assert.match(resAuto.reply, /매 통화/);
  assert.match(resAuto.reply, /OPIc/);

  const resExplicit = buildProgressProposal(
    { intent: "pull_forward", goalId: "philly", days: 2 },
    makeCtx({ userText: "시험 때문에 Philly 이틀치 땡겨줘" })
  );
  assert.equal(resExplicit.type, "clarify");
  assert.match(resExplicit.reply, /Philly/);
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
test("10. postpone: Sunday is info(reviewDay=true) with 4 next lessons; 11/23(Mon) includeToday=false next OPIc is 11/28(토)", () => {
  const rSun = buildProgressProposal({ intent: "postpone" }, makeCtx({ todayKst: "2026-11-22" }));
  assert.equal(rSun.type, "info");
  assert.equal(rSun.info.reviewDay, true);
  assert.match(rSun.reply, /주간 복기/);
  assert.match(rSun.reply, /그대로/);
  assert.match(rSun.reply, /11\/23\(월\)/);
  assert.match(rSun.reply, /11\/24\(화\)/);
  assert.match(rSun.reply, /11\/25\(수\)/);
  assert.match(rSun.reply, /11\/27\(금\)/);
  assert.match(rSun.reply, /구글 캘린더/);
  const sunCard = buildPostponeInfoCard(rSun.info);
  assert.equal(sunCard.title, "오늘은 주간 복기");
  assert.ok(sunCard.lines.includes("다음 OPIc 6과 · 11/23(월) 23:00"));
  assert.equal(sunCard.lines[sunCard.lines.length - 1], "구글 캘린더는 바뀌지 않습니다");

  const rMon = buildProgressProposal({ intent: "postpone" }, makeCtx({ todayKst: "2026-11-23" }));
  assert.equal(rMon.type, "info");
  assert.equal(rMon.info.reviewDay, false);
  assert.match(rMon.reply, /OPIc 6과/);
  assert.match(rMon.reply, /11\/28\(토\)/);
  assert.doesNotMatch(rMon.reply, /다음 수업: 11\/23\(월\)/);
  assert.match(rMon.reply, /그대로/);
  assert.match(rMon.reply, /구글 캘린더/);
  const monCard = buildPostponeInfoCard(rMon.info);
  assert.equal(monCard.title, "오늘 건너뜀");
  assert.ok(monCard.lines.includes("다음 OPIc 6과 · 11/28(토) 23:00"));
  assert.equal(monCard.lines[monCard.lines.length - 1], "구글 캘린더는 바뀌지 않습니다");
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


test("20. proposalQaPreview: true for QA progress; false for schedule-only or non-QA", () => {
  const progressAfter = { goals: { opic: { nextLessonIndex: 8 } } };
  const planOnlyAfter = { plan: { weeklyPattern: { mon: ["opic"] } } };
  assert.equal(proposalQaPreview(progressAfter, true), true);
  assert.equal(proposalQaPreview(planOnlyAfter, true), false);
  assert.equal(proposalQaPreview(progressAfter, false), false);
});

test("21. finalizeCoachProgressResponse: proposal reply overwrites LLM text, empty after, undo_request, info card, memoryPatch kept", () => {
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

  const postponeRes = buildProgressProposal({ intent: "postpone" }, makeCtx({ todayKst: "2026-11-23" }));
  assert.equal(postponeRes.type, "info");
  const postponePlain = finalizeCoachProgressResponse({
    progressResult: postponeRes,
    sanitizedAfter: {},
    isEmptyAfter: true,
  });
  assert.equal(postponePlain.progress?.type, "info");
  if (postponePlain.progress?.type === "info") {
    assert.equal(postponePlain.progress.card.title, "오늘 건너뜀");
  }
  assert.equal(postponePlain.proposal, null);

  const postponeMem = finalizeCoachProgressResponse({
    progressResult: postponeRes,
    sanitizedAfter: {},
    isEmptyAfter: true,
    existingMemoryPatch: { constraints: ["야근"] },
  });
  assert.equal(postponeMem.progress?.type, "info");
  assert.deepEqual(postponeMem.proposal?.memoryPatch, { constraints: ["야근"] });
});

// 22. set_pace basic
test("22. set_pace basic: '시험이 얼마 안 남아서 이틀치씩 땡겨줘' proposes lessonsPerCall 1->2 without nextLessonIndex or plan", () => {
  const ctx = makeCtx({ userText: "시험이 얼마 안 남아서 이틀치씩 땡겨줘" });
  const res = buildProgressProposal({ intent: "set_pace", days: 2 }, ctx);
  assert.equal(res.type, "proposal");
  assert.deepEqual(res.before, { goals: { opic: { lessonsPerCall: 1 } } });
  assert.deepEqual(res.after, { goals: { opic: { lessonsPerCall: 2 } } });
  assert.equal((res.after.goals.opic as { nextLessonIndex?: number }).nextLessonIndex, undefined);
  assert.equal((res.after as { plan?: unknown }).plan, undefined);
  assert.match(res.reply, /매 통화마다 OPIc은 2과씩/);
  assert.match(res.reply, /지금은 6과 그대로/);
  assert.match(res.reply, /6과를 마치면 다음은 8과/);
  assert.match(res.reply, /7과는/);
  assert.match(res.reply, /14과는 건너뛰지/);
  assert.match(res.reply, /구글 캘린더/);
  assert.deepEqual(sanitizePlanChangeAfter(res.after, ctx.goals), res.after);
});

// 23. '씩' overrides LLM pull_forward -> set_pace
test("23. '씩' in userText overrides LLM pull_forward into set_pace 2", () => {
  const res = buildProgressProposal(
    { intent: "pull_forward", goalId: "opic", days: 2 },
    makeCtx({ userText: "이틀치씩 땡겨줘" })
  );
  assert.equal(res.type, "proposal");
  assert.deepEqual(res.after, { goals: { opic: { lessonsPerCall: 2 } } });
});

// 24. '한 번만' / '점프' overrides LLM set_pace -> pull_forward
test("24. '한 번만' and '점프' override LLM set_pace into pull_forward", () => {
  const once = buildProgressProposal(
    { intent: "set_pace", goalId: "opic", days: 2 },
    makeCtx({ userText: "한 번만 이틀치 땡겨줘" })
  );
  assert.equal(once.type, "proposal");
  assert.deepEqual(once.after, { goals: { opic: { nextLessonIndex: 8 } } });

  const jump = buildProgressProposal(
    { intent: "set_pace", goalId: "opic", days: 2 },
    makeCtx({ userText: "OPIc 2과 점프" })
  );
  assert.equal(jump.type, "proposal");
  assert.deepEqual(jump.after, { goals: { opic: { nextLessonIndex: 8 } } });
});

// 25. postpone protection against '하루씩 미뤄줘'
test("25. postpone protection: '오늘은 진도를 못 나갈 것 같으니 하루씩 미뤄줘' stays info without writes", () => {
  const rPostpone = buildProgressProposal(
    { intent: "postpone" },
    makeCtx({ userText: "오늘은 진도를 못 나갈 것 같으니 하루씩 미뤄줘" })
  );
  assert.equal(rPostpone.type, "info");
  assert.equal("after" in rPostpone, false);

  const rPull = buildProgressProposal(
    { intent: "pull_forward", days: 1 },
    makeCtx({ userText: "오늘은 진도를 못 나갈 것 같으니 하루씩 미뤄줘" })
  );
  assert.equal(rPull.type, "info");
  assert.equal("after" in rPull, false);
});

// 26. reset pace ('원래 속도로', '하루씩으로 돌려줘')
test("26. reset pace: '원래 속도로' and '하루씩으로 돌려줘' reset pace to 1 or noop if already 1", () => {
  const rReset = buildProgressProposal(
    { intent: "set_pace", goalId: "opic" },
    makeCtx({
      goals: makeGoals({ opic: { lessonsPerCall: 2 } }),
      userText: "원래 속도로",
    })
  );
  assert.equal(rReset.type, "proposal");
  assert.deepEqual(rReset.after, { goals: { opic: { lessonsPerCall: 1 } } });
  assert.match(rReset.reply, /1과씩/);

  const rDaily = buildProgressProposal(
    { intent: "set_pace", goalId: "opic" },
    makeCtx({
      goals: makeGoals({ opic: { lessonsPerCall: 2 } }),
      userText: "하루씩으로 돌려줘",
    })
  );
  assert.equal(rDaily.type, "proposal");
  assert.deepEqual(rDaily.after, { goals: { opic: { lessonsPerCall: 1 } } });

  const rAlready = buildProgressProposal(
    { intent: "set_pace", goalId: "opic" },
    makeCtx({ userText: "원래 속도로" })
  );
  assert.equal(rAlready.type, "noop");
  assert.match(rAlready.reply, /이미 매 통화 1과씩/);
});

// 27. set_pace noop when already same pace
test("27. set_pace returns noop when goal already has the requested pace", () => {
  const res = buildProgressProposal(
    { intent: "set_pace", goalId: "opic", days: 2 },
    makeCtx({
      goals: makeGoals({ opic: { lessonsPerCall: 2 } }),
      userText: "이틀치씩",
    })
  );
  assert.equal(res.type, "noop");
  assert.match(res.reply, /이미 매 통화 2과씩/);
});

// 28. set_pace clamping and missing days
test("28. set_pace clamps >3 to 3, <=0 to 1, and clarifies when days is missing", () => {
  const over = buildProgressProposal(
    { intent: "set_pace", goalId: "opic", days: 5 },
    makeCtx({ userText: "5과씩" })
  );
  assert.equal(over.type, "proposal");
  assert.deepEqual(over.after, { goals: { opic: { lessonsPerCall: 3 } } });
  assert.match(over.reply, /최대 3과/);

  const zero = buildProgressProposal(
    { intent: "set_pace", goalId: "opic", days: 0 },
    makeCtx()
  );
  assert.equal(zero.type, "noop");

  const missing = buildProgressProposal(
    { intent: "set_pace", goalId: "opic" },
    makeCtx({ userText: "앞으로 매 통화 빠르게" })
  );
  assert.equal(missing.type, "clarify");
  assert.match(missing.reply, /1~3과/);
});

// 29. goalId='all' set_pace 2 skips paused
test("29. goalId='all' set_pace 2 updates all 4 active goals and excludes paused", () => {
  const rAll = buildProgressProposal(
    { intent: "set_pace", goalId: "all", days: 2 },
    makeCtx({ goals: makeGoals({ bluey: { status: "paused" } }) })
  );
  assert.equal(rAll.type, "proposal");
  assert.deepEqual(rAll.after, {
    goals: {
      opic: { lessonsPerCall: 2 },
      philly: { lessonsPerCall: 2 },
      travel: { lessonsPerCall: 2 },
    },
  });

  const rAll4 = buildProgressProposal({ intent: "set_pace", goalId: "all", days: 2 }, makeCtx());
  assert.equal(rAll4.type, "proposal");
  assert.equal(Object.keys(rAll4.after.goals).length, 4);
});

// 30. set_pace near last lesson
test("30. set_pace near last lesson: opic 13 with pace 2 mentions '13과를 마치면 다음은 14과'", () => {
  const res = buildProgressProposal(
    { intent: "set_pace", goalId: "opic", days: 2 },
    makeCtx({ goals: makeGoals({ opic: { nextLessonIndex: 13 } }) })
  );
  assert.equal(res.type, "proposal");
  assert.match(res.reply, /13과를 마치면 다음은 14과/);
});

// 31. pull_forward reflects existing pace > 1
test("31. pull_forward on opic with pace 2 mentions '2과씩 올라갑니다'", () => {
  const res = buildProgressProposal(
    { intent: "pull_forward", goalId: "opic", days: 1 },
    makeCtx({ goals: makeGoals({ opic: { lessonsPerCall: 2 } }) })
  );
  assert.equal(res.type, "proposal");
  assert.match(res.reply, /2과씩 올라갑니다/);
});

// 32. reconcileProgressIntent table
test("32. reconcileProgressIntent matches every table rule and keeps non-pace/postpone/set_lesson/undo/empty", () => {
  assert.deepEqual(reconcileProgressIntent("pull_forward", undefined), { intent: "pull_forward" });
  assert.deepEqual(reconcileProgressIntent("postpone", "하루씩 미뤄줘"), { intent: "postpone" });
  assert.deepEqual(reconcileProgressIntent("set_lesson", "2과씩"), { intent: "set_lesson" });
  assert.deepEqual(reconcileProgressIntent("undo", "원래대로"), { intent: "undo" });
  assert.deepEqual(reconcileProgressIntent("pull_forward", "원래대로"), { intent: "pull_forward" });
  assert.deepEqual(reconcileProgressIntent("pull_forward", "오늘 미뤄줘"), { intent: "postpone" });
  assert.deepEqual(reconcileProgressIntent("pull_forward", "원래 속도로"), {
    intent: "set_pace",
    forceDays: 1,
  });
  assert.deepEqual(reconcileProgressIntent("set_pace", "이번만 2과"), { intent: "pull_forward" });
  assert.deepEqual(reconcileProgressIntent("pull_forward", "매 통화 2과"), { intent: "set_pace" });
  assert.deepEqual(reconcileProgressIntent("pull_forward", "2일치 땡겨줘"), {
    intent: "pull_forward",
    ambiguousPace: true,
  });
});

// 33. parseDayCount
test("33. parseDayCount extracts Korean and numeric counts or returns null", () => {
  assert.equal(parseDayCount("하루"), 1);
  assert.equal(parseDayCount("이틀"), 2);
  assert.equal(parseDayCount("사흘"), 3);
  assert.equal(parseDayCount("나흘"), 4);
  assert.equal(parseDayCount("2과씩"), 2);
  assert.equal(parseDayCount("3일치"), 3);
  assert.equal(parseDayCount("없음"), null);
  assert.equal(parseDayCount("앞으로 매 통화 빠르게"), null);
});

// 34. todayGoalId on Sunday postpone
test("34. Sunday + todayGoalId='opic' + postpone answers for selected track without '정해진 진도 수업이 없어요'", () => {
  const res = buildProgressProposal(
    { intent: "postpone" },
    makeCtx({ todayKst: "2026-11-22", todayGoalId: "opic" })
  );
  assert.equal(res.type, "info");
  assert.match(res.reply, /OPIc 6과 그대로/);
  assert.match(res.reply, /11\/23\(월\)/);
  assert.match(res.reply, /구글 캘린더/);
  assert.doesNotMatch(res.reply, /정해진 진도 수업이 없어요/);
  assert.deepEqual(buildPostponeInfoCard(res.info), {
    kind: "postpone",
    title: "오늘 건너뜀",
    lines: [
      "다음 OPIc 6과 · 11/23(월) 23:00",
      "구글 캘린더는 바뀌지 않습니다",
    ],
  });
});

// 35. todayGoalId resolution priority
test("35. target resolution priority: explicit > text > todayGoalId > pattern", () => {
  const sunOverride = buildProgressProposal(
    { intent: "pull_forward", days: 2 },
    makeCtx({ todayKst: "2026-11-22", todayGoalId: "opic", userText: "한 번만 2과 점프" })
  );
  assert.equal(sunOverride.type, "proposal");
  assert.deepEqual(sunOverride.after, { goals: { opic: { nextLessonIndex: 8 } } });

  const tueOverride = buildProgressProposal(
    { intent: "pull_forward", goalId: "today", days: 2 },
    makeCtx({ todayKst: "2026-11-24", todayGoalId: "opic" })
  );
  assert.equal(tueOverride.type, "proposal");
  assert.deepEqual(tueOverride.after, { goals: { opic: { nextLessonIndex: 8 } } });

  const textWins = buildProgressProposal(
    { intent: "pull_forward", days: 2 },
    makeCtx({ todayGoalId: "philly", userText: "시험 때문에 한 번만 2과 점프" })
  );
  assert.equal(textWins.type, "proposal");
  assert.deepEqual(textWins.after, { goals: { opic: { nextLessonIndex: 8 } } });

  const explicitWins = buildProgressProposal(
    { intent: "pull_forward", goalId: "travel", days: 2 },
    makeCtx({ todayGoalId: "opic" })
  );
  assert.equal(explicitWins.type, "proposal");
  assert.deepEqual(explicitWins.after, { goals: { travel: { nextLessonIndex: 4 } } });
});

// 36. sanitizeTodayGoalId
test("36. sanitizeTodayGoalId filters unknown/invalid ids and falls back to Sunday clarify", () => {
  const ids = ["opic", "philly", "bluey", "travel"];
  assert.equal(sanitizeTodayGoalId("opic", ids), "opic");
  assert.equal(sanitizeTodayGoalId("toeic", ids), undefined);
  assert.equal(sanitizeTodayGoalId(123, ids), undefined);
  assert.equal(sanitizeTodayGoalId("", ids), undefined);
  assert.equal(sanitizeTodayGoalId("a".repeat(65), ids), undefined);

  const sundayInvalid = buildProgressProposal(
    { intent: "pull_forward", days: 2 },
    makeCtx({ todayKst: "2026-11-22", todayGoalId: "toeic" })
  );
  assert.equal(sundayInvalid.type, "clarify");
});

// 37. isProgressChange / qaBlocksPlanChange / isStaleProgressChange for lessonsPerCall
test("37. isProgressChange, qaBlocksPlanChange, and isStaleProgressChange cover lessonsPerCall", () => {
  const paceAfter = { goals: { opic: { lessonsPerCall: 2 } } };
  assert.equal(isProgressChange(paceAfter), true);
  assert.equal(qaBlocksPlanChange(paceAfter, true), true);

  const change = {
    before: { goals: { opic: { lessonsPerCall: 1 } } },
    after: paceAfter,
  };
  assert.equal(
    isStaleProgressChange(change, makeGoals({ opic: { lessonsPerCall: 2 } })),
    true
  );
  assert.equal(isStaleProgressChange(change, makeGoals()), false);
});

// 38. pickUndoTarget for lessonsPerCall
test("38. pickUndoTarget restores paceFrom/paceTo and detects moved pace", () => {
  const changes: UndoCandidateChange[] = [
    {
      id: "pace-change",
      status: "approved",
      at: "2026-11-22T10:00:00Z",
      appliedAt: "2026-11-22T10:01:00Z",
      before: { goals: { opic: { lessonsPerCall: 1 } } },
      after: { goals: { opic: { lessonsPerCall: 2 } } },
    },
  ];
  const ok = pickUndoTarget(changes, makeGoals({ opic: { lessonsPerCall: 2 } }));
  assert.deepEqual(ok, {
    ok: true,
    changeId: "pace-change",
    restore: { opic: { paceFrom: 2, paceTo: 1 } },
  });

  const moved = pickUndoTarget(changes, makeGoals({ opic: { lessonsPerCall: 3 } }));
  assert.equal(moved.ok, false);
  if (!moved.ok) assert.equal(moved.reason, "moved");
});

// 39. buildProgressCardView, formatAppliedProgressReply, describeUndoOffer
test("39. buildProgressCardView, formatAppliedProgressReply, describeUndoOffer format pace and lesson cards", () => {
  const ctx = makeCtx();
  const paceView = buildProgressCardView(
    {
      before: { goals: { opic: { lessonsPerCall: 1 } } },
      after: { goals: { opic: { lessonsPerCall: 2 } } },
    },
    ctx
  );
  assert.deepEqual(paceView.beforeLines, ["OPIc 매 통화 1과씩"]);
  assert.deepEqual(paceView.afterLines, ["OPIc 매 통화 2과씩"]);
  assert.equal(paceView.approveLabel, "승인 (OPIc 매 통화 2과씩)");

  const lessonView = buildProgressCardView(
    {
      before: { goals: { opic: { nextLessonIndex: 6 } } },
      after: { goals: { opic: { nextLessonIndex: 8 } } },
    },
    ctx
  );
  assert.equal(lessonView.approveLabel, "승인 (OPIc 6과 → 8과)");

  const appliedPace = formatAppliedProgressReply(
    { after: { goals: { opic: { lessonsPerCall: 2 } } } },
    ctx
  );
  assert.match(appliedPace, /OPIc은 앞으로 매 통화 2과씩 올라가요/);

  const undoMsg = describeUndoOffer({ opic: { paceFrom: 2, paceTo: 1 } }, ctx.goals);
  assert.match(undoMsg, /OPIc 매 통화 2과씩 → 1과씩/);
});

// 40. APPROVE_HINT and progressReplyForDisplay
test("40. APPROVE_HINT appears once in all 6 proposal variants and progressReplyForDisplay strips approve/reply hints in qaPreview", () => {
  const variants = [
    buildProgressProposal({ intent: "pull_forward", goalId: "opic", days: 2 }, makeCtx()),
    buildProgressProposal({ intent: "pull_forward", goalId: "all", days: 1 }, makeCtx()),
    buildProgressProposal({ intent: "set_pace", goalId: "opic", days: 2 }, makeCtx()),
    buildProgressProposal({ intent: "set_pace", goalId: "all", days: 2 }, makeCtx()),
    buildProgressProposal({ intent: "set_lesson", goalId: "opic", lessonIndex: 8 }, makeCtx()),
    buildProgressProposal({ intent: "set_lesson", goalId: "all", lessonIndex: 3 }, makeCtx()),
  ];

  for (const v of variants) {
    assert.equal(v.type, "proposal");
    if (v.type !== "proposal") continue;
    assert.equal(v.reply.split(APPROVE_HINT).length - 1, 1);

    assert.equal(progressReplyForDisplay(v.reply, { qaPreview: false }), v.reply);

    const qaText = progressReplyForDisplay(v.reply, { qaPreview: true });
    assert.doesNotMatch(qaText, /\[승인\]|'응'/);
    assert.equal(qaText.split(QA_PREVIEW_HINT).length - 1, 1);
  }

  const fallbackInput =
    "요청하신 내용을 바탕으로 계획 변경 제안 카드를 준비했어요. 아래 카드를 확인하시고 [승인]해 주세요.";
  const fallbackOut = progressReplyForDisplay(fallbackInput, { qaPreview: true });
  assert.doesNotMatch(fallbackOut, /\[승인\]|'응'/);
  assert.equal(fallbackOut.split(QA_PREVIEW_HINT).length - 1, 1);
  assert.match(fallbackOut, /계획 변경 제안 카드를 준비했어요\./);
});

// 41. sanitizeCoachInfoCard
test("41. sanitizeCoachInfoCard validates kind/title and caps lines to 6 x 80 chars", () => {
  assert.equal(sanitizeCoachInfoCard(null), null);
  assert.equal(sanitizeCoachInfoCard("bad"), null);
  assert.equal(sanitizeCoachInfoCard({ kind: "other", title: "제목", lines: [] }), null);
  assert.equal(sanitizeCoachInfoCard({ kind: "postpone", title: "", lines: [] }), null);
  assert.equal(sanitizeCoachInfoCard({ kind: "postpone", title: "   ", lines: [] }), null);
  assert.equal(sanitizeCoachInfoCard({ kind: "postpone", title: "a".repeat(31), lines: [] }), null);

  const sanitized = sanitizeCoachInfoCard({
    kind: "postpone",
    title: "오늘 건너뜀",
    lines: [
      123,
      "L".repeat(100),
      "line2",
      "line3",
      "line4",
      "line5",
      null,
      "line6",
      "line7",
    ],
  });
  assert.deepEqual(sanitized, {
    kind: "postpone",
    title: "오늘 건너뜀",
    lines: ["L".repeat(80), "line2", "line3", "line4", "line5", "line6"],
  });
});
