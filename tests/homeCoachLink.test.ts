import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');

test('HomeScreen renders today-card-coach-link twice, keeps More coach card, and excludes qaPreview in alreadyProposed', () => {
  const homeSrc = fs.readFileSync(path.join(root, 'src/ui/home/HomeScreen.tsx'), 'utf8');

  const linkMatches = homeSrc.match(/data-testid="today-card-coach-link"/g) ?? [];
  assert.equal(linkMatches.length, 2);

  assert.match(homeSrc, /<span>코치와 대화하기<\/span>/);
  assert.match(homeSrc, /const alreadyProposed = existingChanges\.some\([\s\S]*?!c\.qaPreview/);
});
