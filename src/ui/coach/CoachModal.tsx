import React, { useState, useEffect, useRef } from "react";
import { friendlyError } from "../common/friendlyError";
import {
  X,
  Send,
  Sparkles,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Clock,
  Calendar,
  Brain,
  Trash2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Layers,
} from "lucide-react";
import {
  GoalData,
  UserPlanData,
  PlanChangeData,
  CoachMemoryData,
  CoachMessageData,
  getUserPlan,
  getUserGoals,
  getPlanChanges,
  createPlanChange,
  applyPlanChange,
  revertPlanChange,
  rejectPlanChange,
  getCoachMemory,
  saveCoachMemory,
  removeCoachMemoryItem,
  getCoachMessages,
  saveCoachMessage,
  MistakeData,
  getUserMistakes,
  getDueMistakes,
} from "../../services/firebase/db";
import { authFetch } from "../../services/api/authFetch";
import { sanitizePlanChangeAfter, isEmptyPlanChange, normalizeLessonsPerCall } from "../../data/planValidation";
import { isQaMode } from "../../data/qaMode";
import {
  canApplyPendingProposal,
  resolveQaProgressQuickReply,
  selectQuickReplyTarget,
} from "../../data/coachProposalGate";
import { loadDailyOverride } from "../home/dailyTrackOverride";
import {
  QA_PREVIEW_HINT,
  buildProgressCardView,
  classifyQuickReply,
  describeUndoOffer,
  formatAppliedProgressReply,
  isProgressChange,
  isStaleProgressChange,
  kstTodayStr,
  pickUndoTarget,
  progressReplyForDisplay,
  proposalQaPreview,
  qaBlocksPlanChange,
  sanitizeCoachInfoCard,
  type CoachInfoCard,
  type UndoRestoreEntry,
} from "../../data/progressAdjust";

const DAY_LABELS: Record<string, string> = {
  mon: "월",
  tue: "화",
  wed: "수",
  thu: "목",
  fri: "금",
  sat: "토",
  sun: "일",
};

interface CoachModalProps {
  userId: string;
  isOpen: boolean;
  onClose: () => void;
  goals: GoalData[];
  onPlanUpdated: () => Promise<void>;
}

export const CoachModal: React.FC<CoachModalProps> = ({
  userId,
  isOpen,
  onClose,
  goals,
  onPlanUpdated,
}) => {
  const [activeTab, setActiveTab] = useState<"chat" | "history" | "memory">("chat");
  const [messages, setMessages] = useState<CoachMessageData[]>([]);
  const [inputText, setInputText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [plan, setPlan] = useState<UserPlanData | null>(null);
  const [planChanges, setPlanChanges] = useState<PlanChangeData[]>([]);
  const [memory, setMemory] = useState<CoachMemoryData>({
    constraints: [],
    preferences: [],
    weakPoints: [],
    updatedAt: "",
  });
  const [expandedChangeId, setExpandedChangeId] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [undoOffer, setUndoOffer] = useState<{
    changeId: string;
    restore: Record<string, UndoRestoreEntry>;
  } | null>(null);
  const [undoLoading, setUndoLoading] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sessionChangeIdsRef = useRef<Set<string>>(new Set());

  const loadData = async () => {
    if (!userId) return;
    setUndoOffer(null);
    sessionChangeIdsRef.current.clear();
    try {
      const [p, changes, mem, msgs] = await Promise.all([
        getUserPlan(userId),
        getPlanChanges(userId),
        getCoachMemory(userId),
        getCoachMessages(userId),
      ]);
      setPlan(p);
      setPlanChanges(changes);
      setMemory(mem);

      if (msgs.length === 0) {
        // Initial welcome message
        const initialMsg: CoachMessageData = {
          id: "welcome",
          role: "coach",
          text:
            "안녕하세요 찬식님! 전담 영어 학습 코치입니다. 출장, 시험 일정, 바쁜 요일 등 학습 패턴 변경이나 목표 조정이 필요하시면 언제든 말씀해 주세요." +
            "\n\n진도도 말로 바꿀 수 있어요. 예: 「시험이 얼마 안 남아서 OPIc 이틀치씩 땡겨줘」, 「OPIc 한 번만 2과 건너뛰어 줘」, 「원래 속도로」, 「여행은 5과부터 할래」, 「방금 거 되돌려줘」",
          at: new Date().toISOString(),
        };
        setMessages([initialMsg]);
      } else {
        setMessages(msgs);
      }
    } catch (err) {
      console.warn("[CoachModal] Load data error:", err);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadData();
    }
  }, [isOpen, userId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  if (!isOpen) return null;

  const appendAndSaveCoachMessage = async (
    text: string,
    opts?: { planChangeId?: string; planChange?: PlanChangeData; infoCard?: CoachInfoCard }
  ) => {
    const coachMsg: CoachMessageData = {
      id: `coach-${Date.now()}`,
      role: "coach",
      text,
      at: new Date().toISOString(),
      planChangeId: opts?.planChangeId,
      planChange: opts?.planChange,
      infoCard: opts?.infoCard,
    };
    await saveCoachMessage(userId, {
      role: "coach",
      text: coachMsg.text,
      at: coachMsg.at,
      ...(opts?.planChangeId ? { planChangeId: opts.planChangeId } : {}),
      ...(opts?.infoCard ? { infoCard: opts.infoCard } : {}),
    }).catch(() => {});
    setMessages((prev) => [...prev, coachMsg]);
  };

  const runLocalUndoFlow = async (fallbackText?: string): Promise<string> => {
    const [latestChanges, liveGoals] = await Promise.all([
      getPlanChanges(userId),
      getUserGoals(userId),
    ]);
    setPlanChanges(latestChanges);
    const pick = pickUndoTarget(latestChanges, liveGoals);
    if (!pick.ok) {
      setUndoOffer(null);
      return pick.reply;
    }
    setUndoOffer({ changeId: pick.changeId, restore: pick.restore });
    return fallbackText || "방금 바꾼 진도를 되돌릴까요? 아래 카드에서 확인해 주세요.";
  };

  const formatAppliedReply = (change: PlanChangeData): string =>
    formatAppliedProgressReply(change, {
      goals,
      weeklyPattern: plan?.weeklyPattern,
      todayKst: kstTodayStr(),
    });

  const handleSendMessage = async (customPrompt?: string) => {
    const textToSend = (customPrompt || inputText).trim();
    if (!textToSend || isLoading) return;

    setInputText("");
    const userMsg: CoachMessageData = {
      id: `temp-${Date.now()}`,
      role: "user",
      text: textToSend,
      at: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    try {
      // 1. Save user message
      await saveCoachMessage(userId, {
        role: "user",
        text: textToSend,
        at: userMsg.at,
      }).catch(() => {});

      // 1-a. Quick reply check before calling LLM
      const qaQuick = resolveQaProgressQuickReply(
        classifyQuickReply(textToSend, { hasPending: true }),
        planChanges,
        {
          nowMs: Date.now(),
          sessionChangeIds: sessionChangeIdsRef.current,
        }
      );
      if (qaQuick.kind === "reply") {
        for (const id of qaQuick.closeChangeIds) {
          await handleRejectChange(id);
        }
        await appendAndSaveCoachMessage(qaQuick.text);
        return;
      }

      const quickTarget = selectQuickReplyTarget(planChanges, {
        nowMs: Date.now(),
        sessionChangeIds: sessionChangeIdsRef.current,
      });
      const quick = classifyQuickReply(textToSend, { hasPending: quickTarget.kind !== "none" });

      if (quick === "approve" || quick === "reject") {
        if (quickTarget.kind === "expired") {
          await appendAndSaveCoachMessage("이 제안은 10분이 지나 만료됐어요. 코치에게 다시 요청해 주세요.");
          return;
        }
        if (quickTarget.kind === "many") {
          await appendAndSaveCoachMessage("대기 중인 제안이 여러 개 있어요. 카드의 버튼으로 골라 주세요.");
          return;
        }
        if (quickTarget.kind === "one") {
          const target = quickTarget.change;
          if (quick === "approve") {
            const resApply = await handleApplyChange(target.id, { viaQuickReply: true });
            if (resApply.ok) {
              await appendAndSaveCoachMessage(formatAppliedReply(target));
            } else if (resApply.reason) {
              await appendAndSaveCoachMessage(resApply.reason);
            }
          } else {
            await handleRejectChange(target.id);
            await appendAndSaveCoachMessage("제안을 거절했어요. 기존 진도와 일정은 그대로 유지됩니다.");
          }
          return;
        }
      }

      if (quick === "undo") {
        const undoReply = await runLocalUndoFlow();
        await appendAndSaveCoachMessage(undoReply);
        return;
      }

      // 2. Fetch stats for coach context
      const [allM, dueM] = await Promise.all([
        getUserMistakes(userId).catch(() => [] as MistakeData[]),
        getDueMistakes(userId).catch(() => [] as MistakeData[]),
      ]);

      const mistakeStats = {
        reviewing: allM.filter((m) => m.status === "reviewing").length,
        graduated: allM.filter((m) => m.status === "graduated").length,
        dueToday: dueM.length,
      };

      // 3. Call server /api/coach/chat
      let todayGoalId: string | undefined;
      try {
        todayGoalId =
          loadDailyOverride(
            window.localStorage,
            userId,
            Date.now(),
            goals.map((g) => g.id)
          ) ?? undefined;
      } catch {
        todayGoalId = undefined;
      }

      const res = await authFetch("/api/coach/chat", {
        method: "POST",
        body: JSON.stringify({
          text: textToSend,
          plan,
          goals,
          mistakeStats,
          memory,
          history: messages.slice(-6).map((m) => ({ role: m.role, text: m.text })),
          todayGoalId,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "코치 응답 생성에 실패했습니다.");
      }

      let planChangeId: string | undefined = undefined;
      let createdChange: PlanChangeData | undefined = undefined;
      let qaPreview = false;

      // 4. If coach proposed a plan change, validate it before saving/showing
      const safeAfter = data.proposal ? sanitizePlanChangeAfter(data.proposal.after, goals) : null;
      if (data.proposal && safeAfter && !isEmptyPlanChange(safeAfter)) {
        qaPreview = proposalQaPreview(safeAfter, isQaMode());
        const changePayload: Omit<PlanChangeData, "id"> = {
          requestedText: textToSend,
          summary: data.proposal.summary || "학습 일정 변경 제안",
          before: data.proposal.before || {},
          after: safeAfter as PlanChangeData["after"],
          status: "proposed" as const,
          at: new Date().toISOString(),
          ...(qaPreview ? { qaPreview: true } : {}),
        };

        planChangeId = await createPlanChange(userId, changePayload);
        sessionChangeIdsRef.current.add(planChangeId);
        createdChange = {
          ...changePayload,
          id: planChangeId,
        };

        // Refresh planChanges list
        const updatedChanges = await getPlanChanges(userId);
        setPlanChanges(updatedChanges);
      }

      // If memory patch provided, update coachMemory
      if (data.proposal?.memoryPatch) {
        const mp = data.proposal.memoryPatch;
        const strList = (v: unknown): string[] =>
          Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
        const newMem: CoachMemoryData = {
          constraints: Array.from(new Set([...(memory.constraints || []), ...strList(mp.constraints)])),
          preferences: Array.from(new Set([...(memory.preferences || []), ...strList(mp.preferences)])),
          weakPoints: Array.from(new Set([...(memory.weakPoints || []), ...strList(mp.weakPoints)])),
          updatedAt: new Date().toISOString(),
        };
        await saveCoachMemory(userId, newMem).catch(() => {});
        setMemory(newMem);
      }

      let replyText = progressReplyForDisplay(data.reply || "네, 확인했습니다.", { qaPreview });
      if (data.progress?.type === "undo_request") {
        replyText = await runLocalUndoFlow(data.reply);
      }
      const infoCard =
        data.progress?.type === "info"
          ? sanitizeCoachInfoCard(data.progress.card) ?? undefined
          : undefined;

      // 5. Save coach message
      await appendAndSaveCoachMessage(replyText, {
        planChangeId,
        planChange: createdChange,
        infoCard,
      });
    } catch (err: any) {
      console.error("[CoachModal] Send error:", err);
      const errorMsg: CoachMessageData = {
        id: `err-${Date.now()}`,
        role: "coach",
        text: `죄송합니다. 오류가 발생했습니다: ${friendlyError(err, "다시 시도해 주세요.")}`,
        at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  const findChangeById = (changeId: string): PlanChangeData | undefined => {
    return (
      planChanges.find((c) => c.id === changeId) ||
      messages.find((m) => m.planChange?.id === changeId)?.planChange
    );
  };

  const handleApplyChange = async (
    changeId: string,
    opts?: { viaQuickReply?: boolean }
  ): Promise<{ ok: boolean; reason?: string }> => {
    const targetChange = findChangeById(changeId);
    if (targetChange && qaBlocksPlanChange(targetChange.after, isQaMode())) {
      const msg = "QA 모드에서는 실제 진도를 바꾸지 않습니다.";
      alert(msg);
      return { ok: false, reason: msg };
    }

    if (targetChange) {
      const gate = canApplyPendingProposal(targetChange, {
        nowMs: Date.now(),
        sessionChangeIds: sessionChangeIdsRef.current,
        viaQuickReply: opts?.viaQuickReply ?? false,
      });
      if (!gate.ok) {
        alert(gate.reply);
        return { ok: false, reason: gate.reply };
      }
    }

    setActionLoadingId(changeId);
    try {
      if (targetChange && isProgressChange(targetChange.after)) {
        const liveGoals = await getUserGoals(userId);
        if (isStaleProgressChange(targetChange, liveGoals)) {
          const changedGoalId = Object.entries(targetChange.after?.goals || {}).find(
            ([, patch]) =>
              typeof patch?.nextLessonIndex === "number" ||
              typeof patch?.lessonsPerCall === "number"
          )?.[0];
          const changedPatch = changedGoalId ? targetChange.after?.goals?.[changedGoalId] : undefined;
          const liveGoal = changedGoalId ? liveGoals.find((g) => g.id === changedGoalId) : undefined;
          const msg =
            typeof changedPatch?.nextLessonIndex === "number" && typeof liveGoal?.nextLessonIndex === "number"
              ? `그 사이 진도가 ${liveGoal.nextLessonIndex}과로 바뀌었어요. 다시 요청해 주세요.`
              : "그 사이 진도 설정이 바뀌었어요. 다시 요청해 주세요.";
          alert(msg);
          return { ok: false, reason: msg };
        }
      }

      await applyPlanChange(userId, changeId);
      // Refresh local states
      const [updatedPlan, updatedChanges] = await Promise.all([
        getUserPlan(userId),
        getPlanChanges(userId),
      ]);
      setPlan(updatedPlan);
      setPlanChanges(updatedChanges);

      // Update message cards in chat view
      setMessages((prev) =>
        prev.map((m) =>
          m.planChangeId === changeId && m.planChange
            ? { ...m, planChange: { ...m.planChange, status: "approved" } }
            : m
        )
      );

      // Trigger app-wide plan & goals refresh
      await onPlanUpdated();
      return { ok: true };
    } catch (err: any) {
      const errMsg = friendlyError(err);
      alert(`적용 오류: ${errMsg}`);
      return { ok: false, reason: errMsg };
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleRejectChange = async (changeId: string) => {
    setActionLoadingId(changeId);
    try {
      await rejectPlanChange(userId, changeId);
      const updatedChanges = await getPlanChanges(userId);
      setPlanChanges(updatedChanges);

      setMessages((prev) =>
        prev.map((m) =>
          m.planChangeId === changeId && m.planChange
            ? { ...m, planChange: { ...m.planChange, status: "rejected" } }
            : m
        )
      );
    } catch (err: any) {
      alert(`거절 처리 오류: ${friendlyError(err)}`);
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleRevertChange = async (changeId: string) => {
    const targetChange = findChangeById(changeId);
    if (targetChange && isProgressChange(targetChange.after)) {
      if (qaBlocksPlanChange(targetChange.after, isQaMode())) {
        alert("QA 모드에서는 실제 진도를 바꾸지 않습니다.");
        return;
      }
      const liveGoals = await getUserGoals(userId);
      for (const [gid, patch] of Object.entries(targetChange.after?.goals || {})) {
        const live = liveGoals.find((g) => g.id === gid);
        if (typeof patch?.nextLessonIndex === "number") {
          if (!live || live.nextLessonIndex !== patch.nextLessonIndex) {
            alert("그 뒤로 수업을 하셔서 되돌리면 진도가 뒤로 가요. 진도 바꾸기로 직접 지정해 주세요.");
            return;
          }
        }
        if (typeof patch?.lessonsPerCall === "number") {
          if (!live || normalizeLessonsPerCall(live.lessonsPerCall) !== patch.lessonsPerCall) {
            alert("그 뒤로 설정이 바뀌어 되돌릴 수 없어요. 코치에게 다시 요청해 주세요.");
            return;
          }
        }
      }
    }

    if (!confirm("이 변경을 되돌리고 이전 상태로 복구하시겠습니까?")) return;
    setActionLoadingId(changeId);
    try {
      await revertPlanChange(userId, changeId);
      const [updatedPlan, updatedChanges] = await Promise.all([
        getUserPlan(userId),
        getPlanChanges(userId),
      ]);
      setPlan(updatedPlan);
      setPlanChanges(updatedChanges);
      await onPlanUpdated();
    } catch (err: any) {
      alert(`되돌리기 오류: ${friendlyError(err)}`);
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleConfirmUndoOffer = async () => {
    if (!undoOffer || undoLoading) return;
    if (isQaMode()) {
      alert("QA 모드에서는 실제 진도를 바꾸지 않습니다.");
      setUndoOffer(null);
      return;
    }

    setUndoLoading(true);
    try {
      const [latestChanges, liveGoals] = await Promise.all([
        getPlanChanges(userId),
        getUserGoals(userId),
      ]);
      const pick = pickUndoTarget(latestChanges, liveGoals);
      if (!pick.ok || pick.changeId !== undoOffer.changeId) {
        const msg = !pick.ok ? pick.reply : "되돌릴 대상을 다시 확인해 주세요.";
        setUndoOffer(null);
        await appendAndSaveCoachMessage(msg);
        return;
      }

      await revertPlanChange(userId, undoOffer.changeId);
      const [updatedPlan, updatedChanges] = await Promise.all([
        getUserPlan(userId),
        getPlanChanges(userId),
      ]);
      setPlan(updatedPlan);
      setPlanChanges(updatedChanges);
      setUndoOffer(null);
      await onPlanUpdated();
      await appendAndSaveCoachMessage("진도를 이전 상태로 되돌렸어요. 구글 캘린더는 바뀌지 않습니다.");
    } catch (err: any) {
      alert(`되돌리기 오류: ${friendlyError(err)}`);
    } finally {
      setUndoLoading(false);
    }
  };

  const handleRemoveMemory = async (
    category: "constraints" | "preferences" | "weakPoints",
    item: string
  ) => {
    try {
      await removeCoachMemoryItem(userId, category, item);
      setMemory((prev) => ({
        ...prev,
        [category]: (prev[category] || []).filter((i) => i !== item),
      }));
    } catch (err: any) {
      alert(`기억 삭제 실패: ${friendlyError(err)}`);
    }
  };

  const pendingCount = planChanges.filter((c) => !c.qaPreview && c.status === "proposed").length;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5">
      <div className="w-full max-w-2xl bg-[#161D2A] border border-slate-800 rounded-3xl shadow-2xl flex flex-col h-[92vh] max-h-[820px] overflow-hidden">
        {/* Header */}
        <header className="p-4 sm:p-5 border-b border-slate-800 bg-[#1A2232] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center font-bold shadow-md">
              <Sparkles className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm sm:text-base font-bold text-white tracking-tight">
                  AI 전담 학습 코치
                </h2>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/30 font-medium">
                  찬식님 1:1 맞춤
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5">
                계획 조율 및 일정 맞춤 제안 (승인 시에만 반영)
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="닫기"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center transition cursor-pointer"
          >
            <X size={18} />
          </button>
        </header>

        {/* Tab Switcher */}
        <div className="flex border-b border-slate-800 bg-[#161D2A] text-xs font-semibold px-4 pt-1">
          <button
            onClick={() => setActiveTab("chat")}
            className={`py-3 px-3 border-b-2 transition flex items-center gap-1.5 cursor-pointer ${
              activeTab === "chat"
                ? "border-amber-400 text-amber-300"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <span>💬 코치 대화</span>
          </button>

          <button
            onClick={() => setActiveTab("history")}
            className={`py-3 px-3 border-b-2 transition flex items-center gap-1.5 cursor-pointer ${
              activeTab === "history"
                ? "border-amber-400 text-amber-300"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <span>📜 변경 이력</span>
            {pendingCount > 0 && (
              <span className="w-4 h-4 rounded-full bg-amber-500 text-slate-950 text-[10px] font-black flex items-center justify-center">
                {pendingCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab("memory")}
            className={`py-3 px-3 border-b-2 transition flex items-center gap-1.5 cursor-pointer ${
              activeTab === "memory"
                ? "border-amber-400 text-amber-300"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <Brain size={13} />
            <span>코치가 기억하는 것</span>
            <span className="text-[10px] text-slate-500">
              ({(memory.constraints?.length || 0) + (memory.preferences?.length || 0) + (memory.weakPoints?.length || 0)})
            </span>
          </button>
        </div>

        {/* Main Tab Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          {activeTab === "chat" && (
            <div className="space-y-4">
              {messages.map((m) => {
                const linkedChange = m.planChange || (m.planChangeId ? planChanges.find((c) => c.id === m.planChangeId) : null);
                return (
                  <div
                    key={m.id}
                    className={`flex flex-col ${
                      m.role === "user" ? "items-end" : "items-start"
                    }`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-3 text-xs leading-relaxed shadow-md ${
                        m.role === "user"
                          ? "bg-amber-500/20 border border-amber-500/40 text-amber-100 rounded-tr-none"
                          : "bg-[#1E2738] border border-slate-700/60 text-slate-200 rounded-tl-none"
                      }`}
                    >
                      <span className="text-[10px] font-bold block mb-1 opacity-60 uppercase tracking-wider">
                        {m.role === "user" ? "찬식님" : "AI 코치"}
                      </span>
                      <p className="whitespace-pre-wrap">{m.text}</p>
                    </div>

                    {/* Linked Plan Change Card */}
                    {linkedChange && (() => {
                      const progressCard = isProgressChange(linkedChange.after);
                      const cardView = progressCard
                        ? buildProgressCardView(linkedChange, {
                            goals,
                            weeklyPattern: plan?.weeklyPattern,
                            todayKst: kstTodayStr(),
                          })
                        : null;
                      const previewOnly = Boolean(linkedChange.qaPreview);
                      const qaBlocked = qaBlocksPlanChange(linkedChange.after, isQaMode());
                      const gateState =
                        linkedChange.status === "proposed"
                          ? canApplyPendingProposal(linkedChange, {
                              nowMs: Date.now(),
                              sessionChangeIds: sessionChangeIdsRef.current,
                              viaQuickReply: false,
                            })
                          : null;
                      const isExpired = Boolean(gateState && !gateState.ok && gateState.reason === "expired");
                      const approveLabel = cardView ? cardView.approveLabel : "승인 (적용하기)";

                      return (
                      <div className="w-full max-w-[92%] mt-2.5 p-4 rounded-2xl bg-[#131A26] border border-amber-500/40 shadow-xl space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <Sparkles className="w-4 h-4 text-amber-400" />
                            <span className="text-xs font-bold text-amber-300">
                              {cardView ? cardView.title : "📋 계획 변경 제안"}
                            </span>
                          </div>
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                              previewOnly
                                ? linkedChange.status === "proposed"
                                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                                  : "bg-slate-800 text-slate-400 border border-slate-700"
                                : linkedChange.status === "approved"
                                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                                : linkedChange.status === "rejected"
                                ? "bg-slate-800 text-slate-400 border border-slate-700"
                                : linkedChange.status === "reverted"
                                ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
                                : isExpired
                                ? "bg-slate-800 text-slate-400 border border-slate-700"
                                : "bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse"
                            }`}
                          >
                            {previewOnly
                              ? linkedChange.status === "proposed"
                                ? "QA 미리보기"
                                : "미리보기 닫힘"
                              : linkedChange.status === "approved"
                              ? "✅ 승인됨"
                              : linkedChange.status === "rejected"
                              ? "거절됨"
                              : linkedChange.status === "reverted"
                              ? "되돌려짐"
                              : isExpired
                              ? "만료"
                              : "승인 대기"}
                          </span>
                        </div>

                        <p className="text-xs font-semibold text-white">
                          {linkedChange.summary}
                        </p>

                        {/* Before vs After detail box */}
                        <div className="grid grid-cols-2 gap-2 text-[11px] p-2.5 rounded-xl bg-slate-900/60 border border-slate-800">
                          <div>
                            <span className="text-[10px] font-bold text-slate-400 block mb-1">
                              [현재 상태]
                            </span>
                            <div className="space-y-0.5 text-slate-300">
                              {cardView ? (
                                cardView.beforeLines.map((line, i) => (
                                  <p key={i} className="truncate">
                                    {line}
                                  </p>
                                ))
                              ) : (
                                <>
                                  {linkedChange.before?.plan?.weeklyPattern && (
                                    <p className="truncate">
                                      루틴: {Object.entries(linkedChange.before.plan.weeklyPattern)
                                        .filter(([_, v]) => Array.isArray(v) && v.length > 0)
                                        .map(([k, v]) => `${DAY_LABELS[k] || k}:${v[0]}`)
                                        .join(", ")}
                                    </p>
                                  )}
                                  {linkedChange.before?.goals &&
                                    Object.entries(linkedChange.before.goals).map(([gid, g]: [string, any]) => (
                                      <p key={gid} className="truncate">
                                        {gid}: {g.deadline ? `시험 ${g.deadline.slice(5)}` : `${g.nextLessonIndex || 1}과`}
                                      </p>
                                    ))}
                                </>
                              )}
                            </div>
                          </div>

                          <div className="border-l border-slate-800 pl-2">
                            <span className="text-[10px] font-bold text-amber-400 block mb-1">
                              [제안 변경안]
                            </span>
                            <div className="space-y-0.5 text-amber-200">
                              {cardView ? (
                                cardView.afterLines.map((line, i) => (
                                  <p key={i} className="truncate font-medium">
                                    {line}
                                  </p>
                                ))
                              ) : (
                                <>
                                  {linkedChange.after?.plan?.weeklyPattern && (
                                    <p className="truncate">
                                      루틴: {Object.entries(linkedChange.after.plan.weeklyPattern)
                                        .filter(([_, v]) => Array.isArray(v) && v.length > 0)
                                        .map(([k, v]) => `${DAY_LABELS[k] || k}:${v[0]}`)
                                        .join(", ")}
                                    </p>
                                  )}
                                  {linkedChange.after?.goals &&
                                    Object.entries(linkedChange.after.goals).map(([gid, g]: [string, any]) => (
                                      <p key={gid} className="truncate font-medium">
                                        {gid}: {g.deadline ? `시험일 ${g.deadline}` : g.status ? `상태 ${g.status}` : `${g.nextLessonIndex}과`}
                                      </p>
                                    ))}
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        {cardView && cardView.detailLines.length > 0 && (
                          <ul className="space-y-1 text-[11px] text-slate-300 bg-slate-900/40 rounded-xl px-3 py-2 border border-slate-800/80">
                            {cardView.detailLines.map((line, i) => (
                              <li key={i}>• {line}</li>
                            ))}
                          </ul>
                        )}

                        {/* Action buttons if status === 'proposed' */}
                        {previewOnly ? (
                          <p className="text-[11px] font-semibold text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
                            {QA_PREVIEW_HINT}
                          </p>
                        ) : (
                          linkedChange.status === "proposed" && (
                            qaBlocked ? (
                              <p className="text-[11px] font-semibold text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
                                QA 모드에서는 실제 진도를 바꾸지 않습니다
                              </p>
                            ) : isExpired ? (
                              <div className="flex items-center justify-between gap-2 pt-1">
                                <span className="text-[11px] font-semibold text-slate-400">
                                  만료된 제안이에요 · 다시 요청해 주세요
                                </span>
                                <button
                                  onClick={() => handleRejectChange(linkedChange.id)}
                                  disabled={actionLoadingId === linkedChange.id}
                                  className="py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 font-medium text-xs transition cursor-pointer shrink-0"
                                >
                                  <span>거절</span>
                                </button>
                              </div>
                            ) : (
                              <div className="flex gap-2 pt-1">
                                <button
                                  onClick={() => handleApplyChange(linkedChange.id, { viaQuickReply: false })}
                                  disabled={actionLoadingId === linkedChange.id}
                                  className="flex-1 py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer shadow-lg shadow-emerald-600/20 active:scale-95"
                                >
                                  {actionLoadingId === linkedChange.id ? (
                                    <Loader2 size={13} className="animate-spin" />
                                  ) : (
                                    <CheckCircle2 size={14} />
                                  )}
                                  <span>{approveLabel}</span>
                                </button>

                                <button
                                  onClick={() => handleRejectChange(linkedChange.id)}
                                  disabled={actionLoadingId === linkedChange.id}
                                  className="py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 font-medium text-xs transition cursor-pointer"
                                >
                                  <span>거절</span>
                                </button>
                              </div>
                            )
                          )
                        )}
                      </div>
                      );
                    })()}

                    {(() => {
                      const info = sanitizeCoachInfoCard(m.infoCard);
                      if (!info) return null;
                      return (
                        <div className="w-full max-w-[92%] mt-2.5 p-4 rounded-2xl bg-[#131A26] border border-slate-700 shadow-xl space-y-2.5">
                          <div className="flex items-center gap-1.5">
                            <Calendar className="w-4 h-4 text-amber-400" />
                            <span className="text-xs font-bold text-white">{info.title}</span>
                          </div>
                          <ul className="space-y-1 text-[11px] text-slate-300">
                            {info.lines.map((line, i) => (
                              <li key={i}>• {line}</li>
                            ))}
                          </ul>
                        </div>
                      );
                    })()}
                  </div>
                );
              })}

              {undoOffer && (
                <div className="w-full max-w-[92%] p-4 rounded-2xl bg-[#131A26] border border-purple-500/40 shadow-xl space-y-3">
                  <div className="flex items-center gap-1.5">
                    <RotateCcw className="w-4 h-4 text-purple-400" />
                    <span className="text-xs font-bold text-purple-300">진도 되돌리기 확인</span>
                  </div>
                  <p className="text-xs text-slate-200">
                    {describeUndoOffer(undoOffer.restore, goals)}
                  </p>
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={handleConfirmUndoOffer}
                      disabled={undoLoading}
                      className="flex-1 py-2 px-3 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer"
                    >
                      {undoLoading ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                      <span>되돌리기</span>
                    </button>
                    <button
                      onClick={() => setUndoOffer(null)}
                      disabled={undoLoading}
                      className="py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 font-medium text-xs transition cursor-pointer"
                    >
                      <span>그대로 두기</span>
                    </button>
                  </div>
                </div>
              )}

              {isLoading && (
                <div className="flex items-center gap-2 text-xs text-amber-400 p-2 animate-pulse">
                  <Loader2 size={14} className="animate-spin" />
                  <span>코치가 찬식님의 일정을 검토하는 중...</span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}

          {activeTab === "history" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-slate-400 px-1">
                <span>총 {planChanges.length}건의 계획 변경 기록</span>
                <span className="text-[11px] text-slate-500">
                  승인된 항목은 언제든 직전 상태로 [되돌리기] 가능
                </span>
              </div>

              {planChanges.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500 bg-slate-900/40 rounded-2xl border border-slate-800">
                  아직 변경된 계획 이력이 없습니다. 코치에게 일정 변경을 요청해 보세요.
                </div>
              ) : (
                planChanges.map((change) => {
                  const isExpanded = expandedChangeId === change.id;
                  return (
                    <div
                      key={change.id}
                      className="p-4 rounded-2xl bg-[#1A2232] border border-slate-800 space-y-2.5 transition"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                              change.qaPreview
                                ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                                : change.status === "approved"
                                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                                : change.status === "rejected"
                                ? "bg-slate-800 text-slate-400 border border-slate-700"
                                : change.status === "reverted"
                                ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
                                : "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                            }`}
                          >
                            {change.qaPreview
                              ? "QA 미리보기"
                              : change.status === "approved"
                              ? "승인 완료"
                              : change.status === "rejected"
                              ? "거절됨"
                              : change.status === "reverted"
                              ? "되돌림 완료"
                              : "승인 대기"}
                          </span>
                          <span className="text-xs font-bold text-white">
                            {change.summary}
                          </span>
                        </div>

                        <span className="text-[10px] text-slate-500 font-mono shrink-0">
                          {change.at.slice(5, 16).replace("T", " ")}
                        </span>
                      </div>

                      <p className="text-[11px] text-slate-400">
                        요청 내용: "{change.requestedText}"
                      </p>

                      {/* Expandable Before/After Comparison */}
                      {isExpanded && (
                        <div className="grid grid-cols-2 gap-2 text-[11px] p-2.5 rounded-xl bg-slate-900/80 border border-slate-800 animate-fade-in">
                          <div>
                            <span className="text-[10px] font-bold text-slate-400 block mb-1">
                              [Before 이전 상태]
                            </span>
                            <pre className="text-[10px] font-mono text-slate-300 whitespace-pre-wrap">
                              {JSON.stringify(change.before, null, 2)}
                            </pre>
                          </div>
                          <div className="border-l border-slate-800 pl-2">
                            <span className="text-[10px] font-bold text-amber-400 block mb-1">
                              [After 변경 상태]
                            </span>
                            <pre className="text-[10px] font-mono text-amber-200 whitespace-pre-wrap">
                              {JSON.stringify(change.after, null, 2)}
                            </pre>
                          </div>
                        </div>
                      )}

                      <div className="flex items-center justify-between pt-1">
                        <button
                          onClick={() => setExpandedChangeId(isExpanded ? null : change.id)}
                          className="text-[11px] text-slate-500 hover:text-slate-300 flex items-center gap-1 cursor-pointer"
                        >
                          <span>{isExpanded ? "상세 닫기" : "상세 내역"}</span>
                          {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </button>

                        <div className="flex gap-2">
                          {!change.qaPreview && change.status === "proposed" && (() => {
                            const histGate = canApplyPendingProposal(change, {
                              nowMs: Date.now(),
                              sessionChangeIds: sessionChangeIdsRef.current,
                              viaQuickReply: false,
                            });
                            const histExpired = !histGate.ok && histGate.reason === "expired";
                            return histExpired ? (
                              <span className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-400 font-semibold text-xs border border-slate-700">
                                만료
                              </span>
                            ) : (
                              <button
                                onClick={() => handleApplyChange(change.id, { viaQuickReply: false })}
                                disabled={actionLoadingId === change.id}
                                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center gap-1 transition cursor-pointer"
                              >
                                <CheckCircle2 size={12} />
                                <span>승인</span>
                              </button>
                            );
                          })()}

                          {change.status === "approved" && (
                            <button
                              onClick={() => handleRevertChange(change.id)}
                              disabled={actionLoadingId === change.id}
                              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 font-semibold text-xs flex items-center gap-1 transition cursor-pointer border border-slate-700"
                            >
                              <RotateCcw size={12} />
                              <span>되돌리기 (직전 복구)</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {activeTab === "memory" && (
            <div className="space-y-4 text-xs">
              <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-200 leading-relaxed text-[11px]">
                💡 코치가 대화 중 파악한 찬식님의 일정 제약, 선호도, 취약점을 기억하는 공간입니다. 언제든 항목별로 삭제하실 수 있습니다.
              </div>

              {/* 1. Constraints */}
              <div className="p-4 rounded-2xl bg-[#1A2232] border border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white flex items-center gap-1.5">
                    <Clock size={13} className="text-amber-400" />
                    <span>학습 제약 조건 (출장·야근·선호 불가)</span>
                  </span>
                  <span className="text-[10px] text-slate-500">
                    {memory.constraints?.length || 0}개
                  </span>
                </div>
                {(!memory.constraints || memory.constraints.length === 0) ? (
                  <p className="text-slate-500 text-[11px] py-1">등록된 제약 조건이 없습니다.</p>
                ) : (
                  <div className="space-y-1.5">
                    {memory.constraints.map((item, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between p-2 rounded-xl bg-slate-900/60 border border-slate-800"
                      >
                        <span className="text-slate-200">{item}</span>
                        <button
                          onClick={() => handleRemoveMemory("constraints", item)}
                          className="p-1 rounded text-slate-500 hover:text-rose-400 transition cursor-pointer"
                          title="삭제"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 2. Preferences */}
              <div className="p-4 rounded-2xl bg-[#1A2232] border border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white flex items-center gap-1.5">
                    <Sparkles size={13} className="text-purple-400" />
                    <span>학습 선호도 (집중 과목·시간)</span>
                  </span>
                  <span className="text-[10px] text-slate-500">
                    {memory.preferences?.length || 0}개
                  </span>
                </div>
                {(!memory.preferences || memory.preferences.length === 0) ? (
                  <p className="text-slate-500 text-[11px] py-1">등록된 선호도가 없습니다.</p>
                ) : (
                  <div className="space-y-1.5">
                    {memory.preferences.map((item, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between p-2 rounded-xl bg-slate-900/60 border border-slate-800"
                      >
                        <span className="text-slate-200">{item}</span>
                        <button
                          onClick={() => handleRemoveMemory("preferences", item)}
                          className="p-1 rounded text-slate-500 hover:text-rose-400 transition cursor-pointer"
                          title="삭제"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 3. Weak Points */}
              <div className="p-4 rounded-2xl bg-[#1A2232] border border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white flex items-center gap-1.5">
                    <AlertCircle size={13} className="text-rose-400" />
                    <span>취약점 및 집중 보완 포인트</span>
                  </span>
                  <span className="text-[10px] text-slate-500">
                    {memory.weakPoints?.length || 0}개
                  </span>
                </div>
                {(!memory.weakPoints || memory.weakPoints.length === 0) ? (
                  <p className="text-slate-500 text-[11px] py-1">등록된 취약점이 없습니다.</p>
                ) : (
                  <div className="space-y-1.5">
                    {memory.weakPoints.map((item, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between p-2 rounded-xl bg-slate-900/60 border border-slate-800"
                      >
                        <span className="text-slate-200">{item}</span>
                        <button
                          onClick={() => handleRemoveMemory("weakPoints", item)}
                          className="p-1 rounded text-slate-500 hover:text-rose-400 transition cursor-pointer"
                          title="삭제"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Quick Suggestion Chips (only on chat tab) */}
        {activeTab === "chat" && (
          <div className="px-4 py-2 border-t border-slate-800/80 bg-[#161D2A] flex items-center gap-1.5 overflow-x-auto text-[11px] scrollbar-none">
            <span className="text-slate-500 shrink-0 font-medium">추천 예시:</span>
            <button
              onClick={() => handleSendMessage("다음 주 출장이야")}
              className="shrink-0 px-2.5 py-1 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700/60 transition cursor-pointer"
            >
              💼 "다음 주 출장이야"
            </button>
            <button
              onClick={() => handleSendMessage("시험이 11/29로 잡혔어")}
              className="shrink-0 px-2.5 py-1 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700/60 transition cursor-pointer"
            >
              🎯 "시험이 11/29로 잡혔어"
            </button>
            <button
              onClick={() => handleSendMessage("수요일 Bluey 수업을 목요일로 옮겨줘")}
              className="shrink-0 px-2.5 py-1 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700/60 transition cursor-pointer"
            >
              📅 "수요일 수업 옮기기"
            </button>
            <button
              onClick={() => handleSendMessage("하루 20분만 집중할래")}
              className="shrink-0 px-2.5 py-1 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700/60 transition cursor-pointer"
            >
              ⏱️ "하루 20분만"
            </button>
            <button
              onClick={() => handleSendMessage("OPIc 매 통화 2과씩 나가줘")}
              className="shrink-0 px-2.5 py-1 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700/60 transition cursor-pointer"
            >
              ⏩ "OPIc 매 통화 2과씩 나가줘"
            </button>
          </div>
        )}

        {/* Bottom Chat Input Bar */}
        {activeTab === "chat" && (
          <footer className="p-3 sm:p-4 border-t border-slate-800 bg-[#1A2232]">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage();
              }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="코치에게 일정이나 목표 변경을 한국어로 편하게 말해보세요..."
                disabled={isLoading}
                className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
              />
              <button
                type="submit"
                disabled={!inputText.trim() || isLoading}
                className="p-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-bold transition cursor-pointer active:scale-95 shrink-0"
              >
                <Send size={15} />
              </button>
            </form>
          </footer>
        )}
      </div>
    </div>
  );
};
