export class UtteranceWindow {
  static readonly DEFAULT_WINDOW_MS = 1500;

  readonly windowMs: number;
  private segments: string[] = [];
  private pendingPartial: string | null = null;
  deadline: number | null = null;
  lastFinalAt: number | null = null;

  constructor(windowMs = UtteranceWindow.DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  get hasContent(): boolean {
    return this.segments.length > 0 || Boolean(this.pendingPartial && this.pendingPartial.length > 0);
  }

  onFinal(text: string, now: number): void {
    const t = text.trim();
    this.pendingPartial = null;
    if (t.length > 0) {
      const last = this.segments[this.segments.length - 1];
      if (!last || (last !== t && !last.endsWith(t))) {
        this.segments.push(t);
        this.lastFinalAt = now;
      }
    }
    if (this.segments.length > 0) {
      this.extendTo(now + this.windowMs);
    }
  }

  onPartial(text: string, now: number): void {
    const t = text.trim();
    if (t.length > 0) {
      this.pendingPartial = t;
      this.extendTo(now + this.windowMs);
    }
  }

  onActivity(now: number): void {
    if (this.segments.length === 0) return;
    this.extendTo(now + this.windowMs);
  }

  isDue(now: number): boolean {
    if (this.deadline === null) return false;
    return this.hasContent && now >= this.deadline;
  }

  displayText(partial?: string | null): string {
    const p = (partial ?? this.pendingPartial)?.trim();
    const parts = [...this.segments];
    if (p && p.length > 0 && !parts.includes(p)) {
      parts.push(p);
    }
    return parts.join(' ');
  }

  take(): string {
    const text = this.displayText(this.pendingPartial);
    this.reset();
    return text.trim();
  }

  reset(): void {
    this.segments = [];
    this.pendingPartial = null;
    this.deadline = null;
    this.lastFinalAt = null;
  }

  private extendTo(t: number): void {
    if (this.deadline === null || t > this.deadline) {
      this.deadline = t;
    }
  }
}
