export const POC_VOICE_ADDENDUM =
  "Voice call output rules: Your reply will be spoken aloud by text-to-speech on a phone call. " +
  "Answer in 1 to 3 short, natural spoken sentences. " +
  "Do not use markdown, bullet lists, numbered lists, emoji, or stage directions. " +
  "Keep Korean only where the instructions specifically ask for Korean explanations.";

const ABBREVIATIONS = new Set([
  "mr.",
  "mrs.",
  "ms.",
  "dr.",
  "prof.",
  "jr.",
  "sr.",
  "st.",
  "e.g.",
  "i.e.",
  "etc.",
  "vs.",
  "a.m.",
  "p.m.",
  "u.s.",
  "u.k.",
]);

const SENTENCE_END_CHARS = new Set([".", "!", "?", "。", "…"]);
const CLOSING_WRAPPER_CHARS = new Set(['"', "'", "”", "’", ")", "]"]);

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isAbbreviationAt(text: string, periodIdx: number): boolean {
  let start = periodIdx;
  while (start > 0 && !isWhitespace(text[start - 1])) {
    start--;
  }
  let token = text.slice(start, periodIdx + 1).toLowerCase();
  token = token.replace(/^["'“‘(\[]+/, "");
  return ABBREVIATIONS.has(token);
}

/**
 * Cut complete sentences from streamed text.
 * A sentence ends at `.`, `!`, `?`, `。`, `…` or newline followed by whitespace or end-of-input,
 * avoiding common abbreviations and decimal numbers (e.g. 3.5).
 */
export function splitSentences(buffer: string): { sentences: string[]; rest: string } {
  if (!buffer) return { sentences: [], rest: "" };

  const sentences: string[] = [];
  let start = 0;
  let i = 0;
  const len = buffer.length;

  while (i < len) {
    const ch = buffer[i];

    if (ch === "\n") {
      const piece = buffer.slice(start, i).trim();
      if (piece) sentences.push(piece);
      i++;
      start = i;
      continue;
    }

    if (SENTENCE_END_CHARS.has(ch)) {
      if (ch === ".") {
        // Decimal number like 3.5
        if (i > 0 && i + 1 < len && isDigit(buffer[i - 1]) && isDigit(buffer[i + 1])) {
          i++;
          continue;
        }
        // Common abbreviations like Mr., Dr., e.g., i.e., a.m., U.S.
        if (isAbbreviationAt(buffer, i)) {
          i++;
          continue;
        }
      }

      // Consume consecutive sentence-end punctuation (e.g., "...", "?!", "!!")
      let end = i;
      while (end + 1 < len && SENTENCE_END_CHARS.has(buffer[end + 1])) {
        end++;
      }
      // Consume optional closing quotes/parens immediately after punctuation
      while (end + 1 < len && CLOSING_WRAPPER_CHARS.has(buffer[end + 1])) {
        end++;
      }

      const nextIdx = end + 1;
      const isBoundary =
        ch === "。" || nextIdx >= len || isWhitespace(buffer[nextIdx]);

      if (isBoundary) {
        const piece = buffer.slice(start, nextIdx).trim();
        if (piece) sentences.push(piece);
        i = nextIdx;
        while (i < len && buffer[i] !== "\n" && isWhitespace(buffer[i])) {
          i++;
        }
        start = i;
        continue;
      }

      i = end + 1;
      continue;
    }

    i++;
  }

  const rest = buffer.slice(start).trimStart();
  return { sentences, rest };
}

export function flushSentences(rest: string): string[] {
  const trimmed = rest.trim();
  return trimmed ? [trimmed] : [];
}

export function stripMarkdownForSpeech(s: string): string {
  if (!s) return "";
  return s
    .replace(/^\s*(?:[-*+•]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_#`]/g, "")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readAscii4(buf: Uint8Array, offset: number): string {
  return String.fromCharCode(
    buf[offset],
    buf[offset + 1],
    buf[offset + 2],
    buf[offset + 3],
  );
}

/**
 * Parse a RIFF/WAVE buffer by walking chunks ("fmt " and "data") with odd-size padding.
 * If not RIFF/WAVE, returns the input as-is with sampleRate 24000.
 */
export function wavToPcm(buf: Uint8Array): { pcm: Uint8Array; sampleRate: number } {
  const DEFAULT_RATE = 24000;
  if (
    buf.byteLength < 12 ||
    readAscii4(buf, 0) !== "RIFF" ||
    readAscii4(buf, 8) !== "WAVE"
  ) {
    return { pcm: buf, sampleRate: DEFAULT_RATE };
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let sampleRate = DEFAULT_RATE;
  let dataStart = -1;
  let dataEnd = -1;
  let offset = 12;

  while (offset + 8 <= buf.byteLength) {
    const id = readAscii4(buf, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + 8;
    const chunkDataEnd = Math.min(buf.byteLength, chunkDataStart + chunkSize);

    if (id === "fmt " && chunkDataEnd - chunkDataStart >= 8) {
      const sr = view.getUint32(chunkDataStart + 4, true);
      if (sr > 0) sampleRate = sr;
    } else if (id === "data") {
      dataStart = chunkDataStart;
      dataEnd = chunkDataEnd;
    }

    const paddedSize = chunkSize + (chunkSize & 1);
    const nextOffset = chunkDataStart + paddedSize;
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  if (dataStart >= 0) {
    return { pcm: buf.subarray(dataStart, dataEnd), sampleRate };
  }
  return { pcm: new Uint8Array(0), sampleRate };
}

/**
 * TTS audio → 16-bit PCM. Gemini TTS usually returns raw PCM labelled
 * "audio/L16;codec=pcm;rate=24000"; a RIFF/WAVE body is parsed instead. The rate comes from the
 * WAV header, else from the mime type, else 24000.
 */
export function ttsAudioToPcm(audio: Uint8Array, mimeType?: string): { pcm: Uint8Array; sampleRate: number } {
  const isRiff = audio.byteLength >= 12 && readAscii4(audio, 0) === "RIFF" && readAscii4(audio, 8) === "WAVE";
  if (isRiff) return wavToPcm(audio);
  const rate = Number(/rate=(\d+)/i.exec(String(mimeType || ""))?.[1]);
  return { pcm: audio, sampleRate: Number.isFinite(rate) && rate > 0 ? rate : 24000 };
}

export function pcmSeconds(byteLength: number, sampleRate = 24000): number {
  if (
    !Number.isFinite(byteLength) ||
    byteLength <= 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0
  ) {
    return 0;
  }
  return byteLength / (sampleRate * 2);
}

export function normalizeWords(s: string): string[] {
  if (!s) return [];
  const cleaned = s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim();
  if (!cleaned) return [];
  return cleaned.split(/\s+/).filter(Boolean);
}

export function isLikelyEcho(userInterim: string, tutorRecentText: string): boolean {
  const userWords = normalizeWords(userInterim);
  if (userWords.length === 0) return false;
  const tutorWords = new Set(normalizeWords(tutorRecentText));
  if (tutorWords.size === 0) return false;
  let matches = 0;
  for (const w of userWords) {
    if (tutorWords.has(w)) matches++;
  }
  return matches / userWords.length >= 0.7;
}

export function shouldBargeIn(opts: {
  interim: string;
  tutorSpeaking: boolean;
  tutorRecentText: string;
  minWords?: number;
}): boolean {
  if (!opts.tutorSpeaking) return false;
  const minWords = opts.minWords ?? 2;
  const words = normalizeWords(opts.interim);
  if (words.length < minWords) return false;
  return !isLikelyEcho(opts.interim, opts.tutorRecentText);
}

export interface ChatTurn {
  role: "user" | "model";
  text: string;
}

export function truncateModelTurnAfterBargeIn(spokenSentences: string[]): string {
  const cleaned = spokenSentences.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return "[interrupted before speaking]";
  return `${cleaned.join(" ")} [interrupted]`;
}

export function buildContents(
  history: ChatTurn[],
  maxTurns = 80,
): Array<{ role: "user" | "model"; parts: [{ text: string }] }> {
  if (!Array.isArray(history) || history.length === 0 || maxTurns <= 0) return [];
  const sliced = history.slice(-maxTurns);
  const merged: Array<{ role: "user" | "model"; text: string }> = [];

  for (const turn of sliced) {
    if (!turn || (turn.role !== "user" && turn.role !== "model")) continue;
    const text = typeof turn.text === "string" ? turn.text.trim() : "";
    if (!text) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.role === turn.role) {
      prev.text = `${prev.text}\n${text}`;
    } else {
      merged.push({ role: turn.role, text });
    }
  }

  if (merged.length === 0) return [];
  if (merged[0].role === "model") {
    merged.unshift({ role: "user", text: "(call started)" });
  }

  return merged.map((t) => ({
    role: t.role,
    parts: [{ text: t.text }],
  }));
}

export function sanitizeHistory(
  raw: unknown,
  maxTurns = 80,
  maxChars = 2000,
): ChatTurn[] {
  if (!Array.isArray(raw) || maxTurns <= 0 || maxChars <= 0) return [];
  const out: ChatTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.role !== "user" && rec.role !== "model") continue;
    if (typeof rec.text !== "string") continue;
    const trimmed = rec.text.trim();
    if (!trimmed) continue;
    const text = trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
    out.push({ role: rec.role, text });
  }
  return out.slice(-maxTurns);
}

export function percentile(xs: number[], p: number): number {
  if (!Array.isArray(xs) || xs.length === 0) return 0;
  const finite = xs.filter((x) => Number.isFinite(x));
  if (finite.length === 0) return 0;
  const sorted = finite.sort((a, b) => a - b);
  const clamped = Math.max(0, Math.min(100, Number.isFinite(p) ? p : 0));
  if (clamped <= 0) return sorted[0];
  const rank = Math.ceil((clamped / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function median(xs: number[]): number {
  return percentile(xs, 50);
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
