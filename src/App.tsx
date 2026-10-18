import React, { useState, useEffect } from "react";
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
  markSessionPendingReview,
  checkAndMarkInterruptedSessions,
  GoalData,
  UserProfileData,
  SessionData,
  SessionReviewData,
  SttFinalData,
} from "./services/firebase/db";
import { retryPendingUploads } from "./services/recording/chunkIndexedDb";
import { runPostCallReview } from "./services/review/reviewPipeline";
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
import { Loader2 } from "lucide-react";

/** Settings → 1분 임시 받아쓰기 switch (saved in this browser by SettingsModal). Default on. */
function isPartialTranscribeEnabled(): boolean {
  try {
    return localStorage.getItem("onecall_enable_partial_transcribe") !== "false";
  } catch {
    return true;
  }
}

interface ActiveReviewState {
  review: SessionReviewData;
  sttFinal?: SttFinalData;
  goalId: string;
  lessonIndex: number;
  goalTitle: string;
  lessonTitle: string;
  sessionId: string;
}

export const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // User Profile & Goals State
  const [userProfile, setUserProfile] = useState<UserProfileData | null>(null);
  const [goals, setGoals] = useState<GoalData[]>([]);
  const [dataLoading, setDataLoading] = useState<boolean>(false);

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

  // Placeholders for prompts
  const [placeholders, setPlaceholders] = useState<PromptPlaceholders>(DEFAULT_PROMPT_PLACEHOLDERS);

  // Active Call State (B-2 requirement)
  const [activeCallGoal, setActiveCallGoal] = useState<GoalData | null>(null);
  const [activeCallLesson, setActiveCallLesson] = useState<number>(1);
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
        setUser(authUser);
      }
    });

    return () => unsubscribe();
  }, []);

  // 2. Load Firestore Data when authenticated + B-4 requirement 0 retry/watchdog
  useEffect(() => {
    if (!user) {
      setUserProfile(null);
      setGoals([]);
      return;
    }

    const loadUserData = async () => {
      setDataLoading(true);
      try {
        // Fetch or initialize profile
        let profile = await getUserProfile(user.uid);
        if (!profile) {
          profile = {
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
          };
          await saveUserProfile(user.uid, profile);
        }
        setUserProfile(profile);

        // Populate placeholders from profile
        setPlaceholders({
          job: profile.job || DEFAULT_PROMPT_PLACEHOLDERS.job,
          surveyTopics: profile.surveyTopics || DEFAULT_PROMPT_PLACEHOLDERS.surveyTopics,
          phillyRole: profile.phillyRole || DEFAULT_PROMPT_PLACEHOLDERS.phillyRole,
          opicWeakPoints: DEFAULT_PROMPT_PLACEHOLDERS.opicWeakPoints,
          phillyWeakPoints: DEFAULT_PROMPT_PLACEHOLDERS.phillyWeakPoints,
          travelWeakPoints: DEFAULT_PROMPT_PLACEHOLDERS.travelWeakPoints,
        });

        // Fetch or initialize Goals
        let userGoals = await getUserGoals(user.uid);
        if (userGoals.length === 0) {
          await batchInitGoals(user.uid, DEFAULT_GOALS);
          userGoals = DEFAULT_GOALS;
        }
        setGoals(userGoals);

        // Check if first-run progress setup is needed
        if (!profile.initialProgressConfigured) {
          setShowInitialProgressModal(true);
        }

        // B-4 Requirement 0: Auto retry uploading pending/failed chunks from IndexedDB
        retryPendingUploads(user.uid).catch((retryErr) => {
          console.warn("[App] Auto retry failed chunks error:", retryErr);
        });

        // B-4 Requirement 0: Firestore-based watchdog (in-progress && lastChunkAt > 2m => pending_review)
        try {
          const interrupted = await checkAndMarkInterruptedSessions(user.uid);
          if (interrupted.length > 0) {
            setUnfinishedSessions(interrupted);
            setShowUnfinishedModal(true);
          }
        } catch (sessErr) {
          console.warn("[App] Watchdog check interrupted sessions error:", sessErr);
        }
      } catch (err) {
        console.error("Failed to load user data from Firestore:", err);
      } finally {
        setDataLoading(false);
      }
    };

    loadUserData();
  }, [user]);

  // Handle Initial Progress Save
  const handleSaveInitialProgress = async (updatedProgress: Record<string, number>) => {
    if (!user) return;

    for (const [goalId, lessonIndex] of Object.entries(updatedProgress)) {
      await updateGoalProgress(user.uid, goalId, lessonIndex);
    }

    // Refresh goals
    const updatedGoals = await getUserGoals(user.uid);
    setGoals(updatedGoals);

    // Mark as configured in userProfile
    await saveUserProfile(user.uid, { initialProgressConfigured: true });
    setUserProfile((prev) => (prev ? { ...prev, initialProgressConfigured: true } : null));
    setShowInitialProgressModal(false);
  };

  // Re-read goals after something changed them in Firestore (call review advanced the lesson,
  // coach plan change approved/reverted), so 「오늘 수업」 shows the current lesson.
  const refreshGoals = async () => {
    if (!user) return;
    try {
      setGoals(await getUserGoals(user.uid));
    } catch (err) {
      console.warn("[App] Could not refresh goals:", err);
    }
  };

  // Handle Goal Lesson Change
  const handleUpdateGoalProgress = async (goalId: string, nextLessonIndex: number) => {
    if (!user) return;
    await updateGoalProgress(user.uid, goalId, nextLessonIndex);
    setGoals((prev) =>
      prev.map((g) => (g.id === goalId ? { ...g, nextLessonIndex } : g))
    );
  };

  // Handle Placeholders Save
  const handleSavePlaceholders = async (updated: PromptPlaceholders) => {
    setPlaceholders(updated);
    if (!user) return;
    await saveUserProfile(user.uid, {
      job: updated.job,
      surveyTopics: updated.surveyTopics,
      phillyRole: updated.phillyRole,
    });
  };

  // Handle Logout
  const handleLogout = async () => {
    await logOut();
  };

  // Handle Call Start & End (B-2, B-3, B-4)
  const handleStartCall = (goal: GoalData, lessonIndex: number) => {
    setPrepCall({ goal, lessonIndex });
  };

  const handlePrepConfirmed = () => {
    if (!prepCall) return;
    setActiveCallGoal(prepCall.goal);
    setActiveCallLesson(prepCall.lessonIndex);
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
        await refreshGoals();
        setActiveReviewData({
          review: result.review,
          sttFinal: result.sttFinal,
          goalId: endedGoal.id,
          lessonIndex: endedLesson,
          goalTitle: endedGoal.title,
          lessonTitle,
          sessionId: finalSessionId,
        });
      } catch (err: any) {
        console.error("[App] Post-call review generation failed:", err);
        // Keep the session reopenable from 끝나지 않은 통화 (finalize marked it done).
        markSessionPendingReview(sessionUser.uid, finalSessionId).catch(() => {});
        setReviewFailure({ message: err?.message || "알 수 없는 오류", retry: run });
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
    const run = async () => {
      setReviewFailure(null);
      setIsGeneratingReview(true);
      setReviewProgressStep("1/3 저장된 녹음을 정리하고 받아쓰는 중...");
      try {
        const result = await runPostCallReview({
          userId: sessionUser.uid,
          sessionId: session.id,
          goal: matchedGoal,
          lessonIndex: session.lessonIndex,
          placeholders,
          liveTranscript: session.liveTranscript,
          onProgress: (step) => setReviewProgressStep(step),
        });
        await refreshGoals();

        setActiveReviewData({
          review: result.review,
          sttFinal: result.sttFinal,
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
        setReviewFailure({ message: err?.message || "알 수 없는 오류", retry: run });
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
        enablePartialTranscribe={isPartialTranscribeEnabled()}
        onEndCall={handleEndCall}
        onExit={() => setActiveCallGoal(null)}
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
  return (
    <>
      <HomeScreen
        key={homeRefreshKey}
        user={user}
        goals={goals}
        placeholders={placeholders}
        onUpdateGoalProgress={handleUpdateGoalProgress}
        onGoalsChanged={refreshGoals}
        onStartCall={handleStartCall}
        onOpenSettings={() => setShowSettingsModal(true)}
        onLogout={handleLogout}
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
          onClose={() => {
            setActiveReviewData(null);
            setHomeRefreshKey((prev) => prev + 1);
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
