import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStepTimer } from '../src/services/review/reviewTiming.ts';

test('step timer records step durations and totalMs with a fake clock', () => {
  let t = 1000;
  const timer = createStepTimer(() => t);

  timer.start('collectChunks');
  t += 120;
  timer.end('collectChunks');

  timer.start('transcribe');
  t += 850;
  timer.end('transcribe');

  timer.start('review');
  t += 430;
  timer.end('review');

  const snap = timer.snapshot();
  assert.deepEqual(snap.steps, {
    collectChunks: 120,
    transcribe: 850,
    review: 430,
  });
  assert.equal(snap.totalMs, 1400);
});

test('step with start but no end is omitted from snapshot', () => {
  let t = 500;
  const timer = createStepTimer(() => t);

  timer.start('collectChunks');
  t += 50;
  timer.end('collectChunks');

  timer.start('review');
  t += 300;
  // review is never ended

  const snap = timer.snapshot();
  assert.deepEqual(snap.steps, { collectChunks: 50 });
  assert.equal('review' in snap.steps, false);
  assert.equal(snap.totalMs, 50);
});

test('same step started and ended twice is summed', () => {
  let t = 0;
  const timer = createStepTimer(() => t);

  timer.start('transcribe');
  t += 100;
  timer.end('transcribe');

  t += 25; // gap outside step

  timer.start('transcribe');
  t += 250;
  timer.end('transcribe');

  // Calling end without a matching start is ignored
  timer.end('transcribe');

  const snap = timer.snapshot();
  assert.deepEqual(snap.steps, { transcribe: 350 });
  assert.equal(snap.totalMs, 350);
});
