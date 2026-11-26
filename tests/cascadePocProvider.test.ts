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

test('mic opens only after the first tutor audio: never on fallback, once on success', async () => {
  const withMic = (statuses: string[]) => ({ ...opts(statuses), skipMic: false, onMicWarning() {} });
  FakeWs.all = [];
  micOpens = 0;
  const failing = new CascadePocProvider({ connectBudgetMs: 50 });
  await quiet(async () => {
    const done = failing.connect(withMic([])).catch(() => {});
    await tick();
    FakeWs.all[0].open();
    FakeWs.all[0].push({ type: 'ready' });
    await done; // budget runs out without tutor audio
  });
  assert.equal(micOpens, 0, 'fallback path never touched the mic');

  FakeWs.all = [];
  const ok = new CascadePocProvider({ connectBudgetMs: 2000 });
  await quiet(async () => {
    const statuses: string[] = [];
    const done = ok.connect(withMic(statuses));
    await tick();
    FakeWs.all[0].open();
    FakeWs.all[0].push({ type: 'ready' });
    await tick();
    assert.equal(micOpens, 0, 'not before the first tutor audio');
    FakeWs.all[0].push({ type: 'audio', audio: Buffer.alloc(4).toString('base64'), mimeType: 'audio/pcm;rate=24000' });
    await done;
  });
  assert.equal(micOpens, 1);
  await quiet(() => ok.disconnect());
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
