/**
 * Settings → 개발자 메뉴 「시험 통화 엔진: 구글 스트리밍(PoC)」 switch (default OFF).
 * Stored per browser only. Any value other than exactly "cascade_poc" means the normal engine.
 */
export const CALL_ENGINE_KEY = "onecall_call_engine";
export const CALL_ENGINE_POC = "cascade_poc";

export type CallEngine = "live" | "cascade_poc";

function getDefaultStorage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

/** True ONLY when the stored value is strictly "cascade_poc". */
export function isCascadePocEnabled(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    const target = storage === undefined ? getDefaultStorage() : storage;
    if (!target) return false;
    return target.getItem(CALL_ENGINE_KEY) === CALL_ENGINE_POC;
  } catch {
    return false;
  }
}

export function getCallEngine(storage?: Pick<Storage, "getItem"> | null): CallEngine {
  return isCascadePocEnabled(storage) ? "cascade_poc" : "live";
}

/** Persist the switch; OFF removes the key so the default engine is used (swallows storage errors). */
export function setCascadePocEnabled(
  on: boolean,
  storage?: Pick<Storage, "setItem" | "removeItem"> | null
): void {
  try {
    const target = storage === undefined ? getDefaultStorage() : storage;
    if (!target) return;
    if (on) target.setItem(CALL_ENGINE_KEY, CALL_ENGINE_POC);
    else target.removeItem(CALL_ENGINE_KEY);
  } catch {
    // ignore storage quota/privacy-mode errors
  }
}
