import { createHash } from 'crypto';

export const EMBED_TEXT_VERSION = 2;
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

export type ClusterSkipReason = 'truncated' | 'too_short' | 'non_english';

/**
 * Short English function words and frequent learner-mistake verbs.
 * Used only to decide whether a short original looks like English (not a lexicon for scoring).
 */
const ENGLISH_COMMON = new Set([
  'i', "i'm", "i've", "i'd", "i'll", 'im', 'ive', 'id', 'ill',
  'me', 'my', 'mine', 'myself',
  'you', 'your', "you're", "you've", "you'd", "you'll", 'yourself',
  'we', "we're", "we've", "we'd", "we'll", 'us', 'our', 'ours', 'ourselves',
  'they', 'them', 'their', 'theirs', "they're", "they've", 'themselves',
  'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself',
  'it', "it's", 'its', 'itself',
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', "don't", "doesn't", "didn't", 'dont', 'doesnt', 'didnt',
  'have', 'has', 'had', "haven't", "hasn't", "hadn't",
  'go', 'goes', 'went', 'gone', 'going',
  'get', 'gets', 'got', 'gotten', 'getting',
  'buy', 'buys', 'bought', 'buying', 'use', 'uses', 'used', 'using',
  'make', 'makes', 'made', 'making',
  'take', 'takes', 'took', 'taken', 'taking',
  'come', 'comes', 'came', 'coming',
  'see', 'sees', 'saw', 'seen', 'seeing',
  'know', 'knows', 'knew', 'known',
  'think', 'thinks', 'thought',
  'want', 'wants', 'wanted', 'need', 'needs', 'needed',
  'say', 'says', 'said', 'tell', 'tells', 'told',
  'can', 'could', 'will', 'would', 'should', 'shall', 'may', 'might', 'must',
  'not', 'no', 'yes', 'please', 'thanks', 'thank', 'sorry',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'if', 'or', 'and', 'but',
  'so', 'than', 'then', 'too', 'very', 'just', 'also', 'about', 'into', 'over', 'after', 'before',
  'let', "let's", 'lets', 'ok', 'okay',
  'what', 'when', 'where', 'why', 'who', 'which', 'how',
  'there', 'here', 'now', 'today', 'yesterday', 'tomorrow',
]);

export function cleanEmbeddingField(raw: string | undefined, maxLen: number): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, maxLen);
}

export function buildEmbeddingText(item: EmbeddingTextInput): string {
  const wrong = cleanEmbeddingField(item.myPhrase, MY_PHRASE_MAX_LEN);
  const correct = cleanEmbeddingField(item.naturalPhrase, NATURAL_PHRASE_MAX_LEN);
  const why = cleanEmbeddingField(item.reason, REASON_MAX_LEN);
  return `Instruct: Identify the type of English grammar or usage error in this learner mistake. Ignore the sentence topic; focus on the error pattern (tense, agreement, preposition, article, word choice, politeness, etc.).\nQuery: wrong: ${wrong} | correct: ${correct} | why: ${why}`;
}

export function tokenizeForClusterFilter(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []);
}

/**
 * Drop junk before embedding: truncated transcript fragments, very short originals,
 * and short non-English phrases (e.g. Spanish "A ver."). Keeps short English mistakes like "I go".
 */
export function isClusterableMistake(item: { myPhrase: string; naturalPhrase?: string }): { ok: true } | { ok: false; reason: ClusterSkipReason } {
  const raw = (item.myPhrase ?? '').trim();
  if (!raw) return { ok: false, reason: 'too_short' };

  const tokens = tokenizeForClusterFilter(raw);
  if (tokens.length === 0) return { ok: false, reason: 'too_short' };

  const last = tokens[tokens.length - 1];
  const endsWithSentencePunct = /[.?!…]$/.test(raw);
  const lastIsLoneLetter = /^[a-z]$/.test(last);
  const lastIsAllowlistedSingle = last === 'i' || last === 'a';
  // Mid-word cut: "while discussing o", hanging hyphen "inter-". A trailing digit ("wrong 3") is not a cut.
  if ((lastIsLoneLetter && !lastIsAllowlistedSingle && !endsWithSentencePunct) || /[A-Za-z]-$/.test(raw)) {
    return { ok: false, reason: 'truncated' };
  }

  const longTokens = tokens.filter((t) => t.length >= 2);
  const englishLong = longTokens.filter((t) => ENGLISH_COMMON.has(t));
  const hasLongLatin = tokens.some((t) => t.length >= 4);

  // "I buy" / "She have": pronoun + another word is a short English learner mistake,
  // even if the verb is not in the small common-word list. "A ver." stays out (article, not subject).
  const SUBJECT_PRONOUNS = new Set(['i', 'you', 'he', 'she', 'we', 'they', 'it']);
  const pronounPattern = SUBJECT_PRONOUNS.has(tokens[0]) && tokens.some((tok, i) => i > 0 && tok.length >= 2);
  if (englishLong.length === 0 && !hasLongLatin && !pronounPattern) {
    if (longTokens.length === 0) return { ok: false, reason: 'too_short' };
    return { ok: false, reason: 'non_english' };
  }

  return { ok: true };
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

function minPairwise(vectors: ArrayLike<number>[], a: number[], b: number[]): number {
  let min = Infinity;
  for (const i of a) {
    for (const j of b) {
      const s = cosine(vectors[i], vectors[j]);
      if (s < min) min = s;
    }
  }
  return min;
}

/**
 * Deterministic complete-linkage clustering: two groups merge only if every cross pair
 * has cosine >= threshold. This blocks single-linkage chains (A~B, B~C, A!~C).
 * Clusters are sorted by size desc, then by first member's input index asc.
 * Members inside a cluster stay in input-index order.
 */
export function clusterBySimilarity(
  vectors: ArrayLike<number>[],
  threshold = CLUSTER_SIM_THRESHOLD
): number[][] {
  const n = vectors.length;
  if (n === 0) return [];

  const groups: number[][] = Array.from({ length: n }, (_, i) => [i]);

  while (groups.length > 1) {
    let bestI = -1;
    let bestJ = -1;
    let bestSim = -Infinity;
    let bestFirst = Infinity;
    let bestSecond = Infinity;

    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const sim = minPairwise(vectors, groups[i], groups[j]);
        if (sim < threshold) continue;
        const first = Math.min(groups[i][0], groups[j][0]);
        const second = Math.max(groups[i][0], groups[j][0]);
        const better =
          sim > bestSim + 1e-12 ||
          (Math.abs(sim - bestSim) <= 1e-12 && (first < bestFirst || (first === bestFirst && second < bestSecond)));
        if (better) {
          bestSim = sim;
          bestI = i;
          bestJ = j;
          bestFirst = first;
          bestSecond = second;
        }
      }
    }

    if (bestI < 0) break;
    const merged = [...groups[bestI], ...groups[bestJ]].sort((a, b) => a - b);
    const next = groups.filter((_, idx) => idx !== bestI && idx !== bestJ);
    next.push(merged);
    groups.length = 0;
    groups.push(...next);
  }

  return groups
    .map((g) => [...g].sort((a, b) => a - b))
    .sort((a, b) => {
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
