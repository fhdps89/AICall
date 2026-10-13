import React, { useState } from "react";
import { GoalData } from "../../services/firebase/db";
import { Sparkles, ArrowRight, CheckCircle2 } from "lucide-react";

interface InitialProgressModalProps {
  goals: GoalData[];
  onSave: (updatedProgress: Record<string, number>) => Promise<void>;
}

export const InitialProgressModal: React.FC<InitialProgressModalProps> = ({
  goals,
  onSave,
}) => {
  // Default values: OPIc: 4 (1~3 already completed 10/10, 10/11, 10/12), Philly: 1, Travel: 1, Bluey: 1
  const [progressMap, setProgressMap] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const g of goals) {
      if (g.id === "opic") {
        init[g.id] = 4;
      } else {
        init[g.id] = g.nextLessonIndex || 1;
      }
    }
    return init;
  });

  const [saving, setSaving] = useState(false);

  const handleLessonChange = (goalId: string, lessonIndex: number) => {
    setProgressMap((prev) => ({
      ...prev,
      [goalId]: lessonIndex,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(progressMap);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-[#161D2A] border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="mb-6">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-semibold mb-3">
            <Sparkles className="w-3.5 h-3.5" />
            <span>최초 1회 진도 설정</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
            목표별 현재 진도를 설정해 주세요
          </h2>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            기존 진행 내역(OPIc 10/10 1과, 10/11 2과, 10/12 3과)을 반영해 다음 수업 과를 선택합니다.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto pr-1 space-y-4">
          {goals.map((goal) => {
            const currentSelected = progressMap[goal.id] ?? 1;
            const currentLesson = goal.lessons.find((l) => l.index === currentSelected);

            return (
              <div
                key={goal.id}
                className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white text-sm">{goal.title}</span>
                    <span className="text-[11px] text-slate-400 font-mono">
                      총 {goal.lessons.length}개 과
                    </span>
                  </div>
                  {goal.id === "opic" && (
                    <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      1~3과 완료 추천 (다음 4과)
                    </span>
                  )}
                </div>

                <p className="text-xs text-slate-400 mb-3">{goal.why}</p>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-slate-300 block">
                    다음에 진행할 과 선택:
                  </label>
                  <select
                    value={currentSelected}
                    onChange={(e) => handleLessonChange(goal.id, Number(e.target.value))}
                    className="w-full bg-[#121824] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-400"
                  >
                    {goal.lessons.map((lesson) => (
                      <option key={lesson.index} value={lesson.index}>
                        {lesson.index}과: {lesson.title}
                      </option>
                    ))}
                  </select>
                </div>

                {currentLesson && (
                  <div className="mt-2.5 p-2 rounded-lg bg-slate-800/40 border border-slate-700/50 text-[11px] text-slate-300 flex items-start gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                    <span>
                      선택된 시작 과: <strong className="text-amber-300 font-medium">{currentLesson.index}과. {currentLesson.title}</strong>
                    </span>
                  </div>
                )}
              </div>
            );
          })}

          <div className="pt-4">
            <button
              type="submit"
              disabled={saving}
              className="w-full py-3.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-sm transition-all shadow-lg shadow-amber-500/20 flex items-center justify-center gap-2 cursor-pointer"
            >
              {saving ? (
                <div className="w-5 h-5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <span>진도 저장 및 수업 시작하기</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
