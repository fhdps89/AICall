import { createHash } from 'crypto';

export const EMBED_TEXT_VERSION = 1;
export const CLUSTER_SIM_THRESHOLD = 0.80;
export const MAX_CLUSTER_ITEMS = 120;
export const MAX_NAMED_CLUSTERS = 8;
export const MY_PHRASE_MAX_LEN = 200;
export const NATURAL_PHRASE_MAX_LEN = 200;
export const REASON_MAX_LEN = 300;

export interface EmbeddingTextInput {
  myPhrase: string;
  naturalPhrase: string;
  reason?: string;
}

export function cleanEmbeddingField(raw: string | undefined, maxLen: number): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, maxLen);
}

export function buildEmbeddingText(item: EmbeddingTextInput): string {
  const wrong = cleanEmbeddingField(item.myPhrase, MY_PHRASE_MAX_LEN);
  const correct = cleanEmbeddingField(item.naturalPhrase, NATURAL_PHRASE_MAX_LEN);
  const why = cleanEmbeddingField(item.reason, REASON_MAX_LEN);
  return `Instruct: Identify the English grammar or usage error pattern in this learner mistake.\nQuery: wrong: ${wrong} | correct: ${correct} | why: ${why}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function clusterKey(memberIds: string[]): string {
  const sorted = [...memberIds].sort();
  return sha256Hex(JSON.stringify(sorted)).slice(0, 16);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} !== ${b.length}`);
  }
  if (a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Deterministic single-linkage clustering via union-find (cos >= threshold).
 * Clusters are sorted by size desc, then by first member's input index asc.
 */
export function clusterBySimilarity(
  vectors: ArrayLike<number>[],
  threshold = CLUSTER_SIM_THRESHOLD
): number[][] {
  const n = vectors.length;
  if (n === 0) return [];

  const parent = new Int32Array(n);
  const rank = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };

  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) parent[ra] = rb;
    else if (rank[ra] > rank[rb]) parent[rb] = ra;
    else {
      parent[rb] = ra;
      rank[ra]++;
    }
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosine(vectors[i], vectors[j]) >= threshold) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let list = groups.get(root);
    if (!list) {
      list = [];
      groups.set(root, list);
    }
    list.push(i);
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return a[0] - b[0];
  });
}

export function encodeVecBase64(vec: ArrayLike<number>): string {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

export function decodeVecBase64(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) {
    throw new Error('Invalid base64 Float32 vector');
  }
  const out = new Float32Array(buf.byteLength / 4);
  new Uint8Array(out.buffer).set(buf);
  return out;
}
