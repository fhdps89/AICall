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
const realSetTimeout = globalThis.setTimeout;
g.setTimeout = (fn: any, ms?: number, ...a: any[]) => realSetTimeout(fn, ms === 10000 ? 200 : ms, ...a);

const { ChunkRecorder } = await import('../src/services/recording/chunkRecorder.ts');
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
