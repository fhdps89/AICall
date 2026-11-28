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

test('lesson prompt wrapper is short English (re-billed every Live turn) for every default goal', () => {
  for (const g of DEFAULT_GOALS) {
    const p = buildTodayLessonSystemPrompt(g, 1, ph, []);
    const hydrated = hydrateTutorPrompt(g.tutorPrompt, ph, g.id);
    const wrapper = p.replace(hydrated, '');
    // Was ~1,550 chars with ~710 Hangul chars of fixed rules; now English only (goal/lesson titles excluded).
    const rules = wrapper.replace(g.title, '').replace(g.why, '');
    assert.ok(wrapper.length <= 1800, `wrapper too long for ${g.id}: ${wrapper.length}`);
    assert.doesNotMatch(rules.replace(/Lesson \d+: .*/g, ''), /[\uac00-\ud7a3]/, `Hangul left in fixed rules for ${g.id}`);
  }
});

test('lesson prompt wrapper preserves key call rules and commands', () => {
  const p = buildTodayLessonSystemPrompt(goal('opic'), 1, ph, []);
  for (const re of [
    /Tell me more/,
    /That's it for today/,
    /Model answer/,
    /Slow/,
    /Next lesson/,
    /PROGRESS/,
    /70%/,
    /Done/,
    /Feedback/,
    /Pause/,
    /Australian/,
  ]) {
    assert.match(p, re, `expected lesson prompt to match ${re}`);
  }
});

test('lesson prompt keeps spoken/friendly style and formats review mistakes in English', () => {
  const p = buildTodayLessonSystemPrompt(goal('opic'), 1, ph, [
    { myPhrase: 'I go yesterday', naturalPhrase: 'I went yesterday', reason: 'past tense' },
  ]);
  assert.match(p, /spoken, concise, friendly/);
  assert.match(p, /Review mistakes \(wrong -> correct\)\. Naturally create chances/);
  assert.match(p, /1\. "I go yesterday" -> "I went yesterday" \(past tense\)/);
  const empty = buildTodayLessonSystemPrompt(goal('opic'), 1, ph, []);
  assert.match(empty, /Review mistakes: none yet\. Focus on the new lesson\./);
});
