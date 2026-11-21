/**
 * 뒤로가기 시 닫을 최상위 화면 대상을 판정하는 순수 모듈.
 * 통화 중·복기 로딩/실패 카드·초기 진도 모달이 열려 있으면 닫지 않고(null) 깊이를 복구한다.
 */

export interface BackTargetState {
  activeCall: boolean;
  generatingReview: boolean;
  reviewFailure: boolean;
  initialProgressModal: boolean;
  prepCall: boolean;
  activeReview: boolean;
  unfinishedModal: boolean;
  settingsModal: boolean;
}

export type BackTarget = "prepCall" | "review" | "unfinished" | "settings";

/**
 * 뒤로가기로 닫히면 안 되는 보호 화면이 열려 있는지 반환한다.
 */
export function isBackBlocked(state: BackTargetState): boolean {
  return (
    state.activeCall ||
    state.generatingReview ||
    state.reviewFailure ||
    state.initialProgressModal
  );
}

/**
 * 현재 앱 화면 깊이(0=홈, 1=홈 위 화면/모달)를 계산한다.
 */
export function getNavigationDepth(state: BackTargetState): 0 | 1 {
  if (
    isBackBlocked(state) ||
    state.prepCall ||
    state.activeReview ||
    state.unfinishedModal ||
    state.settingsModal
  ) {
    return 1;
  }
  return 0;
}

/**
 * 우선순위에 따라 뒤로가기로 닫을 대상을 고른다.
 * 우선순위: 닫지 않음(통화 중 / 복기 로딩·실패 카드 / 초기 진도 모달)
 * → prepCall → 복기 모달 → 끝나지 않은 통화 모달 → 설정 모달.
 */
export function pickBackTarget(state: BackTargetState): BackTarget | null {
  if (isBackBlocked(state)) {
    return null;
  }
  if (state.prepCall) return "prepCall";
  if (state.activeReview) return "review";
  if (state.unfinishedModal) return "unfinished";
  if (state.settingsModal) return "settings";
  return null;
}
