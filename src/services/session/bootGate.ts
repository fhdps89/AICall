export type BootGoalsEvent = "cache" | "retry" | "fresh" | "failed" | "signedOut";

/** 진도(goals) 확인 상태: 확인 중 / 최신 확인됨 / 확인 실패 */
export type GoalsSyncState = "syncing" | "fresh" | "failed";

/**
 * 부트 캐시·재시도·서버 동기화·실패·로그아웃 이벤트에 따라 진도 확인 상태를 계산한다.
 * 서버 조회 실패는 캐시가 있든 없든 "failed"이며, 통화 시작은 "fresh"일 때만 허용한다.
 */
export function nextGoalsSyncState(event: BootGoalsEvent): GoalsSyncState {
  switch (event) {
    case "cache":
    case "retry":
    case "signedOut":
      return "syncing";
    case "fresh":
      return "fresh";
    case "failed":
      return "failed";
  }
}

/** 최신 진도를 서버에서 확인한 뒤에만 통화를 시작할 수 있다. */
export function canStartCall(state: GoalsSyncState): boolean {
  return state === "fresh";
}

/**
 * 목표 목록을 반영해도 되는 조회인지 가른다.
 * 시작 시각이 이미 반영된 조회보다 이르면 거절해, 늦은 응답이 더 새로운 진도를 덮지 못하게 한다.
 */
export interface GoalsCommitGate {
  claim(startedAt: number): boolean;
}

export function createGoalsCommitGate(): GoalsCommitGate {
  let newestApplied = Number.NEGATIVE_INFINITY;
  return {
    claim(startedAt: number): boolean {
      if (!Number.isFinite(startedAt) || startedAt < newestApplied) return false;
      newestApplied = startedAt;
      return true;
    },
  };
}
