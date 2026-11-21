import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('ReviewModal and App do not call startLecture on the review-to-lecture path', () => {
  const reviewModalSrc = fs.readFileSync(path.join(rootDir, 'src/ui/review/ReviewModal.tsx'), 'utf-8');
  const appSrc = fs.readFileSync(path.join(rootDir, 'src/App.tsx'), 'utf-8');

  assert.equal(/\bstartLecture\b/.test(reviewModalSrc), false);
  assert.equal(/\bstartLecture\b/.test(appSrc), false);
});
