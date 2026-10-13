import React, { useState } from "react";
import { SessionData, finalizeCallSession } from "../../services/firebase/db";
import {
  AlertCircle,
  Clock,
  FileAudio,
  CheckCircle2,
  X,
  Sparkles,
  ArrowRight,
  Database,
} from "lucide-react";

interface UnfinishedSessionModalProps {
  userId: string;
  unfinishedSessions: SessionData[];
  onClose: () => void;
  onResolved: () => void;
}

export const UnfinishedSessionModal: React.FC<UnfinishedSessionModalProps> = ({
  userId,
  unfinishedSessions,
  onClose,
  onResolved,
}) => {
  const [selectedSession, setSelectedSession] = useState<SessionData | null>(
    unfinishedSessions[0] || null
  );
  const [showReviewDetail, setShowReviewDetail] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  if (!selectedSession) return null;

  const chunkCount = selectedSession.recordingChunks?.length || 0;
  const transcriptCount = selectedSession.liveTranscript?.length || 0;
  const partialSttCount = selectedSession.sttPartial?.length || 0;

  const handleMarkResolved = async () => {
    setIsProcessing(true);
    try {
      await finalizeCallSession(userId, selectedSession.id, {
        liveTranscript: selectedSession.liveTranscript || [],
        connectionPath: selectedSession.connectionPath || "direct",
        directFailCount: selectedSession.directFailCount || 0,
      });
      onResolved();
    } catch (err) {
      console.error("Failed to mark session as done:", err);
    } finally {
      setIsProcessing(false);
    }
  };

  const formatDateTime = (isoString?: string) => {
    if (!isoString) return "최근 통화";
    try {
      const d = new Date(isoString);
      return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    } catch {
      return isoString;
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#161D2A] border border-amber-500/40 rounded-2xl max-w-lg w-full p-5 sm:p-6 shadow-2xl relative text-slate-200 animate-in fade-in zoom-in-95 duration-200">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-200 p-1 cursor-pointer transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header Banner */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 shrink-0">
            <AlertCircle className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <span>끝나지 않은 통화가 있어요. 복기할까요?</span>
            </h3>
            <p className="text-xs text-amber-300/90 mt-0.5">
              이전 통화가 예기치 않게 중단되었거나 아직 복기되지 않았습니다.
            </p>
          </div>
        </div>

        {/* Session Card Info */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-3 mb-5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono text-amber-400 font-bold">
              {selectedSession.goalId?.toUpperCase() || "LESSON"} · {selectedSession.lessonIndex}과
            </span>
            <span className="text-slate-400 flex items-center gap-1 font-mono text-[11px]">
              <Clock className="w-3 h-3 text-slate-500" />
              {formatDateTime(selectedSession.startedAt)}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2 pt-1 border-t border-slate-800 text-center">
            <div className="bg-slate-800/40 p-2 rounded-lg">
              <span className="block text-[10px] text-slate-400">10초 녹음 조각</span>
              <span className="text-xs font-bold text-emerald-400 flex items-center justify-center gap-1 mt-0.5">
                <FileAudio className="w-3 h-3" />
                {chunkCount}개 ({Math.round((chunkCount * 10) / 60)}분)
              </span>
            </div>
            <div className="bg-slate-800/40 p-2 rounded-lg">
              <span className="block text-[10px] text-slate-400">실시간 대화 로그</span>
              <span className="text-xs font-bold text-sky-400 mt-0.5 block font-mono">
                {transcriptCount}턴
              </span>
            </div>
            <div className="bg-slate-800/40 p-2 rounded-lg">
              <span className="block text-[10px] text-slate-400">1분 단위 전사</span>
              <span className="text-xs font-bold text-purple-400 mt-0.5 block font-mono">
                {partialSttCount}구간
              </span>
            </div>
          </div>

          <div className="text-[11px] text-slate-400 flex items-center gap-1.5 pt-1">
            <Database className="w-3.5 h-3.5 text-emerald-400" />
            <span>IndexedDB 및 Cloud Storage에 음성 파일이 안전하게 보관되어 있습니다.</span>
          </div>
        </div>

        {/* Detailed Review Preview or Actions */}
        {showReviewDetail ? (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 space-y-2 mb-5">
            <div className="font-bold flex items-center gap-1.5 text-amber-300">
              <Sparkles className="w-4 h-4 text-amber-400" />
              <span>B-4 복기 튜터 연동 대기 중 (준비 완료)</span>
            </div>
            <p className="text-[11px] text-slate-300 leading-relaxed">
              중단된 통화의 음성 청크 {chunkCount}개와 대화 전사록이 모두 온전히 보존되어 있습니다. 
              차후 B-4(복기 파이프라인)가 연결되면 오답 분석, AL 모범 표현 추출, Keep 동기화가 이 데이터를 바탕으로 자동 실행됩니다.
            </p>
          </div>
        ) : null}

        {/* Modal Buttons */}
        <div className="flex items-center gap-2">
          {!showReviewDetail ? (
            <button
              onClick={() => setShowReviewDetail(true)}
              className="flex-1 py-3 px-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-lg shadow-amber-500/20 active:scale-95"
            >
              <span>복기 시작 (B-4 대기)</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              onClick={handleMarkResolved}
              disabled={isProcessing}
              className="flex-1 py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-lg shadow-emerald-600/20 active:scale-95"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>통화 완료 처리 및 보관</span>
            </button>
          )}

          <button
            onClick={onClose}
            className="py-3 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-xs transition-colors cursor-pointer"
          >
            나중에 하기
          </button>
        </div>
      </div>
    </div>
  );
};
