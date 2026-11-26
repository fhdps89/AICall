import {
  POC_STT_MODEL,
  POC_TEXT_VARIANTS,
  parsePocTextVariant,
  POC_TEXT_THINKING_LEVEL,
  POC_TTS_MODEL,
  emptyPocUsage,
  pocCostUsd,
} from "../src/config/cascadePoc.ts";
import type { PocTextVariant, PocUsageTotals } from "../src/config/cascadePoc.ts";
import {
  POC_VOICE_ADDENDUM,
  takeFirstSpeechSegment,
  splitSentences,
  flushSentences,
  stripMarkdownForSpeech,
  pcmSeconds,
  normalizeWords,
  isLikelyEcho,
  shouldBargeIn,
  truncateModelTurnAfterBargeIn,
  buildContents,
  sanitizeHistory,
  median,
  percentile,
  estimateTextTokens,
  endWithUserTurn,
} from "./cascadeText.ts";
import type { ChatTurn } from "./cascadeText.ts";

export interface SttLiveSession {
  sendRealtimeInput(input: {
    audio?: { data: string; mimeType: string };
    audioStreamEnd?: boolean;
  }): void;
  close(): void;
}

export interface CascadeAi {
  connectStt(callbacks: {
    onmessage: (m: any) => void;
    onerror: (e: unknown) => void;
    onclose: () => void;
  }): Promise<SttLiveSession>;
  streamText(req: {
    systemInstruction: string;
    contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    maxOutputTokens: number;
    signal: AbortSignal;
  }): Promise<
    AsyncIterable<{ text?: string; usageMetadata?: any; finishReason?: string }>
  >;
  streamSpeech(req: {
    text: string;
    voiceName: string;
    signal: AbortSignal;
  }): Promise<
    AsyncIterable<{
      audio?: Uint8Array;
      sampleRate?: number;
      usage?: { inputTokens?: number; outputTokens?: number };
    }>
  >;
}

export interface CascadeClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export interface CascadeDeps {
  ai: CascadeAi;
  send: (msg: Record<string, unknown>) => void;
  clock?: CascadeClock;
  log?: (line: string) => void;
}

export interface CascadeInit {
  systemInstruction: string;
  voiceName: string;
  history?: unknown;
  /** Reply-text A/B variant; anything else is treated as "a". */
  textVariant?: unknown;
}

export interface CascadeModels {
  stt: string;
  text: string;
  tts: string;
  /** thinkingConfig.thinkingLevel for the text model (default POC_TEXT_THINKING_LEVEL). */
  thinkingLevel?: string;
}

export const CASCADE_SETTLE_MS = 400;
export const STT_ROTATE_AFTER_MS = 9 * 60 * 1000;
export const STT_CONNECT_TIMEOUT_MS = 7000;
/** Spoken reply cap (visible text, estimated tokens); Done / Model answer turns get the long cap. */
export const POC_REPLY_TOKEN_CAP = 150;
export const POC_LONG_REPLY_TOKEN_CAP = 600;
/**
 * maxOutputTokens counts thinking tokens too (ai.google.dev thinking#token-limits), and a model
 * that hits it mid-thought returns empty output. So the API cap is the reply cap plus this
 * headroom, and the reply itself is cut on our side at the reply cap.
 */
export const POC_THINKING_HEADROOM_TOKENS = 1024;

const PCM_16K_BYTES_PER_SEC = 32000;
/** Final segments this soon after the tutor stops are still checked for speaker echo. */
export const ECHO_GRACE_MS = 1500;
const MAX_ROTATION_BUFFER_BYTES = 5 * PCM_16K_BYTES_PER_SEC;

const DEFAULT_CLOCK: CascadeClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const CONTROL_COMMAND_PROMPTS: Record<string, string> = {
  Done: "Done. (I have finished my answer. Please provide concise feedback, estimated level, and AL upgrade expression under 40 seconds.)",
  Feedback: "Feedback. (Please provide quick feedback on what I just said.)",
  "Model answer": "Model answer. (Please give a 60-second AL model answer to this question using my details.)",
  Pause: "Pause. (Let's pause here. How did I sound in this scene?)",
  Slow: "Please speak a bit slower and enunciate clearly.",
};

export function replyTokenCapFor(prompt: string): number {
  return prompt === CONTROL_COMMAND_PROMPTS.Done ||
    prompt === CONTROL_COMMAND_PROMPTS["Model answer"]
    ? POC_LONG_REPLY_TOKEN_CAP
    : POC_REPLY_TOKEN_CAP;
}

/** API maxOutputTokens for a turn: reply cap + thinking headroom. */
export function maxOutputTokensFor(prompt: string): number {
  return replyTokenCapFor(prompt) + POC_THINKING_HEADROOM_TOKENS;
}

function nonNegNum(v: unknown): number {
  if (typeof v !== "number") return 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function isAbortError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      ((err as any).name === "AbortError" || (err as any).code === "ABORT_ERR"),
  );
}

export function createGeminiCascadeAi(
  ai: any /* GoogleGenAI */,
  models: CascadeModels,
  ttsAi?: any /* GoogleGenAI (v1beta) */,
): CascadeAi {
  return {
    connectStt(callbacks) {
      return ai.live.connect({
        model: models.stt,
        config: {
          responseModalities: ["TEXT"],
          inputAudioTranscription: { languageCodes: [] },
        },
        callbacks,
      });
    },

    async streamText({ systemInstruction, contents, maxOutputTokens, signal }) {
      const request = (withThinking: boolean) =>
        ai.models.generateContentStream({
          model: models.text,
          contents,
          config: {
            systemInstruction,
            maxOutputTokens,
            // No temperature: deprecated and ignored from Gemini 3.6 Flash on, an error in later
            // generations (ai.google.dev whats-new-gemini-3.6#sampling-parameter-deprecation).
            abortSignal: signal,
            ...(withThinking
              ? { thinkingConfig: { thinkingLevel: models.thinkingLevel ?? POC_TEXT_THINKING_LEVEL } }
              : {}),
          },
        });
      let stream: any;
      try {
        stream = await request(true);
      } catch (err) {
        // A model that rejects the thinking setting must not silence the call: retry once
        // with the model default (log the message only, never the request).
        if (signal.aborted || !/thinking/i.test(errorMessage(err))) throw err;
        console.warn(`[poc] stage=text_thinking_rejected msg=${errorMessage(err).slice(0, 160)}`);
        stream = await request(false);
      }
      return {
        async *[Symbol.asyncIterator]() {
          for await (const chunk of stream) {
            const finishReason =
              typeof chunk?.candidates?.[0]?.finishReason === "string"
                ? chunk.candidates[0].finishReason
                : undefined;
            yield {
              text: typeof chunk?.text === "string" ? chunk.text : undefined,
              usageMetadata: chunk?.usageMetadata,
              finishReason,
            };
          }
        },
      };
    },

    async streamSpeech({ text, voiceName, signal }) {
      const client = ttsAi ?? ai;
      const stream = await client.interactions.create(
        {
          model: models.tts,
          input: [{ type: "user_input", content: [{ type: "text", text }] }],
          response_format: {
            type: "audio",
            mime_type: "audio/l16",
            sample_rate: 24000,
          },
          generation_config: {
            speech_config: [{ voice: voiceName }],
          },
          stream: true,
        },
        { fetchOptions: { signal } },
      );
      return {
        async *[Symbol.asyncIterator]() {
          for await (const event of stream) {
            // Interactions can report a failure as an SSE event instead of throwing.
            if (event?.event_type === "error") {
              throw new Error(`tts_stream_error ${String(event?.error?.message || event?.error?.code || "unknown").slice(0, 120)}`);
            }
            if (event?.event_type === "interaction.status_update" && event?.status === "failed") {
              throw new Error("tts_stream_failed");
            }
            const rawUsage =
              event?.event_type === "interaction.completed"
                ? event?.interaction?.usage ?? event?.metadata?.total_usage
                : event?.metadata?.total_usage;
            const usage =
              rawUsage && typeof rawUsage === "object"
                ? {
                    inputTokens:
                      typeof rawUsage.total_input_tokens === "number"
                        ? rawUsage.total_input_tokens
                        : undefined,
                    outputTokens:
                      typeof rawUsage.total_output_tokens === "number"
                        ? rawUsage.total_output_tokens
                        : undefined,
                  }
                : undefined;

            const isAudioDelta =
              event?.event_type === "step.delta" &&
              event?.delta?.type === "audio" &&
              typeof event?.delta?.data === "string" &&
              event.delta.data.length > 0;

            if (isAudioDelta) {
              const audio = new Uint8Array(
                Buffer.from(event.delta.data, "base64"),
              );
              const sr = event.delta.sample_rate;
              const sampleRate =
                typeof sr === "number" && Number.isFinite(sr) && sr > 0
                  ? sr
                  : 24000;
              yield { audio, sampleRate, ...(usage ? { usage } : {}) };
            } else if (usage) {
              yield { usage };
            }
          }
        },
      };
    },
  };
}

interface BufferedAudioChunk {
  data: string;
  mimeType: string;
  bytes: number;
}

export class CascadeSession {
  private deps: CascadeDeps;
  private init: CascadeInit;
  private clock: CascadeClock;
  private log: (line: string) => void;
  private history: ChatTurn[];
  private systemInstruction: string;
  private stt: SttLiveSession | null;
  private sttGen: number;
  private sttStartedAt: number;
  private rotating: boolean;
  /** The old STT session closed or errored while a rotation was in flight. */
  private sttLostDuringRotation: boolean;
  private reconnectAttemptedForGen: number;
  private rotationBuffer: BufferedAudioChunk[];
  private rotationBufferBytes: number;
  private closed: boolean;
  private pendingUserText: string;
  private allFinalUserText: string[];
  private settleTimer: unknown;
  private lastInterimAt: number;
  /** When the last final segment of the pending user turn arrived (turn timing base). */
  private lastFinalAt: number;
  private lastInterimToFinalMs: number;
  private turnSeq: number;
  private turnInProgress: boolean;
  private turnAborted: boolean;
  private turnAbort: AbortController | null;
  /** Text streams still draining after a reply cap (usage only); aborted on close. */
  private textDrains: Set<AbortController>;
  private turnSpokenSentences: string[];
  private currentTutorText: string;
  private speakingUntil: number;
  private bargeIns: number;
  private echoDrops: number;
  private ttsStreams: number;
  private finalToAudioSamples: number[];
  private finalToTokenSamples: number[];
  /** Per turn: first audio chunk latency of the turn's first speech request. */
  private ttsFirstChunkSamples: number[];
  private textVariant: PocTextVariant;
  private totals: PocUsageTotals;
  private sttMeasured: boolean;

  constructor(deps: CascadeDeps, init: CascadeInit) {
    this.deps = deps;
    this.init = init;
    this.clock = deps.clock ?? DEFAULT_CLOCK;
    this.log = deps.log ?? console.log;
    this.history = [];
    this.systemInstruction = "";
    this.stt = null;
    this.sttGen = 0;
    this.sttStartedAt = 0;
    this.rotating = false;
    this.sttLostDuringRotation = false;
    this.reconnectAttemptedForGen = -1;
    this.rotationBuffer = [];
    this.rotationBufferBytes = 0;
    this.closed = false;
    this.pendingUserText = "";
    this.allFinalUserText = [];
    this.settleTimer = null;
    this.lastInterimAt = 0;
    this.lastFinalAt = 0;
    this.lastInterimToFinalMs = -1;
    this.turnSeq = 0;
    this.turnInProgress = false;
    this.turnAborted = false;
    this.turnAbort = null;
    this.textDrains = new Set();
    this.turnSpokenSentences = [];
    this.currentTutorText = "";
    this.speakingUntil = 0;
    this.bargeIns = 0;
    this.echoDrops = 0;
    this.ttsStreams = 0;
    this.finalToAudioSamples = [];
    this.finalToTokenSamples = [];
    this.ttsFirstChunkSamples = [];
    this.textVariant = parsePocTextVariant(init.textVariant);
    this.totals = emptyPocUsage();
    this.sttMeasured = false;
  }

  async start(): Promise<void> {
    if (this.closed) return;
    this.history = sanitizeHistory(this.init.history);
    const baseInstr =
      typeof this.init.systemInstruction === "string"
        ? this.init.systemInstruction.trim()
        : "";
    this.systemInstruction = baseInstr
      ? `${baseInstr}\n\n${POC_VOICE_ADDENDUM}`
      : POC_VOICE_ADDENDUM;

    const gen = ++this.sttGen;
    try {
      const session = await this.connectSttWithTimeout(gen);
      if (this.closed) {
        try {
          session.close();
        } catch {
          // ignore
        }
        return;
      }
      this.stt = session;
      this.sttStartedAt = this.clock.now();
      this.deps.send({
        type: "ready",
        model: "cascade-poc",
        textVariant: this.textVariant,
        models: {
          stt: POC_STT_MODEL,
          text: POC_TEXT_VARIANTS[this.textVariant].model,
          tts: POC_TTS_MODEL,
        },
      });
    } catch (err) {
      this.log(`[poc] stage=connect_failed msg=${errorMessage(err)}`);
      if (!this.closed) {
        this.deps.send({
          type: "fallback_required",
          error: "cascade_connect_failed",
        });
        this.close("connect_failed");
      }
    }
  }

  handleClientMessage(msg: any): void {
    if (this.closed || !msg || typeof msg !== "object") return;

    if (msg.type === "realtime_audio") {
      if (typeof msg.audio !== "string" || !msg.audio) return;
      const bytes = Buffer.byteLength(msg.audio, "base64");
      this.totals.sttAudioSec += bytes / PCM_16K_BYTES_PER_SEC;
      const mimeType = "audio/pcm;rate=16000";

      if (this.rotating) {
        this.rotationBuffer.push({ data: msg.audio, mimeType, bytes });
        this.rotationBufferBytes += bytes;
        while (
          this.rotationBufferBytes > MAX_ROTATION_BUFFER_BYTES &&
          this.rotationBuffer.length > 0
        ) {
          const dropped = this.rotationBuffer.shift()!;
          this.rotationBufferBytes -= dropped.bytes;
        }
      } else if (this.stt) {
        try {
          this.stt.sendRealtimeInput({
            audio: { data: msg.audio, mimeType },
          });
        } catch (err) {
          this.log(`[poc] stage=stt_send_error msg=${errorMessage(err)}`);
        }
      }
      return;
    }

    if (msg.type === "text_prompt") {
      if (typeof msg.text !== "string" || !msg.text.trim()) return;
      this.handleUserTextTurn(msg.text.trim());
      return;
    }

    if (msg.type === "control_command") {
      if (typeof msg.command !== "string" || !msg.command.trim()) return;
      const prompt = CONTROL_COMMAND_PROMPTS[msg.command] ?? msg.command;
      this.handleUserTextTurn(prompt);
      return;
    }

    if (msg.type === "interrupt") {
      this.bargeIn("client");
      return;
    }
  }

  close(_reason?: string): void {
    if (this.closed) return;
    this.closed = true;

    this.turnAborted = true;
    this.turnInProgress = false;
    if (this.turnAbort) {
      this.turnAbort.abort();
      this.turnAbort = null;
    }
    for (const drain of this.textDrains) drain.abort();
    this.textDrains.clear();

    this.clearSettleTimer();

    const s = this.stt;
    this.stt = null;
    this.sttGen++;
    if (s) {
      try {
        s.close();
      } catch {
        // ignore
      }
    }

    this.rotationBuffer = [];
    this.rotationBufferBytes = 0;

    const u = this.usage();
    const med = Math.round(median(this.finalToAudioSamples));
    const p90 = Math.round(percentile(this.finalToAudioSamples, 90));
    const ftMed = Math.round(median(this.finalToTokenSamples));
    const ftP90 = Math.round(percentile(this.finalToTokenSamples, 90));
    const ttsMed = Math.round(median(this.ttsFirstChunkSamples));
    const usd = pocCostUsd(u, this.clock.now(), this.textVariant).toFixed(4);
    this.log(
      `[poc-summary] variant=${this.textVariant} textModel=${POC_TEXT_VARIANTS[this.textVariant].model} turns=${u.turns} medianFinalToToken=${ftMed}ms p90FinalToToken=${ftP90}ms medianTtsFirstChunk=${ttsMed}ms medianFinalToAudio=${med}ms p90FinalToAudio=${p90}ms bargeIns=${this.bargeIns} echoDrops=${this.echoDrops} ttsStreams=${this.ttsStreams} sttAudioSec=${u.sttAudioSec.toFixed(2)} ttsAudioSec=${u.ttsAudioSec.toFixed(2)} usd=${usd}`,
    );
  }

  /** Usage plus the running counters, so the browser [poc-summary] also sees drops after the last finished turn. */
  private sendPocUsage(): void {
    if (this.closed) return;
    this.deps.send({
      type: "poc_usage",
      usage: this.usage(),
      counters: { echoDrops: this.echoDrops, ttsStreams: this.ttsStreams, bargeIns: this.bargeIns },
    });
  }

  usage(): PocUsageTotals {
    const sttOutTokens = this.sttMeasured
      ? this.totals.sttOutTokens
      : estimateTextTokens(this.allFinalUserText.join(" "));
    return {
      sttAudioSec: this.totals.sttAudioSec,
      sttOutTokens,
      sttOutEstimated: !this.sttMeasured,
      textInTokens: this.totals.textInTokens,
      textOutTokens: this.totals.textOutTokens,
      ttsInTokens: this.totals.ttsInTokens,
      ttsAudioSec: this.totals.ttsAudioSec,
      turns: this.totals.turns,
    };
  }

  private connectSttWithTimeout(gen: number): Promise<SttLiveSession> {
    return new Promise<SttLiveSession>((resolve, reject) => {
      let settled = false;
      const timer = this.clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`stt_connect_timeout_${STT_CONNECT_TIMEOUT_MS}ms`));
      }, STT_CONNECT_TIMEOUT_MS);

      this.deps.ai
        .connectStt({
          onmessage: (m) => this.handleSttMessage(gen, m),
          onerror: (e) => this.handleSttError(gen, e),
          onclose: () => this.handleSttClose(gen),
        })
        .then((session) => {
          this.clock.clearTimeout(timer);
          if (settled || this.closed) {
            try {
              session.close();
            } catch {
              // ignore
            }
            return;
          }
          settled = true;
          resolve(session);
        })
        .catch((err) => {
          this.clock.clearTimeout(timer);
          if (settled) return;
          settled = true;
          reject(err);
        });
    });
  }

  private handleSttMessage(gen: number, m: any): void {
    if (this.closed || gen !== this.sttGen) return;

    if (m?.usageMetadata && typeof m.usageMetadata === "object") {
      const cand = nonNegNum(m.usageMetadata.candidatesTokenCount);
      const thoughts = nonNegNum(m.usageMetadata.thoughtsTokenCount);
      this.totals.sttOutTokens += cand + thoughts;
      this.sttMeasured = true;
    }

    const interim =
      typeof m?.serverContent?.interimInputTranscription?.text === "string"
        ? m.serverContent.interimInputTranscription.text
        : "";
    const finalSegment =
      typeof m?.serverContent?.inputTranscription?.text === "string"
        ? m.serverContent.inputTranscription.text
        : "";

    if (interim) {
      this.lastInterimAt = this.clock.now();
      if (
        shouldBargeIn({
          interim,
          tutorSpeaking: this.isTutorSpeaking(),
          tutorRecentText: this.currentTutorText,
        })
      ) {
        this.bargeIn("voice");
      }
      if (this.settleTimer !== null) {
        this.resetSettleTimer();
      }
    }

    if (finalSegment) {
      const trimmed = finalSegment.trim();
      // The tutor's own voice picked up by the mic must not become a user turn.
      if (
        trimmed &&
        (this.isTutorSpeaking() || this.clock.now() < this.speakingUntil + ECHO_GRACE_MS) &&
        isLikelyEcho(trimmed, this.currentTutorText)
      ) {
        this.echoDrops++;
        this.log("[poc] echo_dropped");
        this.sendPocUsage();
        return;
      }
      if (trimmed) {
        this.pendingUserText = this.pendingUserText
          ? `${this.pendingUserText} ${trimmed}`
          : trimmed;
        this.allFinalUserText.push(trimmed);
        const finalNow = this.clock.now();
        if (this.lastInterimAt > 0) this.lastInterimToFinalMs = Math.max(0, Math.round(finalNow - this.lastInterimAt));
        this.lastFinalAt = finalNow;
        this.deps.send({ type: "input_transcript", text: finalSegment });
        if (
          this.isTutorSpeaking() &&
          normalizeWords(trimmed).length >= 2 &&
          !isLikelyEcho(trimmed, this.currentTutorText)
        ) {
          this.bargeIn("final");
        }
        this.resetSettleTimer();
      }
    }
  }

  private handleSttError(gen: number, err: unknown): void {
    if (this.closed || gen !== this.sttGen) return;
    if (this.rotating) this.sttLostDuringRotation = true;
    this.log(`[poc] stage=stt_error msg=${errorMessage(err)}`);
    void this.reconnectSttOnce(gen);
  }

  private handleSttClose(gen: number): void {
    if (this.closed || gen !== this.sttGen) return;
    if (this.rotating) this.sttLostDuringRotation = true;
    this.log("[poc] stage=stt_closed");
    void this.reconnectSttOnce(gen);
  }

  private async reconnectSttOnce(failedGen: number): Promise<void> {
    if (
      this.closed ||
      this.rotating ||
      failedGen !== this.sttGen ||
      this.reconnectAttemptedForGen === failedGen
    ) {
      return;
    }
    this.reconnectAttemptedForGen = failedGen;
    this.rotating = true;
    const oldStt = this.stt;
    const nextGen = this.sttGen + 1;

    try {
      const newStt = await this.connectSttWithTimeout(nextGen);
      if (this.closed) {
        try {
          newStt.close();
        } catch {
          // ignore
        }
        return;
      }
      this.sttGen = nextGen;
      this.stt = newStt;
      this.sttStartedAt = this.clock.now();
      if (oldStt) {
        try {
          oldStt.close();
        } catch {
          // ignore
        }
      }
      this.flushRotationBuffer(newStt);
      this.rotating = false;
      this.log("[poc] stt_reconnected");
    } catch (err) {
      this.rotating = false;
      this.rotationBuffer = [];
      this.rotationBufferBytes = 0;
      this.stt = null;
      this.log(`[poc] stage=stt_reconnect_failed msg=${errorMessage(err)}`);
      if (!this.closed) {
        this.deps.send({ type: "error", error: "stt_closed" });
      }
    }
  }

  private async maybeRotateStt(): Promise<void> {
    if (
      this.closed ||
      this.rotating ||
      !this.stt ||
      this.clock.now() - this.sttStartedAt < STT_ROTATE_AFTER_MS
    ) {
      return;
    }
    this.rotating = true;
    const oldStt = this.stt;
    const nextGen = this.sttGen + 1;

    try {
      const newStt = await this.connectSttWithTimeout(nextGen);
      if (this.closed) {
        try {
          newStt.close();
        } catch {
          // ignore
        }
        return;
      }
      this.sttGen = nextGen;
      this.stt = newStt;
      this.sttStartedAt = this.clock.now();
      try {
        oldStt.close();
      } catch {
        // ignore
      }
      this.flushRotationBuffer(newStt);
      this.rotating = false;
      this.sttLostDuringRotation = false;
      this.log("[poc] stt_rotated");
    } catch (err) {
      this.rotating = false;
      this.log(`[poc] stage=stt_rotate_failed msg=${errorMessage(err)}`);
      if (this.stt === oldStt && !this.sttLostDuringRotation) {
        this.flushRotationBuffer(oldStt);
      } else if (this.sttLostDuringRotation && !this.closed) {
        // The old session died meanwhile: take the normal one-reconnect path (it keeps the
        // buffered audio for the new session, or tells the client stt_closed).
        this.sttLostDuringRotation = false;
        await this.reconnectSttOnce(this.sttGen);
      } else {
        this.rotationBuffer = [];
        this.rotationBufferBytes = 0;
      }
    }
  }

  private flushRotationBuffer(target: SttLiveSession): void {
    const queued = this.rotationBuffer;
    this.rotationBuffer = [];
    this.rotationBufferBytes = 0;
    for (const chunk of queued) {
      try {
        target.sendRealtimeInput({
          audio: { data: chunk.data, mimeType: chunk.mimeType },
        });
      } catch (err) {
        this.log(`[poc] stage=stt_flush_error msg=${errorMessage(err)}`);
        break;
      }
    }
  }

  private clearSettleTimer(): void {
    if (this.settleTimer !== null) {
      this.clock.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private resetSettleTimer(): void {
    this.clearSettleTimer();
    this.settleTimer = this.clock.setTimeout(() => {
      this.settleTimer = null;
      this.endUserTurn();
    }, CASCADE_SETTLE_MS);
  }

  private endUserTurn(): void {
    this.clearSettleTimer();
    // A short remark that did not barge in (e.g. one word) waits until the tutor has finished,
    // so it never cuts the tutor off silently or overlaps two replies.
    if (this.pendingUserText.trim() && !this.closed && this.isTutorSpeaking()) {
      const wait = Math.max(CASCADE_SETTLE_MS, Math.ceil(this.speakingUntil - this.clock.now()));
      this.lastFinalAt = 0; // time the reply from when it can start, not from the deferred remark
      this.settleTimer = this.clock.setTimeout(() => {
        this.settleTimer = null;
        this.endUserTurn();
      }, wait);
      return;
    }
    const text = this.pendingUserText.trim();
    this.pendingUserText = "";
    if (!text || this.closed) return;

    this.history.push({ role: "user", text });
    // Latency is measured from the last final segment (before the 0.4 s settle wait), so
    // finalToAudio includes the settle wait the user actually experiences.
    const finalAt = this.lastFinalAt > 0 ? this.lastFinalAt : this.clock.now();
    const interimToFinalMs = this.lastInterimToFinalMs;
    this.lastInterimAt = 0;
    this.lastFinalAt = 0;
    this.lastInterimToFinalMs = -1;

    void this.runTutorTurn({ finalAt, interimToFinalMs, prompt: text });
  }

  private handleUserTextTurn(text: string): void {
    this.clearSettleTimer();
    // Speech still waiting for its 0.4 s settle belongs before the button/typed prompt.
    const pendingVoice = this.pendingUserText.trim();
    this.pendingUserText = "";
    this.lastFinalAt = 0;
    this.lastInterimToFinalMs = -1;
    if (this.isTutorSpeaking()) {
      this.bargeIn("text");
    }
    if (pendingVoice) this.history.push({ role: "user", text: pendingVoice });
    this.history.push({ role: "user", text });
    void this.runTutorTurn({
      finalAt: this.clock.now(),
      interimToFinalMs: 0,
      prompt: text,
    });
  }

  private isTutorSpeaking(): boolean {
    return this.turnInProgress || this.clock.now() < this.speakingUntil;
  }

  private bargeIn(reason: string): void {
    if (!this.turnInProgress && this.clock.now() >= this.speakingUntil) {
      return;
    }
    const hadStarted = this.turnInProgress;
    this.turnAborted = true;
    this.turnInProgress = false;
    if (this.turnAbort) {
      this.turnAbort.abort();
      this.turnAbort = null;
    }
    if (hadStarted) {
      this.history.push({
        role: "model",
        text: truncateModelTurnAfterBargeIn(this.turnSpokenSentences),
      });
    }
    this.speakingUntil = this.clock.now();
    this.bargeIns++;
    this.deps.send({ type: "interrupted" });
    this.sendPocUsage();
    this.log(`[poc] barge_in reason=${reason}`);
  }

  private async runTutorTurn(timing: {
    finalAt: number;
    interimToFinalMs: number;
    prompt: string;
  }): Promise<void> {
    if (this.closed) return;

    void this.maybeRotateStt();

    if (this.turnAbort) {
      this.turnAbort.abort();
    }

    const seq = ++this.turnSeq;
    const turnNum = this.totals.turns + 1;
    const abortController = new AbortController();
    this.turnAbort = abortController;
    this.turnInProgress = true;
    this.turnAborted = false;
    this.turnSpokenSentences = [];
    this.currentTutorText = "";

    const isCancelled = () =>
      this.closed || this.turnAborted || seq !== this.turnSeq;
    const isAborted = () => isCancelled() || abortController.signal.aborted;

    let firstTokenAt = -1;
    let firstAudioAt = -1;
    /** First-chunk latency of this turn's first speech request (-1 = none). */
    let ttsFirstChunkMs = -1;
    let lastTextUsage: any = null;
    let finishReason: string | undefined = undefined;
    let ttsError: unknown = null;

    interface BufferedPcmChunk {
      audio: Uint8Array;
      sampleRate: number;
      sec: number;
    }
    interface SegmentState {
      text: string;
      sentences: string[];
      transcriptSent: boolean;
    }

    const seg1State: SegmentState = { text: "", sentences: [], transcriptSent: false };
    const seg2State: SegmentState = { text: "", sentences: [], transcriptSent: false };
    let seg1Started = false;
    let seg1Used = 0;
    let seg1Finished = false;
    let seg1Promise: Promise<void> | null = null;
    let seg2Promise: Promise<void> | null = null;
    let seg2Buffer: BufferedPcmChunk[] = [];

    const sendAudioChunk = (chunk: BufferedPcmChunk, segState: SegmentState) => {
      if (isAborted() || ttsError) return;
      const now = this.clock.now();
      if (firstAudioAt < 0) firstAudioAt = now;
      this.deps.send({
        type: "audio",
        audio: Buffer.from(
          chunk.audio.buffer,
          chunk.audio.byteOffset,
          chunk.audio.byteLength,
        ).toString("base64"),
        mimeType: `audio/pcm;rate=${chunk.sampleRate}`,
      });
      if (!segState.transcriptSent) {
        segState.transcriptSent = true;
        this.deps.send({
          type: "output_transcript",
          text: segState.text,
        });
        this.turnSpokenSentences.push(...segState.sentences);
      }
      this.speakingUntil = Math.max(now, this.speakingUntil) + chunk.sec * 1000;
    };

    const startSpeechStream = (
      seg: 1 | 2,
      segmentText: string,
      segmentSentences: string[],
    ): Promise<void> => {
      const segState = seg === 1 ? seg1State : seg2State;
      segState.text = segmentText;
      segState.sentences = segmentSentences;
      segState.transcriptSent = false;
      this.ttsStreams++;

      const startedAt = this.clock.now();
      let firstChunkAt = -1;
      let chunks = 0;
      let streamAudioSec = 0;
      let reportedInTokens: number | null = null;
      let failed = false;

      const run = async () => {
        try {
          const speechStream = await this.deps.ai.streamSpeech({
            text: segmentText,
            voiceName: this.init.voiceName,
            signal: abortController.signal,
          });
          for await (const item of speechStream) {
            if (
              item?.usage &&
              typeof item.usage.inputTokens === "number" &&
              Number.isFinite(item.usage.inputTokens) &&
              item.usage.inputTokens >= 0
            ) {
              reportedInTokens = item.usage.inputTokens;
            }
            if (item?.audio && item.audio.byteLength > 0) {
              const sampleRate =
                typeof item.sampleRate === "number" &&
                Number.isFinite(item.sampleRate) &&
                item.sampleRate > 0
                  ? item.sampleRate
                  : 24000;
              const sec = pcmSeconds(item.audio.byteLength, sampleRate);
              // Billed even when a barge-in drops it, so count every received chunk.
              this.totals.ttsAudioSec += sec;
              if (firstChunkAt < 0) firstChunkAt = this.clock.now();
              chunks++;
              streamAudioSec += sec;

              if (!isAborted() && !ttsError) {
                if (seg === 1 || seg1Finished) {
                  sendAudioChunk({ audio: item.audio, sampleRate, sec }, segState);
                } else {
                  seg2Buffer.push({ audio: item.audio, sampleRate, sec });
                }
              }
            }
          }
        } catch (err) {
          failed = true;
          if (!isCancelled() && !isAbortError(err) && !ttsError) {
            ttsError = err;
            abortController.abort();
          }
        } finally {
          if (reportedInTokens !== null) {
            this.totals.ttsInTokens += reportedInTokens;
          } else if (!failed || chunks > 0) {
            this.totals.ttsInTokens += estimateTextTokens(segmentText);
          }
          const firstChunkMs =
            firstChunkAt >= 0 ? Math.max(0, Math.round(firstChunkAt - startedAt)) : -1;
          if (seg === 1) ttsFirstChunkMs = firstChunkMs;
          const totalMs = Math.max(0, Math.round(this.clock.now() - startedAt));
          this.log(
            `[poc-tts] n=${turnNum} seg=${seg} chars=${segmentText.length} firstChunkMs=${firstChunkMs} chunks=${chunks} audioSec=${streamAudioSec.toFixed(2)} totalMs=${totalMs}`,
          );
          // A cancelled turn already reported usage at barge-in time; chunks and tokens counted
          // after that would otherwise only reach the client with the next completed turn.
          if (isCancelled() && !this.closed) {
            this.sendPocUsage();
          }
          if (seg === 1) {
            seg1Finished = true;
            if (!isAborted() && !ttsError && seg2Buffer.length > 0) {
              const queued = seg2Buffer;
              seg2Buffer = [];
              for (const c of queued) {
                if (isAborted() || ttsError) break;
                sendAudioChunk(c, seg2State);
              }
            } else {
              seg2Buffer = [];
            }
          }
        }
      };

      const p = run();
      p.catch(() => {});
      return p;
    };

    try {
      const contents = endWithUserTurn(buildContents(this.history));
      const replyCap = replyTokenCapFor(timing.prompt);
      let replyCapped = false;
      // The text stream follows the turn's abort until the reply cap; after that it keeps
      // draining (billed usage) even if the turn is interrupted or the next turn starts.
      const textAbort = new AbortController();
      abortController.signal.addEventListener("abort", () => {
        if (!replyCapped) textAbort.abort();
      });
      if (abortController.signal.aborted) textAbort.abort();
      const stream = await this.deps.ai.streamText({
        systemInstruction: this.systemInstruction,
        contents,
        maxOutputTokens: maxOutputTokensFor(timing.prompt),
        signal: textAbort.signal,
      });

      const collected: string[] = [];
      let textBuf = "";
      // Starts speech for whatever of the reply is not spoken yet (end of text or reply cap).
      const startRemainingSpeech = (): void => {
        if (!seg1Started && !isAborted()) {
          const first = takeFirstSpeechSegment(collected, true);
          if (first) {
            seg1Started = true;
            seg1Used = first.used;
            seg1Promise = startSpeechStream(1, first.segment, collected.slice(0, first.used));
          }
        }
        // Independent of the branch above: a cap can arrive with 3+ sentences before stream 1
        // started, and stream 2 buffers its audio until stream 1 is done.
        if (seg1Started && !seg2Promise && collected.length > seg1Used && !isAborted() && !ttsError) {
          const restSentences = collected.slice(seg1Used);
          const restText = restSentences.join(" ");
          if (restText) {
            seg2Promise = startSpeechStream(2, restText, restSentences);
          }
        }
      };
      const addTextUsage = (usage: any): void => {
        if (!usage || typeof usage !== "object") return;
        this.totals.textInTokens += nonNegNum(usage.promptTokenCount);
        this.totals.textOutTokens +=
          nonNegNum(usage.candidatesTokenCount) + nonNegNum(usage.thoughtsTokenCount);
      };
      const capReply = (): void => {
        // Cut at the last complete sentence; later text is never spoken or echo-checked.
        replyCapped = true;
        textBuf = "";
        this.currentTutorText = collected.join(" ");
        this.log("[poc] stage=reply_capped");
        startRemainingSpeech();
      };
      // Manual iteration: after the cap the turn goes on with speech while the rest of the
      // stream is drained in the background, only for its billed usage (thinking included).
      const iter = stream[Symbol.asyncIterator]();
      for (;;) {
        const step = await iter.next();
        if (step.done) break;
        const chunk = step.value;
        if (isAborted()) break;
        if (chunk?.usageMetadata) {
          lastTextUsage = chunk.usageMetadata;
        }
        if (typeof chunk?.finishReason === "string" && chunk.finishReason) {
          finishReason = chunk.finishReason;
        }
        if (typeof chunk?.text === "string" && chunk.text) {
          if (firstTokenAt < 0) firstTokenAt = this.clock.now();
          this.currentTutorText += chunk.text;
          textBuf += chunk.text;
          const { sentences, rest } = splitSentences(textBuf);
          textBuf = rest;
          for (const raw of sentences) {
            const s = stripMarkdownForSpeech(raw);
            if (!s) continue;
            if (collected.length > 0 && estimateTextTokens([...collected, s].join(" ")) > replyCap) {
              capReply();
              break;
            }
            collected.push(s);
          }
          if (
            !replyCapped &&
            textBuf &&
            estimateTextTokens([...collected, textBuf].join(" ")) > replyCap
          ) {
            // The unfinished sentence would pass the cap: drop it. With nothing complete yet
            // (no sentence end at all), speak what came, cut mid-sentence.
            if (collected.length === 0) {
              const forced = stripMarkdownForSpeech(textBuf);
              if (forced) collected.push(forced);
            }
            capReply();
          }
          if (!replyCapped && !seg1Started && !isAborted()) {
            const first = takeFirstSpeechSegment(collected, false);
            if (first) {
              seg1Started = true;
              seg1Used = first.used;
              seg1Promise = startSpeechStream(
                1,
                first.segment,
                collected.slice(0, first.used),
              );
            }
          }
          if (!replyCapped && estimateTextTokens(collected.join(" ")) >= replyCap) {
            capReply();
          }
          if (replyCapped) break;
        }
      }

      if (replyCapped && !this.closed) {
        this.textDrains.add(textAbort);
        void (async () => {
          let usage: any = lastTextUsage;
          try {
            for (;;) {
              const step = await iter.next();
              if (step.done) break;
              if (step.value?.usageMetadata) usage = step.value.usageMetadata;
            }
          } catch {
            // Aborted (barge-in / close) or failed after the cap: keep what was seen.
          }
          this.textDrains.delete(textAbort);
          addTextUsage(usage);
          this.sendPocUsage();
        })();
      } else {
        addTextUsage(lastTextUsage);
      }
      if (isCancelled()) {
        // bargeIn already sent poc_usage before this turn's text usage was added.
        this.sendPocUsage();
        return;
      }

      const tail = flushSentences(textBuf)
        .map(stripMarkdownForSpeech)
        .filter(Boolean);
      if (replyCapped) {
        // Speech for the capped reply already started inside the loop.
      } else if (finishReason === "MAX_TOKENS" && collected.length > 0) {
        this.log("[poc] stage=reply_capped");
        startRemainingSpeech();
      } else {
        for (const s of tail) {
          if (collected.length > 0 && estimateTextTokens([...collected, s].join(" ")) > replyCap) {
            this.log("[poc] stage=reply_capped");
            break;
          }
          collected.push(s);
        }
        startRemainingSpeech();
      }

      if (collected.length === 0) {
        // e.g. thinking used the whole maxOutputTokens: visible in logs, turn ends quietly.
        this.log(`[poc] stage=reply_empty finish=${finishReason ?? "none"}`);
      }

      const pendingStreams: Promise<void>[] = [];
      if (seg1Promise) pendingStreams.push(seg1Promise);
      if (seg2Promise) pendingStreams.push(seg2Promise);
      if (pendingStreams.length > 0) {
        await Promise.all(pendingStreams);
      }

      if (isCancelled()) return;
      if (ttsError) throw ttsError;

      this.turnInProgress = false;
      const fullSpoken = this.turnSpokenSentences.join(" ").trim();
      if (fullSpoken) {
        this.history.push({ role: "model", text: fullSpoken });
      }
      this.deps.send({ type: "turnComplete" });
      this.totals.turns += 1;
      this.sendPocUsage();

      const i2f =
        Number.isFinite(timing.interimToFinalMs) && timing.interimToFinalMs >= 0
          ? Math.round(timing.interimToFinalMs)
          : -1;
      const f2t =
        firstTokenAt >= 0 && timing.finalAt >= 0
          ? Math.max(0, Math.round(firstTokenAt - timing.finalAt))
          : -1;
      const t2a =
        firstAudioAt >= 0 && firstTokenAt >= 0
          ? Math.max(0, Math.round(firstAudioAt - firstTokenAt))
          : -1;
      const f2a =
        firstAudioAt >= 0 && timing.finalAt >= 0
          ? Math.max(0, Math.round(firstAudioAt - timing.finalAt))
          : -1;

      if (f2a >= 0) {
        this.finalToAudioSamples.push(f2a);
      }
      if (f2t >= 0) this.finalToTokenSamples.push(f2t);
      if (ttsFirstChunkMs >= 0) this.ttsFirstChunkSamples.push(ttsFirstChunkMs);

      this.deps.send({
        type: "poc_turn",
        turn: this.totals.turns,
        interimToFinalMs: i2f,
        finalToTokenMs: f2t,
        tokenToAudioMs: t2a,
        finalToAudioMs: f2a,
        ttsFirstChunkMs,
        // Running session counters so the browser can print its own [poc-summary].
        echoDrops: this.echoDrops,
        ttsStreams: this.ttsStreams,
        bargeIns: this.bargeIns,
      });
      this.log(
        `[poc-turn] n=${this.totals.turns} variant=${this.textVariant} interimToFinal=${i2f}ms finalToToken=${f2t}ms tokenToAudio=${t2a}ms ttsFirstChunk=${ttsFirstChunkMs}ms finalToAudio=${f2a}ms`,
      );
    } catch (err) {
      abortController.abort();
      if (seq === this.turnSeq) {
        this.turnInProgress = false;
      }
      if (isCancelled()) return;
      // A speech-stream failure aborts the shared controller, so the text stream may surface as
      // an AbortError: report the speech error instead of ending the turn silently.
      if (isAbortError(err) && !ttsError) return;
      this.log(`[poc] stage=turn_error msg=${errorMessage(ttsError ?? err)}`);
      if (!this.closed) {
        this.deps.send({ type: "error", error: "cascade_turn_failed" });
      }
    }
  }
}
