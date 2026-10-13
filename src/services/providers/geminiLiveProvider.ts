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
 * Implements B-2 Specification & 2-1 Fixes:
 * 1) Real-time conversation with gemini-3.8-live.
 * 2) Session resumption & context window compression enabled.
 * 3) Direct connection via BidiGenerateContentConstrained?access_token=${token}.
 * 4) "Connected" determination: Wait for Gemini's setupComplete message (with 8s timeout fallback).
 * 5) Fresh token fetched on every reconnection, with session resumption handle preserved.
 * 6) Connection telemetry: [Live] path=direct or [Live] path=proxy logged, connectionPath & directFailCount tracked.
 * 7) Audio in: 16kHz 16-bit PCM streaming with echo isolation.
 * 8) Audio out: 24kHz gapless playback scheduling.
 * 9) Control commands: Done, Feedback, Model answer, Pause, Slow.
 * 10) Stores live transcript in memory for sessions.liveTranscript.
 */
export class GeminiLiveProvider implements LiveProvider {
  public name = LIVE_MODEL;

  private ws: WebSocket | null = null;
  private options: LiveSessionOptions | null = null;
  private isConnected = false;
  private isReconnecting = false;
  private resumeHandle: string | null = null;

  // Connection path tracking (2-1 requirement 5)
  private connectionPath: "direct" | "proxy" = "direct";
  private directFailCount = 0;
  private onDirectSetupComplete: (() => void) | null = null;

  // Audio contexts
  private inputAudioCtx: AudioContext | null = null;
  private outputAudioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private nextPlaybackTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];

  // Transcript memory
  private transcriptItems: LiveTranscriptItem[] = [];
  private activeSystemPrompt: string = "";

  // Reconnect timer
  private reconnectTimer: NodeJS.Timeout | null = null;

  public async connect(options: LiveSessionOptions): Promise<void> {
    this.options = options;
    this.activeSystemPrompt = options.systemPrompt;
    this.options.onStatusChange("connecting", "Gemini Live 연결 준비 중...");

    if (options.resumeToken) {
      this.resumeHandle = options.resumeToken;
    }

    console.log("[Live] stage=connect_start");

    // Mic is decoupled from the session: start it in parallel and never let it
    // block or fail the connection. On failure we only show guidance.
    const micPromise = this.initAudioCapture()
      .then(() => console.log("[Live] stage=mic_ready"))
      .catch((err: any) => {
        console.warn("[Live] stage=mic_failed", err?.cause || err);
        this.options?.onMicWarning?.(
          err?.message || "마이크를 쓸 수 없어요. 튜터 목소리는 들을 수 있지만 말하려면 마이크를 확인해 주세요."
        );
      });

    try {
      await this.initAudioPlayback().catch((err) => {
        console.warn("[Live] stage=playback_init_failed", err);
      });
      console.log("[Live] stage=establish_connection");
      await this.establishConnection();
      console.log("[Live] stage=connected path=" + this.connectionPath);
    } catch (err: any) {
      console.error("[GeminiLiveProvider] Connect failed:", err);
      // Release anything half-opened so a retry starts clean.
      await this.disconnect().catch(() => {});
      this.options?.onStatusChange(
        "error",
        err?.userMessage || "연결하지 못했어요. 인터넷을 확인하고 다시 시도해 주세요."
      );
      throw err;
    }
    await micPromise;
  }

  private async establishConnection(): Promise<void> {
    // 1. Try Ephemeral Token direct connection (2-1 requirement 1, 2, 3)
    let directSucceeded = false;
    console.log("[Live] stage=token_fetch");
    try {
      const tokenAbort = new AbortController();
      const tokenTimer = setTimeout(() => tokenAbort.abort(), 8000);
      const tokenRes = await fetch("/api/gemini/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: tokenAbort.signal,
      }).finally(() => clearTimeout(tokenTimer));
      const tokenData = await tokenRes.json();

      if (tokenData.ok && tokenData.token) {
        console.log("[GeminiLiveProvider] Ephemeral token acquired. Attempting direct connection...");
        try {
          await this.connectDirect(tokenData.token);
          directSucceeded = true;
        } catch (directErr) {
          console.warn("[GeminiLiveProvider] Direct connection failed, switching to server proxy:", directErr);
        }
      } else {
        console.warn("[GeminiLiveProvider] Token endpoint returned fallback:", tokenData);
      }
    } catch (err) {
      console.warn("[GeminiLiveProvider] Ephemeral token fetch error, switching to proxy:", err);
    }

    // 2. Fallback to server proxy WebSocket
    if (!directSucceeded) {
      console.log("[GeminiLiveProvider] Connecting via server proxy WebSocket...");
      await this.connectViaServerProxy();
    }
  }

  /**
   * Direct connection to Gemini Live endpoint using ephemeral token (2-1 requirement 1 & 3)
   * URL: .../BidiGenerateContentConstrained?access_token=${token}
   * Waits for setupComplete from server (8-second timeout).
   */
  private async connectDirect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // 1) Direct connection URL with BidiGenerateContentConstrained?access_token=
      const directUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(
        token
      )}`;

      const socket = new WebSocket(directUrl);
      let setupCompleted = false;

      // 3) 8-second timeout waiting for setupComplete
      const setupTimer = setTimeout(() => {
        if (!setupCompleted) {
          this.directFailCount++;
          console.warn("[Live] Direct connection timeout (8s) waiting for setupComplete. Falling back to proxy.");
          try {
            socket.close();
          } catch {
            // ignore
          }
          reject(new Error("Direct setupComplete timeout"));
        }
      }, 8000);

      socket.onopen = () => {
        this.ws = socket;
        this.onDirectSetupComplete = () => {
          if (!setupCompleted) {
            setupCompleted = true;
            clearTimeout(setupTimer);
            this.isConnected = true;
            this.isReconnecting = false;
            this.connectionPath = "direct";
            // 5) Log path
            console.log("[Live] path=direct");
            this.options?.onStatusChange("connected", "Gemini Live 직접 연결 완료");
            resolve();
          }
        };

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
              parts: [{ text: this.activeSystemPrompt || this.options?.systemPrompt || "" }],
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            sessionResumption: {
              handle: this.resumeHandle || undefined,
            },
            contextWindowCompression: {
              slidingWindow: {},
            },
          },
        };

        socket.send(JSON.stringify(setupPayload));
      };

      socket.onerror = (err) => {
        if (!setupCompleted) {
          clearTimeout(setupTimer);
          this.directFailCount++;
          console.warn("[Live] Direct connection error before setupComplete:", err);
          reject(err);
        } else {
          this.handleDisconnect("direct error");
        }
      };

      socket.onclose = (event) => {
        if (!setupCompleted) {
          clearTimeout(setupTimer);
          this.directFailCount++;
          console.warn("[Live] Direct WebSocket closed before setupComplete:", event.code, event.reason);
          reject(new Error(`Direct WebSocket closed before setupComplete (${event.code})`));
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
    const PROXY_READY_TIMEOUT_MS = 15000;
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      const wsUrl = `${protocol}//${host}/api/gemini/live`;
      console.log("[Live] stage=proxy_open", wsUrl);

      const socket = new WebSocket(wsUrl);
      let settled = false;

      const fail = (reason: string, userMessage: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        console.warn("[Live] stage=proxy_failed", reason);
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          // ignore
        }
        if (this.ws === socket) this.ws = null;
        const e: any = new Error(reason);
        e.userMessage = userMessage;
        reject(e);
      };

      const readyTimer = setTimeout(() => {
        fail(
          `proxy ready timeout (${PROXY_READY_TIMEOUT_MS / 1000}s)`,
          "튜터 연결이 너무 오래 걸려요. 잠시 후 다시 시도해 주세요."
        );
      }, PROXY_READY_TIMEOUT_MS);

      socket.onopen = () => {
        console.log("[Live] stage=proxy_socket_open, sending init");
        socket.send(
          JSON.stringify({
            type: "init",
            systemInstruction: this.activeSystemPrompt || this.options?.systemPrompt,
            voiceName: this.options?.voiceName || "Kore",
            resumeHandle: this.resumeHandle,
            languageCode: "en-US",
          })
        );
      };

      // NOTE: do NOT call wireWebSocketEvents before 'ready'. It replaces
      // onmessage, which previously swallowed the 'ready' message and made
      // the call hang forever on "연결 준비 중".
      socket.onmessage = (event) => {
        let data: any;
        try {
          data = JSON.parse(event.data);
        } catch (err) {
          console.error("[GeminiLiveProvider] Failed to parse proxy message:", err);
          return;
        }
        if (settled) return;
        if (data.type === "ready") {
          settled = true;
          clearTimeout(readyTimer);
          this.ws = socket;
          this.wireWebSocketEvents(false);
          this.isConnected = true;
          this.isReconnecting = false;
          this.connectionPath = "proxy";
          console.log("[Live] path=proxy model=" + (data.model || "?"));
          this.options?.onStatusChange("connected", "Gemini 3.8 Live 연결됨 (서버 중계)");
          resolve();
        } else if (data.type === "fallback_required" || data.type === "error") {
          fail(
            `server: ${data.type} ${data.error || ""}`,
            data.userMessage || "튜터 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요."
          );
        } else {
          // Early audio/transcripts before ready are ignored.
          console.log("[Live] proxy message before ready ignored:", data.type);
        }
      };

      socket.onerror = (err) => {
        console.warn("[Live] proxy socket error before ready", err);
        fail("proxy socket error", "튜터 서버에 연결하지 못했어요. 인터넷을 확인하고 다시 시도해 주세요.");
      };

      socket.onclose = (event) => {
        fail(
          `proxy closed before ready (${event.code} ${event.reason || ""})`,
          "튜터 서버 연결이 끊겼어요. 다시 시도해 주세요."
        );
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
      // 3) setupComplete check for direct connection
      if (msg.setupComplete) {
        if (this.onDirectSetupComplete) {
          this.onDirectSetupComplete();
          this.onDirectSetupComplete = null;
        }
      }

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

      // GoAway message (2-1 requirement 4)
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
   * Automatic Reconnection upon GoAway or disconnect (2-1 requirement 4)
   * Fetches fresh token and attempts direct connection first with existing resumeHandle.
   */
  private triggerReconnection(): void {
    if (this.isReconnecting) return;
    this.isReconnecting = true;
    this.isConnected = false;

    // Show "연결 유지 중" briefly as requested in B-2
    this.options?.onStatusChange("reconnecting", "연결 유지 중");

    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      try {
        console.log("[Live] Reconnecting... resume handle:", this.resumeHandle);
        await this.establishConnection();
      } catch (err) {
        console.error("[Live] Reconnection attempt failed with handle:", this.resumeHandle, err);
        // B-3 Requirement 3: If session resumption fails, summarize dialogue so far and inject into new session system prompt
        if (this.resumeHandle) {
          console.warn("[Live] Session resumption failed. Rebuilding session prompt with conversation summary...");
          this.resumeHandle = null;
          this.activeSystemPrompt = this.buildConversationSummaryPrompt();
          try {
            await this.establishConnection();
            return;
          } catch (retryErr) {
            console.error("[Live] Fallback session creation also failed:", retryErr);
          }
        }
        this.isReconnecting = false;
        this.reconnectTimer = setTimeout(() => this.triggerReconnection(), 3000);
      }
    }, 1000);
  }

  /**
   * Build conversation history summary to inject into system prompt if resumption fails
   */
  private buildConversationSummaryPrompt(): string {
    const basePrompt = this.options?.systemPrompt || "";
    if (!this.transcriptItems || this.transcriptItems.length === 0) {
      return basePrompt;
    }
    const recentTurns = this.transcriptItems.slice(-10);
    const summary = recentTurns
      .map((item) => `${item.role === "user" ? "Student" : "Tutor"}: ${item.text}`)
      .join("\n");

    return `${basePrompt}\n\n[이전 대화 맥락 복원: 이전 세션 연결이 끊겨 새 세션으로 자동 전환되었습니다. 아래 이전 대화 내용을 숙지하고 학생에게 끊김 없이 자연스럽게 대화를 이어가세요]:\n${summary}`;
  }

  private appendTranscript(role: "user" | "model", text: string): void {
    if (!text || !text.trim()) return;
    const last = this.transcriptItems[this.transcriptItems.length - 1];
    let updatedItem: LiveTranscriptItem;
    if (last && last.role === role) {
      last.text += " " + text.trim();
      updatedItem = last;
    } else {
      updatedItem = {
        role,
        text: text.trim(),
        timestamp: Date.now(),
      };
      this.transcriptItems.push(updatedItem);
    }

    // Continuous transcript callback (B-3 requirement 3)
    this.options?.onTranscriptLogged?.(updatedItem, [...this.transcriptItems]);
  }

  public getLiveTranscript(): LiveTranscriptItem[] {
    return [...this.transcriptItems];
  }

  public getResumeToken(): string | null {
    return this.resumeHandle;
  }

  public getMediaStream(): MediaStream | null {
    return this.mediaStream;
  }

  public getConnectionStats(): { connectionPath: "direct" | "proxy"; directFailCount: number } {
    return {
      connectionPath: this.connectionPath,
      directFailCount: this.directFailCount,
    };
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

    if (!navigator.mediaDevices?.getUserMedia) {
      const e: any = new Error("이 브라우저에서는 마이크를 쓸 수 없어요.");
      e.code = "MIC_UNAVAILABLE";
      throw e;
    }
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
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

    this.options?.onMediaStreamReady?.(this.mediaStream);

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
    this.onDirectSetupComplete = null;

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
