import React, { useEffect, useRef, useState } from "react";
import { friendlyError } from "../common/friendlyError";
import { User } from "firebase/auth";
import { Headphones, Loader2, Play, RefreshCw, AlertTriangle } from "lucide-react";
import { getKSTToday } from "../../services/firebase/db";
import { LectureDoc, getLecture, startLecture, syncLectureStatus, copyLectureAudio } from "../../services/lecture/lectureService";
import { rebuildTodayLecture } from "../../services/lecture/rebuildTodayLecture";
import { formatLectureDuration } from "../../services/lecture/lecturePick";
import {
  shouldCopyLectureAudio,
  shouldPollLecture,
  readUploadFailAt,
  isLectureAudioRestoring,
  shouldStartPollRefresh,
  isLatestRequest,
  shouldShowLectureChecking,
  shouldShowLectureSlow,
  shouldForceStartLecture,
  resolveLectureAutoOpen,
} from "../../services/lecture/lectureSyncPolicy";
import {
  loadLectureForCard,
  type LectureCardServerStatus,
} from "../../services/lecture/lectureCardLoad";
import { markBoot } from "../../services/perf/bootTiming";
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
  const [serverChecking, setServerChecking] = useState(false);
  const [serverSlow, setServerSlow] = useState(false);
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
  const reqRef = useRef(0);
  const inFlightReqIdRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const today = getKSTToday();

  const canApply = (reqId: number) =>
    mountedRef.current && isLatestRequest(reqId, reqRef.current);

  const applyAutoOpen = (
    serverStatus: LectureCardServerStatus,
    lectureStatus?: string
  ) => {
    const decision = resolveLectureAutoOpen({
      autoOpen: autoOpenRef.current,
      alreadyHandled: autoOpenHandledRef.current,
      serverStatus,
      lectureStatus,
    });
    if (decision.markFirstRefreshDone) {
      firstRefreshDoneRef.current = true;
    }
    if (decision.markHandled) {
      autoOpenHandledRef.current = true;
    }
    if (decision.openModal) {
      setOpen(true);
    }
    if (decision.markHandled) {
      onAutoOpenHandledRef.current?.();
    }
  };

  const maybeCopyAudio = (l: LectureDoc | null, reqId: number) => {
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
        if (updated && canApply(reqId)) setLecture(updated);
      })
      .catch(() => { /* stream from the server instead */ });
  };

  const refresh = async (): Promise<{
    lecture: LectureDoc | null;
    server: LectureCardServerStatus;
  } | null> => {
    const reqId = ++reqRef.current;
    inFlightReqIdRef.current = reqId;
    try {
      const result = await loadLectureForCard({
        readLocal: () => getLecture(user.uid, today),
        syncServer: (cur) => syncLectureStatus(user.uid, today, cur),
        onLocal: (l, needsServer) => {
          if (!canApply(reqId)) return;
          setLecture(l);
          setLoading(false);
          setServerChecking(needsServer);
          setServerSlow(false);
          markBoot("lectureLocal");
          if (!needsServer) {
            maybeCopyAudio(l, reqId);
          }
        },
        onServerSettled: (l, settledStatus) => {
          if (!canApply(reqId)) return;
          if (settledStatus === "ok") {
            setServerSlow(false);
            setLecture(l);
            maybeCopyAudio(l, reqId);
          }
          if (!firstRefreshDoneRef.current) {
            applyAutoOpen(settledStatus, settledStatus === "ok" ? l?.status : undefined);
          }
        },
      });
      if (!canApply(reqId)) return null;
      markBoot("lectureServer");
      if (result.server !== "skipped") {
        setLecture(result.lecture);
        maybeCopyAudio(result.lecture, reqId);
      }
      setServerSlow(result.server === "timeout");
      if (!firstRefreshDoneRef.current) {
        applyAutoOpen(result.server, result.lecture?.status);
      }
      return result;
    } finally {
      if (inFlightReqIdRef.current === reqId) {
        inFlightReqIdRef.current = null;
      }
      if (canApply(reqId)) {
        setServerChecking(false);
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    refresh().catch(() => {
      if (cancelled || !mountedRef.current || firstRefreshDoneRef.current) return;
      applyAutoOpen("failed", undefined);
    });

    return () => {
      cancelled = true;
      mountedRef.current = false;
      reqRef.current += 1;
      inFlightReqIdRef.current = null;
      busyRef.current = false;
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [user.uid]);

  useEffect(() => {
    if (!autoOpen || !firstRefreshDoneRef.current || autoOpenHandledRef.current) return;
    applyAutoOpen("ok", lecture?.status);
  }, [autoOpen, lecture]);

  const pollingNeeded = shouldPollLecture(lecture);
  useEffect(() => {
    if (pollingNeeded && !pollRef.current) {
      pollRef.current = window.setInterval(async () => {
        if (!shouldStartPollRefresh(inFlightReqIdRef.current !== null, busyRef.current)) return;
        const res = await refresh().catch(() => null);
        const l = res?.lecture ?? null;
        if (l && !shouldPollLecture(l) && pollRef.current) {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, 5000);
    } else if (!pollingNeeded && pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [pollingNeeded, user.uid]);

  const runLectureAction = async (action: () => Promise<LectureDoc>) => {
    // Bump reqRef at action start so any in-flight poll or late response cannot overwrite this action.
    reqRef.current += 1;
    inFlightReqIdRef.current = null;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setServerChecking(false);
    setServerSlow(false);
    try {
      const next = await action();
      if (!mountedRef.current) return;
      setLecture(next);
      setLoading(false);
    } catch (err: any) {
      if (mountedRef.current) {
        setError(friendlyError(err));
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  };

  const create = (force = false) => runLectureAction(() => startLecture(user.uid, today, force));

  const rebuild = () => {
    if (!confirm("오늘 통화까지 넣어 강의를 다시 만들까요?")) return;
    return runLectureAction(() => rebuildTodayLecture(user.uid, today));
  };

  const status = lecture?.status;
  const restoring = isLectureAudioRestoring(lecture);
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
            {shouldShowLectureChecking({ loading, status, serverChecking }) && (
              <div className="text-[11px] text-slate-400 flex items-center gap-1 mt-0.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>오늘 강의가 있는지 확인 중…</span>
              </div>
            )}
            {shouldShowLectureSlow({ loading, status, serverChecking, serverSlow }) && (
              <div className="text-[11px] text-slate-400 mt-0.5">
                확인이 늦어지고 있어요. 잠시 후 다시 열어 주세요
              </div>
            )}
            {status === "ready" && (
              <div className="text-[11px] text-slate-400">
                {lecture?.itemCount}개 표현 · {formatLectureDuration(lecture?.durationSec || 0)}{lecture?.listenedAt ? " · 들음" : ""}{restoring ? " · 오디오 복원 중" : ""}
              </div>
            )}
            {status === "ready" && lecture?.audioStatus === "missing" && lecture?.error === "AUDIO_REBUILD_TIMED_OUT" && (
              <div className="text-[11px] text-amber-300">
                오디오를 만들지 못했어요. 재생을 누르면 다시 만들어요.
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
            <>
              <button
                onClick={() => setOpen(true)}
                className="px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-black flex items-center gap-1.5 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 fill-current" /> 재생
              </button>
              <button
                type="button"
                data-testid="rebuild-today-lecture"
                onClick={rebuild}
                disabled={busy || loading}
                className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 border border-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                다시 만들기
              </button>
            </>
          ) : status === "generating" ? (
            <>
              <div className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> 생성 중 (1~3분)
              </div>
              <button
                type="button"
                data-testid="rebuild-today-lecture"
                onClick={rebuild}
                disabled={busy || loading}
                className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 border border-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                다시 만들기
              </button>
            </>
          ) : (
            <button
              onClick={() => create(shouldForceStartLecture(status, serverSlow))}
              disabled={busy || loading || serverChecking}
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
