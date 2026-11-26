import { test } from "node:test";
import assert from "node:assert/strict";
import { createBootTimer, markBoot, shouldUnrefBootTimer } from "../src/services/perf/bootTiming.ts";

const FULL_LINE =
  "[boot] auth=20ms data=30ms home=40ms mistakes=60ms lectureLocal=50ms lectureServer=70ms";

interface BootHtml {
  dataset: { bootTiming?: string };
  getAttribute(name: string): string | null;
}

/** Stand-in for `<html>`: assigning `dataset.bootTiming` sets `data-boot-timing`. */
function bootHtml(): BootHtml {
  const attrs = new Map<string, string>();
  const dataset = {};
  Object.defineProperty(dataset, "bootTiming", {
    configurable: true,
    enumerable: true,
    get() {
      return attrs.get("data-boot-timing");
    },
    set(value: string) {
      attrs.set("data-boot-timing", String(value));
    },
  });
  return {
    dataset: dataset as { bootTiming?: string },
    getAttribute: (name: string) => attrs.get(name) ?? null,
  };
}

function bootWindow(search: string | undefined): Window {
  const win: { __AICALL_BOOT__?: string; location?: { search: string } } = {};
  if (search !== undefined) win.location = { search };
  return win as unknown as Window;
}

function withBootPage(
  page: { html: BootHtml | null | "bare"; win: Window | null; storage?: Storage },
  run: () => void
): void {
  const g = globalThis as unknown as {
    document?: Document;
    window?: Window;
    localStorage?: Storage;
  };
  const hadDocument = Object.prototype.hasOwnProperty.call(g, "document");
  const hadWindow = Object.prototype.hasOwnProperty.call(g, "window");
  const hadStorage = Object.prototype.hasOwnProperty.call(g, "localStorage");
  const prevDocument = g.document;
  const prevWindow = g.window;
  const prevStorage = g.localStorage;
  if (page.html === "bare") g.document = {} as Document;
  else if (page.html) g.document = { documentElement: page.html } as unknown as Document;
  else delete g.document;
  if (page.win) g.window = page.win;
  else delete g.window;
  if (page.storage) g.localStorage = page.storage;
  else if (!hadStorage) delete g.localStorage;
  try {
    run();
  } finally {
    if (hadDocument) g.document = prevDocument;
    else delete g.document;
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
    if (hadStorage) g.localStorage = prevStorage;
    else delete g.localStorage;
  }
}

function flushFullLine(log: (msg: string) => void): { late: () => void; again: () => void } {
  let tick = 10;
  let timerCb: (() => void) | undefined;
  const mark = createBootTimer(
    () => (tick += 10),
    log,
    (cb) => {
      timerCb = cb;
      return 1;
    }
  );
  mark("auth");
  mark("data");
  mark("home");
  mark("lectureLocal");
  mark("mistakes");
  mark("lectureServer");
  return {
    late: () => timerCb?.(),
    again: () => mark("home"),
  };
}

const persistedQa = {
  getItem: (key: string) => (key === "oc_qa_mode" ? "1" : null),
  setItem() {},
  removeItem() {},
  clear() {},
  key: () => null,
  length: 0,
} as Storage;

test("records only first call per phase and logs once when data, mistakes, and lectureServer are marked", () => {
  let tick = 10;
  const logs: string[] = [];
  let timerCb: (() => void) | undefined;

  const mark = createBootTimer(
    () => (tick += 10),
    (msg) => logs.push(msg),
    (cb) => {
      timerCb = cb;
      return 1;
    }
  );

  mark("auth"); // 20
  mark("auth"); // ignored (first 1 only)
  mark("data"); // 30
  mark("home"); // 40
  mark("lectureLocal"); // 50
  assert.equal(logs.length, 0);

  mark("mistakes"); // 60
  assert.equal(logs.length, 0);

  mark("lectureServer"); // 70 -> triggers log
  assert.equal(logs.length, 1);
  assert.equal(
    logs[0],
    "[boot] auth=20ms data=30ms home=40ms mistakes=60ms lectureLocal=50ms lectureServer=70ms"
  );

  // Subsequent marks or timer callback do not re-log
  mark("lectureServer");
  timerCb?.();
  assert.equal(logs.length, 1);
});

test("logs once after 60s timeout when not all phases finish and ignores later marks", () => {
  let tick = 0;
  const logs: string[] = [];
  let capturedCb: (() => void) | undefined;
  let capturedMs: number | undefined;

  const mark = createBootTimer(
    () => (tick += 25),
    (msg) => logs.push(msg),
    (cb, ms) => {
      capturedCb = cb;
      capturedMs = ms;
      return 1;
    }
  );

  mark("auth"); // 25
  mark("mistakes"); // 50 (lectureServer missing)
  assert.equal(capturedMs, 60_000);
  assert.equal(logs.length, 0);

  capturedCb?.();
  assert.equal(logs.length, 1);
  assert.equal(
    logs[0],
    "[boot] auth=25ms data=- home=- mistakes=50ms lectureLocal=- lectureServer=-"
  );

  mark("lectureServer");
  assert.equal(logs.length, 1);
});

test("flush waits for data after mistakes and lectureServer, and the 60s fallback still logs", () => {
  let tick = 0;
  const logs: string[] = [];

  const mark = createBootTimer(
    () => (tick += 10),
    (msg) => logs.push(msg),
    () => 1
  );

  mark("auth"); // 10
  mark("home"); // 20
  mark("lectureLocal"); // 30
  mark("mistakes"); // 40
  assert.equal(logs.length, 0);

  mark("lectureServer"); // 50 — data still open, so no flush
  assert.equal(logs.length, 0);

  mark("data"); // 60 -> triggers log
  assert.equal(logs.length, 1);
  assert.equal(
    logs[0],
    "[boot] auth=10ms data=60ms home=20ms mistakes=40ms lectureLocal=30ms lectureServer=50ms"
  );

  let lateTick = 0;
  const lateLogs: string[] = [];
  let lateCb: (() => void) | undefined;
  const late = createBootTimer(
    () => (lateTick += 25),
    (msg) => lateLogs.push(msg),
    (cb, ms) => {
      lateCb = cb;
      assert.equal(ms, 60_000);
      return 2;
    }
  );
  late("mistakes");
  late("lectureServer");
  assert.equal(lateLogs.length, 0);
  lateCb?.();
  assert.equal(lateLogs.length, 1);
  assert.match(lateLogs[0], /data=-/);
  assert.match(lateLogs[0], /mistakes=25ms/);
  assert.match(lateLogs[0], /lectureServer=50ms/);
});

test("calls clearTimer with timer handle when flushed before 60s timeout", () => {
  let tick = 0;
  const logs: string[] = [];
  const cleared: unknown[] = [];
  const timerHandle = { id: "boot-timer-1" };
  let capturedCb: (() => void) | undefined;

  const mark = createBootTimer(
    () => (tick += 10),
    (msg) => logs.push(msg),
    (cb) => {
      capturedCb = cb;
      return timerHandle;
    },
    (handle) => {
      cleared.push(handle);
    }
  );

  mark("data");
  mark("mistakes");
  assert.deepEqual(cleared, []);

  mark("lectureServer");
  assert.equal(logs.length, 1);
  assert.deepEqual(cleared, [timerHandle]);

  // Late timer callback or extra mark neither re-logs nor clears again
  capturedCb?.();
  mark("home");
  assert.equal(logs.length, 1);
  assert.deepEqual(cleared, [timerHandle]);
});

test("unref is for Node test timers only; a page keeps the 60s fallback", () => {
  const handle = { unref() {} };
  assert.equal(shouldUnrefBootTimer(handle, { window: true, node: true }), false);
  assert.equal(shouldUnrefBootTimer(handle, { window: false, node: true }), true);
  assert.equal(shouldUnrefBootTimer(handle, { window: false, node: false }), false);
  assert.equal(shouldUnrefBootTimer(1, { window: false, node: true }), false);
});

test("flush writes the summary to data-boot-timing and window.__AICALL_BOOT__", () => {
  const html = bootHtml();
  const win = bootWindow("");
  const logs: string[] = [];
  const warns: string[] = [];
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.warn = (msg?: unknown) => {
    warns.push(String(msg));
  };
  console.info = (msg?: unknown) => {
    logs.push(`info:${String(msg)}`);
  };
  try {
    withBootPage({ html, win, storage: persistedQa }, () => {
      const flushed = flushFullLine((msg) => logs.push(msg));
      assert.equal(logs.length, 1);
      assert.equal(logs[0], FULL_LINE);
      assert.equal(html.dataset.bootTiming, FULL_LINE);
      assert.equal(html.getAttribute("data-boot-timing"), FULL_LINE);
      assert.equal(win.__AICALL_BOOT__, FULL_LINE);
      assert.deepEqual(warns, []);
      flushed.late();
      flushed.again();
      assert.equal(html.dataset.bootTiming, FULL_LINE);
      assert.equal(win.__AICALL_BOOT__, FULL_LINE);
      assert.deepEqual(warns, []);
    });
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
  assert.equal(logs.some((line) => line.startsWith("info:")), false);
});

test("flush warns the same summary only when the URL has ?qa=1", () => {
  const cases: { search: string | undefined; warn: boolean }[] = [
    { search: "?qa=1", warn: true },
    { search: "?x=2&qa=1", warn: true },
    { search: "qa=1", warn: true },
    { search: "?qa=0", warn: false },
    { search: "?qa=yes", warn: false },
    { search: "?qa=10", warn: false },
    { search: "", warn: false },
    { search: undefined, warn: false },
  ];

  for (const item of cases) {
    const html = bootHtml();
    const win = bootWindow(item.search);
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg?: unknown) => {
      warns.push(String(msg));
    };
    try {
      withBootPage({ html, win, storage: persistedQa }, () => {
        const flushed = flushFullLine(() => {});
        if (item.warn) {
          assert.deepEqual(warns, [FULL_LINE], `search ${item.search}`);
        } else {
          assert.deepEqual(warns, [], `search ${String(item.search)}`);
        }
        assert.equal(html.getAttribute("data-boot-timing"), FULL_LINE);
        assert.equal(win.__AICALL_BOOT__, FULL_LINE);
        flushed.late();
        flushed.again();
        assert.equal(warns.length, item.warn ? 1 : 0);
      });
    } finally {
      console.warn = originalWarn;
    }
  }
});

test("flush skips a missing document or window and still logs", () => {
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg?: unknown) => {
    warns.push(String(msg));
  };
  try {
    const html = bootHtml();
    withBootPage({ html, win: null }, () => {
      const logs: string[] = [];
      flushFullLine((msg) => logs.push(msg));
      assert.deepEqual(logs, [FULL_LINE]);
      assert.equal(html.getAttribute("data-boot-timing"), FULL_LINE);
      assert.equal(html.dataset.bootTiming, FULL_LINE);
      assert.deepEqual(warns, []);
    });

    const win = bootWindow("?qa=1");
    withBootPage({ html: null, win }, () => {
      const logs: string[] = [];
      flushFullLine((msg) => logs.push(msg));
      assert.deepEqual(logs, [FULL_LINE]);
      assert.equal(win.__AICALL_BOOT__, FULL_LINE);
      assert.deepEqual(warns, [FULL_LINE]);
    });

    const bareWin = bootWindow("?qa=1");
    withBootPage({ html: "bare", win: bareWin }, () => {
      const logs: string[] = [];
      flushFullLine((msg) => logs.push(msg));
      assert.deepEqual(logs, [FULL_LINE]);
      assert.equal(bareWin.__AICALL_BOOT__, FULL_LINE);
      assert.deepEqual(warns, [FULL_LINE, FULL_LINE]);
    });

    withBootPage({ html: null, win: null }, () => {
      const logs: string[] = [];
      flushFullLine((msg) => logs.push(msg));
      assert.deepEqual(logs, [FULL_LINE]);
      assert.deepEqual(warns, [FULL_LINE, FULL_LINE]);
    });
  } finally {
    console.warn = originalWarn;
  }
});

test("default markBoot keeps console.info and mirrors the line, warning only for ?qa=1", () => {
  const html = bootHtml();
  const win = bootWindow("?qa=1");
  const infos: string[] = [];
  const warns: string[] = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.info = (msg?: unknown) => {
    infos.push(String(msg));
  };
  console.warn = (msg?: unknown) => {
    warns.push(String(msg));
  };
  try {
    withBootPage({ html, win }, () => {
      markBoot("auth");
      markBoot("data");
      markBoot("home");
      markBoot("mistakes");
      markBoot("lectureLocal");
      markBoot("lectureServer");
      assert.equal(infos.length, 1);
      assert.match(
        infos[0],
        /^\[boot\] auth=\d+ms data=\d+ms home=\d+ms mistakes=\d+ms lectureLocal=\d+ms lectureServer=\d+ms$/
      );
      assert.equal(html.dataset.bootTiming, infos[0]);
      assert.equal(html.getAttribute("data-boot-timing"), infos[0]);
      assert.equal(win.__AICALL_BOOT__, infos[0]);
      assert.deepEqual(warns, [infos[0]]);
      markBoot("home");
      assert.equal(infos.length, 1);
      assert.equal(warns.length, 1);
    });
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
  }
});
