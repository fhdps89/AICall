import React from "react";
import { X, Check } from "lucide-react";
import {
  trackPickerSubtitle,
  type TrackOption,
  type TrackPickerMode,
} from "./trackOptions";

interface TrackPickerSheetProps {
  mode: TrackPickerMode;
  options: TrackOption[];
  isPlanReviewDay: boolean;
  reviewDaySelected: boolean;
  onSelect: (goalId: string | null) => void;
  onClose: () => void;
}

/**
 * 홈 오늘 수업 카드에서 수업 트랙을 바로 고르는 바텀시트.
 */
export const TrackPickerSheet: React.FC<TrackPickerSheetProps> = ({
  mode,
  options,
  isPlanReviewDay,
  reviewDaySelected,
  onSelect,
  onClose,
}) => {
  const handlePick = (goalId: string | null) => {
    onSelect(goalId);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md bg-[#161D2A] border border-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-800 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-white">트랙 고르기</h3>
            <p className="text-xs text-slate-400 truncate mt-0.5">
              {trackPickerSubtitle(mode)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
            aria-label="닫기"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Track List */}
        <div className="p-4 overflow-y-auto flex-1 space-y-2">
          {isPlanReviewDay && (
            <button
              type="button"
              onClick={() => handlePick(null)}
              className={`w-full text-left px-3.5 py-3 rounded-xl border flex items-center justify-between gap-3 transition-colors cursor-pointer ${
                reviewDaySelected
                  ? "bg-amber-500/15 border-amber-500/50 text-white"
                  : "bg-slate-900/50 border-slate-800/80 text-slate-300 hover:border-slate-700 hover:text-white"
              }`}
            >
              <div className="min-w-0">
                <div className="text-xs font-bold">주간 복기(오늘 루틴)</div>
                <div className="text-[11px] text-slate-400 mt-0.5">
                  실수 복습 · 오늘 강의 · 퀴즈
                </div>
              </div>
              {reviewDaySelected && <Check className="w-4 h-4 text-amber-400 shrink-0" />}
            </button>
          )}

          {options.map((option) => {
            const isDisabled = Boolean(option.disabledReason);

            return (
              <button
                key={option.id}
                type="button"
                disabled={isDisabled}
                onClick={() => {
                  if (isDisabled) return;
                  handlePick(option.isRoutine ? null : option.id);
                }}
                className={`w-full text-left px-3.5 py-3 rounded-xl border flex items-center justify-between gap-3 transition-colors ${
                  isDisabled
                    ? "bg-slate-900/30 border-slate-800/60 text-slate-500 opacity-55 cursor-not-allowed"
                    : option.isSelected
                    ? "bg-amber-500/15 border-amber-500/50 text-white cursor-pointer"
                    : "bg-slate-900/50 border-slate-800/80 text-slate-300 hover:border-slate-700 hover:text-white cursor-pointer"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold truncate">{option.title}</span>
                    {option.isRoutine && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-semibold shrink-0">
                        오늘 루틴
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400 truncate mt-0.5">
                    {option.disabledReason || option.nextLabel}
                  </div>
                </div>
                {option.isSelected && <Check className="w-4 h-4 text-amber-400 shrink-0" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
