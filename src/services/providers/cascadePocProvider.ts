/**
 * Google-streaming test mode (PoC) Live provider.
 *
 * Browser side only does mic capture (16 kHz PCM), playback (24 kHz PCM through the shared
 * playback scheduler) and UI callbacks. Transcription (gemini-3.5-transcribe-live), the tutor
 * reply (gemini-3.1-flash-lite) and speech (gemini-3.8-flash-lite-tts) all run on the server
 * WebSocket POC_WS_PATH, so no key ever reaches the browser.
 *
 * connect() REJECTS when the server is not ready within CASCADE_READY_TIMEOUT_MS (8 s), or the
 * tutor's first sentence (text + speech) does not arrive within CASCADE_FIRST_AUDIO_TIMEOUT_MS
 * (8 s) after that; PocFallbackProvider then connects the normal engine for this call. The mic
 * opens only after both, so a fallback never leaves a second mic stream behind.
 */
import { normalizeVoiceName } from "../../config/voices";
import { POC_WS_PATH, emptyPocUsage, sanitizePocUsage, type PocUsageTotals } from "../../config/cascadePoc";
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

export const CASCADE_READY_TIMEOUT_MS = 8000;
export const CASCADE_FIRST_AUDIO_TIMEOUT_MS = 8000;
const MAX_RECONNECTS = 3;

function cascadeError(code: string, message: string): Error {
  const e: any = new Error(message);
  e.code = code;
  return e;
}

export class CascadePocProvider implements PocCapableProvider {
  public name = "cascade-poc";

  private options: LiveSessionOptions | null = null;
  private socket: WebSocket | null = null;
  private ready = false;
  private closing = false;
  private reconnects = 0;
  private generation = 0;
  private connectStartedAt = 0;
  private firstAudioLogged = false;
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
  private pocUsage: PocUsageTotals = emptyPocUsage();

  public async connect(options: LiveSessionOptions): Promise<void> {
    const gen = ++this.generation;
    this.options = options;
    this.closing = false;
    this.reconnects = 0;
    this.firstAudioLogged = false;
    this.connectStartedAt = Date.now();
    options.onStatusChange("connecting", LIVE_STATUS_TEXT.preparing);
    console.log("[poc] stage=connect_start");

    // Speaker first (same order as the normal engine, keeps autoplay close to the tap), then the
    // server; the mic opens only after "ready" so a fallback never leaves a second mic stream
    // or chunk recorder behind (disconnect() closes the speaker on fallback).
    await this.initAudioPlayback().catch((err) => console.warn("[poc] stage=playback_init_failed", err));
    await this.openSocket(gen);
    if (gen !== this.generation) throw cascadeError("POC_CANCELLED", "cancelled");
    await this.kickoffAndWaitFirstAudio();
    if (gen !== this.generation) throw cascadeError("POC_CANCELLED", "cancelled");
    if (!options.skipMic) {
      await this.initAudioCapture().catch((err: any) => {
        console.warn("[poc] stage=mic_failed", err?.cause || err);
        this.options?.onMicWarning?.(
          err?.message || "마이크를 쓸 수 없어요. 튜터 목소리는 들을 수 있지만 말하려면 마이크를 확인해 주세요."
        );
      });
    }
    if (gen !== this.generation) throw cascadeError("POC_CANCELLED", "cancelled");
    options.onStatusChange("connected", LIVE_STATUS_TEXT.connected);
    console.log(`[poc] stage=connected ms=${Date.now() - this.connectStartedAt}`);
  }

  /** Sends the kickoff and waits for the tutor's first audio (proves text + speech both work). */
  private kickoffAndWaitFirstAudio(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.firstAudioWaiter = null;
        reject(cascadeError("POC_FIRST_AUDIO_TIMEOUT", `no tutor audio in ${CASCADE_FIRST_AUDIO_TIMEOUT_MS}ms`));
      }, CASCADE_FIRST_AUDIO_TIMEOUT_MS);
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
  private async openSocket(gen: number): Promise<void> {
    let idToken = "";
    try {
      idToken = (await auth.currentUser?.getIdToken()) || "";
    } catch (e) {
      console.warn("[poc] stage=id_token_failed", e);
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}${POC_WS_PATH}?token=${encodeURIComponent(idToken)}`;
    const history = this.transcriptItems.slice(-80).map((t) => ({ role: t.role, text: t.text }));

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      this.ready = false;
      let settled = false;
      const timer = setTimeout(() => fail("POC_READY_TIMEOUT", `cascade not ready in ${CASCADE_READY_TIMEOUT_MS}ms`), CASCADE_READY_TIMEOUT_MS);
      const fail = (code: string, msg: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // ignore
        }
        if (this.socket === socket) this.socket = null;
        reject(cascadeError(code, msg));
      };

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: "init",
            systemInstruction: this.options?.systemPrompt || "",
            voiceName: normalizeVoiceName(this.options?.voiceName),
            history,
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
            this.ready = true;
            console.log(`[poc] stage=ready ms=${Date.now() - this.connectStartedAt}`);
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
    this.stopAudioPlayback();
    this.options?.onStatusChange("reconnecting", "연결이 잠깐 끊겼어요. 다시 연결하는 중...");
    setTimeout(() => {
      if (this.closing || gen !== this.generation) return;
      this.openSocket(gen)
        .then(() => this.options?.onStatusChange("connected", LIVE_STATUS_TEXT.connected))
        .catch((err) => {
          console.warn("[poc] stage=reconnect_failed", err?.code || err);
          this.handleDrop(gen, -1);
        });
    }, 1000);
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
          console.log(`[poc] stage=first_tutor_audio ms=${Date.now() - this.connectStartedAt}`);
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
        this.stopAudioPlayback();
        this.options?.onInterrupted?.();
        return;
      case "turnComplete":
        this.options?.onTurnComplete?.();
        return;
      case "poc_usage":
        this.pocUsage = sanitizePocUsage(msg.usage);
        return;
      case "poc_turn":
        console.log(
          `[poc-turn] n=${msg.turn} interimToFinal=${msg.interimToFinalMs}ms finalToToken=${msg.finalToTokenMs}ms tokenToAudio=${msg.tokenToAudioMs}ms finalToAudio=${msg.finalToAudioMs}ms`
        );
        return;
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
    return { ...this.pocUsage };
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

  private static readonly MIC_CONSTRAINTS: MediaStreamConstraints = {
    audio: {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };

  private async initAudioCapture(): Promise<void> {
    if (this.mediaStream) return;
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
      this.mediaStream = await navigator.mediaDevices.getUserMedia(CascadePocProvider.MIC_CONSTRAINTS);
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
    const source = this.inputAudioCtx.createMediaStreamSource(this.mediaStream);
    this.recordDest = this.inputAudioCtx.createMediaStreamDestination();
    source.connect(this.recordDest);
    this.options?.onMediaStreamReady?.(this.recordDest.stream);
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
    const { startTime } = scheduleChunk(this.playbackScheduler, {
      now: this.outputAudioCtx.currentTime,
      durationSec: audioBuffer.duration,
    });
    source.start(startTime);
    this.activeSources.push(source);
    source.onended = () => {
      const idx = this.activeSources.indexOf(source);
      if (idx !== -1) this.activeSources.splice(idx, 1);
    };
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
    this.firstAudioWaiter?.reject(cascadeError("POC_CANCELLED", "disconnected"));
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
