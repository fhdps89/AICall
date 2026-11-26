import { LIVE_MODEL } from "../../config/models";
import { LIVE_LANGUAGE_CODE, normalizeVoiceName } from "../../config/voices";
import {
  LiveProvider,
  LiveSessionOptions,
  LiveCommand,
  LiveTranscriptItem,
} from "./types";
import { authFetch } from "../api/authFetch";
import { auth } from "../firebase/config";
import { decodeLiveMessage, createSerialQueue } from "./liveMessage";
import { createLiveUsageAccumulator, LiveUsageTotals } from "./liveUsage";
import { LIVE_STATUS_TEXT } from "./liveStatusText";
import {
  LiveWireKind,
  LiveClientMessage,
  buildDirectSetup,
  buildProxyInit,
  buildAudioInput,
  buildTextInput,
  validateClientMessage,
  describeClientMessage,
  redactSocketUrl,
} from "./liveWire";
import { MAX_KICKOFF_ATTEMPTS, shouldSendKickoff, isTutorOutput } from "./liveKickoff";
import {
  PlaybackSchedulerState,
  createScheduler,
  scheduleChunk,
  resetScheduler,
  describeScheduler,
} from "./audioPlaybackScheduler";

/**
 * 새 통화 연결 직후 튜터가 사용자 발화를 기다리지 않고 먼저 인사하도록 유도하는 초기 신호.
 * transcriptItems / Firestore liveTranscript 에는 기록하지 않는다.
 */
export const CALL_KICKOFF_PROMPT =
  "(The call has just connected. Greet me now and start today's lesson exactly as your instructions say. Do not wait for me to speak first.)";

const CONNECT_CANCELLED_CODE = "LIVE_CONNECT_CANCELLED";

function createConnectCancelledError(): Error {
  const err: any = new Error("Live connection cancelled");
  err.code = CONNECT_CANCELLED_CODE;
  return err;
}

function isConnectCancelledError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as any).code === CONNECT_CANCELLED_CODE);
}

/**
 * GeminiLiveProvider
 *
 * Implements B-2 Specification & 2-1 Fixes:
 * 1) Real-time conversation with gemini-3.8-live.
 * 2) Session resumption & context window compression enabled.
 * 3) Direct connection via BidiGenerateContentConstrained?access_token=${token}.
 * 4) "Connected" determination: Wait for Gemini's setupComplete message (with 5s timeout fallback).
 * 5) Fresh token fetched on every reconnection, with session resumption handle preserved.
 * 6) Connection telemetry: [Live] path=direct or [Live] path=proxy logged, connectionPath & directFailCount tracked.
 * 7) Audio in: 16kHz 16-bit PCM streaming with echo isolation.
 * 8) Audio out: 24kHz gapless playback scheduling.
 * 9) Control commands: Done, Feedback, Model answer, Pause, Slow.
 * 10) Stores live transcript in memory for sessions.liveTranscript.
 */
interface LiveConn {
  socket: WebSocket;
  wire: LiveWireKind;
  sockGen: number;
  ready: boolean;
  lastSent: string | null;
  sentCount: number;
  kickoffSent: boolean;
}

export class GeminiLiveProvider implements LiveProvider {
  public name = LIVE_MODEL;

  /** ready 완료된 활성 소켓 상태. setupComplete / ready 이전에는 null 이다. */
  private conn: LiveConn | null = null;
  private tutorSpoke = false;
  private kickoffAttempts = 0;
  private connectStartedAt = 0;
  private options: LiveSessionOptions | null = null;
  private isConnected = false;
  private isReconnecting = false;
  /** Failed reconnect rounds since the last successful connection. */
  private reconnectFailures = 0;
  private static readonly MAX_RECONNECT_FAILURES = 5;
  private resumeHandle: string | null = null;
  /** 프로바이더 단위 메시지 처리 직렬 큐(비동기 Blob 디코딩 시 프레임 순서 보존). */
  private messageQueue = createSerialQueue();
  /** 연결·재연결·종료 간 이전 연결 흐름을 무효화하는 세대 번호. */
  private connectionGeneration = 0;
  /** 개별 WebSocket 시도(direct/proxy) 간 잔여 이벤트를 분리하는 소켓 세대 번호. */
  private socketGeneration = 0;
  /** 연결 대기 중 disconnect()가 호출되면 대기 중인 소켓 Promise를 즉시 취소한다. */
  private cancelPendingConnect: (() => void) | null = null;

  // Connection path tracking (2-1 requirement 5)
  private connectionPath: "direct" | "proxy" = "direct";
  private directFailCount = 0;
  private liveUsage = createLiveUsageAccumulator();

  // Audio contexts
  private inputAudioCtx: AudioContext | null = null;
  private outputAudioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  // Mic graph: micSource -> processorNode (to Gemini) and -> recordDest (stable stream for the
  // chunk recorder), so the mic can be swapped mid-call (earphones plugged in) without
  // restarting the recording.
  private micSource: MediaStreamAudioSourceNode | null = null;
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  private deviceChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private swappingMic = false;
  private playbackScheduler: PlaybackSchedulerState = createScheduler();
  private interruptCount = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  // Tutor voice goes AudioContext -> MediaStream -> <audio>, so phones treat it as call audio
  // (volume keys change it, earphones/Bluetooth get it). Null when we fell back to ctx.destination.
  private playbackOut: AudioNode | null = null;
  private playbackEl: HTMLAudioElement | null = null;

  // Transcript memory
  private transcriptItems: LiveTranscriptItem[] = [];
  private activeSystemPrompt: string = "";

  // Reconnect timer
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** Disconnect still closing audio devices (see connect). */
  private teardown: Promise<void> | null = null;

  public async connect(options: LiveSessionOptions): Promise<void> {
    // "다시 시도" disconnects and connects again right away. Wait for that teardown first:
    // otherwise the new call could adopt the old mic / speaker objects just before they are closed
    // and end up connected with no sound in either direction.
    if (this.teardown) await this.teardown.catch(() => {});
    const connectGen = ++this.connectionGeneration;
    this.cancelPendingConnect?.();
    this.cancelPendingConnect = null;

    this.options = options;
    this.activeSystemPrompt = options.systemPrompt;
    this.options.onStatusChange("connecting", LIVE_STATUS_TEXT.preparing);

    if (options.resumeToken) {
      this.resumeHandle = options.resumeToken;
    }
    this.connectStartedAt = Date.now();
    this.playbackScheduler = createScheduler();
    this.interruptCount = 0;
    // resumeToken 없이 새 Live 맥락을 열 때만 튜터 발화 여부·kickoff 횟수·토큰 누적기를 초기화한다.
    // 내부 재연결(triggerReconnection -> establishConnection)은 connect()를 거치지 않고,
    // resumeToken 재개 역시 동일 통화 맥락이므로 누적 합계를 유지한 채 직전 pending 턴만 커밋한다.
    if (!options.resumeToken) {
      this.tutorSpoke = false;
      this.kickoffAttempts = 0;
      this.liveUsage.reset();
    } else {
      this.liveUsage.commitTurn();
    }

    console.log("[Live] stage=connect_start");

    // Mic is decoupled from the session: start it in parallel and never let it
    // block or fail the connection. On failure we only show guidance.
    const micPromise = options.skipMic
      ? Promise.resolve()
      : this.initAudioCapture()
          .then(() => console.log("[Live] stage=mic_ready"))
          .catch((err: any) => {
            if (connectGen !== this.connectionGeneration) return;
            console.warn("[Live] stage=mic_failed", err?.cause || err);
            this.options?.onMicWarning?.(
              err?.message || "마이크를 쓸 수 없어요. 튜터 목소리는 들을 수 있지만 말하려면 마이크를 확인해 주세요."
            );
          });

    try {
      await this.initAudioPlayback().catch((err) => {
        console.warn("[Live] stage=playback_init_failed", err);
      });
      if (connectGen !== this.connectionGeneration) return;
      console.log("[Live] stage=establish_connection");
      const established = await this.establishConnection();
      // kickoff 전에 세대가 바뀌었거나 연결이 중단됐으면 오류 없이 조용히 종료한다.
      if (!established || connectGen !== this.connectionGeneration || !this.isConnected) return;
      console.log("[Live] stage=connected path=" + this.connectionPath);
      this.maybeSendKickoff("connect");
    } catch (err: any) {
      if (connectGen !== this.connectionGeneration || isConnectCancelledError(err)) {
        return;
      }
      console.error("[GeminiLiveProvider] Connect failed:", err);
      // Release anything half-opened so a retry starts clean, without overwriting error status.
      await this.disconnect(false).catch(() => {});
      this.options?.onStatusChange(
        "error",
        err?.userMessage || "연결하지 못했어요. 인터넷을 확인하고 다시 시도해 주세요."
      );
      throw err;
    }
    // Mic initialization is fully asynchronous and decoupled from session establishment.
    micPromise.catch(() => {});
  }

  private async establishConnection(): Promise<boolean> {
    this.liveUsage.commitTurn();
    const startGen = this.connectionGeneration;
    // 1. Try Ephemeral Token direct connection (2-1 requirement 1, 2, 3)
    let directSucceeded = false;
    console.log("[Live] stage=token_fetch");
    this.options?.onStatusChange("connecting", LIVE_STATUS_TEXT.preparing);

    try {
      const tokenAbort = new AbortController();
      const tokenTimer = setTimeout(() => tokenAbort.abort(), 6000);
      const tokenRes = await authFetch("/api/gemini/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: tokenAbort.signal,
      }).finally(() => clearTimeout(tokenTimer));
      if (this.connectionGeneration !== startGen) return false;
      const tokenData = await tokenRes.json();
      if (this.connectionGeneration !== startGen) return false;

      if (tokenData.ok && tokenData.token) {
        console.log("[GeminiLiveProvider] Ephemeral token acquired. Attempting direct connection...");
        this.options?.onStatusChange("connecting", LIVE_STATUS_TEXT.connecting);
        try {
          await this.connectDirect(tokenData.token);
          directSucceeded = true;
        } catch (directErr) {
          if (this.connectionGeneration !== startGen || isConnectCancelledError(directErr)) {
            return false;
          }
          console.warn("[GeminiLiveProvider] Direct connection failed, switching to server proxy:", directErr);
        }
      } else {
        console.warn("[GeminiLiveProvider] Token endpoint returned fallback:", tokenData);
      }
    } catch (err) {
      if (this.connectionGeneration !== startGen) return false;
      console.warn("[GeminiLiveProvider] Ephemeral token fetch error, switching to proxy:", err);
    }

    // 프록시 폴백 전 세대 검사: 연결 중 disconnect/재연결이 발생했으면 프록시 세션을 열지 않는다.
    if (this.connectionGeneration !== startGen) return false;

    // 2. Fallback to server proxy WebSocket
    if (!directSucceeded) {
      console.log("[GeminiLiveProvider] Connecting via server proxy WebSocket...");
      this.options?.onStatusChange("connecting", LIVE_STATUS_TEXT.connecting);
      try {
        await this.connectViaServerProxy();
      } catch (proxyErr) {
        if (this.connectionGeneration !== startGen || isConnectCancelledError(proxyErr)) {
          return false;
        }
        throw proxyErr;
      }
    }

    if (this.connectionGeneration !== startGen) return false;
    return true;
  }

  /**
   * Direct connection to Gemini Live endpoint using ephemeral token (2-1 requirement 1 & 3)
   * URL: .../BidiGenerateContentConstrained?access_token=${token}
   * Waits for setupComplete from server (5-second timeout).
   */
  private async connectDirect(token: string): Promise<void> {
    const gen = this.connectionGeneration;
    const sockGen = ++this.socketGeneration;

    return new Promise((resolve, reject) => {
      // 1) Direct connection URL with BidiGenerateContentConstrained?access_token=
      const directUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(
        token
      )}`;

      const socket = new WebSocket(directUrl);
      const c: LiveConn = {
        socket,
        wire: "direct",
        sockGen,
        ready: false,
        lastSent: null,
        sentCount: 0,
        kickoffSent: false,
      };
      let setupCompleted = false;
      let failed = false;
      let errorFallbackTimer: ReturnType<typeof setTimeout> | null = null;

      const clearErrorFallback = () => {
        if (errorFallbackTimer) {
          clearTimeout(errorFallbackTimer);
          errorFallbackTimer = null;
        }
      };

      const rejectCancelled = () => {
        if (setupCompleted || failed) return;
        failed = true;
        clearTimeout(setupTimer);
        clearErrorFallback();
        if (this.cancelPendingConnect === rejectCancelled) {
          this.cancelPendingConnect = null;
        }
        this.detachAndCloseSocket(socket);
        reject(createConnectCancelledError());
      };
      this.cancelPendingConnect = rejectCancelled;

      const failPreReady = (err: unknown) => {
        if (setupCompleted || failed) return;
        failed = true;
        clearTimeout(setupTimer);
        clearErrorFallback();
        if (this.cancelPendingConnect === rejectCancelled) {
          this.cancelPendingConnect = null;
        }
        this.directFailCount++;
        this.detachAndCloseSocket(socket);
        reject(err);
      };

      // 5-second timeout waiting for setupComplete
      const setupTimer = setTimeout(() => {
        if (gen !== this.connectionGeneration || sockGen !== this.socketGeneration) {
          rejectCancelled();
          return;
        }
        if (!setupCompleted && !failed) {
          console.warn("[Live] Direct connection timeout (5s) waiting for setupComplete. Falling back to proxy.");
          failPreReady(new Error("Direct setupComplete timeout"));
        }
      }, 5000);

      socket.onopen = () => {
        if (gen !== this.connectionGeneration || sockGen !== this.socketGeneration) {
          rejectCancelled();
          return;
        }
        if (failed) {
          try {
            socket.close();
          } catch {
            // ignore
          }
          return;
        }
        console.log(`[Live] ws_open wire=${c.wire} url=${redactSocketUrl(socket.url)}`);

        // Listen for setupComplete before attaching full event listeners
        socket.onmessage = (event) => {
          this.messageQueue.enqueue(async () => {
            if (
              failed ||
              gen !== this.connectionGeneration ||
              sockGen !== this.socketGeneration ||
              (setupCompleted && this.conn?.socket !== socket)
            ) {
              return;
            }
            try {
              const raw = await decodeLiveMessage(event.data);
              if (
                failed ||
                gen !== this.connectionGeneration ||
                sockGen !== this.socketGeneration ||
                (setupCompleted && this.conn?.socket !== socket)
              ) {
                return;
              }
              if (raw.setupComplete && !setupCompleted) {
                if (raw.usageMetadata) {
                  this.liveUsage.observe(raw.usageMetadata);
                }
                setupCompleted = true;
                clearTimeout(setupTimer);
                clearErrorFallback();
                if (this.cancelPendingConnect === rejectCancelled) {
                  this.cancelPendingConnect = null;
                }
                c.ready = true;
                this.conn = c;
                this.isConnected = true;
                this.isReconnecting = false;
                this.reconnectFailures = 0;
                this.connectionPath = "direct";
                console.log("[Live] path=direct (setupComplete received)");
                this.options?.onStatusChange("connected", LIVE_STATUS_TEXT.connected);

                // Switch to full message handler
                this.wireWebSocketEvents(c);
                resolve();
                return;
              }

              if (setupCompleted) {
                this.handleIncomingMessage(raw, c.wire);
              }
            } catch (err) {
              console.error("[GeminiLiveProvider] Direct parse message error:", err);
            }
          });
        };

        // Send initial setup payload with session resumption & context compression
        this.sendOn(
          c,
          buildDirectSetup({
            model: LIVE_MODEL,
            voiceName: normalizeVoiceName(this.options?.voiceName),
            systemInstruction: this.activeSystemPrompt || this.options?.systemPrompt || "",
            resumeHandle: this.resumeHandle,
            languageCode: LIVE_LANGUAGE_CODE,
          })
        );
      };

      socket.onerror = () => {
        if (gen !== this.connectionGeneration || sockGen !== this.socketGeneration) {
          rejectCancelled();
          return;
        }
        if (failed || setupCompleted) return;
        console.warn(
          `[Live] ws_error wire=${c.wire} phase=${c.ready ? "open" : "pre_ready"} lastSent=${c.lastSent ?? "-"}`
        );
        // 표준상 close 가 뒤따르므로 close 코드를 남기기 위해 1500ms 안전장치만 둔다.
        if (!errorFallbackTimer) {
          errorFallbackTimer = setTimeout(() => {
            errorFallbackTimer = null;
            if (gen !== this.connectionGeneration || sockGen !== this.socketGeneration) {
              rejectCancelled();
              return;
            }
            failPreReady(new Error("Direct connection error before setupComplete (no close)"));
          }, 1500);
        }
      };

      socket.onclose = (event) => {
        if (gen !== this.connectionGeneration || sockGen !== this.socketGeneration) {
          rejectCancelled();
          return;
        }
        if (failed) return;
        clearErrorFallback();
        console.warn(
          `[Live] ws_close wire=${c.wire} phase=${c.ready ? "open" : "pre_ready"} code=${event.code} reason=${event.reason || "-"} clean=${event.wasClean ?? false} lastSent=${c.lastSent ?? "-"} sent=${c.sentCount}`
        );
        if (!setupCompleted) {
          failPreReady(new Error(`Direct WebSocket closed before setupComplete (${event.code})`));
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
    const PROXY_READY_TIMEOUT_MS = 20000;
    const gen = this.connectionGeneration;
    // Server proxy requires the signed-in user's Firebase ID token (browsers can't set WS headers).
    let idToken = "";
    try {
      idToken = (await auth.currentUser?.getIdToken()) || "";
    } catch (e) {
      console.warn("[Live] stage=id_token_failed", e);
    }
    if (gen !== this.connectionGeneration) {
      throw createConnectCancelledError();
    }
    const sockGen = ++this.socketGeneration;
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      const baseUrl = `${protocol}//${host}/api/gemini/live`;
      console.log("[Live] stage=proxy_open", baseUrl);

      const wsUrl = `${baseUrl}?token=${encodeURIComponent(idToken)}`;
      const socket = new WebSocket(wsUrl);
      const c: LiveConn = {
        socket,
        wire: "proxy",
        sockGen,
        ready: false,
        lastSent: null,
        sentCount: 0,
        kickoffSent: false,
      };
      let settled = false;
      let failed = false;
      let errorFallbackTimer: ReturnType<typeof setTimeout> | null = null;

      const clearErrorFallback = () => {
        if (errorFallbackTimer) {
          clearTimeout(errorFallbackTimer);
          errorFallbackTimer = null;
        }
      };

      const rejectCancelled = () => {
        if (settled || failed) return;
        failed = true;
        settled = true;
        clearTimeout(readyTimer);
        clearErrorFallback();
        if (this.cancelPendingConnect === rejectCancelled) {
          this.cancelPendingConnect = null;
        }
        this.detachAndCloseSocket(socket);
        reject(createConnectCancelledError());
      };
      this.cancelPendingConnect = rejectCancelled;

      const fail = (reason: string, userMessage: string) => {
        if (settled || failed) return;
        failed = true;
        settled = true;
        clearTimeout(readyTimer);
        clearErrorFallback();
        if (this.cancelPendingConnect === rejectCancelled) {
          this.cancelPendingConnect = null;
        }
        console.warn("[Live] stage=proxy_failed", reason);
        this.detachAndCloseSocket(socket);
        const e: any = new Error(reason);
        e.userMessage = userMessage;
        reject(e);
      };

      const readyTimer = setTimeout(() => {
        if (gen !== this.connectionGeneration || sockGen !== this.socketGeneration) {
          rejectCancelled();
          return;
        }
        fail(
          `proxy ready timeout (${PROXY_READY_TIMEOUT_MS / 1000}s)`,
          "튜터 연결이 너무 오래 걸려요. 잠시 후 다시 시도해 주세요."
        );
      }, PROXY_READY_TIMEOUT_MS);

      socket.onopen = () => {
        if (gen !== this.connectionGeneration || sockGen !== this.socketGeneration) {
          rejectCancelled();
          return;
        }
        if (failed) {
          try {
            socket.close();
          } catch {
            // ignore
          }
          return;
        }
        console.log(`[Live] ws_open wire=${c.wire} url=${redactSocketUrl(socket.url)}`);
        console.log("[Live] stage=proxy_socket_open, sending init");
        this.sendOn(
          c,
          buildProxyInit({
            systemInstruction: this.activeSystemPrompt || this.options?.systemPrompt || "",
            voiceName: normalizeVoiceName(this.options?.voiceName),
            resumeHandle: this.resumeHandle,
            languageCode: "en-US",
          })
        );
      };

      // NOTE: do NOT call wireWebSocketEvents before 'ready'. It replaces
      // onmessage, which previously swallowed the 'ready' message and made
      // the call hang forever on "연결 준비 중".
      socket.onmessage = (event) => {
        this.messageQueue.enqueue(async () => {
          if (failed || gen !== this.connectionGeneration || sockGen !== this.socketGeneration) return;
          let data: any;
          try {
            data = await decodeLiveMessage(event.data);
          } catch (err) {
            console.error("[GeminiLiveProvider] Failed to parse proxy message:", err);
            return;
          }
          if (failed || gen !== this.connectionGeneration || sockGen !== this.socketGeneration) return;
          if (settled) {
            // ready 처리 직후 wireWebSocketEvents 교체 전에 큐에 들어온 후속 프레임을 유실 없이 처리한다.
            if (this.conn?.socket === socket) {
              this.handleIncomingMessage(data, c.wire);
            }
            return;
          }
          if (data.type === "ready") {
            settled = true;
            clearTimeout(readyTimer);
            clearErrorFallback();
            if (this.cancelPendingConnect === rejectCancelled) {
              this.cancelPendingConnect = null;
            }
            c.ready = true;
            this.conn = c;
            this.wireWebSocketEvents(c);
            this.isConnected = true;
            this.isReconnecting = false;
            this.reconnectFailures = 0;
            this.connectionPath = "proxy";
            console.log("[Live] path=proxy model=" + (data.model || "?"));
            this.options?.onStatusChange("connected", LIVE_STATUS_TEXT.connected);
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
        });
      };

      socket.onerror = () => {
        if (gen !== this.connectionGeneration || sockGen !== this.socketGeneration) {
          rejectCancelled();
          return;
        }
        if (failed || settled) return;
        console.warn(
          `[Live] ws_error wire=${c.wire} phase=${c.ready ? "open" : "pre_ready"} lastSent=${c.lastSent ?? "-"}`
        );
        if (!errorFallbackTimer) {
          errorFallbackTimer = setTimeout(() => {
            errorFallbackTimer = null;
            if (gen !== this.connectionGeneration || sockGen !== this.socketGeneration) {
              rejectCancelled();
              return;
            }
            fail("proxy socket error", "튜터 서버에 연결하지 못했어요. 인터넷을 확인하고 다시 시도해 주세요.");
          }, 1500);
        }
      };

      socket.onclose = (event) => {
        if (gen !== this.connectionGeneration || sockGen !== this.socketGeneration) {
          rejectCancelled();
          return;
        }
        if (failed) return;
        clearErrorFallback();
        console.warn(
          `[Live] ws_close wire=${c.wire} phase=${c.ready ? "open" : "pre_ready"} code=${event.code} reason=${event.reason || "-"} clean=${event.wasClean ?? false} lastSent=${c.lastSent ?? "-"} sent=${c.sentCount}`
        );
        fail(
          `proxy closed before ready (${event.code} ${event.reason || ""})`,
          "튜터 서버 연결이 끊겼어요. 다시 시도해 주세요."
        );
      };
    });
  }

  private sendOn(c: LiveConn, msg: LiveClientMessage): boolean {
    const problem = validateClientMessage(c.wire, msg);
    if (problem) {
      console.error(`[Live] send_blocked wire=${c.wire} kind=${describeClientMessage(msg)} problem=${problem}`);
      return false;
    }
    if (c.socket.readyState !== WebSocket.OPEN) return false;
    try {
      c.socket.send(JSON.stringify(msg));
      c.lastSent = describeClientMessage(msg);
      c.sentCount++;
      return true;
    } catch {
      return false;
    }
  }

  private maybeSendKickoff(trigger: "connect" | "reconnect"): void {
    const c = this.conn;
    if (!c?.ready || !this.isConnected) return;
    const startedFresh = !this.options?.resumeToken;
    if (
      !shouldSendKickoff({
        startedFresh,
        tutorSpoke: this.tutorSpoke,
        sentOnThisSocket: c.kickoffSent,
        attempts: this.kickoffAttempts,
      })
    ) {
      if (startedFresh && !this.tutorSpoke && !c.kickoffSent && this.kickoffAttempts >= MAX_KICKOFF_ATTEMPTS) {
        console.log(
          `[Live] kickoff_skipped reason=max_attempts attempts=${this.kickoffAttempts} trigger=${trigger}`
        );
      } else {
        console.log(`[Live] stage=kickoff_skipped trigger=${trigger} tutorSpoke=${this.tutorSpoke}`);
      }
      return;
    }
    console.log(`[Live] stage=kickoff_greeting trigger=${trigger} wire=${c.wire}`);
    const sent = this.sendTextPrompt(CALL_KICKOFF_PROMPT);
    c.kickoffSent = sent;
    if (sent) {
      this.kickoffAttempts++;
    }
  }

  private detachAndCloseSocket(socket: WebSocket | null): void {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (this.conn?.socket === socket) {
      this.conn.ready = false;
      this.conn = null;
    }
    try {
      socket.close();
    } catch {
      // ignore
    }
  }

  private wireWebSocketEvents(c: LiveConn): void {
    const socket = c.socket;
    const gen = this.connectionGeneration;
    const sockGen = c.sockGen;
    let errorFallbackTimer: ReturnType<typeof setTimeout> | null = null;

    socket.onmessage = (event) => {
      this.messageQueue.enqueue(async () => {
        if (gen !== this.connectionGeneration || sockGen !== this.socketGeneration || this.conn !== c) return;
        try {
          const raw = await decodeLiveMessage(event.data);
          if (gen !== this.connectionGeneration || sockGen !== this.socketGeneration || this.conn !== c) return;
          this.handleIncomingMessage(raw, c.wire);
        } catch (err) {
          console.error(
            c.wire === "direct"
              ? "[GeminiLiveProvider] Parse message error:"
              : "[GeminiLiveProvider] Failed to parse proxy message:",
            err
          );
        }
      });
    };

    socket.onerror = () => {
      if (gen !== this.connectionGeneration || sockGen !== this.socketGeneration || this.conn !== c) return;
      console.warn(
        `[Live] ws_error wire=${c.wire} phase=${c.ready ? "open" : "pre_ready"} lastSent=${c.lastSent ?? "-"}`
      );
      if (!errorFallbackTimer) {
        errorFallbackTimer = setTimeout(() => {
          errorFallbackTimer = null;
          if (gen !== this.connectionGeneration || sockGen !== this.socketGeneration || this.conn !== c) return;
          this.handleDisconnect("ws error (no close)");
        }, 1500);
      }
    };

    socket.onclose = (event) => {
      if (errorFallbackTimer) {
        clearTimeout(errorFallbackTimer);
        errorFallbackTimer = null;
      }
      if (gen !== this.connectionGeneration || sockGen !== this.socketGeneration || this.conn !== c) return;
      console.warn(
        `[Live] ws_close wire=${c.wire} phase=${c.ready ? "open" : "pre_ready"} code=${event.code} reason=${event.reason || "-"} clean=${event.wasClean ?? false} lastSent=${c.lastSent ?? "-"} sent=${c.sentCount}`
      );
      this.handleDisconnect("ws close");
    };
  }

  private handleIncomingMessage(msg: any, wire: LiveWireKind): void {
    if (!this.tutorSpoke && isTutorOutput(wire, msg)) {
      this.tutorSpoke = true;
      console.log(`[Live] stage=first_tutor_output wire=${wire} ms=${Date.now() - this.connectStartedAt}`);
    }

    if (wire === "direct") {
      if (msg.usageMetadata) {
        this.liveUsage.observe(msg.usageMetadata);
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
          this.liveUsage.commitTurn();
          this.interruptCount += 1;
          this.stopAudioPlayback();
          this.options?.onInterrupted?.();
        }

        if (msg.serverContent.turnComplete) {
          this.liveUsage.commitTurn();
          console.log(
            `[Live] stage=playback_stats ${describeScheduler(this.playbackScheduler)} interrupts=${this.interruptCount}`
          );
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
      } else if (msg.type === "usage_metadata" && msg.usageMetadata) {
        this.liveUsage.observe(msg.usageMetadata);
      } else if (msg.type === "interrupted") {
        this.liveUsage.commitTurn();
        this.interruptCount += 1;
        this.stopAudioPlayback();
        this.options?.onInterrupted?.();
      } else if (msg.type === "turnComplete") {
        this.liveUsage.commitTurn();
        console.log(
          `[Live] stage=playback_stats ${describeScheduler(this.playbackScheduler)} interrupts=${this.interruptCount}`
        );
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
    this.liveUsage.commitTurn();
    this.isReconnecting = true;
    this.isConnected = false;
    const reconnectGen = ++this.connectionGeneration;
    this.cancelPendingConnect?.();
    this.cancelPendingConnect = null;

    // Show "연결 유지 중" briefly as requested in B-2
    this.options?.onStatusChange("reconnecting", "연결 유지 중");

    if (this.conn) {
      this.conn.ready = false;
      this.detachAndCloseSocket(this.conn.socket);
      this.conn = null;
    }

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      if (reconnectGen !== this.connectionGeneration) return;
      try {
        console.log("[Live] Reconnecting... resume handle:", this.resumeHandle);
        const connected = await this.establishConnection();
        if (!connected || reconnectGen !== this.connectionGeneration) return;
        this.maybeSendKickoff("reconnect");
      } catch (err) {
        if (reconnectGen !== this.connectionGeneration) return;
        console.error("[Live] Reconnection attempt failed with handle:", this.resumeHandle, err);
        // B-3 Requirement 3: If session resumption fails, summarize dialogue so far and inject into new session system prompt
        if (this.resumeHandle) {
          console.warn("[Live] Session resumption failed. Rebuilding session prompt with conversation summary...");
          this.resumeHandle = null;
          this.activeSystemPrompt = this.buildConversationSummaryPrompt();
          try {
            const retried = await this.establishConnection();
            if (!retried || reconnectGen !== this.connectionGeneration) return;
            this.maybeSendKickoff("reconnect");
            return;
          } catch (retryErr) {
            if (reconnectGen !== this.connectionGeneration) return;
            console.error("[Live] Fallback session creation also failed:", retryErr);
            err = retryErr;
          }
        }
        this.isReconnecting = false;
        this.reconnectFailures++;
        // Stop after a few rounds: each attempt costs a token request and a Live session start
        // (daily limit), and a persistent failure (e.g. no server key) will not fix itself.
        if (this.reconnectFailures >= GeminiLiveProvider.MAX_RECONNECT_FAILURES) {
          console.error(`[Live] Giving up after ${this.reconnectFailures} failed reconnect rounds`);
          this.isConnected = false;
          this.options?.onStatusChange(
            "error",
            (err as any)?.userMessage || "연결이 계속 끊겨요. 인터넷을 확인하고 다시 걸어 주세요."
          );
          return;
        }
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

  public getLiveUsage(): LiveUsageTotals {
    return this.liveUsage.snapshot();
  }

  public finalizeLiveUsage(): LiveUsageTotals {
    return this.liveUsage.finalize();
  }

  public sendAudioChunk(pcm16kChunk: ArrayBuffer): void {
    const c = this.conn;
    if (!c?.ready) return;
    this.sendOn(c, buildAudioInput(c.wire, this.arrayBufferToBase64(pcm16kChunk)));
  }

  public appendUserText(text: string): void {
    const trimmed = text?.trim();
    if (!trimmed) return;
    this.appendTranscript("user", trimmed);
    this.options?.onTranscript(trimmed, true);
  }

  public sendTextPrompt(prompt: string): boolean {
    const c = this.conn;
    if (!c?.ready) return false;
    return this.sendOn(c, buildTextInput(c.wire, prompt));
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
    // iOS Safari 16.4+: a call-style session lets earphones carry both voice and mic.
    try {
      const session = (navigator as any).audioSession;
      if (session && session.type !== "play-and-record") session.type = "play-and-record";
    } catch {
      // ignore
    }
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia(GeminiLiveProvider.MIC_CONSTRAINTS);
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
    if (this.inputAudioCtx.state === "suspended") {
      await this.inputAudioCtx.resume().catch(() => {});
    }

    const source = this.inputAudioCtx.createMediaStreamSource(this.mediaStream);
    this.micSource = source;
    this.recordDest = this.inputAudioCtx.createMediaStreamDestination();
    source.connect(this.recordDest);
    this.options?.onMediaStreamReady?.(this.recordDest.stream);
    navigator.mediaDevices.addEventListener?.("devicechange", this.handleDeviceChange);
    // Buffer size 2048 gives ~128ms chunks at 16kHz
    this.processorNode = this.inputAudioCtx.createScriptProcessor(2048, 1, 1);

    this.processorNode.onaudioprocess = (e) => {
      if (!this.conn?.ready) return;

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

  private static readonly MIC_CONSTRAINTS: MediaStreamConstraints = {
    audio: {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };

  // Earphones plugged in or unplugged mid-call: reopen the mic so the new default device is used.
  private handleDeviceChange = (): void => {
    if (this.deviceChangeTimer) clearTimeout(this.deviceChangeTimer);
    this.deviceChangeTimer = setTimeout(() => {
      this.deviceChangeTimer = null;
      this.swapMic().catch((err) => console.warn("[Live] stage=mic_swap_failed", err));
    }, 700);
  };

  private async swapMic(): Promise<void> {
    if (this.swappingMic || !this.inputAudioCtx || !this.processorNode || !this.recordDest) return;
    this.swappingMic = true;
    try {
      const next = await navigator.mediaDevices.getUserMedia(GeminiLiveProvider.MIC_CONSTRAINTS);
      if (!this.inputAudioCtx || !this.processorNode || !this.recordDest) {
        next.getTracks().forEach((t) => t.stop());
        return;
      }
      const nextSource = this.inputAudioCtx.createMediaStreamSource(next);
      nextSource.connect(this.processorNode);
      nextSource.connect(this.recordDest);
      try {
        this.micSource?.disconnect();
      } catch {
        // ignore
      }
      this.mediaStream?.getTracks().forEach((t) => t.stop());
      this.micSource = nextSource;
      this.mediaStream = next;
      console.log("[Live] stage=mic_swapped label=" + (next.getAudioTracks()[0]?.label || "?"));
    } finally {
      this.swappingMic = false;
    }
  }

  // Audio Playback Setup (24kHz standard for Gemini Live output)
  private async initAudioPlayback(): Promise<void> {
    if (this.outputAudioCtx) return;

    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.outputAudioCtx = new AudioContextClass({ sampleRate: 24000 });
    this.playbackScheduler = createScheduler(this.outputAudioCtx.currentTime);
    this.playbackOut = this.outputAudioCtx.destination;

    // Played straight to ctx.destination, mobile browsers use the media channel while the mic
    // puts the phone in call mode: volume keys then change call volume (not the tutor) and the
    // voice can stay on the loudspeaker with earphones in. Playing through an <audio> element
    // fed by a MediaStream keeps the voice on the same call route as the mic.
    try {
      const dest = this.outputAudioCtx.createMediaStreamDestination();
      const el = new Audio();
      el.autoplay = true;
      el.setAttribute("playsinline", "");
      el.srcObject = dest.stream;
      await el.play();
      this.playbackEl = el;
      this.playbackOut = dest;
      console.log("[Live] stage=playback_route media_element");
    } catch (err) {
      console.warn("[Live] stage=playback_route destination (media element failed)", err);
    }
    if (this.outputAudioCtx.state === "suspended") {
      await this.outputAudioCtx.resume().catch(() => {});
    }
  }

  private playAudioChunk(pcmBuffer: ArrayBuffer): void {
    if (!this.outputAudioCtx) return;

    const evenBytes = pcmBuffer.byteLength - (pcmBuffer.byteLength % 2);
    if (evenBytes <= 0) return;

    const pcm16 = new Int16Array(pcmBuffer, 0, evenBytes / 2);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768.0;
    }

    const audioBuffer = this.outputAudioCtx.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);

    const source = this.outputAudioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.playbackOut || this.outputAudioCtx.destination);

    const now = this.outputAudioCtx.currentTime;
    const { startTime } = scheduleChunk(this.playbackScheduler, {
      now,
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
    if (this.outputAudioCtx) {
      resetScheduler(this.playbackScheduler, this.outputAudioCtx.currentTime);
    }
  }

  public disconnect(notifyClosed: boolean = true): Promise<void> {
    const run = this.runDisconnect(notifyClosed);
    const tracked: Promise<void> = run.catch(() => {}).finally(() => {
      if (this.teardown === tracked) this.teardown = null;
    });
    this.teardown = tracked;
    return run;
  }

  private async runDisconnect(notifyClosed: boolean): Promise<void> {
    this.liveUsage.commitTurn();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.connectionGeneration++;
    this.cancelPendingConnect?.();
    this.cancelPendingConnect = null;
    this.isConnected = false;
    this.isReconnecting = false;
    this.reconnectFailures = 0;

    if (this.conn) {
      this.conn.ready = false;
      this.detachAndCloseSocket(this.conn.socket);
      this.conn = null;
    }

    this.stopAudioPlayback();

    navigator.mediaDevices?.removeEventListener?.("devicechange", this.handleDeviceChange);
    if (this.deviceChangeTimer) {
      clearTimeout(this.deviceChangeTimer);
      this.deviceChangeTimer = null;
    }
    this.micSource = null;
    this.recordDest = null;

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

    if (this.playbackEl) {
      try {
        this.playbackEl.pause();
        this.playbackEl.srcObject = null;
      } catch {
        // ignore
      }
      this.playbackEl = null;
    }
    this.playbackOut = null;

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

    if (notifyClosed) {
      this.options?.onStatusChange("closed", "통화가 정상 종료되었습니다.");
    }
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
