import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodeLiveMessage, createSerialQueue } from '../src/services/providers/liveMessage.ts';
import { GeminiLiveProvider, CALL_KICKOFF_PROMPT } from '../src/services/providers/geminiLiveProvider.ts';
import { validateClientMessage } from '../src/services/providers/liveWire.ts';
import { auth } from '../src/services/firebase/config.ts';

const rootDir = path.resolve(import.meta.dirname, '..');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test('decodeLiveMessage parses string, Blob, ArrayBuffer, Uint8Array (with byteOffset), and multibyte Korean JSON', async () => {
  const payload = { setupComplete: {}, greeting: '안녕하세요 튜터입니다!' };
  const jsonText = JSON.stringify(payload);
  const encoded = new TextEncoder().encode(jsonText);

  assert.deepEqual(await decodeLiveMessage(jsonText), payload);

  const blob = new Blob([jsonText], { type: 'application/json' });
  assert.deepEqual(await decodeLiveMessage(blob), payload);

  const arrayBuffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
  assert.deepEqual(await decodeLiveMessage(arrayBuffer), payload);

  // 앞뒤에 잘못된 바이트가 있는 큰 버퍼에서 byteOffset/byteLength 구간만 정확히 디코딩해야 한다.
  const padded = new Uint8Array(encoded.byteLength + 10);
  padded.fill(0x7b); // '{' garbage around payload
  padded.set(encoded, 4);
  const offsetView = new Uint8Array(padded.buffer, 4, encoded.byteLength);
  assert.deepEqual(await decodeLiveMessage(offsetView), payload);
});

test('decodeLiveMessage rejects on malformed JSON across payload types', async () => {
  await assert.rejects(decodeLiveMessage('{not-valid-json'), SyntaxError);
  await assert.rejects(decodeLiveMessage(new Blob(['{bad'])), SyntaxError);
  await assert.rejects(decodeLiveMessage(new TextEncoder().encode('{bad').buffer), SyntaxError);
  await assert.rejects(decodeLiveMessage(12345 as any), TypeError);
});

test('createSerialQueue preserves enqueue order even when an earlier task is slower and continues after failure', async () => {
  const queue = createSerialQueue();
  const events: string[] = [];

  const p1 = queue.enqueue(async () => {
    events.push('1:start');
    await sleep(10);
    events.push('1:end');
  });

  const p2 = queue
    .enqueue(async () => {
      events.push('2:fail');
      throw new Error('boom');
    })
    .catch((err) => {
      events.push(`2:caught:${err.message}`);
    });

  const p3 = queue.enqueue(async () => {
    events.push('3:fast');
  });

  await Promise.all([p1, p2, p3]);
  assert.deepEqual(events, ['1:start', '1:end', '2:fail', '2:caught:boom', '3:fast']);
});

test('geminiLiveProvider.ts source uses liveWire/liveKickoff without raw JSON.parse(event.data) or URL-based wire branching', () => {
  const src = fs.readFileSync(path.join(rootDir, 'src/services/providers/geminiLiveProvider.ts'), 'utf-8');
  assert.equal(/JSON\.parse\s*\(\s*event\.data\s*\)/.test(src), false);
  assert.equal(src.includes('.url.includes('), false);
  assert.equal(/type:\s*["']realtime_audio["']/.test(src), false);
  assert.equal(/type:\s*["']text_prompt["']/.test(src), false);
  assert.match(src, /export\s+const\s+CALL_KICKOFF_PROMPT\s*=/);
  assert.match(src, /shouldSendKickoff\s*\(/);
  assert.match(src, /sendTextPrompt\s*\(\s*CALL_KICKOFF_PROMPT\s*\)/);
});

// Slow Blob mock to verify serial queue ordering across setupComplete -> wireWebSocketEvents transition.
function createDelayedBlob(text: string, delayMs: number): Blob {
  return {
    async text() {
      await sleep(delayMs);
      return text;
    },
  } as unknown as Blob;
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static autoOpen = true;
  static urlRewrite?: (url: string) => string;

  public url: string;
  public readyState = FakeWebSocket.CONNECTING;
  public sent: string[] = [];
  public onopen: ((ev: any) => void) | null = null;
  public onmessage: ((ev: { data: any }) => void) | null = null;
  public onerror: ((ev: any) => void) | null = null;
  public onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;

  constructor(url: string) {
    this.url = FakeWebSocket.urlRewrite ? FakeWebSocket.urlRewrite(url) : url;
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.autoOpen) {
      queueMicrotask(() => this.open());
    }
  }

  open(): void {
    if (this.readyState === FakeWebSocket.CONNECTING) {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.({});
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  emitMessage(data: any): void {
    this.onmessage?.({ data });
  }

  emitClose(code: number, reason = '', wasClean = false): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean });
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: '', wasClean: true });
  }
}

function withFakeBrowserEnv(run: () => Promise<void>): Promise<void> {
  const g = globalThis as any;
  const origWebSocket = g.WebSocket;
  const origFetch = g.fetch;
  const origWindow = g.window;
  const origLocation = g.location;
  const origBtoa = g.btoa;
  const origAtob = g.atob;
  const origCurrentUser = Object.getOwnPropertyDescriptor(auth, 'currentUser');

  FakeWebSocket.instances = [];
  FakeWebSocket.autoOpen = true;
  FakeWebSocket.urlRewrite = undefined;
  g.WebSocket = FakeWebSocket;
  g.window = g;
  g.location = { protocol: 'https:', host: 'localhost:3000' };
  g.btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
  g.atob = (s: string) => Buffer.from(s, 'base64').toString('binary');
  g.fetch = async () => new Response(JSON.stringify({ ok: true, token: 'ephemeral-test-token' }), { status: 200 });
  Object.defineProperty(auth, 'currentUser', {
    configurable: true,
    value: { getIdToken: async () => 'fake-firebase-id-token' },
  });

  return run().finally(() => {
    FakeWebSocket.autoOpen = true;
    FakeWebSocket.urlRewrite = undefined;
    g.WebSocket = origWebSocket;
    g.fetch = origFetch;
    g.window = origWindow;
    g.location = origLocation;
    g.btoa = origBtoa;
    g.atob = origAtob;
    if (origCurrentUser) {
      Object.defineProperty(auth, 'currentUser', origCurrentUser);
    } else {
      delete (auth as any).currentUser;
    }
  });
}

test('GeminiLiveProvider connects via Blob setupComplete, keeps frame order, and sends kickoff once without mic', async () => {
  await withFakeBrowserEnv(async () => {
    const provider = new GeminiLiveProvider();
    const statuses: string[] = [];
    const transcripts: Array<{ text: string; isUser: boolean }> = [];
    const logged: number[] = [];
    let micWarned = false;

    const connectPromise = provider.connect({
      sessionId: 'sess-new-1',
      systemPrompt: 'System prompt',
      onAudioData: () => {},
      onTranscript: (text, isUser) => transcripts.push({ text, isUser }),
      onTranscriptLogged: (_item, all) => logged.push(all.length),
      onStatusChange: (status) => statuses.push(status),
      onMicWarning: () => {
        micWarned = true;
      },
    });

    // Wait for FakeWebSocket to open and receive the setup payload.
    await waitFor(() => FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].sent.length >= 1);
    assert.equal(FakeWebSocket.instances.length, 1);
    const ws = FakeWebSocket.instances[0];
    assert.equal(ws.sent.length, 1);
    assert.ok(JSON.parse(ws.sent[0]).setup);

    // Slow Blob setupComplete followed immediately by fast Blob outputTranscription:
    // the second frame must not be dropped or overtake setupComplete.
    ws.emitMessage(createDelayedBlob(JSON.stringify({ setupComplete: {} }), 15));
    ws.emitMessage(new Blob([JSON.stringify({ serverContent: { outputTranscription: { text: 'Hi there!' } } })]));

    await connectPromise;
    await waitFor(() => transcripts.length >= 1);

    assert.equal(micWarned, true);
    assert.ok(statuses.includes('connected'));
    assert.equal(provider.getConnectionStats().connectionPath, 'direct');
    assert.equal(provider.getConnectionStats().directFailCount, 0);

    // Kickoff prompt sent exactly once using LiveClientRealtimeInput wire format.
    const sentPayloads = ws.sent.slice(1).map((s) => JSON.parse(s));
    const kickoffPayloads = sentPayloads.filter((p) => p.realtimeInput?.text === CALL_KICKOFF_PROMPT);
    assert.equal(kickoffPayloads.length, 1);
    assert.equal(sentPayloads[0].clientContent, undefined);

    // Kickoff prompt must never be recorded as user transcript; tutor's second Blob must arrive.
    assert.deepEqual(transcripts, [{ text: 'Hi there!', isUser: false }]);
    assert.deepEqual(
      provider.getLiveTranscript().map((t) => ({ role: t.role, text: t.text })),
      [{ role: 'model', text: 'Hi there!' }],
    );
    assert.equal(logged.length, 1);

    // sendAudioChunk uses realtimeInput.audio instead of deprecated mediaChunks.
    const pcm = new Uint8Array([1, 2, 3, 4]).buffer;
    provider.sendAudioChunk(pcm);
    const audioPayload = JSON.parse(ws.sent[ws.sent.length - 1]);
    assert.equal(audioPayload.realtimeInput?.audio?.mimeType, 'audio/pcm;rate=16000');
    assert.equal(typeof audioPayload.realtimeInput?.audio?.data, 'string');
    assert.equal(audioPayload.realtimeInput?.mediaChunks, undefined);

    await provider.disconnect(false);
  });
});

test('GeminiLiveProvider does not send kickoff when resumeToken is provided or during GoAway reconnection after tutor spoke', async (t) => {
  await withFakeBrowserEnv(async () => {
    // 1) Initial connect with resumeToken -> 0 kickoffs
    const resumedProvider = new GeminiLiveProvider();
    const p1 = resumedProvider.connect({
      sessionId: 'sess-resume',
      systemPrompt: 'System prompt',
      resumeToken: 'handle-abc',
      onAudioData: () => {},
      onTranscript: () => {},
      onStatusChange: () => {},
    });

    await waitFor(() => FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].sent.length >= 1);
    const ws1 = FakeWebSocket.instances[0];
    ws1.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
    await p1;
    assert.equal(
      ws1.sent.filter((s) => JSON.parse(s).realtimeInput?.text === CALL_KICKOFF_PROMPT).length,
      0,
    );
    await resumedProvider.disconnect(false);

    // 2a) New call -> 1 kickoff -> tutor output arrives -> GoAway reconnect -> no second kickoff
    FakeWebSocket.instances = [];
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const liveProvider = new GeminiLiveProvider();
      const reconnectStatuses: string[] = [];
      const p2 = liveProvider.connect({
        sessionId: 'sess-goaway-spoke',
        systemPrompt: 'System prompt',
        onAudioData: () => {},
        onTranscript: () => {},
        onStatusChange: (status) => reconnectStatuses.push(status),
      });

      await waitFor(() => FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].sent.length >= 1);
      const sock1 = FakeWebSocket.instances[0];
      sock1.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await p2;

      sock1.emitMessage(
        new Blob([JSON.stringify({ serverContent: { outputTranscription: { text: 'Hello!' } } })]),
      );
      sock1.emitMessage(new Blob([JSON.stringify({ sessionResumptionUpdate: { newHandle: 'handle-next' } })]));
      sock1.emitMessage(new Blob([JSON.stringify({ goAway: { timeLimit: '5s' } })]));

      // triggerReconnection waits 1000ms before calling establishConnection().
      await waitFor(() => reconnectStatuses.includes('reconnecting'));
      t.mock.timers.tick(1000);
      await waitFor(() => FakeWebSocket.instances.length === 2 && FakeWebSocket.instances[1].sent.length >= 1);

      const sock2 = FakeWebSocket.instances[1];
      const setup2 = JSON.parse(sock2.sent[0]);
      assert.equal(setup2.setup?.sessionResumption?.handle, 'handle-next');

      const connectedCountBefore = reconnectStatuses.filter((s) => s === 'connected').length;
      sock2.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await waitFor(() => reconnectStatuses.filter((s) => s === 'connected').length > connectedCountBefore);

      assert.equal(
        sock2.sent.filter((s) => JSON.parse(s).realtimeInput?.text === CALL_KICKOFF_PROMPT).length,
        0,
      );

      await liveProvider.disconnect(false);
    } finally {
      t.mock.timers.reset();
    }
  });
});

test('GeminiLiveProvider resends kickoff after GoAway reconnection when tutor has not spoken yet', async (t) => {
  await withFakeBrowserEnv(async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const liveProvider = new GeminiLiveProvider();
      const statuses: string[] = [];
      const p = liveProvider.connect({
        sessionId: 'sess-goaway-silent',
        systemPrompt: 'System prompt',
        onAudioData: () => {},
        onTranscript: () => {},
        onStatusChange: (status) => statuses.push(status),
      });

      await waitFor(() => FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].sent.length >= 1);
      const sock1 = FakeWebSocket.instances[0];
      sock1.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await p;

      sock1.emitMessage(new Blob([JSON.stringify({ goAway: { timeLimit: '5s' } })]));
      await waitFor(() => statuses.includes('reconnecting'));
      t.mock.timers.tick(1000);
      await waitFor(() => FakeWebSocket.instances.length === 2 && FakeWebSocket.instances[1].sent.length >= 1);

      const sock2 = FakeWebSocket.instances[1];
      const connectedBefore = statuses.filter((s) => s === 'connected').length;
      sock2.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await waitFor(() => statuses.filter((s) => s === 'connected').length > connectedBefore);

      const kickoffs = sock2.sent
        .map((s, idx) => ({ idx, parsed: JSON.parse(s) }))
        .filter((item) => item.parsed.realtimeInput?.text === CALL_KICKOFF_PROMPT);
      assert.equal(kickoffs.length, 1);
      assert.ok(kickoffs[0].idx >= 1, 'kickoff must be sent after setup');

      await liveProvider.disconnect(false);
    } finally {
      t.mock.timers.reset();
    }
  });
});

test('GeminiLiveProvider cancels cleanly if disconnect is called before direct socket opens or before setupComplete (no proxy fallback, 0 kickoffs)', async () => {
  await withFakeBrowserEnv(async () => {
    // 1) 직접 소켓이 열리기(onopen) 전에 disconnect
    FakeWebSocket.autoOpen = false;
    const provider = new GeminiLiveProvider();
    const statuses: string[] = [];

    const connectPromise = provider.connect({
      sessionId: 'sess-cancel-before-open',
      systemPrompt: 'System prompt',
      onAudioData: () => {},
      onTranscript: () => {},
      onStatusChange: (status) => statuses.push(status),
    });

    await waitFor(() => FakeWebSocket.instances.length === 1);
    const directWs = FakeWebSocket.instances[0];
    assert.ok(directWs.url.includes('generativelanguage.googleapis.com'));
    assert.equal(directWs.readyState, FakeWebSocket.CONNECTING);

    await provider.disconnect();
    // 지연된 onopen 이 뒤늦게 도착하더라도 무시되어야 한다.
    directWs.open();
    await connectPromise;

    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(directWs.sent.length, 0);
    assert.equal(statuses.includes('error'), false);
    assert.equal(statuses.includes('connected'), false);
    assert.equal(statuses[statuses.length - 1], 'closed');

    // 2) 직접 소켓은 열렸으나 setupComplete 도착 전에 disconnect -> 5초 대기·프록시 폴백·kickoff 없이 즉시 종료
    FakeWebSocket.instances = [];
    FakeWebSocket.autoOpen = true;
    const provider2 = new GeminiLiveProvider();
    const statuses2: string[] = [];
    const connectPromise2 = provider2.connect({
      sessionId: 'sess-cancel-before-setup',
      systemPrompt: 'System prompt',
      onAudioData: () => {},
      onTranscript: () => {},
      onStatusChange: (status) => statuses2.push(status),
    });

    await waitFor(() => FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].sent.length === 1);
    const directWs2 = FakeWebSocket.instances[0];
    await provider2.disconnect();
    await connectPromise2;

    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(directWs2.sent.length, 1); // setup payload만 전송, kickoff 없음
    assert.equal(provider2.getConnectionStats().directFailCount, 0);
    assert.equal(statuses2.includes('error'), false);
    assert.equal(statuses2.includes('connected'), false);
    assert.equal(statuses2[statuses2.length - 1], 'closed');
  });
});

test('GeminiLiveProvider proxy path ({ok:false}) handles Blob ready, sends 1 text_prompt kickoff, and keeps post-ready frames', async () => {
  await withFakeBrowserEnv(async () => {
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ ok: false, error: 'no token' }), { status: 200 });

    const provider = new GeminiLiveProvider();
    const statuses: string[] = [];
    const transcripts: Array<{ text: string; isUser: boolean }> = [];

    const connectPromise = provider.connect({
      sessionId: 'sess-proxy-1',
      systemPrompt: 'System prompt',
      onAudioData: () => {},
      onTranscript: (text, isUser) => transcripts.push({ text, isUser }),
      onStatusChange: (status) => statuses.push(status),
    });

    await waitFor(() => FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].sent.length >= 1);
    const ws = FakeWebSocket.instances[0];
    assert.ok(ws.url.includes('/api/gemini/live?token=fake-firebase-id-token'));
    assert.equal(JSON.parse(ws.sent[0]).type, 'init');

    // Blob ready 직후 같은 틱에 이어서 도착한 후속 프레임도 유실되지 않아야 한다.
    ws.emitMessage(createDelayedBlob(JSON.stringify({ type: 'ready', model: 'gemini-3.8-live' }), 10));
    ws.emitMessage(new Blob([JSON.stringify({ type: 'output_transcript', text: 'Proxy greeting!' })]));

    await connectPromise;
    await waitFor(() => transcripts.length >= 1);

    assert.equal(provider.getConnectionStats().connectionPath, 'proxy');
    assert.ok(statuses.includes('connected'));

    const sentAfterInit = ws.sent.slice(1).map((s) => JSON.parse(s));
    const kickoffs = sentAfterInit.filter(
      (p) => p.type === 'text_prompt' && p.text === CALL_KICKOFF_PROMPT,
    );
    assert.equal(kickoffs.length, 1);

    assert.deepEqual(transcripts, [{ text: 'Proxy greeting!', isUser: false }]);
    assert.deepEqual(
      provider.getLiveTranscript().map((t) => ({ role: t.role, text: t.text })),
      [{ role: 'model', text: 'Proxy greeting!' }],
    );

    await provider.disconnect(false);
  });
});

test('direct socket stays on direct wire even when ws.url lacks googleapis host', async () => {
  await withFakeBrowserEnv(async () => {
    FakeWebSocket.urlRewrite = () => 'wss://localhost:3000/api-proxy/ws/live';
    const provider = new GeminiLiveProvider();

    const connectPromise = provider.connect({
      sessionId: 'sess-h1-rewrite',
      systemPrompt: 'System prompt',
      skipMic: true,
      onAudioData: () => {},
      onTranscript: () => {},
      onStatusChange: () => {},
    });

    await waitFor(() => FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].sent.length >= 1);
    const ws = FakeWebSocket.instances[0];
    assert.equal(ws.url.includes('generativelanguage.googleapis.com'), false);

    ws.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
    await connectPromise;

    provider.sendAudioChunk(new Uint8Array([1, 2, 3, 4]).buffer);

    const parsedSent = ws.sent.map((raw) => JSON.parse(raw));
    assert.equal(parsedSent.length, 3); // setup + kickoff + audio
    assert.equal(parsedSent[1].realtimeInput?.text, CALL_KICKOFF_PROMPT);
    assert.equal(parsedSent[2].realtimeInput?.audio?.mimeType, 'audio/pcm;rate=16000');

    for (const msg of parsedSent) {
      assert.equal(validateClientMessage('direct', msg), null);
      assert.equal(msg.type, undefined);
    }

    await provider.disconnect(false);
  });
});

test('nothing but setup is sent before setupComplete during reconnection', async (t) => {
  await withFakeBrowserEnv(async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const provider = new GeminiLiveProvider();
      const statuses: string[] = [];
      const connectPromise = provider.connect({
        sessionId: 'sess-pre-ready-gate',
        systemPrompt: 'System prompt',
        skipMic: true,
        onAudioData: () => {},
        onTranscript: () => {},
        onStatusChange: (status) => statuses.push(status),
      });

      await waitFor(() => FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].sent.length >= 1);
      const sock1 = FakeWebSocket.instances[0];
      sock1.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await connectPromise;

      sock1.emitMessage(new Blob([JSON.stringify({ goAway: { timeLimit: '5s' } })]));
      await waitFor(() => statuses.includes('reconnecting'));
      t.mock.timers.tick(1000);
      await waitFor(() => FakeWebSocket.instances.length === 2 && FakeWebSocket.instances[1].sent.length >= 1);

      const sock2 = FakeWebSocket.instances[1];
      assert.equal(sock2.sent.length, 1);

      provider.sendAudioChunk(new Uint8Array([1, 2, 3, 4]).buffer);
      const sentText = provider.sendTextPrompt('should be blocked before setupComplete');
      assert.equal(sentText, false);
      assert.equal(sock2.sent.length, 1);

      await provider.disconnect(false);
    } finally {
      t.mock.timers.reset();
    }
  });
});

test('QA scenario: kickoff -> 1007 close -> direct 1007 pre-setup -> proxy gets exactly one text_prompt kickoff', async (t) => {
  await withFakeBrowserEnv(async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const provider = new GeminiLiveProvider();
      const statuses: string[] = [];
      const connectPromise = provider.connect({
        sessionId: 'sess-qa-1007',
        systemPrompt: 'System prompt',
        skipMic: true,
        onAudioData: () => {},
        onTranscript: () => {},
        onStatusChange: (status) => statuses.push(status),
      });

      await waitFor(() => FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].sent.length >= 1);
      const sock1 = FakeWebSocket.instances[0];
      sock1.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await connectPromise;

      // 1차 직접 연결에서 kickoff 직후 1007 close 발생
      sock1.emitClose(1007, 'Invalid JSON payload', false);
      await waitFor(() => statuses.includes('reconnecting'));
      t.mock.timers.tick(1000);

      // 2차 재연결 직접 소켓(sock2)은 setup 직후 setupComplete 전에 1007 로 닫힘
      await waitFor(() => FakeWebSocket.instances.length === 2 && FakeWebSocket.instances[1].sent.length >= 1);
      const sock2 = FakeWebSocket.instances[1];
      sock2.emitClose(1007, 'Invalid JSON payload', false);

      // 프록시 소켓(sock3)으로 폴백되어 ready 수신
      await waitFor(() => FakeWebSocket.instances.length === 3 && FakeWebSocket.instances[2].sent.length >= 1);
      const sock3 = FakeWebSocket.instances[2];
      assert.ok(sock3.url.includes('/api/gemini/live'));
      assert.equal(JSON.parse(sock3.sent[0]).type, 'init');

      const connectedBefore = statuses.filter((s) => s === 'connected').length;
      sock3.emitMessage(new Blob([JSON.stringify({ type: 'ready', model: 'gemini-3.8-live' })]));
      await waitFor(() => statuses.filter((s) => s === 'connected').length > connectedBefore);

      assert.equal(sock2.sent.length, 1, 'sock2 must only have setup');
      const sock3Kickoffs = sock3.sent
        .slice(1)
        .map((s) => JSON.parse(s))
        .filter((m) => m.type === 'text_prompt' && m.text === CALL_KICKOFF_PROMPT);
      assert.equal(sock3Kickoffs.length, 1);

      await provider.disconnect(false);
    } finally {
      t.mock.timers.reset();
    }
  });
});

test('ws_close logs code/reason/lastSent without payload data', async (t) => {
  await withFakeBrowserEnv(async () => {
    const warnMock = t.mock.method(console, 'warn');
    const provider = new GeminiLiveProvider();
    const connectPromise = provider.connect({
      sessionId: 'sess-close-log',
      systemPrompt: 'System prompt',
      skipMic: true,
      onAudioData: () => {},
      onTranscript: () => {},
      onStatusChange: () => {},
    });

    await waitFor(() => FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].sent.length >= 1);
    const sock1 = FakeWebSocket.instances[0];
    sock1.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
    await connectPromise;

    sock1.emitClose(1007, 'Invalid JSON payload received. Unknown name "type"', false);

    const warnLines = warnMock.mock.calls.map((c) => c.arguments.map(String).join(' '));
    const closeLine = warnLines.find((line) =>
      /\[Live\] ws_close wire=direct phase=open code=1007 reason=Invalid JSON.*lastSent=realtimeInput\.text/.test(
        line,
      ),
    );
    assert.ok(closeLine, `expected ws_close log, got: ${warnLines.join('\n')}`);
    for (const line of warnLines) {
      assert.equal(line.includes(CALL_KICKOFF_PROMPT), false);
    }

    await provider.disconnect(false);
  });
});

test('onerror then close logs close code once and reconnects once', async (t) => {
  await withFakeBrowserEnv(async () => {
    const warnMock = t.mock.method(console, 'warn');
    const provider = new GeminiLiveProvider();
    const statuses: string[] = [];
    const connectPromise = provider.connect({
      sessionId: 'sess-error-then-close',
      systemPrompt: 'System prompt',
      skipMic: true,
      onAudioData: () => {},
      onTranscript: () => {},
      onStatusChange: (status) => statuses.push(status),
    });

    await waitFor(() => FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].sent.length >= 1);
    const sock1 = FakeWebSocket.instances[0];
    sock1.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
    await connectPromise;

    sock1.onerror?.({});
    sock1.emitClose(1006, '', false);

    assert.equal(statuses.filter((s) => s === 'reconnecting').length, 1);
    const closeLogs = warnMock.mock.calls
      .map((c) => c.arguments.map(String).join(' '))
      .filter((line) => line.includes('[Live] ws_close') && line.includes('code=1006'));
    assert.equal(closeLogs.length, 1);

    await provider.disconnect(false);
  });
});

test('setupComplete -> kickoff -> close repeated 3 times sends at most 2 kickoffs and logs max_attempts', async (t) => {
  await withFakeBrowserEnv(async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const logMock = t.mock.method(console, 'log');
    try {
      const provider = new GeminiLiveProvider();
      const statuses: string[] = [];
      const connectPromise = provider.connect({
        sessionId: 'sess-kickoff-cap',
        systemPrompt: 'System prompt',
        skipMic: true,
        onAudioData: () => {},
        onTranscript: () => {},
        onStatusChange: (status) => statuses.push(status),
      });

      // 1회차: setupComplete -> 킥오프 #1 -> close(1007)
      await waitFor(() => FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].sent.length >= 1);
      const sock1 = FakeWebSocket.instances[0];
      sock1.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await connectPromise;
      sock1.emitClose(1007, 'Invalid JSON payload', false);

      await waitFor(() => statuses.includes('reconnecting'));
      t.mock.timers.tick(1000);

      // 2회차: setupComplete -> 킥오프 #2 -> close(1007)
      await waitFor(() => FakeWebSocket.instances.length === 2 && FakeWebSocket.instances[1].sent.length >= 1);
      const sock2 = FakeWebSocket.instances[1];
      const connectedAfter1 = statuses.filter((s) => s === 'connected').length;
      sock2.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await waitFor(() => statuses.filter((s) => s === 'connected').length > connectedAfter1);
      sock2.emitClose(1007, 'Invalid JSON payload', false);

      await waitFor(() => statuses.filter((s) => s === 'reconnecting').length === 2);
      t.mock.timers.tick(1000);

      // 3회차: setupComplete -> 상한 도달로 킥오프 미송신 -> close(1007)
      await waitFor(() => FakeWebSocket.instances.length === 3 && FakeWebSocket.instances[2].sent.length >= 1);
      const sock3 = FakeWebSocket.instances[2];
      const connectedAfter2 = statuses.filter((s) => s === 'connected').length;
      sock3.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await waitFor(() => statuses.filter((s) => s === 'connected').length > connectedAfter2);
      sock3.emitClose(1007, 'Invalid JSON payload', false);

      const countKickoffs = (ws: FakeWebSocket) =>
        ws.sent
          .map((s) => JSON.parse(s))
          .filter((m) => m.realtimeInput?.text === CALL_KICKOFF_PROMPT).length;

      assert.equal(countKickoffs(sock1), 1);
      assert.equal(countKickoffs(sock2), 1);
      assert.equal(countKickoffs(sock3), 0);
      assert.equal(countKickoffs(sock1) + countKickoffs(sock2) + countKickoffs(sock3), 2);

      const logLines = logMock.mock.calls.map((c) => c.arguments.map(String).join(' '));
      assert.ok(
        logLines.some((line) => line.includes('[Live] kickoff_skipped reason=max_attempts')),
        `expected max_attempts log, got: ${logLines.join('\n')}`,
      );

      await provider.disconnect(false);
    } finally {
      t.mock.timers.reset();
    }
  });
});

test('onaudioprocess drops mic frames before ready (connect and reconnect) and sends after ready', async (t) => {
  await withFakeBrowserEnv(async () => {
    const g = globalThis as any;
    const origNavigator = Object.getOwnPropertyDescriptor(g, 'navigator');
    const origAudioContext = g.AudioContext;
    const origAudio = g.Audio;
    t.mock.timers.enable({ apis: ['setTimeout'] });

    let capturedProcessor: { onaudioprocess: ((e: any) => void) | null; connect: () => void; disconnect: () => void } | null = null;
    class FakeAudioContext {
      public state = 'running';
      public currentTime = 0;
      public destination = {};
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createMediaStreamDestination() {
        return { stream: {} };
      }
      createScriptProcessor() {
        capturedProcessor = { onaudioprocess: null, connect() {}, disconnect() {} };
        return capturedProcessor;
      }
      async close() {}
    }
    class FakeAudio {
      public autoplay = false;
      public srcObject: any = null;
      setAttribute() {}
      async play() {}
      pause() {}
    }
    const fakeStream = {
      getTracks: () => [{ stop() {} }],
      getAudioTracks: () => [{ label: 'Fake Mic' }],
    };
    Object.defineProperty(g, 'navigator', {
      configurable: true,
      value: { mediaDevices: { getUserMedia: async () => fakeStream } },
    });
    g.AudioContext = FakeAudioContext;
    g.Audio = FakeAudio;

    try {
      const provider = new GeminiLiveProvider();
      const statuses: string[] = [];
      const connectPromise = provider.connect({
        sessionId: 'sess-onaudioprocess-gate',
        systemPrompt: 'System prompt',
        onAudioData: () => {},
        onTranscript: () => {},
        onStatusChange: (status) => statuses.push(status),
      });

      await waitFor(
        () =>
          FakeWebSocket.instances.length === 1 &&
          FakeWebSocket.instances[0].sent.length >= 1 &&
          capturedProcessor?.onaudioprocess !== null,
      );
      const sock1 = FakeWebSocket.instances[0];
      const fakeAudioEvent = { inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.25) } };

      // 1) setupComplete 전: onaudioprocess 호출되어도 송신 0건
      capturedProcessor!.onaudioprocess!(fakeAudioEvent);
      assert.equal(sock1.sent.length, 1);

      // 2) setupComplete 후: 오디오 프레임 송신 허용
      sock1.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await connectPromise;
      const beforeReadySend = sock1.sent.length;
      capturedProcessor!.onaudioprocess!(fakeAudioEvent);
      assert.equal(sock1.sent.length, beforeReadySend + 1);
      assert.equal(JSON.parse(sock1.sent[sock1.sent.length - 1]).realtimeInput?.audio?.mimeType, 'audio/pcm;rate=16000');

      // 3) 재연결 중 (ready 전): 송신 0건
      sock1.emitMessage(new Blob([JSON.stringify({ goAway: { timeLimit: '5s' } })]));
      await waitFor(() => statuses.includes('reconnecting'));
      capturedProcessor!.onaudioprocess!(fakeAudioEvent);
      t.mock.timers.tick(1000);
      await waitFor(() => FakeWebSocket.instances.length === 2 && FakeWebSocket.instances[1].sent.length >= 1);
      const sock2 = FakeWebSocket.instances[1];
      capturedProcessor!.onaudioprocess!(fakeAudioEvent);
      assert.equal(sock2.sent.length, 1, 'only setup must be sent before setupComplete on sock2');

      // 4) 재연결 ready 후: 다시 오디오 프레임 송신
      const connectedBefore = statuses.filter((s) => s === 'connected').length;
      sock2.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await waitFor(() => statuses.filter((s) => s === 'connected').length > connectedBefore);
      const sock2BeforeAudio = sock2.sent.length;
      capturedProcessor!.onaudioprocess!(fakeAudioEvent);
      assert.equal(sock2.sent.length, sock2BeforeAudio + 1);
      assert.equal(JSON.parse(sock2.sent[sock2.sent.length - 1]).realtimeInput?.audio?.mimeType, 'audio/pcm;rate=16000');

      await provider.disconnect(false);
    } finally {
      t.mock.timers.reset();
      g.AudioContext = origAudioContext;
      g.Audio = origAudio;
      if (origNavigator) {
        Object.defineProperty(g, 'navigator', origNavigator);
      } else {
        delete g.navigator;
      }
    }
  });
});

test('second connect() without resumeToken on the same provider resets tutorSpoke and kickoffAttempts even when resumeHandle remains', async (t) => {
  await withFakeBrowserEnv(async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const provider = new GeminiLiveProvider();
      const statuses: string[] = [];

      const countKickoffs = (ws: FakeWebSocket) =>
        ws.sent
          .map((s) => JSON.parse(s))
          .filter((m) => m.realtimeInput?.text === CALL_KICKOFF_PROMPT).length;

      // 1차 통화: kickoff #1 -> GoAway 재연결 -> kickoff #2(상한 도달) -> 튜터 발화 + resumeHandle 저장 -> disconnect
      const p1 = provider.connect({
        sessionId: 'sess-retry-1',
        systemPrompt: 'System prompt',
        skipMic: true,
        onAudioData: () => {},
        onTranscript: () => {},
        onStatusChange: (status) => statuses.push(status),
      });

      await waitFor(() => FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].sent.length >= 1);
      const sock1 = FakeWebSocket.instances[0];
      sock1.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await p1;
      assert.equal(countKickoffs(sock1), 1);

      sock1.emitMessage(new Blob([JSON.stringify({ goAway: { timeLimit: '5s' } })]));
      await waitFor(() => statuses.includes('reconnecting'));
      t.mock.timers.tick(1000);
      await waitFor(() => FakeWebSocket.instances.length === 2 && FakeWebSocket.instances[1].sent.length >= 1);
      const sock1Reconnect = FakeWebSocket.instances[1];
      const connectedAfterSock1 = statuses.filter((s) => s === 'connected').length;
      sock1Reconnect.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await waitFor(() => statuses.filter((s) => s === 'connected').length > connectedAfterSock1);
      assert.equal(countKickoffs(sock1Reconnect), 1); // kickoffAttempts === MAX_KICKOFF_ATTEMPTS(2)

      sock1Reconnect.emitMessage(
        new Blob([JSON.stringify({ sessionResumptionUpdate: { newHandle: 'handle-prev-call' } })]),
      );
      sock1Reconnect.emitMessage(
        new Blob([JSON.stringify({ serverContent: { outputTranscription: { text: 'First call hi!' } } })]),
      );
      await waitFor(() => provider.getResumeToken() === 'handle-prev-call' && provider.getLiveTranscript().length === 1);

      await provider.disconnect(false);
      assert.equal(provider.getResumeToken(), 'handle-prev-call');

      // 2차 통화(같은 provider 인스턴스, resumeToken 없이 다시 connect):
      // resumeHandle이 남아 있어도 !options.resumeToken 기준으로 tutorSpoke/kickoffAttempts가 초기화되어야 한다.
      const connectedAfterCall1 = statuses.filter((s) => s === 'connected').length;
      const p2 = provider.connect({
        sessionId: 'sess-retry-2',
        systemPrompt: 'System prompt',
        skipMic: true,
        onAudioData: () => {},
        onTranscript: () => {},
        onStatusChange: (status) => statuses.push(status),
      });

      await waitFor(() => FakeWebSocket.instances.length === 3 && FakeWebSocket.instances[2].sent.length >= 1);
      const sock2 = FakeWebSocket.instances[2];
      sock2.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await p2;
      await waitFor(() => statuses.filter((s) => s === 'connected').length > connectedAfterCall1);

      assert.equal(countKickoffs(sock2), 1);

      await provider.disconnect(false);
    } finally {
      t.mock.timers.reset();
    }
  });
});


test('GeminiLiveProvider tracks usageMetadata across direct turns, GoAway reconnect, proxy path, and resets on fresh connect', async (t) => {
  await withFakeBrowserEnv(async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const provider = new GeminiLiveProvider();
      const statuses: string[] = [];

      // 1) Direct path: 2 snapshots in turn 1 (last-wins) + turnComplete, then pending snapshot across GoAway reconnect
      const p1 = provider.connect({
        sessionId: 'sess-usage-direct',
        systemPrompt: 'System prompt',
        skipMic: true,
        onAudioData: () => {},
        onTranscript: () => {},
        onStatusChange: (status) => statuses.push(status),
      });

      await waitFor(() => FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].sent.length >= 1);
      const sock1 = FakeWebSocket.instances[0];
      sock1.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await p1;

      sock1.emitMessage(
        new Blob([
          JSON.stringify({
            usageMetadata: {
              promptTokenCount: 100,
              responseTokenCount: 10,
              promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 100 }],
              responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 10 }],
            },
          }),
        ]),
      );
      sock1.emitMessage(
        new Blob([
          JSON.stringify({
            usageMetadata: {
              promptTokenCount: 100,
              responseTokenCount: 40,
              thoughtsTokenCount: 5,
              promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 100 }],
              responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 40 }],
            },
            serverContent: { turnComplete: true },
          }),
        ]),
      );

      // Turn 2 observed, then GoAway arrives before turnComplete -> pending turn must be committed and preserved.
      sock1.emitMessage(
        new Blob([
          JSON.stringify({
            usageMetadata: {
              promptTokenCount: 220,
              responseTokenCount: 30,
              promptTokensDetails: [
                { modality: 'AUDIO', tokenCount: 200 },
                { modality: 'TEXT', tokenCount: 20 },
              ],
              responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 30 }],
            },
          }),
        ]),
      );
      sock1.emitMessage(new Blob([JSON.stringify({ goAway: { timeLimit: '5s' } })]));

      await waitFor(() => statuses.includes('reconnecting'));
      t.mock.timers.tick(1000);
      await waitFor(() => FakeWebSocket.instances.length === 2 && FakeWebSocket.instances[1].sent.length >= 1);

      const sock2 = FakeWebSocket.instances[1];
      const connectedBefore = statuses.filter((s) => s === 'connected').length;
      sock2.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await waitFor(() => statuses.filter((s) => s === 'connected').length > connectedBefore);

      // Turn 3 on reconnected socket ends with interrupted
      sock2.emitMessage(
        new Blob([
          JSON.stringify({
            usageMetadata: {
              promptTokenCount: 300,
              responseTokenCount: 50,
            },
            serverContent: { interrupted: true },
          }),
        ]),
      );
      await waitFor(() => provider.getLiveUsage().turns === 3);

      const directTotals = provider.finalizeLiveUsage();
      assert.equal(directTotals.turns, 3);
      assert.equal(directTotals.inAudio, 100 + 200 + 300);
      assert.equal(directTotals.inText, 20);
      assert.equal(directTotals.outAudio, 40 + 30 + 50);
      assert.equal(directTotals.thoughts, 5);
      assert.equal(directTotals.unsplitPromptTokens, 300);

      await provider.disconnect(false);

      // 2) Brand new call via proxy path on same provider -> resets previous call totals
      (globalThis as any).fetch = async () =>
        new Response(JSON.stringify({ ok: false, error: 'proxy test' }), { status: 200 });
      const p2 = provider.connect({
        sessionId: 'sess-usage-proxy',
        systemPrompt: 'System prompt',
        skipMic: true,
        onAudioData: () => {},
        onTranscript: () => {},
        onStatusChange: (status) => statuses.push(status),
      });

      await waitFor(() => FakeWebSocket.instances.length === 3 && FakeWebSocket.instances[2].sent.length >= 1);
      const proxyWs = FakeWebSocket.instances[2];
      proxyWs.emitMessage(new Blob([JSON.stringify({ type: 'ready', model: 'gemini-3.8-live' })]));
      await p2;

      assert.equal(provider.getLiveUsage().turns, 0);

      proxyWs.emitMessage(
        new Blob([
          JSON.stringify({
            type: 'usage_metadata',
            usageMetadata: {
              promptTokenCount: 150,
              responseTokenCount: 60,
              promptTokensDetails: [
                { modality: 'AUDIO', tokenCount: 110 },
                { modality: 'TEXT', tokenCount: 40 },
              ],
              responseTokensDetails: [
                { modality: 'AUDIO', tokenCount: 50 },
                { modality: 'TEXT', tokenCount: 10 },
              ],
            },
          }),
        ]),
      );
      proxyWs.emitMessage(new Blob([JSON.stringify({ type: 'turnComplete' })]));
      await waitFor(() => provider.getLiveUsage().turns === 1);

      const proxyTotals = provider.finalizeLiveUsage();
      assert.equal(proxyTotals.turns, 1);
      assert.equal(proxyTotals.inAudio, 110);
      assert.equal(proxyTotals.inText, 40);
      assert.equal(proxyTotals.outAudio, 50);
      assert.equal(proxyTotals.outText, 10);

      await provider.disconnect(false);
    } finally {
      t.mock.timers.reset();
    }
  });
});

test('proxy ready.contextCompression is tracked per call: false -> off, true -> on, missing -> unknown', async () => {
  for (const [field, expected] of [[false, 'off'], [true, 'on'], [undefined, 'unknown']] as const) {
    await withFakeBrowserEnv(async () => {
      (globalThis as any).fetch = async () =>
        new Response(JSON.stringify({ ok: false, error: 'no token' }), { status: 200 });
      const provider = new GeminiLiveProvider();
      const connectPromise = provider.connect({
        sessionId: `sess-ctx-${String(field)}`,
        systemPrompt: 'System prompt',
        onAudioData: () => {},
        onTranscript: () => {},
        onStatusChange: () => {},
      });
      await waitFor(() => FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].sent.length >= 1);
      const ws = FakeWebSocket.instances[0];
      const ready: Record<string, unknown> = { type: 'ready', model: 'gemini-3.8-live' };
      if (field !== undefined) ready.contextCompression = field;
      ws.emitMessage(new Blob([JSON.stringify(ready)]));
      await connectPromise;
      assert.equal(provider.getConnectionStats().connectionPath, 'proxy');
      assert.equal(provider.getLiveContextCompression(), expected);
      await provider.disconnect(false);
    });
  }
});
