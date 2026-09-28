export class SentenceSplitter {
  private static readonly DEFAULT_MIN_CHARS = 2;
  private static readonly TERMINATORS = new Set(['.', '!', '?', '…', '~', '。', '！', '？']);
  private static readonly CLOSERS = new Set(['"', "'", ')', '」', '』', '”', '’']);

  private buf = '';
  private carry = '';
  private minChars: number;

  constructor(minChars = SentenceSplitter.DEFAULT_MIN_CHARS) {
    this.minChars = minChars;
  }

  private static contentChars(s: string): number {
    let count = 0;
    for (const c of s) {
      if (/[\p{L}\p{N}]/u.test(c)) count++;
    }
    return count;
  }

  push(delta: string): string[] {
    if (!delta) return [];
    this.buf += delta;
    const out: string[] = [];
    let start = 0;
    let i = 0;

    while (i < this.buf.length) {
      const c = this.buf[i];
      if (c === '\n' || c === '\r') {
        this.emit(this.buf.substring(start, i), out);
        start = i + 1;
      } else if (SentenceSplitter.TERMINATORS.has(c)) {
        let j = i + 1;
        while (
          j < this.buf.length &&
          (SentenceSplitter.TERMINATORS.has(this.buf[j]) || SentenceSplitter.CLOSERS.has(this.buf[j]))
        ) {
          j++;
        }
        if (j >= this.buf.length) break; // End not reached yet
        if (/\s/.test(this.buf[j])) {
          this.emit(this.buf.substring(start, j), out);
          start = j;
        }
        i = j;
        continue;
      }
      i++;
    }

    this.buf = this.buf.substring(start);
    return out;
  }

  flush(): string[] {
    const rest = [this.carry, this.buf.trim()].filter((s) => s.length > 0).join(' ');
    this.buf = '';
    this.carry = '';
    return rest.length === 0 ? [] : [rest];
  }

  private emit(raw: string, out: string[]) {
    const s = raw.trim();
    if (!s) return;
    const merged = this.carry.length === 0 ? s : `${this.carry} ${s}`;
    if (SentenceSplitter.contentChars(merged) < this.minChars) {
      this.carry = merged;
      return;
    }
    this.carry = '';
    out.push(merged);
  }

  static splitAll(text: string, minChars = SentenceSplitter.DEFAULT_MIN_CHARS): string[] {
    const sp = new SentenceSplitter(minChars);
    return [...sp.push(text), ...sp.flush()];
  }
}
