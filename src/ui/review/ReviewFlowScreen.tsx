import React from "react";
import { Loader2, Sparkles, AlertTriangle, RotateCcw, Home } from "lucide-react";

interface ReviewFlowScreenProps {
  loading: boolean;
  progressStep?: string;
  errorMessage: string | null;
  onRetry: () => void;
  onLater: () => void;
}

/** Turns raw server/network errors into a short Korean reason. */
export function friendlyReviewError(raw: string): string {
  const m = raw || "";
  if (/Gemini 키가 없어요|GEMINI_API_KEY|연동이 준비되지/.test(m))
    return "서버에 Gemini 키가 없어 복기를 만들 수 없어요. AI Studio Secrets에 GEMINI_API_KEY를 넣어 주세요.";
  if (/로그인|인증|401/.test(m)) return "로그인이 만료됐어요. 다시 로그인한 뒤 다시 만들어 주세요.";
  if (/Failed to fetch|NetworkError|network/i.test(m)) return "인터넷 연결이 불안정해요. 연결을 확인하고 다시 만들어 주세요.";
  return m.length > 80 ? "복기를 만드는 중 문제가 생겼어요." : m;
}

/**
 * Full-screen post-call review flow.
 * - loading: progress
 * - error: in-app card with [다시 만들기] / [나중에]
 * Success is handled by the existing ReviewModal.
 */
export const ReviewFlowScreen: React.FC<ReviewFlowScreenProps> = ({
  loading,
  progressStep,
  errorMessage,
  onRetry,
  onLater,
}) => {
  return (
    <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center text-slate-100">
      {loading ? (
        <>
          <div className="relative mb-5">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center animate-pulse">
              <Sparkles className="w-8 h-8 text-amber-400" />
            </div>
            <Loader2 className="w-6 h-6 text-amber-400 animate-spin absolute -bottom-2 -right-2 bg-slate-900 rounded-full p-1" />
          </div>
          <h3 className="text-base font-bold text-white mb-1.5">통화 복기를 만들고 있어요</h3>
          <p className="text-xs text-amber-300 font-medium max-w-sm">
            {progressStep || "받아쓰기와 실수 분석을 하고 있어요."}
          </p>
          <p className="text-[11px] text-slate-500 mt-3">1분 정도 걸릴 수 있어요. 화면을 닫지 마세요.</p>
        </>
      ) : errorMessage ? (
        <div className="w-full max-w-sm rounded-2xl bg-[#161D2A] border border-rose-500/30 p-5 shadow-2xl text-left">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <h3 className="text-sm font-bold text-white">복기를 만들지 못했어요</h3>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed mb-1">{friendlyReviewError(errorMessage)}</p>
          <p className="text-[11px] text-slate-500 mb-4">통화 녹음은 저장돼 있어요. 나중에 홈의 '끝나지 않은 통화'에서 다시 만들 수 있어요.</p>
          <div className="flex gap-2">
            <button
              onClick={onRetry}
              className="flex-1 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" /> 다시 만들기
            </button>
            <button
              onClick={onLater}
              className="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Home className="w-4 h-4" /> 나중에
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};
