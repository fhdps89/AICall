import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupChunks } from '../src/services/recording/audioMerge.ts';
import { addKSTDays } from '../src/services/firebase/db.ts';
import { estimateCostUsd } from '../src/services/usage/usageService.ts';
import { PRICING_RATES } from '../src/config/models.ts';

test('chunks are grouped into 1-minute batches of 6', () => {
  assert.deepEqual(groupChunks([1, 2, 3, 4, 5, 6, 7, 8]).map((g) => g.length), [6, 2]);
});

test('KST date arithmetic crosses month ends', () => {
  assert.equal(addKSTDays(1, '2026-10-31'), '2026-11-01');
  assert.equal(addKSTDays(14, '2026-12-25'), '2027-01-08');
});

test('cost estimate uses the single price table', () => {
  assert.equal(estimateCostUsd({ liveMinutes: 10 }), 10 * PRICING_RATES.livePerMinute);
});
