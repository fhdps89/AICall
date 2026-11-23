import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

test('MorningLectureCard renders secondary rebuild button only in ready state with confirm and rebuildTodayLecture', () => {
  const src = fs.readFileSync(
    path.join(root, 'src/ui/lecture/MorningLectureCard.tsx'),
    'utf8'
  );

  assert.match(src, /import\s+\{\s*rebuildTodayLecture\s*\}\s+from\s+["']\.\.\/\.\.\/services\/lecture\/rebuildTodayLecture["']/);
  assert.match(src, /rebuildTodayLecture\(user\.uid,\s*today\)/);
  assert.match(src, /data-testid="rebuild-today-lecture"/);
  assert.ok(
    src.includes('confirm("오늘 통화까지 넣어 강의를 다시 만들까요?")'),
    'Expected exact confirm prompt string'
  );
  assert.match(
    src,
    /if\s*\(!confirm\("오늘 통화까지 넣어 강의를 다시 만들까요\?"\)\)\s*return;[\s\S]{0,80}runLectureAction\(\(\) => rebuildTodayLecture/
  );

  const readyBranchMatch = src.match(
    /\{status === "ready" \? \(([\s\S]*?)\) : status === "generating" \? \(([\s\S]*?)\) : \(([\s\S]*?)\n\s*\)\}/
  );
  assert.ok(readyBranchMatch, 'Expected status === "ready" / "generating" / fallback JSX branches');

  const [, readyBranch, generatingBranch, fallbackBranch] = readyBranchMatch;

  assert.ok(readyBranch.includes('재생'), 'ready branch should keep 재생 button');
  assert.ok(readyBranch.includes('다시 만들기'), 'ready branch should include 다시 만들기 button');
  assert.ok(
    readyBranch.includes('data-testid="rebuild-today-lecture"'),
    'ready branch should include rebuild-today-lecture testid'
  );

  assert.equal(
    generatingBranch.includes('rebuild-today-lecture'),
    false,
    'generating branch must not include rebuild-today-lecture'
  );
  assert.equal(
    generatingBranch.includes('다시 만들기'),
    false,
    'generating branch must not include 다시 만들기'
  );

  assert.ok(
    fallbackBranch.includes('오늘 강의 만들기'),
    'failed/missing branch should still render 오늘 강의 만들기'
  );
  assert.equal(
    fallbackBranch.includes('rebuild-today-lecture'),
    false,
    'failed/missing branch must not include rebuild-today-lecture'
  );
  assert.equal(
    fallbackBranch.includes('다시 만들기'),
    false,
    'failed/missing branch must not include 다시 만들기'
  );
});
