import React, { useState } from "react";
import { ALLOWED_USER_EMAIL, signInWithGoogle, UnauthorizedUserError } from "../../services/firebase/auth";
import { ShieldCheck, LogIn, AlertCircle } from "lucide-react";

interface LoginScreenProps {
  onLoginSuccess?: () => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLoginSuccess }) => {
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleLogin = async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      await signInWithGoogle();
      if (onLoginSuccess) onLoginSuccess();
    } catch (err: unknown) {
      if (err instanceof UnauthorizedUserError) {
        setErrorMessage(err.message);
      } else if (err instanceof Error) {
        setErrorMessage(
          err.message.includes("popup-closed-by-user")
            ? "로그인 팝업이 닫혔습니다. 다시 시도해 주세요."
            : `로그인 중 오류가 발생했습니다: ${err.message}`
        );
      } else {
        setErrorMessage("알 수 없는 로그인 오류가 발생했습니다.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0F141C] text-slate-100 flex flex-col justify-center items-center px-4">
      <div className="w-full max-w-md bg-[#161D2A] border border-slate-800 rounded-2xl p-8 shadow-2xl relative overflow-hidden">
        {/* Glow accent */}
        <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-32 h-32 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="text-center mb-8 relative z-10">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-amber-500/15 border border-amber-500/30 text-amber-400 mb-4 shadow-inner">
            <span className="text-2xl font-black tracking-tighter">1C</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white mb-2">
            One Call English
          </h1>
          <p className="text-sm text-slate-400">
            찬식님 1인 전용 AI 1:1 전화영어 & 실시간 복기 시스템
          </p>
        </div>

        {errorMessage && (
          <div className="mb-6 p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-3">
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
            <div className="leading-relaxed whitespace-pre-wrap">{errorMessage}</div>
          </div>
        )}

        <div className="space-y-4 mb-8">
          <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800/80 text-xs text-slate-300 flex items-center gap-3">
            <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
            <div>
              <p className="font-medium text-slate-200">단일 계정 접근 제어</p>
              <p className="text-slate-400 font-mono text-[11px] mt-0.5">
                허용 계정: {ALLOWED_USER_EMAIL}
              </p>
            </div>
          </div>
        </div>

        <button
          onClick={handleLogin}
          disabled={loading}
          className="w-full py-3.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-semibold text-sm transition-all shadow-lg shadow-amber-500/20 flex items-center justify-center gap-2 cursor-pointer"
        >
          {loading ? (
            <div className="w-5 h-5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
          ) : (
            <>
              <LogIn className="w-4 h-4" />
              <span>Google 계정으로 로그인</span>
            </>
          )}
        </button>

        <p className="text-center text-[11px] text-slate-500 mt-6">
          지정된 허용 계정 외 다른 계정으로 로그인 시 자동으로 세션이 거부됩니다.
        </p>
      </div>
    </div>
  );
};
