import type { MistakeData } from "../firebase/db";

export type MistakeLoadState =
  | { status: "loading" }
  | { status: "ready"; all: MistakeData[]; refreshing: boolean }
  | { status: "error"; message: string };

export type ReviewCardView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "counts";
      due: MistakeData[];
      dueCount: number;
      quizCount: number;
      deferred: number;
      reviewing: number;
      total: number;
      canQuiz: boolean;
      refreshing: boolean;
    };

/**
 * Select and sort today's due mistakes from the full list.
 * - `deferred` items come first (preserving order).
 * - `reviewing` items with targetDate <= today follow, sorted by date asc then stage desc.
 */
export function selectDueMistakes(all: MistakeData[], today: string): MistakeData[] {
  const deferredList: MistakeData[] = [];
  const reviewingDueList: MistakeData[] = [];

  for (const m of all) {
    if (m.status === "deferred") {
      deferredList.push(m);
    } else if (m.status === "reviewing") {
      const targetDate = m.nextReviewAt || m.nextReviewDate || m.createdAt.slice(0, 10);
      if (targetDate <= today) {
        reviewingDueList.push(m);
      }
    }
  }

  reviewingDueList.sort((a, b) => {
    const da = a.nextReviewAt || a.nextReviewDate || "";
    const db = b.nextReviewAt || b.nextReviewDate || "";
    if (da !== db) return da.localeCompare(db);
    return (b.stage || 1) - (a.stage || 1);
  });

  return [...deferredList, ...reviewingDueList];
}

/** Derive the review card presentation state for the given KST date. */
export function reviewCardView(s: MistakeLoadState, today: string): ReviewCardView {
  if (s.status === "loading") {
    return { kind: "loading" };
  }
  if (s.status === "error") {
    return { kind: "error", message: s.message };
  }

  const due = selectDueMistakes(s.all, today);
  const dueCount = due.length;
  const deferred = due.filter((m) => m.status === "deferred").length;
  const reviewing = due.filter((m) => m.status === "reviewing").length;

  return {
    kind: "counts",
    due,
    dueCount,
    quizCount: Math.min(dueCount, 10),
    deferred,
    reviewing,
    total: s.all.length,
    canQuiz: dueCount > 0,
    refreshing: s.refreshing,
  };
}

// Store raw `all` only so `due` is always re-derived for the current KST day.
const mistakeCache = new Map<string, MistakeData[]>();

export function initialMistakeState(uid: string): MistakeLoadState {
  const cached = mistakeCache.get(uid);
  if (cached !== undefined) {
    return { status: "ready", all: cached, refreshing: true };
  }
  return { status: "loading" };
}

export function rememberMistakes(uid: string, all: MistakeData[]): void {
  mistakeCache.set(uid, all);
}

/** Preserve previously loaded mistakes when a background refresh fails. */
export function failMistakes(prev: MistakeLoadState, message: string): MistakeLoadState {
  if (prev.status === "ready") {
    return { ...prev, refreshing: false };
  }
  return { status: "error", message };
}

export function __resetMistakeCacheForTest(): void {
  mistakeCache.clear();
}

export type MistakeLoadReason = "mount" | "changed";
export type FeedSyncMode = "now" | "fromHome";

/**
 * Choose feed sync mode so an earlier "changed" load isn't downgraded to a
 * throttled "fromHome" sync when a later "mount" load supersedes it.
 */
export function pickFeedSyncMode(
  reason: MistakeLoadReason,
  pendingChanged: boolean
): FeedSyncMode {
  if (pendingChanged || reason === "changed") {
    return "now";
  }
  return "fromHome";
}

export interface LatestOnly {
  begin(): number;
  isLatest(id: number): boolean;
  invalidate(): void;
}

/** Track monotonic request generations so stale or post-unmount responses are ignored. */
export function createLatestOnly(): LatestOnly {
  let current = 0;
  return {
    begin(): number {
      current += 1;
      return current;
    },
    isLatest(id: number): boolean {
      return id > 0 && id === current;
    },
    invalidate(): void {
      current += 1;
    },
  };
}
