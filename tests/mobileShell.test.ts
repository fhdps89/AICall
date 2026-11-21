import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..');

test('index.html viewport includes viewport-fit=cover and allows pinch zoom', () => {
  const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf-8');
  const match = html.match(/<meta\s+name=["']viewport["']\s+content=["']([^"']+)["']/i);
  assert.ok(match, 'viewport meta tag should exist');
  assert.match(match[1], /\bviewport-fit=cover\b/);
  assert.equal(/\buser-scalable=no\b/i.test(match[1]), false, 'viewport must not disable user scaling');
  assert.equal(/\bmaximum-scale=1(?:\.0+)?\b/i.test(match[1]), false, 'viewport must not lock maximum-scale to 1');
});

test('index.html theme-color matches manifest.json theme_color and background_color', () => {
  const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf-8');
  const themeMatch = html.match(/<meta\s+name=["']theme-color["']\s+content=["']([^"']+)["']/i);
  assert.ok(themeMatch, 'theme-color meta tag should exist');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'public/manifest.json'), 'utf-8'),
  ) as { theme_color?: string; background_color?: string };
  assert.equal(manifest.theme_color, themeMatch[1]);
  assert.equal(manifest.background_color, themeMatch[1]);
});

test('index.html body allows text selection (no select-none)', () => {
  const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf-8');
  const bodyMatch = html.match(/<body\b[^>]*\bclass=["']([^"']+)["'][^>]*>/i);
  assert.ok(bodyMatch, 'body tag with class attribute should exist');
  const classes = bodyMatch[1].trim().split(/\s+/);
  assert.equal(classes.includes('select-none'), false, 'body class must not include select-none');
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
  assert.equal(rootTokens.includes('select-none'), true, 'call screen keeps select-none');
});

test('SettingsModal tab bar scrolls horizontally on one line without wrapping', () => {
  const src = fs.readFileSync(path.join(rootDir, 'src/ui/settings/SettingsModal.tsx'), 'utf-8');
  const navStart = src.indexOf('{/* Tab Navigation */}');
  const bodyStart = src.indexOf('{/* Body */}', navStart);
  assert.ok(navStart !== -1 && bodyStart > navStart, 'SettingsModal should have Tab Navigation before Body');
  const tabBarSrc = src.slice(navStart, bodyStart);
  assert.match(tabBarSrc, /overflow-x-auto/);
  assert.match(tabBarSrc, /flex-nowrap/);
  assert.match(tabBarSrc, /whitespace-nowrap/);
  assert.match(tabBarSrc, /shrink-0/);
  assert.match(src, /scrollIntoView/);
});
