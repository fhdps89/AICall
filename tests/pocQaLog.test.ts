import { test } from "node:test";
import assert from "node:assert/strict";
import { infoPoc, logPoc, mirrorPocQaLine, pocQaKind } from "../src/services/perf/pocQaLog.ts";
import { publishQaReadableLine } from "../src/services/perf/qaReadable.ts";

const SUMMARY =
  "[poc-summary] variant=a textModel=gemini-3.8-flash turns=2 medianFinalToToken=1100ms p90FinalToToken=2000ms medianTtsFirstChunk=500ms medianFinalToAudio=1900ms p90FinalToAudio=2600ms echoDrops=0 ttsStreams=2 bargeIns=1";
const USAGE =
  "[poc-usage] durationSec=104 turns=2 sttAudioSec=12.3 ttsAudioSec=8.1 sttOutEstimated=0 variant=b textModel=gemini-3.5-flash-lite usd=0.0032 qa=1";
const TURN =
  "[poc-turn] n=1 variant=a interimToFinal=200ms finalToToken=1100ms tokenToAudio=400ms ttsFirstChunk=500ms finalToAudio=1900ms";

interface QaHtml {
  dataset: { pocSummary?: string; pocUsage?: string; bootTiming?: string };
  getAttribute(name: string): string | null;
}

function qaHtml(): QaHtml {
  const attrs = new Map<string, string>();
  const dataset = {};
  for (const [prop, attr] of [
    ["pocSummary", "data-poc-summary"],
    ["pocUsage", "data-poc-usage"],
    ["bootTiming", "data-boot-timing"],
  ] as const) {
    Object.defineProperty(dataset, prop, {
      configurable: true,
      enumerable: true,
      get() {
        return attrs.get(attr);
      },
      set(value: string) {
        attrs.set(attr, String(value));
      },
    });
  }
  return {
    dataset: dataset as QaHtml["dataset"],
    getAttribute: (name: string) => attrs.get(name) ?? null,
  };
}

function qaWindow(search: string | undefined): Window {
  const win: {
    __AICALL_POC_SUMMARY__?: string;
    __AICALL_POC_USAGE__?: string;
    __AICALL_BOOT__?: string;
    location?: { search: string };
  } = {};
  if (search !== undefined) win.location = { search };
  return win as unknown as Window;
}

function withPage(
  page: { html: QaHtml | null | "bare"; win: Window | null; storage?: Storage },
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

const persistedQa = {
  getItem: (key: string) => (key === "oc_qa_mode" ? "1" : null),
  setItem() {},
  removeItem() {},
  clear() {},
  key: () => null,
  length: 0,
} as Storage;

test("pocQaKind maps the six prefixes and ignores other console lines", () => {
  assert.equal(pocQaKind(SUMMARY), "summary");
  assert.equal(pocQaKind(USAGE), "usage");
  assert.equal(pocQaKind(TURN), "other");
  assert.equal(pocQaKind("[poc-play] n=1 chunks=3 underruns=0 gaps=0 leadMs=40"), "other");
  assert.equal(pocQaKind("[poc-tts] n=1 seg=1 chars=40 firstChunkMs=500 chunks=4 audioSec=1.20 totalMs=800"), "other");
  assert.equal(pocQaKind("[poc] variant=a textModel=gemini-3.8-flash source=url"), "other");
  assert.equal(pocQaKind("[boot] auth=20ms data=30ms"), null);
  assert.equal(pocQaKind("[live-usage] turns=1"), null);
});

test("?qa=1 mirrors log/info poc lines to console.warn and writes summary/usage attributes", () => {
  const html = qaHtml();
  const win = qaWindow("?qa=1");
  const logs: string[] = [];
  const infos: string[] = [];
  const warns: string[] = [];
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.log = (msg?: unknown) => {
    logs.push(String(msg));
  };
  console.info = (msg?: unknown) => {
    infos.push(String(msg));
  };
  console.warn = (msg?: unknown) => {
    warns.push(String(msg));
  };
  try {
    withPage({ html, win }, () => {
      logPoc("[poc] stage=connect_start");
      logPoc(TURN);
      logPoc("[poc-play] n=1 chunks=3 underruns=0 gaps=0 leadMs=40");
      logPoc("[poc-tts] n=1 seg=1 chars=40 firstChunkMs=500 chunks=4 audioSec=1.20 totalMs=800");
      logPoc(SUMMARY);
      infoPoc(USAGE);
      assert.deepEqual(logs, [
        "[poc] stage=connect_start",
        TURN,
        "[poc-play] n=1 chunks=3 underruns=0 gaps=0 leadMs=40",
        "[poc-tts] n=1 seg=1 chars=40 firstChunkMs=500 chunks=4 audioSec=1.20 totalMs=800",
        SUMMARY,
      ]);
      assert.deepEqual(infos, [USAGE]);
      assert.deepEqual(warns, [
        "[poc] stage=connect_start",
        TURN,
        "[poc-play] n=1 chunks=3 underruns=0 gaps=0 leadMs=40",
        "[poc-tts] n=1 seg=1 chars=40 firstChunkMs=500 chunks=4 audioSec=1.20 totalMs=800",
        SUMMARY,
        USAGE,
      ]);
      assert.equal(html.getAttribute("data-poc-summary"), SUMMARY);
      assert.equal(html.dataset.pocSummary, SUMMARY);
      assert.equal(html.getAttribute("data-poc-usage"), USAGE);
      assert.equal(html.dataset.pocUsage, USAGE);
      assert.equal(win.__AICALL_POC_SUMMARY__, SUMMARY);
      assert.equal(win.__AICALL_POC_USAGE__, USAGE);
      assert.equal(html.getAttribute("data-boot-timing"), null);
    });
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
  }
});

test("without ?qa=1, poc lines stay on log/info and do not warn or write attributes", () => {
  const cases: (string | undefined)[] = ["", "?qa=0", "?qa=yes", "?qa=10", undefined];
  for (const search of cases) {
    const html = qaHtml();
    const win = qaWindow(search);
    const logs: string[] = [];
    const warns: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (msg?: unknown) => {
      logs.push(String(msg));
    };
    console.warn = (msg?: unknown) => {
      warns.push(String(msg));
    };
    try {
      withPage({ html, win, storage: persistedQa }, () => {
        logPoc(SUMMARY);
        logPoc(USAGE);
        logPoc(TURN);
        assert.deepEqual(logs, [SUMMARY, USAGE, TURN], `search ${String(search)}`);
        assert.deepEqual(warns, [], `search ${String(search)}`);
        assert.equal(html.getAttribute("data-poc-summary"), null, `search ${String(search)}`);
        assert.equal(html.getAttribute("data-poc-usage"), null, `search ${String(search)}`);
        assert.equal(win.__AICALL_POC_SUMMARY__, undefined, `search ${String(search)}`);
        assert.equal(win.__AICALL_POC_USAGE__, undefined, `search ${String(search)}`);
      });
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
  }
});

test("latest summary and usage attributes are overwritten per call under ?qa=1", () => {
  const html = qaHtml();
  const win = qaWindow("?x=2&qa=1");
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg?: unknown) => {
    warns.push(String(msg));
  };
  try {
    withPage({ html, win }, () => {
      const first = SUMMARY.replace("turns=2", "turns=1");
      const second = SUMMARY.replace("variant=a", "variant=b").replace(
        "textModel=gemini-3.8-flash",
        "textModel=gemini-3.5-flash-lite"
      );
      mirrorPocQaLine(first);
      mirrorPocQaLine(USAGE.replace("variant=b", "variant=a").replace("textModel=gemini-3.5-flash-lite", "textModel=gemini-3.8-flash"));
      assert.equal(html.getAttribute("data-poc-summary"), first);
      mirrorPocQaLine(second);
      mirrorPocQaLine(USAGE);
      assert.equal(html.getAttribute("data-poc-summary"), second);
      assert.equal(html.dataset.pocSummary, second);
      assert.equal(win.__AICALL_POC_SUMMARY__, second);
      assert.equal(html.getAttribute("data-poc-usage"), USAGE);
      assert.equal(win.__AICALL_POC_USAGE__, USAGE);
      assert.equal(warns.length, 4);
    });
  } finally {
    console.warn = originalWarn;
  }
});

test("turn/play/tts lines warn under ?qa=1 but do not touch summary or usage attributes", () => {
  const html = qaHtml();
  const win = qaWindow("qa=1");
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg?: unknown) => {
    warns.push(String(msg));
  };
  try {
    withPage({ html, win }, () => {
      mirrorPocQaLine(TURN);
      mirrorPocQaLine("[poc-play] n=1 chunks=1 underruns=0 gaps=0 leadMs=10");
      mirrorPocQaLine("[poc-tts] n=1 seg=1 chars=12 firstChunkMs=80 chunks=1 audioSec=0.40 totalMs=90");
      assert.equal(warns.length, 3);
      assert.equal(html.getAttribute("data-poc-summary"), null);
      assert.equal(html.getAttribute("data-poc-usage"), null);
      assert.equal(win.__AICALL_POC_SUMMARY__, undefined);
      assert.equal(win.__AICALL_POC_USAGE__, undefined);
    });
  } finally {
    console.warn = originalWarn;
  }
});

test("non-poc lines and missing document/window do not throw or warn when qa is off", () => {
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg?: unknown) => {
    warns.push(String(msg));
  };
  try {
    withPage({ html: null, win: null }, () => {
      mirrorPocQaLine(SUMMARY);
      mirrorPocQaLine("[boot] auth=1ms");
    });
    const html = qaHtml();
    withPage({ html, win: null }, () => {
      logPoc(SUMMARY);
      assert.equal(html.getAttribute("data-poc-summary"), null);
    });
    const win = qaWindow("?qa=1");
    withPage({ html: "bare", win }, () => {
      logPoc(SUMMARY);
      assert.equal(win.__AICALL_POC_SUMMARY__, SUMMARY);
      assert.deepEqual(warns, [SUMMARY]);
    });
  } finally {
    console.warn = originalWarn;
  }
});

test("boot publish still writes attributes when qa is off (only warn is qa-gated)", () => {
  const html = qaHtml();
  const win = qaWindow("");
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg?: unknown) => {
    warns.push(String(msg));
  };
  try {
    withPage({ html, win, storage: persistedQa }, () => {
      const line = "[boot] auth=20ms data=30ms home=40ms mistakes=60ms lectureLocal=50ms lectureServer=70ms";
      publishQaReadableLine(line, { datasetKey: "bootTiming", windowKey: "__AICALL_BOOT__" });
      assert.equal(html.getAttribute("data-boot-timing"), line);
      assert.equal(win.__AICALL_BOOT__, line);
      assert.deepEqual(warns, []);
    });
  } finally {
    console.warn = originalWarn;
  }
});
