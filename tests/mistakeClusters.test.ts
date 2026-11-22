import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EMBEDDING_MODEL } from '../src/config/models.ts';
import {
  CLUSTER_SIM_THRESHOLD,
  EMBED_TEXT_VERSION,
  buildEmbeddingText,
  clusterBySimilarity,
  clusterKey,
  findOverlappingNameEntry,
  jaccard,
  cosine,
  decodeVecBase64,
  encodeVecBase64,
  isClusterableMistake,
} from '../server/clusterMath.ts';
import { embedTexts } from '../server/sieEmbeddings.ts';
import {
  clusterCachePath,
  computeMistakeClusters,
  type ClusterRequestItem,
} from '../server/mistakeClusters.ts';

const DUMMY_KEY = 'test-sie-key';

function makeJsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aicall-clusters-'));
}

// ---------------------------------------------------------------------------
// A. Pure clusterMath tests
// ---------------------------------------------------------------------------

test('cosine: identical vectors -> 1', () => {
  const v = [0.3, -0.7, 1.2, 0.5];
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-9);
});

test('cosine: orthogonal -> 0, zero vector -> 0 (not NaN)', () => {
  assert.equal(cosine([1, 0, 0], [0, 1, 0]), 0);
  assert.equal(cosine([0, 0, 0], [1, 2, 3]), 0);
  assert.equal(cosine([0, 0, 0], [0, 0, 0]), 0);
  assert.ok(!Number.isNaN(cosine([0, 0], [0, 0])));
});

test('cluster: empty list -> []', () => {
  assert.deepEqual(clusterBySimilarity([]), []);
});

test('cluster: single item -> one singleton', () => {
  assert.deepEqual(clusterBySimilarity([[1, 0, 0]]), [[0]]);
});

test('cluster: two similar (cos >= T) -> one cluster with member indices in input order', () => {
  const res = clusterBySimilarity([
    [1, 0],
    [0.95, 0.1],
  ]);
  assert.deepEqual(res, [[0, 1]]);
});

test('cluster: exactly at threshold merges', () => {
  const t = CLUSTER_SIM_THRESHOLD;
  const v0 = [1, 0];
  const v1 = [t, Math.sqrt(1 - t * t)];
  assert.ok(Math.abs(cosine(v0, v1) - t) < 1e-12);
  assert.deepEqual(clusterBySimilarity([v0, v1]), [[0, 1]]);
});

test('cluster: just below threshold stays separate', () => {
  const below = CLUSTER_SIM_THRESHOLD - 1e-6;
  const v0 = [1, 0];
  const v1 = [below, Math.sqrt(1 - below * below)];
  assert.deepEqual(clusterBySimilarity([v0, v1]), [[0], [1]]);
});

test('cluster: complete-linkage does not chain A~B, B~C when A!~C', () => {
  // Angle between A and B: 30 deg (cos ~ 0.866 >= 0.80)
  // Angle between B and C: 30 deg (cos ~ 0.866 >= 0.80)
  // Angle between A and C: 60 deg (cos = 0.5 < 0.80)
  const a = [1, 0];
  const b = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
  const c = [Math.cos(Math.PI / 3), Math.sin(Math.PI / 3)];
  assert.ok(cosine(a, b) >= CLUSTER_SIM_THRESHOLD);
  assert.ok(cosine(b, c) >= CLUSTER_SIM_THRESHOLD);
  assert.ok(cosine(a, c) < CLUSTER_SIM_THRESHOLD);
  const res = clusterBySimilarity([a, b, c]);
  // A and C cannot share a cluster. Closest pair (A,B) merges; C stays alone.
  assert.deepEqual(res, [[0, 1], [2]]);
});

test('cluster: order sorted by size desc, then first index; member sets invariant to input shuffle', () => {
  const g1 = [1, 0, 0];
  const g2 = [0, 1, 0];
  const g3 = [0, 0, 1];
  const vectors = [g1, g2, g2, g3, g3, g3];
  const clusters = clusterBySimilarity(vectors);
  assert.deepEqual(clusters, [
    [3, 4, 5],
    [1, 2],
    [0],
  ]);

  // Same items with IDs shuffled produce identical member ID sets
  const labeled = [
    { id: 'a1', vec: g1 },
    { id: 'b1', vec: g2 },
    { id: 'b2', vec: g2 },
    { id: 'c1', vec: g3 },
    { id: 'c2', vec: g3 },
    { id: 'c3', vec: g3 },
  ];
  const reversed = [...labeled].reverse();
  const forwardSets = clusterBySimilarity(labeled.map((x) => x.vec)).map((idxs) =>
    idxs.map((i) => labeled[i].id).sort()
  );
  const reverseSets = clusterBySimilarity(reversed.map((x) => x.vec)).map((idxs) =>
    idxs.map((i) => reversed[i].id).sort()
  );
  assert.deepEqual(forwardSets, reverseSets);
});

test('cluster: threshold constant is pinned to 0.80', () => {
  assert.equal(CLUSTER_SIM_THRESHOLD, 0.80);
});

test('buildEmbeddingText: labeled format, whitespace collapse & 200/200/300 truncation', () => {
  assert.equal(EMBED_TEXT_VERSION, 2);
  const longWrong = 'a'.repeat(250);
  const longCorrect = 'b'.repeat(250);
  const longWhy = 'c'.repeat(350);
  const text = buildEmbeddingText({
    myPhrase: `  ${longWrong}   extra `,
    naturalPhrase: ` ${longCorrect} `,
    reason: `  ${longWhy} `,
  });
  assert.ok(text.startsWith('Instruct: Identify the type of English grammar or usage error'));
  assert.ok(text.includes('\nQuery: wrong: '));
  assert.ok(text.includes(' | correct: '));
  assert.ok(text.includes(' | why: '));
  assert.ok(text.includes(`wrong: ${'a'.repeat(200)} |`));
  assert.ok(text.includes(`correct: ${'b'.repeat(200)} |`));
  assert.ok(text.endsWith(`why: ${'c'.repeat(300)}`));

  const spaced = buildEmbeddingText({
    myPhrase: '  I   go  yesterday ',
    naturalPhrase: ' I  went  yesterday ',
    reason: ' 과거   시제 ',
  });
  assert.ok(spaced.includes('wrong: I go yesterday | correct: I went yesterday | why: 과거 시제'));
});


test('isClusterableMistake: drops truncated fragments, short non-English, keeps short English mistakes', () => {
  assert.deepEqual(isClusterableMistake({ myPhrase: "while discussing o" }), { ok: false, reason: 'truncated' });
  assert.deepEqual(isClusterableMistake({ myPhrase: 'inter-' }), { ok: false, reason: 'truncated' });
  assert.deepEqual(isClusterableMistake({ myPhrase: 'A ver.' }), { ok: false, reason: 'non_english' });
  assert.deepEqual(isClusterableMistake({ myPhrase: '' }), { ok: false, reason: 'too_short' });
  assert.deepEqual(isClusterableMistake({ myPhrase: '??' }), { ok: false, reason: 'too_short' });
  assert.equal(isClusterableMistake({ myPhrase: 'I go' }).ok, true);
  assert.equal(isClusterableMistake({ myPhrase: 'I buy' }).ok, true);
  assert.equal(isClusterableMistake({ myPhrase: 'I want a' }).ok, true);
  // Known limit: a longer non-English phrase with a 4+ letter token is kept.
  assert.equal(isClusterableMistake({ myPhrase: 'Yo tengo hambre' }).ok, true);
  assert.equal(isClusterableMistake({ myPhrase: 'He go yesterday' }).ok, true);
  assert.equal(isClusterableMistake({ myPhrase: 'Can you fix it?' }).ok, true);
  assert.equal(isClusterableMistake({ myPhrase: "recieve the package" }).ok, true);
  assert.equal(isClusterableMistake({ myPhrase: 'much cheaper than now' }).ok, true);
  assert.equal(isClusterableMistake({ myPhrase: 'I go 1' }).ok, true);
  assert.equal(isClusterableMistake({ myPhrase: 'wrong 3' }).ok, true);
});

test('clusterKey: stable regardless of member order', () => {
  const k1 = clusterKey(['m3', 'm1', 'm2']);
  const k2 = clusterKey(['m2', 'm3', 'm1']);
  assert.equal(k1, k2);
  assert.equal(k1.length, 16);
  assert.notEqual(k1, clusterKey(['m1', 'm2']));
});

test('vec base64 roundtrip preserves Float32 values', () => {
  const orig = new Float32Array([0.125, -0.5, 1.75, 0, -3.25]);
  const b64 = encodeVecBase64(orig);
  const decoded = decodeVecBase64(b64);
  assert.equal(decoded.length, orig.length);
  for (let i = 0; i < orig.length; i++) {
    assert.equal(decoded[i], orig[i]);
  }
});

// ---------------------------------------------------------------------------
// B. SIE client tests (injected fetch & sleep)
// ---------------------------------------------------------------------------

test('sie: sends Bearer, JSON accept, model, input array', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;

  const res = await embedTexts(['hello', 'world'], {
    apiKey: DUMMY_KEY,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return makeJsonResponse(200, {
        object: 'list',
        model: EMBEDDING_MODEL,
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 1, embedding: [0, 1] },
        ],
        usage: { prompt_tokens: 12 },
      });
    }) as typeof fetch,
  });

  assert.equal(res.ok, true);
  assert.equal(capturedUrl, 'https://api.superlinked.com/v1/embeddings');
  assert.equal(capturedInit?.method, 'POST');
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${DUMMY_KEY}`);
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers.Accept, 'application/json');
  const parsedBody = JSON.parse(String(capturedInit?.body));
  assert.equal(parsedBody.model, EMBEDDING_MODEL);
  assert.deepEqual(parsedBody.input, ['hello', 'world']);
});

test('sie: 503 with Retry-After 1 then 200 -> one retry', async () => {
  let fetchCalls = 0;
  const sleeps: number[] = [];

  const res = await embedTexts(['a'], {
    apiKey: DUMMY_KEY,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    logger: () => {},
    fetchImpl: (async () => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return makeJsonResponse(503, { error: 'loading' }, { 'Retry-After': '1' });
      }
      return makeJsonResponse(200, {
        data: [{ index: 0, embedding: [0.5, 0.5] }],
        usage: { prompt_tokens: 5 },
      });
    }) as typeof fetch,
  });

  assert.equal(fetchCalls, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.promptTokens, 5);
});

test('sie: 429 with Retry-After 120 -> no retry, unavailable', async () => {
  let fetchCalls = 0;
  let sleepCalls = 0;

  const res = await embedTexts(['a'], {
    apiKey: DUMMY_KEY,
    sleep: async () => {
      sleepCalls++;
    },
    logger: () => {},
    fetchImpl: (async () => {
      fetchCalls++;
      return makeJsonResponse(429, { error: 'rate' }, { 'Retry-After': '120' });
    }) as typeof fetch,
  });

  assert.equal(fetchCalls, 1);
  assert.equal(sleepCalls, 0);
  assert.deepEqual(res, { ok: false, reason: 'unavailable', promptTokens: 0 });
});

test('sie: 503 without Retry-After -> no retry', async () => {
  let fetchCalls = 0;
  const res = await embedTexts(['a'], {
    apiKey: DUMMY_KEY,
    logger: () => {},
    fetchImpl: (async () => {
      fetchCalls++;
      return makeJsonResponse(503, { error: 'loading' });
    }) as typeof fetch,
  });
  assert.equal(fetchCalls, 1);
  assert.deepEqual(res, { ok: false, reason: 'unavailable', promptTokens: 0 });
});

test('sie: retry also fails -> unavailable (exactly 2 fetches)', async () => {
  let fetchCalls = 0;
  const res = await embedTexts(['a'], {
    apiKey: DUMMY_KEY,
    sleep: async () => {},
    logger: () => {},
    fetchImpl: (async () => {
      fetchCalls++;
      return makeJsonResponse(503, { error: 'still loading' }, { 'Retry-After': '1' });
    }) as typeof fetch,
  });
  assert.equal(fetchCalls, 2);
  assert.deepEqual(res, { ok: false, reason: 'unavailable', promptTokens: 0 });
});

test('sie: timeout aborts quickly', async () => {
  const start = Date.now();
  const res = await embedTexts(['a'], {
    apiKey: DUMMY_KEY,
    timeoutMs: 20,
    logger: () => {},
    fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch,
  });
  const elapsed = Date.now() - start;
  assert.deepEqual(res, { ok: false, reason: 'timeout', promptTokens: 0 });
  assert.ok(elapsed < 1000, `Expected < 1000ms, got ${elapsed}ms`);
});

test('sie: malformed responses -> bad_response', async () => {
  const badBodies = [
    { usage: { prompt_tokens: 1 } }, // missing data
    { data: [{ index: 0, embedding: [1, 2] }] }, // count mismatch for 2 inputs
    {
      data: [
        { index: 0, embedding: [1, Number.NaN] },
        { index: 1, embedding: [1, 2] },
      ],
    }, // NaN (via custom response)
    {
      data: [
        { index: 0, embedding: [1, 2] },
        { index: 1, embedding: [1, 2, 3] },
      ],
    }, // dimension mismatch
  ];

  for (let i = 0; i < badBodies.length; i++) {
    const payload = badBodies[i];
    const res = await embedTexts(['a', 'b'], {
      apiKey: DUMMY_KEY,
      logger: () => {},
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => payload,
      })) as unknown as typeof fetch,
    });
    assert.deepEqual(res, { ok: false, reason: 'bad_response', promptTokens: 0 }, `subcase ${i}`);
  }
});

test('sie: out-of-order index is reordered', async () => {
  const res = await embedTexts(['first', 'second'], {
    apiKey: DUMMY_KEY,
    fetchImpl: (async () =>
      makeJsonResponse(200, {
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
        usage: { prompt_tokens: 10 },
      })) as typeof fetch,
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.vectors[0][0], 1);
    assert.equal(res.vectors[0][1], 0);
    assert.equal(res.vectors[1][0], 0);
    assert.equal(res.vectors[1][1], 1);
  }
});

test('sie: batches of 32 and sums prompt_tokens', async () => {
  const texts = Array.from({ length: 70 }, (_, i) => `item-${i}`);
  const batchSizes: number[] = [];

  const res = await embedTexts(texts, {
    apiKey: DUMMY_KEY,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      batchSizes.push(body.input.length);
      return makeJsonResponse(200, {
        data: body.input.map((_: string, idx: number) => ({
          index: idx,
          embedding: [1, idx],
        })),
        usage: { prompt_tokens: body.input.length * 10 },
      });
    }) as typeof fetch,
  });

  assert.deepEqual(batchSizes, [32, 32, 6]);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.vectors.length, 70);
    assert.equal(res.promptTokens, 700);
  }
});

test('sie: error log contains no auth header or key', async () => {
  const logs: string[] = [];
  await embedTexts(['secret learner text'], {
    apiKey: DUMMY_KEY,
    logger: (m) => logs.push(m),
    fetchImpl: (async () =>
      makeJsonResponse(
        429,
        { error: 'rate limit' },
        { 'X-SIE-Error-Code': 'RATE_LIMIT', 'Retry-After': '120' }
      )) as typeof fetch,
  });

  assert.ok(logs.length > 0);
  const joined = logs.join('\n');
  assert.equal(joined.includes('Bearer'), false);
  assert.equal(joined.includes(DUMMY_KEY), false);
  assert.equal(joined.includes('secret learner text'), false);
  assert.ok(joined.includes('429'));
  assert.ok(joined.includes('RATE_LIMIT'));
});

// ---------------------------------------------------------------------------
// C. Cache & orchestration tests (temp DATA_DIR, stub fetch & naming)
// ---------------------------------------------------------------------------

function makeItem(id: string, myPhrase?: string, naturalPhrase?: string, reason = '시제'): ClusterRequestItem {
  return {
    id,
    myPhrase: myPhrase ?? `I go ${id}`,
    naturalPhrase: naturalPhrase ?? `I went ${id}`,
    reason,
  };
}

/** Unique, clusterable English stand-in so short fixture tags are not dropped by isClusterableMistake. */
function en(tag: string): string {
  return `I go ${tag} today`;
}

test('no key -> enabled:false no_key, fetch not called', async () => {
  const tmp = makeTempDir();
  let fetchCalls = 0;
  try {
    const res = await computeMistakeClusters(
      {
        apiKey: '',
        dataDir: tmp,
        fetchImpl: (async () => {
          fetchCalls++;
          return makeJsonResponse(200, {});
        }) as typeof fetch,
      },
      'user-1',
      [makeItem('1', en('a'), en('b'), 'r'), makeItem('2', en('c'), en('d'), 'r')]
    );
    assert.equal(fetchCalls, 0);
    assert.deepEqual(res, {
      ok: true,
      enabled: false,
      clusters: [],
      disabledReason: 'no_key',
      usage: { inputTokens: 0, outputTokens: 0, sieEmbeddingTokens: 0 },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fewer than 2 items -> too_few, fetch not called (0 and 1 items)', async () => {
  const tmp = makeTempDir();
  let fetchCalls = 0;
  const fetchStub = (async () => {
    fetchCalls++;
    return makeJsonResponse(200, {});
  }) as typeof fetch;

  try {
    for (const list of [[], [makeItem('1', en('a'), en('b'), 'r')]]) {
      const res = await computeMistakeClusters(
        { apiKey: DUMMY_KEY, dataDir: tmp, fetchImpl: fetchStub },
        'user-1',
        list
      );
      assert.equal(fetchCalls, 0);
      assert.equal(res.enabled, false);
      if (!res.enabled) assert.equal(res.disabledReason, 'too_few');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('junk originals are dropped before SIE; remaining English mistakes still cluster', async () => {
  const tmp = makeTempDir();
  const seenInputs: string[][] = [];
  const fetchStub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { input?: string[] };
    seenInputs.push(body.input || []);
    const vecs = (body.input || []).map((_, i) => ({
      index: i,
      embedding: i === 0 ? [1, 0] : [0.99, 0.01],
    }));
    return makeJsonResponse(200, { data: vecs, usage: { prompt_tokens: body.input?.length || 0 } });
  }) as typeof fetch;

  try {
    const res = await computeMistakeClusters(
      {
        apiKey: DUMMY_KEY,
        dataDir: tmp,
        logger: () => {},
        fetchImpl: fetchStub,
        generateClusterNames: async (clusters) => ({
          items: clusters.map((c) => ({ key: c.key, name: '과거시제 오류', description: '시제를 빠뜨림' })),
          inputTokens: 1,
          outputTokens: 1,
        }),
      },
      'user-junk',
      [
        makeItem('junk-es', 'A ver.', "Let's see.", 'filler'),
        makeItem('junk-cut', 'while discussing o', 'while discussing it', 'cut'),
        makeItem('m1', 'I go yesterday', 'I went yesterday', '시제'),
        makeItem('m2', 'She go to school', 'She went to school', '시제'),
      ]
    );
    assert.equal(res.enabled, true);
    assert.equal(seenInputs.length, 1);
    assert.equal(seenInputs[0].length, 2);
    assert.ok(seenInputs[0].every((text) => text.includes('wrong: I go') || text.includes('wrong: She go')));
    assert.ok(res.ok && res.enabled && res.clusters.length === 1);
    if (res.ok && res.enabled) {
      assert.deepEqual(res.clusters[0].memberIds.sort(), ['m1', 'm2']);
      assert.equal(res.clusters[0].size, 2);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('only junk leftovers after filter -> enabled with empty clusters, no SIE call', async () => {
  const tmp = makeTempDir();
  let fetchCalls = 0;
  try {
    const res = await computeMistakeClusters(
      {
        apiKey: DUMMY_KEY,
        dataDir: tmp,
        fetchImpl: (async () => {
          fetchCalls++;
          return makeJsonResponse(200, {});
        }) as typeof fetch,
      },
      'user-junk-only',
      [
        makeItem('j1', 'A ver.', "Let's see.", 'es'),
        makeItem('j2', 'while discussing o', 'while discussing it', 'cut'),
      ]
    );
    assert.equal(fetchCalls, 0);
    assert.equal(res.enabled, true);
    assert.deepEqual(res.clusters, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('same id + same text embeds once; second call hits cache with 0 SIE tokens', async () => {
  const tmp = makeTempDir();
  let fetchCalls = 0;
  let namingCalls = 0;
  const items = [
    makeItem('m1', 'I go yesterday', 'I went yesterday', '시제'),
    makeItem('m2', 'She eat lunch', 'She ate lunch', '시제'),
  ];

  const deps = {
    apiKey: DUMMY_KEY,
    dataDir: tmp,
    fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
      fetchCalls++;
      const body = JSON.parse(String(init?.body));
      return makeJsonResponse(200, {
        data: body.input.map((_: string, idx: number) => ({ index: idx, embedding: [1, 0] })),
        usage: { prompt_tokens: 40 },
      });
    }) as typeof fetch,
    generateClusterNames: async (clusters: Array<{ key: string }>) => {
      namingCalls++;
      return {
        items: clusters.map((c) => ({ key: c.key, name: '과거 시제', description: '과거형 동사 실수' })),
        inputTokens: 100,
        outputTokens: 20,
      };
    },
  };

  try {
    const first = await computeMistakeClusters(deps, 'user-1', items);
    assert.equal(first.enabled, true);
    assert.equal(fetchCalls, 1);
    assert.equal(namingCalls, 1);
    assert.equal(first.usage.sieEmbeddingTokens, 40);

    const second = await computeMistakeClusters(deps, 'user-1', items);
    assert.equal(second.enabled, true);
    assert.equal(fetchCalls, 1);
    assert.equal(namingCalls, 1);
    assert.equal(second.usage.sieEmbeddingTokens, 0);
    assert.equal(second.usage.inputTokens, 0);
    assert.equal(second.usage.outputTokens, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('same id, changed text -> only that id re-embedded', async () => {
  const tmp = makeTempDir();
  const seenBatchLengths: number[] = [];
  const deps = {
    apiKey: DUMMY_KEY,
    dataDir: tmp,
    fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seenBatchLengths.push(body.input.length);
      return makeJsonResponse(200, {
        data: body.input.map((_: string, idx: number) => ({ index: idx, embedding: [1, 0] })),
        usage: { prompt_tokens: body.input.length * 10 },
      });
    }) as typeof fetch,
    generateClusterNames: async (clusters: Array<{ key: string }>) => ({
      items: clusters.map((c) => ({ key: c.key, name: '시제', description: '' })),
      inputTokens: 10,
      outputTokens: 5,
    }),
  };

  try {
    await computeMistakeClusters(deps, 'user-1', [
      makeItem('m1', 'I go', 'I went', '시제'),
      makeItem('m2', 'I see', 'I saw', '시제'),
    ]);
    await computeMistakeClusters(deps, 'user-1', [
      makeItem('m1', 'I go', 'I went', '시제'),
      makeItem('m2', 'I buy', 'I bought', '시제'),
    ]);
    assert.deepEqual(seenBatchLengths, [2, 1]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('model or textVersion change in cache invalidates and re-embeds', async () => {
  const tmp = makeTempDir();
  let fetchCalls = 0;
  const items = [
    makeItem('m1', en('a'), en('b'), 'r'),
    makeItem('m2', en('c'), en('d'), 'r'),
  ];
  const deps = {
    apiKey: DUMMY_KEY,
    dataDir: tmp,
    fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
      fetchCalls++;
      const body = JSON.parse(String(init?.body));
      return makeJsonResponse(200, {
        data: body.input.map((_: string, idx: number) => ({ index: idx, embedding: [1, 0] })),
        usage: { prompt_tokens: 10 },
      });
    }) as typeof fetch,
  };

  try {
    await computeMistakeClusters(deps, 'user-1', items);
    assert.equal(fetchCalls, 1);

    const filePath = clusterCachePath('user-1', tmp);
    const cache = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    cache.embeddings.m1.model = 'other-model';
    cache.embeddings.m2.textVersion = 999;
    fs.writeFileSync(filePath, JSON.stringify(cache));

    await computeMistakeClusters(deps, 'user-1', items);
    assert.equal(fetchCalls, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removed ids pruned from cache file and cache filename hides raw uid', async () => {
  const tmp = makeTempDir();
  const uid = 'secret-raw-uid-123';
  const deps = {
    apiKey: DUMMY_KEY,
    dataDir: tmp,
    fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return makeJsonResponse(200, {
        data: body.input.map((_: string, idx: number) => ({ index: idx, embedding: [1, 0] })),
        usage: { prompt_tokens: 10 },
      });
    }) as typeof fetch,
  };

  try {
    await computeMistakeClusters(deps, uid, [
      makeItem('m1', en('a'), en('b'), 'r'),
      makeItem('m2', en('c'), en('d'), 'r'),
      makeItem('m3', en('e'), en('f'), 'r'),
    ]);
    await computeMistakeClusters(deps, uid, [
      makeItem('m1', en('a'), en('b'), 'r'),
      makeItem('m3', en('e'), en('f'), 'r'),
    ]);

    const filePath = clusterCachePath(uid, tmp);
    assert.equal(path.basename(filePath).includes(uid), false);
    assert.match(path.basename(filePath), /^[0-9a-f]{64}\.json$/);

    const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.deepEqual(Object.keys(saved.embeddings).sort(), ['m1', 'm3']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('corrupt cache file -> treated empty, no throw, rewritten cleanly', async () => {
  const tmp = makeTempDir();
  try {
    const filePath = clusterCachePath('user-corrupt', tmp);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{corrupt json!!!', 'utf-8');

    const res = await computeMistakeClusters(
      {
        apiKey: DUMMY_KEY,
        dataDir: tmp,
        fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body));
          return makeJsonResponse(200, {
            data: body.input.map((_: string, idx: number) => ({ index: idx, embedding: [1, 0] })),
            usage: { prompt_tokens: 20 },
          });
        }) as typeof fetch,
      },
      'user-corrupt',
      [makeItem('m1', en('a'), en('b'), 'r'), makeItem('m2', en('c'), en('d'), 'r')]
    );

    assert.equal(res.enabled, true);
    const rewritten = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(rewritten.v, 1);
    assert.deepEqual(Object.keys(rewritten.embeddings).sort(), ['m1', 'm2']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('partial batch failure keeps earlier batches cached', async () => {
  const tmp = makeTempDir();
  const items = Array.from({ length: 35 }, (_, i) =>
    makeItem(`m${i}`, `wrong ${i}`, `right ${i}`, 'why')
  );
  const requestCounts: number[] = [];
  let failSecondBatch = true;

  const deps = {
    apiKey: DUMMY_KEY,
    dataDir: tmp,
    logger: () => {},
    fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requestCounts.push(body.input.length);
      if (failSecondBatch && body.input.length === 3) {
        return makeJsonResponse(500, { error: 'boom' });
      }
      return makeJsonResponse(200, {
        data: body.input.map((_: string, idx: number) => ({ index: idx, embedding: [1, 0] })),
        usage: { prompt_tokens: body.input.length },
      });
    }) as typeof fetch,
  };

  try {
    const first = await computeMistakeClusters(deps, 'user-batch', items);
    assert.equal(first.enabled, false);
    assert.equal(first.usage.sieEmbeddingTokens, 32);

    failSecondBatch = false;
    const second = await computeMistakeClusters(deps, 'user-batch', items);
    assert.equal(second.enabled, true);
    assert.deepEqual(requestCounts, [32, 3, 3]);
    assert.equal(second.usage.sieEmbeddingTokens, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('SIE failure -> enabled:false; Gemini naming not called', async () => {
  const tmp = makeTempDir();
  let namingCalls = 0;
  try {
    const res = await computeMistakeClusters(
      {
        apiKey: DUMMY_KEY,
        dataDir: tmp,
        logger: () => {},
        fetchImpl: (async () => makeJsonResponse(503, { error: 'down' })) as typeof fetch,
        generateClusterNames: async () => {
          namingCalls++;
          return { items: [], inputTokens: 0, outputTokens: 0 };
        },
      },
      'user-1',
      [makeItem('m1', en('a'), en('b'), 'r'), makeItem('m2', en('c'), en('d'), 'r')]
    );
    assert.equal(res.enabled, false);
    assert.equal(namingCalls, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('naming failure -> enabled:true with fallback titles (and not cached)', async () => {
  const tmp = makeTempDir();
  let namingCalls = 0;
  const deps = {
    apiKey: DUMMY_KEY,
    dataDir: tmp,
    logger: () => {},
    fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return makeJsonResponse(200, {
        data: body.input.map((_: string, idx: number) => ({ index: idx, embedding: [1, 0] })),
        usage: { prompt_tokens: 15 },
      });
    }) as typeof fetch,
    generateClusterNames: async () => {
      namingCalls++;
      throw new Error('Gemini unavailable');
    },
  };

  try {
    const first = await computeMistakeClusters(deps, 'user-1', [
      makeItem('m1', en('a'), en('b'), 'r'),
      makeItem('m2', en('c'), en('d'), 'r'),
    ]);
    assert.equal(first.enabled, true);
    if (first.enabled) {
      assert.equal(first.clusters.length, 1);
      assert.equal(first.clusters[0].name, '반복 실수 1');
      assert.equal(first.clusters[0].description, '');
    }

    // Fallback names were not cached, so naming is retried on next call
    await computeMistakeClusters(deps, 'user-1', [
      makeItem('m1', en('a'), en('b'), 'r'),
      makeItem('m2', en('c'), en('d'), 'r'),
    ]);
    assert.equal(namingCalls, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('naming cached per cluster key; overlapping membership reuses the name without a new Gemini call', async () => {
  const tmp = makeTempDir();
  const namedKeyBatches: string[][] = [];
  const vecByWrong: Record<string, number[]> = {
    a1: [1, 0],
    a2: [1, 0],
    a3: [1, 0],
    b1: [0, 1],
    b2: [0, 1],
  };

  const deps = {
    apiKey: DUMMY_KEY,
    dataDir: tmp,
    fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return makeJsonResponse(200, {
        data: body.input.map((t, idx) => {
          const match = /wrong: I go (\w+) today/.exec(t);
          const vec = (match && vecByWrong[match[1]]) || [1, 0];
          return { index: idx, embedding: vec };
        }),
        usage: { prompt_tokens: 10 },
      });
    }) as typeof fetch,
    generateClusterNames: async (clusters: Array<{ key: string }>) => {
      namedKeyBatches.push(clusters.map((c) => c.key));
      return {
        items: clusters.map((c) => ({ key: c.key, name: '패턴 이름', description: '설명' })),
        inputTokens: 50,
        outputTokens: 10,
      };
    },
  };

  try {
    const base = [
      makeItem('m1', en('a1'), en('right'), 'why'),
      makeItem('m2', en('a2'), en('right'), 'why'),
      makeItem('m3', en('b1'), en('right'), 'why'),
      makeItem('m4', en('b2'), en('right'), 'why'),
    ];
    await computeMistakeClusters(deps, 'user-1', base);
    assert.equal(namedKeyBatches.length, 1);
    assert.equal(namedKeyBatches[0].length, 2);

    // Same items -> 0 naming calls
    await computeMistakeClusters(deps, 'user-1', base);
    assert.equal(namedKeyBatches.length, 1);

    // Add a3 to cluster A: membership overlaps the cached set, so the name is reused
    // and Gemini is not called again.
    const withMember = await computeMistakeClusters(deps, 'user-1', [
      ...base,
      makeItem('m5', en('a3'), en('right'), 'why'),
    ]);
    assert.equal(namedKeyBatches.length, 1);
    assert.equal(withMember.clusters.find((c) => c.memberIds.includes('m5'))?.name, '패턴 이름');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('naming output validated: too-long name and unknown key fall back', async () => {
  const tmp = makeTempDir();
  try {
    const res = await computeMistakeClusters(
      {
        apiKey: DUMMY_KEY,
        dataDir: tmp,
        fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { input: string[] };
          return makeJsonResponse(200, {
            data: body.input.map((t, idx) => {
              const isB = /wrong: I go b/.test(t);
              return { index: idx, embedding: isB ? [0, 1] : [1, 0] };
            }),
            usage: { prompt_tokens: 10 },
          });
        }) as typeof fetch,
        generateClusterNames: async (clusters) => ({
          items: [
            { key: clusters[0].key, name: '가'.repeat(25), description: '너무 긴 이름' },
            { key: 'unknown-key', name: '정상 이름', description: '설명' },
          ],
          inputTokens: 20,
          outputTokens: 5,
        }),
      },
      'user-1',
      [
        makeItem('m1', en('a1'), en('right'), 'why'),
        makeItem('m2', en('a2'), en('right'), 'why'),
        makeItem('m3', en('b1'), en('right'), 'why'),
        makeItem('m4', en('b2'), en('right'), 'why'),
      ]
    );

    assert.equal(res.enabled, true);
    if (res.enabled) {
      assert.equal(res.clusters[0].name, '반복 실수 1');
      assert.equal(res.clusters[0].description, '');
      assert.equal(res.clusters[1].name, '반복 실수 2');
      assert.equal(res.clusters[1].description, '');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('response only includes size >= 2, max 8 clusters, no vectors; usage separates SIE and Gemini tokens', async () => {
  const tmp = makeTempDir();
  // Create 10 distinct clusters of size 2 + 1 singleton = 21 items
  const items: ClusterRequestItem[] = [];
  for (let g = 0; g < 10; g++) {
    items.push(makeItem(`g${g}_1`, en(`w${g}_1`), en('c'), 'r'));
    items.push(makeItem(`g${g}_2`, en(`w${g}_2`), en('c'), 'r'));
  }
  items.push(makeItem('single', en('ws'), en('c'), 'r'));

  try {
    const res = await computeMistakeClusters(
      {
        apiKey: DUMMY_KEY,
        dataDir: tmp,
        fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { input: string[] };
          return makeJsonResponse(200, {
            data: body.input.map((t, idx) => {
              const vec = new Array(11).fill(0);
              const m = /wrong: I go w(\d+)_/.exec(t);
              if (m) vec[Number(m[1])] = 1;
              else vec[10] = 1;
              return { index: idx, embedding: vec };
            }),
            usage: { prompt_tokens: 123 },
          });
        }) as typeof fetch,
        generateClusterNames: async (clusters) => ({
          items: clusters.map((c, i) => ({ key: c.key, name: `패턴 ${i + 1}`, description: '요약' })),
          inputTokens: 456,
          outputTokens: 78,
        }),
      },
      'user-1',
      items
    );

    assert.equal(res.enabled, true);
    if (res.enabled) {
      assert.equal(res.clusters.length, 8);
      for (const c of res.clusters) {
        assert.ok(c.size >= 2);
      }
      const serialized = JSON.stringify(res);
      assert.equal(serialized.includes('"vec"'), false);
      assert.equal(serialized.includes('"embedding"'), false);
      assert.deepEqual(res.usage, {
        inputTokens: 456,
        outputTokens: 78,
        sieEmbeddingTokens: 123,
      });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('jaccard and findOverlappingNameEntry reuse a name when most members overlap', () => {
  assert.equal(jaccard(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5);
  const names = {
    old: { name: '과거시제 누락', description: '동사 시제', memberIds: ['t1', 't2', 't3'] },
  };
  const hit = findOverlappingNameEntry(['t1', 't2', 't4'], names, 0.5);
  assert.equal(hit?.name, '과거시제 누락');
  assert.equal(findOverlappingNameEntry(['x'], names, 0.6), null);
});
