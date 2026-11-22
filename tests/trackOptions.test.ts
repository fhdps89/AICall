import { test } from "node:test";
import assert from "node:assert/strict";
import type { GoalData } from "../src/services/firebase/db.ts";
import { buildTrackOptions } from "../src/ui/home/trackOptions.ts";

function makeGoal(overrides: Partial<GoalData> & { id: string; title: string }): GoalData {
  return {
    type: overrides.id,
    why: "",
    priority: 1,
    tutorPrompt: "",
    lessons: [
      { index: 1, title: "첫 번째 수업" },
      { index: 2, title: "두 번째 수업" },
    ],
    nextLessonIndex: 1,
    status: "active",
    updatedAt: "2026-11-22T00:00:00.000Z",
    ...overrides,
  };
}

test("오늘 루틴 트랙을 표시하고 override가 없으면 오늘 루틴이 선택된다", () => {
  const goals = [
    makeGoal({ id: "opic", title: "OPIc", priority: 1, nextLessonIndex: 2 }),
    makeGoal({ id: "philly", title: "Philly", priority: 2, nextLessonIndex: 1 }),
  ];

  const result = buildTrackOptions({
    goals,
    routineGoalId: "philly",
    overrideGoalId: null,
    isPlanReviewDay: false,
  });

  assert.equal(result.reviewDaySelected, false);
  assert.deepEqual(result.options, [
    {
      id: "opic",
      title: "OPIc",
      nextLabel: "2과. 두 번째 수업",
      isRoutine: false,
      isSelected: false,
      disabledReason: null,
    },
    {
      id: "philly",
      title: "Philly",
      nextLabel: "1과. 첫 번째 수업",
      isRoutine: true,
      isSelected: true,
      disabledReason: null,
    },
  ]);
});

test("overrideGoalId가 있으면 오늘 루틴 표시(isRoutine)는 유지되고 선택(isSelected)은 override로 바뀐다", () => {
  const goals = [
    makeGoal({ id: "opic", title: "OPIc", priority: 1 }),
    makeGoal({ id: "philly", title: "Philly", priority: 2 }),
  ];

  const result = buildTrackOptions({
    goals,
    routineGoalId: "philly",
    overrideGoalId: "opic",
    isPlanReviewDay: false,
  });

  assert.equal(result.reviewDaySelected, false);
  assert.equal(result.options[0].id, "opic");
  assert.equal(result.options[0].isRoutine, false);
  assert.equal(result.options[0].isSelected, true);
  assert.equal(result.options[1].id, "philly");
  assert.equal(result.options[1].isRoutine, true);
  assert.equal(result.options[1].isSelected, false);
});

test("주간 복기일에는 override가 없으면 reviewDaySelected=true이고 어떤 트랙도 선택되지 않는다", () => {
  const goals = [
    makeGoal({ id: "opic", title: "OPIc", priority: 1 }),
    makeGoal({ id: "philly", title: "Philly", priority: 2 }),
  ];

  const reviewDefault = buildTrackOptions({
    goals,
    routineGoalId: null,
    overrideGoalId: null,
    isPlanReviewDay: true,
  });

  assert.equal(reviewDefault.reviewDaySelected, true);
  assert.ok(reviewDefault.options.every((opt) => !opt.isSelected && !opt.isRoutine));

  const reviewOverridden = buildTrackOptions({
    goals,
    routineGoalId: null,
    overrideGoalId: "opic",
    isPlanReviewDay: true,
  });

  assert.equal(reviewOverridden.reviewDaySelected, false);
  assert.equal(reviewOverridden.options[0].isSelected, true);
  assert.equal(reviewOverridden.options[1].isSelected, false);
});

test("다음 과가 lessons에 없거나 트랙이 완료(done)되었으면 비활성 사유가 설정된다", () => {
  const goals = [
    makeGoal({ id: "missing-lesson", title: "초과 진도", priority: 1, nextLessonIndex: 99 }),
    makeGoal({ id: "empty-lessons", title: "빈 커리큘럼", priority: 2, lessons: [] }),
    makeGoal({ id: "done-track", title: "완료 트랙", priority: 3, status: "done", nextLessonIndex: 1 }),
    makeGoal({ id: "active-track", title: "진행 중", priority: 4, nextLessonIndex: 2 }),
  ];

  const result = buildTrackOptions({
    goals,
    routineGoalId: "active-track",
    overrideGoalId: null,
    isPlanReviewDay: false,
  });

  assert.equal(result.options[0].disabledReason, "진행할 과가 없어요");
  assert.equal(result.options[0].nextLabel, "");
  assert.equal(result.options[1].disabledReason, "진행할 과가 없어요");
  assert.equal(result.options[2].disabledReason, "진행할 과가 없어요");
  assert.equal(result.options[3].disabledReason, null);
  assert.equal(result.options[3].nextLabel, "2과. 두 번째 수업");
});

test("priority 오름차순으로 정렬하고 4개가 아니어도 모두 포함하며 priority가 없으면 원래 순서를 유지한다", () => {
  const withoutPriorityA = makeGoal({ id: "no-p-1", title: "무순위 A" });
  delete (withoutPriorityA as Partial<GoalData>).priority;
  const withoutPriorityB = makeGoal({ id: "no-p-2", title: "무순위 B" });
  delete (withoutPriorityB as Partial<GoalData>).priority;

  const goals = [
    makeGoal({ id: "g3", title: "트랙 3", priority: 3 }),
    withoutPriorityA,
    makeGoal({ id: "g1", title: "트랙 1", priority: 1 }),
    withoutPriorityB,
    makeGoal({ id: "g2", title: "트랙 2", priority: 2 }),
    makeGoal({ id: "g5", title: "트랙 5", priority: 5 }),
  ];

  const result = buildTrackOptions({
    goals,
    routineGoalId: "g1",
    overrideGoalId: null,
    isPlanReviewDay: false,
  });

  assert.deepEqual(
    result.options.map((o) => o.id),
    ["g1", "g2", "g3", "g5", "no-p-1", "no-p-2"]
  );
});

test("goals가 비어 있어도 빈 options와 올바른 reviewDaySelected를 반환한다", () => {
  const normal = buildTrackOptions({
    goals: [],
    routineGoalId: "opic",
    overrideGoalId: null,
    isPlanReviewDay: false,
  });
  assert.deepEqual(normal, { options: [], reviewDaySelected: false });

  const review = buildTrackOptions({
    goals: [],
    routineGoalId: null,
    overrideGoalId: null,
    isPlanReviewDay: true,
  });
  assert.deepEqual(review, { options: [], reviewDaySelected: true });
});
