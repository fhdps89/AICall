import React, { useState } from "react";
import {
  SessionReviewData,
  SttFinalData,
  createQualityReport,
} from "../../services/firebase/db";
import {
  Check,
  Copy,
  Volume2,
  X,
  BookmarkCheck,
  ArrowRight,
  Sparkles,
  AlertTriangle,
  FileText,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  CheckCircle,
} from "lucide-react";
import { authFetch } from "../../services/api/authFetch";

export interface ReviewModalProps {
  userId?: string;
  sessionId?: string;
  goalId?: string;
  lessonIndex?: number;
  goalTitle?: string;
  lessonTitle?: string;
  review: SessionReviewData | any;
  sttFinal?: SttFinalData;
  onClose: () => void;
  onOpenPodcast?: () => void;
}

export const ReviewModal: React.FC<ReviewModalProps> = ({
  userId,
  sessionId,
  goalId = "opic",
  lessonIndex = 1,
  goalTitle,
  lessonTitle,
  review,
  sttFinal,
  onClose,
  onOpenPodcast,
}) => {
  const [copied, setCopied] = useState<boolean>(false);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [hiddenMistakes, setHiddenMistakes] = useState<Set<number>>(new Set());
  const [reportedMessage, setReportedMessage] = useState<string | null>(null);
  const [showFullTranscript, setShowFullTranscript] = useState<boolean>(false);

  // All mistakes from review
  const allMistakes: any[] = review?.mistakes || [];
  // Visible mistakes (excluding those hidden by "이건 내가 한 말이 아니에요")
  const visibleMistakes = allMistakes.filter((_, idx) => !hiddenMistakes.has(idx));

  // Keep Sync Text generator (B-4 requirement 3: 내가 한 말 -> 자연스러운 표현, 줄마다 하나)
  const getKeepCopyText = () => {
    if (visibleMistakes.length === 0) return "오늘 특별한 문법적 실수가 없습니다.";
    return visibleMistakes
      .map((m) => `${m.myPhrase} -> ${m.naturalPhrase}`)
      .join("\n");
  };

  const handleCopyKeep = () => {
    const textToCopy = getKeepCopyText();
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  // B-4 Requirement 3: "이건 내가 한 말이 아니에요" button
  const handleReportNotMyWord = async (idx: number, m: any) => {
    // 1. Hide from visible table
    setHiddenMistakes((prev) => {
      const next = new Set(prev);
      next.add(idx);
      return next;
    });

    // 2. Save report to qualityReports collection
    if (userId && sessionId) {
      try {
        await createQualityReport(userId, {
          sessionId,
          myPhrase: m.myPhrase || "",
          sourceStt: m.sourceStt || sttFinal?.sourceStt || "sttFinal",
          reportedAt: new Date().toISOString(),
          reason: "사용자가 '이건 내가 한 말이 아니에요'로 오인식 보고",
        });
      } catch (err) {
        console.warn("[ReviewModal] Failed to create qualityReport:", err);
      }
    }

    setReportedMessage(`"${m.myPhrase}" 항목이 품질 리포트에 기록되고 화면에서 제외되었습니다.`);
    setTimeout(() => setReportedMessage(null), 3500);
  };

  const handlePlayTts = async (text: string, index: number) => {
    try {
      setPlayingIndex(index);
      const res = await authFetch("/api/gemini/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voiceName: "Kore",
        }),
      });
      const data = await res.json();
      if (data.audioBase64) {
        const audio = new Audio(`data:${data.mimeType || "audio/wav"};base64,${data.audioBase64}`);
        audio.onended = () => setPlayingIndex(null);
        audio.onerror = () => setPlayingIndex(null);
        await audio.play();
      } else {
        setPlayingIndex(null);
      }
    } catch {
      setPlayingIndex(null);
    }
  };

  const getLevelColor = (level: string) => {
    switch (level) {
      case "AL":
      case "Native":
        return "text-emerald-400 bg-emerald-950/60 border-emerald-500/40";
      case "IH":
        return "text-amber-400 bg-amber-950/60 border-amber-500/40";
      default:
        return "text-sky-400 bg-sky-950/60 border-sky-500/40";
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/85 backdrop-blur-md overflow-y-auto">
      <div className="relative w-full max-w-3xl max-h-[94vh] overflow-y-auto bg-[#161D2A] border border-slate-800 rounded-3xl p-5 sm:p-6 text-slate-100 shadow-2xl flex flex-col gap-5">
        
        {/* Top Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-800/80 pb-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-amber-400 font-mono">
              <span>{goalTitle || goalId.toUpperCase()}</span>
              <span className="text-slate-600">·</span>
              <span className="text-slate-300 font-normal">
                {lessonIndex}과 {lessonTitle ? `(${lessonTitle})` : ""}
              </span>
            </div>
            <h2 className="text-lg sm:text-xl font-bold text-white mt-1 flex items-center gap-2">
              <span>통화 복기 & 실수 분석</span>
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-slate-800 text-slate-400 hover:text-white transition cursor-pointer"
            aria-label="닫기"
          >
            <X size={20} />
          </button>
        </div>

        {/* Floating feedback alert when a mistake is reported */}
        {reportedMessage && (
          <div className="p-3 rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-200 text-xs flex items-center gap-2 animate-in fade-in duration-200">
            <CheckCircle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>{reportedMessage}</span>
          </div>
        )}

        {/* Level & Evaluation Banner (B-4 requirement 3: AI 예상 레벨 옆에 "AI 예상치, 공식 등급 아님") */}
        <div className="bg-[#1C2433] border border-slate-800 rounded-2xl p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <span className="text-xs text-slate-400 font-medium">오늘의 총평</span>
            <p className="text-sm md:text-base font-semibold text-slate-100 leading-snug">
              {review?.overallEvaluation || "성공적으로 통화가 완료되었습니다."}
            </p>
          </div>
          <div className="shrink-0 flex flex-col items-start md:items-end gap-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400 font-medium">AI 예상 레벨:</span>
              <span
                className={`px-3 py-1 rounded-xl text-sm font-extrabold border ${getLevelColor(
                  review?.estimatedLevel || "IH"
                )}`}
              >
                {review?.estimatedLevel || "IH"}
              </span>
            </div>
            <span className="text-[11px] text-slate-400 font-normal">
              ※ AI 예상치, 공식 등급 아님
            </span>
          </div>
        </div>

        {/* Mistake Log Table (B-4 requirement 3: 내가 한 말 -> 자연스러운 표현 -> 이유) */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400"></span>
              오늘의 실수 교정 내역 ({visibleMistakes.length}개)
            </h3>
            <span className="text-xs text-slate-400">
              mistakes 컬렉션 자동 저장됨
            </span>
          </div>

          {visibleMistakes.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-400 bg-[#1C2433]/50 rounded-2xl">
              오늘 대화에서는 큰 문법적 실수가 발견되지 않았습니다. 훌륭합니다!
            </div>
          ) : (
            <div className="space-y-3">
              {allMistakes.map((m, idx) => {
                if (hiddenMistakes.has(idx)) return null;
                return (
                  <div
                    key={idx}
                    className="bg-[#1C2433] border border-slate-800/80 rounded-2xl p-4 transition hover:border-slate-700"
                  >
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                      {/* My Phrase (Copied word-for-word from sttFinal) */}
                      <div className="p-3 rounded-xl bg-red-950/20 border border-red-900/30 flex flex-col justify-between">
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs font-semibold text-red-400">
                              내가 한 말 (녹음 전사 원본)
                            </span>
                            <span className="text-[10px] font-mono text-slate-500">
                              {m.sourceStt || sttFinal?.sourceStt || "sttFinal"}
                            </span>
                          </div>
                          <p className="text-red-200 font-mono text-xs md:text-sm leading-relaxed">
                            "{m.myPhrase}"
                          </p>
                        </div>

                        {/* "이건 내가 한 말이 아니에요" button (B-4 requirement 3) */}
                        <div className="mt-3 pt-2 border-t border-red-900/20 flex justify-end">
                          <button
                            onClick={() => handleReportNotMyWord(idx, m)}
                            className="text-[11px] text-slate-400 hover:text-rose-300 flex items-center gap-1 px-2 py-1 rounded bg-slate-900/60 hover:bg-rose-950/40 border border-slate-800 hover:border-rose-900/50 transition cursor-pointer"
                            title="STT 오인식 등으로 내가 말하지 않은 문장인 경우 숨기고 품질 리포트에 기록합니다"
                          >
                            <AlertTriangle size={12} className="text-amber-400" />
                            <span>이건 내가 한 말이 아니에요</span>
                          </button>
                        </div>
                      </div>

                      {/* Natural Native Phrase */}
                      <div className="p-3 rounded-xl bg-emerald-950/30 border border-emerald-900/40 flex flex-col justify-between">
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs font-semibold text-emerald-400">
                              원어민 자연스러운 표현
                            </span>
                            <button
                              onClick={() => handlePlayTts(m.naturalPhrase, idx)}
                              disabled={playingIndex === idx}
                              className="text-xs text-emerald-300 hover:text-emerald-100 flex items-center gap-1 cursor-pointer"
                              title="발음 듣기"
                            >
                              <Volume2
                                size={14}
                                className={playingIndex === idx ? "animate-pulse text-amber-300" : ""}
                              />
                              <span>{playingIndex === idx ? "재생 중" : "발음"}</span>
                            </button>
                          </div>
                          <p className="text-emerald-200 font-semibold text-xs md:text-sm leading-relaxed">
                            "{m.naturalPhrase}"
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Reason & Tips (Korean 1-2 sentences) */}
                    <div className="mt-3 pt-2.5 border-t border-slate-800/60 text-xs text-slate-300 leading-relaxed">
                      <span className="font-bold text-amber-400 mr-1.5">[교정 이유]:</span>
                      {m.reason}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Key Expressions (외울 표현 5개 - B-4 requirement 2, 3) */}
        {review?.keyExpressions && review.keyExpressions.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <Sparkles size={16} className="text-amber-400" />
              오늘 꼭 외울 필수 표현 5선
            </h3>
            <div className="grid grid-cols-1 gap-2.5">
              {review.keyExpressions.map((k: any, i: number) => (
                <div
                  key={i}
                  className="bg-[#1C2433] border border-slate-800 rounded-xl p-3 flex flex-col md:flex-row md:items-center justify-between gap-2"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-amber-300 text-sm">{k.expression}</span>
                      <span className="text-xs text-slate-400">({k.situation})</span>
                    </div>
                    <p className="text-xs text-slate-300 italic">"{k.exampleSentence}"</p>
                  </div>
                  <button
                    onClick={() => handlePlayTts(k.exampleSentence, 100 + i)}
                    disabled={playingIndex === 100 + i}
                    className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 self-end md:self-auto cursor-pointer"
                    title="예문 발음 듣기"
                  >
                    <Volume2
                      size={16}
                      className={playingIndex === 100 + i ? "animate-pulse text-amber-300" : ""}
                    />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* After the call: what happened automatically and what comes next */}
        <div className="p-4 rounded-2xl bg-emerald-950/30 border border-emerald-500/30 space-y-2">
          <div className="text-sm font-bold text-emerald-300 flex items-center gap-1.5">
            <CheckCircle size={16} />
            <span>통화 후 할 일</span>
          </div>
          {review?.mistakesSaved === false ? (
            <p className="text-xs text-amber-300 leading-relaxed">
              실수를 앱 복습 목록에 저장하지 못했어요. 아래 "Keep에 붙여넣기용 복사"로 따로 남겨 두세요.
            </p>
          ) : (
            <p className="text-xs text-slate-200 leading-relaxed">
              {visibleMistakes.length > 0
                ? `오늘 실수 ${visibleMistakes.length}개는 앱 복습 목록에 자동으로 저장됐어요. 따로 옮겨 적지 않아도 돼요.`
                : "오늘은 저장할 실수가 없어요."}
            </p>
          )}
          <ul className="text-xs text-slate-300 leading-relaxed list-disc pl-4 space-y-0.5">
            <li>내일 아침 강의에서 오늘 실수를 다시 들어요.</li>
            <li>내일 홈의 "퀴즈 풀기"로 맞게 말할 수 있는지 확인해요. 맞히면 그 실수는 졸업이에요.</li>
          </ul>
        </div>

        {/* Google Keep backup copy (B-4 requirement 4, optional) */}
        <details className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800">
          <summary className="text-xs font-semibold text-slate-300 cursor-pointer flex items-center gap-1.5">
            <BookmarkCheck size={14} className="text-emerald-400" />
            <span>Google Keep에도 남기고 싶다면 (선택)</span>
          </summary>
          <div className="mt-3 space-y-2">
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Google 개인 계정은 앱이 Keep에 직접 쓸 수 없어서, 복사해서 붙여 넣는 방법만 있어요.
            </p>
            <button
              onClick={handleCopyKeep}
              className="px-3 py-1.5 text-xs font-bold bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg flex items-center gap-1.5 transition cursor-pointer active:scale-95"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              <span>{copied ? "복사 완료!" : "Keep에 붙여넣기용 복사"}</span>
            </button>
            <pre className="text-xs font-mono text-slate-300 bg-black/50 p-3 rounded-xl overflow-x-auto whitespace-pre-wrap max-h-32 border border-slate-800/80">
              {getKeepCopyText()}
            </pre>
          </div>
        </details>

        {/* Expandable: Full Verbatim STT Transcript viewer (기록용 받아쓰기 전문 확인) */}
        {sttFinal?.transcript && (
          <div className="border border-slate-800/80 rounded-2xl overflow-hidden bg-slate-900/40">
            <button
              onClick={() => setShowFullTranscript(!showFullTranscript)}
              className="w-full p-3.5 flex items-center justify-between text-xs text-slate-400 hover:text-slate-200 transition cursor-pointer font-medium"
            >
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-emerald-400" />
                <span>
                  기록용 전사(sttFinal) 전문 확인 ({sttFinal.sourceStt === "sttFinal" ? "VERBATIM 전사본" : "sttPartial 합본"})
                </span>
              </div>
              {showFullTranscript ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {showFullTranscript && (
              <div className="p-4 border-t border-slate-800 bg-black/60 text-xs font-mono text-slate-300 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                {sttFinal.transcript}
              </div>
            )}
          </div>
        )}

        {/* Bottom Actions */}
        <div className="flex items-center justify-between gap-3 pt-2">
          {onOpenPodcast ? (
            <button
              onClick={() => {
                onClose();
                onOpenPodcast();
              }}
              className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm font-semibold text-amber-300 flex items-center gap-1.5 transition cursor-pointer"
            >
              <span>🎧 아침 복습 오디오 듣기</span>
            </button>
          ) : (
            <div />
          )}

          <button
            onClick={onClose}
            className="px-6 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm flex items-center gap-1.5 transition cursor-pointer shadow-lg shadow-amber-500/20 active:scale-95"
          >
            <span>확인 완료</span>
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
};
