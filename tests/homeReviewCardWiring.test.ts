import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

test("HomeScreen wires MistakeLoadState and avoids duplicate getDueMistakes read", () => {
  const homeSrc = fs.readFileSync(path.join(root, "src/ui/home/HomeScreen.tsx"), "utf8");

  assert.ok(homeSrc.includes("initialMistakeState("));
  assert.equal(homeSrc.includes("getDueMistakes("), false);
  assert.ok(homeSrc.includes('data-testid="review-card-loading"'));
  assert.ok(homeSrc.includes('data-testid="review-card-retry"'));
});
