import { authFetch } from "../../services/api/authFetch";
import React, { useState, useEffect, useRef } from "react";
import { User } from "firebase/auth";
import {
  MistakeData,
  graduateMistakeAfterQuiz,
  updateMistakeMeaningKo,
  saveQuizAttempt,
} from "../../services/firebase/db";
import {
  X,
  Mic,
  Square,
  Send,
  CheckCircle2,
  XCircle,
  GraduationCap,
  Sparkles,
  ArrowRight,
  Loader2,
  Keyboard,
  Volume2,
  RotateCcw,
  AlertCircle,
  Check,
} from "lucide-react";

/** First recording format this browser supports, or "" to let it choose. */
function pickRecordingMimeType(): string {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

interface QuizModalProps {
  user: User;
  dueMistakes: MistakeData[];
  isOpen: boolean;
  onClose: () => void;
  onFinished?: () => void;
}

interface QuizQueueItem {
  mistake: MistakeData;
  isRetry: boolean;
}

interface GradeResult {
  passed: boolean;
  feedback: string;
  correctAnswer: string;
}

export const QuizModal: React.FC<QuizModalProps> = ({
  user,
  dueMistakes,
  isOpen,
  onClose,
  onFinished,
}) => {
  // Queue & Progress
  const [queue, setQueue] = useState<QuizQueueItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [initialCount, setInitialCount] = useState<number>(0);
  const [graduatedIds, setGraduatedIds] = useState<Set<string>>(new Set());

  // Input & Mode
  const [mode, setMode] = useState<"type" | "speak">("type");
  const [typedAnswer, setTypedAnswer] = useState<string>("");
  const [spokenTranscript, setSpokenTranscript] = useState<string>("");

  // Recording state
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Grading & Feedback State
  const [isGrading, setIsGrading] = useState<boolean>(false);
  const [gradeResult, setGradeResult] = useState<GradeResult | null>(null);
  const [submittedAnswer, setSubmittedAnswer] = useState<string>("");

  // MeaningKo loading state
  const [isTranslating, setIsTranslating] = useState<boolean>(false);
  const [meaningMap, setMeaningMap] = useState<Record<string, string>>({});

  // Initialize Quiz
  useEffect(() => {
    if (!isOpen) {
      setQueue([]);
      setCurrentIndex(0);
      setGraduatedIds(new Set());
      setGradeResult(null);
      setTypedAnswer("");
      setSpokenTranscript("");
      return;
    }

    // Limit to max 10 mistakes for today's quiz
    const selected = dueMistakes.slice(0, 10);
    const initialItems: QuizQueueItem[] = selected.map((m) => ({
      mistake: m,
      isRetry: false,
    }));

    setQueue(initialItems);
    setInitialCount(initialItems.length);
    setCurrentIndex(0);
    setGraduatedIds(new Set());
    setGradeResult(null);
    setTypedAnswer("");
    setSpokenTranscript("");

    // Check if any mistakes lack meaningKo and generate them
    const missing = selected.filter((m) => !m.meaningKo && m.id);
    if (missing.length > 0) {
      fetchMissingMeanings(missing);
    } else {
      const map: Record<string, string> = {};
      selected.forEach((m) => {
        if (m.id && m.meaningKo) map[m.id] = m.meaningKo;
      });
      setMeaningMap(map);
    }
  }, [isOpen, dueMistakes]);

  // Fetch Korean meanings via /api/quiz/meaning-ko
  const fetchMissingMeanings = async (items: MistakeData[]) => {
    try {
      setIsTranslating(true);
      const res = await authFetch("/api/quiz/meaning-ko", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items.map((m) => ({
            id: m.id,
            naturalPhrase: m.naturalPhrase,
            reason: m.reason,
          })),
        }),
      });

      const data = await res.json();
      if (data.ok && Array.isArray(data.meanings)) {
        const newMap: Record<string, string> = { ...meaningMap };
        for (const item of data.meanings) {
          if (item.id && item.meaningKo) {
            newMap[item.id] = item.meaningKo;
            // Persist to Firestore for permanent reuse
            updateMistakeMeaningKo(user.uid, item.id, item.meaningKo).catch(console.warn);
          }
        }
        setMeaningMap(newMap);
      }
    } catch (err) {
      console.warn("[QuizModal] Error fetching meanings:", err);
    } finally {
      setIsTranslating(false);
    }
  };

  if (!isOpen) return null;

  const currentItem = queue[currentIndex];
  const isFinished = currentIndex >= queue.length;

  // Speak audio playback helper
  const playAudio = (text: string) => {
    try {
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "en-US";
        u.rate = 0.95;
        window.speechSynthesis.speak(u);
      }
    } catch (e) {
      console.warn("TTS error:", e);
    }
  };

  // Start Voice Recording
  const handleStartRecording = async () => {
    let stream: MediaStream;
    try {
      audioChunksRef.current = [];
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      const denied = err?.name === "NotAllowedError" || err?.name === "SecurityError";
      alert(denied ? "마이크 권한을 허용해 주세요." : "마이크를 찾지 못했어요. 이어폰·브라우저 설정을 확인해 주세요.");
      console.error("Mic access error:", err);
      return;
    }
    try {
      // Use a format this browser can record (iPhone Safari may not record WebM).
      const mimeType = pickRecordingMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const type = recorder.mimeType || mimeType || "audio/webm";
        const audioBlob = new Blob(audioChunksRef.current, { type });
        await handleTranscribeAudio(audioBlob);
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setSpokenTranscript("");
    } catch (err) {
      stream.getTracks().forEach((track) => track.stop());
      alert("이 브라우저에서는 음성 녹음을 할 수 없어요. 타이핑으로 답해 주세요.");
      console.error("MediaRecorder error:", err);
    }
  };

  // Stop Voice Recording
  const handleStopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  // Transcribe Audio via gemini-3.5-transcribe (VERBATIM)
  const handleTranscribeAudio = async (blob: Blob) => {
    try {
      setIsTranscribing(true);
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onloadend = () => {
          const res = reader.result as string;
          // "data:<type>;base64,<data>" (the type may carry ";codecs=..." too)
          resolve(res.slice(res.indexOf(",") + 1));
        };
        reader.onerror = reject;
      });
      reader.readAsDataURL(blob);

      const audioBase64 = await base64Promise;
      const res = await authFetch("/api/gemini/transcribe-final", {
        method: "POST",
        body: JSON.stringify({
          audioBase64,
          // Server/Gemini wants the bare type ("audio/mp4"), not "audio/mp4;codecs=..."
          mimeType: (blob.type || "audio/webm").split(";")[0],
        }),
      });

      const data = await res.json();
      const text = data.ok && data.transcript ? data.transcript.trim() : "";
      setSpokenTranscript(text);

      // Auto-submit voice answer if transcribed
      if (text) {
        await handleGradeAnswer(text, "speak");
      }
    } catch (err: any) {
      alert(`음성 인식 오류: ${err?.message || err}`);
    } finally {
      setIsTranscribing(false);
    }
  };

  // Grade user answer
  const handleGradeAnswer = async (answerText: string, submissionMode: "type" | "speak") => {
    if (!currentItem || isGrading) return;
    const cleanAnswer = answerText.trim();
    if (!cleanAnswer) return;

    const m = currentItem.mistake;
    setIsGrading(true);
    setSubmittedAnswer(cleanAnswer);

    try {
      const res = await authFetch("/api/quiz/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mistakeId: m.id,
          myPhrase: m.myPhrase,
          naturalPhrase: m.naturalPhrase,
          reason: m.reason,
          answer: cleanAnswer,
        }),
      });

      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || "채점 실패");
      }

      const result: GradeResult = {
        passed: Boolean(data.passed),
        feedback: data.feedback || "",
        correctAnswer: data.correctAnswer || m.naturalPhrase,
      };
      setGradeResult(result);

      // Save quiz attempt in users/{uid}/quizAttempts
      if (m.id) {
        await saveQuizAttempt(user.uid, {
          mistakeId: m.id,
          mode: submissionMode,
          answer: cleanAnswer,
          passed: result.passed,
          feedback: result.feedback,
          createdAt: new Date().toISOString(),
        });
      }

      if (result.passed) {
        // Graduate mistake!
        if (m.id) {
          await graduateMistakeAfterQuiz(user.uid, m.id);
          setGraduatedIds((prev) => new Set([...prev, m.id!]));
        }
      } else {
        // Failed: add back to end of queue for 1 same-day retry if not already a retry
        if (!currentItem.isRetry) {
          setQueue((prev) => [...prev, { mistake: m, isRetry: true }]);
        }
      }
    } catch (err: any) {
      alert(`채점 중 오류가 발생했습니다: ${err?.message || err}`);
    } finally {
      setIsGrading(false);
    }
  };

  // Move to next card
  const handleNext = () => {
    setGradeResult(null);
    setTypedAnswer("");
    setSpokenTranscript("");
    setCurrentIndex((prev) => prev + 1);
  };

  const handleFinishQuiz = () => {
    onFinished?.();
    onClose();
  };

  // Get meaningKo for current mistake
  const currentMeaning = currentItem
    ? meaningMap[currentItem.mistake.id || ""] ||
      currentItem.mistake.meaningKo ||
      "다음 한국어 상황에 맞는 자연스러운 영어 표현을 완성하세요"
    : "";

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-[#141B28] border border-slate-700/80 rounded-3xl shadow-2xl flex flex-col overflow-hidden max-h-[92vh] animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-[#101622]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-white">오늘의 복습 퀴즈</h3>
                {!isFinished && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-800 text-amber-400 border border-slate-700">
                    {currentIndex + 1} / {queue.length}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400">
                핵심 교정 포인트를 맞히면 바로 졸업합니다
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {graduatedIds.size > 0 && (
              <span className="text-xs font-bold text-emerald-400 flex items-center gap-1 font-mono bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/20">
                <GraduationCap className="w-3.5 h-3.5" />
                <span>{graduatedIds.size}개 졸업</span>
              </span>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-5 sm:p-6 flex-1 overflow-y-auto space-y-5">
          {isFinished ? (
            /* Finished Summary Screen */
            <div className="text-center py-8 space-y-5 animate-in fade-in duration-300">
              <div className="w-16 h-16 rounded-3xl bg-amber-500/15 border border-amber-500/40 text-amber-400 flex items-center justify-center mx-auto shadow-xl">
                <GraduationCap className="w-8 h-8" />
              </div>
              <div>
                <h2 className="text-xl font-black text-white">오늘 퀴즈 완료!</h2>
                <p className="text-xs text-slate-400 mt-1">
                  총 {initialCount}개 대상 중 {graduatedIds.size}개 표현을 완벽하게 졸업시켰습니다.
                </p>
              </div>

              <div className="p-4 rounded-2xl bg-[#101622] border border-slate-800 max-w-sm mx-auto space-y-2 text-xs">
                <div className="flex justify-between text-slate-300">
                  <span>총 푼 문항</span>
                  <span className="font-mono font-bold text-white">{initialCount}개</span>
                </div>
                <div className="flex justify-between text-emerald-400 font-bold">
                  <span>새로 졸업한 표현</span>
                  <span className="font-mono">{graduatedIds.size}개</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>복습 유지 / 재도전</span>
                  <span className="font-mono">{Math.max(0, initialCount - graduatedIds.size)}개</span>
                </div>
              </div>

              <button
                onClick={handleFinishQuiz}
                className="w-full max-w-sm mx-auto py-3.5 px-6 rounded-2xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-amber-500/20 transition-all cursor-pointer active:scale-98"
              >
                <span>홈으로 돌아가기</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          ) : (
            /* Flashcard View */
            <div className="space-y-4">
              {/* Flashcard Front Container */}
              <div className="p-5 rounded-2xl bg-gradient-to-b from-[#182233] to-[#121926] border border-slate-700/80 shadow-lg space-y-3 relative overflow-hidden">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-amber-400 tracking-wide uppercase flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>한국어 뜻 (플래시카드)</span>
                  </span>
                  {currentItem.isRetry && (
                    <span className="text-[10px] font-bold font-mono px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 flex items-center gap-1">
                      <RotateCcw className="w-3 h-3" />
                      <span>재도전 문항</span>
                    </span>
                  )}
                </div>

                {/* Korean Meaning */}
                <div className="text-lg sm:text-xl font-bold text-white leading-snug">
                  {isTranslating ? (
                    <div className="flex items-center gap-2 text-slate-400 text-sm py-1">
                      <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                      <span>한국어 뜻 생성 중...</span>
                    </div>
                  ) : (
                    currentMeaning
                  )}
                </div>

                {/* Hint: Reason (한 줄 힌트) */}
                <div className="pt-2 border-t border-slate-800/80 flex items-start gap-2 text-xs text-slate-400">
                  <span className="text-amber-400/80 font-bold shrink-0">💡 힌트:</span>
                  <span className="leading-relaxed">{currentItem.mistake.reason}</span>
                </div>
              </div>

              {/* Mode Toggle (말하기 vs 타이핑) - only show before graded */}
              {!gradeResult && (
                <div className="flex rounded-xl bg-slate-900/80 p-1 border border-slate-800">
                  <button
                    onClick={() => setMode("type")}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                      mode === "type"
                        ? "bg-amber-500 text-slate-950 shadow-md"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    <Keyboard className="w-3.5 h-3.5" />
                    <span>타이핑으로 풀기</span>
                  </button>
                  <button
                    onClick={() => setMode("speak")}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                      mode === "speak"
                        ? "bg-amber-500 text-slate-950 shadow-md"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    <Mic className="w-3.5 h-3.5" />
                    <span>말하기로 풀기</span>
                  </button>
                </div>
              )}

              {/* Input Area (Before Grade) */}
              {!gradeResult && (
                <div>
                  {mode === "type" ? (
                    <div className="space-y-3">
                      <div className="relative">
                        <textarea
                          value={typedAnswer}
                          onChange={(e) => setTypedAnswer(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              if (typedAnswer.trim()) handleGradeAnswer(typedAnswer, "type");
                            }
                          }}
                          placeholder="자연스러운 영어 문장을 입력하세요... (Enter 키로 채점)"
                          rows={3}
                          disabled={isGrading}
                          className="w-full bg-[#101622] border border-slate-700 rounded-xl p-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 transition-all resize-none"
                        />
                      </div>

                      <button
                        onClick={() => handleGradeAnswer(typedAnswer, "type")}
                        disabled={isGrading || !typedAnswer.trim()}
                        className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer active:scale-98 shadow-md"
                      >
                        {isGrading ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>채점 중...</span>
                          </>
                        ) : (
                          <>
                            <Send className="w-3.5 h-3.5" />
                            <span>답안 제출 및 채점하기</span>
                          </>
                        )}
                      </button>
                    </div>
                  ) : (
                    /* Speak Mode */
                    <div className="p-5 rounded-2xl bg-[#101622] border border-slate-800 text-center space-y-4">
                      <div className="text-xs text-slate-400">
                        {isRecording
                          ? "영어 문장을 말씀하세요. 다 말씀하신 뒤 정지를 누르세요."
                          : "마이크 버튼을 누르고 자연스러운 영어로 말씀하세요."}
                      </div>

                      <div className="flex justify-center">
                        {isRecording ? (
                          <button
                            onClick={handleStopRecording}
                            className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center shadow-lg shadow-red-500/30 animate-pulse transition-all cursor-pointer"
                          >
                            <Square className="w-6 h-6 fill-white" />
                          </button>
                        ) : (
                          <button
                            onClick={handleStartRecording}
                            disabled={isTranscribing || isGrading}
                            className="w-16 h-16 rounded-full bg-amber-500 hover:bg-amber-400 text-slate-950 flex items-center justify-center shadow-lg shadow-amber-500/20 transition-all cursor-pointer active:scale-95 disabled:opacity-50"
                          >
                            <Mic className="w-7 h-7" />
                          </button>
                        )}
                      </div>

                      <div className="text-[11px] font-mono text-slate-500">
                        {isRecording && <span className="text-red-400 font-bold">● 녹음 중... (정지 버튼 클릭)</span>}
                        {isTranscribing && (
                          <span className="text-amber-400 flex items-center justify-center gap-1.5">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            <span>음성 받아쓰는 중...</span>
                          </span>
                        )}
                        {isGrading && (
                          <span className="text-amber-400 flex items-center justify-center gap-1.5">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            <span>채점 중...</span>
                          </span>
                        )}
                      </div>

                      {/* Display transcribed utterance verbatim */}
                      {spokenTranscript && (
                        <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 text-left text-xs space-y-1">
                          <span className="text-[10px] font-bold text-slate-400 uppercase">인식된 발화 (VERBATIM):</span>
                          <div className="font-mono text-amber-300 font-semibold">"{spokenTranscript}"</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Instant Feedback Result Display (After Grade) */}
              {gradeResult && (
                <div className="space-y-4 animate-in fade-in duration-200">
                  <div
                    className={`p-4 rounded-2xl border flex items-start gap-3 ${
                      gradeResult.passed
                        ? "bg-emerald-950/20 border-emerald-500/40"
                        : "bg-red-950/20 border-red-500/40"
                    }`}
                  >
                    {gradeResult.passed ? (
                      <div className="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
                        <CheckCircle2 className="w-6 h-6" />
                      </div>
                    ) : (
                      <div className="w-10 h-10 rounded-xl bg-red-500/20 text-red-400 flex items-center justify-center shrink-0">
                        <XCircle className="w-6 h-6" />
                      </div>
                    )}

                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <h4
                          className={`text-sm font-black ${
                            gradeResult.passed ? "text-emerald-400" : "text-red-400"
                          }`}
                        >
                          {gradeResult.passed ? "통과! 즉시 졸업 (Graduated) 🎉" : "아쉬워요! 핵심 포인트를 다시 확인해 보세요"}
                        </h4>
                        {gradeResult.passed && (
                          <span className="px-2 py-0.5 rounded-full bg-emerald-500 text-slate-950 text-[10px] font-black uppercase">
                            졸업
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        {gradeResult.feedback}
                      </p>
                    </div>
                  </div>

                  {/* Submitted Answer vs Target Answer */}
                  <div className="p-4 rounded-2xl bg-[#101622] border border-slate-800 space-y-3 text-xs">
                    <div>
                      <span className="text-[10px] text-slate-500 uppercase font-bold block mb-1">
                        내가 제출한 답변 ({mode === "speak" ? "말하기" : "타이핑"}):
                      </span>
                      <div className="font-mono text-slate-200 bg-slate-900/80 px-3 py-2 rounded-lg border border-slate-800">
                        "{submittedAnswer}"
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-emerald-400 uppercase font-bold">
                          자연스러운 원문 정답:
                        </span>
                        <button
                          onClick={() => playAudio(gradeResult.correctAnswer)}
                          className="text-[11px] text-slate-400 hover:text-white flex items-center gap-1 cursor-pointer"
                        >
                          <Volume2 className="w-3 h-3 text-amber-400" />
                          <span>발음 듣기</span>
                        </button>
                      </div>
                      <div className="font-mono text-emerald-300 font-bold bg-emerald-950/20 px-3 py-2 rounded-lg border border-emerald-800/40">
                        "{gradeResult.correctAnswer}"
                      </div>
                    </div>

                    {/* Show previous mistake (myPhrase) ONLY AFTER grading as per spec */}
                    <div className="pt-2 border-t border-slate-800">
                      <span className="text-[10px] text-slate-500 uppercase font-bold block mb-1">
                        예전 통화에서 했던 실수 (오답 복기):
                      </span>
                      <div className="font-mono text-red-300 line-through decoration-red-400/50 bg-red-950/15 px-3 py-1.5 rounded-lg border border-red-900/30">
                        "{currentItem.mistake.myPhrase}"
                      </div>
                    </div>

                    {!gradeResult.passed && !currentItem.isRetry && (
                      <div className="text-[11px] text-purple-300 bg-purple-950/20 p-2.5 rounded-lg border border-purple-800/40 flex items-center gap-2">
                        <RotateCcw className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                        <span>오늘 퀴즈 맨 뒤에 1회 재도전 문항으로 다시 추가되었습니다.</span>
                      </div>
                    )}
                  </div>

                  {/* Next Question CTA */}
                  <button
                    onClick={handleNext}
                    className="w-full py-3.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer active:scale-98 shadow-md"
                  >
                    <span>{currentIndex + 1 < queue.length ? "다음 문항으로" : "결과 확인하기"}</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
