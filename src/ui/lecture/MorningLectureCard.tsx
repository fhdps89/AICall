import React, { useEffect, useRef, useState } from "react";
import { friendlyError } from "../common/friendlyError";
import { User } from "firebase/auth";
import { Headphones, Loader2, Play, RefreshCw, AlertTriangle } from "lucide-react";
import { getKSTToday } from "../../services/firebase/db";
import { LectureDoc, getLecture, startLecture, syncLectureStatus, copyLectureAudio } from "../../services/lecture/lectureService";
import { formatLectureDuration } from "../../services/lecture/lecturePick";
import { shouldCopyLectureAudio, shouldShowLectureImmediately, readUploadFailAt } from "../../services/lecture/lectureSyncPolicy";
import { LectureModal } from "./LectureModal";

interface MorningLectureCardProps {
  user: User;
  autoOpen?: boolean;          // if first refresh is ready, open LectureModal
  onAutoOpenHandled?: () => void;
  onOpenQuiz: () => void;
  onLectureCompleted?: () => void;
}

/** B-7 Home card 「오늘 아침 강의」 */
export const MorningLectureCard: React.FC<MorningLectureCardProps> = ({
  user,
  autoOpen = false,
  onAutoOpenHandled,
  onOpenQuiz,
  onLectureCompleted,
}) => {
  const [lecture, setLecture] = useState<LectureDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const pollRef = useRef<number | null>(null);
  const autoOpenHandledRef = useRef(false);
  const autoOpenRef = useRef(Boolean(autoOpen));
  autoOpenRef.current = Boolean(autoOpen);
  const onAutoOpenHandledRef = useRef(onAutoOpenHandled);
  onAutoOpenHandledRef.current = onAutoOpenHandled;
  const firstRefreshDoneRef = useRef(false);
  const today = getKSTToday();

  const maybeCopyAudio = (l: LectureDoc | null) => {
    if (!l) return;
    let store: Storage | undefined;
    try {
      store = typeof localStorage === "undefined" ? undefined : localStorage;
    } catch {
      store = undefined;
    }
    if (!shouldCopyLectureAudio(l, Date.now(), readUploadFailAt(store, user.uid, today))) return;
    void copyLectureAudio(user.uid, today, l)
      .then((updated) => {
        if (updated) setLecture(updated);
      })
      .catch(() => { /* stream from the server instead */ });
  };

  const refresh = async () => {
    try {
      let l = await getLecture(user.uid, today);
      if (shouldShowLectureImmediately(l)) {
        setLecture(l);
        setLoading(false);
        maybeCopyAudio(l);
        return l;
      }
      // Server may have generated it (e.g. via the Grok Bot feed) → metadata only
      l = (await syncLectureStatus(user.uid, today).catch(() => l)) || l;
      setLecture(l);
      maybeCopyAudio(l);
      return l;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const finalizeAutoOpen = (l: LectureDoc | null) => {
      if (cancelled) return;
      firstRefreshDoneRef.current = true;
      if (autoOpenRef.current && !autoOpenHandledRef.current) {
        autoOpenHandledRef.current = true;
        if (l?.status === "ready") {
          setOpen(true);
        }
        onAutoOpenHandledRef.current?.();
      }
    };

    refresh()
      .then((l) => finalizeAutoOpen(l))
      .catch(() => finalizeAutoOpen(null));

    return () => {
      cancelled = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [user.uid]);

  useEffect(() => {
    if (!autoOpen || !firstRefreshDoneRef.current || autoOpenHandledRef.current) return;
    autoOpenHandledRef.current = true;
    if (lecture?.status === "ready") {
      setOpen(true);
    }
    onAutoOpenHandledRef.current?.();
  }, [autoOpen, lecture]);

  useEffect(() => {
    if (lecture?.status === "generating" && !pollRef.current) {
      pollRef.current = window.setInterval(async () => {
        const l = await refresh().catch(() => null);
        if (l && l.status !== "generating" && pollRef.current) {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, 5000);
    }
  }, [lecture?.status]);

  const create = async (force = false) => {
    setBusy(true);
    setError(null);
    try {
      setLecture(await startLecture(user.uid, today, force));
    } catch (err: any) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const status = lecture?.status;
  return (
    <section className="bg-[#161D2A] border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-lg">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-400 flex items-center justify-center shrink-0">
            <Headphones className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs font-bold text-sky-400">오늘 아침 강의</div>
            <div className="text-lg font-black text-white">
              {loading
                ? "불러오는 중…"
                : status === "ready"
                ? lecture?.title || "오늘 강의 준비 완료"
                : status === "generating"
                ? "강의 만드는 중…"
                : status === "failed"
                ? "강의 만들기 실패"
                : "아직 오늘 강의가 없어요"}
            </div>
            {status === "ready" && (
              <div className="text-[11px] text-slate-400">
                {lecture?.itemCount}개 표현 · {formatLectureDuration(lecture?.durationSec || 0)}{lecture?.listenedAt ? " · 들음" : ""}
              </div>
            )}
            {status === "failed" && lecture?.error && (
              <div className="text-[11px] text-rose-300 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                {lecture.error === "NOTHING_TO_TEACH"
                  ? "새 실수·복습 대상이 없어요"
                  : lecture.error === "INTERRUPTED"
                  ? "서버가 다시 시작되어 만들던 강의가 멈췄어요. 다시 만들어 주세요."
                  : lecture.error === "TIMED_OUT"
                  ? "시간이 초과되어 강의 만들기가 멈췄어요. 다시 만들어 주세요."
                  : "강의를 만들지 못했어요. 잠시 후 다시 만들어 주세요."}
              </div>
            )}
            {error && <div className="text-[11px] text-rose-300">{error}</div>}
          </div>
        </div>
        <div className="flex gap-2">
          {status === "ready" ? (
            <button
              onClick={() => setOpen(true)}
              className="px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-black flex items-center gap-1.5 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5 fill-current" /> 재생
            </button>
          ) : status === "generating" ? (
            <div className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> 생성 중 (1~3분)
            </div>
          ) : (
            <button
              onClick={() => create(status === "failed")}
              disabled={busy || loading}
              className="px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 text-xs font-black flex items-center gap-1.5 cursor-pointer"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              오늘 강의 만들기
            </button>
          )}
        </div>
      </div>
      {open && lecture && (
        <LectureModal
          user={user}
          lecture={lecture}
          onClose={() => setOpen(false)}
          onOpenQuiz={() => {
            setOpen(false);
            onOpenQuiz();
          }}
          onCompleted={() => {
            refresh();
            onLectureCompleted?.();
          }}
        />
      )}
    </section>
  );
};
