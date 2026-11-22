import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');

test('db.applyPlanChange rejects qaPreview and CoachModal wires qaPreview/infoCard without local preview IDs', () => {
  const dbSrc = fs.readFileSync(path.join(root, 'src/services/firebase/db.ts'), 'utf8');
  const coachSrc = fs.readFileSync(path.join(root, 'src/ui/coach/CoachModal.tsx'), 'utf8');

  const applyMatch = dbSrc.match(/export async function applyPlanChange[\s\S]*?\n\}/);
  assert.ok(applyMatch, 'applyPlanChange must exist in db.ts');
  assert.match(applyMatch[0], /if\s*\(\s*data\.qaPreview\s*\)\s*\{\s*throw new Error\(/);

  assert.doesNotMatch(coachSrc, /qa-preview-/);
  assert.doesNotMatch(coachSrc, /persistChangeId/);
  assert.match(coachSrc, /\bprogressReplyForDisplay\b/);
  assert.match(coachSrc, /\bresolveQaProgressQuickReply\b/);
  assert.match(coachSrc, /\bsanitizeCoachInfoCard\b/);
});
