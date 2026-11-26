export const PARTIAL_TRANSCRIBE_KEY = "onecall_enable_partial_transcribe";

function getDefaultStorage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

/**
 * Settings → 1분 임시 받아쓰기 switch (default OFF).
 * Returns true ONLY when the stored value is strictly "true".
 */
export function isPartialTranscribeEnabled(
  storage?: Pick<Storage, "getItem"> | null
): boolean {
  try {
    const target = storage === undefined ? getDefaultStorage() : storage;
    if (!target) return false;
    return target.getItem(PARTIAL_TRANSCRIBE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist the 1-minute partial transcription toggle (swallows storage errors). */
export function setPartialTranscribeEnabled(
  on: boolean,
  storage?: Pick<Storage, "setItem"> | null
): void {
  try {
    const target = storage === undefined ? getDefaultStorage() : storage;
    if (!target) return;
    target.setItem(PARTIAL_TRANSCRIBE_KEY, on ? "true" : "false");
  } catch {
    // ignore storage quota/privacy-mode errors
  }
}
