import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalsToCreate, type GoalData } from '../src/services/firebase/db.ts';

const goals = [
  { id: 'opic', nextLessonIndex: 1 },
  { id: 'travel', nextLessonIndex: 1 },
  { id: 'philly', nextLessonIndex: 1 },
] as GoalData[];

test('goalsToCreate skips ids that already exist so seed cannot reset progress', () => {
  const created = goalsToCreate(['travel', 'opic'], goals);
  assert.deepEqual(created.map((g) => g.id), ['philly']);
});

test('goalsToCreate returns all defaults when the collection is empty', () => {
  assert.deepEqual(goalsToCreate([], goals).map((g) => g.id), ['opic', 'travel', 'philly']);
});
