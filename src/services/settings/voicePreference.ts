import { DEFAULT_VOICE, normalizeVoiceName, type VoiceId } from "../../config/voices";

export const VOICE_STORAGE_KEY = "onecall_voice_name";
export const DEFAULT_VOICE_TIMEOUT_MS = 1500;

export interface VoiceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface VoicePreferenceDeps {
  readRemote?: (userId: string) => Promise<string | undefined>;
  writeRemote?: (userId: string, voiceName: VoiceId) => Promise<void>;
  storage?: VoiceStorage | null;
}

export interface VoicePreferenceStore {
  getPreferredVoice(userId?: string, options?: { timeoutMs?: number }): Promise<VoiceId>;
  setPreferredVoice(userId: string | undefined, name: unknown): Promise<VoiceId>;
  clearCache(): void;
}

function resolveDefaultStorage(): VoiceStorage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * AI 목소리 선택 저장소 팩토리 (메모리 캐시 → localStorage → 원격 Firestore 순).
 */
export function createVoicePreference(deps: VoicePreferenceDeps = {}): VoicePreferenceStore {
  const memoryCache = new Map<string, VoiceId>();

  const getStorage = (): VoiceStorage | null =>
    deps.storage !== undefined ? deps.storage : resolveDefaultStorage();

  const cacheKey = (userId?: string): string => userId || "__anon__";

  const readLocal = (): VoiceId | null => {
    const storage = getStorage();
    if (!storage) return null;
    try {
      const raw = storage.getItem(VOICE_STORAGE_KEY);
      if (raw === null || raw.trim() === "") return null;
      return normalizeVoiceName(raw);
    } catch {
      return null;
    }
  };

  const writeLocal = (voice: VoiceId): void => {
    const storage = getStorage();
    if (!storage) return;
    try {
      storage.setItem(VOICE_STORAGE_KEY, voice);
    } catch {
      // ignore storage quota/privacy errors
    }
  };

  async function getPreferredVoice(
    userId?: string,
    options?: { timeoutMs?: number },
  ): Promise<VoiceId> {
    const key = cacheKey(userId);

    const cached = memoryCache.get(key);
    if (cached) {
      return cached;
    }

    const local = readLocal();
    if (local) {
      memoryCache.set(key, local);
      return local;
    }

    if (userId && deps.readRemote) {
      const timeoutMs = options?.timeoutMs ?? DEFAULT_VOICE_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const remoteResult = await Promise.race<
          { timedOut: false; value: string | undefined } | { timedOut: true }
        >([
          deps.readRemote(userId).then((value) => ({ timedOut: false as const, value })),
          new Promise<{ timedOut: true }>((resolve) => {
            timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
          }),
        ]);
        if (!remoteResult.timedOut) {
          const normalized = normalizeVoiceName(remoteResult.value);
          memoryCache.set(key, normalized);
          writeLocal(normalized);
          return normalized;
        }
      } catch {
        // fall through to default
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    return DEFAULT_VOICE;
  }

  async function setPreferredVoice(userId: string | undefined, name: unknown): Promise<VoiceId> {
    const normalized = normalizeVoiceName(name);
    const key = cacheKey(userId);
    memoryCache.set(key, normalized);
    writeLocal(normalized);
    if (userId && deps.writeRemote) {
      await deps.writeRemote(userId, normalized);
    }
    return normalized;
  }

  function clearCache(): void {
    memoryCache.clear();
  }

  return {
    getPreferredVoice,
    setPreferredVoice,
    clearCache,
  };
}
