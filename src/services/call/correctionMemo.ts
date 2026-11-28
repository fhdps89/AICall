/**
 * In-call correction memo (EL-21).
 *
 * Live sliding-window compression (12k/6k) drops older turns, so the tutor can forget
 * corrections made earlier in the same call. This module keeps a short rolling list
 * extracted from the Live input/output transcripts (no extra model call) and formats
 * a compact note for re-injection.
 *
 * Official Live API (https://ai.google.dev/api/live, fetched 2026-11-28):
 * - BidiGenerateContentSetup is the first and only setup message and applies for the
 *   duration of the streaming RPC, so systemInstruction cannot be changed mid-session.
 * - SlidingWindow always keeps system instructions (and prefixTurns) at the start.
 * - clientContent is appended to history; turnComplete=false waits for more messages
 *   and does not start generation. Conversational Live models: clientContent interrupts
 *   *current generation*, so we only send it when the tutor's turn is complete.
 */

export interface CallCorrection {
  myPhrase: string;
  naturalPhrase: string;
  /** Optional 3-5 word hint (may be omitted). */
  rule?: string;
}

export const CORRECTION_MEMO_MAX_ITEMS = 8;
/** Character budget for the injected note (~200-300 tokens at ~4 chars/token). */
export const CORRECTION_MEMO_MAX_CHARS = 960;
export const CORRECTION_MEMO_HEADING =
  "[Call corrections — do not read this aloud. If the learner repeats an old form, use the correct one.]";

const MIN_PHRASE_LEN = 3;
const MAX_PHRASE_LEN = 120;

export function normalizePhrase(raw: string): string {
  return raw
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'\u300c\u300e]+|["'\u300d\u300f]+$/g, "")
    .trim()
    .toLowerCase();
}

function clipPhrase(raw: string): string | null {
  const t = raw.replace(/\s+/g, " ").trim();
  if (t.length < MIN_PHRASE_LEN) return null;
  if (t.length > MAX_PHRASE_LEN) return `${t.slice(0, MAX_PHRASE_LEN - 1).trim()}…`;
  return t;
}

function clipRule(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const words = raw
    .replace(/[()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 5);
  if (words.length === 0) return undefined;
  const s = words.join(" ");
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

function quotedSpans(text: string): string[] {
  const spans: string[] = [];
  const patterns = [
    /"([^"\n]{3,120})"/g,
    /'([^'\n]{3,120})'/g,
    /\u300c([^\u300d\n]{3,120})\u300d/g,
    /\u300e([^\u300f\n]{3,120})\u300f/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const t = m[1].replace(/\s+/g, " ").trim();
      if (t.length >= MIN_PHRASE_LEN) spans.push(t);
    }
  }
  return spans;
}

function pushPair(out: CallCorrection[], wrong: string, right: string, rule?: string): void {
  const myPhrase = clipPhrase(wrong);
  const naturalPhrase = clipPhrase(right);
  if (!myPhrase || !naturalPhrase) return;
  if (normalizePhrase(myPhrase) === normalizePhrase(naturalPhrase)) return;
  if (out.some(
    (x) =>
      normalizePhrase(x.myPhrase) === normalizePhrase(myPhrase) &&
      normalizePhrase(x.naturalPhrase) === normalizePhrase(naturalPhrase),
  )) {
    return;
  }
  out.push({ myPhrase, naturalPhrase, rule: clipRule(rule) });
}

/** Minimum tokens in the learner line (and in a recast candidate) to try a similarity match. */
export const RECAST_MIN_TOKENS = 3;
/** Token LCS/edit similarity bar for an unquoted recast (see tokenSimilarity). */
export const RECAST_MIN_SIMILARITY = 0.6;

const QUESTION_START =
  /^(did|do|does|are|is|am|was|were|can|could|would|will|shall|may|might|what|why|how|when|where|who|whom|which|whose)$/;

export function tokenizePhrase(raw: string): string[] {
  const n = normalizePhrase(raw)
    .replace(/[?!.,;:…。！？、]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!n) return [];
  return n.split(" ").filter(Boolean);
}

export function tokenLcsLength(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return 0;
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  return prev[m];
}

export function tokenEditDistance(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (!n) return m;
  if (!m) return n;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[n][m];
}

/** Token similarity in [0, 1]: min(LCS/maxLen, 1 - editDistance/maxLen). */
export function tokenSimilarity(a: string[], b: string[]): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  const lcsRatio = tokenLcsLength(a, b) / maxLen;
  const editSim = 1 - tokenEditDistance(a, b) / maxLen;
  return Math.min(lcsRatio, editSim);
}

function charSimilarity(a: string, b: string): number {
  const x = normalizePhrase(a);
  const y = normalizePhrase(b);
  const maxLen = Math.max(x.length, y.length);
  if (maxLen === 0) return 0;
  return 1 - tokenEditDistance([...x], [...y]) / maxLen;
}

function isContiguousSubsequence(small: string[], large: string[]): boolean {
  if (small.length === 0 || small.length > large.length) return false;
  for (let i = 0; i + small.length <= large.length; i++) {
    if (small.every((t, k) => t === large[i + k])) return true;
  }
  return false;
}

/** True when the tutor span is a recast of the learner line, not an echo. */
export function isRecastMatch(userText: string, candidate: string): boolean {
  const userTokens = tokenizePhrase(userText);
  const candTokens = tokenizePhrase(candidate);
  if (userTokens.length < RECAST_MIN_TOKENS || candTokens.length < RECAST_MIN_TOKENS) return false;
  if (candTokens.length === userTokens.length && candTokens.every((t, i) => t === userTokens[i])) return false;
  if (normalizePhrase(candidate) === normalizePhrase(userText)) return false;
  // A truncated copy of the same learner line (e.g. dropping "yesterday") is not a recast.
  if (isContiguousSubsequence(candTokens, userTokens)) return false;
  // Same line with a word stuck on the front or back is still an echo, not a recast.
  if (isContiguousSubsequence(userTokens, candTokens)) return false;
  const tok = tokenSimilarity(userTokens, candTokens);
  if (tok >= RECAST_MIN_SIMILARITY) return true;
  // Morphology like have/has, brother/brothers can sit just under 0.6 on short lines.
  return tok >= 0.5 && charSimilarity(userText, candidate) >= 0.8;
}

export function splitTutorSentences(text: string): string[] {
  const trimmed = (text || "").trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/(?<=[.!?。！？])\s+|\n+/);
  const out = parts.map((s) => s.trim()).filter((s) => s.length >= 3);
  return out.length ? out : [trimmed];
}

export function isQuestionSentence(sentence: string): boolean {
  const t = sentence.trim();
  if (!t) return false;
  if (/[?？]\s*$/.test(t)) return true;
  if (/(?:까|나요|가요|까요)\s*[.。]?\s*$/.test(t)) return true;
  const first = tokenizePhrase(t)[0] || "";
  return QUESTION_START.test(first);
}

function trimTrailingExplanation(phrase: string): string {
  return phrase
    .split(/\b(?:because|since|that's because|that is because|we use|the reason)\b/i)[0]
    .replace(/[,;:\-–—]\s*$/, "")
    .trim();
}

/** Unquoted cue phrases: "You can say X", "We say X instead of Y", "X라고 하면 돼요". */
export function extractUnquotedCues(userText: string, tutorText: string): CallCorrection[] {
  const out: CallCorrection[] = [];
  const user = (userText || "").trim();
  const userTokens = tokenizePhrase(user);
  const sentences = splitTutorSentences(tutorText);

  const instead =
    /\bwe say\s+(.+?)\s+instead of\s+(.+?)(?:[.!?。]|$)|\binstead of\s+(.+?)\s+(?:we say|you (?:should )?say|say)\s+(.+?)(?:[.!?。]|$)/gi;
  const cueRight =
    /\b(?:you can say|try saying|it(?:'s| is) better to say|a more natural(?: way)?(?: to say(?: it)?)? is)\s+(.+)/i;
  const koreanCue = /(.+?)\s*라고 하면 돼(?:요|습니다)?/;

  for (const sentence of sentences) {
    instead.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = instead.exec(sentence)) !== null) {
      if (m[1] && m[2]) pushPair(out, trimTrailingExplanation(m[2]), trimTrailingExplanation(m[1]));
      else if (m[3] && m[4]) pushPair(out, trimTrailingExplanation(m[3]), trimTrailingExplanation(m[4]));
    }

    const cue = sentence.match(cueRight);
    if (cue?.[1] && userTokens.length >= RECAST_MIN_TOKENS) {
      const right = trimTrailingExplanation(cue[1]);
      if (tokenizePhrase(right).length >= RECAST_MIN_TOKENS) pushPair(out, user, right);
    }

    const ko = sentence.match(koreanCue);
    if (ko?.[1] && userTokens.length >= 1) {
      const right = trimTrailingExplanation(ko[1].replace(/^.*?(?:예요|이에요|요)\s*/, "").trim() || ko[1]);
      if (right) pushPair(out, user, right);
    }
  }
  return out;
}

/**
 * A tutor sentence (or a token window, for unpunctuated speech) that is close to
 * the learner's last line, but not identical, is treated as a recast.
 */
export function extractRecastBySimilarity(userText: string, tutorText: string): CallCorrection[] {
  const user = (userText || "").trim();
  const tutor = (tutorText || "").trim();
  const userTokens = tokenizePhrase(user);
  if (userTokens.length < RECAST_MIN_TOKENS || !tutor) return [];

  const candidates: { phrase: string; score: number }[] = [];

  const consider = (phrase: string, asQuestion: boolean): void => {
    if (asQuestion) return;
    if (!isRecastMatch(user, phrase)) return;
    candidates.push({ phrase: phrase.trim(), score: tokenSimilarity(userTokens, tokenizePhrase(phrase)) });
  };

  const considerWindows = (span: string): void => {
    const spanTokens = tokenizePhrase(span);
    if (spanTokens.length < RECAST_MIN_TOKENS) return;
    if (spanTokens.length === userTokens.length && spanTokens.every((t, i) => t === userTokens[i])) return;
    // Unpunctuated "echo + more words": do not slide a window off the original line.
    if (isContiguousSubsequence(userTokens, spanTokens)) return;
    const minW = Math.max(RECAST_MIN_TOKENS, userTokens.length - 2);
    const maxW = Math.min(spanTokens.length, userTokens.length + 3);
    for (let w = minW; w <= maxW; w++) {
      for (let i = 0; i + w <= spanTokens.length; i++) {
        const window = spanTokens.slice(i, i + w);
        const phrase = window.join(" ");
        if (!isRecastMatch(user, phrase)) continue;
        candidates.push({ phrase, score: tokenSimilarity(userTokens, window) });
      }
    }
  };

  for (const sentence of splitTutorSentences(tutor)) {
    if (isQuestionSentence(sentence)) continue;
    consider(sentence, false);
    // Slide only inside this sentence so a greeting + question cannot leak a question window.
    considerWindows(sentence);
  }

  if (!candidates.length) return [];
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const out: CallCorrection[] = [];
  pushPair(out, user, best.phrase);
  return out;
}

/**
 * Pull correction pairs from one tutor turn, optionally using the learner's last utterance
 * to confirm the "wrong" side. Pure string heuristics; no model call.
 */
export function extractCorrections(userText: string, tutorText: string): CallCorrection[] {
  const tutor = (tutorText || "").trim();
  if (tutor.length < 8) return [];
  const out: CallCorrection[] = [];
  const text = tutor
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/➔|→|⇒/g, "->");

  const pairRes: RegExp[] = [
    /you said\s+"([^"]+)"[\s\S]{0,160}?\b(?:a more natural(?: way)? is|you can say|try(?: saying)?|say|it's|it is)\s+"([^"]+)"/gi,
    /you said\s+'([^']+)'[\s\S]{0,160}?\b(?:a more natural(?: way)? is|you can say|try(?: saying)?|say|it's|it is)\s+'([^']+)'/gi,
    /(?:instead of|not)\s+"([^"]+)"[\s\S]{0,80}?\bbut\s+"([^"]+)"/gi,
    /(?:instead of|not)\s+'([^']+)'[\s\S]{0,80}?\bbut\s+'([^']+)'/gi,
    /"([^"]+)"\s*(?:->|=>)\s*"([^"]+)"/g,
    /'([^']+)'\s*(?:->|=>)\s*'([^']+)'/g,
    /"([^"]{3,120})"\s*(?:가 )?아니라\s*"([^"]{3,120})"/g,
    /\u300c([^\u300d]{3,120})\u300d\s*(?:가 )?아니라\s*\u300c([^\u300d]{3,120})\u300d/g,
  ];
  for (const re of pairRes) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 50);
      const ruleMatch =
        after.match(/^\s*[\s,.:;–—-]*\(([^)]{3,40})\)/) ||
        after.match(/^\s*[-–—:]\s*([A-Za-z][\w' ]{2,30})/);
      pushPair(out, m[1], m[2], ruleMatch?.[1]);
    }
  }

  if (out.length === 0) {
    const quotes = quotedSpans(text);
    const uniq: string[] = [];
    for (const q of quotes) {
      if (!uniq.some((u) => normalizePhrase(u) === normalizePhrase(q))) uniq.push(q);
    }
    if (uniq.length >= 2) {
      const userN = normalizePhrase(userText || "");
      let wrong = uniq[0];
      let right = uniq[1];
      if (userN) {
        const close = uniq.find((q) => {
          const n = normalizePhrase(q);
          return n === userN || userN.includes(n) || n.includes(userN);
        });
        if (close) {
          wrong = close;
          right = uniq.find((q) => normalizePhrase(q) !== normalizePhrase(close)) || right;
        }
      }
      pushPair(out, wrong, right);
    }
  }

  // Real calls mostly recast without quotes. Cues and token-similarity run after quoted patterns.
  if (out.length === 0) {
    for (const item of extractUnquotedCues(userText, text)) pushPair(out, item.myPhrase, item.naturalPhrase, item.rule);
  }
  if (out.length === 0) {
    for (const item of extractRecastBySimilarity(userText, text)) {
      pushPair(out, item.myPhrase, item.naturalPhrase, item.rule);
    }
  }

  return out;
}

export function mergeCorrections(
  existing: CallCorrection[],
  incoming: CallCorrection[],
  maxItems: number = CORRECTION_MEMO_MAX_ITEMS,
  maxChars: number = CORRECTION_MEMO_MAX_CHARS,
): CallCorrection[] {
  const next = [...existing];
  for (const item of incoming) {
    const key = normalizePhrase(item.myPhrase);
    const idx = next.findIndex((x) => normalizePhrase(x.myPhrase) === key);
    if (idx >= 0) {
      next[idx] = {
        myPhrase: item.myPhrase,
        naturalPhrase: item.naturalPhrase,
        rule: item.rule || next[idx].rule,
      };
      const kept = next.splice(idx, 1)[0];
      next.push(kept);
    } else {
      next.push(item);
    }
  }
  let capped = next.slice(-Math.max(1, maxItems));
  while (capped.length > 1 && formatCorrectionMemo(capped).length > maxChars) {
    capped = capped.slice(1);
  }
  if (capped.length === 1 && formatCorrectionMemo(capped).length > maxChars) {
    return [];
  }
  return capped;
}

export function formatCorrectionMemo(items: CallCorrection[]): string {
  if (!items.length) return "";
  const lines = items.map((it, i) => {
    const rule = it.rule ? ` (${it.rule})` : "";
    return `${i + 1}. "${it.myPhrase}" -> "${it.naturalPhrase}"${rule}`;
  });
  return `${CORRECTION_MEMO_HEADING}\n${lines.join("\n")}`;
}

/** Rough token count for docs and tests (mixed English; ~4 chars/token). */
export function estimateMemoTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function memoSignature(items: CallCorrection[]): string {
  return items
    .map((it) => `${normalizePhrase(it.myPhrase)}=>${normalizePhrase(it.naturalPhrase)}`)
    .join("|");
}

export interface ReinjectionDecisionInput {
  items: CallCorrection[];
  lastSentSignature: string;
  lastSentAtMs: number;
  nowMs: number;
  compressed: boolean;
  /** Resume starts a new Live RPC; a prior clientContent may be gone, and a new systemInstruction may be ignored. */
  reason?: "changed" | "compression" | "resume";
  minIntervalMs?: number;
}

/**
 * Re-inject when the list changed, or after a compression (old note may have been dropped).
 * Skip empty lists and identical notes sent too recently.
 */
export function shouldReinjectMemo(input: ReinjectionDecisionInput): boolean {
  if (input.items.length === 0) return false;
  const sig = memoSignature(input.items);
  if (sig !== input.lastSentSignature) return true;
  // A new connection (resume) or a sliding-window cut can drop the previous note.
  if (input.compressed || input.reason === "resume" || input.reason === "compression") return true;
  if (input.lastSentAtMs <= 0) return true;
  return false;
}

/** Detect a sliding-window cut: prompt tokens drop by a large amount toward the 6k target. */
export function detectCompression(
  prevPromptTokens: number,
  nextPromptTokens: number,
  triggerTokens: number = 12_000,
  targetTokens: number = 6_000,
): boolean {
  if (!(prevPromptTokens > 0 && nextPromptTokens > 0)) return false;
  if (nextPromptTokens >= prevPromptTokens) return false;
  const dropped = prevPromptTokens - nextPromptTokens;
  return (
    dropped >= 2_000 &&
    prevPromptTokens >= Math.min(triggerTokens * 0.8, 8_000) &&
    nextPromptTokens <= targetTokens * 1.4 + 2_000
  );
}

const MEMO_SYS_MARK = "\n\n[Call corrections this session]\n";

/** Append (or replace) the memo block on a system prompt used at session start/resume. */
export function appendMemoToSystemPrompt(basePrompt: string, items: CallCorrection[]): string {
  const base = (basePrompt || "").replace(/\n\n\[Call corrections this session\]\n[\s\S]*$/, "");
  const body = formatCorrectionMemo(items);
  if (!body) return base;
  return `${base}${MEMO_SYS_MARK}${body}`;
}

export interface CorrectionMemoStats {
  memoItems: number;
  memoInjects: number;
  memoChars: number;
}


/**
 * Payload the Live session accepts as clientContent for a correction memo.
 * turnComplete=false appends history without starting a spoken turn.
 * Returns null when the text is empty after trim (server must not send).
 * Kept in this import-free module so `node server.ts` can load it without tsx.
 */
export function buildLiveMemoClientContent(text: unknown): {
  turns: [{ role: "user"; parts: [{ text: string }] }];
  turnComplete: false;
} | null {
  const memoText = typeof text === "string" ? text.trim() : "";
  if (!memoText) return null;
  return {
    turns: [{ role: "user", parts: [{ text: memoText }] }],
    turnComplete: false,
  };
}
