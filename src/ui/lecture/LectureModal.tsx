import React, { useEffect, useRef, useState } from "react";
import { User } from "firebase/auth";
import { X, Play, Pause, RotateCcw, CheckCircle2, ListOrdered, GraduationCap, Loader2 } from "lucide-react";
import {
  LectureDoc,
  resolveLectureAudio,
  cacheLectureAudio,
  completeLecture,
} from "../../services/lecture/lectureService";

interface LectureModalProps {
  user: User;
  lecture: LectureDoc;
  onClose: () => void;
  onOpenQuiz: () => void;
  onCompleted?: () => void;
}

const RATES = [1.0, 1.25, 1.5];

export const LectureModal: React.FC<LectureModalProps> = ({ user, lecture, onClose, onOpenQuiz, onCompleted }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [offline, setOffline] = useState<"cached" | "stream" | "loading">("loading");
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1.0);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(lecture.durationSec || 0);
  const [ended, setEnded] = useState(false);
  const [done, setDone] = useState(Boolean(lecture.listenedAt));
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let revoked: string | null = null;
    (async () => {
      try {
        const url = await resolveLectureAudio(lecture);
        const cached = await cacheLectureAudio(url);
        if (cached) {
          revoked = cached;
          setSrc(cached);
          setOffline("cached");
        } else {
          if (url.startsWith("blob:")) revoked = url;
          setSrc(url);
          setOffline("stream");
        }
      } catch (err: any) {
        setError(err?.message || "오디오를 불러오지 못했어요.");
      }
    })();
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [lecture.date, lecture.audioUrl]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate, src]);

  const markComplete = async () => {
    if (done) return;
    try {
      const n = await completeLecture(user.uid, lecture);
      setDone(true);
      setToast(`강의 완료! 복습 실수 ${n}개 단계가 올라갔어요.`);
      onCompleted?.();
    } catch (err: any) {
      setToast(`완료 처리 오류: ${err?.message || err}`);
    }
  };

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch((e) => setError(String(e)));
    else a.pause();
  };

  const seek = (sec: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, sec);
    if (a.paused) a.play().catch(() => {});
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const items = lecture.script || [];
  const currentIdx = items.reduce((acc, it, i) => ((it.startSec ?? Infinity) <= time ? i : acc), -1);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3">
      <div className="w-full max-w-2xl max-h-[92vh] overflow-y-auto bg-[#161D2A] border border-slate-800 rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div>
            <div className="text-xs font-bold text-sky-400">오늘 아침 강의 (B-7) · {lecture.date}</div>
            <div className="text-lg font-black text-white">{lecture.title || "아침 강의"}</div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {error && <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">{error}</div>}
          {!src && !error && (
            <div className="flex items-center gap-2 text-slate-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> 오디오 미리 받는 중…
            </div>
          )}
          {src && (
            <audio
              ref={audioRef}
              src={src}
              preload="auto"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || duration)}
              onEnded={() => {
                setEnded(true);
                markComplete();
              }}
            />
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={toggle}
              disabled={!src}
              className="w-12 h-12 rounded-full bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 flex items-center justify-center cursor-pointer"
            >
              {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 fill-current" />}
            </button>
            <button
              onClick={() => seek(time - 10)}
              disabled={!src}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold flex items-center gap-1 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" /> 10초
            </button>
            <div className="flex gap-1">
              {RATES.map((r) => (
                <button
                  key={r}
                  onClick={() => setRate(r)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${rate === r ? "bg-sky-500 text-slate-950" : "bg-slate-800 text-slate-300"}`}
                >
                  {r}x
                </button>
              ))}
            </div>
            <div className="ml-auto text-xs font-mono text-slate-400">
              {fmt(time)} / {fmt(duration)}
            </div>
          </div>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.5}
            value={time}
            onChange={(e) => seek(Number(e.target.value))}
            className="w-full accent-sky-500"
          />
          <div className="text-[11px] text-slate-500">
            {offline === "cached" ? "기기에 저장됨 · 오프라인 재생 가능" : offline === "stream" ? "스트리밍 재생(오프라인 저장 실패)" : ""}
          </div>

          <div className="space-y-1.5">
            <div className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
              <ListOrdered className="w-3.5 h-3.5" /> 목차
            </div>
            {items.map((it, i) => (
              <button
                key={it.mistakeId + i}
                onClick={() => it.startSec !== undefined && seek(it.startSec)}
                className={`w-full text-left p-2.5 rounded-xl border text-xs cursor-pointer ${i === currentIdx ? "border-sky-500/60 bg-sky-500/10" : "border-slate-800 bg-slate-900/40 hover:bg-slate-800/60"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-slate-500">{it.startSec !== undefined ? fmt(it.startSec) : "--:--"}</span>
                  <span className={`px-1.5 rounded text-[10px] font-bold ${it.kind === "review" ? "bg-amber-500/20 text-amber-300" : "bg-emerald-500/20 text-emerald-300"}`}>
                    {it.kind === "review" ? "복습" : "새 표현"}
                  </span>
                  <span className="text-rose-300 line-through decoration-rose-400/50">{it.myPhrase}</span>
                  <span className="text-slate-500">→</span>
                  <span className="text-emerald-300 font-semibold">{it.naturalPhrase}</span>
                </div>
              </button>
            ))}
          </div>

          {lecture.coachNote && (
            <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 text-sm text-slate-200">
              <span className="font-bold text-sky-300">코치 한마디 · </span>
              {lecture.coachNote}
            </div>
          )}

          {toast && (
            <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> {toast}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              onClick={onOpenQuiz}
              className={`px-4 py-2 rounded-xl text-xs font-black flex items-center gap-1.5 cursor-pointer ${ended || done ? "bg-amber-400 text-slate-950" : "bg-slate-800 text-slate-200"}`}
            >
              <GraduationCap className="w-4 h-4" /> 퀴즈 풀기
            </button>
            <button
              onClick={markComplete}
              disabled={done}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs font-bold cursor-pointer"
            >
              {done ? "강의 완료됨" : "강의 완료 (강의 들었음)"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
