import { test } from 'node:test';
import assert from 'node:assert/strict';

// Fake browser recording APIs; 10 s segments run as 200 ms here.
class FakeTrack { readyState = 'live'; clone() { return new FakeTrack(); } stop() { this.readyState = 'ended'; } }
const g = globalThis as any;
g.window = globalThis;
g.MediaStream = class { t: any[]; constructor(t: any[]) { this.t = t; } getAudioTracks() { return this.t; } getTracks() { return this.t; } };
g.MediaRecorder = class {
  static isTypeSupported(m: string) { return m === 'audio/webm;codecs=opus'; }
  state = 'inactive'; ondataavailable: any; onstop: any;
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; setTimeout(() => { this.ondataavailable?.({ data: new Blob(['x']) }); this.onstop?.(); }, 50); }
};
g.FileReader = class {
  result = ''; onloadend: any; onerror: any;
  readAsDataURL() { this.result = 'data:audio/webm;base64,eA=='; realSetTimeout(() => this.onloadend?.(), 0); }
};
const realSetTimeout = globalThis.setTimeout;
g.setTimeout = (fn: any, ms?: number, ...a: any[]) => realSetTimeout(fn, ms === 10000 ? 200 : ms, ...a);

const { ChunkRecorder } = await import('../src/services/recording/chunkRecorder.ts');
const {
  PARTIAL_TRANSCRIBE_KEY,
  isPartialTranscribeEnabled,
  setPartialTranscribeEnabled,
} = await import('../src/services/recording/partialTranscribeSetting.ts');
const sleep = (ms: number) => new Promise((r) => realSetTimeout(r, ms));
const savedIndices: number[] = [];
const deps = {
  saveChunkLocally: async () => {},
  deleteChunkLocally: async () => {},
  uploadAudioFile: async () => 'https://storage.example/chunk',
  appendSessionChunk: async (_u: string, _s: string, meta: any) => { savedIndices.push(meta.index); },
  appendSessionSttPartial: async () => {},
  authFetch: (async () => new Response('{}')) as any,
  mergeChunksToWav: async () => null,
  recordPartialSttMinutes: () => {},
};
const stream = () => new g.MediaStream([new FakeTrack()]);

test('stop() includes the last segment, also right at a segment boundary', async () => {
  for (const wait of [220, 230, 310, 500]) {
    const rec = new ChunkRecorder(deps);
    await rec.start(stream(), { userId: 'u', sessionId: `s-${wait}` });
    await sleep(wait);
    await rec.stop();
    assert.equal(rec.getSessionRecordedBlobs().length, rec.getChunkCount(), `stop after ${wait} ms`);
  }
});

test('restarting in the same call continues numbering; a new call starts over', async () => {
  savedIndices.length = 0;
  const rec = new ChunkRecorder(deps);
  const opts = { userId: 'u', sessionId: 'call-1' };
  await rec.start(stream(), opts); await sleep(300); await rec.stop();
  await rec.start(stream(), opts); await sleep(300); await rec.stop();
  await sleep(50);
  assert.equal(new Set(savedIndices).size, savedIndices.length, `duplicate chunk index: ${savedIndices}`);
  assert.equal(rec.getSessionRecordedBlobs().length, rec.getChunkCount());
  await rec.start(stream(), { ...opts, sessionId: 'call-2' }); await rec.stop();
  assert.equal(rec.getChunkCount(), 1);
});

test('1-minute backup batch keeps recording order even when an early upload is slow', async () => {
  const batches: number[][] = [];
  let first = true;
  const rec = new ChunkRecorder({
    ...deps,
    // The first chunk's upload hangs longer than the whole test: it must not be pushed to the
    // back of the minute, and must not hold the minute back.
    uploadAudioFile: async () => { if (first) { first = false; await sleep(5000); } return 'https://storage.example/chunk'; },
    authFetch: (async () => new Response(JSON.stringify({ ok: true, transcript: 'hi' }))) as any,
    appendSessionSttPartial: async (_u: string, _s: string, item: any) => { batches.push(item.sourceChunkIndices); },
  });
  await rec.start(stream(), { userId: 'u', sessionId: 'call-slow', enablePartialTranscribe: true });
  await sleep(1750); // 6 segments of ~250 ms and a little more
  await rec.stop();
  await sleep(100);
  assert.deepEqual(batches[0], [0, 1, 2, 3, 4, 5]);
});

test('enablePartialTranscribe undefined or false never calls transcribe-partial yet still stores/uploads every 10s chunk', async () => {
  for (const mode of [undefined, false] as const) {
    let partialCalls = 0;
    let savedLocally = 0;
    let uploaded = 0;
    let deletedLocally = 0;
    let appendedMeta = 0;
    const recordedUsage: Array<{ userId: string; minutes: number }> = [];

    const rec = new ChunkRecorder({
      ...deps,
      saveChunkLocally: async () => { savedLocally += 1; },
      uploadAudioFile: async () => { uploaded += 1; return 'https://storage.example/chunk'; },
      deleteChunkLocally: async () => { deletedLocally += 1; },
      appendSessionChunk: async () => { appendedMeta += 1; },
      authFetch: (async (url: string) => {
        if (String(url).includes('/api/gemini/transcribe-partial')) partialCalls += 1;
        return new Response(JSON.stringify({ ok: true, transcript: 'should not run' }));
      }) as any,
      recordPartialSttMinutes: (userId, minutes) => { recordedUsage.push({ userId, minutes }); },
    });

    await rec.start(stream(), {
      userId: 'u-off',
      sessionId: `call-off-${String(mode)}`,
      ...(mode === undefined ? {} : { enablePartialTranscribe: mode }),
    });
    await sleep(1750); // >= 6 segments (~250ms each)
    await rec.stop();
    await sleep(100);

    const totalChunks = rec.getChunkCount();
    assert.ok(totalChunks >= 6, `expected >= 6 chunks for mode=${String(mode)}, got ${totalChunks}`);
    assert.equal(partialCalls, 0, `transcribe-partial must not be called for mode=${String(mode)}`);
    assert.equal(recordedUsage.length, 0);
    assert.equal(savedLocally, totalChunks);
    assert.equal(uploaded, totalChunks);
    assert.equal(deletedLocally, totalChunks);
    assert.equal(appendedMeta, totalChunks);
  }
});

test('enablePartialTranscribe true calls transcribe-partial once per 6 chunks and records 1 minute only on success', async () => {
  let partialCalls = 0;
  const recordedUsage: Array<{ userId: string; minutes: number }> = [];

  const recOk = new ChunkRecorder({
    ...deps,
    authFetch: (async (url: string) => {
      if (String(url).includes('/api/gemini/transcribe-partial')) partialCalls += 1;
      return new Response(JSON.stringify({ ok: true, transcript: 'hello world' }), { status: 200 });
    }) as any,
    recordPartialSttMinutes: (userId, minutes) => { recordedUsage.push({ userId, minutes }); },
  });

  await recOk.start(stream(), {
    userId: 'u-on',
    sessionId: 'call-on-ok',
    enablePartialTranscribe: true,
  });
  await sleep(1750); // 1 batch of 6 chunks
  await recOk.stop();
  await sleep(100);

  assert.equal(partialCalls, 1);
  assert.deepEqual(recordedUsage, [{ userId: 'u-on', minutes: 1 }]);

  // HTTP failure must NOT record partial STT usage
  let failCalls = 0;
  const failedUsage: Array<{ userId: string; minutes: number }> = [];
  const recFail = new ChunkRecorder({
    ...deps,
    authFetch: (async (url: string) => {
      if (String(url).includes('/api/gemini/transcribe-partial')) failCalls += 1;
      return new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 500 });
    }) as any,
    recordPartialSttMinutes: (userId, minutes) => { failedUsage.push({ userId, minutes }); },
  });

  await recFail.start(stream(), {
    userId: 'u-fail',
    sessionId: 'call-on-fail',
    enablePartialTranscribe: true,
  });
  await sleep(1750);
  await recFail.stop();
  await sleep(100);

  assert.equal(failCalls, 1);
  assert.equal(failedUsage.length, 0);
});

test('partialTranscribeSetting: default OFF, strict "true" check, error swallowing, and round trip', () => {
  const makeStorage = (initial?: Record<string, string>) => {
    const map = new Map<string, string>(Object.entries(initial ?? {}));
    return {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => { map.set(k, v); },
    };
  };

  assert.equal(isPartialTranscribeEnabled(makeStorage()), false);
  assert.equal(isPartialTranscribeEnabled(null), false);
  assert.equal(isPartialTranscribeEnabled(makeStorage({ [PARTIAL_TRANSCRIBE_KEY]: 'true' })), true);
  assert.equal(isPartialTranscribeEnabled(makeStorage({ [PARTIAL_TRANSCRIBE_KEY]: 'false' })), false);
  assert.equal(isPartialTranscribeEnabled(makeStorage({ [PARTIAL_TRANSCRIBE_KEY]: '1' })), false);
  assert.equal(isPartialTranscribeEnabled(makeStorage({ [PARTIAL_TRANSCRIBE_KEY]: 'TRUE' })), false);

  const throwingStorage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  assert.equal(isPartialTranscribeEnabled(throwingStorage), false);
  assert.doesNotThrow(() => setPartialTranscribeEnabled(true, throwingStorage));

  const s = makeStorage();
  assert.equal(isPartialTranscribeEnabled(s), false);
  setPartialTranscribeEnabled(true, s);
  assert.equal(s.getItem(PARTIAL_TRANSCRIBE_KEY), 'true');
  assert.equal(isPartialTranscribeEnabled(s), true);
  setPartialTranscribeEnabled(false, s);
  assert.equal(s.getItem(PARTIAL_TRANSCRIBE_KEY), 'false');
  assert.equal(isPartialTranscribeEnabled(s), false);
});
