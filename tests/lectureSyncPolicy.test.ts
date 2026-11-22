import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  LECTURE_UPLOAD_BACKOFF_MS,
  shouldShowLectureImmediately,
  shouldCopyLectureAudio,
  shouldOverwriteFirestoreLecture,
  listenedAtToKeep,
  shouldMarkLectureDate,
} from '../src/services/lecture/lectureSyncPolicy.ts';

test('ready lecture without audioUrl can be shown immediately', () => {
  assert.equal(shouldShowLectureImmediately({ status: 'ready' }), true);
  assert.equal(shouldShowLectureImmediately({ status: 'generating' }), false);
  assert.equal(shouldShowLectureImmediately(null), false);
});

test('audio copy is skipped while backoff is active and is single-reasoned', () => {
  const ready = { status: 'ready', audioUrl: null as string | null };
  const now = 1_000_000;
  assert.equal(shouldCopyLectureAudio(ready, now, null), true);
  assert.equal(shouldCopyLectureAudio({ status: 'ready', audioUrl: 'https://x' }, now, null), false);
  assert.equal(shouldCopyLectureAudio(ready, now, now - 1000), false);
  assert.equal(shouldCopyLectureAudio(ready, now, now - LECTURE_UPLOAD_BACKOFF_MS - 1), true);
  assert.equal(shouldCopyLectureAudio({ status: 'generating' }, now, null), false);
});

test('does not overwrite a ready Firestore lecture with a different ready server lecture', () => {
  const current = { status: 'ready', createdAt: '2026-11-22T01:56:00.000Z' };
  const server = { status: 'ready', createdAt: '2026-11-22T02:06:00.000Z' };
  assert.equal(shouldOverwriteFirestoreLecture(current, server), false);
  assert.equal(shouldOverwriteFirestoreLecture(current, { status: 'ready', createdAt: current.createdAt }), true);
  assert.equal(shouldOverwriteFirestoreLecture({ status: 'generating', createdAt: 'a' }, server), true);
});

test('listenedAt is kept only for the same lecture createdAt', () => {
  const current = { createdAt: 'a', listenedAt: 'heard' };
  assert.equal(listenedAtToKeep(current, 'a'), 'heard');
  assert.equal(listenedAtToKeep(current, 'b'), null);
  assert.equal(listenedAtToKeep({ createdAt: 'a', listenedAt: null }, 'a'), null);
});

test('lectureDate is recorded only when status first becomes ready', () => {
  assert.equal(shouldMarkLectureDate('generating', 'ready'), true);
  assert.equal(shouldMarkLectureDate(undefined, 'ready'), true);
  assert.equal(shouldMarkLectureDate('ready', 'ready'), false);
  assert.equal(shouldMarkLectureDate('failed', 'generating'), false);
});

test('storage setup doc includes a rule for every users/{uid}/<seg>/ path used in src', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const doc = fs.readFileSync(path.join(root, 'docs/troubleshooting/firebase-storage-setup.md'), 'utf8');
  const used = new Set<string>();
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.git') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(ent.name)) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/users\/\$\{uid\}\/([A-Za-z0-9_-]+)\//g)) used.add(m[1]);
        for (const m of src.matchAll(/users\/\$\{[^}]+]\}\/([A-Za-z0-9_-]+)\//g)) used.add(m[1]);
      }
    }
  };
  walk(path.join(root, 'src'));
  const required = [...used].filter((s) => s === 'lectures' || s === 'recordings');
  assert.ok(required.includes('lectures'), `src uses lectures, used=${[...used]}`);
  for (const seg of required) {
    assert.match(doc, new RegExp(`match /users/\\{uid\\}/${seg}/`), `doc missing rule for users/{uid}/${seg}/`);
  }
});
