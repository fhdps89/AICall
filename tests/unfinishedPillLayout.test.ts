import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');

test('unfinished-call pill is an in-flow home banner, not a fixed overlay', () => {
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
  const home = fs.readFileSync(path.join(root, 'src/ui/home/HomeScreen.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');

  assert.match(app, /const showUnfinishedPill =/);
  assert.match(app, /unfinishedCount=\{showUnfinishedPill \? unfinishedSessions\.length : 0\}/);
  assert.match(app, /onOpenUnfinished=\{\(\) => setShowUnfinishedModal\(true\)\}/);
  assert.doesNotMatch(app, /data-testid="unfinished-call-pill"/);
  assert.doesNotMatch(app, /reserveBottomForPill/);
  assert.doesNotMatch(app, /fixed bottom-safe left-1\/2/);

  assert.match(home, /unfinishedCount\?: number/);
  assert.match(home, /onOpenUnfinished\?: \(\) => void/);
  assert.match(home, /data-testid="unfinished-call-pill"/);
  assert.match(home, /unfinishedCount > 0 && onOpenUnfinished/);
  assert.doesNotMatch(home, /unfinished-pill-spacer/);
  assert.doesNotMatch(home, /fixed bottom-safe/);

  assert.doesNotMatch(css, /\.unfinished-pill-space/);
});
