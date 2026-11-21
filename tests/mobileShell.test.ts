import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..');

test('index.html viewport includes viewport-fit=cover', () => {
  const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf-8');
  const match = html.match(/<meta\s+name=["']viewport["']\s+content=["']([^"']+)["']/i);
  assert.ok(match, 'viewport meta tag should exist');
  assert.match(match[1], /\bviewport-fit=cover\b/);
});

test('NewCallScreen uses "답변 끝" instead of "끝내기" and keeps fixed viewport layout', () => {
  const src = fs.readFileSync(path.join(rootDir, 'src/ui/call/NewCallScreen.tsx'), 'utf-8');
  assert.equal(src.includes('끝내기'), false, 'NewCallScreen.tsx must not contain "끝내기"');
  assert.equal(src.includes('답변 끝'), true, 'NewCallScreen.tsx must contain "답변 끝"');
  assert.match(src, /Done:\s*"답변 끝"/);
  assert.match(src, /\bh-dvh\b/);
  assert.match(src, /\bmin-h-0\b/);
  assert.match(src, /\bpt-safe\b/);
  assert.match(src, /\bpb-safe\b/);
});
