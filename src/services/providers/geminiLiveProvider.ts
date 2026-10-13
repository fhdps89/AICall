import { LIVE_MODEL } from "../../config/models";
import {
  LiveProvider,
  LiveSessionOptions,
  LiveCommand,
  LiveTranscriptItem,
} from "./types";

/**
 * GeminiLiveProvider
 *
 * Implements B-2 Specification:
 * 1) Real-time conversation with gemini-3.8-live.
 * 2) Session resumption & context window compression enabled.
 * 3) Auto reconnection upon GoAway with "연결 유지 중" status.
 * 4) Ephemeral token direct browser connection with transparent fallback to server proxy.
 * 5) Audio in: 16kHz 16-bit PCM streaming with echo isolation.
 * 6) Audio out: 24kHz gapless playback scheduling.
 * 7) Control commands: Done, Feedback, Model answer, Pause, Slow.
 * 8) Stores live transcript in memory for sessions.liveTranscript.
 */
export class GeminiLiveProvider implements LiveProvider {
  public name = LIVE_MODEL;

  private ws: WebSocket | null = null;
  private options: LiveSessionOptions | null = null;
  private isConnected = false;
  private isReconnecting = false;
  private resumeHandle: string | null = null;

  // Audio contexts
  private inputAudioCtx: AudioContext | null = null;
  private outputAudioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private nextPlaybackTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];

  // Transcript memory
  private transcriptItems: LiveTranscriptItem[] = [];

  // Reconnect timer
  private reconnectTimer: NodeJS.Timeout | null = null;

  public async connect(options: LiveSessionOptions): Promise<void> {
    this.options = options;
    this.options.onStatusChange("connecting", "Gemini Live 연결 준비 중...");

    if (options.resumeToken) {
      this.resumeHandle = options.resumeToken;
    }

    try {
      await this.initAudioCapture();
      await this.initAudioPlayback();
      await this.establishConnection();
    } catch (err: any) {
      console.error("[GeminiLiveProvider] Connect failed:", err);
      this.options.onStatusChange("error", err?.message || "마이크 또는 네트워크 연결에 실패했습니다.");
      throw err;
    }
  }

  private async establishConnection(): Promise<void> {
    // 1. Try Ephemeral Token direct connection
    let directSucceeded = false;
    try {
      const tokenRes = await fetch("/api/gemini/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const tokenData = await tokenRes.json();

      if (tokenData.ok && tokenData.token) {
        console.log("[GeminiLiveProvider] Ephemeral token acquired. Attempting direct connection...");
        try {
          await this.connectDirect(tokenData.token);
          directSucceeded = true;
        } catch (directErr) {
          console.warn("[GeminiLiveProvider] Direct connection failed, switching to server proxy:", directErr);
        }
      }
    } catch {
      // Ephemeral token endpoint unreachable or error -> proceed to fallback
    }

    // 2. Fallback to server proxy WebSocket
    if (!directSucceeded) {
      console.log("[GeminiLiveProvider] Connecting via server proxy WebSocket...");
      await this.connectViaServerProxy();
    }
  }

  /**
   * Direct connection to Gemini Live endpoint using ephemeral token
   */
  private async connectDirect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const directUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
        token
      )}`;

      const socket = new WebSocket(directUrl);
      let opened = false;

      socket.onopen = () => {
        opened = true;
        this.ws = socket;
        this.wireWebSocketEvents(true);

        // Send initial setup payload with session resumption & context compression
        const setupPayload = {
          setup: {
            model: `models/${LIVE_MODEL}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: this.options?.voiceName || "Kore",
                  },
                },
              },
            },
            systemInstruction: {
              parts: [{ text: this.options?.systemPrompt || "" }],
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            sessionResumption: {
              handle: this.resumeHandle || undefined,
              transparent: true,
            },
            contextWindowCompression: {
              slidingWindow: {},
            },
          },
        };

        socket.send(JSON.stringify(setupPayload));
        this.isConnected = true;
        this.isReconnecting = false;
        this.options?.onStatusChange("connected", "Gemini Live 직접 연결 완료");
        resolve();
      };

      socket.onerror = (err) => {
        if (!opened) {
          reject(err);
        } else {
          this.handleDisconnect("direct error");
        }
      };

      socket.onclose = () => {
        if (!opened) {
          reject(new Error("Direct WebSocket closed before opening"));
        } else {
          this.handleDisconnect("direct close");
        }
      };
    });
  }

  /**
   * Fallback connection via Server Proxy WebSocket
   */
  private async connectViaServerProxy(): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      const wsUrl = `${protocol}//${host}/api/gemini/live`;

      const socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        this.ws = socket;
        this.wireWebSocketEvents(false);

        // Send init message to server
        socket.send(
          JSON.stringify({
            type: "init",
            systemInstruction: this.options?.systemPrompt,
            voiceName: this.options?.voiceName || "Kore",
            resumeHandle: this.resumeHandle,
            languageCode: "en-US",
          })
        );
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "ready") {
            this.isConnected = true;
            this.isReconnecting = false;
            this.options?.onStatusChange("connected", "Gemini 3.8 Live 연결됨");
            resolve();
          } else if (data.type === "fallback_required" || data.type === "error") {
            reject(new Error(data.error || "Server proxy live connection failed"));
          } else {
            this.handleIncomingMessage(data, false);
          }
        } catch (err) {
          console.error("[GeminiLiveProvider] Failed to parse proxy message:", err);
        }
      };

      socket.onerror = (err) => {
        if (!this.isConnected) {
          reject(err);
        } else {
          this.handleDisconnect("proxy error");
        }
      };

      socket.onclose = () => {
        this.handleDisconnect("proxy closed");
      };
    });
  }

  private wireWebSocketEvents(isDirect: boolean): void {
    if (!this.ws) return;

    this.ws.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data);
        this.handleIncomingMessage(raw, isDirect);
      } catch (err) {
        console.error("[GeminiLiveProvider] Parse message error:", err);
      }
    };

    this.ws.onerror = (err) => {
      console.warn("[GeminiLiveProvider] WS error:", err);
      this.handleDisconnect("ws error");
    };

    this.ws.onclose = () => {
      this.handleDisconnect("ws close");
    };
  }

  private handleIncomingMessage(msg: any, isDirect: boolean): void {
    if (isDirect) {
      // Standard Direct BidiGenerateContent messages
      if (msg.serverContent) {
        const parts = msg.serverContent.modelTurn?.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (p.inlineData?.data) {
              const buffer = this.base64ToArrayBuffer(p.inlineData.data);
              this.playAudioChunk(buffer);
              this.options?.onAudioData(buffer);
            }
            if (p.text) {
              this.appendTranscript("model", p.text);
              this.options?.onTranscript(p.text, false);
            }
          }
        }

        if (msg.serverContent.inputTranscription?.text) {
          const text = msg.serverContent.inputTranscription.text;
          this.appendTranscript("user", text);
          this.options?.onTranscript(text, true);
        }

        if (msg.serverContent.outputTranscription?.text) {
          const text = msg.serverContent.outputTranscription.text;
          this.appendTranscript("model", text);
          this.options?.onTranscript(text, false);
        }

        if (msg.serverContent.interrupted) {
          this.stopAudioPlayback();
          this.options?.onInterrupted?.();
        }

        if (msg.serverContent.turnComplete) {
          this.options?.onTurnComplete?.();
        }
      }

      // Session Resumption update
      if (msg.sessionResumptionUpdate) {
        if (msg.sessionResumptionUpdate.newHandle) {
          this.resumeHandle = msg.sessionResumptionUpdate.newHandle;
          console.log("[GeminiLiveProvider] Direct session resume handle updated:", this.resumeHandle);
        }
      }

      // GoAway message
      if (msg.goAway) {
        console.warn("[GeminiLiveProvider] Direct GoAway received. Triggering auto-reconnect...");
        this.triggerReconnection();
      }
    } else {
      // Proxy messages from server.ts
      if (msg.type === "audio" && msg.audio) {
        const buffer = this.base64ToArrayBuffer(msg.audio);
        this.playAudioChunk(buffer);
        this.options?.onAudioData(buffer);
      } else if (msg.type === "input_transcript" && msg.text) {
        this.appendTranscript("user", msg.text);
        this.options?.onTranscript(msg.text, true);
      } else if (msg.type === "output_transcript" && msg.text) {
        this.appendTranscript("model", msg.text);
        this.options?.onTranscript(msg.text, false);
      } else if (msg.type === "interrupted") {
        this.stopAudioPlayback();
        this.options?.onInterrupted?.();
      } else if (msg.type === "turnComplete") {
        this.options?.onTurnComplete?.();
      } else if (msg.type === "session_resumption_update" && msg.handle) {
        this.resumeHandle = msg.handle;
        console.log("[GeminiLiveProvider] Proxy session resume handle updated:", this.resumeHandle);
      } else if (msg.type === "go_away") {
        console.warn("[GeminiLiveProvider] Proxy GoAway received. Triggering auto-reconnect...");
        this.triggerReconnection();
      }
    }
  }

  private handleDisconnect(reason: string): void {
    if (!this.isConnected && !this.isReconnecting) return;
    console.warn(`[GeminiLiveProvider] Disconnected (${reason}). Triggering auto-reconnect...`);
    this.triggerReconnection();
  }

  /**
   * Automatic Reconnection upon GoAway or disconnect (B-2 requirement 2)
   */
  private triggerReconnection(): void {
    if (this.isReconnecting) return;
    this.isReconnecting = true;
    this.isConnected = false;

    // Show "연결 유지 중" briefly as requested in B-2
    this.options?.onStatusChange("reconnecting", "연결 유지 중");

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      try {
        console.log("[GeminiLiveProvider] Reconnecting with resume handle:", this.resumeHandle);
        await this.establishConnection();
      } catch (err) {
        console.error("[GeminiLiveProvider] Reconnection attempt failed, retrying in 3s:", err);
        this.isReconnecting = false;
        this.reconnectTimer = setTimeout(() => this.triggerReconnection(), 3000);
      }
    }, 1000);
  }

  private appendTranscript(role: "user" | "model", text: string): void {
    if (!text || !text.trim()) return;
    const last = this.transcriptItems[this.transcriptItems.length - 1];
    if (last && last.role === role) {
      last.text += " " + text.trim();
    } else {
      this.transcriptItems.push({
        role,
        text: text.trim(),
        timestamp: Date.now(),
      });
    }
  }

  public getLiveTranscript(): LiveTranscriptItem[] {
    return [...this.transcriptItems];
  }

  public getResumeToken(): string | null {
    return this.resumeHandle;
  }

  public sendAudioChunk(pcm16kChunk: ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const base64 = this.arrayBufferToBase64(pcm16kChunk);

    if (this.ws.url.includes("generativelanguage.googleapis.com")) {
      // Direct message format
      this.ws.send(
        JSON.stringify({
          realtimeInput: {
            mediaChunks: [
              {
                mimeType: "audio/pcm;rate=16000",
                data: base64,
              },
            ],
          },
        })
      );
    } else {
      // Proxy message format
      this.ws.send(
        JSON.stringify({
          type: "realtime_audio",
          audio: base64,
          mimeType: "audio/pcm;rate=16000",
        })
      );
    }
  }

  public sendTextPrompt(prompt: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this.ws.url.includes("generativelanguage.googleapis.com")) {
      this.ws.send(
        JSON.stringify({
          clientContent: {
            turns: [
              {
                role: "user",
                parts: [{ text: prompt }],
              },
            ],
            turnComplete: true,
          },
        })
      );
    } else {
      this.ws.send(
        JSON.stringify({
          type: "text_prompt",
          text: prompt,
        })
      );
    }
  }

  /**
   * Send control buttons: Done / Feedback / Model answer / Pause / Slow (B-2 requirement 5)
   */
  public sendControlCommand(command: LiveCommand): void {
    const commandPrompts: Record<LiveCommand, string> = {
      Done: "Done. (I have finished my answer. Please provide concise feedback, estimated level, and AL upgrade expression under 40 seconds.)",
      Feedback: "Feedback. (Please provide quick feedback on what I just said.)",
      "Model answer": "Model answer. (Please give a 60-second AL model answer to this question using my details.)",
      Pause: "Pause. (Let's pause here. How did I sound in this scene?)",
      Slow: "Please speak a bit slower and enunciate clearly.",
    };

    const promptText = commandPrompts[command] || command;
    console.log(`[GeminiLiveProvider] Sending command: [${command}] -> "${promptText}"`);
    this.sendTextPrompt(promptText);
  }

  // Audio Capture Setup (16kHz 16-bit PCM little-endian)
  private async initAudioCapture(): Promise<void> {
    if (this.mediaStream) return;

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.inputAudioCtx = new AudioContextClass({ sampleRate: 16000 });

    const source = this.inputAudioCtx.createMediaStreamSource(this.mediaStream);
    // Buffer size 2048 gives ~128ms chunks at 16kHz
    this.processorNode = this.inputAudioCtx.createScriptProcessor(2048, 1, 1);

    this.processorNode.onaudioprocess = (e) => {
      if (!this.isConnected && !this.isReconnecting) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      this.sendAudioChunk(pcm16.buffer);
    };

    source.connect(this.processorNode);
    this.processorNode.connect(this.inputAudioCtx.destination);
  }

  // Audio Playback Setup (24kHz standard for Gemini Live output)
  private async initAudioPlayback(): Promise<void> {
    if (this.outputAudioCtx) return;

    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.outputAudioCtx = new AudioContextClass({ sampleRate: 24000 });
    this.nextPlaybackTime = this.outputAudioCtx.currentTime;
  }

  private playAudioChunk(pcmBuffer: ArrayBuffer): void {
    if (!this.outputAudioCtx) return;

    const pcm16 = new Int16Array(pcmBuffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768.0;
    }

    const audioBuffer = this.outputAudioCtx.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);

    const source = this.outputAudioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.outputAudioCtx.destination);

    const now = this.outputAudioCtx.currentTime;
    const startTime = Math.max(now, this.nextPlaybackTime);
    source.start(startTime);
    this.nextPlaybackTime = startTime + audioBuffer.duration;

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
    if (this.outputAudioCtx) {
      this.nextPlaybackTime = this.outputAudioCtx.currentTime;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.isConnected = false;
    this.isReconnecting = false;

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    this.stopAudioPlayback();

    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }

    if (this.inputAudioCtx) {
      try {
        await this.inputAudioCtx.close();
      } catch {
        // ignore
      }
      this.inputAudioCtx = null;
    }

    if (this.outputAudioCtx) {
      try {
        await this.outputAudioCtx.close();
      } catch {
        // ignore
      }
      this.outputAudioCtx = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    this.options?.onStatusChange("closed", "통화가 정상 종료되었습니다.");
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
