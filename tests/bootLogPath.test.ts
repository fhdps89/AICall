import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadLectureForCard } from "../src/services/lecture/lectureCardLoad.ts";
import { settleBootPhase } from "../src/services/perf/bootTiming.ts";
import type { LectureDoc } from "../src/services/lecture/lectureService.ts";

const root = path.resolve(import.meta.dirname, "..");

/**
 * HomeScreen and MorningLectureCard used to mark only after isCurrent/canApply.
 * A superseded mount (or a thrown mistakes read) settled the screen and skipped
 * the mark, so flush never ran. These calls are that seam: the test discards
 * the results the way those guards do, and does not call markBoot itself.
 */
test("discarded lecture and mistakes reads still log [boot] once", async () => {
  const logs: string[] = [];
  const original = console.info;
  console.info = (msg?: unknown) => {
    logs.push(String(msg));
  };

  try {
    const lecture = loadLectureForCard({
      readLocal: async () => null,
      syncServer: () => new Promise<LectureDoc | null>(() => {}),
      onLocal: () => {
        // Card paints here, then a newer mount makes canApply false.
      },
      timeoutMs: 30,
    }).then((result) => {
      const canApply = false;
      if (!canApply) return null;
      return result;
    });

    const mistakes = settleBootPhase("mistakes", async () => {
      throw new Error("firestore");
    }).then(
      (all) => {
        const isCurrent = false;
        if (!isCurrent) return;
        return all;
      },
      () => {
        const isCurrent = false;
        if (!isCurrent) return;
      }
    );

    await mistakes;
    assert.equal(logs.length, 0);

    await lecture;
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[boot\] /);
    assert.match(logs[0], /mistakes=\d+ms/);
    assert.match(logs[0], /lectureServer=\d+ms/);
    assert.doesNotMatch(logs[0], /mistakes=-/);
    assert.doesNotMatch(logs[0], /lectureServer=-/);

    await settleBootPhase("mistakes", async () => []);
    await loadLectureForCard({
      readLocal: async () => null,
      syncServer: async () => null,
      onLocal: () => {},
      timeoutMs: 20,
    });
    assert.equal(logs.length, 1);
  } finally {
    console.info = original;
  }
});

test("HomeScreen and MorningLectureCard mark through the settle seam, not after the accept guard", () => {
  const home = fs.readFileSync(path.join(root, "src/ui/home/HomeScreen.tsx"), "utf8");
  const card = fs.readFileSync(
    path.join(root, "src/ui/lecture/MorningLectureCard.tsx"),
    "utf8"
  );
  const loader = fs.readFileSync(
    path.join(root, "src/services/lecture/lectureCardLoad.ts"),
    "utf8"
  );

  assert.match(home, /settleBootPhase\(\s*"mistakes"/);
  assert.match(home, /settleBootPhase\(\s*"mistakes"[\s\S]{0,160}if \(!isCurrent\(\)\) return/);
  assert.match(card, /loadLectureForCard\(/);
  assert.match(card, /if \(!canApply\(reqId\)\) return null/);
  assert.equal(card.includes('markBoot("lectureServer")'), false);
  assert.equal(card.includes('markBoot("lectureLocal")'), false);
  assert.match(loader, /finally\s*\{\s*markBoot\("lectureServer"\)/);
  assert.match(loader, /markBoot\("lectureLocal"\)/);
});
