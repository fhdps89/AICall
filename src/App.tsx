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
  GoalData,
  UserProfileData,
} from "./services/firebase/db";
import { DEFAULT_GOALS } from "./data/defaultGoals";
import {
  DEFAULT_PROMPT_PLACEHOLDERS,
  PromptPlaceholders,
} from "./data/promptCustomizer";
import { LoginScreen } from "./ui/auth/LoginScreen";
import { HomeScreen } from "./ui/home/HomeScreen";
import { InitialProgressModal } from "./ui/onboarding/InitialProgressModal";
import { SettingsModal } from "./ui/settings/SettingsModal";
import { ShieldAlert, Loader2 } from "lucide-react";

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

  // Placeholders for prompts
  const [placeholders, setPlaceholders] = useState<PromptPlaceholders>(DEFAULT_PROMPT_PLACEHOLDERS);

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

  // 2. Load Firestore Data when authenticated
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

  // 4. Authenticated Main View
  return (
    <>
      <HomeScreen
        user={user}
        goals={goals}
        placeholders={placeholders}
        onUpdateGoalProgress={handleUpdateGoalProgress}
        onOpenSettings={() => setShowSettingsModal(true)}
        onLogout={handleLogout}
      />

      {/* Initial Progress Modal on First Run */}
      {showInitialProgressModal && (
        <InitialProgressModal
          goals={goals}
          onSave={handleSaveInitialProgress}
        />
      )}

      {/* Settings Modal */}
      <SettingsModal
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
