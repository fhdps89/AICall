export interface DailyOverrideStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * UTC 밀리초 타임스탬프를 KST(UTC+9) 기준 'YYYY-MM-DD' 문자열로 변환한다.
 */
export function kstDateKey(nowMs: number): string {
  const kstDate = new Date(nowMs + KST_OFFSET_MS);
  const year = kstDate.getUTCFullYear();
  const month = String(kstDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(kstDate.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 사용자별 오늘 트랙 선택 저장 키를 만든다.
 */
export function overrideStorageKey(userId: string): string {
  return `onecall_today_track_override:${userId}`;
}

/**
 * 오늘(KST) 선택한 트랙 ID를 저장소에서 읽는다.
 * 깨졌거나 지난 날짜의 값은 정리(removeItem)하고 null을 반환한다.
 */
export function loadDailyOverride(
  storage: DailyOverrideStorage,
  userId: string,
  nowMs: number,
  validGoalIds?: string[]
): string | null {
  if (!userId) return null;
  const key = overrideStorageKey(userId);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      storage.removeItem(key);
      return null;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      storage.removeItem(key);
      return null;
    }

    const record = parsed as { date?: unknown; goalId?: unknown };
    if (
      typeof record.date !== "string" ||
      typeof record.goalId !== "string" ||
      record.goalId.length === 0 ||
      record.date !== kstDateKey(nowMs)
    ) {
      storage.removeItem(key);
      return null;
    }

    if (validGoalIds !== undefined && !validGoalIds.includes(record.goalId)) {
      return null;
    }

    return record.goalId;
  } catch {
    return null;
  }
}

/**
 * 오늘(KST) 선택한 트랙 ID를 저장소에 기록한다.
 * goalId가 null이면 저장된 값을 지우며, 저장소 예외는 삼킨다.
 */
export function saveDailyOverride(
  storage: DailyOverrideStorage,
  userId: string,
  nowMs: number,
  goalId: string | null
): void {
  if (!userId) return;
  const key = overrideStorageKey(userId);
  try {
    if (!goalId) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(
      key,
      JSON.stringify({
        date: kstDateKey(nowMs),
        goalId,
      })
    );
  } catch {
    // 저장소 접근/쓰기 실패는 무시한다.
  }
}
