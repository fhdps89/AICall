import React, { useState, useEffect } from "react";
import {
  X,
  Save,
  Sliders,
  Cpu,
  Shield,
  RefreshCw,
  FileAudio,
  Play,
  HardDrive,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { PromptPlaceholders } from "../../data/promptCustomizer";
import { CURRENT_MODEL_CONFIG } from "../../config/models";
import { collection, getDocs, query, orderBy, limit } from "firebase/firestore";
import { db } from "../../services/firebase/config";
import { SessionData } from "../../services/firebase/db";
import { getAllPendingChunks, LocalRecordingChunk } from "../../services/recording/chunkIndexedDb";
import { ALLOWED_USER_EMAIL } from "../../services/firebase/auth";
import { FeedSettingsPanel } from "./FeedSettingsPanel";

interface SettingsModalProps {
  userId?: string;
  isOpen: boolean;
  onClose: () => void;
  placeholders: PromptPlaceholders;
  onSavePlaceholders: (updated: PromptPlaceholders) => Promise<void>;
  onResetProgressRequest: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  userId,
  isOpen,
  onClose,
  placeholders,
  onSavePlaceholders,
  onResetProgressRequest,
}) => {
  const [formData, setFormData] = useState<PromptPlaceholders>(placeholders);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<"prompts" | "models" | "recordings" | "feed">("prompts");
  const [enablePartialStt, setEnablePartialStt] = useState<boolean>(() => {
    return localStorage.getItem("onecall_enable_partial_transcribe") !== "false";
  });
  const [sessionsList, setSessionsList] = useState<SessionData[]>([]);
  const [pendingLocalChunks, setPendingLocalChunks] = useState<LocalRecordingChunk[]>([]);
  const [loadingRecordings, setLoadingRecordings] = useState(false);

  if (!isOpen) return null;

  // Fetch recordings when tab opened
  useEffect(() => {
    if (activeTab === "recordings" && userId) {
      setLoadingRecordings(true);
      Promise.all([
        (async () => {
          try {
            const snap = await getDocs(
              query(
                collection(db, "users", userId, "sessions"),
                orderBy("startedAt", "desc"),
                limit(10)
              )
            );
            return snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
          } catch {
            return [];
          }
        })(),
        getAllPendingChunks(),
      ])
        .then(([sess, pending]) => {
          setSessionsList(sess);
          setPendingLocalChunks(pending);
        })
        .finally(() => setLoadingRecordings(false));
    }
  }, [activeTab, userId]);

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
          <button
            type="button"
            onClick={() => setActiveTab("recordings")}
            className={`py-3 px-3 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
              activeTab === "recordings"
                ? "border-amber-400 text-amber-300"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            녹음 보관함 (Storage Chunks)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("feed")}
            className={`py-3 px-3 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
              activeTab === "feed"
                ? "border-amber-400 text-amber-300"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            그록봇 피드 (B-8)
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto flex-1">
          {activeTab === "feed" ? (
            <FeedSettingsPanel userId={userId} />
          ) : activeTab === "prompts" ? (
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
          ) : activeTab === "models" ? (
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

              {/* B-3 Requirement 2 Toggle: 1-minute partial transcribe */}
              <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-2.5 text-xs">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-bold text-slate-200 block">통화 중 1분 단위 임시 받아쓰기</span>
                    <span className="text-[11px] text-slate-400 font-mono text-purple-300">gemini-3.5-transcribe VERBATIM (B-3)</span>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={enablePartialStt}
                      onChange={(e) => {
                        const val = e.target.checked;
                        setEnablePartialStt(val);
                        localStorage.setItem("onecall_enable_partial_transcribe", String(val));
                      }}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-500"></div>
                  </label>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  10초 녹음 조각이 약 1분(6조각) 쌓일 때마다 백그라운드에서 별도로 받아써서 sessions.sttPartial에 저장합니다. 대화와 독립적으로 작동하며 필요 시 끌 수 있습니다.
                </p>
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
          ) : (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-slate-200 text-xs font-bold">
                    <FileAudio className="w-4 h-4 text-emerald-400" />
                    <span>B-3 10초 분할 녹음 파일 (Cloud Storage & IndexedDB)</span>
                  </div>
                  <span className="text-[11px] text-slate-400 font-mono">
                    최근 {sessionsList.length}개 세션 보존됨
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  통화 중 마이크 소리가 10초 단위로 나뉘어 IndexedDB에 임시 기록된 후, 즉시 Cloud Storage로 업로드됩니다.
                </p>
                {pendingLocalChunks.length > 0 && (
                  <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
                    <span>업로드 대기 중인 로컬 조각: {pendingLocalChunks.length}개</span>
                  </div>
                )}
              </div>

              {loadingRecordings ? (
                <div className="text-center py-8 text-xs text-slate-400">녹음 기록을 불러오는 중...</div>
              ) : sessionsList.length === 0 ? (
                <div className="text-center py-8 text-xs text-slate-500 bg-slate-900/30 rounded-xl border border-slate-800">
                  아직 기록된 통화 세션이 없습니다. 홈에서 통화를 시작하면 10초 조각들이 이곳에 보존됩니다.
                </div>
              ) : (
                <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
                  {sessionsList.map((sess) => (
                    <div key={sess.id} className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-amber-300 font-mono">
                          {sess.goalId?.toUpperCase()} · {sess.lessonIndex}과
                        </span>
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            sess.status === "done"
                              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                              : sess.status === "pending_review"
                              ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                              : "bg-sky-500/20 text-sky-300 border border-sky-500/30"
                          }`}>
                            {sess.status === "done" ? "완료됨" : sess.status === "pending_review" ? "복기 대기" : "진행 중"}
                          </span>
                          <span className="text-slate-400 text-[10px] font-mono">
                            {sess.startedAt ? new Date(sess.startedAt).toLocaleTimeString() : ""}
                          </span>
                        </div>
                      </div>

                      {/* Chunks summary */}
                      <div className="text-[11px] text-slate-300 flex items-center justify-between">
                        <span>10초 녹음 조각: <strong>{sess.recordingChunks?.length || 0}개</strong></span>
                        <span>1분 전사: <strong>{sess.sttPartial?.length || 0}건</strong></span>
                        <span className="text-slate-400 font-mono text-[10px]">{sess.connectionPath || "direct"}</span>
                      </div>

                      {/* Chunks list details */}
                      {sess.recordingChunks && sess.recordingChunks.length > 0 && (
                        <div className="pt-1.5 border-t border-slate-800 space-y-1">
                          <span className="text-[10px] text-slate-400 block font-semibold">최근 녹음 조각 목록:</span>
                          <div className="space-y-1 max-h-28 overflow-y-auto">
                            {sess.recordingChunks.map((chunk, cIdx) => (
                              <div key={cIdx} className="flex items-center justify-between text-[10px] bg-slate-800/40 px-2 py-1 rounded">
                                <span className="font-mono text-slate-300">
                                  #{chunk.index} ({chunk.durationSeconds || 10}초)
                                </span>
                                <span className="truncate max-w-[180px] text-slate-400 font-mono">
                                  {chunk.path}
                                </span>
                                <span className="text-emerald-400 font-bold">
                                  {chunk.uploaded ? "업로드 완료" : "로컬 대기"}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* sttPartial preview */}
                      {sess.sttPartial && sess.sttPartial.length > 0 && (
                        <div className="pt-1.5 border-t border-slate-800 text-[10px] text-purple-300">
                          <span className="font-bold text-purple-400 block mb-0.5">1분 단위 전사 (gemini-3.5-transcribe):</span>
                          {sess.sttPartial.map((stt, sIdx) => (
                            <div key={sIdx} className="bg-purple-950/20 border border-purple-800/30 p-1.5 rounded mb-1">
                              <span className="font-mono text-[9px] text-purple-400 mr-1.5">[{stt.timeRange}]</span>
                              <span>{stt.transcript}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
