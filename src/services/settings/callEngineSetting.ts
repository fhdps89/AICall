/**
 * Settings → 개발자 메뉴 「시험 통화 엔진: 구글 스트리밍(PoC)」 switch (default OFF).
 * Stored per browser only. Any value other than exactly "cascade_poc" means the normal engine.
 */
import { POC_DEFAULT_TEXT_VARIANT, parsePocTextVariant } from "../../config/cascadePoc";
import type { PocTextVariant } from "../../config/cascadePoc";

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

/**
 * Test engine reply-text A/B choice (EL-18). Stored per browser; "?pocText=a|b" in the page URL
 * overrides it for that page load only (not saved). Default and any invalid value = "a".
 * Only "a" or "b" is ever sent to the server, which maps it to a model ID.
 */
export const POC_TEXT_VARIANT_KEY = "onecall_poc_text_variant";

export type PocTextVariantSource = "url" | "setting" | "default";

export function getStoredPocTextVariant(storage?: Pick<Storage, "getItem"> | null): PocTextVariant {
  try {
    const target = storage === undefined ? getDefaultStorage() : storage;
    return parsePocTextVariant(target?.getItem(POC_TEXT_VARIANT_KEY));
  } catch {
    return POC_DEFAULT_TEXT_VARIANT;
  }
}

/** "a" removes the key (default); "b" stores it. Swallows storage errors. */
export function setStoredPocTextVariant(
  variant: PocTextVariant,
  storage?: Pick<Storage, "setItem" | "removeItem"> | null
): void {
  try {
    const target = storage === undefined ? getDefaultStorage() : storage;
    if (!target) return;
    if (parsePocTextVariant(variant) === "b") target.setItem(POC_TEXT_VARIANT_KEY, "b");
    else target.removeItem(POC_TEXT_VARIANT_KEY);
  } catch {
    // ignore
  }
}

/** URL override: null when there is no pocText param; an invalid value means "a". */
export function parsePocTextParam(search: string | null | undefined): PocTextVariant | null {
  const raw = String(search || "");
  const params = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
  if (!params.has("pocText")) return null;
  return parsePocTextVariant(params.get("pocText"));
}

/** URL param first, then the saved setting, then "a". */
export function resolvePocTextVariant(
  search?: string | null,
  storage?: Pick<Storage, "getItem"> | null
): { variant: PocTextVariant; source: PocTextVariantSource } {
  let s = search;
  if (s === undefined) {
    try {
      s = typeof globalThis !== "undefined" && (globalThis as any).location ? String((globalThis as any).location.search || "") : "";
    } catch {
      s = "";
    }
  }
  const fromUrl = parsePocTextParam(s);
  if (fromUrl) return { variant: fromUrl, source: "url" };
  const target = storage === undefined ? getDefaultStorage() : storage;
  try {
    if (target && target.getItem(POC_TEXT_VARIANT_KEY) !== null) {
      return { variant: getStoredPocTextVariant(target), source: "setting" };
    }
  } catch {
    // ignore
  }
  return { variant: POC_DEFAULT_TEXT_VARIANT, source: "default" };
}
