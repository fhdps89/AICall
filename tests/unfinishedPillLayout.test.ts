import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');

test('unfinished-call pill and home padding share one visibility flag', () => {
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
  const home = fs.readFileSync(path.join(root, 'src/ui/home/HomeScreen.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');

  assert.match(app, /const showUnfinishedPill =/);
  assert.match(app, /reserveBottomForPill=\{showUnfinishedPill\}/);
  assert.match(app, /\{showUnfinishedPill && \(/);
  assert.match(app, /whitespace-nowrap/);
  assert.match(app, /data-testid="unfinished-call-pill"/);

  assert.match(home, /reserveBottomForPill\?: boolean/);
  assert.match(home, /reserveBottomForPill = false/);
  assert.match(home, /unfinished-pill-spacer/);
  assert.match(home, /unfinished-pill-space/);

  assert.match(css, /\.unfinished-pill-space\s*\{/);
  assert.match(css, /env\(safe-area-inset-bottom/);
});
