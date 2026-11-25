import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function extractMatchBlock(src: string, headerRe: RegExp): string {
  const m = headerRe.exec(src);
  assert.ok(m, `header ${headerRe} must exist`);
  const openIdx = m.index + m[0].length - 1;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i + 2);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  assert.fail(`unclosed block for ${headerRe}`);
}

test('firestore.rules audio chunk subcollection and storage.rules removal guards', () => {
  const firestoreRules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
  const daysSection = extractMatchBlock(firestoreRules, /match\s+\/days\/\{date\}\s*\{/);
  const audioSection = extractMatchBlock(daysSection, /match\s+\/audio\/\{n\}\s*\{/);

  assert.match(audioSection, /allow get:\s*if true;/);
  assert.match(audioSection, /exists\(\/databases\/\$\(database\)\/documents\/feeds\/\$\(feedId\)\)/);
  assert.match(audioSection, /request\.resource\.data\.keys\(\)\.hasOnly\(\['data',\s*'updatedAt'\]\)/);
  assert.match(audioSection, /800000/);
  assert.ok(audioSection.includes('^[0-7]$'), 'expected ^[0-7]$ chunk index pattern');
  assert.match(audioSection, /allow delete:\s*if isSingleAllowedUser\(/);

  const outsideDays = firestoreRules.replace(daysSection, '');
  assert.equal(
    /match\s+\/audio\/\{n\}/.test(outsideDays),
    false,
    'match /audio/{n} must only exist inside match /days/{date}'
  );

  const storageRules = fs.readFileSync(path.join(root, 'storage.rules'), 'utf8');
  assert.equal(storageRules.includes('ai-studio-'), false, 'storage.rules must not reference ai-studio-');
  assert.equal(storageRules.includes('/feeds/'), false, 'storage.rules must not contain /feeds/ block');
});
