import React, { useEffect, useRef, useState } from "react";
import { GoalData, MistakeData, getDueMistakes } from "../../services/firebase/db";
import { ArrowLeft, Mic, MicOff, PhoneCall, CheckCircle2, Loader2 } from "lucide-react";

interface PreCallScreenProps {
  userId: string;
  goal: GoalData;
  lessonIndex: number;
  onStart: () => void;
  onBack: () => void;
}

type MicState = "idle" | "checking" | "ok" | "fail";

/**
 * 통화 전 준비 화면: 오늘 과 · 오늘 써 볼 표현(복습 대상 실수의 자연스러운 표현) · 마이크 점검.
 * 마이크 점검을 통과해야 [전화 걸기]가 켜진다.
 */
export const PreCallScreen: React.FC<PreCallScreenProps> = ({ userId, goal, lessonIndex, onStart, onBack }) => {
  const lesson = goal.lessons.find((l) => l.index === lessonIndex);
  const [expressions, setExpressions] = useState<MistakeData[] | null>(null);
  const [mic, setMic] = useState<MicState>("idle");
  const [micMsg, setMicMsg] = useState<string>("");
  const [level, setLevel] = useState<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    getDueMistakes(userId)
      .then((d) => setExpressions(d.slice(0, 3)))
      .catch(() => setExpressions([]));
    return () => stopMic();
  }, [userId]);

  const stopMic = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
  };

  const checkMic = async () => {
    stopMic();
    setMic("checking");
    setMicMsg("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(), { name: "NotSupported" });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new Ctx();
      ctxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
        setLevel(Math.min(1, peak / 64));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
      setMic("ok");
    } catch (err: any) {
      setMic("fail");
      setMicMsg(
        err?.name === "NotAllowedError" || err?.name === "SecurityError"
          ? "마이크 권한이 꺼져 있어요. 주소창의 마이크 권한을 허용해 주세요."
          : "마이크를 찾지 못했어요. 이어폰·브라우저 권한을 확인해 주세요."
      );
    }
  };

  const start = () => {
    stopMic();
    onStart();
  };

  return (
    <div className="min-h-screen bg-[#0F141C] text-slate-100 flex flex-col">
      <header className="p-4 border-b border-slate-800 flex items-center gap-3">
        <button onClick={() => { stopMic(); onBack(); }} className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 cursor-pointer" title="홈으로">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-bold">통화 준비</span>
      </header>

      <main className="flex-1 max-w-md w-full mx-auto p-5 space-y-4">
        <section className="rounded-2xl bg-[#161D2A] border border-slate-800 p-5">
          <p className="text-[11px] text-amber-400 font-bold mb-1">오늘 할 과 · {goal.title}</p>
          <h2 className="text-xl font-extrabold text-white">
            {lessonIndex}과. {lesson?.title || ""}
          </h2>
        </section>

        <section className="rounded-2xl bg-[#161D2A] border border-slate-800 p-5">
          <p className="text-xs font-bold text-slate-200 mb-2">오늘 통화에서 써 볼 표현</p>
          {expressions === null ? (
            <Loader2 className="w-4 h-4 animate-spin text-slate-500" />
          ) : expressions.length === 0 ? (
            <p className="text-xs text-slate-400">복습할 표현이 아직 없어요. 오늘 과 주제로 편하게 말해 보세요.</p>
          ) : (
            <ul className="space-y-2">
              {expressions.map((m) => (
                <li key={m.id || m.naturalPhrase} className="text-xs">
                  <span className="text-emerald-300 font-semibold">"{m.naturalPhrase}"</span>
                  {m.meaningKo && <span className="text-slate-400"> — {m.meaningKo}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl bg-[#161D2A] border border-slate-800 p-5 space-y-3">
          <p className="text-xs font-bold text-slate-200">마이크 점검</p>
          {mic === "ok" ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-emerald-300">
                <CheckCircle2 className="w-4 h-4" /> 마이크가 연결됐어요. 말해 보면 막대가 움직여요.
              </div>
              <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                <div className="h-full bg-emerald-400 transition-all" style={{ width: `${Math.round(level * 100)}%` }} />
              </div>
            </div>
          ) : mic === "fail" ? (
            <div className="flex items-start gap-2 text-xs text-rose-300">
              <MicOff className="w-4 h-4 shrink-0 mt-0.5" /> {micMsg}
            </div>
          ) : (
            <p className="text-xs text-slate-400">전화를 걸기 전에 마이크가 잘 들리는지 확인해요.</p>
          )}
          {mic !== "ok" && (
            <button
              onClick={checkMic}
              disabled={mic === "checking"}
              className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
            >
              {mic === "checking" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}
              {mic === "fail" ? "다시 점검" : "마이크 점검하기"}
            </button>
          )}
        </section>
      </main>

      <footer className="p-5 border-t border-slate-800">
        <div className="max-w-md mx-auto">
          <button
            onClick={start}
            disabled={mic !== "ok"}
            className="w-full py-4 rounded-2xl bg-gradient-to-r from-amber-500 to-amber-400 disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed text-slate-950 font-black text-sm flex items-center justify-center gap-2 cursor-pointer"
          >
            <PhoneCall className="w-5 h-5" />
            {mic === "ok" ? "전화 걸기" : "마이크 점검 후 전화를 걸 수 있어요"}
          </button>
        </div>
      </footer>
    </div>
  );
};
