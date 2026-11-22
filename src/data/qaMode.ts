/**
 * QA mode marker so test calls on the owner's account are not used as lecture material.
 * Enable with ?qa=1 (persisted in this browser/origin); disable with ?qa=0.
 */

export const QA_KEY = "oc_qa_mode";

export type QaStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function parseQaParam(search: string): "on" | "off" | null {
  const raw = String(search || "");
  const q = raw.startsWith("?") ? raw.slice(1) : raw;
  const params = new URLSearchParams(q);
  if (!params.has("qa")) return null;
  const v = params.get("qa");
  if (v === "1") return "on";
  if (v === "0") return "off";
  return null;
}

export function applyQaParam(search: string, store: QaStore | undefined): boolean {
  const parsed = parseQaParam(search);
  if (store && parsed === "on") {
    try {
      store.setItem(QA_KEY, "1");
    } catch {
      return false;
    }
  } else if (store && parsed === "off") {
    try {
      store.removeItem(QA_KEY);
    } catch {
      return false;
    }
  }
  return readQaMode(store);
}

export function readQaMode(store: QaStore | undefined): boolean {
  if (!store) return false;
  try {
    return store.getItem(QA_KEY) === "1";
  } catch {
    return false;
  }
}

export function isQaMode(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return readQaMode(localStorage);
  } catch {
    return false;
  }
}

export function applyQaModeFromUrl(): boolean {
  try {
    if (typeof window === "undefined") return false;
    return applyQaParam(window.location.search, localStorage);
  } catch {
    return false;
  }
}

/** Session document wins when present; fall back to the current browser flag only if it is missing. */
export function resolveMistakeSource(
  sessionDoc: { source?: string } | null | undefined,
  qaNow: boolean
): "call" | "qa" {
  if (sessionDoc) return sessionDoc.source === "qa" ? "qa" : "call";
  return qaNow ? "qa" : "call";
}

/** 세션 문서가 있으면 그 source를 따르고, 없을 때만 지금 브라우저 플래그를 본다 (resolveMistakeSource와 같은 규칙). */
export function isQaCall(sessionDoc: { source?: string } | null | undefined, qaNow: boolean): boolean {
  return resolveMistakeSource(sessionDoc, qaNow) === "qa";
}

export interface CallSideEffects {
  saveMistakes: boolean;          // deleteCallMistakesForSession + saveCallMistakes
  applyMistakeOutcomes: boolean;  // applyCallMistakeUpdates(졸업·재오픈) + 성과 항목 표시
  advanceLesson: boolean;         // advanceGoalAfterCompletedCall + lessonAdvanced=true
  recordLearningUsage: boolean;   // liveMinutes / calls
}

export function callSideEffects(isQa: boolean): CallSideEffects {
  const allow = !isQa;
  return {
    saveMistakes: allow,
    applyMistakeOutcomes: allow,
    advanceLesson: allow,
    recordLearningUsage: allow,
  };
}
