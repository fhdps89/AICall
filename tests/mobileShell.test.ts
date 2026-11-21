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
  assert.match(src, /supports-\[height:100dvh\]:h-dvh/);
  assert.match(src, /\bmin-h-0\b/);
  assert.match(src, /\bpt-safe\b/);
  assert.match(src, /\bpb-safe\b/);
  // A bare h-dvh next to h-screen loses to the later .h-screen {height:100vh} rule in the built CSS,
  // so dvh must come from the supports-variant, which overrides the vh fallback.
  const rootMatch = src.match(/<div className="([^"]*supports-\[height:100dvh\]:h-dvh[^"]*)"/);
  assert.ok(rootMatch, 'root should use supports-[height:100dvh]:h-dvh so dvh can override vh');
  const rootTokens = rootMatch[1].split(/\s+/);
  assert.equal(rootTokens.includes('h-dvh'), false, 'bare h-dvh would be overridden by h-screen');
  assert.equal(rootTokens.includes('h-screen'), true, 'h-screen is the fallback for browsers without dvh');
});
