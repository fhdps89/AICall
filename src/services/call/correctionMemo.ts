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
  out.push({ myPhrase, naturalPhrase, rule: clipRule(rule) });
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
