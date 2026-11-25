import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

test('firestore.rules audio chunk subcollection and storage.rules removal guards', () => {
  const firestoreRules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
  const daysIdx = firestoreRules.indexOf('match /days/{date}');
  assert.ok(daysIdx >= 0, 'match /days/{date} must exist');
  const daysSection = firestoreRules.slice(daysIdx);

  const audioIdx = daysSection.indexOf('match /audio/{n}');
  assert.ok(audioIdx >= 0, 'match /audio/{n} must exist inside match /days/{date}');
  const audioSection = daysSection.slice(audioIdx);

  assert.match(audioSection, /allow get:\s*if true;/);
  assert.match(audioSection, /exists\(\/databases\/\$\(database\)\/documents\/feeds\/\$\(feedId\)\)/);
  assert.match(audioSection, /request\.resource\.data\.keys\(\)\.hasOnly\(\['data',\s*'updatedAt'\]\)/);
  assert.match(audioSection, /800000/);
  assert.ok(audioSection.includes('^[0-7]$'), 'expected ^[0-7]$ chunk index pattern');
  assert.match(audioSection, /allow delete:\s*if isSingleAllowedUser\(/);

  const storageRules = fs.readFileSync(path.join(root, 'storage.rules'), 'utf8');
  assert.equal(storageRules.includes('ai-studio-'), false, 'storage.rules must not reference ai-studio-');
  assert.equal(storageRules.includes('/feeds/'), false, 'storage.rules must not contain /feeds/ block');
});
