/**
 * Google-streaming test mode (PoC) Live provider.
 *
 * Browser side only does mic capture (16 kHz PCM), playback (24 kHz PCM through the shared
 * playback scheduler) and UI callbacks. Transcription (gemini-3.5-transcribe-live), the tutor
 * reply (gemini-3.8-flash) and speech (gemini-3.8-flash-tts) all run on the server
 * WebSocket POC_WS_PATH, so no key ever reaches the browser.
 *
 * connect() REJECTS unless the server is ready AND the tutor's first sentence (text + speech)
 * has arrived within CASCADE_CONNECT_BUDGET_MS (8 s, one deadline for both); PocFallbackProvider
 * then connects the normal engine for this call. The mic opens in parallel at connect start (same
 * order as the normal engine) but sends nothing before "ready"; the chunk recorder is attached
 * only once this engine is committed, and a fallback closes this mic before the normal engine
 * opens its own.
 */
import { normalizeVoiceName } from "../../config/voices";
import {
  POC_DEFAULT_FIRST_TTS,
  POC_TEXT_VARIANTS,
  POC_WS_PATH,
  emptyPocUsage,
  parsePocFirstTts,
  pocFirstTtsModel,
  sanitizePocUsage,
  type PocFirstTts,
  type PocTextVariant,
  type PocUsageTotals,
} from "../../config/cascadePoc";
import {
  resolvePocFirstTts,
  resolvePocTextVariant,
  type PocTextVariantSource,
} from "../settings/callEngineSetting";
import { auth } from "../firebase/config";
import { LIVE_STATUS_TEXT } from "./liveStatusText";
import { CALL_KICKOFF_PROMPT } from "./geminiLiveProvider";
import {
  createScheduler,
  scheduleChunk,
  resetScheduler,
  type PlaybackSchedulerState,
} from "./audioPlaybackScheduler";
import type { LiveCommand, LiveSessionOptions, LiveTranscriptItem } from "./types";
import type { PocCapableProvider } from "./cascadeFallbackProvider";
import { logPoc } from "../perf/pocQaLog";

/** One deadline from connect start to "server ready + first tutor audio" (plan: 8 s fallback). */
export const CASCADE_CONNECT_BUDGET_MS = 8000;
export const CASCADE_RECONNECT_DELAY_MS = 1000;

export interface CascadePocTimings {
  connectBudgetMs?: number;
  reconnectDelayMs?: number;
  /** Test seam: A/B choice (default: ?pocText= URL param, then the saved setting, then "a"). */
  resolveTextVariant?: () => { variant: PocTextVariant; source: PocTextVariantSource };
  /** Test seam: first-segment TTS mode (default: ?pocTts= URL param, else "full"). */
  resolveFirstTts?: () => PocFirstTts;
}

/** Nearest-rank percentile, same rule as the server's [poc-summary] (no samples → 0, like the server). */
function percentileOf(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((x, y) => x - y);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return Math.round(s[idx]);
}

/** Nearest-rank median, the same rule as the server's [poc-summary]. */
function medianOf(values: number[]): number {
  return percentileOf(values, 50);
}

function nonNegInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

interface PocCallStats {
  turns: number;
  finalToToken: number[];
  ttsFirstChunk: number[];
  finalToAudio: number[];
  /** Server counters of earlier sessions in this call (a reconnect starts a new server session). */
  base: { echoDrops: number; ttsStreams: number; bargeIns: number; textInterrupts: number };
  last: { echoDrops: number; ttsStreams: number; bargeIns: number; textInterrupts: number };
}

function emptyStats(): PocCallStats {
  return {
    turns: 0,
    finalToToken: [],
    ttsFirstChunk: [],
    finalToAudio: [],
    base: { echoDrops: 0, ttsStreams: 0, bargeIns: 0, textInterrupts: 0 },
    last: { echoDrops: 0, ttsStreams: 0, bargeIns: 0, textInterrupts: 0 },
  };
}
const MAX_RECONNECTS = 3;

function addPocUsage(a: PocUsageTotals, b: PocUsageTotals): PocUsageTotals {
  return {
    sttAudioSec: a.sttAudioSec + b.sttAudioSec,
    sttOutTokens: a.sttOutTokens + b.sttOutTokens,
    sttOutEstimated: a.sttOutEstimated || b.sttOutEstimated,
    textInTokens: a.textInTokens + b.textInTokens,
    textOutTokens: a.textOutTokens + b.textOutTokens,
    ttsInTokens: a.ttsInTokens + b.ttsInTokens,
    ttsAudioSec: a.ttsAudioSec + b.ttsAudioSec,
    ttsLiteInTokens: a.ttsLiteInTokens + b.ttsLiteInTokens,
    ttsLiteAudioSec: a.ttsLiteAudioSec + b.ttsLiteAudioSec,
    turns: a.turns + b.turns,
  };
}

function cascadeError(code: string, message: string): Error {
  const e: any = new Error(message);
  e.code = code;
  return e;
}

export class CascadePocProvider implements PocCapableProvider {
  public name = "cascade-poc";
  private connectBudgetMs: number;
  private reconnectDelayMs: number;

  private options: LiveSessionOptions | null = null;
  private socket: WebSocket | null = null;
  private ready = false;
  private closing = false;
  private reconnects = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Rejects the socket handshake in progress (used by disconnect()). */
  private cancelOpen: ((e: Error) => void) | null = null;
  private generation = 0;
  private connectStartedAt = 0;
  private firstAudioLogged = false;
  /** Mic opened at connect start (call mode settles before the tutor speaks). */
  private micInit: Promise<void> | null = null;
  /** The recorder hookup (onMediaStreamReady) waits until this engine is committed to the call. */
  private micCommitted = false;
  private turnPlay = { chunks: 0, underrunsAtStart: 0, gaps: 0, turn: 0 };
  private firstAudioWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  private inputAudioCtx: AudioContext | null = null;
  private outputAudioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  private playbackScheduler: PlaybackSchedulerState = createScheduler();
  private activeSources: AudioBufferSourceNode[] = [];
  private playbackOut: AudioNode | null = null;
  private playbackEl: HTMLAudioElement | null = null;

  private transcriptItems: LiveTranscriptItem[] = [];
  /** Usage of earlier server sessions in this call (each reconnect starts a new server session). */
  private pocUsageBase: PocUsageTotals = emptyPocUsage();
  private pocUsage: PocUsageTotals = emptyPocUsage();

  private resolveTextVariant: () => { variant: PocTextVariant; source: PocTextVariantSource };
  private resolveFirstTts: () => PocFirstTts;
  private textVariant: PocTextVariant = "a";
  private firstTts: PocFirstTts = POC_DEFAULT_FIRST_TTS;
  private stats: PocCallStats = emptyStats();
  private summaryLogged = false;

  constructor(timings: CascadePocTimings = {}) {
    this.connectBudgetMs = timings.connectBudgetMs ?? CASCADE_CONNECT_BUDGET_MS;
    this.reconnectDelayMs = timings.reconnectDelayMs ?? CASCADE_RECONNECT_DELAY_MS;
    this.resolveTextVariant = timings.resolveTextVariant ?? (() => resolvePocTextVariant());
    this.resolveFirstTts = timings.resolveFirstTts ?? (() => resolvePocFirstTts());
  }

  /** Reply-text variant this call asked the server for ("a" or "b"). */
  public getPocTextVariant(): PocTextVariant {
    return this.textVariant;
  }

  /** First-segment TTS mode this call asked the server for ("full" or "lite"). */
  public getPocFirstTts(): PocFirstTts {
    return this.firstTts;
  }

  /** Browser-side call summary (the server prints its own [poc-summary] to the server log). */
  private logSummary(): void {
    if (this.summaryLogged || this.stats.turns === 0) return;
    this.summaryLogged = true;
    const st = this.stats;
    const c = (k: "echoDrops" | "ttsStreams" | "bargeIns" | "textInterrupts") => st.base[k] + st.last[k];
    logPoc(
      `[poc-summary] variant=${this.textVariant} textModel=${POC_TEXT_VARIANTS[this.textVariant].model} firstTts=${this.firstTts} ttsFirstModel=${pocFirstTtsModel(this.firstTts)} turns=${st.turns} medianFinalToToken=${medianOf(st.finalToToken)}ms p90FinalToToken=${percentileOf(st.finalToToken, 90)}ms medianTtsFirstChunk=${medianOf(st.ttsFirstChunk)}ms medianFinalToAudio=${medianOf(st.finalToAudio)}ms p90FinalToAudio=${percentileOf(st.finalToAudio, 90)}ms echoDrops=${c("echoDrops")} ttsStreams=${c("ttsStreams")} bargeIns=${c("bargeIns")} textInterrupts=${c("textInterrupts")}`
    );
  }

  public async connect(options: LiveSessionOptions): Promise<void> {
    const gen = ++this.generation;
    this.options = options;
    this.closing = false;
    this.reconnects = 0;
    this.firstAudioLogged = false;
    this.connectStartedAt = Date.now();
    options.onStatusChange("connecting", LIVE_STATUS_TEXT.preparing);
    logPoc("[poc] stage=connect_start");
    const chosen = this.resolveTextVariant();
    this.textVariant = chosen.variant === "b" ? "b" : "a";
    this.firstTts = parsePocFirstTts(this.resolveFirstTts());
    this.stats = emptyStats();
    this.summaryLogged = false;
    logPoc(
      `[poc] variant=${this.textVariant} textModel=${POC_TEXT_VARIANTS[this.textVariant].model} source=${chosen.source} firstTts=${this.firstTts} ttsFirstModel=${pocFirstTtsModel(this.firstTts)}`
    );

    // Same order as the normal engine (geminiLiveProvider connect): the mic opens in parallel
    // right away, so Android's switch to call mode happens before the tutor's first word, not
    // in the middle of it. No audio is sent before the server is ready (processor checks
    // `ready`), and the chunk recorder is only attached once this engine is committed, so a
    // fallback never leaves a second recorder; on fallback disconnect() stops this mic before
    // the normal engine opens its own.
    this.micCommitted = false;
    const deadline = this.connectStartedAt + this.connectBudgetMs;
    if (!options.skipMic) {
      this.micInit = this.initAudioCapture(gen)
        .then((live) => {
          if (live) logPoc("[poc] stage=mic_ready");
        })
        .catch((err: any) => {
          if (gen !== this.generation) return;
          console.warn("[poc] stage=mic_failed", err?.cause || err);
          this.options?.onMicWarning?.(
            err?.message || "마이크를 쓸 수 없어요. 튜터 목소리는 들을 수 있지만 말하려면 마이크를 확인해 주세요."
          );
        });
    }
    await this.initAudioPlayback().catch((err) => console.warn("[poc] stage=playback_init_failed", err));
    if (gen !== this.generation) throw cascadeError("POC_CANCELLED", "cancelled");
    await this.openSocket(gen, Math.max(0, deadline - Date.now()));
    if (gen !== this.generation) throw cascadeError("POC_CANCELLED", "cancelled");
    await this.kickoffAndWaitFirstAudio(Math.max(0, deadline - Date.now()));
    if (gen !== this.generation) throw cascadeError("POC_CANCELLED", "cancelled");
    this.commitMic();
    options.onStatusChange("connected", LIVE_STATUS_TEXT.connected);
    logPoc(`[poc] stage=connected ms=${Date.now() - this.connectStartedAt}`);
  }

  /** Attach the recorder now if the mic is ready; otherwise initAudioCapture() does it when it is. */
  private commitMic(): void {
    this.micCommitted = true;
    if (this.recordDest) this.options?.onMediaStreamReady?.(this.recordDest.stream);
  }

  /** Sends the kickoff and waits for the tutor's first audio (proves text + speech both work). */
  private kickoffAndWaitFirstAudio(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.firstAudioWaiter = null;
        reject(cascadeError("POC_CONNECT_TIMEOUT", `no tutor audio within ${this.connectBudgetMs}ms`));
      }, timeoutMs);
      this.firstAudioWaiter = {
        resolve: () => {
          clearTimeout(timer);
          this.firstAudioWaiter = null;
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          this.firstAudioWaiter = null;
          reject(e);
        },
      };
      if (!this.sendTextPrompt(CALL_KICKOFF_PROMPT)) {
        this.firstAudioWaiter.reject(cascadeError("POC_KICKOFF_SEND_FAILED", "kickoff not sent"));
      }
    });
  }

  /** Opens the cascade socket and resolves on the server's "ready", rejects otherwise. */
  private async openSocket(gen: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let idToken = "";
    let tokenTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      // The token refresh counts against the same budget, so a stuck refresh still falls back in time.
      idToken =
        (await Promise.race([
          auth.currentUser?.getIdToken() ?? Promise.resolve(""),
          new Promise<string>((_, reject) => {
            tokenTimer = setTimeout(() => reject(cascadeError("POC_CONNECT_TIMEOUT", "id token timeout")), timeoutMs);
          }),
        ])) || "";
    } catch (e: any) {
      if (e?.code === "POC_CONNECT_TIMEOUT") throw e;
      console.warn("[poc] stage=id_token_failed", e);
    } finally {
      if (tokenTimer) clearTimeout(tokenTimer);
    }
    if (gen !== this.generation || this.closing) throw cascadeError("POC_CANCELLED", "cancelled");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}${POC_WS_PATH}?token=${encodeURIComponent(idToken)}`;
    const history = this.transcriptItems.slice(-80).map((t) => ({ role: t.role, text: t.text }));

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      this.ready = false;
      let settled = false;
      const timer = setTimeout(
        () => fail("POC_CONNECT_TIMEOUT", `cascade not ready within ${this.connectBudgetMs}ms`),
        Math.max(0, deadline - Date.now())
      );
      const fail = (code: string, msg: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelOpen = null;
        try {
          socket.close();
        } catch {
          // ignore
        }
        if (this.socket === socket) this.socket = null;
        reject(cascadeError(code, msg));
      };
      this.cancelOpen = (e: any) => fail(e?.code || "POC_CANCELLED", e?.message || "cancelled");

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: "init",
            systemInstruction: this.options?.systemPrompt || "",
            voiceName: normalizeVoiceName(this.options?.voiceName),
            history,
            // Only "a"/"b" and "full"/"lite"; the server maps them to model IDs.
            textVariant: this.textVariant,
            firstTts: this.firstTts,
          })
        );
      };
      socket.onmessage = async (event) => {
        let msg: any;
        try {
          msg = JSON.parse(typeof event.data === "string" ? event.data : await (event.data as Blob).text());
        } catch {
          return;
        }
        if (gen !== this.generation || this.socket !== socket) return;
        if (!settled) {
          if (msg.type === "ready") {
            settled = true;
            clearTimeout(timer);
            this.cancelOpen = null;
            this.ready = true;
            // A new server session counts usage from zero: keep what earlier sessions reported.
            this.pocUsageBase = addPocUsage(this.pocUsageBase, this.pocUsage);
            this.pocUsage = emptyPocUsage();
            const st = this.stats;
            st.base = {
              echoDrops: st.base.echoDrops + st.last.echoDrops,
              ttsStreams: st.base.ttsStreams + st.last.ttsStreams,
              bargeIns: st.base.bargeIns + st.last.bargeIns,
              textInterrupts: st.base.textInterrupts + st.last.textInterrupts,
            };
            st.last = { echoDrops: 0, ttsStreams: 0, bargeIns: 0, textInterrupts: 0 };
            logPoc(
              `[poc] stage=ready ms=${Date.now() - this.connectStartedAt} variant=${String(msg.textVariant ?? "?")} textModel=${String(msg.models?.text ?? "?")} firstTts=${String(msg.firstTts ?? "?")} ttsFirstModel=${String(msg.models?.ttsFirst ?? "?")}`
            );
            resolve();
          } else if (msg.type === "fallback_required" || msg.type === "error") {
            fail("POC_SERVER_" + String(msg.error || msg.type), String(msg.error || msg.type));
          }
          return;
        }
        this.handleMessage(msg);
      };
      socket.onerror = () => fail("POC_SOCKET_ERROR", "cascade socket error");
      socket.onclose = (ev) => {
        if (!settled) {
          fail("POC_CLOSED_BEFORE_READY", `closed before ready (${ev.code})`);
          return;
        }
        if (this.socket === socket) this.handleDrop(gen, ev.code);
      };
    });
  }

  private handleDrop(gen: number, code: number): void {
    this.ready = false;
    this.socket = null;
    if (this.firstAudioWaiter) {
      // Still inside connect(): let the wrapper fall back instead of reconnecting.
      this.firstAudioWaiter.reject(cascadeError("POC_CLOSED_BEFORE_FIRST_AUDIO", `closed (${code})`));
      return;
    }
    if (this.closing || gen !== this.generation) return;
    if (this.reconnects >= MAX_RECONNECTS) {
      console.error(`[poc] giving up after ${this.reconnects} reconnects (code=${code})`);
      this.options?.onStatusChange("error", "연결이 계속 끊겨요. 인터넷을 확인하고 다시 걸어 주세요.");
      return;
    }
    this.reconnects += 1;
    console.warn(`[poc] stage=reconnect attempt=${this.reconnects} code=${code}`);
    if (this.turnPlay.chunks > 0) this.logTurnPlayback(true);
    this.stopAudioPlayback();
    this.options?.onStatusChange("reconnecting", "연결이 잠깐 끊겼어요. 다시 연결하는 중...");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closing || gen !== this.generation) return;
      this.openSocket(gen, this.connectBudgetMs)
        .then(() => {
          if (this.closing || gen !== this.generation) return;
          this.options?.onStatusChange("connected", LIVE_STATUS_TEXT.connected);
        })
        .catch((err) => {
          if (this.closing || gen !== this.generation) return;
          console.warn("[poc] stage=reconnect_failed", err?.code || err);
          this.handleDrop(gen, -1);
        });
    }, this.reconnectDelayMs);
  }

  private handleMessage(msg: any): void {
    switch (msg?.type) {
      case "audio": {
        if (!msg.audio) return;
        const rate = Number(/rate=(\d+)/.exec(String(msg.mimeType || ""))?.[1]) || 24000;
        const buffer = this.base64ToArrayBuffer(msg.audio);
        this.playAudioChunk(buffer, rate);
        this.options?.onAudioData(buffer);
        if (!this.firstAudioLogged) {
          this.firstAudioLogged = true;
          logPoc(`[poc] stage=first_tutor_audio ms=${Date.now() - this.connectStartedAt}`);
        }
        this.firstAudioWaiter?.resolve();
        return;
      }
      case "input_transcript":
        if (msg.text) {
          this.appendTranscript("user", msg.text);
          this.options?.onTranscript(msg.text, true);
        }
        return;
      case "output_transcript":
        if (msg.text) {
          this.appendTranscript("model", msg.text);
          this.options?.onTranscript(msg.text, false);
        }
        return;
      case "interrupted":
        this.logTurnPlayback(true);
        this.stopAudioPlayback();
        this.options?.onInterrupted?.();
        return;
      case "turnComplete":
        this.logTurnPlayback();
        this.options?.onTurnComplete?.();
        return;
      case "poc_usage":
        this.pocUsage = sanitizePocUsage(msg.usage);
        if (msg.counters && typeof msg.counters === "object") {
          this.stats.last = {
            echoDrops: nonNegInt(msg.counters.echoDrops),
            ttsStreams: nonNegInt(msg.counters.ttsStreams),
            bargeIns: nonNegInt(msg.counters.bargeIns),
            textInterrupts: nonNegInt(msg.counters.textInterrupts),
          };
        }
        return;
      case "poc_turn": {
        const st = this.stats;
        st.turns += 1;
        const f2t = Number(msg.finalToTokenMs);
        const tts = Number(msg.ttsFirstChunkMs);
        const f2a = Number(msg.finalToAudioMs);
        if (Number.isFinite(f2t) && f2t >= 0) st.finalToToken.push(f2t);
        if (Number.isFinite(tts) && tts >= 0) st.ttsFirstChunk.push(tts);
        if (Number.isFinite(f2a) && f2a >= 0) st.finalToAudio.push(f2a);
        st.last = {
          echoDrops: nonNegInt(msg.echoDrops),
          ttsStreams: nonNegInt(msg.ttsStreams),
          bargeIns: nonNegInt(msg.bargeIns),
          textInterrupts: nonNegInt(msg.textInterrupts),
        };
        logPoc(
          `[poc-turn] n=${msg.turn} variant=${this.textVariant} interimToFinal=${msg.interimToFinalMs}ms finalToToken=${msg.finalToTokenMs}ms tokenToAudio=${msg.tokenToAudioMs}ms ttsFirstChunk=${msg.ttsFirstChunkMs ?? -1}ms finalToAudio=${msg.finalToAudioMs}ms ttsModel=${String(msg.ttsFirstModel ?? "?")}`
        );
        return;
      }
      case "error":
        console.warn(`[poc] server_error=${msg.error}`);
        this.firstAudioWaiter?.reject(cascadeError("POC_SERVER_" + String(msg.error), String(msg.error)));
        return;
      default:
        return;
    }
  }

  private send(msg: Record<string, unknown>): boolean {
    const s = this.socket;
    if (!s || !this.ready || s.readyState !== WebSocket.OPEN) return false;
    try {
      s.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  public sendAudioChunk(pcm16kChunk: ArrayBuffer): void {
    this.send({ type: "realtime_audio", audio: this.arrayBufferToBase64(pcm16kChunk), mimeType: "audio/pcm;rate=16000" });
  }

  public sendTextPrompt(prompt: string): boolean {
    return this.send({ type: "text_prompt", text: prompt });
  }

  public appendUserText(text: string): void {
    const trimmed = text?.trim();
    if (!trimmed) return;
    this.appendTranscript("user", trimmed);
    this.options?.onTranscript(trimmed, true);
  }

  public sendControlCommand(command: LiveCommand): void {
    this.send({ type: "control_command", command });
  }

  public getLiveTranscript(): LiveTranscriptItem[] {
    return [...this.transcriptItems];
  }

  public getResumeToken(): string | null {
    return null;
  }

  public getMediaStream(): MediaStream | null {
    return this.mediaStream;
  }

  public getConnectionStats(): { connectionPath: "direct" | "proxy"; directFailCount: number } {
    return { connectionPath: "proxy", directFailCount: 0 };
  }

  public getPocUsage(): PocUsageTotals {
    return addPocUsage(this.pocUsageBase, this.pocUsage);
  }

  private appendTranscript(role: "user" | "model", text: string): void {
    if (!text || !text.trim()) return;
    const last = this.transcriptItems[this.transcriptItems.length - 1];
    let item: LiveTranscriptItem;
    if (last && last.role === role) {
      last.text += " " + text.trim();
      item = last;
    } else {
      item = { role, text: text.trim(), timestamp: Date.now() };
      this.transcriptItems.push(item);
    }
    this.options?.onTranscriptLogged?.(item, [...this.transcriptItems]);
  }

  private static readonly MIC_RELEASE_WAIT_MS = 2000;
  private static readonly MIC_CONSTRAINTS: MediaStreamConstraints = {
    audio: {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };

  /** Resolves true when the mic is live for this connect; false when it was released (hang-up/fallback). */
  private async initAudioCapture(gen: number): Promise<boolean> {
    const stale = () => this.closing || gen !== this.generation;
    if (this.mediaStream) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      const e: any = new Error("이 브라우저에서는 마이크를 쓸 수 없어요.");
      e.code = "MIC_UNAVAILABLE";
      throw e;
    }
    try {
      const session = (navigator as any).audioSession;
      if (session && session.type !== "play-and-record") session.type = "play-and-record";
    } catch {
      // ignore
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(CascadePocProvider.MIC_CONSTRAINTS);
      if (stale()) {
        // Hung up or fell back while the permission prompt was open: release the mic right away.
        stream.getTracks().forEach((tr) => tr.stop());
        return false;
      }
      this.mediaStream = stream;
    } catch (err: any) {
      const name = err?.name || "";
      const e: any = new Error(
        name === "NotAllowedError" || name === "SecurityError"
          ? "마이크 권한이 꺼져 있어요. 브라우저 주소창의 마이크 권한을 허용해 주세요."
          : "마이크를 찾지 못했어요. 이어폰·브라우저 권한을 확인해 주세요."
      );
      e.code = "MIC_UNAVAILABLE";
      e.cause = err;
      throw e;
    }
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.inputAudioCtx = new AudioContextClass({ sampleRate: 16000 });
    if (this.inputAudioCtx.state === "suspended") await this.inputAudioCtx.resume().catch(() => {});
    if (stale() || !this.inputAudioCtx || !this.mediaStream) return false;
    const source = this.inputAudioCtx.createMediaStreamSource(this.mediaStream);
    this.recordDest = this.inputAudioCtx.createMediaStreamDestination();
    source.connect(this.recordDest);
    if (this.micCommitted) this.options?.onMediaStreamReady?.(this.recordDest.stream);
    this.processorNode = this.inputAudioCtx.createScriptProcessor(2048, 1, 1);
    this.processorNode.onaudioprocess = (e) => {
      if (!this.ready) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.sendAudioChunk(pcm16.buffer);
    };
    source.connect(this.processorNode);
    this.processorNode.connect(this.inputAudioCtx.destination);
    return true;
  }

  private async initAudioPlayback(): Promise<void> {
    if (this.outputAudioCtx) return;
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.outputAudioCtx = new AudioContextClass({ sampleRate: 24000 });
    this.playbackScheduler = createScheduler(this.outputAudioCtx.currentTime);
    this.playbackOut = this.outputAudioCtx.destination;
    // Same call-route trick as the normal engine: play through an <audio> element.
    try {
      const dest = this.outputAudioCtx.createMediaStreamDestination();
      const el = new Audio();
      el.autoplay = true;
      el.setAttribute("playsinline", "");
      el.srcObject = dest.stream;
      await el.play();
      this.playbackEl = el;
      this.playbackOut = dest;
    } catch (err) {
      console.warn("[poc] stage=playback_route destination (media element failed)", err);
    }
    if (this.outputAudioCtx.state === "suspended") await this.outputAudioCtx.resume().catch(() => {});
  }

  private playAudioChunk(pcmBuffer: ArrayBuffer, sampleRate: number): void {
    if (!this.outputAudioCtx) return;
    const evenBytes = pcmBuffer.byteLength - (pcmBuffer.byteLength % 2);
    if (evenBytes <= 0) return;
    const pcm16 = new Int16Array(pcmBuffer, 0, evenBytes / 2);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768.0;
    const audioBuffer = this.outputAudioCtx.createBuffer(1, float32.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32);
    const source = this.outputAudioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.playbackOut || this.outputAudioCtx.destination);
    const { startTime, newUtterance } = scheduleChunk(this.playbackScheduler, {
      now: this.outputAudioCtx.currentTime,
      durationSec: audioBuffer.duration,
    });
    this.turnPlay.chunks += 1;
    // A "new utterance" after the first chunk of a turn is an audible hole of 1 s or more.
    if (newUtterance && this.turnPlay.chunks > 1) this.turnPlay.gaps += 1;
    source.start(startTime);
    this.activeSources.push(source);
    source.onended = () => {
      const idx = this.activeSources.indexOf(source);
      if (idx !== -1) this.activeSources.splice(idx, 1);
    };
  }

  /** One line per tutor turn: scheduler underruns, lead buffer and 1 s+ holes in this turn. */
  private logTurnPlayback(interrupted: boolean = false): void {
    const s = this.playbackScheduler;
    const p = this.turnPlay;
    p.turn += 1;
    logPoc(
      `[poc-play] n=${p.turn} chunks=${p.chunks} underruns=${s.underruns - p.underrunsAtStart} gaps=${p.gaps} leadMs=${Math.round(s.leadSec * 1000)}${interrupted ? " interrupted=1" : ""}`
    );
    this.turnPlay = { chunks: 0, underrunsAtStart: s.underruns, gaps: 0, turn: p.turn };
  }

  private stopAudioPlayback(): void {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        // ignore
      }
    }
    this.activeSources = [];
    if (this.outputAudioCtx) resetScheduler(this.playbackScheduler, this.outputAudioCtx.currentTime);
  }

  public async disconnect(notifyClosed: boolean = true): Promise<void> {
    this.closing = true;
    this.logSummary();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cancelOpen?.(cascadeError("POC_CANCELLED", "disconnected"));
    this.firstAudioWaiter?.reject(cascadeError("POC_CANCELLED", "disconnected"));
    this.micCommitted = false;
    this.generation++;
    this.ready = false;
    const s = this.socket;
    this.socket = null;
    if (s) {
      try {
        s.onclose = null;
        s.close(1000, "client disconnect");
      } catch {
        // ignore
      }
    }
    this.stopAudioPlayback();
    if (this.processorNode) {
      try {
        this.processorNode.disconnect();
      } catch {
        // ignore
      }
      this.processorNode = null;
    }
    this.recordDest = null;
    if (this.inputAudioCtx) {
      await this.inputAudioCtx.close().catch(() => {});
      this.inputAudioCtx = null;
    }
    if (this.playbackEl) {
      try {
        this.playbackEl.pause();
        this.playbackEl.srcObject = null;
      } catch {
        // ignore
      }
      this.playbackEl = null;
    }
    if (this.outputAudioCtx) {
      await this.outputAudioCtx.close().catch(() => {});
      this.outputAudioCtx = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    // A mic request still in flight (permission prompt) is released by initAudioCapture() once it
    // settles; wait briefly for that so the fallback engine never opens a second mic beside it.
    const micInit = this.micInit;
    this.micInit = null;
    if (micInit) {
      let capTimer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        micInit,
        new Promise<void>((r) => {
          capTimer = setTimeout(r, CascadePocProvider.MIC_RELEASE_WAIT_MS);
        }),
      ]);
      if (capTimer) clearTimeout(capTimer);
    }
    if (notifyClosed) this.options?.onStatusChange("closed");
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
}
