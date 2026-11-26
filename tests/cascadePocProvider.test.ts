// Browser provider with a fake WebSocket (no network, no Gemini). Audio contexts are absent in
// node, so playback init fails softly and skipMic keeps the mic out, as in a text-only call.
import test from 'node:test';
import assert from 'node:assert/strict';

class FakeWs {
  static OPEN = 1;
  static all: FakeWs[] = [];
  url: string;
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWs.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(msg: any) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

(globalThis as any).window = { location: { protocol: 'https:', host: 'app.test' } };
let micOpens = 0;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: async () => {
        micOpens++;
        return { getTracks: () => [{ stop() {} }] };
      },
    },
  },
});
(globalThis as any).WebSocket = FakeWs;

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
};
const tick = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

const { CascadePocProvider } = await import('../src/services/providers/cascadePocProvider.ts');
const { PocFallbackProvider } = await import('../src/services/providers/cascadeFallbackProvider.ts');

function opts(statuses: string[], extra: Record<string, unknown> = {}) {
  return {
    sessionId: 's',
    systemPrompt: 'SYS',
    voiceName: 'Kore',
    skipMic: true,
    onAudioData() {},
    onTranscript() {},
    onStatusChange: (s: string) => void statuses.push(s),
    ...extra,
  } as any;
}

async function connected(p: InstanceType<typeof CascadePocProvider>, statuses: string[]) {
  const done = p.connect(opts(statuses));
  await tick();
  const ws = FakeWs.all[FakeWs.all.length - 1];
  ws.open();
  ws.push({ type: 'ready', model: 'cascade-poc' });
  await tick();
  ws.push({ type: 'audio', audio: Buffer.alloc(4).toString('base64'), mimeType: 'audio/pcm;rate=24000' });
  await done;
  return ws;
}

test('connect: init on the cascade path, kickoff after ready, connected only after first tutor audio', async () => {
  FakeWs.all = [];
  const statuses: string[] = [];
  const p = new CascadePocProvider({ connectBudgetMs: 2000 });
  await quiet(async () => {
    const done = p.connect(opts(statuses));
    await tick();
    const ws = FakeWs.all[0];
    assert.match(ws.url, /^wss:\/\/app\.test\/api\/gemini\/cascade\?token=/);
    ws.open();
    assert.deepEqual(ws.sent[0], { type: 'init', systemInstruction: 'SYS', voiceName: 'Kore', history: [] });
    ws.push({ type: 'ready' });
    await tick();
    assert.equal(ws.sent[1].type, 'text_prompt', 'kickoff sent after ready');
    assert.ok(!statuses.includes('connected'), 'not connected before the first tutor audio');
    ws.push({ type: 'audio', audio: Buffer.alloc(4).toString('base64'), mimeType: 'audio/pcm;rate=24000' });
    await done;
    assert.equal(statuses[statuses.length - 1], 'connected');
  });
});

test('connect rejects (→ fallback) on fallback_required, close before ready, or the 8 s budget', async () => {
  for (const scenario of ['fallback', 'closed', 'timeout', 'noAudio']) {
    FakeWs.all = [];
    const p = new CascadePocProvider({ connectBudgetMs: 50 });
    const err: any = await quiet(async () => {
      const done = p.connect(opts([])).then(() => null, (e) => e);
      await tick();
      const ws = FakeWs.all[0];
      ws.open();
      if (scenario === 'fallback') ws.push({ type: 'fallback_required', error: 'cascade_connect_failed' });
      if (scenario === 'closed') ws.drop(1011);
      if (scenario === 'noAudio') ws.push({ type: 'ready' });
      return done;
    });
    assert.ok(err, `${scenario} must reject`);
    const want = { fallback: 'POC_SERVER_cascade_connect_failed', closed: 'POC_CLOSED_BEFORE_READY', timeout: 'POC_CONNECT_TIMEOUT', noAudio: 'POC_CONNECT_TIMEOUT' }[scenario];
    assert.equal(err.code, want, scenario);
  }
});

test('drop after connect: reconnects with the transcript history, max 3, and keeps PoC usage', async () => {
  FakeWs.all = [];
  const statuses: string[] = [];
  const p = new CascadePocProvider({ connectBudgetMs: 2000, reconnectDelayMs: 1 });
  await quiet(async () => {
    const ws1 = await connected(p, statuses);
    ws1.push({ type: 'output_transcript', text: 'Hello!' });
    ws1.push({ type: 'input_transcript', text: 'Hi.' });
    ws1.push({ type: 'poc_usage', usage: { sttAudioSec: 10, turns: 1 } });
    ws1.drop();
    await new Promise((r) => setTimeout(r, 10));
    await tick();
    const ws2 = FakeWs.all[1];
    ws2.open();
    assert.deepEqual(ws2.sent[0].history, [{ role: 'model', text: 'Hello!' }, { role: 'user', text: 'Hi.' }]);
    ws2.push({ type: 'ready' });
    await tick();
    assert.equal(ws2.sent.length, 1, 'no second kickoff on reconnect');
    ws2.push({ type: 'poc_usage', usage: { sttAudioSec: 5, turns: 1 } });
    assert.equal(p.getPocUsage().sttAudioSec, 15, 'usage from the first server session is kept');
    assert.equal(p.getPocUsage().turns, 2);
    assert.ok(statuses.includes('reconnecting'));
    // Three more drops with failing reconnects → error status.
    for (let i = 0; i < 4; i++) {
      FakeWs.all[FakeWs.all.length - 1].drop();
      await new Promise((r) => setTimeout(r, 10));
      await tick();
      const next = FakeWs.all[FakeWs.all.length - 1];
      if (next.readyState === 0) next.drop(1011);
      await tick();
    }
    assert.equal(statuses[statuses.length - 1], 'error');
  });
  await p.disconnect();
});

test('hang-up during connect: no fallback to the normal engine', async () => {
  FakeWs.all = [];
  let liveMade = 0;
  const w = new PocFallbackProvider(
    () => new CascadePocProvider({ connectBudgetMs: 2000 }),
    () => {
      liveMade++;
      return { connect: async () => {}, disconnect: async () => {} } as any;
    }
  );
  await quiet(async () => {
    const done = w.connect(opts([]));
    await tick();
    FakeWs.all[0].open();
    await w.disconnect();
    await done;
  });
  assert.equal(liveMade, 0);
});

class FakeAudioCtx {
  state = 'running';
  currentTime = 0;
  destination = {};
  async resume() {}
  async close() {}
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createMediaStreamDestination() {
    return { stream: { id: 'rec' } };
  }
  createScriptProcessor() {
    const node = { connect() {}, disconnect() {}, onaudioprocess: null as any };
    FakeAudioCtx.processors.push(node);
    return node;
  }
  createBuffer(_c: number, length: number, rate: number) {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    return { buffer: null, connect() {}, start() {}, stop() {}, onended: null };
  }
  createGain() {
    return { gain: { value: 1 }, connect() {} };
  }
  static processors: { onaudioprocess: any }[] = [];
}
const micFrame = () => ({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.1) } });

test('mic handoff: opened at connect start, never attached or left open on fallback, attached once on success', async () => {
  const win = (globalThis as any).window;
  win.AudioContext = FakeAudioCtx;
  const realNav = (globalThis as any).navigator;
  const tracks: { stopped: boolean }[] = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          micOpens++;
          const tr = { stopped: false, stop() { tr.stopped = true; } };
          tracks.push(tr);
          return { getTracks: () => [tr] };
        },
      },
    },
  });
  try {
    const ready: unknown[] = [];
    const withMic = (statuses: string[]) => ({
      ...opts(statuses),
      skipMic: false,
      onMicWarning() {},
      onMediaStreamReady: (s: unknown) => void ready.push(s),
    });

    // 1) Fallback: the mic opened in parallel is stopped before the wrapper starts the normal engine.
    FakeWs.all = [];
    micOpens = 0;
    let liveConnectSawOpenMic: boolean | null = null;
    const fake = {
      name: 'gemini-live-fake',
      async connect() {
        liveConnectSawOpenMic = tracks.some((tr) => !tr.stopped);
      },
      async disconnect() {},
      sendAudioChunk() {},
      sendTextPrompt: () => true,
      appendUserText() {},
      sendControlCommand: () => true,
      getLiveTranscript: () => [],
      getResumeToken: () => null,
      getMediaStream: () => null,
      getConnectionStats: () => ({}),
    } as any;
    const wrapper = new PocFallbackProvider(
      () => new CascadePocProvider({ connectBudgetMs: 60 }),
      () => fake
    );
    await quiet(async () => {
      const done = wrapper.connect(withMic([]));
      await tick();
      assert.equal(micOpens, 1, 'mic opens at connect start, before ready');
      FakeWs.all[0].open();
      FakeWs.all[0].push({ type: 'ready' });
      await done; // budget runs out without tutor audio -> fallback
    });
    assert.equal(liveConnectSawOpenMic, false, 'the PoC mic was stopped before the normal engine connected');
    assert.equal(ready.length, 0, 'no recorder was attached to the PoC mic on fallback');

    // 2) Success: one mic, recorder attached exactly once, only after the first tutor audio.
    FakeWs.all = [];
    micOpens = 0;
    tracks.length = 0;
    FakeAudioCtx.processors = [];
    const ok = new CascadePocProvider({ connectBudgetMs: 2000 });
    await quiet(async () => {
      const done = ok.connect(withMic([]));
      await tick();
      const proc = FakeAudioCtx.processors.at(-1)!;
      FakeWs.all[0].open();
      proc.onaudioprocess(micFrame());
      assert.equal(FakeWs.all[0].sent.filter((m) => m.type === 'realtime_audio').length, 0, 'no mic audio before ready');
      FakeWs.all[0].push({ type: 'ready' });
      await tick();
      assert.equal(micOpens, 1);
      assert.equal(ready.length, 0, 'recorder waits for the engine to be committed');
      proc.onaudioprocess(micFrame());
      assert.equal(FakeWs.all[0].sent.filter((m) => m.type === 'realtime_audio').length, 1, 'mic audio flows after ready');
      FakeWs.all[0].push({ type: 'audio', audio: Buffer.alloc(4).toString('base64'), mimeType: 'audio/pcm;rate=24000' });
      await done;
    });
    assert.equal(micOpens, 1);
    assert.equal(ready.length, 1);
    await quiet(() => ok.disconnect());
    assert.ok(tracks.every((tr) => tr.stopped), 'hang-up releases the mic');
  } finally {
    delete win.AudioContext;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: realNav });
  }
});

test('hang-up during the handshake ends connect at once with POC_CANCELLED', async () => {
  FakeWs.all = [];
  const p = new CascadePocProvider({ connectBudgetMs: 8000 });
  const t0 = Date.now();
  const err: any = await quiet(async () => {
    const done = p.connect(opts([])).then(() => null, (e) => e);
    await tick();
    FakeWs.all[0].open();
    await p.disconnect();
    return done;
  });
  assert.equal(err?.code, 'POC_CANCELLED');
  assert.ok(Date.now() - t0 < 1000, 'did not wait for the 8 s budget');
});

test('playback diagnostics: one [poc-play] line per tutor turn with chunk and underrun counts', async () => {
  const win = (globalThis as any).window;
  win.AudioContext = FakeAudioCtx;
  const lines: string[] = [];
  try {
    FakeWs.all = [];
    const p = new CascadePocProvider({ connectBudgetMs: 2000 });
    await quiet(async () => {
      const ws = await connected(p, []);
      const chunk = { type: 'audio', audio: Buffer.alloc(480).toString('base64'), mimeType: 'audio/pcm;rate=24000' };
      ws.push(chunk);
      ws.push(chunk);
      const orig = console.log;
      console.log = (...a: unknown[]) => void lines.push(a.join(' '));
      try {
        ws.push({ type: 'turnComplete' });
        ws.push(chunk);
        ws.push({ type: 'turnComplete' });
      } finally {
        console.log = orig;
      }
      await p.disconnect();
    });
  } finally {
    delete win.AudioContext;
  }
  const play = lines.filter((l) => l.startsWith('[poc-play]'));
  assert.equal(play.length, 2);
  assert.match(play[0], /^\[poc-play\] n=1 chunks=3 underruns=\d+ gaps=0 leadMs=\d+$/);
  assert.match(play[1], /^\[poc-play\] n=2 chunks=1 underruns=\d+ gaps=0 leadMs=\d+$/);
});

test('mic edge cases: permission prompt still open at fallback, and a denied mic', async () => {
  const win = (globalThis as any).window;
  win.AudioContext = FakeAudioCtx;
  const realNav = (globalThis as any).navigator;
  let grant!: () => void;
  const track = { stopped: false, stop() { track.stopped = true; } };
  let deny = false;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () => {
          if (deny) return Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
          return new Promise((r) => (grant = () => r({ getTracks: () => [track] })));
        },
      },
    },
  });
  try {
    // 1) Prompt still open when the budget runs out: the late grant is released before Live connects.
    FakeWs.all = [];
    const order: string[] = [];
    const ready: unknown[] = [];
    const fake = {
      name: 'gemini-live-fake',
      async connect() {
        order.push(`live.connect stopped=${track.stopped}`);
      },
      async disconnect() {},
    } as any;
    const wrapper = new PocFallbackProvider(() => new CascadePocProvider({ connectBudgetMs: 40 }), () => fake);
    await quiet(async () => {
      const done = wrapper.connect({ ...opts([]), skipMic: false, onMicWarning() {}, onMediaStreamReady: (s: unknown) => void ready.push(s) });
      await tick();
      FakeWs.all[0].open();
      FakeWs.all[0].push({ type: 'ready' });
      await new Promise((r) => setTimeout(r, 80)); // budget gone, wrapper is in poc.disconnect waiting for the prompt
      grant();
      await done;
    });
    assert.deepEqual(order, ['live.connect stopped=true']);
    assert.equal(ready.length, 0);

    // 2) Denied mic: the call still connects (tutor audible) and the user gets the warning once.
    deny = true;
    FakeWs.all = [];
    const warnings: string[] = [];
    const statuses: string[] = [];
    const p = new CascadePocProvider({ connectBudgetMs: 2000 });
    await quiet(async () => {
      const done = p.connect({ ...opts(statuses), skipMic: false, onMicWarning: (m: string) => void warnings.push(m) });
      await tick();
      FakeWs.all[0].open();
      FakeWs.all[0].push({ type: 'ready' });
      await tick();
      FakeWs.all[0].push({ type: 'audio', audio: Buffer.alloc(4).toString('base64'), mimeType: 'audio/pcm;rate=24000' });
      await done;
      await p.disconnect();
    });
    assert.ok(statuses.includes('connected'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /마이크 권한/);
  } finally {
    delete win.AudioContext;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: realNav });
  }
});

test('playback diagnostics: an interrupted turn is logged on its own and does not leak into the next', async () => {
  const win = (globalThis as any).window;
  win.AudioContext = FakeAudioCtx;
  const lines: string[] = [];
  try {
    FakeWs.all = [];
    const p = new CascadePocProvider({ connectBudgetMs: 2000 });
    await quiet(async () => {
      const ws = await connected(p, []);
      const chunk = { type: 'audio', audio: Buffer.alloc(480).toString('base64'), mimeType: 'audio/pcm;rate=24000' };
      ws.push({ type: 'turnComplete' });
      ws.push(chunk);
      ws.push(chunk);
      const orig = console.log;
      console.log = (...a: unknown[]) => void lines.push(a.join(' '));
      try {
        ws.push({ type: 'interrupted' });
        ws.push(chunk);
        ws.push({ type: 'turnComplete' });
      } finally {
        console.log = orig;
      }
      await p.disconnect();
    });
  } finally {
    delete win.AudioContext;
  }
  const play = lines.filter((l) => l.startsWith('[poc-play]'));
  assert.equal(play.length, 2);
  assert.match(play[0], /^\[poc-play\] n=2 chunks=2 .* interrupted=1$/);
  assert.match(play[1], /^\[poc-play\] n=3 chunks=1 underruns=\d+ gaps=0 leadMs=\d+$/);
});

test('playback diagnostics count real underruns and 1 s+ holes per turn, and reset at a reconnect', async () => {
  const win = (globalThis as any).window;
  win.AudioContext = FakeAudioCtx;
  const lines: string[] = [];
  let ctx: FakeAudioCtx | null = null;
  const RealCtx = FakeAudioCtx;
  win.AudioContext = class extends RealCtx {
    constructor() {
      super();
      ctx = this;
    }
  };
  try {
    FakeWs.all = [];
    const p = new CascadePocProvider({ connectBudgetMs: 2000, reconnectDelayMs: 1 } as any);
    await quiet(async () => {
      const ws = await connected(p, []);
      ws.push({ type: 'turnComplete' });
      // 0.1 s chunks (2400 samples at 24 kHz).
      const chunk = { type: 'audio', audio: Buffer.alloc(4800).toString('base64'), mimeType: 'audio/pcm;rate=24000' };
      const orig = console.log;
      console.log = (...a: unknown[]) => void lines.push(a.join(' '));
      try {
        ctx!.currentTime = 10;
        ws.push(chunk); // new utterance (first chunk of the turn)
        ctx!.currentTime = 10.5; // past the scheduled end (≈10.22) but < 1 s later → underrun
        ws.push(chunk);
        ctx!.currentTime = 12; // > 1 s after the scheduled end → audible hole (gap)
        ws.push(chunk);
        ws.push({ type: 'turnComplete' });
        ctx!.currentTime = 12.1;
        ws.push(chunk); // next turn, partial
      } finally {
        console.log = orig;
      }
      const lines2: string[] = [];
      console.log = (...a: unknown[]) => void lines2.push(a.join(' '));
      const warn = console.warn;
      console.warn = (...a: unknown[]) => void lines2.push(a.join(' '));
      try {
        ws.drop(); // reconnect: the half-played turn is logged on its own
      } finally {
        console.log = orig;
        console.warn = warn;
      }
      lines.push(...lines2);
      await p.disconnect();
    });
  } finally {
    delete win.AudioContext;
  }
  const play = lines.filter((l) => l.startsWith('[poc-play]'));
  assert.match(play[0], /^\[poc-play\] n=2 chunks=3 underruns=1 gaps=1 leadMs=\d+$/);
  assert.match(play[1], /^\[poc-play\] n=3 chunks=1 underruns=0 gaps=0 leadMs=\d+ interrupted=1$/);
});
