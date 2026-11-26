import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadLectureForCard } from "../src/services/lecture/lectureCardLoad.ts";
import {
  lectureCardFlagsAfterLocal,
  lectureCardFlagsAfterServer,
  lectureCardView,
  type LectureCardView,
} from "../src/services/lecture/lectureSyncPolicy.ts";
import type { LectureDoc } from "../src/services/lecture/lectureService.ts";

const root = path.resolve(import.meta.dirname, "..");
const EMPTY = "아직 오늘 강의가 없어요";
const LOADING = "불러오는 중…";

function makeLecture(overrides: Partial<LectureDoc> = {}): LectureDoc {
  return {
    date: "2026-11-26",
    status: "ready",
    createdAt: "2026-11-26T00:00:00.000Z",
    ...overrides,
  };
}

/** Same flag hand-off MorningLectureCard uses around loadLectureForCard. */
function viewFromLocal(
  lecture: LectureDoc | null,
  needsServer: boolean
): LectureCardView {
  return lectureCardView({
    ...lectureCardFlagsAfterLocal(lecture, needsServer),
    lecture,
  });
}

function viewFromServer(result: {
  lecture: LectureDoc | null;
  server: "skipped" | "ok" | "failed" | "timeout";
}): LectureCardView {
  return lectureCardView({
    ...lectureCardFlagsAfterServer(result.server),
    lecture: result.lecture,
  });
}

test("null local with the server still pending stays loading, not empty", async () => {
  let releaseServer!: (doc: LectureDoc | null) => void;
  let pendingView: LectureCardView | undefined;

  const pending = loadLectureForCard({
    readLocal: async () => null,
    syncServer: () =>
      new Promise<LectureDoc | null>((resolve) => {
        releaseServer = resolve;
      }),
    onLocal: (lecture, needsServer) => {
      pendingView = viewFromLocal(lecture, needsServer);
    },
  });

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pendingView?.presence, "unknown");
  assert.equal(pendingView?.headline, LOADING);
  assert.notEqual(pendingView?.headline, EMPTY);

  releaseServer(null);
  await pending;
});

test("server confirming there is no lecture shows the empty headline", async () => {
  let pendingView: LectureCardView | undefined;
  const result = await loadLectureForCard({
    readLocal: async () => null,
    syncServer: async () => null,
    onLocal: (lecture, needsServer) => {
      pendingView = viewFromLocal(lecture, needsServer);
    },
  });

  assert.equal(pendingView?.presence, "unknown");
  assert.equal(pendingView?.headline, LOADING);
  const settled = viewFromServer(result);
  assert.equal(result.server, "ok");
  assert.equal(settled.presence, "none");
  assert.equal(settled.headline, EMPTY);
  assert.equal(settled.slow, false);
});

test("server returning a ready lecture shows that lecture", async () => {
  const serverDoc = makeLecture({ title: "오늘 표현", status: "ready" });
  const result = await loadLectureForCard({
    readLocal: async () => null,
    syncServer: async () => serverDoc,
    onLocal: () => {},
  });

  const settled = viewFromServer(result);
  assert.equal(result.server, "ok");
  assert.equal(settled.presence, "lecture");
  assert.equal(settled.headline, "오늘 표현");
  assert.notEqual(settled.headline, EMPTY);
});

test("timeout with no local lecture shows the slow state, not the empty headline", async () => {
  const result = await loadLectureForCard({
    readLocal: async () => null,
    syncServer: () => new Promise<LectureDoc | null>(() => {}),
    onLocal: () => {},
    timeoutMs: 20,
  });

  const settled = viewFromServer(result);
  assert.equal(result.server, "timeout");
  assert.equal(settled.presence, "unknown");
  assert.equal(settled.headline, LOADING);
  assert.equal(settled.slow, true);
  assert.notEqual(settled.headline, EMPTY);
});

test("the card renders the view helper and keeps the 10s server timeout", () => {
  const card = fs.readFileSync(
    path.join(root, "src/ui/lecture/MorningLectureCard.tsx"),
    "utf8"
  );
  const loader = fs.readFileSync(
    path.join(root, "src/services/lecture/lectureCardLoad.ts"),
    "utf8"
  );

  assert.match(card, /lectureCardFlagsAfterLocal\(/);
  assert.match(card, /lectureCardView\(/);
  assert.equal(card.includes(EMPTY), false);
  assert.match(loader, /timeoutMs \?\? 10_000/);
  assert.match(card, /확인이 늦어지고 있어요/);
});
