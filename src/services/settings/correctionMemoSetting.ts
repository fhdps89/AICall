export const CORRECTION_MEMO_KEY = "onecall_correction_memo";

function getDefaultStorage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

/** URL `?correctionMemo=off` (or 0/false) / `on`. Null if the param is absent or unused. */
export function parseCorrectionMemoParam(search: unknown): "on" | "off" | null {
  if (typeof search !== "string" || !search) return null;
  const q = search.startsWith("?") ? search.slice(1) : search;
  const raw = new URLSearchParams(q).get("correctionMemo");
  if (raw == null) return null;
  const v = raw.trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return "off";
  if (v === "on" || v === "1" || v === "true") return "on";
  return null;
}

/**
 * Call-correction memo (default ON).
 * Off when the stored value is strictly "false", or when `?correctionMemo=off`.
 * The URL wins over storage for that page load and is not written back.
 */
export function isCorrectionMemoEnabled(
  storage?: Pick<Storage, "getItem"> | null,
  search?: string,
): boolean {
  try {
    const hrefSearch =
      search !== undefined
        ? search
        : typeof window !== "undefined"
          ? window.location?.search
          : "";
    const param = parseCorrectionMemoParam(hrefSearch);
    if (param === "off") return false;
    if (param === "on") return true;
    const target = storage === undefined ? getDefaultStorage() : storage;
    if (!target) return true;
    return target.getItem(CORRECTION_MEMO_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setCorrectionMemoEnabled(
  on: boolean,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? getDefaultStorage() : storage;
    if (!target) return;
    target.setItem(CORRECTION_MEMO_KEY, on ? "true" : "false");
  } catch {
    // ignore storage quota/privacy-mode errors
  }
}
