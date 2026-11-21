import { test } from "node:test";
import assert from "node:assert/strict";
import { HistoryDepthSync, HistoryLike } from "../src/services/navigation/historySync.ts";

interface RecordedCall {
  type: "pushState" | "replaceState" | "go";
  data?: unknown;
  delta?: number;
}

function createFakeHistory(initialState: unknown = null, options?: { syncGo?: boolean }) {
  const stack: unknown[] = [initialState];
  let index = 0;
  const calls: RecordedCall[] = [];
  const listeners = new Set<() => void>();

  const emitPopstate = () => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const history: HistoryLike = {
    get state() {
      return stack[index];
    },
    pushState(data) {
      calls.push({ type: "pushState", data });
      stack.splice(index + 1);
      stack.push(data);
      index = stack.length - 1;
    },
    replaceState(data) {
      calls.push({ type: "replaceState", data });
      stack[index] = data;
    },
    go(delta = 0) {
      calls.push({ type: "go", delta });
      if (delta === 0) return;
      const target = index + delta;
      if (target < 0 || target >= stack.length) return;
      index = target;
      if (options?.syncGo !== false) {
        emitPopstate();
      }
    },
  };

  const subscribePopstate = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const userBack = () => {
    assert.ok(index > 0, "cannot go back before first entry");
    index -= 1;
    emitPopstate();
  };

  return { history, subscribePopstate, calls, userBack, emitPopstate, listenerCount: () => listeners.size };
}

test("(6) 마운트 시 replaceState({ onecallDepth: 0 })로 현재 항목을 정규화한다", () => {
  const fake = createFakeHistory({ onecallDepth: 1, extra: "keep" });
  const sync = new HistoryDepthSync({
    history: fake.history,
    subscribePopstate: fake.subscribePopstate,
    onUserBack: () => {},
  });

  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0], {
    type: "replaceState",
    data: { onecallDepth: 0, extra: "keep" },
  });
  assert.deepEqual(fake.history.state, { onecallDepth: 0, extra: "keep" });

  sync.dispose();
});

test("(1) 깊이 0→1 전환 시 pushState가 1회 호출된다", () => {
  const fake = createFakeHistory();
  const sync = new HistoryDepthSync({
    history: fake.history,
    subscribePopstate: fake.subscribePopstate,
    onUserBack: () => {},
  });
  fake.calls.length = 0;

  sync.setDepth(1);

  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0], {
    type: "pushState",
    data: { onecallDepth: 1 },
  });

  sync.dispose();
});

test("(2) 사용자 뒤로가기 시 onUserBack이 호출되고 앱이 닫으면 추가 pushState가 없다", () => {
  const fake = createFakeHistory();
  let backCalls = 0;
  let sync!: HistoryDepthSync;
  sync = new HistoryDepthSync({
    history: fake.history,
    subscribePopstate: fake.subscribePopstate,
    onUserBack: () => {
      backCalls += 1;
      sync.setDepth(0);
    },
  });

  sync.setDepth(1);
  fake.calls.length = 0;

  fake.userBack();

  assert.equal(backCalls, 1);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(fake.history.state, { onecallDepth: 0 });

  sync.dispose();
});

test("(3) 앱이 먼저 닫으면(깊이 1→0) go(-1)이 불리고 그 popstate에서 onUserBack이 불리지 않는다", () => {
  const fake = createFakeHistory();
  let backCalls = 0;
  const sync = new HistoryDepthSync({
    history: fake.history,
    subscribePopstate: fake.subscribePopstate,
    onUserBack: () => {
      backCalls += 1;
    },
  });

  sync.setDepth(1);
  fake.calls.length = 0;

  sync.setDepth(0);

  assert.equal(backCalls, 0);
  assert.deepEqual(fake.calls, [{ type: "go", delta: -1 }]);
  assert.deepEqual(fake.history.state, { onecallDepth: 0 });

  // 비동기 popstate(브라우저 동작)에서도 동일하게 무시되는지 확인
  const asyncFake = createFakeHistory(null, { syncGo: false });
  let asyncBackCalls = 0;
  const asyncSync = new HistoryDepthSync({
    history: asyncFake.history,
    subscribePopstate: asyncFake.subscribePopstate,
    onUserBack: () => {
      asyncBackCalls += 1;
    },
  });
  asyncSync.setDepth(1);
  asyncFake.calls.length = 0;
  asyncSync.setDepth(0);
  assert.deepEqual(asyncFake.calls, [{ type: "go", delta: -1 }]);
  asyncFake.emitPopstate();
  assert.equal(asyncBackCalls, 0);

  sync.dispose();
  asyncSync.dispose();
});

test("(4) 깊이 1→1 화면 교체는 history 호출이 0회다", () => {
  const fake = createFakeHistory();
  const sync = new HistoryDepthSync({
    history: fake.history,
    subscribePopstate: fake.subscribePopstate,
    onUserBack: () => {},
  });

  sync.setDepth(1);
  fake.calls.length = 0;

  // 예: 통화 준비(depth 1) -> 통화 중(depth 1)
  sync.setDepth(1);

  assert.equal(fake.calls.length, 0);

  sync.dispose();
});

test("(5) onUserBack이 앱 상태를 바꾸지 않으면 pushState로 깊이를 복구한다", () => {
  const fake = createFakeHistory();
  let backCalls = 0;
  const sync = new HistoryDepthSync({
    history: fake.history,
    subscribePopstate: fake.subscribePopstate,
    onUserBack: () => {
      backCalls += 1;
      // 통화 중 등 뒤로가기로 닫지 않는 화면
    },
  });

  sync.setDepth(1);
  fake.calls.length = 0;

  fake.userBack();

  assert.equal(backCalls, 1);
  assert.deepEqual(fake.calls, [
    { type: "pushState", data: { onecallDepth: 1 } },
  ]);
  assert.deepEqual(fake.history.state, { onecallDepth: 1 });

  sync.dispose();
});

test("(7) dispose 후에는 popstate를 무시하고 구독을 해제한다", () => {
  const fake = createFakeHistory();
  let backCalls = 0;
  const sync = new HistoryDepthSync({
    history: fake.history,
    subscribePopstate: fake.subscribePopstate,
    onUserBack: () => {
      backCalls += 1;
    },
  });

  sync.setDepth(1);
  assert.equal(fake.listenerCount(), 1);
  fake.calls.length = 0;

  sync.dispose();
  assert.equal(fake.listenerCount(), 0);

  fake.userBack();
  assert.equal(backCalls, 0);
  assert.equal(fake.calls.length, 0);
});
