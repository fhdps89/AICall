import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hydrateTutorPrompt, DEFAULT_PROMPT_PLACEHOLDERS } from '../src/data/promptCustomizer.ts';
import { DEFAULT_GOALS } from '../src/data/defaultGoals.ts';
import { buildTodayLessonSystemPrompt } from '../src/data/lessonPromptBuilder.ts';

const ph = { ...DEFAULT_PROMPT_PLACEHOLDERS, opicWeakPoints: 'OPIC-WEAK', phillyWeakPoints: 'PHILLY-WEAK', travelWeakPoints: 'TRAVEL-WEAK' };
const goal = (id: string) => DEFAULT_GOALS.find((g) => g.id === id)!;

test('each track gets its own weak points', () => {
  assert.match(hydrateTutorPrompt(goal('opic').tutorPrompt, ph, 'opic'), /OPIC-WEAK/);
  const philly = hydrateTutorPrompt(goal('philly').tutorPrompt, ph, 'philly');
  assert.match(philly, /PHILLY-WEAK/);
  const travel = hydrateTutorPrompt(goal('travel').tutorPrompt, ph, 'travel');
  assert.match(travel, /TRAVEL-WEAK/);
  assert.doesNotMatch(travel, /PHILLY-WEAK/);
});

test('lesson prompt lists at most 3 review mistakes', () => {
  const m = (i: number) => ({ myPhrase: `wrong ${i}`, naturalPhrase: `right ${i}`, reason: 'r' });
  const p = buildTodayLessonSystemPrompt(goal('opic'), 1, ph, [m(1), m(2), m(3), m(4)]);
  assert.match(p, /wrong 3/);
  assert.doesNotMatch(p, /wrong 4/);
});
