import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupChunks } from '../src/services/recording/audioMerge.ts';
import { addKSTDays } from '../src/services/firebase/db.ts';
import { estimateCostUsd, buildUsageFields } from '../src/services/usage/usageService.ts';
import { PRICING_RATES } from '../src/config/models.ts';
import { buildClusterRequest, pickDisplayClusters } from '../src/services/mistakes/clusterRequest.ts';

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

test('usage cost: sieEmbeddingTokens priced at $0.06/1M and kept separate from textTokens', () => {
  assert.equal(PRICING_RATES.sieEmbedPer1MTokens, 0.06);
  const cost = estimateCostUsd({ sieEmbeddingTokens: 1_000_000 });
  assert.ok(Math.abs(cost - 0.06) < 1e-12);

  const fields = buildUsageFields({ sieEmbeddingTokens: 1_000_000 }, (n) => n);
  assert.equal(fields.textTokens, 0);
  assert.equal(fields.sieEmbeddingTokens, 1_000_000);
  assert.ok(Math.abs(fields.estCostUsd - 0.06) < 1e-12);
});

test('buildClusterRequest: caps to 120, truncates fields, drops missing phrases and graduated items', () => {
  const empty = buildClusterRequest([]);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.shouldRequest, false);

  const single = buildClusterRequest([
    { id: 'm1', myPhrase: 'I go', naturalPhrase: 'I went', reason: 'tense', status: 'reviewing' },
  ]);
  assert.equal(single.items.length, 1);
  assert.equal(single.shouldRequest, false);

  const many = Array.from({ length: 130 }, (_, i) => ({
    id: `id_${i}`,
    myPhrase: i === 0 ? 'x'.repeat(250) : `wrong ${i}`,
    naturalPhrase: i === 0 ? 'y'.repeat(250) : `right ${i}`,
    reason: i === 0 ? 'z'.repeat(350) : 'reason',
    status: 'reviewing',
  }));
  many.unshift(
    { id: 'drop_empty_my', myPhrase: '  ', naturalPhrase: 'ok', reason: 'r', status: 'reviewing' },
    { id: 'drop_empty_nat', myPhrase: 'ok', naturalPhrase: '', reason: 'r', status: 'reviewing' },
    { id: 'drop_grad', myPhrase: 'a', naturalPhrase: 'b', reason: 'r', status: 'graduated' }
  );

  const req = buildClusterRequest(many);
  assert.equal(req.shouldRequest, true);
  assert.equal(req.items.length, 120);
  assert.equal(req.items[0].id, 'id_0');
  assert.equal(req.items[0].myPhrase.length, 200);
  assert.equal(req.items[0].naturalPhrase.length, 200);
  assert.equal(req.items[0].reason.length, 300);
});

test('buildClusterRequest: drops source="qa", keeps call/keep_import/transcript_analysis/omitted, updates shouldRequest', () => {
  const mixed = buildClusterRequest([
    { id: 'qa1', myPhrase: 'I go yesterday', naturalPhrase: 'I went yesterday', reason: 'tense', status: 'reviewing', source: 'qa' },
    { id: 'c1', myPhrase: 'a', naturalPhrase: 'b', reason: 'r', status: 'reviewing', source: 'call' },
    { id: 'k1', myPhrase: 'c', naturalPhrase: 'd', reason: 'r', status: 'reviewing', source: 'keep_import' },
    { id: 't1', myPhrase: 'e', naturalPhrase: 'f', reason: 'r', status: 'reviewing', source: 'transcript_analysis' },
    { id: 'u1', myPhrase: 'g', naturalPhrase: 'h', reason: 'r', status: 'reviewing' },
  ]);
  assert.deepEqual(
    mixed.items.map((item) => item.id),
    ['c1', 'k1', 't1', 'u1']
  );
  assert.equal(mixed.shouldRequest, true);

  const qaAndOne = buildClusterRequest([
    { id: 'qa1', myPhrase: 'I go yesterday', naturalPhrase: 'I went yesterday', reason: 'tense', status: 'reviewing', source: 'qa' },
    { id: 'c1', myPhrase: 'a', naturalPhrase: 'b', reason: 'r', status: 'reviewing', source: 'call' },
  ]);
  assert.deepEqual(
    qaAndOne.items.map((item) => item.id),
    ['c1']
  );
  assert.equal(qaAndOne.shouldRequest, false);
});

test('pickDisplayClusters: handles null/disabled/empty, filters size < 2, caps top 3', () => {
  assert.deepEqual(pickDisplayClusters(null), []);
  assert.deepEqual(
    pickDisplayClusters({
      ok: true,
      enabled: false,
      clusters: [],
      disabledReason: 'no_key',
      usage: { inputTokens: 0, outputTokens: 0, sieEmbeddingTokens: 0 },
    }),
    []
  );
  assert.deepEqual(
    pickDisplayClusters({
      ok: true,
      enabled: true,
      clusters: [],
      usage: { inputTokens: 0, outputTokens: 0, sieEmbeddingTokens: 0 },
    }),
    []
  );

  const clusters = [
    { key: 'k_small', name: '소형', description: '', memberIds: ['a'], size: 1 },
    { key: 'k1', name: '1', description: '', memberIds: ['a', 'b'], size: 2 },
    { key: 'k2', name: '2', description: '', memberIds: ['c', 'd'], size: 2 },
    { key: 'k3', name: '3', description: '', memberIds: ['e', 'f'], size: 2 },
    { key: 'k4', name: '4', description: '', memberIds: ['g', 'h'], size: 2 },
  ];
  const picked = pickDisplayClusters({
    ok: true,
    enabled: true,
    clusters,
    usage: { inputTokens: 0, outputTokens: 0, sieEmbeddingTokens: 0 },
  });
  assert.deepEqual(
    picked.map((c) => c.key),
    ['k1', 'k2', 'k3']
  );
});
