import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { syncFeedWith } from "../src/services/feed/feedService.ts";
import { resolveLectureMistakes } from "../src/services/lecture/lecturePick.ts";
import { loadProfileAndGoals } from "../src/services/session/bootLoad.ts";
import type { GoalData, MistakeData, UserProfileData } from "../src/services/firebase/db.ts";

const root = path.resolve(import.meta.dirname, "..");

function makeMistake(id: string): MistakeData {
  return {
    id,
    createdAt: "2026-11-26T00:00:00.000Z",
    source: "call",
    myPhrase: "a",
    naturalPhrase: "b",
    reason: "r",
    sourceStt: "s",
    stage: 1,
    status: "reviewing",
    nextReviewAt: "2026-11-26",
  };
}

test("syncFeedWith skips reading mistakes when opts.mistakes is provided, and reads once when omitted", async () => {
  let mistakeReads = 0;
  let receivedPre: { all: MistakeData[] } | undefined;
  let sentBody: Record<string, unknown> | undefined;
  const preMistakes = [makeMistake("m1"), makeMistake("m2")];

  const baseDeps = {
    ensureFeedSecret: async () => "secret-123456789012345678901234",
    getUserMistakes: async () => {
      mistakeReads++;
      return preMistakes;
    },
    pickLectureMistakes: async (
      _uid: string,
      _today?: string,
      _nowIso?: string,
      pre?: { all: MistakeData[] }
    ) => {
      receivedPre = pre;
      return { newMistakes: [], reviewMistakes: [] };
    },
    authJson: async (_path: string, body: unknown) => {
      sentBody = body as Record<string, unknown>;
      return {};
    },
    today: () => "2026-11-26",
  };

  await syncFeedWith(baseDeps, "u1", undefined, undefined, { mistakes: preMistakes });
  assert.equal(mistakeReads, 0);
  assert.deepEqual(receivedPre, { all: preMistakes });
  assert.equal(sentBody?.quizCount, 2);

  await syncFeedWith(baseDeps, "u1");
  assert.equal(mistakeReads, 1);
  assert.deepEqual(receivedPre, { all: preMistakes });
});

test("lectureService and feedService do not call getDueMistakes", () => {
  const lectureSrc = fs.readFileSync(
    path.join(root, "src/services/lecture/lectureService.ts"),
    "utf8"
  );
  const feedSrc = fs.readFileSync(
    path.join(root, "src/services/feed/feedService.ts"),
    "utf8"
  );

  assert.equal(lectureSrc.includes("getDueMistakes("), false);
  assert.equal(feedSrc.includes("getDueMistakes("), false);
});

test("loadProfileAndGoals runs profile and goals reads in parallel (<260ms for two 150ms delays)", async () => {
  const delay = <T,>(ms: number, value: T) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  const fakeProfile: UserProfileData = {
    email: "a@example.com",
    job: "dev",
    surveyTopics: "travel",
    phillyRole: "pm",
    sttEngine: "gemini",
    ttsEngine: "gemini",
    lectureTime: "07:00",
    feedSecret: "sec",
    initialProgressConfigured: true,
    updatedAt: "2026-11-26T00:00:00.000Z",
  };
  const fakeGoals: GoalData[] = [
    {
      id: "opic",
      title: "OPIc",
      type: "opic",
      why: "test",
      priority: 1,
      tutorPrompt: "p",
      lessons: [{ index: 1, title: "Intro" }],
      nextLessonIndex: 1,
      status: "active",
      updatedAt: "2026-11-26T00:00:00.000Z",
    },
  ];

  const start = Date.now();
  const res = await loadProfileAndGoals("u1", {
    getUserProfile: () => delay(150, fakeProfile),
    saveUserProfile: async () => {},
    getUserGoals: () => delay(150, fakeGoals),
    batchInitGoals: async () => {},
    defaultProfile: () => fakeProfile,
    defaultGoals: fakeGoals,
  });
  const elapsed = Date.now() - start;

  assert.equal(res.profile, fakeProfile);
  assert.equal(res.goals, fakeGoals);
  assert.ok(elapsed < 260, `Expected parallel load < 260ms, got ${elapsed}ms`);
});

test("App, FeedSettingsPanel, rebuildTodayLecture, and rotateFeedSecret route through syncFeedNow", () => {
  const appSrc = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
  const cardSrc = fs.readFileSync(
    path.join(root, "src/ui/lecture/MorningLectureCard.tsx"),
    "utf8"
  );
  const panelSrc = fs.readFileSync(
    path.join(root, "src/ui/settings/FeedSettingsPanel.tsx"),
    "utf8"
  );
  const rebuildSrc = fs.readFileSync(
    path.join(root, "src/services/lecture/rebuildTodayLecture.ts"),
    "utf8"
  );
  const feedSrc = fs.readFileSync(
    path.join(root, "src/services/feed/feedService.ts"),
    "utf8"
  );

  assert.ok(appSrc.includes("syncFeedNow("));
  assert.equal(appSrc.includes("syncFeed(sessionUser.uid)"), false);
  assert.ok(cardSrc.includes("loadLectureForCard"));
  assert.ok(panelSrc.includes("syncFeedNow("));
  assert.equal(panelSrc.includes("syncFeed("), false);
  assert.ok(rebuildSrc.includes("syncFeedNow("));
  assert.match(feedSrc, /export async function rotateFeedSecret[\s\S]*?syncFeedNow\(/);
});

test("resolveLectureMistakes skips read when pre is provided and reads once when omitted", async () => {
  const pre = [makeMistake("pre-1")];
  const fetched = [makeMistake("fetched-1")];
  let reads = 0;
  const read = async () => {
    reads++;
    return fetched;
  };

  const fromPre = await resolveLectureMistakes({ all: pre }, read);
  assert.equal(reads, 0);
  assert.equal(fromPre, pre);

  const fromRead = await resolveLectureMistakes(undefined, read);
  assert.equal(reads, 1);
  assert.equal(fromRead, fetched);
});

test("loadProfileAndGoals initializes only missing profile or goals and writes nothing when both exist", async () => {
  const profile: UserProfileData = {
    email: "a@example.com",
    job: "dev",
    surveyTopics: "travel",
    phillyRole: "pm",
    sttEngine: "gemini",
    ttsEngine: "gemini",
    lectureTime: "07:00",
    feedSecret: "sec",
    initialProgressConfigured: true,
    updatedAt: "2026-11-26T00:00:00.000Z",
  };
  const defaultGoalList: GoalData[] = [
    {
      id: "opic",
      title: "OPIc",
      type: "opic",
      why: "test",
      priority: 1,
      tutorPrompt: "p",
      lessons: [{ index: 1, title: "Intro" }],
      nextLessonIndex: 1,
      status: "active",
      updatedAt: "2026-11-26T00:00:00.000Z",
    },
  ];
  const existingGoals: GoalData[] = [
    { ...defaultGoalList[0], id: "custom" },
  ];

  // 1. Missing profile -> saves defaultProfile, keeps existing goals
  let profileSaves = 0;
  let goalInits = 0;
  const missingProfileRes = await loadProfileAndGoals("u1", {
    getUserProfile: async () => null,
    saveUserProfile: async (_uid, p) => {
      profileSaves++;
      assert.equal(p, profile);
    },
    getUserGoals: async () => existingGoals,
    batchInitGoals: async () => {
      goalInits++;
    },
    defaultProfile: () => profile,
    defaultGoals: defaultGoalList,
  });
  assert.equal(profileSaves, 1);
  assert.equal(goalInits, 0);
  assert.equal(missingProfileRes.profile, profile);
  assert.equal(missingProfileRes.goals, existingGoals);

  // 2. Empty goals -> calls batchInitGoals and returns defaultGoals, does not save profile
  profileSaves = 0;
  goalInits = 0;
  const emptyGoalsRes = await loadProfileAndGoals("u1", {
    getUserProfile: async () => profile,
    saveUserProfile: async () => {
      profileSaves++;
    },
    getUserGoals: async () => [],
    batchInitGoals: async (_uid, g) => {
      goalInits++;
      assert.equal(g, defaultGoalList);
    },
    defaultProfile: () => profile,
    defaultGoals: defaultGoalList,
  });
  assert.equal(profileSaves, 0);
  assert.equal(goalInits, 1);
  assert.equal(emptyGoalsRes.profile, profile);
  assert.equal(emptyGoalsRes.goals, defaultGoalList);

  // 3. Both exist -> zero writes
  profileSaves = 0;
  goalInits = 0;
  const bothExistRes = await loadProfileAndGoals("u1", {
    getUserProfile: async () => profile,
    saveUserProfile: async () => {
      profileSaves++;
    },
    getUserGoals: async () => existingGoals,
    batchInitGoals: async () => {
      goalInits++;
    },
    defaultProfile: () => profile,
    defaultGoals: defaultGoalList,
  });
  assert.equal(profileSaves, 0);
  assert.equal(goalInits, 0);
  assert.equal(bothExistRes.profile, profile);
  assert.equal(bothExistRes.goals, existingGoals);
});
