import { recordUsage } from "../../services/usage/usageService";
import { callsForDuration } from "../../services/usage/learningLog";
import React, { useState, useEffect, useRef } from "react";
import { useDevMode } from "../../data/devMode";
import {
  GoalData,
  createCallSession,
  finalizeCallSession,
  updateSessionLiveTranscript,
  getDueMistakes,
  MistakeData,
} from "../../services/firebase/db";
import { PromptPlaceholders } from "../../data/promptCustomizer";
import { buildTodayLessonSystemPrompt } from "../../data/lessonPromptBuilder";
import { createLiveProvider } from "../../services/providers";
import { LiveCommand, LiveProvider, LiveTranscriptItem } from "../../services/providers/types";
import { LIVE_STATUS_TEXT } from "../../services/providers/liveStatusText";
import { getChunkRecorder } from "../../services/recording/chunkRecorder";
import { formatWrittenAnswer, WRITTEN_ANSWER_MAX_LENGTH } from "./micCheck";
import { RECONNECT_NOTICE_DELAY_MS, resolveReconnectUiState } from "./reconnectNotice";
import { getPreferredVoice } from "../../services/settings/voicePreferenceDefault";
import {
  PhoneOff,
  Mic,
  MicOff,
  Volume2,
  CheckCircle2,
  MessageSquare,
  Sparkles,
  Pause,
  Clock,
  Shield,
  Smartphone,
  Disc3,
  FileAudio,
  Send,
} from "lucide-react";

const COMMAND_LABELS: Record<string, string> = {
  Done: "답변 끝",
  Feedback: "피드백",
  "Model answer": "모범답",
  Pause: "잠깐",
  Slow: "천천히",
};

interface NewCallScreenProps {
  userId?: string;
  goal: GoalData;
  lessonIndex: number;
  placeholders: PromptPlaceholders;
  enablePartialTranscribe?: boolean;
  textOnly?: boolean;
  onEndCall: (
    transcript: LiveTranscriptItem[],
    stats?: { connectionPath: "direct" | "proxy"; directFailCount: number },
    sessionId?: string,
    audioBlobs?: Blob[]
  ) => void;
  /** Leave without a call (e.g. mic failure). No review is generated. */
  onExit?: () => void;
}

export const NewCallScreen: React.FC<NewCallScreenProps> = ({
  userId,
  goal,
  lessonIndex,
  placeholders,
  enablePartialTranscribe = true,
  textOnly = false,
  onEndCall,
  onExit,
}) => {
  const devMode = useDevMode();
  const sessionIdRef = useRef<string>(`call-${Date.now()}`);
  const [status, setStatus] = useState<"connecting" | "connected" | "reconnecting" | "closed" | "error">("connecting");
  const [statusMessage, setStatusMessage] = useState<string>(LIVE_STATUS_TEXT.preparing);
  const [transcripts, setTranscripts] = useState<LiveTranscriptItem[]>([]);
  const [callDuration, setCallDuration] = useState<number>(0);
  const [isSpeakingModel, setIsSpeakingModel] = useState<boolean>(false);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [chunkCount, setChunkCount] = useState<number>(0);
  const [wakeLockActive, setWakeLockActive] = useState<boolean>(false);
  const [lastPartialSnippet, setLastPartialSnippet] = useState<string | null>(null);
  // Mic/connection failure: Korean guidance + [다시 시도]/[나가기]
  const [connectError, setConnectError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<number>(0);
  const [micWarning, setMicWarning] = useState<string | null>(null);
  const [writtenText, setWrittenText] = useState<string>("");
  const [writtenSendError, setWrittenSendError] = useState<string | null>(null);
  const [noticeVisible, setNoticeVisible] = useState(false);
  useEffect(() => {
    if (status !== "reconnecting") {
      setNoticeVisible(false);
      return;
    }
    setNoticeVisible(false);
    const t = setTimeout(() => setNoticeVisible(true), RECONNECT_NOTICE_DELAY_MS);
    return () => clearTimeout(t);
  }, [status]);
  const { showReconnectNotice, displayStatus } = resolveReconnectUiState({
    status,
    noticeVisible,
  }); // displayStatus는 표시 전용
  const sessionCreatedRef = useRef<boolean>(false);
  const sessionCreatePromiseRef = useRef<Promise<void> | null>(null);
  const hasMicRecordingRef = useRef<boolean>(false);
  // Guards 통화 종료 against a double tap (it would finalize and review the call twice).
  const hangingUpRef = useRef<boolean>(false);
  const [hangingUp, setHangingUp] = useState<boolean>(false);

  const ensureSessionCreated = (): Promise<void> => {
    if (!userId) return Promise.resolve();
    if (!sessionCreatedRef.current) {
      sessionCreatedRef.current = true;
      sessionCreatePromiseRef.current = createCallSession(userId, sessionIdRef.current, {
        goalId: goal.id,
        lessonIndex,
        connectionPath: "direct",
      }).catch((err) => console.warn("[NewCallScreen] createCallSession error:", err));
    }
    return sessionCreatePromiseRef.current || Promise.resolve();
  };

  const transcriptsEndRef = useRef<HTMLDivElement>(null);
  // One provider per call screen: "다시 시도" in the same call reuses it (keeps transcript and
  // resume handle), a new call gets a clean one.
  const providerRef = useRef<LiveProvider>(null as unknown as LiveProvider);
  if (!providerRef.current) providerRef.current = createLiveProvider();
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const modelSpeakingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 통화 중(연결 중/연결됨/재연결 중) 실수로 F5·창 닫기를 누를 때 브라우저 경고를 띄운다.
  const shouldWarnBeforeUnload =
    !hangingUp &&
    (status === "connecting" || status === "connected" || status === "reconnecting");

  useEffect(() => {
    if (!shouldWarnBeforeUnload || typeof window === "undefined") return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (hangingUpRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [shouldWarnBeforeUnload]);

  const currentLesson = goal.lessons.find((l) => l.index === lessonIndex) || {
    index: lessonIndex,
    title: `${lessonIndex}과`,
  };

  // Screen Wake Lock (B-3 requirement 5)
  useEffect(() => {
    let sentinel: any = null;
    const requestWakeLock = async () => {
      if (typeof navigator !== "undefined" && "wakeLock" in navigator && (navigator as any).wakeLock?.request) {
        try {
          sentinel = await (navigator as any).wakeLock.request("screen");
          setWakeLockActive(true);
          console.log("[NewCallScreen] Screen Wake Lock acquired");
        } catch (err) {
          console.warn("[NewCallScreen] Screen Wake Lock not available:", err);
        }
      }
    };
    requestWakeLock();
    // The browser drops the wake lock whenever the page is hidden (another app, notification
    // shade, screen off). Ask again when the user comes back, or the screen dims mid-call.
    const onVisible = () => {
      if (document.visibilityState === "visible") requestWakeLock();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (sentinel) {
        sentinel.release().catch(() => {});
      }
    };
  }, []);

  // 1. Initialize session and connect on mount
  useEffect(() => {
    let isCancelled = false;
    const provider = providerRef.current;
    const currentSessionId = sessionIdRef.current;

    setConnectError(null);
    setMicWarning(null);
    setWrittenSendError(null);

    // B-2 req 4: up to 3 mistakes due for review go into the call so the tutor sets up chances
    // to use them (the post-call review then graduates ones used correctly). Never block the
    // call for more than 3 s on this.
    const dueMistakes: Promise<MistakeData[]> = userId
      ? Promise.race([
          getDueMistakes(userId).catch(() => [] as MistakeData[]),
          new Promise<MistakeData[]>((r) => setTimeout(() => r([]), 3000)),
        ])
      : Promise.resolve([]);

    const preferredVoice = getPreferredVoice(userId);

    Promise.all([dueMistakes, preferredVoice])
      .then(([due, voiceName]) => {
        if (isCancelled) return;
        const reviewTargets = (due || [])
          .slice(0, 3)
          .map((m) => ({ id: m.id, myPhrase: m.myPhrase, naturalPhrase: m.naturalPhrase, reason: m.reason }));
        const systemPrompt = buildTodayLessonSystemPrompt(goal, lessonIndex, placeholders, reviewTargets);
        return provider.connect({
        sessionId: currentSessionId,
        systemPrompt,
        voiceName,
        skipMic: textOnly,
        onMediaStreamReady: (stream) => {
          if (isCancelled || !userId) return;
          // Create the Firestore session only once the mic works (or first written answer),
          // so an unused attempt leaves no empty session behind.
          ensureSessionCreated();
          hasMicRecordingRef.current = true;
          console.log("[NewCallScreen] MediaStream ready, starting 10s chunk recorder...");
          const chunkRecorder = getChunkRecorder();
          chunkRecorder.start(stream, {
            userId,
            sessionId: currentSessionId,
            enablePartialTranscribe,
            onChunkRecorded: () => {
              if (isCancelled) return;
              setChunkCount((prev) => prev + 1);
            },
            onPartialStt: (stt) => {
              if (isCancelled) return;
              setLastPartialSnippet(stt.transcript);
            },
          });
        },
        onMicWarning: (m) => {
          if (isCancelled || textOnly) return;
          setMicWarning(m);
        },
        onAudioData: () => {
          if (isCancelled) return;
          setIsSpeakingModel(true);
          if (modelSpeakingTimeoutRef.current) clearTimeout(modelSpeakingTimeoutRef.current);
          modelSpeakingTimeoutRef.current = setTimeout(() => {
            setIsSpeakingModel(false);
          }, 400);
        },
        onTranscript: (text, isUser) => {
          if (isCancelled) return;
          setTranscripts((prev) => {
            const role = isUser ? "user" : "model";
            const last = prev[prev.length - 1];
            if (last && last.role === role) {
              return [
                ...prev.slice(0, -1),
                { ...last, text: last.text + " " + text.trim() },
              ];
            }
            return [...prev, { role, text: text.trim(), timestamp: Date.now() }];
          });
        },
        onTranscriptLogged: (_item, allTranscripts) => {
          // B-3 Requirement 3: Continuous live transcript saving to Firestore
          if (userId && !isCancelled && sessionCreatedRef.current) {
            (sessionCreatePromiseRef.current || Promise.resolve())
              .then(() => updateSessionLiveTranscript(userId, currentSessionId, allTranscripts))
              .catch(() => {});
          }
        },
        onStatusChange: (newStatus, msg) => {
          if (isCancelled) return;
          setStatus(newStatus);
          if (msg) setStatusMessage(msg);
          if (newStatus === "error") {
            setConnectError(msg || "연결하지 못했어요. 다시 시도해 주세요.");
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
            getChunkRecorder().stop().catch(() => {});
          }

          if (newStatus === "connected") {
            setWrittenSendError(null);
            if (!timerRef.current) {
              timerRef.current = setInterval(() => {
                setCallDuration((prev) => prev + 1);
              }, 1000);
            }
          }
        },
        onInterrupted: () => {
          setIsSpeakingModel(false);
        },
        });
      })
      .catch((err) => {
        if (!isCancelled) {
          setStatus("error");
          const m = err?.userMessage || "연결하지 못했어요. 인터넷을 확인하고 다시 시도해 주세요.";
          setStatusMessage(m);
          setConnectError(m);
        }
      });

    return () => {
      isCancelled = true;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (modelSpeakingTimeoutRef.current) clearTimeout(modelSpeakingTimeoutRef.current);
      getChunkRecorder().stop().catch(() => {});
      provider.disconnect().catch(() => {});
    };
  }, [userId, goal, lessonIndex, placeholders, enablePartialTranscribe, attempt, textOnly]);

  // Auto-scroll transcripts
  useEffect(() => {
    transcriptsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcripts]);

  // Handle Control Buttons (B-2 requirement 5)
  const handleCommand = (cmd: LiveCommand) => {
    providerRef.current.sendControlCommand(cmd);
    setLastAction(cmd);
    setTimeout(() => setLastAction(null), 2500);
  };

  const handleSendWrittenText = () => {
    const formatted = formatWrittenAnswer(writtenText);
    if (!formatted || status !== "connected") return;
    const sent = providerRef.current.sendTextPrompt(formatted.prompt);
    if (!sent) {
      setWrittenSendError("연결이 끊겨 보내지 못했어요");
      return;
    }
    setWrittenSendError(null);
    ensureSessionCreated();
    providerRef.current.appendUserText(formatted.displayText);
    setWrittenText("");
  };

  const handleRetryConnect = () => {
    setConnectError(null);
    setWrittenSendError(null);
    setStatus("connecting");
    setStatusMessage("다시 연결하는 중...");
    setAttempt((a) => a + 1);
  };

  const handleExitAfterError = async () => {
    await getChunkRecorder().stop().catch(() => {});
    await providerRef.current.disconnect().catch(() => {});
    if (onExit) onExit();
    else onEndCall([], undefined, undefined, []);
  };

  // Handle End Call
  const handleHangUp = async () => {
    if (hangingUpRef.current) return;
    hangingUpRef.current = true;
    setHangingUp(true);
    // Nothing was recorded and nothing was written: just leave, no review.
    if (!sessionCreatedRef.current) {
      await handleExitAfterError();
      return;
    }
    await sessionCreatePromiseRef.current;
    const chunkRecorder = getChunkRecorder();
    // Stop first: stop() waits for the last (partial) chunk, so the final words are included.
    await chunkRecorder.stop();
    const recordedBlobs = hasMicRecordingRef.current ? chunkRecorder.getSessionRecordedBlobs() : [];

    const finalTranscripts = providerRef.current.getLiveTranscript();
    const stats = providerRef.current.getConnectionStats();

    if (userId) {
      await finalizeCallSession(userId, sessionIdRef.current, {
        liveTranscript: finalTranscripts,
        connectionPath: stats.connectionPath,
        directFailCount: stats.directFailCount,
      }).catch((err) => console.warn("[NewCallScreen] finalizeCallSession error:", err));
      // B-10 usage: call minutes & completed calls (>= 10s)
      recordUsage(userId, { liveMinutes: callDuration / 60, calls: callsForDuration(callDuration) });
    }

    await providerRef.current.disconnect().catch(() => {});
    onEndCall(finalTranscripts, stats, sessionIdRef.current, recordedBlobs);
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  return (
    <div className="h-screen supports-[height:100dvh]:h-dvh overflow-hidden bg-[#0F141C] text-slate-100 flex flex-col select-none">
      {/* Mic / connection failure: stop the call UI and offer retry or exit */}
      {connectError && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl bg-[#161D2A] border border-rose-500/30 p-5 shadow-2xl">
            <div className="flex items-center gap-2 mb-2">
              <MicOff className="w-5 h-5 text-rose-400" />
              <h3 className="text-sm font-bold text-white">
                {sessionCreatedRef.current && callDuration > 0 ? "통화 연결이 끊겼어요" : "통화를 시작하지 못했어요"}
              </h3>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed mb-4">{connectError}</p>
            <div className="flex gap-2">
              <button
                onClick={handleRetryConnect}
                className="flex-1 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs cursor-pointer"
              >
                다시 시도
              </button>
              {/* A call that already has recordings is ended properly (saved + reviewed), not dropped. */}
              <button
                onClick={handleHangUp}
                disabled={hangingUp}
                className="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 font-bold text-xs cursor-pointer"
              >
                {sessionCreatedRef.current && callDuration > 0 ? "여기서 끝내고 복기 보기" : "나가기"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Top Header */}
      <header className="shrink-0 px-4 sm:px-5 pt-safe pb-4 sm:pb-5 border-b border-slate-800 bg-[#161D2A]/90 backdrop-blur-md flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-amber-400 font-mono tracking-wider">
              {goal.title}
            </span>
            <span className="text-slate-600">·</span>
            <span className="text-xs text-slate-300 font-medium truncate max-w-[200px] sm:max-w-none">
              {currentLesson.index}과. {currentLesson.title}
            </span>
          </div>
          {devMode && (
            <div className="text-[11px] text-slate-400 mt-0.5 flex items-center gap-1.5 font-mono">
              <Shield className="w-3 h-3 text-emerald-400" />
              <span>gemini-3.8-live · 세션 재개 & 컨텍스트 압축 ON</span>
            </div>
          )}
        </div>

        {/* Status Pill */}
        <div className="flex items-center gap-2">
          {displayStatus === "reconnecting" ? (
            <div className="px-3 py-1.5 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-bold animate-pulse flex items-center gap-1.5 shadow-lg shadow-amber-500/10">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
              <span>연결 유지 중</span>
            </div>
          ) : displayStatus === "connected" ? (
            <div className="px-3 py-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-bold flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>{formatTime(callDuration)}</span>
            </div>
          ) : displayStatus === "error" ? (
            <div className="px-3 py-1.5 rounded-full bg-rose-500/20 border border-rose-500/40 text-rose-300 text-xs font-bold">
              연결 오류
            </div>
          ) : displayStatus === "closed" ? (
            <div className="px-3 py-1.5 rounded-full bg-slate-800 text-slate-400 text-xs font-medium">
              통화 종료
            </div>
          ) : (
            <div className="px-3 py-1.5 rounded-full bg-slate-800 text-slate-300 text-xs font-medium animate-pulse">
              연결 중...
            </div>
          )}
        </div>
      </header>

      {/* Main Conversation Stream */}
      <main className="flex-1 min-h-0 max-w-2xl w-full mx-auto p-4 sm:p-6 overflow-y-auto overscroll-contain space-y-4">
        {/* Screen Keep-On notice (one line, no jargon) */}
        <div className="px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center gap-2 text-xs text-amber-200">
          <Smartphone className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="truncate">화면을 켜 두세요. 대화는 10초마다 자동 저장돼요.</span>
        </div>

        {/* Mic guidance (call stays connected without mic) */}
        {micWarning && !connectError && (
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs flex items-center justify-between gap-2">
            <span>{micWarning} 튜터 목소리는 계속 들을 수 있어요.</span>
            <button
              type="button"
              onClick={() => setAttempt((a) => a + 1)}
              className="shrink-0 px-2 py-1 rounded-lg bg-rose-500/20 border border-rose-500/40 font-bold"
            >
              다시 시도
            </button>
          </div>
        )}

        {/* Reconnect notice banner */}
        {showReconnectNotice && (
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs text-center font-medium animate-pulse">
            연결이 잠깐 끊겨 다시 잇는 중이에요. 대화는 그대로 이어져요.
          </div>
        )}

        {/* Action feedback flash */}
        {lastAction && (
          <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 px-4 py-1.5 rounded-full bg-amber-500 text-slate-950 font-bold text-xs shadow-xl animate-bounce">
            {COMMAND_LABELS[lastAction] || lastAction} 요청을 보냈어요
          </div>
        )}

        {/* Live Audio Indicator & Orb */}
        <div className="py-6 flex flex-col items-center justify-center">
          <div
            className={`w-28 h-28 sm:w-32 sm:h-32 rounded-full flex items-center justify-center transition-all duration-300 shadow-2xl ${
              isSpeakingModel
                ? "bg-gradient-to-tr from-amber-500 to-amber-300 ring-8 ring-amber-500/30 scale-105"
                : status === "connected"
                ? "bg-slate-800/80 ring-4 ring-slate-700/50"
                : "bg-slate-900 ring-2 ring-slate-800"
            }`}
          >
            {isSpeakingModel ? (
              <Volume2 className="w-12 h-12 text-slate-950 animate-pulse" />
            ) : textOnly ? (
              <MicOff className="w-12 h-12 text-slate-400" />
            ) : (
              <Mic className="w-12 h-12 text-slate-400" />
            )}
          </div>
          <p className="text-xs text-slate-400 mt-3 font-medium text-center">
            {isSpeakingModel
              ? "튜터가 답변하는 중..."
              : displayStatus === "connected"
              ? textOnly
                ? "마이크 없이 연결됨 · 아래 입력창에 영어로 답해 보세요"
                : "자유롭게 영어로 말해 보세요 (다 말했으면 '답변 끝')"
              : statusMessage}
          </p>
        </div>

        {/* Transcript rolling area (Live 자체 받아쓰기 보조 표시) */}
        <div className="space-y-3 pt-2">
          {transcripts.length === 0 ? (
            <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800/60 text-center text-xs text-slate-500">
              첫 마디를 나누면 실시간 받아쓰기 내용이 이곳에 표시됩니다.
            </div>
          ) : (
            transcripts.map((item, idx) => (
              <div
                key={idx}
                className={`flex gap-2.5 ${
                  item.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-xs leading-relaxed ${
                    item.role === "user"
                      ? "bg-amber-500/20 border border-amber-500/30 text-amber-100 rounded-tr-none"
                      : "bg-[#161D2A] border border-slate-800 text-slate-200 rounded-tl-none shadow-md"
                  }`}
                >
                  <span className="text-[10px] uppercase font-bold block mb-0.5 opacity-60">
                    {item.role === "user" ? "You" : "Tutor"}
                  </span>
                  <span>{item.text}</span>
                </div>
              </div>
            ))
          )}
          <div ref={transcriptsEndRef} />
        </div>
      </main>

      {/* Bottom Controls Toolbar (B-2 requirement 5) */}
      <footer className="shrink-0 px-4 sm:px-5 pt-4 sm:pt-5 pb-safe border-t border-slate-800 bg-[#161D2A]/95 backdrop-blur-md">
        <div className="max-w-2xl mx-auto space-y-3">
          {/* 5 Core Control Buttons: Done / Feedback / Model answer / Pause / Slow
              Shown only once connected; before that, explain why. */}
          {status !== "connected" ? (
            <p className="text-center text-[11px] text-slate-400 py-1">
              {status === "reconnecting" ? "다시 연결되면 버튼을 쓸 수 있어요." : "튜터와 연결되면 답변 끝·피드백·모범답 버튼이 나와요."}
            </p>
          ) : (
          <div className="space-y-2.5">
            <div className="grid grid-cols-5 gap-2">
              <button
                onClick={() => handleCommand("Done")}
                className="py-2.5 px-1 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-40 border border-amber-500/40 text-amber-300 font-bold text-xs flex flex-col items-center justify-center gap-1 transition-all cursor-pointer active:scale-95"
                title="답변 종료 및 핵심 피드백 요청"
              >
                <CheckCircle2 className="w-4 h-4 text-amber-400" />
                <span>답변 끝</span>
              </button>

              <button
                onClick={() => handleCommand("Feedback")}
                className="py-2.5 px-1 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 disabled:opacity-40 border border-slate-700/60 text-slate-200 font-bold text-xs flex flex-col items-center justify-center gap-1 transition-all cursor-pointer active:scale-95"
                title="방금 답변에 대한 피드백 요청"
              >
                <MessageSquare className="w-4 h-4 text-sky-400" />
                <span>피드백</span>
              </button>

              <button
                onClick={() => handleCommand("Model answer")}
                className="py-2.5 px-1 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 disabled:opacity-40 border border-slate-700/60 text-slate-200 font-bold text-xs flex flex-col items-center justify-center gap-1 transition-all cursor-pointer active:scale-95"
                title="60초 AL 모범 답안 청취"
              >
                <Sparkles className="w-4 h-4 text-purple-400" />
                <span>모범답</span>
              </button>

              <button
                onClick={() => handleCommand("Pause")}
                className="py-2.5 px-1 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 disabled:opacity-40 border border-slate-700/60 text-slate-200 font-bold text-xs flex flex-col items-center justify-center gap-1 transition-all cursor-pointer active:scale-95"
                title="장면 일시정지 및 점검"
              >
                <Pause className="w-4 h-4 text-amber-400" />
                <span>잠깐</span>
              </button>

              <button
                onClick={() => handleCommand("Slow")}
                className="py-2.5 px-1 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 disabled:opacity-40 border border-slate-700/60 text-slate-200 font-bold text-xs flex flex-col items-center justify-center gap-1 transition-all cursor-pointer active:scale-95"
                title="천천히 또박또박 말하기"
              >
                <Clock className="w-4 h-4 text-emerald-400" />
                <span>천천히</span>
              </button>
            </div>

            {/* Written reply input (always available when connected, including mic-less/textOnly calls) */}
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={writtenText}
                  maxLength={WRITTEN_ANSWER_MAX_LENGTH}
                  onChange={(e) => {
                    setWrittenText(e.target.value.slice(0, WRITTEN_ANSWER_MAX_LENGTH));
                    if (writtenSendError) setWrittenSendError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      handleSendWrittenText();
                    }
                  }}
                  placeholder="글로 답하기 (영어로 입력 후 Enter)"
                  aria-label="글로 답하기"
                  className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-slate-900/90 border border-slate-700/80 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-amber-400/70 select-text"
                />
                <button
                  type="button"
                  onClick={handleSendWrittenText}
                  disabled={!formatWrittenAnswer(writtenText)}
                  className="shrink-0 px-3.5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-slate-950 font-bold text-xs flex items-center gap-1.5 transition-all cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>보내기</span>
                </button>
              </div>
              {writtenSendError && (
                <p className="text-[11px] text-rose-300 px-1 truncate" role="alert">
                  {writtenSendError}
                </p>
              )}
            </div>
          </div>
          )}

          {/* End Call Button */}
          <button
            onClick={handleHangUp}
            disabled={hangingUp}
            className="w-full py-3.5 px-4 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-60 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-rose-600/25 transition-all cursor-pointer"
          >
            <PhoneOff className="w-4 h-4" />
            <span>{hangingUp ? "통화를 마무리하는 중..." : "통화 종료"}</span>
          </button>
        </div>
      </footer>
    </div>
  );
};
