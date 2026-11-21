/**
 * 앱 화면 깊이(0=홈, 1=홈 위 화면/모달)와 브라우저 history 스택을 동기화하는 순수 모듈.
 * React/DOM 전역에 직접 의존하지 않고 history 유사 객체와 popstate 구독 함수를 주입받는다.
 */

export interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  go(delta?: number): void;
}

export type SubscribePopstate = (listener: () => void) => () => void;

export interface HistoryDepthSyncOptions {
  history: HistoryLike;
  subscribePopstate: SubscribePopstate;
  onUserBack: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildState(existing: unknown, depth: number): Record<string, unknown> {
  if (isRecord(existing)) {
    return { ...existing, onecallDepth: depth };
  }
  return { onecallDepth: depth };
}

function readDepth(state: unknown): number {
  if (isRecord(state) && typeof state.onecallDepth === "number" && Number.isFinite(state.onecallDepth)) {
    return Math.max(0, Math.floor(state.onecallDepth));
  }
  return 0;
}

export class HistoryDepthSync {
  private readonly history: HistoryLike;
  private readonly onUserBack: () => void;
  private readonly unsubscribe: () => void;
  private appDepth = 0;
  private browserDepth = 0;
  private pendingProgrammaticPops = 0;
  private disposed = false;

  constructor(options: HistoryDepthSyncOptions) {
    this.history = options.history;
    this.onUserBack = options.onUserBack;

    // 새로고침 뒤 브라우저 history에 남은 깊이 표시가 앱 초기 상태(홈=0)와 어긋나지 않게 정규화한다.
    this.history.replaceState(buildState(this.history.state, 0), "");
    this.browserDepth = 0;
    this.appDepth = 0;

    this.unsubscribe = options.subscribePopstate(this.handlePopstate);
  }

  /**
   * 앱의 현재 깊이를 반영한다.
   * 브라우저 깊이보다 크면 pushState, 작으면 go(-차이)로 맞추되 프로그래밍적 되돌림은 사용자 뒤로가기로 보지 않는다.
   */
  setDepth(depth: number): void {
    if (this.disposed) return;
    const targetDepth = Math.max(0, Math.floor(depth));
    this.appDepth = targetDepth;

    if (targetDepth > this.browserDepth) {
      this.pushToDepth(targetDepth);
    } else if (targetDepth < this.browserDepth) {
      const diff = this.browserDepth - targetDepth;
      this.browserDepth = targetDepth;
      this.pendingProgrammaticPops += 1;
      this.history.go(-diff);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }

  private pushToDepth(targetDepth: number): void {
    while (this.browserDepth < targetDepth) {
      const nextDepth = this.browserDepth + 1;
      this.history.pushState(buildState(this.history.state, nextDepth), "");
      this.browserDepth = nextDepth;
    }
  }

  private handlePopstate = (): void => {
    if (this.disposed) return;

    const stateDepth = readDepth(this.history.state);
    this.browserDepth = stateDepth;

    if (this.pendingProgrammaticPops > 0) {
      this.pendingProgrammaticPops -= 1;
      // go(-n) 처리 중에 앱이 다시 깊어졌다면 pushState로 맞춘다.
      if (this.appDepth > this.browserDepth) {
        this.pushToDepth(this.appDepth);
      }
      return;
    }

    if (this.browserDepth < this.appDepth) {
      this.onUserBack();
      // 콜백이 앱 상태를 바꾸지 않아 깊이가 그대로면(예: 통화 중) pushState로 깊이를 복구한다.
      if (!this.disposed && this.appDepth > this.browserDepth) {
        this.pushToDepth(this.appDepth);
      }
    } else if (this.browserDepth > this.appDepth) {
      // 사용자가 앞으로가기로 닫힌 화면 항목에 진입한 경우 앱 깊이로 되돌린다.
      const diff = this.browserDepth - this.appDepth;
      this.browserDepth = this.appDepth;
      this.pendingProgrammaticPops += 1;
      this.history.go(-diff);
    }
  };
}
