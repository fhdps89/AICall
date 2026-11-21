import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkMicrophone,
  formatWrittenAnswer,
  MIC_FAIL_MESSAGES,
  MicFailReason,
  WRITTEN_ANSWER_MAX_LENGTH,
  WRITTEN_ANSWER_PREFIX,
} from "../src/ui/call/micCheck.ts";

function makeFakeStream() {
  const tracks = [
    { stopped: false, stop() { this.stopped = true; } },
    { stopped: false, stop() { this.stopped = true; } },
  ];
  const stream = {
    getTracks: () => tracks,
  } as unknown as MediaStream;
  return { stream, tracks };
}

test("checkMicrophone returns ok and keeps tracks running on success", async () => {
  const { stream, tracks } = makeFakeStream();
  const res = await checkMicrophone(async () => stream, 100);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.stream, stream);
  }
  assert.equal(tracks.every((t) => !t.stopped), true);
});

test("checkMicrophone returns timeout when getUserMedia hangs forever", async () => {
  const never = () => new Promise<MediaStream>(() => {});
  const start = Date.now();
  const res = await checkMicrophone(never, 30);
  const elapsed = Date.now() - start;

  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "timeout");
    assert.ok(res.message.length > 0);
  }
  assert.ok(elapsed < 500, `expected quick timeout, took ${elapsed}ms`);
});

test("checkMicrophone stops late stream tracks when stream resolves after timeout", async () => {
  const { stream, tracks } = makeFakeStream();
  let resolveLate!: (s: MediaStream) => void;
  const lateGetUserMedia = () =>
    new Promise<MediaStream>((resolve) => {
      resolveLate = resolve;
    });

  const res = await checkMicrophone(lateGetUserMedia, 20);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "timeout");
  }

  // Stream arrives after timeout: every track must be stopped.
  resolveLate(stream);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(tracks.every((t) => t.stopped), true);
});

test("checkMicrophone maps all expected error names to MicFailReason", async () => {
  const cases: Array<[string, MicFailReason]> = [
    ["NotAllowedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "not_found"],
    ["DevicesNotFoundError", "not_found"],
    ["OverconstrainedError", "not_found"],
    ["NotReadableError", "in_use"],
    ["TrackStartError", "in_use"],
    ["NotSupportedError", "unsupported"],
    ["NotSupported", "unsupported"],
    ["AbortError", "unknown"],
    ["WeirdError", "unknown"],
  ];

  for (const [errName, expectedReason] of cases) {
    const res = await checkMicrophone(async () => {
      throw Object.assign(new Error(errName), { name: errName });
    }, 100);
    assert.equal(res.ok, false, `expected failure for ${errName}`);
    if (!res.ok) {
      assert.equal(res.reason, expectedReason, `error ${errName} should map to ${expectedReason}`);
    }
  }
});

test("checkMicrophone returns unsupported when mediaDevices/getUserMedia is missing", async () => {
  const resUndefined = await checkMicrophone(undefined, 100);
  assert.equal(resUndefined.ok, false);
  if (!resUndefined.ok) {
    assert.equal(resUndefined.reason, "unsupported");
  }

  const resNull = await checkMicrophone(null, 100);
  assert.equal(resNull.ok, false);
  if (!resNull.ok) {
    assert.equal(resNull.reason, "unsupported");
  }
});

test("MIC_FAIL_MESSAGES has non-empty distinct messages for every reason", () => {
  const reasons: MicFailReason[] = [
    "unsupported",
    "denied",
    "not_found",
    "in_use",
    "timeout",
    "unknown",
  ];
  const messages = reasons.map((r) => MIC_FAIL_MESSAGES[r]);
  for (const m of messages) {
    assert.equal(typeof m, "string");
    assert.ok(m.trim().length > 0, "message must not be empty");
  }
  assert.equal(new Set(messages).size, reasons.length, "each reason must have a distinct message");
});

test("formatWrittenAnswer rejects blank text, trims, truncates to 500 chars, and adds prefix", () => {
  assert.equal(formatWrittenAnswer(""), null);
  assert.equal(formatWrittenAnswer("   \n\t  "), null);

  const formatted = formatWrittenAnswer("  I work at a shipyard.  ");
  assert.deepEqual(formatted, {
    displayText: "I work at a shipyard.",
    prompt: `${WRITTEN_ANSWER_PREFIX}I work at a shipyard.`,
  });

  const longInput = `  ${"a".repeat(WRITTEN_ANSWER_MAX_LENGTH + 75)}  `;
  const truncated = formatWrittenAnswer(longInput);
  assert.ok(truncated);
  assert.equal(truncated.displayText.length, WRITTEN_ANSWER_MAX_LENGTH);
  assert.equal(truncated.displayText, "a".repeat(WRITTEN_ANSWER_MAX_LENGTH));
  assert.equal(truncated.prompt, `${WRITTEN_ANSWER_PREFIX}${"a".repeat(WRITTEN_ANSWER_MAX_LENGTH)}`);
});

test("GeminiLiveProvider skipMic skips getUserMedia and sendTextPrompt returns socket send status", async () => {
  const g = globalThis as any;
  const prevWindow = g.window;
  const prevWebSocket = g.WebSocket;
  const prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  let getUserMediaCalls = 0;
  let lastSocket!: FakeWebSocket;
  const sentPayloads: string[] = [];

  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    url = "ws://localhost/api/gemini/live?token=";
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    constructor(url: string) {
      this.url = url;
      lastSocket = this;
      setTimeout(() => {
        this.onopen?.();
        this.onmessage?.({ data: JSON.stringify({ type: "ready" }) });
      }, 0);
    }
    send(data: string) {
      sentPayloads.push(data);
    }
    close() {
      this.readyState = 3;
    }
  }

  g.window = {
    location: { protocol: "http:", host: "localhost:3000" },
  };
  g.WebSocket = FakeWebSocket;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          getUserMediaCalls++;
          return makeFakeStream().stream;
        },
      },
    },
  });

  try {
    const { GeminiLiveProvider } = await import(
      "../src/services/providers/geminiLiveProvider.ts"
    );
    const provider = new GeminiLiveProvider();

    const uiTranscripts: Array<{ text: string; isUser: boolean }> = [];
    const loggedAll: Array<{ role: string; text: string }> = [];

    await provider.connect({
      sessionId: "test-text-only",
      systemPrompt: "You are a tutor.",
      skipMic: true,
      onAudioData: () => {},
      onTranscript: (text, isUser) => {
        uiTranscripts.push({ text, isUser });
      },
      onTranscriptLogged: (_item, all) => {
        loggedAll.splice(0, loggedAll.length, ...all.map((x) => ({ role: x.role, text: x.text })));
      },
      onStatusChange: () => {},
    });

    assert.equal(getUserMediaCalls, 0, "skipMic: true must not call navigator.mediaDevices.getUserMedia");

    provider.appendUserText("   ");
    assert.equal(provider.getLiveTranscript().length, 0);

    const formatted = formatWrittenAnswer("I work at a shipyard.");
    assert.ok(formatted);
    assert.equal(provider.sendTextPrompt(formatted.prompt), true);
    provider.appendUserText(formatted.displayText);

    assert.equal(provider.getLiveTranscript().length, 1);
    assert.equal(provider.getLiveTranscript()[0].role, "user");
    assert.equal(provider.getLiveTranscript()[0].text, "I work at a shipyard.");
    assert.deepEqual(uiTranscripts, [{ text: "I work at a shipyard.", isUser: true }]);
    assert.deepEqual(loggedAll, [{ role: "user", text: "I work at a shipyard." }]);

    const textPrompts = sentPayloads
      .map((raw) => JSON.parse(raw))
      .filter((m) => m.type === "text_prompt");
    // connect() now also sends the tutor kickoff as text_prompt; assert the written answer is present.
    const textPromptMsg = textPrompts.find((m) =>
      String(m.text).startsWith("The learner answers in writing:")
    );
    assert.equal(textPromptMsg?.text, "The learner answers in writing: I work at a shipyard.");

    // Closed socket: sendTextPrompt must return false and send nothing.
    lastSocket.readyState = 3;
    const countBeforeClosedSend = sentPayloads.length;
    assert.equal(provider.sendTextPrompt("The learner answers in writing: Should not send"), false);
    assert.equal(sentPayloads.length, countBeforeClosedSend);

    await provider.disconnect(false);
    // Disconnected (ws === null): sendTextPrompt must return false.
    assert.equal(provider.sendTextPrompt("The learner answers in writing: After disconnect"), false);
  } finally {
    g.window = prevWindow;
    g.WebSocket = prevWebSocket;
    if (prevNavigatorDesc) {
      Object.defineProperty(globalThis, "navigator", prevNavigatorDesc);
    } else {
      delete g.navigator;
    }
  }
});
