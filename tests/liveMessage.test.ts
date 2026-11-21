import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodeLiveMessage, createSerialQueue } from '../src/services/providers/liveMessage.ts';
import { GeminiLiveProvider, CALL_KICKOFF_PROMPT } from '../src/services/providers/geminiLiveProvider.ts';
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

test('geminiLiveProvider.ts source has no raw JSON.parse(event.data) and guards kickoff with !options.resumeToken', () => {
  const src = fs.readFileSync(path.join(rootDir, 'src/services/providers/geminiLiveProvider.ts'), 'utf-8');
  assert.equal(/JSON\.parse\s*\(\s*event\.data\s*\)/.test(src), false);
  assert.match(src, /export\s+const\s+CALL_KICKOFF_PROMPT\s*=/);
  assert.match(src, /if\s*\(\s*!options\.resumeToken\b/);
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

  public url: string;
  public readyState = FakeWebSocket.CONNECTING;
  public sent: string[] = [];
  public onopen: ((ev: any) => void) | null = null;
  public onmessage: ((ev: { data: any }) => void) | null = null;
  public onerror: ((ev: any) => void) | null = null;
  public onclose: ((ev: { code: number; reason: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
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

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: '' });
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

test('GeminiLiveProvider does not send kickoff when resumeToken is provided or during GoAway reconnection', async (t) => {
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

    // 2) New call -> 1 kickoff, then GoAway reconnect -> no second kickoff
    FakeWebSocket.instances = [];
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const liveProvider = new GeminiLiveProvider();
      const reconnectStatuses: string[] = [];
      const p2 = liveProvider.connect({
        sessionId: 'sess-goaway',
        systemPrompt: 'System prompt',
        onAudioData: () => {},
        onTranscript: () => {},
        onStatusChange: (status) => reconnectStatuses.push(status),
      });

      await waitFor(() => FakeWebSocket.instances.length === 1 && FakeWebSocket.instances[0].sent.length >= 1);
      const sock1 = FakeWebSocket.instances[0];
      sock1.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
      await p2;

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
