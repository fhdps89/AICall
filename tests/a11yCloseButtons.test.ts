import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");

const MODAL_FILES = [
  "src/ui/call/UnfinishedSessionModal.tsx",
  "src/ui/settings/SettingsModal.tsx",
  "src/ui/coach/CoachModal.tsx",
  "src/ui/lecture/LectureModal.tsx",
  "src/ui/keep/KeepImportModal.tsx",
  "src/ui/sttBench/SttBenchmarkModal.tsx",
  "src/ui/quiz/QuizModal.tsx",
];

test("7개 모달의 <X 아이콘을 품은 <button> 여는 태그에 모두 aria-label이 있다", () => {
  for (const relPath of MODAL_FILES) {
    const src = fs.readFileSync(path.join(rootDir, relPath), "utf-8");
    const buttonWithX = [...src.matchAll(/<button\b([^>]*)>\s*<X\b/g)];
    assert.ok(buttonWithX.length > 0, `${relPath} should have at least one <button><X /></button>`);
    for (const match of buttonWithX) {
      assert.match(
        match[1],
        /\baria-label=["'][^"']+["']/,
        `${relPath} close button opening tag must include aria-label`
      );
    }
  }
});

test("UnfinishedSessionModal 헤더 div에 pr-8이 있어 닫기 버튼과 겹치지 않는다", () => {
  const src = fs.readFileSync(
    path.join(rootDir, "src/ui/call/UnfinishedSessionModal.tsx"),
    "utf-8"
  );
  const headerMatch = src.match(/\{\/\* Header Banner \*\/\}\s*<div className="([^"]+)"/);
  assert.ok(headerMatch, "UnfinishedSessionModal should have Header Banner div");
  assert.match(headerMatch[1], /\bpr-(8|10|12)\b/);
});
