import React, { useState, useEffect, useRef } from "react";
import { User } from "firebase/auth";
import {
  subscribeToAuth,
  logOut,
  ALLOWED_USER_EMAIL,
} from "./services/firebase/auth";
import {
  validateFirestoreConnection,
} from "./services/firebase/config";
import {
  getUserProfile,
  saveUserProfile,
  getUserGoals,
  batchInitGoals,
  updateGoalProgress,
  getUnfinishedSessions,
  getSessionById,
  markSessionPendingReview,
  markSessionUsageRecorded,
  checkAndMarkInterruptedSessions,
  getKSTToday,
  GoalData,
  UserProfileData,
  SessionData,
  SessionReviewData,
  SttFinalData,
} from "./services/firebase/db";
import { getAllPendingChunks, retryPendingUploads } from "./services/recording/chunkIndexedDb";
import { isPartialTranscribeEnabled } from "./services/recording/partialTranscribeSetting";
import { createRecoveredUsageRecorder } from "./services/session/recoveredUsage";
import { recordUsage } from "./services/usage/usageService";
import { runPostCallReview } from "./services/review/reviewPipeline";
import type { ReviewTiming } from "./services/review/reviewTiming";
import { DEFAULT_GOALS } from "./data/defaultGoals";
import {
  DEFAULT_PROMPT_PLACEHOLDERS,
  PromptPlaceholders,
} from "./data/promptCustomizer";
import { LoginScreen } from "./ui/auth/LoginScreen";
import { HomeScreen } from "./ui/home/HomeScreen";
import { NewCallScreen } from "./ui/call/NewCallScreen";
import { PreCallScreen } from "./ui/call/PreCallScreen";
import { UnfinishedSessionModal } from "./ui/call/UnfinishedSessionModal";
import { InitialProgressModal } from "./ui/onboarding/InitialProgressModal";
import { SettingsModal } from "./ui/settings/SettingsModal";
import { ReviewModal } from "./ui/review/ReviewModal";
import { ReviewFlowScreen } from "./ui/review/ReviewFlowScreen";
import { LiveTranscriptItem } from "./services/providers/types";
import { syncFeedNow } from "./services/feed/feedService";
import { loadProfileAndGoals } from "./services/session/bootLoad";
import {
  clearBootCache,
  commitBootGoals,
  defaultBootStore,
  readBootCache,
} from "./services/session/bootCache";
import {
  canStartCall,
  createGoalsCommitGate,
  GoalsSyncState,
  nextGoalsSyncState,
} from "./services/session/bootGate";
import { markBoot, settleBootPhase } from "./services/perf/bootTiming";
import { HistoryDepthSync } from "./services/navigation/historySync";
import {
  BackTargetState,
  getNavigationDepth,
  pickBackTarget,
} from "./services/navigation/backTarget";
import { friendlyError } from "./ui/common/friendlyError";
import { applyQaModeFromUrl } from "./data/qaMode";

applyQaModeFromUrl();
import { Loader2 } from "lucide-react";

type HomeFocus = "lecture" | null;

interface ActiveReviewState {
  review: SessionReviewData;
  sttFinal?: SttFinalData;
  timing?: ReviewTiming;
  goalId: string;
  lessonIndex: number;
  goalTitle: string;
  lessonTitle: string;
  sessionId: string;
}

// 새로고침으로 끊긴 통화는 통화 종료(handleHangUp)를 거치지 않아 통화 횟수·분이 빠진다.
// 모듈 수준 실행기로 같은 sessionId의 동시 중복 호출을 막고 한 번만 기록한다.
const recordRecoveredUsageOnce = createRecoveredUsageRecorder({
  getSession: getSessionById,
  markRecorded: markSessionUsageRecorded,
  recordUsage,
  todayKst: getKSTToday,
  onError: (err) => console.warn("[App] recovered call usage not recorded:", err),
});

export const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // User Profile & Goals State
  const [userProfile, setUserProfile] = useState<UserProfileData | null>(null);
  const [goals, setGoals] = useState<GoalData[]>([]);
  const [dataLoading, setDataLoading] = useState<boolean>(false);
  const [goalsSync, setGoalsSync] = useState<GoalsSyncState>("syncing");
  // 최신 goals 목록(await 뒤 stale 클로저 대신 사용)
  const goalsRef = useRef<GoalData[]>(goals);
  goalsRef.current = goals;
  // 지금 로그인된 uid. 로그아웃·계정 전환 뒤 늦게 온 응답이 상태·캐시를 덮어쓰지 않게 비교한다.
  const activeUidRef = useRef<string | null>(null);
  // 인증 해제·uid 변경 시 이전 uid 캐시를 지우기 위한 직전 uid
  const prevUidRef = useRef<string | null>(null);
  // 「다시 확인」 버튼이 다시 부를 진도 불러오기 함수
  const loadUserDataRef = useRef<(() => Promise<void>) | null>(null);
  // 더 늦게 시작한 목표 조회·진도 저장만 상태와 캐시에 반영한다.
  const goalsCommitGateRef = useRef(createGoalsCommitGate());
  const goalsGateUidRef = useRef<string | null>(null);
  // 프로필도 더 늦게 시작한 부트 조회만 반영한다.
  const profileAppliedAtRef = useRef(Number.NEGATIVE_INFINITY);

  // Modals
  const [showInitialProgressModal, setShowInitialProgressModal] = useState<boolean>(false);
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);

  // Unfinished session state (B-3 & B-4 requirement 0)
  const [unfinishedSessions, setUnfinishedSessions] = useState<SessionData[]>([]);
  const [showUnfinishedModal, setShowUnfinishedModal] = useState<boolean>(false);

  // Post-Call Review state (B-4 requirement 1, 2, 3)
  const [isGeneratingReview, setIsGeneratingReview] = useState<boolean>(false);
  const [reviewProgressStep, setReviewProgressStep] = useState<string>("");
  const [activeReviewData, setActiveReviewData] = useState<ActiveReviewState | null>(null);
  // Failed review: kept so the in-app card can retry the same session
  const [reviewFailure, setReviewFailure] = useState<{
    message: string;
    retry: () => void;
  } | null>(null);
  const [homeRefreshKey, setHomeRefreshKey] = useState<number>(0);
  const [pendingHomeFocus, setPendingHomeFocus] = useState<HomeFocus>(null);

  // Placeholders for prompts
  const [placeholders, setPlaceholders] = useState<PromptPlaceholders>(DEFAULT_PROMPT_PLACEHOLDERS);

  // Active Call State (B-2 requirement)
  const [activeCallGoal, setActiveCallGoal] = useState<GoalData | null>(null);
  const [activeCallLesson, setActiveCallLesson] = useState<number>(1);
  const [activeCallTextOnly, setActiveCallTextOnly] = useState<boolean>(false);
  // Pre-call prep screen (lesson, expressions, mic check) shown before connecting
  const [prepCall, setPrepCall] = useState<{ goal: GoalData; lessonIndex: number } | null>(null);

  // 1. Connection check & Auth listener
  useEffect(() => {
    validateFirestoreConnection().catch((err) =>
      console.warn("Firestore connection check:", err)
    );

    const unsubscribe = subscribeToAuth((authUser, error) => {
      setAuthLoading(false);
      if (error) {
        setAuthError(error.message);
        setUser(null);
      } else {
        setAuthError(null);
        if (authUser) markBoot("auth");
        setUser(authUser);
      }
    });

    return () => unsubscribe();
  }, []);

  // 1-1. 인증이 풀리거나(세션 만료·다른 탭 로그아웃·오류) uid가 바뀌면 이전 부트 캐시를 지운다.
  // 인증 확인 중(authLoading)에는 지우지 않아 정상 부트 캐시를 보존한다.
  useEffect(() => {
    if (authLoading) return;
    const uid = user ? user.uid : null;
    const prevUid = prevUidRef.current;
    if (!uid) {
      if (prevUid) clearBootCache(defaultBootStore(), prevUid);
      clearBootCache(defaultBootStore());
    } else if (prevUid && prevUid !== uid) {
      clearBootCache(defaultBootStore(), prevUid);
    }
    prevUidRef.current = uid;
  }, [authLoading, user]);

  // 2. Load Firestore Data when authenticated + B-4 requirement 0 retry/watchdog
  useEffect(() => {
    if (!user) {
      activeUidRef.current = null;
      loadUserDataRef.current = null;
      if (goalsGateUidRef.current !== null) {
        goalsCommitGateRef.current = createGoalsCommitGate();
        goalsGateUidRef.current = null;
        profileAppliedAtRef.current = Number.NEGATIVE_INFINITY;
      }
      setUserProfile(null);
      setGoals([]);
      setGoalsSync(nextGoalsSyncState("signedOut"));
      return;
    }

    const uid = user.uid;
    activeUidRef.current = uid;
    let cancelled = false;
    const isActive = () => !cancelled && activeUidRef.current === uid;
    if (goalsGateUidRef.current !== uid) {
      goalsCommitGateRef.current = createGoalsCommitGate();
      goalsGateUidRef.current = uid;
      profileAppliedAtRef.current = Number.NEGATIVE_INFINITY;
      const cachedGoals = readBootCache(defaultBootStore(), uid, Date.now());
      if (cachedGoals) {
        setGoals(cachedGoals);
      } else {
        setGoals([]);
      }
      setGoalsSync(nextGoalsSyncState("cache"));
    }

    const loadUserData = async () => {
      const readStartedAt = Date.now();
      setDataLoading(true);
      try {
        // Mark when the read settles — success, throw, or a superseded effect —
        // before isActive() drops a stale result. Same seam as home mistakes.
        const { profile, goals: userGoals } = await settleBootPhase("data", () =>
          loadProfileAndGoals(uid, {
            getUserProfile,
            saveUserProfile,
            getUserGoals,
            batchInitGoals,
            defaultProfile: () => ({
              email: user.email || ALLOWED_USER_EMAIL,
              job: DEFAULT_PROMPT_PLACEHOLDERS.job,
              surveyTopics: DEFAULT_PROMPT_PLACEHOLDERS.surveyTopics,
              phillyRole: DEFAULT_PROMPT_PLACEHOLDERS.phillyRole,
              sttEngine: "gemini",
              ttsEngine: "gemini",
              lectureTime: "07:00",
              feedSecret: "secret-" + Math.random().toString(36).substring(2, 9),
              initialProgressConfigured: false,
              updatedAt: new Date().toISOString(),
            }),
            defaultGoals: DEFAULT_GOALS,
          })
        );
        if (!isActive()) return;
        if (readStartedAt >= profileAppliedAtRef.current) {
          profileAppliedAtRef.current = readStartedAt;
          setUserProfile(profile);

          // Populate placeholders from profile
          setPlaceholders({
            job: profile.job || DEFAULT_PROMPT_PLACEHOLDERS.job,
            surveyTopics: profile.surveyTopics || DEFAULT_PROMPT_PLACEHOLDERS.surveyTopics,
            phillyRole: profile.phillyRole || DEFAULT_PROMPT_PLACEHOLDERS.phillyRole,
            opicWeakPoints: profile.opicWeakPoints || DEFAULT_PROMPT_PLACEHOLDERS.opicWeakPoints,
            phillyWeakPoints: profile.phillyWeakPoints || DEFAULT_PROMPT_PLACEHOLDERS.phillyWeakPoints,
            travelWeakPoints: profile.travelWeakPoints || DEFAULT_PROMPT_PLACEHOLDERS.travelWeakPoints,
          });

          // 더 새로운 프로필이 이미 설정을 끝냈으면 일찍 연 창을 닫는다.
          setShowInitialProgressModal(!profile.initialProgressConfigured);
        }

        if (goalsCommitGateRef.current.claim(readStartedAt)) {
          goalsRef.current = userGoals;
          setGoals(userGoals);
          setGoalsSync(nextGoalsSyncState("fresh"));
          commitBootGoals(defaultBootStore(), uid, userGoals, Date.now(), readStartedAt);
        }

        // B-4 Requirement 0: Auto retry uploading pending/failed chunks from IndexedDB
        retryPendingUploads(uid).catch((retryErr) => {
          console.warn("[App] Auto retry failed chunks error:", retryErr);
        });

        // Only mark sessions that have gone stale (default 2 min). A 0ms threshold would also
        // close a live call that is still running in another tab of the same account.
        try {
          const interrupted = await checkAndMarkInterruptedSessions(uid);
          if (isActive() && interrupted.length > 0) {
            setUnfinishedSessions(interrupted);
            setShowUnfinishedModal(true);
          }
        } catch (sessErr) {
          console.warn("[App] Watchdog check interrupted sessions error:", sessErr);
        }
      } catch (err) {
        console.error("Failed to load user data from Firestore:", err);
        if (isActive() && goalsCommitGateRef.current.claim(readStartedAt)) {
          // 캐시가 있든 없든 실패로 표시하고 「다시 확인」을 보여 준다.
          // 더 새로운 조회가 이미 반영됐으면 그 결과를 실패로 되돌리지 않는다.
          setGoalsSync(nextGoalsSyncState("failed"));
        }
      } finally {
        if (isActive()) {
          setDataLoading(false);
        }
      }
    };

    loadUserDataRef.current = loadUserData;
    loadUserData();

    // 로그인 상태에서 60초마다 미업로드 조각 재시도(대기 조각이 없으면 즉시 반환)
    const retryInterval = setInterval(() => {
      retryPendingUploads(user.uid).catch((retryErr) => {
        console.warn("[App] Periodic retry failed chunks error:", retryErr);
      });
    }, 60_000);

    return () => {
      cancelled = true;
      if (loadUserDataRef.current === loadUserData) loadUserDataRef.current = null;
      clearInterval(retryInterval);
    };
  }, [user]);

  // 「다시 확인」: 최신 진도를 서버에서 다시 불러온다.
  const handleRetryGoalsSync = () => {
    const load = loadUserDataRef.current;
    if (!load) return;
    setGoalsSync(nextGoalsSyncState("retry"));
    load();
  };

  // Handle Initial Progress Save
  const handleSaveInitialProgress = async (updatedProgress: Record<string, number>) => {
    if (!user) return;
    const uid = user.uid;

    for (const [goalId, lessonIndex] of Object.entries(updatedProgress)) {
      await updateGoalProgress(uid, goalId, lessonIndex);
    }

    // Refresh goals
    const readStartedAt = Date.now();
    const updatedGoals = await getUserGoals(uid);
    if (activeUidRef.current !== uid) return;
    if (goalsCommitGateRef.current.claim(readStartedAt)) {
      goalsRef.current = updatedGoals;
      setGoals(updatedGoals);
      setGoalsSync(nextGoalsSyncState("fresh"));
      commitBootGoals(defaultBootStore(), uid, updatedGoals, Date.now(), readStartedAt);
    }

    // Mark as configured in userProfile
    await saveUserProfile(uid, { initialProgressConfigured: true });
    if (activeUidRef.current !== uid) return;
    setUserProfile((prev) => (prev ? { ...prev, initialProgressConfigured: true } : null));
    setShowInitialProgressModal(false);
  };

  // Re-read goals after something changed them in Firestore (call review advanced the lesson,
  // coach plan change approved/reverted), so 「오늘 수업」 shows the current lesson.
  const refreshGoals = async () => {
    if (!user) return;
    const uid = user.uid;
    const readStartedAt = Date.now();
    try {
      const latestGoals = await getUserGoals(uid);
      if (activeUidRef.current !== uid) return;
      if (!goalsCommitGateRef.current.claim(readStartedAt)) return;
      goalsRef.current = latestGoals;
      setGoals(latestGoals);
      setGoalsSync(nextGoalsSyncState("fresh"));
      commitBootGoals(defaultBootStore(), uid, latestGoals, Date.now(), readStartedAt);
    } catch (err) {
      console.warn("[App] Could not refresh goals:", err);
    }
  };

  // 끝나지 않은 통화 목록을 다시 읽음 (복기 실패·완료 뒤 홈의 안내 띠가 바로 맞게 보이도록).
  const refreshUnfinished = async () => {
    if (!user) return;
    setUnfinishedSessions(await getUnfinishedSessions(user.uid));
  };

  // 브라우저 뒤로가기 동기화 (0=홈, 1=통화 준비·통화·모달)
  const backState: BackTargetState = {
    activeCall: Boolean(activeCallGoal),
    generatingReview: isGeneratingReview,
    reviewFailure: Boolean(reviewFailure),
    initialProgressModal: showInitialProgressModal,
    prepCall: Boolean(prepCall),
    activeReview: Boolean(activeReviewData),
    unfinishedModal: Boolean(showUnfinishedModal && unfinishedSessions.length > 0),
    settingsModal: showSettingsModal,
  };
  const depth = getNavigationDepth(backState);

  const historySyncRef = useRef<HistoryDepthSync | null>(null);
  const backStateRef = useRef({
    state: backState,
    refreshUnfinished,
  });
  backStateRef.current = {
    state: backState,
    refreshUnfinished,
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = new HistoryDepthSync({
      history: window.history,
      subscribePopstate: (listener) => {
        window.addEventListener("popstate", listener);
        return () => window.removeEventListener("popstate", listener);
      },
      onUserBack: () => {
        const s = backStateRef.current;
        const target = pickBackTarget(s.state);
        if (!target) return;

        const nextState: BackTargetState = { ...s.state };
        if (target === "prepCall") {
          setPrepCall(null);
          nextState.prepCall = false;
        } else if (target === "review") {
          setActiveReviewData(null);
          setHomeRefreshKey((prev) => prev + 1);
          s.refreshUnfinished().catch(() => {});
          nextState.activeReview = false;
        } else if (target === "unfinished") {
          setShowUnfinishedModal(false);
          nextState.unfinishedModal = false;
        } else if (target === "settings") {
          setShowSettingsModal(false);
          nextState.settingsModal = false;
        }
        if (getNavigationDepth(nextState) === 0) {
          sync.setDepth(0);
        }
      },
    });
    historySyncRef.current = sync;
    return () => {
      sync.dispose();
      historySyncRef.current = null;
    };
  }, []);

  useEffect(() => {
    historySyncRef.current?.setDepth(depth);
  }, [depth]);

  // Handle Goal Lesson Change
  const handleUpdateGoalProgress = async (goalId: string, nextLessonIndex: number) => {
    if (!user) return;
    const uid = user.uid;
    await updateGoalProgress(uid, goalId, nextLessonIndex);
    if (activeUidRef.current !== uid) return;
    const readStartedAt = Date.now();
    if (!goalsCommitGateRef.current.claim(readStartedAt)) return;
    // await 동안 바뀌었을 수 있는 최신 목록(goalsRef)에서 다음 목록을 계산한다.
    const updatedGoals = goalsRef.current.map((g) =>
      g.id === goalId ? { ...g, nextLessonIndex } : g
    );
    goalsRef.current = updatedGoals;
    setGoals(updatedGoals);
    commitBootGoals(defaultBootStore(), uid, updatedGoals, readStartedAt, readStartedAt);
  };

  // Handle Placeholders Save
  const handleSavePlaceholders = async (updated: PromptPlaceholders) => {
    setPlaceholders(updated);
    if (!user) return;
    await saveUserProfile(user.uid, {
      job: updated.job,
      surveyTopics: updated.surveyTopics,
      phillyRole: updated.phillyRole,
      opicWeakPoints: updated.opicWeakPoints,
      phillyWeakPoints: updated.phillyWeakPoints,
      travelWeakPoints: updated.travelWeakPoints,
    });
  };

  // Handle Logout
  const handleLogout = async () => {
    activeUidRef.current = null;
    clearBootCache(defaultBootStore());
    try {
      await logOut();
    } finally {
      // 로그아웃 도중 늦게 끝난 쓰기가 남았을 수 있어 한 번 더 지운다.
      clearBootCache(defaultBootStore());
    }
  };

  // Handle Call Start & End (B-2, B-3, B-4)
  const handleStartCall = (goal: GoalData, lessonIndex: number) => {
    if (!canStartCall(goalsSync)) return;
    setPrepCall({ goal, lessonIndex });
  };

  const handlePrepConfirmed = (opts: { micSkipped: boolean }) => {
    if (!prepCall) return;
    setActiveCallGoal(prepCall.goal);
    setActiveCallLesson(prepCall.lessonIndex);
    setActiveCallTextOnly(Boolean(opts?.micSkipped));
    setPrepCall(null);
  };

  const handleEndCall = async (
    transcripts: LiveTranscriptItem[],
    stats?: { connectionPath: "direct" | "proxy"; directFailCount: number },
    sessionId?: string,
    audioBlobs?: Blob[]
  ) => {
    const endedGoal = activeCallGoal;
    const endedLesson = activeCallLesson;
    const finalSessionId = sessionId || `call-${Date.now()}`;
    setActiveCallGoal(null);
    setActiveCallTextOnly(false);

    if (!user || !endedGoal) return;

    const sessionUser = user;
    const lessonTitle = endedGoal.lessons.find((l) => l.index === endedLesson)?.title || `${endedLesson}과`;
    const run = async () => {
      setReviewFailure(null);
      setIsGeneratingReview(true);
      setReviewProgressStep("1/3 녹음을 정리하고 받아쓰는 중...");
      try {
        const result = await runPostCallReview({
          userId: sessionUser.uid,
          sessionId: finalSessionId,
          goal: endedGoal,
          lessonIndex: endedLesson,
          placeholders,
          audioBlobs,
          liveTranscript: transcripts,
          onProgress: (step) => setReviewProgressStep(step),
        });
        // Send tonight's new mistakes to the morning-lecture feed now. Before, this only
        // happened when the home screen was shown again, so closing the app on the review
        // screen left the 6:40 bot with yesterday's list.
        syncFeedNow(sessionUser.uid).catch((e) => console.warn("[App] feed sync after review failed:", e));
        await refreshGoals();
        setActiveReviewData({
          review: result.review,
          sttFinal: result.sttFinal,
          ...(result.timing ? { timing: result.timing } : {}),
          goalId: endedGoal.id,
          lessonIndex: endedLesson,
          goalTitle: endedGoal.title,
          lessonTitle,
          sessionId: finalSessionId,
        });
      } catch (err: any) {
        console.error("[App] Post-call review generation failed:", err);
        // Keep the session reopenable from 끝나지 않은 통화.
        await markSessionPendingReview(sessionUser.uid, finalSessionId).catch(() => {});
        refreshUnfinished().catch(() => {});
        setReviewFailure({ message: friendlyError(err, "복기를 만드는 중 문제가 생겼어요."), retry: run });
      } finally {
        setIsGeneratingReview(false);
        setReviewProgressStep("");
      }
    };
    await run();
  };

  // B-4: Handle "복기 시작" from Unfinished Session Modal
  const handleStartReviewFromSession = async (session: SessionData) => {
    if (!user) return;

    const matchedGoal: GoalData = goals.find((g) => g.id === session.goalId) ||
      goals[0] || {
        id: session.goalId || "opic",
        title: session.goalId?.toUpperCase() || "영어 회화",
        type: "opic",
        why: "",
        priority: 1,
        tutorPrompt: "",
        lessons: [{ index: session.lessonIndex, title: `${session.lessonIndex}과` }],
        nextLessonIndex: session.lessonIndex,
        status: "active",
        updatedAt: new Date().toISOString(),
      };

    const lessonTitle = matchedGoal.lessons.find((l) => l.index === session.lessonIndex)?.title || `${session.lessonIndex}과`;

    // If review already exists for this session, open it directly
    if (session.review) {
      setActiveReviewData({
        review: session.review,
        sttFinal: session.sttFinal,
        ...(session.reviewTiming ? { timing: session.reviewTiming } : {}),
        goalId: matchedGoal.id,
        lessonIndex: session.lessonIndex,
        goalTitle: matchedGoal.title,
        lessonTitle,
        sessionId: session.id,
      });
      return;
    }

    // Otherwise generate post-call review for the unfinished session
    const sessionUser = user;
    void recordRecoveredUsageOnce(sessionUser.uid, session.id);

    const run = async () => {
      setReviewFailure(null);
      setIsGeneratingReview(true);
      setReviewProgressStep("1/3 저장된 녹음을 정리하고 받아쓰는 중...");
      try {
        const localChunks = (await getAllPendingChunks())
          .filter((c) => c.sessionId === session.id)
          .map((c) => ({ index: c.index, blob: c.blob }));
        const result = await runPostCallReview({
          userId: sessionUser.uid,
          sessionId: session.id,
          goal: matchedGoal,
          lessonIndex: session.lessonIndex,
          placeholders,
          localChunks,
          liveTranscript: session.liveTranscript,
          onProgress: (step) => setReviewProgressStep(step),
        });
        syncFeedNow(sessionUser.uid).catch((e) => console.warn("[App] feed sync after review failed:", e));
        await refreshGoals();

        setActiveReviewData({
          review: result.review,
          sttFinal: result.sttFinal,
          ...(result.timing ? { timing: result.timing } : {}),
          goalId: matchedGoal.id,
          lessonIndex: session.lessonIndex,
          goalTitle: matchedGoal.title,
          lessonTitle,
          sessionId: session.id,
        });

        const remaining = await getUnfinishedSessions(sessionUser.uid);
        setUnfinishedSessions(remaining);
      } catch (err: any) {
        console.error("[App] Unfinished session review failed:", err);
        setReviewFailure({ message: friendlyError(err, "복기를 만드는 중 문제가 생겼어요."), retry: run });
      } finally {
        setIsGeneratingReview(false);
        setReviewProgressStep("");
      }
    };
    await run();
  };

  // 1. Initial Auth Loading State
  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#0F141C] flex flex-col items-center justify-center text-slate-300">
        <Loader2 className="w-8 h-8 text-amber-400 animate-spin mb-3" />
        <p className="text-xs text-slate-400 font-medium">인증 상태 확인 중...</p>
      </div>
    );
  }

  // 2. Unauthenticated or Denied State
  if (!user) {
    return <LoginScreen />;
  }

  // 3. User Data Loading State
  if (dataLoading && goals.length === 0) {
    return (
      <div className="min-h-screen bg-[#0F141C] flex flex-col items-center justify-center text-slate-300">
        <Loader2 className="w-8 h-8 text-amber-400 animate-spin mb-3" />
        <p className="text-xs text-slate-400 font-medium">클라우드 데이터베이스 동기화 중...</p>
      </div>
    );
  }

  // 4. Live Call View (B-2 & B-3)
  if (activeCallGoal && user) {
    return (
      <NewCallScreen
        userId={user.uid}
        goal={activeCallGoal}
        lessonIndex={activeCallLesson}
        placeholders={placeholders}
        // Settings → 1분 임시 받아쓰기 switch (saved in this browser by SettingsModal). Default off.
        enablePartialTranscribe={isPartialTranscribeEnabled()}
        textOnly={activeCallTextOnly}
        onEndCall={handleEndCall}
        onExit={() => {
          setActiveCallGoal(null);
          setActiveCallTextOnly(false);
        }}
      />
    );
  }

  // 4-0. Pre-call prep
  if (prepCall && user) {
    return (
      <PreCallScreen
        userId={user.uid}
        goal={prepCall.goal}
        lessonIndex={prepCall.lessonIndex}
        onStart={handlePrepConfirmed}
        onBack={() => setPrepCall(null)}
      />
    );
  }

  // 5. Authenticated Main Home View
  const showUnfinishedPill =
    unfinishedSessions.length > 0 && !showUnfinishedModal && !isGeneratingReview && !reviewFailure && !activeReviewData;

  return (
    <>
      <HomeScreen
        key={homeRefreshKey}
        user={user}
        goals={goals}
        goalsSyncing={!canStartCall(goalsSync)}
        goalsSyncFailed={goalsSync === "failed"}
        onRetryGoalsSync={handleRetryGoalsSync}
        placeholders={placeholders}
        focus={pendingHomeFocus}
        onFocusHandled={() => setPendingHomeFocus(null)}
        onUpdateGoalProgress={handleUpdateGoalProgress}
        onGoalsChanged={refreshGoals}
        onStartCall={handleStartCall}
        onOpenSettings={() => setShowSettingsModal(true)}
        onLogout={handleLogout}
        unfinishedCount={showUnfinishedPill ? unfinishedSessions.length : 0}
        onOpenUnfinished={() => setShowUnfinishedModal(true)}
      />

      {/* Dedicated post-call review flow: loading → (ReviewModal) | in-app failure card */}
      {(isGeneratingReview || reviewFailure) && (
        <ReviewFlowScreen
          loading={isGeneratingReview}
          progressStep={reviewProgressStep}
          errorMessage={reviewFailure?.message || null}
          onRetry={() => reviewFailure?.retry()}
          onLater={() => {
            setReviewFailure(null);
            setHomeRefreshKey((prev) => prev + 1);
          }}
        />
      )}


      {/* Review Modal Screen (B-4 requirement 3) */}
      {activeReviewData && (
        <ReviewModal
          userId={user.uid}
          sessionId={activeReviewData.sessionId}
          goalId={activeReviewData.goalId}
          lessonIndex={activeReviewData.lessonIndex}
          goalTitle={activeReviewData.goalTitle}
          lessonTitle={activeReviewData.lessonTitle}
          review={activeReviewData.review}
          sttFinal={activeReviewData.sttFinal}
          timing={activeReviewData.timing}
          onOpenPodcast={() => setPendingHomeFocus("lecture")}
          onClose={() => {
            setActiveReviewData(null);
            setHomeRefreshKey((prev) => prev + 1);
            refreshUnfinished().catch(() => {});
          }}
        />
      )}

      {/* Unfinished Session Modal (B-3 requirement 4 & B-4 requirement 0) */}
      {showUnfinishedModal && unfinishedSessions.length > 0 && user && (
        <UnfinishedSessionModal
          userId={user.uid}
          unfinishedSessions={unfinishedSessions}
          onClose={() => setShowUnfinishedModal(false)}
          onStartReview={handleStartReviewFromSession}
          onResolved={async () => {
            setShowUnfinishedModal(false);
            const remaining = await getUnfinishedSessions(user.uid);
            setUnfinishedSessions(remaining);
          }}
        />
      )}

      {/* Initial Progress Modal on First Run */}
      {showInitialProgressModal && (
        <InitialProgressModal
          goals={goals}
          onSave={handleSaveInitialProgress}
        />
      )}

      {/* Settings Modal */}
      <SettingsModal
        userId={user.uid}
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        placeholders={placeholders}
        onSavePlaceholders={handleSavePlaceholders}
        onResetProgressRequest={() => setShowInitialProgressModal(true)}
      />
    </>
  );
};

export default App;
