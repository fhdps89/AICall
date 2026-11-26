import {
  POC_STT_MODEL,
  POC_TEXT_MODEL,
  POC_TTS_MODEL,
  emptyPocUsage,
  pocCostUsd,
} from "../src/config/cascadePoc.ts";
import type { PocUsageTotals } from "../src/config/cascadePoc.ts";
import {
  POC_VOICE_ADDENDUM,
  splitSentences,
  flushSentences,
  stripMarkdownForSpeech,
  ttsAudioToPcm,
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
    signal: AbortSignal;
  }): Promise<AsyncIterable<{ text?: string; usageMetadata?: any }>>;
  synthesize(req: {
    text: string;
    voiceName: string;
    signal: AbortSignal;
  }): Promise<{ audio: Uint8Array; mimeType: string; usageMetadata?: any }>;
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
}

export const CASCADE_SETTLE_MS = 400;
export const STT_ROTATE_AFTER_MS = 9 * 60 * 1000;
export const STT_CONNECT_TIMEOUT_MS = 7000;

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
  models: { stt: string; text: string; tts: string },
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

    async streamText({ systemInstruction, contents, signal }) {
      const request = (withThinking: boolean) =>
        ai.models.generateContentStream({
          model: models.text,
          contents,
          config: {
            systemInstruction,
            abortSignal: signal,
            ...(withThinking ? { thinkingConfig: { thinkingLevel: "minimal" } } : {}),
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
            yield {
              text: typeof chunk?.text === "string" ? chunk.text : undefined,
              usageMetadata: chunk?.usageMetadata,
            };
          }
        },
      };
    },

    async synthesize({ text, voiceName, signal }) {
      const response = await ai.models.generateContent({
        model: models.tts,
        contents: [{ role: "user", parts: [{ text }] }],
        config: {
          responseModalities: ["AUDIO"],
          abortSignal: signal,
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      });
      const parts = response?.candidates?.[0]?.content?.parts;
      const audioPart = Array.isArray(parts)
        ? parts.find(
            (p: any) =>
              typeof p?.inlineData?.data === "string" &&
              (!p.inlineData.mimeType ||
                String(p.inlineData.mimeType).startsWith("audio/")),
          )
        : undefined;
      if (!audioPart?.inlineData?.data) {
        throw new Error("TTS returned no audio data");
      }
      const audio = new Uint8Array(
        Buffer.from(audioPart.inlineData.data, "base64"),
      );
      const mimeType =
        typeof audioPart.inlineData.mimeType === "string"
          ? audioPart.inlineData.mimeType
          : "audio/wav";
      return {
        audio,
        mimeType,
        usageMetadata: response?.usageMetadata,
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
  private turnSpokenSentences: string[];
  private currentTutorText: string;
  private speakingUntil: number;
  private bargeIns: number;
  private finalToAudioSamples: number[];
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
    this.turnSpokenSentences = [];
    this.currentTutorText = "";
    this.speakingUntil = 0;
    this.bargeIns = 0;
    this.finalToAudioSamples = [];
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
        models: {
          stt: POC_STT_MODEL,
          text: POC_TEXT_MODEL,
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
    const usd = pocCostUsd(u, this.clock.now()).toFixed(4);
    this.log(
      `[poc-summary] turns=${u.turns} medianFinalToAudio=${med}ms p90FinalToAudio=${p90}ms bargeIns=${this.bargeIns} sttAudioSec=${u.sttAudioSec.toFixed(2)} ttsAudioSec=${u.ttsAudioSec.toFixed(2)} usd=${usd}`,
    );
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
        this.log("[poc] echo_dropped");
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

    void this.runTutorTurn({ finalAt, interimToFinalMs });
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
    void this.runTutorTurn({ finalAt: this.clock.now(), interimToFinalMs: 0 });
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
    this.deps.send({ type: "poc_usage", usage: this.usage() });
    this.log(`[poc] barge_in reason=${reason}`);
  }

  private async runTutorTurn(timing: {
    finalAt: number;
    interimToFinalMs: number;
  }): Promise<void> {
    if (this.closed) return;

    void this.maybeRotateStt();

    if (this.turnAbort) {
      this.turnAbort.abort();
    }

    const seq = ++this.turnSeq;
    const abortController = new AbortController();
    this.turnAbort = abortController;
    this.turnInProgress = true;
    this.turnAborted = false;
    this.turnSpokenSentences = [];
    this.currentTutorText = "";

    const isAborted = () =>
      this.closed ||
      this.turnAborted ||
      abortController.signal.aborted ||
      seq !== this.turnSeq;

    let firstTokenAt = -1;
    let firstAudioAt = -1;
    let lastTextUsage: any = null;
    let ttsError: unknown = null;
    let ttsChain: Promise<void> = Promise.resolve();

    const enqueueTts = (rawSentence: string) => {
      const sentence = stripMarkdownForSpeech(rawSentence);
      if (!sentence || isAborted()) return;
      // Synthesis starts right away (overlaps the previous sentence); audio is still sent in order.
      const pending = this.deps.ai
        .synthesize({
          text: sentence,
          voiceName: this.init.voiceName,
          signal: abortController.signal,
        })
        .then((res) => {
          // Billed even when a barge-in drops it, so count it before the abort check.
          const decoded = ttsAudioToPcm(res.audio, res.mimeType);
          const sec = pcmSeconds(decoded.pcm.byteLength, decoded.sampleRate);
          this.totals.ttsAudioSec += sec;
          const promptTok = res.usageMetadata?.promptTokenCount;
          this.totals.ttsInTokens +=
            typeof promptTok === "number" && Number.isFinite(promptTok) && promptTok >= 0
              ? promptTok
              : estimateTextTokens(sentence);
          return { ...decoded, audioSec: sec };
        });
      pending.catch(() => {}); // surfaced through the chain below
      ttsChain = ttsChain
        .then(async () => {
          if (isAborted() || ttsError) return;
          const { pcm, sampleRate, audioSec } = await pending;
          if (isAborted()) return;
          const now = this.clock.now();
          if (firstAudioAt < 0) firstAudioAt = now;
          this.deps.send({
            type: "audio",
            audio: Buffer.from(
              pcm.buffer,
              pcm.byteOffset,
              pcm.byteLength,
            ).toString("base64"),
            mimeType: `audio/pcm;rate=${sampleRate}`,
          });
          this.deps.send({
            type: "output_transcript",
            text: sentence,
          });
          this.turnSpokenSentences.push(sentence);
          this.speakingUntil = Math.max(now, this.speakingUntil) + audioSec * 1000;
        })
        .catch((err) => {
          if (!ttsError) ttsError = err;
        });
    };

    try {
      const contents = buildContents(this.history);
      const stream = await this.deps.ai.streamText({
        systemInstruction: this.systemInstruction,
        contents,
        signal: abortController.signal,
      });

      let textBuf = "";
      for await (const chunk of stream) {
        if (isAborted()) break;
        if (chunk?.usageMetadata) {
          lastTextUsage = chunk.usageMetadata;
        }
        if (typeof chunk?.text === "string" && chunk.text) {
          if (firstTokenAt < 0) firstTokenAt = this.clock.now();
          this.currentTutorText += chunk.text;
          textBuf += chunk.text;
          const { sentences, rest } = splitSentences(textBuf);
          textBuf = rest;
          for (const s of sentences) {
            enqueueTts(s);
          }
        }
      }

      if (lastTextUsage && typeof lastTextUsage === "object") {
        this.totals.textInTokens += nonNegNum(lastTextUsage.promptTokenCount);
        this.totals.textOutTokens +=
          nonNegNum(lastTextUsage.candidatesTokenCount) +
          nonNegNum(lastTextUsage.thoughtsTokenCount);
      }
      if (isAborted()) return;

      for (const s of flushSentences(textBuf)) {
        enqueueTts(s);
      }

      await ttsChain;
      if (isAborted()) return;
      if (ttsError) throw ttsError;

      this.turnInProgress = false;
      const fullSpoken = this.turnSpokenSentences.join(" ").trim();
      if (fullSpoken) {
        this.history.push({ role: "model", text: fullSpoken });
      }
      this.deps.send({ type: "turnComplete" });
      this.totals.turns += 1;
      this.deps.send({ type: "poc_usage", usage: this.usage() });

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

      this.deps.send({
        type: "poc_turn",
        turn: this.totals.turns,
        interimToFinalMs: i2f,
        finalToTokenMs: f2t,
        tokenToAudioMs: t2a,
        finalToAudioMs: f2a,
      });
      this.log(
        `[poc-turn] n=${this.totals.turns} interimToFinal=${i2f}ms finalToToken=${f2t}ms tokenToAudio=${t2a}ms finalToAudio=${f2a}ms`,
      );
    } catch (err) {
      if (seq === this.turnSeq) {
        this.turnInProgress = false;
      }
      if (isAborted() || isAbortError(err)) {
        return;
      }
      this.log(`[poc] stage=turn_error msg=${errorMessage(err)}`);
      if (!this.closed) {
        this.deps.send({ type: "error", error: "cascade_turn_failed" });
      }
    }
  }
}
