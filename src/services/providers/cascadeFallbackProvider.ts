/**
 * Google-streaming test mode (PoC) wrapper: tries the cascade provider first and, if it is not
 * ready within its connect timeout (or fails before ready), connects the normal Live engine for
 * this call instead. Pure delegation; no DOM / Firebase imports so it can be unit-tested.
 */
import type { LiveCommand, LiveProvider, LiveSessionOptions, LiveTranscriptItem } from "./types";
import type { LiveUsageTotals } from "./liveUsage";
import type { PocFirstTts, PocTextVariant, PocUsageTotals } from "../../config/cascadePoc";
import { logPoc } from "../perf/pocQaLog";

export const POC_FALLBACK_NOTICE = "시험 모드 연결 실패, 기본 엔진으로 연결합니다";

export type ActiveEngine = "cascade_poc" | "live";

/** A cascade provider: connect() must REJECT on any failure before the server is ready. */
export interface PocCapableProvider extends LiveProvider {
  getPocUsage(): PocUsageTotals;
  /** Reply-text A/B variant of this call (missing = "a"). */
  getPocTextVariant?(): PocTextVariant;
  /** First-segment TTS mode of this call (missing = "full"). */
  getPocFirstTts?(): PocFirstTts;
  disconnect(notifyClosed?: boolean): Promise<void>;
}

export class PocFallbackProvider implements LiveProvider {
  public name = "cascade-poc";
  private makePoc: () => PocCapableProvider;
  private makeLive: () => LiveProvider;
  private inner: LiveProvider | null = null;
  private poc: PocCapableProvider | null = null;
  private engine: ActiveEngine = "cascade_poc";
  private fallbackReason: string | null = null;
  /** Bumped by disconnect(): a connect that was cancelled must not open the normal engine. */
  private connectGen = 0;

  constructor(makePoc: () => PocCapableProvider, makeLive: () => LiveProvider) {
    this.makePoc = makePoc;
    this.makeLive = makeLive;
  }

  public getEngine(): ActiveEngine {
    return this.engine;
  }

  public getFallbackReason(): string | null {
    return this.fallbackReason;
  }

  /** Cascade usage for this call, or null when the call ran on the normal engine. */
  public getPocTextVariant(): PocTextVariant {
    return this.poc?.getPocTextVariant?.() ?? "a";
  }

  public getPocFirstTts(): PocFirstTts {
    return this.poc?.getPocFirstTts?.() ?? "full";
  }

  public getPocUsage(): PocUsageTotals | null {
    return this.engine === "cascade_poc" && this.poc ? this.poc.getPocUsage() : null;
  }

  public async connect(options: LiveSessionOptions): Promise<void> {
    // "다시 시도" after a fallback stays on the normal engine for this call screen.
    if (this.engine === "live" && this.inner) {
      return this.inner.connect(options);
    }
    const gen = ++this.connectGen;
    if (!this.poc) this.poc = this.makePoc();
    this.inner = this.poc;
    this.name = this.poc.name;
    try {
      await this.poc.connect(options);
      return;
    } catch (err: any) {
      if (gen !== this.connectGen || err?.code === "POC_CANCELLED") {
        // Hung up / screen closed during connect: no fallback, nothing left open.
        logPoc("[poc] stage=connect_cancelled");
        return;
      }
      this.fallbackReason = String(err?.code || err?.message || err || "unknown").slice(0, 120);
      console.warn(`[poc] fallback=live reason=${this.fallbackReason}`);
      await this.poc.disconnect(false).catch(() => {});
    }
    if (gen !== this.connectGen) return;
    const live = this.makeLive();
    this.engine = "live";
    this.inner = live;
    this.name = live.name;
    options.onStatusChange("connecting", POC_FALLBACK_NOTICE);
    await live.connect(options);
  }

  private get p(): LiveProvider | null {
    return this.inner;
  }

  sendAudioChunk(pcm16kChunk: ArrayBuffer): void {
    this.p?.sendAudioChunk(pcm16kChunk);
  }
  sendTextPrompt(prompt: string): boolean {
    return this.p ? this.p.sendTextPrompt(prompt) : false;
  }
  appendUserText(text: string): void {
    this.p?.appendUserText(text);
  }
  sendControlCommand(command: LiveCommand): void {
    this.p?.sendControlCommand(command);
  }
  getLiveTranscript(): LiveTranscriptItem[] {
    return this.p ? this.p.getLiveTranscript() : [];
  }
  getResumeToken(): string | null {
    return this.p ? this.p.getResumeToken() : null;
  }
  getMediaStream(): MediaStream | null {
    return this.p ? this.p.getMediaStream() : null;
  }
  getConnectionStats(): { connectionPath: "direct" | "proxy"; directFailCount: number } {
    return this.p ? this.p.getConnectionStats() : { connectionPath: "proxy", directFailCount: 0 };
  }
  /** Live engine usage only (undefined at runtime on the cascade path; callers already use ?.). */
  getLiveUsage(): LiveUsageTotals {
    return this.p?.getLiveUsage?.() as LiveUsageTotals;
  }
  finalizeLiveUsage(): LiveUsageTotals {
    return this.p?.finalizeLiveUsage?.() as LiveUsageTotals;
  }
  getLivePeakPromptTokens(): number {
    return this.p?.getLivePeakPromptTokens?.() ?? 0;
  }
  disconnect(): Promise<void> {
    this.connectGen++;
    return this.p ? this.p.disconnect() : Promise.resolve();
  }
}

/** Engine that actually carried this call ("live" for the normal provider or after a fallback). */
export function activeEngineOf(provider: LiveProvider | null | undefined): ActiveEngine {
  return provider instanceof PocFallbackProvider ? provider.getEngine() : "live";
}

/** Reply-text variant of a test-mode call ("a" when unknown). */
export function pocTextVariantOf(provider: LiveProvider | null | undefined): PocTextVariant {
  return provider instanceof PocFallbackProvider ? provider.getPocTextVariant() : "a";
}

/** First-segment TTS mode of a test-mode call ("full" when unknown). */
export function pocFirstTtsOf(provider: LiveProvider | null | undefined): PocFirstTts {
  return provider instanceof PocFallbackProvider ? provider.getPocFirstTts() : "full";
}

/** Test-mode usage for this call, or null when the call ran on the normal engine. */
export function pocUsageOf(provider: LiveProvider | null | undefined): PocUsageTotals | null {
  return provider instanceof PocFallbackProvider ? provider.getPocUsage() : null;
}
