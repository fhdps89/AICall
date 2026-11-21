import React, { useState } from "react";
import { X, Loader2, Check } from "lucide-react";
import type { GoalData } from "../../services/firebase/db";
import { friendlyError } from "../common/friendlyError";

interface LessonChangeSheetProps {
  goal: GoalData;
  currentIndex: number;
  onConfirm: (lessonIndex: number) => Promise<void>;
  onClose: () => void;
}

export const LessonChangeSheet: React.FC<LessonChangeSheetProps> = ({
  goal,
  currentIndex,
  onConfirm,
  onClose,
}) => {
  const [selected, setSelected] = useState<number>(currentIndex);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const isUnchanged = selected === currentIndex;

  const handleConfirm = async () => {
    if (isUnchanged || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onConfirm(selected);
      onClose();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4"
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <div
        className="w-full sm:max-w-md bg-[#161D2A] border border-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-800 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-white">진도 바꾸기</h3>
            <p className="text-xs text-slate-400 truncate mt-0.5">
              {goal.title} · 현재 {currentIndex}과
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-50 transition-colors cursor-pointer"
            aria-label="취소"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Lesson List */}
        <div className="p-4 overflow-y-auto flex-1 space-y-1.5">
          {goal.lessons.map((lesson) => {
            const isSelected = selected === lesson.index;
            const isCurrent = lesson.index === currentIndex;

            return (
              <button
                key={lesson.index}
                type="button"
                disabled={saving}
                onClick={() => setSelected(lesson.index)}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl border text-xs flex items-center justify-between gap-2 transition-colors cursor-pointer disabled:opacity-60 ${
                  isSelected
                    ? "bg-amber-500/15 border-amber-500/50 text-white font-semibold"
                    : "bg-slate-900/50 border-slate-800/80 text-slate-300 hover:border-slate-700 hover:text-white"
                }`}
              >
                <span className="truncate">
                  {lesson.index}과. {lesson.title}
                </span>
                <span className="flex items-center gap-1.5 shrink-0">
                  {isCurrent && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                      현재
                    </span>
                  )}
                  {isSelected && <Check className="w-4 h-4 text-amber-400" />}
                </span>
              </button>
            );
          })}
        </div>

        {error && (
          <div className="px-4 pb-2 text-xs text-rose-300">
            {error}
          </div>
        )}

        {/* Footer Actions */}
        <div className="p-4 border-t border-slate-800 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 hover:text-white text-xs font-semibold transition-colors cursor-pointer"
          >
            취소
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isUnchanged || saving}
            className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 text-xs font-black flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <span>확인</span>
          </button>
        </div>
      </div>
    </div>
  );
};
