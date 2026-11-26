import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

test("bootCache.ts stays pure without React or Firebase runtime imports", () => {
  const cacheSrc = fs.readFileSync(
    path.join(root, "src/services/session/bootCache.ts"),
    "utf8"
  );

  assert.equal(/\bfrom\s+["']react["']/.test(cacheSrc), false);
  assert.equal(/\bfrom\s+["']firebase\//.test(cacheSrc), false);
  assert.ok(/import\s+type\s+\{\s*GoalData\s*\}\s+from\s+["']\.\.\/firebase\/db["']/.test(cacheSrc));
});

test("App.tsx wires boot cache before loadProfileAndGoals, writes on sync, clears on logout, and gates handleStartCall", () => {
  const appSrc = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");

  const readIdx = appSrc.indexOf("readBootCache(");
  const loadIdx = appSrc.indexOf("loadProfileAndGoals(");
  assert.ok(readIdx > -1, "App.tsx should call readBootCache");
  assert.ok(loadIdx > -1, "App.tsx should call loadProfileAndGoals");
  assert.ok(readIdx < loadIdx, "readBootCache must run before loadProfileAndGoals");

  assert.ok(appSrc.includes("commitBootGoals("), "App.tsx should call commitBootGoals");
  assert.equal(appSrc.includes("writeBootCache("), false);
  assert.match(
    appSrc,
    /const handleLogout[\s\S]*?activeUidRef\.current\s*=\s*null;[\s\S]*?clearBootCache\(defaultBootStore\(\)\)[\s\S]*?logOut\(\)[\s\S]*?clearBootCache\(defaultBootStore\(\)\)/
  );
  assert.match(
    appSrc,
    /const handleStartCall[\s\S]*?if\s*\(!canStartCall\(goalsSync\)\)\s*return;/
  );
  assert.ok(appSrc.includes("goalsSyncing={!canStartCall(goalsSync)}"));
  assert.ok(appSrc.includes('goalsSyncFailed={goalsSync === "failed"}'));
  assert.ok(appSrc.includes("onRetryGoalsSync={handleRetryGoalsSync}"));
  assert.match(
    appSrc,
    /const handleRetryGoalsSync[\s\S]*?loadUserDataRef\.current[\s\S]*?nextGoalsSyncState\("retry"\)/
  );
  assert.match(appSrc, /setGoalsSync\(nextGoalsSyncState\("failed"\)\)/);
});

test("App.tsx guards late goal writes by active uid and uses goalsRef for progress updates", () => {
  const appSrc = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");

  const fnBody = (name: string): string => {
    const start = appSrc.indexOf(`const ${name} = async`);
    assert.ok(start > -1, `${name} should exist`);
    const next = appSrc.indexOf("\n  const ", start + 10);
    return appSrc.slice(start, next > -1 ? next : undefined);
  };

  const update = fnBody("handleUpdateGoalProgress");
  assert.ok(update.includes("goalsRef.current.map("), "progress update must use goalsRef");
  assert.equal(/\bgoals\.map\(/.test(update), false, "no stale goals closure");
  const guardIdx = update.indexOf("activeUidRef.current !== uid");
  assert.ok(guardIdx > -1);
  assert.ok(guardIdx > update.indexOf("await updateGoalProgress("));
  assert.ok(guardIdx < update.indexOf("setGoals("));
  assert.ok(guardIdx < update.indexOf("commitBootGoals("));
  const updateClaim = update.indexOf("goalsCommitGateRef.current.claim(");
  assert.ok(updateClaim > guardIdx);
  assert.ok(updateClaim < update.indexOf("setGoals("));

  for (const name of ["handleSaveInitialProgress", "refreshGoals"]) {
    const body = fnBody(name);
    const g = body.indexOf("activeUidRef.current !== uid");
    assert.ok(g > -1, `${name} should check activeUidRef`);
    assert.ok(g < body.indexOf("setGoals("), `${name} guard before setGoals`);
    assert.ok(g < body.indexOf("commitBootGoals("), `${name} guard before commitBootGoals`);
    const claim = body.indexOf("goalsCommitGateRef.current.claim(");
    assert.ok(claim > g, `${name} claims after the uid guard`);
    assert.ok(claim < body.indexOf("setGoals("), `${name} claim before setGoals`);
  }

  // loadUserData: guard (isActive) before setGoals / writeBootCache, and isActive compares activeUidRef
  assert.match(appSrc, /const isActive = \(\) => !cancelled && activeUidRef\.current === uid;/);
  const loadStart = appSrc.indexOf("const loadUserData = async");
  const loadGuard = appSrc.indexOf("if (!isActive()) return;", loadStart);
  assert.ok(loadGuard > loadStart);
  assert.ok(loadGuard < appSrc.indexOf("commitBootGoals(", loadStart));
  assert.ok(loadGuard < appSrc.indexOf("setGoals(userGoals)", loadStart));
  const loadClaim = appSrc.indexOf("goalsCommitGateRef.current.claim(readStartedAt)", loadStart);
  assert.ok(loadClaim > loadGuard);
  assert.ok(loadClaim < appSrc.indexOf("setGoals(userGoals)", loadStart));
  assert.match(appSrc, /if \(!user\) \{\s*activeUidRef\.current = null;/);
});

test("App.tsx clears previous uid cache when auth is released or uid changes, but not while auth is loading", () => {
  const appSrc = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
  assert.match(
    appSrc,
    /useEffect\(\(\) => \{\s*if \(authLoading\) return;[\s\S]*?prevUidRef\.current[\s\S]*?clearBootCache\(defaultBootStore\(\), prevUid\)[\s\S]*?prevUidRef\.current = uid;\s*\}, \[authLoading, user\]\);/
  );
  assert.match(appSrc, /prevUid && prevUid !== uid/);
});

test("HomeScreen.tsx disables start buttons and renders goals-syncing notice when goalsSyncing is true", () => {
  const homeSrc = fs.readFileSync(path.join(root, "src/ui/home/HomeScreen.tsx"), "utf8");

  assert.ok(homeSrc.includes('data-testid="goals-syncing"'));
  assert.ok(homeSrc.includes("disabled={goalsSyncing}"));
  assert.ok(homeSrc.includes("진도 확인 중…"));
  assert.match(homeSrc, /action\.type\s*===\s*"startCall"\s*&&\s*!goalsSyncing/);
});

test("HomeScreen.tsx disables 트랙 골라 통화 and 진도 바꾸기 while syncing/failed and shows goals-sync-retry", () => {
  const homeSrc = fs.readFileSync(path.join(root, "src/ui/home/HomeScreen.tsx"), "utf8");

  assert.match(
    homeSrc,
    /disabled=\{goalsSyncing\}\s*onClick=\{\(\) => setTrackPickerMode\("startCall"\)\}/
  );
  const lessonChangeButtons = homeSrc.match(/disabled=\{goalsSyncing\}\s*onClick=\{\(\) => setLessonChangeGoal\(/g) || [];
  const allLessonChange = homeSrc.match(/onClick=\{\(\) => setLessonChangeGoal\(/g) || [];
  assert.ok(allLessonChange.length > 0);
  assert.equal(lessonChangeButtons.length, allLessonChange.length, "every 진도 바꾸기 button is disabled while syncing");
  assert.match(homeSrc, /const handleLessonChange[\s\S]*?if \(goalsSyncing\) return;/);

  assert.ok(homeSrc.includes('data-testid="goals-sync-retry"'));
  assert.ok(homeSrc.includes("최신 진도를 확인하지 못했어요"));
  assert.ok(homeSrc.includes("다시 확인"));
  assert.match(homeSrc, /\{goalsSyncing && !goalsSyncFailed && \(/);
});
