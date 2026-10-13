import React, { useState } from "react";
import { X, Save, Sliders, Cpu, Shield, RefreshCw } from "lucide-react";
import { PromptPlaceholders } from "../../data/promptCustomizer";
import { CURRENT_MODEL_CONFIG } from "../../config/models";
import { ALLOWED_USER_EMAIL } from "../../services/firebase/auth";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  placeholders: PromptPlaceholders;
  onSavePlaceholders: (updated: PromptPlaceholders) => Promise<void>;
  onResetProgressRequest: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  placeholders,
  onSavePlaceholders,
  onResetProgressRequest,
}) => {
  const [formData, setFormData] = useState<PromptPlaceholders>(placeholders);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<"prompts" | "models">("prompts");

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSavePlaceholders(formData);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-[#161D2A] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center">
              <Sliders className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">환경 설정 & 프롬프트 변수</h2>
              <p className="text-xs text-slate-400">튜터 프롬프트 슬롯 채우기 및 모델 구성</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-slate-800/80 text-slate-400 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 px-5 bg-slate-900/40">
          <button
            type="button"
            onClick={() => setActiveTab("prompts")}
            className={`py-3 px-3 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
              activeTab === "prompts"
                ? "border-amber-400 text-amber-300"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            프롬프트 변수 입력 (빈칸 채우기)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("models")}
            className={`py-3 px-3 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
              activeTab === "models"
                ? "border-amber-400 text-amber-300"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            연동 모델 및 보안 정보 (Part B-1)
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto flex-1">
          {activeTab === "prompts" ? (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/20 text-xs text-amber-300">
                원문 튜터 프롬프트는 그대로 보존되며, 아래 입력한 내용이 통화 시 프롬프트 내 대괄호 <code>[직무]</code>, <code>[Survey topics]</code> 등에 자동으로 주입됩니다.
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  1. 나의 직무 (공통 [직무])
                </label>
                <input
                  type="text"
                  value={formData.job}
                  onChange={(e) => setFormData({ ...formData, job: e.target.value })}
                  placeholder="예: 조선해양 생산관리 엔지니어"
                  className="w-full bg-[#121824] border border-slate-700 rounded-lg px-3.5 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-400"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  2. OPIc 서베이 선택 주제 ([Survey topics I chose])
                </label>
                <input
                  type="text"
                  value={formData.surveyTopics}
                  onChange={(e) => setFormData({ ...formData, surveyTopics: e.target.value })}
                  placeholder="예: watching movies, going to parks, domestic travel, overseas travel, jogging"
                  className="w-full bg-[#121824] border border-slate-700 rounded-lg px-3.5 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-400"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  3. 필리 조선소 실무 역할 ([My role in Philly])
                </label>
                <input
                  type="text"
                  value={formData.phillyRole}
                  onChange={(e) => setFormData({ ...formData, phillyRole: e.target.value })}
                  placeholder="예: production planning engineer / QA / procurement"
                  className="w-full bg-[#121824] border border-slate-700 rounded-lg px-3.5 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-400"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1">
                    OPIc 최근 취약점 (3줄 또는 none yet)
                  </label>
                  <textarea
                    rows={3}
                    value={formData.opicWeakPoints}
                    onChange={(e) => setFormData({ ...formData, opicWeakPoints: e.target.value })}
                    className="w-full bg-[#121824] border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-amber-400"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1">
                    Philly 비즈니스 최근 취약점
                  </label>
                  <textarea
                    rows={3}
                    value={formData.phillyWeakPoints}
                    onChange={(e) => setFormData({ ...formData, phillyWeakPoints: e.target.value })}
                    className="w-full bg-[#121824] border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-amber-400"
                  />
                </div>
              </div>

              <div className="pt-2 flex items-center justify-between border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onResetProgressRequest();
                  }}
                  className="text-xs text-slate-400 hover:text-amber-400 flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>목표별 진도 다시 설정하기</span>
                </button>

                <button
                  type="submit"
                  disabled={saving}
                  className="py-2.5 px-5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-xs flex items-center gap-1.5 cursor-pointer shadow-md shadow-amber-500/20"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{saving ? "저장 중..." : "설정 저장"}</span>
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-3">
                <div className="flex items-center gap-2 text-slate-200 text-xs font-bold">
                  <Cpu className="w-4 h-4 text-amber-400" />
                  <span>Part B-1 고정 모델 구성</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] font-mono">
                  <div className="p-2 rounded bg-slate-800/50">
                    <span className="text-slate-400 block text-[10px]">LIVE_MODEL (실시간 대화)</span>
                    <span className="text-emerald-400 font-bold">{CURRENT_MODEL_CONFIG.liveModel}</span>
                  </div>
                  <div className="p-2 rounded bg-slate-800/50">
                    <span className="text-slate-400 block text-[10px]">TEXT_MODEL (복기·대본·채점)</span>
                    <span className="text-cyan-400 font-bold">{CURRENT_MODEL_CONFIG.textModel}</span>
                  </div>
                  <div className="p-2 rounded bg-slate-800/50">
                    <span className="text-slate-400 block text-[10px]">STT_ENGINE (기록용 받아쓰기)</span>
                    <span className="text-purple-400 font-bold">
                      {CURRENT_MODEL_CONFIG.geminiSttModel} ({CURRENT_MODEL_CONFIG.geminiSttMode})
                    </span>
                  </div>
                  <div className="p-2 rounded bg-slate-800/50">
                    <span className="text-slate-400 block text-[10px]">TTS_ENGINE (강의 음성 합성)</span>
                    <span className="text-amber-400 font-bold">{CURRENT_MODEL_CONFIG.geminiTtsModel}</span>
                  </div>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-2 text-xs">
                <div className="flex items-center gap-2 text-slate-200 font-bold">
                  <Shield className="w-4 h-4 text-emerald-400" />
                  <span>보안 및 허용 계정 (B-1)</span>
                </div>
                <p className="text-slate-300 text-[11px]">
                  본 웹앱은 1인 전용으로 구성되어 있으며, 허용된 Google 계정 외 모든 로그인은 즉시 차단됩니다.
                </p>
                <div className="p-2 rounded bg-slate-800/50 text-[11px] font-mono text-emerald-300">
                  허용 계정: {ALLOWED_USER_EMAIL}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
