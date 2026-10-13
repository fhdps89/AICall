import React, { useState, useEffect } from "react";
import { User } from "firebase/auth";
import {
  GoalData,
  MistakeData,
  getDueMistakes,
  getUserMistakes,
  advanceMistakeAfterLesson,
  getKSTToday,
} from "../../services/firebase/db";
import { WEEKLY_ROUTINE, getTodayRoutine } from "../../data/defaultGoals";
import { PromptPlaceholders, hydrateTutorPrompt } from "../../data/promptCustomizer";
import {
  Settings,
  LogOut,
  Calendar,
  BookOpen,
  ChevronRight,
  FileText,
  Sparkles,
  CheckCircle,
  ExternalLink,
  Layers,
  PhoneCall,
  GraduationCap,
  Wrench,
  Clock,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Play,
} from "lucide-react";
import { QuizModal } from "../quiz/QuizModal";
import { MorningLectureCard } from "../lecture/MorningLectureCard";
import { syncFeed } from "../../services/feed/feedService";

interface HomeScreenProps {
  user: User;
  goals: GoalData[];
  placeholders: PromptPlaceholders;
  onUpdateGoalProgress: (goalId: string, nextLessonIndex: number) => Promise<void>;
  onStartCall: (goal: GoalData, lessonIndex: number) => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({
  user,
  goals,
  placeholders,
  onUpdateGoalProgress,
  onStartCall,
  onOpenSettings,
  onLogout,
}) => {
  const [selectedPromptGoal, setSelectedPromptGoal] = useState<GoalData | null>(null);
  const [showPromptModal, setShowPromptModal] = useState(false);
  const [promptViewMode, setPromptViewMode] = useState<"raw" | "hydrated">("hydrated");

  // B-5 Spaced Repetition Due Mistakes State
  const [dueMistakes, setDueMistakes] = useState<MistakeData[]>([]);
  const [allMistakes, setAllMistakes] = useState<MistakeData[]>([]);
  const [mistakesLoading, setMistakesLoading] = useState<boolean>(true);
  const [showDebugSection, setShowDebugSection] = useState<boolean>(false);
  const [advancingId, setAdvancingId] = useState<string | null>(null);
  const [debugToast, setDebugToast] = useState<string | null>(null);
  const [showQuizModal, setShowQuizModal] = useState<boolean>(false);

  const loadMistakes = async () => {
    try {
      setMistakesLoading(true);
      const [due, all] = await Promise.all([
        getDueMistakes(user.uid),
        getUserMistakes(user.uid),
      ]);
      setDueMistakes(due);
      setAllMistakes(all);
      // B-8: keep the Grok Bot feed's candidate list fresh (no scheduler server)
      syncFeed(user.uid).catch((e) => console.warn("[HomeScreen] feed sync failed:", e));
    } catch (err) {
      console.warn("[HomeScreen] Failed to load mistakes:", err);
    } finally {
      setMistakesLoading(false);
    }
  };

  useEffect(() => {
    if (user?.uid) {
      loadMistakes();
    }
  }, [user?.uid]);

  // Handle B-5 Requirement 2: advanceMistakeAfterLesson (임시 디버그)
  const handleAdvanceMistake = async (mistakeId: string, phrase: string) => {
    if (!user?.uid) return;
    setAdvancingId(mistakeId);
    try {
      const res = await advanceMistakeAfterLesson(user.uid, mistakeId);
      await loadMistakes();
      setDebugToast(
        `"${phrase}" 진행 완료: ${res.prevStage}일차 ➔ ${res.nextStage}일차 (${res.nextStatus === "deferred" ? "보류 전환" : res.nextStatus}) | 다음 복습: ${res.nextReviewAt}`
      );
      setTimeout(() => setDebugToast(null), 4000);
    } catch (err: any) {
      alert(`단계 진행 오류: ${err?.message || err}`);
    } finally {
      setAdvancingId(null);
    }
  };

  const todayRoutine = getTodayRoutine();
  const currentDayIndex = new Date().getDay();

  // Find goal for today
  const todayGoal = goals.find((g) => g.id === todayRoutine.goalId);
  const currentLesson = todayGoal?.lessons.find(
    (l) => l.index === (todayGoal.nextLessonIndex || 1)
  );

  const handleLessonChange = async (goalId: string, newLessonIndex: number) => {
    await onUpdateGoalProgress(goalId, newLessonIndex);
  };

  return (
    <div className="min-h-screen bg-[#0F141C] text-slate-100 flex flex-col">
      {/* Top Navigation */}
      <header className="border-b border-slate-800 bg-[#161D2A]/80 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-4 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center font-black text-sm">
              1C
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm text-white tracking-tight">One Call English</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium">
                  1단계 뼈대
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-mono truncate max-w-[200px] sm:max-w-none">
                {user.email}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onOpenSettings}
              className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 hover:text-white transition-colors cursor-pointer flex items-center gap-1.5 text-xs"
              title="설정 및 프롬프트 변수"
            >
              <Settings className="w-4 h-4 text-amber-400" />
              <span className="hidden sm:inline">설정</span>
            </button>
            <button
              onClick={onLogout}
              className="p-2 rounded-xl bg-slate-800/80 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 transition-colors cursor-pointer"
              title="로그아웃"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-5xl mx-auto px-4 py-6 w-full flex-1 space-y-6">
        {/* Weekly Routine Bar (B-9) */}
        <section className="bg-[#161D2A] border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-lg">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
              <Calendar className="w-4 h-4 text-amber-400" />
              <span>요일별 집중 루틴 (B-9)</span>
            </div>
            <span className="text-[11px] text-slate-400">
              오늘: <strong className="text-amber-400">{todayRoutine.dayName}</strong> ({todayRoutine.title})
            </span>
          </div>

          <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
            {Object.entries(WEEKLY_ROUTINE).map(([dayKey, item]) => {
              const dayNum = Number(dayKey);
              const isToday = dayNum === currentDayIndex;

              return (
                <div
                  key={dayKey}
                  className={`p-2 sm:p-2.5 rounded-xl border text-center transition-all ${
                    isToday
                      ? "bg-amber-500/15 border-amber-500/40 text-white ring-1 ring-amber-500/30"
                      : "bg-slate-900/40 border-slate-800/70 text-slate-400"
                  }`}
                >
                  <div className={`text-[10px] font-bold uppercase mb-1 ${isToday ? "text-amber-400" : "text-slate-500"}`}>
                    {item.dayShort}
                  </div>
                  <div className="text-[11px] font-semibold truncate leading-tight">
                    {item.isReviewDay ? "주간 복기" : item.title.split(" ")[0]}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* B-7 Morning Lecture Card (오늘 아침 강의) */}
        <MorningLectureCard
          user={user}
          onOpenQuiz={async () => {
            await loadMistakes();
            setShowQuizModal(true);
          }}
          onLectureCompleted={() => loadMistakes()}
        />

        {/* B-5 Spaced Repetition & Due Mistakes Card (간격 반복 & 오늘 복습) */}
        <section className="bg-[#161D2A] border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-lg space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0">
                <GraduationCap className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-amber-400">간격 반복 & 퀴즈 (B-5·B-6)</span>
                  <span className="text-[11px] text-slate-400">
                    보류 {dueMistakes.filter((m) => m.status === "deferred").length}개 · 오늘 복습 대상 {dueMistakes.filter((m) => m.status === "reviewing").length}개
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 sm:gap-4 mt-1">
                  <div className="text-xl sm:text-2xl font-black text-white flex items-center gap-1.5">
                    <span>오늘 복습</span>
                    <span className="text-amber-400 font-mono underline decoration-amber-400/30">
                      {dueMistakes.length}개
                    </span>
                  </div>
                  <div className="text-xl sm:text-2xl font-black text-white flex items-center gap-1.5 border-l border-slate-700/80 pl-3 sm:pl-4">
                    <span>오늘 퀴즈</span>
                    <span className="text-emerald-400 font-mono">
                      {Math.min(dueMistakes.length, 10)}개
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
              <button
                onClick={() => setShowQuizModal(true)}
                disabled={dueMistakes.length === 0}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 text-xs font-black flex items-center gap-1.5 shadow-md shadow-amber-500/20 transition-all cursor-pointer active:scale-95"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>퀴즈 풀기 ({Math.min(dueMistakes.length, 10)}개)</span>
              </button>
              <button
                onClick={() => setShowDebugSection(!showDebugSection)}
                className="px-3 py-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer border border-slate-700/60"
              >
                <Wrench className="w-3.5 h-3.5 text-amber-400" />
                <span>{showDebugSection ? "디버그 닫기" : "임시 디버그"}</span>
              </button>
            </div>
          </div>

          {/* Toast feedback for debug advance */}
          {debugToast && (
            <div className="p-2.5 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-200 text-xs flex items-center gap-2 animate-in fade-in duration-200">
              <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
              <span>{debugToast}</span>
            </div>
          )}

          {/* Temporary Debug Tool (B-5 requirement 2): "이 실수 강의 들었음 처리" */}
          {showDebugSection && (
            <div className="pt-3 border-t border-slate-800/80 space-y-3">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="font-semibold text-amber-300 flex items-center gap-1.5">
                  <Wrench className="w-3.5 h-3.5 text-amber-400" />
                  <span>간격 반복 단계 진행 시뮬레이터 (1→3→7→14→deferred)</span>
                </span>
                <span className="text-[11px] font-mono">
                  총 {allMistakes.length}개 보관
                </span>
              </div>

              {allMistakes.length === 0 ? (
                <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800 text-center text-xs text-slate-400">
                  아직 등록된 실수가 없습니다. 통화 완료 후 복기를 생성하면 1일차 reviewing으로 자동 등록됩니다.
                </div>
              ) : (
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {allMistakes.map((m) => {
                    const isAdvancing = advancingId === m.id;
                    const isGraduated = m.status === "graduated";
                    const isDeferred = m.status === "deferred";

                    return (
                      <div
                        key={m.id}
                        className={`p-3 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 transition-all ${
                          isDeferred
                            ? "bg-purple-950/20 border-purple-800/40"
                            : isGraduated
                            ? "bg-emerald-950/15 border-emerald-800/30 opacity-75"
                            : "bg-slate-900/60 border-slate-800"
                        }`}
                      >
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="font-mono text-red-300 font-semibold line-through decoration-red-400/50 truncate max-w-[200px] sm:max-w-none">
                              "{m.myPhrase}"
                            </span>
                            <ArrowRight className="w-3 h-3 text-slate-500 shrink-0" />
                            <span className="text-emerald-300 font-semibold truncate max-w-[200px] sm:max-w-none">
                              "{m.naturalPhrase}"
                            </span>
                          </div>

                          <div className="flex flex-wrap items-center gap-2 text-[11px]">
                            {/* Status badge */}
                            <span
                              className={`px-2 py-0.5 rounded-full font-bold font-mono text-[10px] border ${
                                isDeferred
                                  ? "bg-purple-500/20 border-purple-500/40 text-purple-300"
                                  : isGraduated
                                  ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
                                  : "bg-amber-500/15 border-amber-500/30 text-amber-300"
                              }`}
                            >
                              {isDeferred
                                ? "보류 (deferred)"
                                : isGraduated
                                ? "졸업 (graduated)"
                                : `복습 중 (${m.stage || 1}일차)`}
                            </span>

                            {/* Next review date */}
                            {m.nextReviewAt && !isGraduated && (
                              <span className="text-slate-400 flex items-center gap-1 font-mono text-[10px]">
                                <Clock className="w-3 h-3 text-slate-500" />
                                <span>다음 복습: {m.nextReviewAt}</span>
                              </span>
                            )}

                            {isGraduated && m.graduatedReason && (
                              <span className="text-[10px] text-emerald-400 font-mono">
                                ({m.graduatedReason === "call_used_correctly" ? "통화에서 맞게 발화하여 즉시 졸업" : "퀴즈 통과 졸업"})
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Debug Action Button: "이 실수 강의 들었음 처리" */}
                        {!isGraduated && m.id && (
                          <button
                            onClick={() => handleAdvanceMistake(m.id!, m.myPhrase)}
                            disabled={isAdvancing}
                            className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-xs shrink-0 flex items-center justify-center gap-1 transition-all cursor-pointer shadow-sm active:scale-95"
                            title="B-7 아침 강의 수강을 가상으로 시뮬레이션하여 1->3->7->14->deferred 로 전진합니다"
                          >
                            {isAdvancing ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            )}
                            <span>이 실수 강의 들었음 처리</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Today's Class Card (오늘 수업 카드) */}
        <section className="bg-gradient-to-br from-[#161D2A] via-[#151C28] to-[#121824] border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-xl relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-amber-500/5 rounded-full blur-3xl pointer-events-none" />

          <div className="flex flex-wrap items-center justify-between gap-2 mb-4 relative z-10">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-bold">
              <Sparkles className="w-3.5 h-3.5" />
              <span>오늘의 추천 수업 카드</span>
            </div>
            <div className="text-xs text-slate-400 font-mono">
              {todayRoutine.dayName} 루틴
            </div>
          </div>

          {todayRoutine.isReviewDay ? (
            <div className="relative z-10 py-6 text-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mx-auto">
                <Calendar className="w-6 h-6" />
              </div>
              <h2 className="text-xl font-bold text-white">일요일: 한 주 복기 및 실수 점검일</h2>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                새로운 진도 대신 이번 주에 기록된 실수와 주요 핵심 표현 5선을 복습하고 다음 주 계획을 준비합니다.
              </p>
            </div>
          ) : todayGoal && currentLesson ? (
            <div className="relative z-10 space-y-5">
              <div>
                <div className="flex items-center gap-2 text-slate-400 text-xs font-medium mb-1">
                  <span>트랙:</span>
                  <span className="text-amber-300 font-semibold">{todayGoal.title}</span>
                  <span className="text-slate-600">·</span>
                  <span>총 {todayGoal.lessons.length}개 과 중 {currentLesson.index}번째</span>
                </div>
                <h2 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                  {currentLesson.index}과. {currentLesson.title}
                </h2>
                <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                  {todayGoal.why}
                </p>
              </div>

              {/* Lesson picker & prompt preview */}
              <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-1">
                  <span className="text-[11px] text-slate-400 font-medium block">진도 변경:</span>
                  <select
                    value={currentLesson.index}
                    onChange={(e) => handleLessonChange(todayGoal.id, Number(e.target.value))}
                    className="bg-[#121824] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-amber-400"
                  >
                    {todayGoal.lessons.map((l) => (
                      <option key={l.index} value={l.index}>
                        {l.index}과: {l.title}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  onClick={() => {
                    setSelectedPromptGoal(todayGoal);
                    setShowPromptModal(true);
                  }}
                  className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer border border-slate-700/50"
                >
                  <FileText className="w-3.5 h-3.5 text-amber-400" />
                  <span>원문 튜터 프롬프트 확인</span>
                </button>
              </div>

              {/* Start Call CTA (B-2 requirement) */}
              <button
                onClick={() => onStartCall(todayGoal, currentLesson.index)}
                className="w-full py-4 px-6 rounded-2xl bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-slate-950 font-black text-sm tracking-tight flex items-center justify-center gap-2.5 shadow-xl shadow-amber-500/20 transition-all cursor-pointer active:scale-98"
              >
                <PhoneCall className="w-5 h-5" />
                <span>오늘 수업 통화 시작하기 ({currentLesson.index}과: {currentLesson.title})</span>
              </button>

              {/* Status info */}
              <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs border-t border-slate-800/70 text-slate-400">
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-emerald-400" />
                  <span>B-2 통화 엔진: gemini-3.8-live · 세션 재개 & 컨텍스트 압축 준비 완료</span>
                </div>
                <div className="text-[11px] text-slate-500 font-mono">
                  GoAway 자동 재연결 지원
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-6 text-slate-400 text-sm">
              목표 데이터를 불러오는 중입니다...
            </div>
          )}
        </section>

        {/* 4 Goals Overview (전체 4대 목표 현황) */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Layers className="w-4 h-4 text-amber-400" />
              <span>4대 집중 트랙 현황</span>
            </h3>
            <span className="text-[11px] text-slate-400">각 목표별 다음 과 번호 관리 및 통화</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {goals.map((goal) => {
              const nextIdx = goal.nextLessonIndex || 1;
              const lessonItem = goal.lessons.find((l) => l.index === nextIdx);

              return (
                <div
                  key={goal.id}
                  className="bg-[#161D2A] border border-slate-800 rounded-2xl p-5 hover:border-slate-700 transition-all flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-bold text-white text-sm">{goal.title}</span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-amber-400 border border-slate-700">
                        다음: {nextIdx}과
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mb-3">{goal.why}</p>

                    <div className="p-2.5 rounded-xl bg-slate-900/60 border border-slate-800/70 mb-3">
                      <span className="text-[10px] text-slate-500 uppercase tracking-wider block font-semibold">
                        NEXT LESSON
                      </span>
                      <p className="text-xs font-semibold text-slate-200 truncate mt-0.5">
                        {lessonItem ? `${lessonItem.index}과. ${lessonItem.title}` : `${nextIdx}과`}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2 pt-2 border-t border-slate-800/60">
                    <div className="flex items-center justify-between text-xs">
                      <select
                        value={nextIdx}
                        onChange={(e) => handleLessonChange(goal.id, Number(e.target.value))}
                        className="bg-[#121824] border border-slate-700 rounded-lg px-2.5 py-1 text-[11px] text-slate-300 focus:outline-none focus:border-amber-400"
                      >
                        {goal.lessons.map((l) => (
                          <option key={l.index} value={l.index}>
                            {l.index}과: {l.title.slice(0, 24)}...
                          </option>
                        ))}
                      </select>

                      <button
                        onClick={() => {
                          setSelectedPromptGoal(goal);
                          setShowPromptModal(true);
                        }}
                        className="text-amber-400 hover:text-amber-300 font-semibold text-[11px] flex items-center gap-1 cursor-pointer transition-colors"
                      >
                        <span>프롬프트 원문</span>
                        <ChevronRight className="w-3 h-3" />
                      </button>
                    </div>

                    <button
                      onClick={() => onStartCall(goal, nextIdx)}
                      className="w-full py-2 px-3 rounded-xl bg-slate-800 hover:bg-amber-500 hover:text-slate-950 text-amber-300 text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer border border-slate-700 hover:border-amber-400"
                    >
                      <PhoneCall className="w-3.5 h-3.5" />
                      <span>{nextIdx}과 통화 시작</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </main>

      {/* Tutor Prompt Viewer Modal */}
      {showPromptModal && selectedPromptGoal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-3xl bg-[#161D2A] border border-slate-800 rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-5 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-white text-base">
                  [{selectedPromptGoal.title}] 튜터 프롬프트
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  부록의 원문 그대로 보존되며, 설정된 사용자 변수 치환 상태를 미리 볼 수 있습니다.
                </p>
              </div>
              <button
                onClick={() => setShowPromptModal(false)}
                className="text-slate-400 hover:text-white text-xs px-2.5 py-1.5 rounded-lg bg-slate-800 cursor-pointer"
              >
                닫기
              </button>
            </div>

            <div className="px-5 py-2.5 bg-slate-900/60 border-b border-slate-800 flex items-center gap-2">
              <button
                onClick={() => setPromptViewMode("hydrated")}
                className={`px-3 py-1 text-xs rounded-lg font-medium cursor-pointer transition-colors ${
                  promptViewMode === "hydrated"
                    ? "bg-amber-500 text-slate-950 font-bold"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                변수 치환본 (Hydrated)
              </button>
              <button
                onClick={() => setPromptViewMode("raw")}
                className={`px-3 py-1 text-xs rounded-lg font-medium cursor-pointer transition-colors ${
                  promptViewMode === "raw"
                    ? "bg-amber-500 text-slate-950 font-bold"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                부록 원본 (Raw)
              </button>
            </div>

            <div className="p-6 overflow-y-auto flex-1 font-mono text-xs leading-relaxed text-slate-300 whitespace-pre-wrap select-text bg-[#0F141C]">
              {promptViewMode === "raw"
                ? selectedPromptGoal.tutorPrompt
                : hydrateTutorPrompt(selectedPromptGoal.tutorPrompt, placeholders)}
            </div>
          </div>
        </div>
      )}

      {/* B-6 Spaced Repetition Quiz Modal */}
      {showQuizModal && (
        <QuizModal
          user={user}
          dueMistakes={dueMistakes}
          isOpen={showQuizModal}
          onClose={() => setShowQuizModal(false)}
          onFinished={() => {
            loadMistakes();
          }}
        />
      )}
    </div>
  );
};
