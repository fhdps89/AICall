import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePlanChangeAfter, isEmptyPlanChange } from '../src/data/planValidation.ts';

const goals = [
  { id: 'opic', lessons: [1, 2, 3, 14].map((index) => ({ index })) },
  { id: 'philly', lessons: [1, 2].map((index) => ({ index })) },
];

test('keeps valid weekday lists and drops unknown goal ids', () => {
  const out = sanitizePlanChangeAfter({ plan: { weeklyPattern: { mon: ['opic', 'nope'], sat: 'philly', funday: ['opic'] } } }, goals);
  assert.deepEqual(out.plan?.weeklyPattern, { mon: ['opic'], sat: ['philly'] });
});

test('minutesPerDay must be a whole number between 5 and 240', () => {
  assert.equal(sanitizePlanChangeAfter({ plan: { minutesPerDay: 30 } }, goals).plan?.minutesPerDay, 30);
  assert.equal(sanitizePlanChangeAfter({ plan: { minutesPerDay: 0 } }, goals).plan, undefined);
  assert.equal(sanitizePlanChangeAfter({ plan: { minutesPerDay: 'lots' } }, goals).plan, undefined);
});

test('goal patches: known goals, existing lessons, real dates, valid status only', () => {
  const out = sanitizePlanChangeAfter(
    {
      goals: {
        opic: { nextLessonIndex: 14, deadline: '2026-11-29', status: 'active' },
        philly: { nextLessonIndex: 99, deadline: '2026-02-30', status: 'sleeping' },
        ghost: { status: 'paused' },
      },
    },
    goals
  );
  assert.deepEqual(out.goals, { opic: { nextLessonIndex: 14, deadline: '2026-11-29', status: 'active' } });
});

test('garbage input leaves an empty change', () => {
  for (const bad of [null, 'text', 42, { plan: 'x', goals: [] }]) {
    assert.ok(isEmptyPlanChange(sanitizePlanChangeAfter(bad, goals)));
  }
});

test('lessonsPerCall 1..3 is preserved and out-of-range/non-integer values are dropped', () => {
  const kept = sanitizePlanChangeAfter({ goals: { opic: { lessonsPerCall: 2 } } }, goals);
  assert.deepEqual(kept, { goals: { opic: { lessonsPerCall: 2 } } });
  assert.equal(isEmptyPlanChange(kept), false);

  for (const bad of [0, 4, 1.5, '2', null]) {
    const dropped = sanitizePlanChangeAfter({ goals: { opic: { lessonsPerCall: bad } } }, goals);
    assert.equal(dropped.goals, undefined);
    assert.equal(isEmptyPlanChange(dropped), true);
  }

  const unknownGoal = sanitizePlanChangeAfter({ goals: { ghost: { lessonsPerCall: 2 } } }, goals);
  assert.equal(isEmptyPlanChange(unknownGoal), true);

  const combined = sanitizePlanChangeAfter(
    { goals: { opic: { nextLessonIndex: 3, lessonsPerCall: 2 } } },
    goals
  );
  assert.deepEqual(combined, { goals: { opic: { nextLessonIndex: 3, lessonsPerCall: 2 } } });
});
