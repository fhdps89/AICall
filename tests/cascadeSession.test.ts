// Fake Gemini + manual clock only: no network, no API key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CascadeSession,
  createGeminiCascadeAi,
  CASCADE_SETTLE_MS,
  STT_ROTATE_AFTER_MS,
  STT_CONNECT_TIMEOUT_MS,
  POC_MAX_OUTPUT_TOKENS,
  POC_LONG_MAX_OUTPUT_TOKENS,
  POC_TEMPERATURE,
  maxOutputTokensFor,
} from '../server/cascadeSession.ts';
import type { CascadeAi, CascadeClock } from '../server/cascadeSession.ts';
import { estimateTextTokens } from '../server/cascadeText.ts';
import { handleCascadeConnection } from '../server/cascadeWs.ts';

class FakeClock implements CascadeClock {
  t = 1_000_000;
  timers: { id: number; at: number; fn: () => void }[] = [];
  seq = 0;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown) {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }
}

const flush = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

type SttCb = { onmessage: (m: any) => void; onerror: (e: unknown) => void; onclose: () => void };

function makeFakeAi(
  opts: {
    reply?: string;
    finishReason?: string;
    failStt?: boolean;
    hangStt?: boolean;
    ttsBytes?: number;
    ttsChunks?: number;
    ttsUsage?: { inputTokens?: number; outputTokens?: number } | null;
    holdTts?: boolean;
  } = {},
) {
  const stt: { cb: SttCb; sent: any[]; closed: boolean }[] = [];
  const textCalls: any[] = [];
  const ttsCalls: { text: string; voiceName: string; signal: AbortSignal }[] = [];
  const ttsRelease: (() => void)[] = [];
  const ai: CascadeAi = {
    connectStt(cb) {
      if (opts.failStt) return Promise.reject(new Error('stt down'));
      if (opts.hangStt) return new Promise(() => {});
      const s = { cb, sent: [] as any[], closed: false };
      stt.push(s);
      return Promise.resolve({
        sendRealtimeInput: (i: any) => s.sent.push(i),
        close: () => {
          s.closed = true;
        },
      });
    },
    async streamText(req) {
      textCalls.push(req);
      const reply = opts.reply ?? 'Hello there. How are you today?';
      const parts = reply.match(/.{1,7}/gs) || [];
      return {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < parts.length; i++) {
            if (req.signal.aborted) return;
            const isLast = i === parts.length - 1;
            yield {
              text: parts[i],
              usageMetadata: isLast ? { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 2 } : undefined,
              finishReason: isLast ? opts.finishReason : undefined,
            };
          }
        },
      };
    },
    async streamSpeech(req) {
      ttsCalls.push({ text: req.text, voiceName: req.voiceName, signal: req.signal });
      const chunkCount = opts.ttsChunks ?? 2;
      const chunkBytes = opts.ttsBytes ?? 24000; // 0.5 s of 24 kHz 16-bit PCM per chunk
      const usage = opts.ttsUsage === undefined ? { inputTokens: 5 } : opts.ttsUsage;
      return {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < chunkCount; i++) {
            if (opts.holdTts) await new Promise<void>((r) => ttsRelease.push(r));
            if (req.signal.aborted) {
              const e: any = new Error('aborted');
              e.name = 'AbortError';
              throw e;
            }
            const audio = new Uint8Array(chunkBytes);
            audio[0] = i + 1;
            yield {
              audio,
              sampleRate: 24000,
              usage: i === chunkCount - 1 && usage ? usage : undefined,
            };
          }
        },
      };
    },
  };
  return { ai, stt, textCalls, ttsCalls, ttsRelease };
}

function makeSession(fake: ReturnType<typeof makeFakeAi>, history: unknown = []) {
  const clock = new FakeClock();
  const sent: any[] = [];
  const logs: string[] = [];
  const session = new CascadeSession(
    { ai: fake.ai, send: (m) => sent.push(m), clock, log: (l) => logs.push(l) },
    { systemInstruction: 'You are a tutor.', voiceName: 'Kore', history }
  );
  return { session, clock, sent, logs };
}

const types = (sent: any[]) => sent.map((m) => m.type);
const finalSeg = (text: string) => ({ serverContent: { inputTranscription: { text } } });
const interim = (text: string) => ({ serverContent: { interimInputTranscription: { text } } });

test('start: ready after STT connects; fallback_required when STT fails or times out', async () => {
  const ok = makeSession(makeFakeAi());
  await ok.session.start();
  assert.deepEqual(ok.sent[0], { type: 'ready', model: 'cascade-poc', models: { stt: 'gemini-3.5-transcribe-live', text: 'gemini-3.1-flash-lite', tts: 'gemini-3.8-flash-lite-tts' } });

  const bad = makeSession(makeFakeAi({ failStt: true }));
  await bad.session.start();
  assert.deepEqual(types(bad.sent), ['fallback_required']);
  assert.equal(bad.sent[0].error, 'cascade_connect_failed');

  const slow = makeSession(makeFakeAi({ hangStt: true }));
  const p = slow.session.start();
  slow.clock.advance(STT_CONNECT_TIMEOUT_MS);
  await p;
  assert.deepEqual(types(slow.sent), ['fallback_required']);
});

test('voice turn: waits 0.4 s after the final segment, then text → streamed audio in order', async () => {
  const fake = makeFakeAi();
  const { session, clock, sent, logs } = makeSession(fake);
  await session.start();
  const stt = fake.stt[0];
  stt.cb.onmessage(interim('I went'));
  stt.cb.onmessage(finalSeg('I went hiking.'));
  assert.equal(fake.textCalls.length, 0, 'no reply before the settle window');
  clock.advance(CASCADE_SETTLE_MS - 1);
  assert.equal(fake.textCalls.length, 0);
  // More speech inside the window restarts it and joins the turn.
  stt.cb.onmessage(finalSeg('With my dad.'));
  clock.advance(CASCADE_SETTLE_MS - 1);
  assert.equal(fake.textCalls.length, 0);
  clock.advance(1);
  await flush();
  assert.equal(fake.textCalls.length, 1);
  const contents = fake.textCalls[0].contents;
  assert.equal(contents[contents.length - 1].parts[0].text, 'I went hiking. With my dad.');
  assert.equal(fake.textCalls[0].maxOutputTokens, POC_MAX_OUTPUT_TOKENS);
  assert.match(fake.textCalls[0].systemInstruction, /^You are a tutor\.\n\nVoice call output rules/);
  assert.deepEqual(fake.ttsCalls.map((c) => c.text), ['Hello there. How are you today?']);
  assert.deepEqual(types(sent), [
    'ready',
    'input_transcript',
    'input_transcript',
    'audio',
    'output_transcript',
    'audio',
    'turnComplete',
    'poc_usage',
    'poc_turn',
  ]);
  assert.equal(sent[3].mimeType, 'audio/pcm;rate=24000');
  assert.equal(sent[4].text, 'Hello there. How are you today?');
  const usage = sent[7].usage;
  assert.equal(usage.turns, 1);
  assert.equal(usage.textInTokens, 100);
  assert.equal(usage.textOutTokens, 12);
  assert.equal(usage.ttsInTokens, 5);
  assert.equal(usage.ttsAudioSec, 1);
  assert.ok(logs.some((l) => /^\[poc-tts\] n=1 seg=1 chars=31 firstChunkMs=\d+ chunks=2 audioSec=1\.00 totalMs=\d+$/.test(l)));
  assert.ok(logs.some((l) => /^\[poc-turn\] n=1 interimToFinal=\d+ms finalToToken=\d+ms tokenToAudio=\d+ms finalToAudio=\d+ms$/.test(l)));
});

test('barge-in: 2 non-echo words while the tutor speaks stop it and truncate history', async () => {
  const fake = makeFakeAi({ holdTts: true, ttsChunks: 2, reply: 'First sentence here. Second one is long.' });
  const { session, clock, sent, logs } = makeSession(fake);
  await session.start();
  session.handleClientMessage({ type: 'text_prompt', text: 'start' });
  await flush();
  fake.ttsRelease.shift()!(); // first chunk of stream #1 sent
  await flush();
  assert.equal(sent.filter((m) => m.type === 'audio').length, 1);
  // One word: ignored. Echo of the tutor: ignored.
  fake.stt[0].cb.onmessage(interim('wait'));
  fake.stt[0].cb.onmessage(interim('second one is'));
  assert.ok(!types(sent).includes('interrupted'));
  fake.stt[0].cb.onmessage(interim('sorry wait'));
  assert.ok(types(sent).includes('interrupted'));
  assert.ok(logs.includes('[poc] barge_in reason=voice'));
  assert.ok(fake.ttsCalls[0].signal.aborted, 'pending speech is aborted');
  fake.ttsRelease.forEach((r) => r());
  await flush();
  assert.equal(sent.filter((m) => m.type === 'audio').length, 1, 'no audio after barge-in');
  assert.ok(!types(sent).includes('turnComplete'));
  // Next user turn sees the truncated tutor turn.
  fake.stt[0].cb.onmessage(finalSeg('Can you repeat?'));
  clock.advance(CASCADE_SETTLE_MS);
  await flush();
  const contents = fake.textCalls[1].contents.map((c: any) => `${c.role}:${c.parts[0].text}`);
  assert.deepEqual(contents.slice(-3), ['user:start', 'model:First sentence here. Second one is long. [interrupted]', 'user:Can you repeat?']);
});

test('no barge-in when the tutor is silent; a client interrupt stops a speaking tutor', async () => {
  const fake = makeFakeAi({ ttsBytes: 240000 }); // 5 s per sentence
  const { session, clock, sent } = makeSession(fake);
  await session.start();
  fake.stt[0].cb.onmessage(interim('hello there friend'));
  assert.ok(!types(sent).includes('interrupted'));
  session.handleClientMessage({ type: 'text_prompt', text: 'start' });
  await flush();
  assert.ok(types(sent).includes('turnComplete'));
  clock.advance(1000); // audio still playing (speakingUntil)
  session.handleClientMessage({ type: 'interrupt' });
  assert.ok(types(sent).includes('interrupted'));
});

test('control commands use the same prompts as the normal engine (server.ts)', async () => {
  const fake = makeFakeAi();
  const { session } = makeSession(fake);
  await session.start();
  const serverSrc = readFileSync('server.ts', 'utf8');
  for (const cmd of ['Done', 'Feedback', 'Model answer', 'Pause', 'Slow']) {
    session.handleClientMessage({ type: 'control_command', command: cmd });
    await flush();
    const c = fake.textCalls[fake.textCalls.length - 1].contents;
    const prompt = c[c.length - 1].parts[0].text.split('\n').pop();
    assert.ok(serverSrc.includes(JSON.stringify(prompt)), `${cmd} prompt differs from server.ts: ${prompt}`);
  }
});

test('mic audio is metered and forwarded; STT rotates after 9 minutes with audio buffered', async () => {
  const fake = makeFakeAi();
  const { session, clock, logs } = makeSession(fake);
  await session.start();
  const oneSec = Buffer.alloc(32000).toString('base64');
  session.handleClientMessage({ type: 'realtime_audio', audio: oneSec });
  assert.equal(fake.stt[0].sent.length, 1);
  assert.equal(fake.stt[0].sent[0].audio.mimeType, 'audio/pcm;rate=16000');
  clock.advance(STT_ROTATE_AFTER_MS);
  session.handleClientMessage({ type: 'text_prompt', text: 'hi' }); // tutor turn start triggers rotation
  session.handleClientMessage({ type: 'realtime_audio', audio: oneSec }); // buffered during swap
  await flush();
  assert.equal(fake.stt.length, 2);
  assert.equal(fake.stt[0].closed, true);
  assert.equal(fake.stt[1].sent.length, 1, 'buffered audio flushed to the new STT session');
  assert.ok(logs.includes('[poc] stt_rotated'));
  assert.equal(session.usage().sttAudioSec, 2);
});

test('usage: STT output tokens estimated (and flagged) when STT sends no usageMetadata', async () => {
  const fake = makeFakeAi();
  const { session, clock } = makeSession(fake);
  await session.start();
  fake.stt[0].cb.onmessage(finalSeg('abcdefgh'));
  clock.advance(CASCADE_SETTLE_MS);
  await flush();
  let u = session.usage();
  assert.equal(u.sttOutEstimated, true);
  assert.equal(u.sttOutTokens, 2);
  fake.stt[0].cb.onmessage({ usageMetadata: { candidatesTokenCount: 7 } });
  u = session.usage();
  assert.equal(u.sttOutEstimated, false);
  assert.equal(u.sttOutTokens, 7);
});

test('turn errors keep the session alive and summary is logged once on close', async () => {
  const fake = makeFakeAi();
  fake.ai.streamText = async () => {
    throw new Error('boom');
  };
  const { session, sent, logs } = makeSession(fake);
  await session.start();
  session.handleClientMessage({ type: 'text_prompt', text: 'hi' });
  await flush();
  assert.deepEqual(sent[sent.length - 1], { type: 'error', error: 'cascade_turn_failed' });
  assert.ok(logs.includes('[poc] stage=turn_error msg=boom'));
  session.close();
  session.close();
  assert.equal(logs.filter((l) => l.startsWith('[poc-summary]')).length, 1);
  assert.match(logs.find((l) => l.startsWith('[poc-summary]'))!, /turns=0 medianFinalToAudio=0ms p90FinalToAudio=0ms bargeIns=0 echoDrops=0 ttsStreams=0 sttAudioSec=0\.00 ttsAudioSec=0\.00 usd=/);
});

test('reconnect history is sanitized and used as context', async () => {
  const fake = makeFakeAi();
  const { session } = makeSession(fake, [{ role: 'model', text: 'Hi!' }, { role: 'user', text: 'Hello' }, { role: 'evil', text: 'x' }]);
  await session.start();
  session.handleClientMessage({ type: 'text_prompt', text: 'go on' });
  await flush();
  const roles = fake.textCalls[0].contents.map((c: any) => c.role);
  assert.deepEqual(roles, ['user', 'model', 'user']);
});

test('Gemini adapter: TEXT-only STT, text cap/temp/finishReason with thinking retry, and streaming TTS via interactions', async () => {
  const calls: any[] = [];
  const genai = {
    live: { connect: async (req: any) => (calls.push(['live', req]), { sendRealtimeInput() {}, close() {} }) },
    models: {
      generateContentStream: async (req: any) => {
        calls.push(['text', req]);
        if (req.config.thinkingConfig) throw new Error('thinking_level is not supported');
        return (async function* () {
          yield {
            text: 'Hi.',
            usageMetadata: { promptTokenCount: 1 },
            candidates: [{ finishReason: 'STOP' }],
          };
        })();
      },
      generateContent: async (req: any) => {
        calls.push(['tts-legacy', req]);
        return { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(4).toString('base64'), mimeType: 'audio/L16;codec=pcm;rate=24000' } }] } }], usageMetadata: { promptTokenCount: 3 } };
      },
    },
  };
  const ttsGenai = {
    interactions: {
      create: async (req: any, opts: any) => {
        calls.push(['tts-stream', req, opts]);
        return (async function* () {
          yield {
            event_type: 'step.delta',
            delta: { type: 'audio', data: Buffer.from([1, 2, 3, 4]).toString('base64'), sample_rate: 24000 },
            metadata: { total_usage: { total_input_tokens: 7, total_output_tokens: 10 } },
          };
          yield {
            event_type: 'interaction.completed',
            interaction: { usage: { total_input_tokens: 9, total_output_tokens: 20 } },
          };
        })();
      },
    },
  };
  const ai = createGeminiCascadeAi(genai, { stt: 's', text: 't', tts: 'v' }, ttsGenai);
  await ai.connectStt({ onmessage() {}, onerror() {}, onclose() {} });
  assert.deepEqual(calls[0][1].config, { responseModalities: ['TEXT'], inputAudioTranscription: { languageCodes: [] } });
  const origWarn = console.warn;
  console.warn = () => {};
  const out: { text?: string; finishReason?: string }[] = [];
  try {
    for await (const ch of await ai.streamText({
      systemInstruction: 'x',
      contents: [],
      maxOutputTokens: POC_MAX_OUTPUT_TOKENS,
      signal: new AbortController().signal,
    })) {
      out.push({ text: ch.text, finishReason: ch.finishReason });
    }
  } finally {
    console.warn = origWarn;
  }
  assert.deepEqual(out, [{ text: 'Hi.', finishReason: 'STOP' }]);
  const textCalls = calls.filter((c) => c[0] === 'text');
  assert.equal(textCalls.length, 2);
  assert.equal(textCalls[0][1].config.maxOutputTokens, POC_MAX_OUTPUT_TOKENS);
  assert.equal(textCalls[0][1].config.temperature, POC_TEMPERATURE);

  const ac = new AbortController();
  const ttsOut: any[] = [];
  for await (const item of await ai.streamSpeech({ text: 'Hi.', voiceName: 'Kore', signal: ac.signal })) {
    ttsOut.push(item);
  }
  const ttsCall = calls.find((c) => c[0] === 'tts-stream');
  assert.deepEqual(ttsCall[1], {
    model: 'v',
    input: [{ type: 'user_input', content: [{ type: 'text', text: 'Hi.' }] }],
    response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 },
    generation_config: { speech_config: [{ voice: 'Kore' }] },
    stream: true,
  });
  assert.equal(ttsCall[2].fetchOptions.signal, ac.signal);
  assert.equal(ttsOut.length, 2);
  assert.equal(ttsOut[0].audio.byteLength, 4);
  assert.equal(ttsOut[0].sampleRate, 24000);
  assert.deepEqual(ttsOut[0].usage, { inputTokens: 7, outputTokens: 10 });
  assert.deepEqual(ttsOut[1].usage, { inputTokens: 9, outputTokens: 20 });
});

test('cascade socket: no server key → fallback_required, never a session', () => {
  const handlers: Record<string, (x?: any) => void> = {};
  const out: string[] = [];
  const ws = {
    readyState: 1,
    send: (d: string) => out.push(d),
    close() {},
    on: (ev: string, fn: any) => {
      handlers[ev] = fn;
    },
  };
  handleCascadeConnection(ws as any, { getGenAI: () => null, log: () => {} });
  handlers.message(Buffer.from(JSON.stringify({ type: 'init', systemInstruction: 'x' })));
  assert.deepEqual(out.map((d) => JSON.parse(d)), [{ type: 'fallback_required', error: 'cascade_connect_failed' }]);
});

test('cascade socket: init starts a session with the fake AI and relays ready', async () => {
  const handlers: Record<string, (x?: any) => void> = {};
  const out: any[] = [];
  const ws = { readyState: 1, send: (d: string) => out.push(JSON.parse(d)), close() {}, on: (ev: string, fn: any) => (handlers[ev] = fn) };
  const fake = makeFakeAi();
  handleCascadeConnection(ws as any, { getGenAI: () => ({}), makeAi: () => fake.ai, log: () => {} });
  handlers.message(JSON.stringify({ type: 'init', systemInstruction: 'x', voiceName: 'Kore' }));
  await flush();
  assert.equal(out[0].type, 'ready');
  handlers.close();
  assert.equal(fake.stt[0].closed, true);
});

test('speaker echo of the tutor is not taken as a user turn', async () => {
  const fake = makeFakeAi({ ttsBytes: 240000 }); // 5 s per sentence
  const { session, clock, logs } = makeSession(fake);
  await session.start();
  session.handleClientMessage({ type: 'text_prompt', text: 'start' });
  await flush();
  fake.stt[0].cb.onmessage(finalSeg('how are you today'));
  clock.advance(CASCADE_SETTLE_MS * 40);
  await flush();
  assert.equal(fake.textCalls.length, 1, 'echo did not start a new reply');
  assert.ok(logs.includes('[poc] echo_dropped'));
});

test('a one-word remark while the tutor speaks waits for the tutor to finish', async () => {
  const fake = makeFakeAi({ ttsBytes: 240000 }); // 2 sentences × 5 s
  const { session, clock, sent } = makeSession(fake);
  await session.start();
  session.handleClientMessage({ type: 'text_prompt', text: 'start' });
  await flush();
  fake.stt[0].cb.onmessage(finalSeg('Yeah.'));
  clock.advance(CASCADE_SETTLE_MS);
  await flush();
  assert.equal(fake.textCalls.length, 1, 'no new reply while the tutor is still talking');
  assert.ok(!types(sent).includes('interrupted'));
  clock.advance(10_000);
  await flush();
  assert.equal(fake.textCalls.length, 2, 'reply after the tutor finished');
  const c = fake.textCalls[1].contents;
  assert.equal(c[c.length - 1].parts[0].text, 'Yeah.');
});

test('turn timing starts at the last final segment, so finalToAudio includes the 0.4 s wait', async () => {
  const fake = makeFakeAi();
  const { session, clock, sent } = makeSession(fake);
  await session.start();
  fake.stt[0].cb.onmessage(interim('I went'));
  clock.advance(300);
  fake.stt[0].cb.onmessage(finalSeg('I went hiking.'));
  clock.advance(CASCADE_SETTLE_MS);
  await flush();
  const turn = sent.find((m) => m.type === 'poc_turn');
  assert.equal(turn.interimToFinalMs, 300);
  assert.equal(turn.finalToTokenMs, CASCADE_SETTLE_MS);
  assert.equal(turn.finalToAudioMs, CASCADE_SETTLE_MS);
});

test('STT drop mid-call: one reconnect, then stt_closed if that fails too', async () => {
  const fake = makeFakeAi();
  const { session, sent, logs } = makeSession(fake);
  await session.start();
  fake.stt[0].cb.onclose();
  await flush();
  assert.equal(fake.stt.length, 2);
  assert.ok(logs.includes('[poc] stt_reconnected'));
  session.handleClientMessage({ type: 'realtime_audio', audio: Buffer.alloc(320).toString('base64') });
  assert.equal(fake.stt[1].sent.length, 1, 'audio goes to the new STT session');
  // Second drop: reconnect fails → client told stt_closed, session itself stays open.
  fake.ai.connectStt = () => Promise.reject(new Error('down'));
  fake.stt[1].cb.onerror(new Error('net'));
  await flush();
  assert.deepEqual(sent[sent.length - 1], { type: 'error', error: 'stt_closed' });
});

test('TTS failure mid-turn reports cascade_turn_failed without turnComplete', async () => {
  const fake = makeFakeAi();
  fake.ai.streamSpeech = async () => {
    throw new Error('tts 500');
  };
  const { session, sent, logs } = makeSession(fake);
  await session.start();
  session.handleClientMessage({ type: 'text_prompt', text: 'hi' });
  await flush();
  assert.ok(!types(sent).includes('turnComplete'));
  assert.ok(!types(sent).includes('audio'));
  assert.deepEqual(sent[sent.length - 1], { type: 'error', error: 'cascade_turn_failed' });
  assert.ok(logs.includes('[poc] stage=turn_error msg=tts 500'));
});

test('STT rotation failure keeps the old session and flushes the buffered audio to it', async () => {
  const fake = makeFakeAi();
  const { session, clock, logs } = makeSession(fake);
  await session.start();
  clock.advance(STT_ROTATE_AFTER_MS);
  fake.ai.connectStt = () => Promise.reject(new Error('quota'));
  session.handleClientMessage({ type: 'text_prompt', text: 'hi' });
  session.handleClientMessage({ type: 'realtime_audio', audio: Buffer.alloc(320).toString('base64') });
  await flush();
  assert.ok(logs.some((l) => l.startsWith('[poc] stage=stt_rotate_failed')));
  assert.equal(fake.stt[0].closed, false);
  assert.equal(fake.stt[0].sent.length, 1);
});

test('echo rule boundary: 70% overlap is echo, 2 of 3 words (67%) is not', () => {
  // via the exported text helpers used by the session
  return import('../server/cascadeText.ts').then(({ isLikelyEcho }) => {
    const tutor = 'alpha beta gamma delta epsilon zeta eta';
    assert.equal(isLikelyEcho('alpha beta gamma delta epsilon zeta eta x y z', tutor), true); // 7/10
    assert.equal(isLikelyEcho('alpha beta qqq', tutor), false); // 2/3
  });
});

test('echo grace: an echo final 1.5 s after the tutor finishes is dropped, after that it is a user turn', async () => {
  const fake = makeFakeAi({ ttsBytes: 24000, ttsChunks: 2, reply: 'Nice to meet you.' }); // 1 s of audio
  const { session, clock } = makeSession(fake);
  await session.start();
  session.handleClientMessage({ type: 'text_prompt', text: 'start' });
  await flush();
  clock.advance(1000 + 1499); // tutor audio ended 1.499 s ago
  fake.stt[0].cb.onmessage(finalSeg('nice to meet you'));
  clock.advance(CASCADE_SETTLE_MS * 3);
  await flush();
  assert.equal(fake.textCalls.length, 1, 'inside the grace window: dropped');
  fake.stt[0].cb.onmessage(finalSeg('nice to meet you'));
  clock.advance(CASCADE_SETTLE_MS);
  await flush();
  assert.equal(fake.textCalls.length, 2, 'after the grace window: a real user turn (repeat practice)');
});

test('barge-in also reports usage so interrupted turns are billed', async () => {
  const fake = makeFakeAi({ holdTts: true });
  const { session, sent } = makeSession(fake);
  await session.start();
  session.handleClientMessage({ type: 'text_prompt', text: 'start' });
  await flush();
  session.handleClientMessage({ type: 'interrupt' });
  const i = types(sent).indexOf('interrupted');
  assert.equal(sent[i + 1].type, 'poc_usage');
  fake.ttsRelease.forEach((r) => r());
  await flush();
});

test('a button prompt during the 0.4 s wait keeps the pending speech, in order', async () => {
  const fake = makeFakeAi();
  const { session, clock } = makeSession(fake);
  await session.start();
  fake.stt[0].cb.onmessage(finalSeg('I think so.'));
  session.handleClientMessage({ type: 'control_command', command: 'Feedback' });
  await flush();
  const last = fake.textCalls[0].contents.at(-1).parts[0].text;
  assert.equal(last, 'I think so.\nFeedback. (Please provide quick feedback on what I just said.)');
  clock.advance(CASCADE_SETTLE_MS * 2);
  await flush();
  assert.equal(fake.textCalls.length, 1, 'the speech is not sent a second time');
});

test('old STT dying during a failed rotation goes through the one-reconnect path', async () => {
  const fake = makeFakeAi();
  const { session, clock, sent } = makeSession(fake);
  await session.start();
  clock.advance(STT_ROTATE_AFTER_MS);
  let release!: (v: unknown) => void;
  const realConnect = fake.ai.connectStt.bind(fake.ai);
  let calls = 0;
  fake.ai.connectStt = (cb) => {
    calls++;
    if (calls === 1) return new Promise((_, rej) => (release = rej));
    return realConnect(cb);
  };
  session.handleClientMessage({ type: 'text_prompt', text: 'hi' });
  await flush();
  fake.stt[0].cb.onclose(); // old session dies mid-rotation
  release(new Error('rotate failed'));
  await flush();
  assert.equal(calls, 2, 'reconnected after the failed rotation');
  assert.equal(fake.stt.length, 2);
  assert.ok(!sent.some((m) => m.error === 'stt_closed'));
});

test('length: maxOutputTokensFor short vs Done/Model answer, passed to streamText, and MAX_TOKENS tail dropped', async () => {
  assert.equal(maxOutputTokensFor('Hello there'), POC_MAX_OUTPUT_TOKENS);
  assert.equal(maxOutputTokensFor('Done'), POC_MAX_OUTPUT_TOKENS);
  assert.equal(
    maxOutputTokensFor('Feedback. (Please provide quick feedback on what I just said.)'),
    POC_MAX_OUTPUT_TOKENS,
  );
  assert.equal(
    maxOutputTokensFor(
      'Done. (I have finished my answer. Please provide concise feedback, estimated level, and AL upgrade expression under 40 seconds.)',
    ),
    POC_LONG_MAX_OUTPUT_TOKENS,
  );
  assert.equal(
    maxOutputTokensFor(
      'Model answer. (Please give a 60-second AL model answer to this question using my details.)',
    ),
    POC_LONG_MAX_OUTPUT_TOKENS,
  );

  // Voice turn gets 150; Done control command gets 600.
  const fake = makeFakeAi({
    reply: 'That sounds great! What did you enjoy most? And then I was about to',
    finishReason: 'MAX_TOKENS',
  });
  const { session, clock, sent, logs } = makeSession(fake);
  await session.start();
  fake.stt[0].cb.onmessage(finalSeg('I went to the park.'));
  clock.advance(CASCADE_SETTLE_MS);
  await flush();
  assert.equal(fake.textCalls[0].maxOutputTokens, 150);
  assert.deepEqual(fake.ttsCalls.map((c) => c.text), ['That sounds great! What did you enjoy most?']);
  assert.ok(logs.includes('[poc] stage=reply_capped'));
  const transcripts = sent.filter((m) => m.type === 'output_transcript').map((m) => m.text);
  assert.deepEqual(transcripts, ['That sounds great! What did you enjoy most?']);

  // Done button gets 600.
  session.handleClientMessage({ type: 'control_command', command: 'Done' });
  await flush();
  assert.equal(fake.textCalls[1].maxOutputTokens, 600);
});

test('chunking: 2-sentence reply uses 1 stream; long 3+ sentence reply (first >= 80 chars) uses 2 streams in order', async () => {
  // 2-sentence reply -> 1 stream, 3 chunks forwarded in order
  const shortFake = makeFakeAi({ reply: 'Nice work! What happened next?', ttsChunks: 3, ttsBytes: 12000 });
  const s1 = makeSession(shortFake);
  await s1.session.start();
  s1.session.handleClientMessage({ type: 'text_prompt', text: 'hi' });
  await flush();
  assert.equal(shortFake.ttsCalls.length, 1);
  assert.equal(shortFake.ttsCalls[0].text, 'Nice work! What happened next?');
  const audioMsgs1 = s1.sent.filter((m) => m.type === 'audio');
  assert.equal(audioMsgs1.length, 3);
  assert.deepEqual(
    audioMsgs1.map((m) => Buffer.from(m.audio, 'base64')[0]),
    [1, 2, 3],
  );

  // Long 3+ sentence reply where sentence 1 >= 80 chars -> 2 streams.
  // Hold stream #1 while stream #2 finishes early; verify #2 audio is buffered until all #1 audio is sent.
  const firstLong =
    'I really enjoyed hearing about your weekend trip to the mountains with your whole family.';
  assert.ok(firstLong.length >= 80);
  const reply = `${firstLong} The weather sounded lovely. Did you take many photos?`;
  const longFake = makeFakeAi({ reply });
  let releaseSeg1Chunk2!: () => void;
  const seg1Chunk2Gate = new Promise<void>((r) => (releaseSeg1Chunk2 = r));
  const streamCalls: string[] = [];
  longFake.ai.streamSpeech = async (req) => {
    streamCalls.push(req.text);
    const segIdx = streamCalls.length;
    return {
      async *[Symbol.asyncIterator]() {
        if (segIdx === 1) {
          const c1 = new Uint8Array(24000);
          c1[0] = 11;
          yield { audio: c1, sampleRate: 24000 };
          await seg1Chunk2Gate;
          const c2 = new Uint8Array(24000);
          c2[0] = 12;
          yield { audio: c2, sampleRate: 24000, usage: { inputTokens: 15 } };
        } else {
          // Stream #2 yields both chunks immediately while stream #1 is still paused!
          const c1 = new Uint8Array(24000);
          c1[0] = 21;
          yield { audio: c1, sampleRate: 24000 };
          const c2 = new Uint8Array(24000);
          c2[0] = 22;
          yield { audio: c2, sampleRate: 24000, usage: { inputTokens: 10 } };
        }
      },
    };
  };
  const s2 = makeSession(longFake);
  await s2.session.start();
  s2.session.handleClientMessage({ type: 'text_prompt', text: 'tell me' });
  await flush();
  assert.equal(streamCalls.length, 2, 'both streams started while #1 is in flight');
  assert.equal(streamCalls[0], firstLong);
  assert.equal(streamCalls[1], 'The weather sounded lovely. Did you take many photos?');
  // Only stream #1 chunk 1 should have been sent so far (stream #2 is buffered).
  assert.deepEqual(
    s2.sent.filter((m) => m.type === 'audio').map((m) => Buffer.from(m.audio, 'base64')[0]),
    [11],
  );
  assert.deepEqual(
    s2.sent.filter((m) => m.type === 'output_transcript').map((m) => m.text),
    [firstLong],
  );

  releaseSeg1Chunk2();
  await flush();
  assert.deepEqual(
    s2.sent.filter((m) => m.type === 'audio').map((m) => Buffer.from(m.audio, 'base64')[0]),
    [11, 12, 21, 22],
  );
  assert.deepEqual(
    s2.sent.filter((m) => m.type === 'output_transcript').map((m) => m.text),
    [firstLong, 'The weather sounded lovely. Did you take many photos?'],
  );
  assert.ok(s2.logs.some((l) => l.startsWith('[poc-tts] n=1 seg=1 ')));
  assert.ok(s2.logs.some((l) => l.startsWith('[poc-tts] n=1 seg=2 ')));
});

test('cancel: barge-in mid-stream aborts signal, stops sending audio, and still counts received chunks', async () => {
  const fake = makeFakeAi({ reply: 'Hello there. How are you today?' });
  let releaseChunk2!: () => void;
  const chunk2Gate = new Promise<void>((r) => (releaseChunk2 = r));
  let recordedSignal!: AbortSignal;
  fake.ai.streamSpeech = async (req) => {
    recordedSignal = req.signal;
    return {
      async *[Symbol.asyncIterator]() {
        yield { audio: new Uint8Array(24000), sampleRate: 24000 }; // 0.5 s sent before barge-in
        await chunk2Gate;
        // Suppose one more chunk arrived from the network right as abort fired:
        yield { audio: new Uint8Array(24000), sampleRate: 24000 }; // 0.5 s received, must NOT be sent
      },
    };
  };
  const { session, sent } = makeSession(fake);
  await session.start();
  session.handleClientMessage({ type: 'text_prompt', text: 'start' });
  await flush();
  assert.equal(sent.filter((m) => m.type === 'audio').length, 1);

  session.handleClientMessage({ type: 'interrupt' });
  assert.equal(recordedSignal.aborted, true);
  releaseChunk2();
  await flush();

  assert.equal(sent.filter((m) => m.type === 'audio').length, 1, 'no audio sent after barge-in');
  assert.ok(!types(sent).includes('turnComplete'));
  assert.equal(session.usage().ttsAudioSec, 1, 'usage still counts every received chunk');
  const lastUsage = sent.filter((m) => m.type === 'poc_usage').at(-1);
  assert.equal(lastUsage.usage.ttsAudioSec, 1, 'the client gets the late chunk in poc_usage too');
  assert.equal(lastUsage.usage.ttsInTokens, session.usage().ttsInTokens);
});

test('cancel with two speech streams: barge-in during stream 1 aborts both and sends nothing from stream 2', async () => {
  const long =
    'This first sentence is deliberately long so that it reaches eighty characters alone. Then a second one. And a third?';
  const fake = makeFakeAi({ reply: long, holdTts: true, ttsChunks: 2 });
  const { session, sent } = makeSession(fake);
  await session.start();
  session.handleClientMessage({ type: 'text_prompt', text: 'start' });
  await flush();
  assert.equal(fake.ttsCalls.length, 2, 'stream 2 started once the text ended');
  fake.ttsRelease.shift()!(); // stream 1 chunk 1
  await flush();
  assert.equal(sent.filter((m) => m.type === 'audio').length, 1);
  session.handleClientMessage({ type: 'interrupt' });
  assert.ok(fake.ttsCalls.every((c) => c.signal.aborted), 'both streams aborted');
  while (fake.ttsRelease.length) fake.ttsRelease.shift()!();
  await flush();
  assert.equal(sent.filter((m) => m.type === 'audio').length, 1, 'nothing more after barge-in');
  assert.ok(!sent.some((m) => m.type === 'output_transcript' && /second/.test(m.text)), 'stream 2 text never shown');
  assert.ok(!types(sent).includes('turnComplete'));
});

test('usage: ttsInTokens uses reported usage (latest seen) or estimates when omitted, and ttsAudioSec sums chunks', async () => {
  // Reported usage (multiple deltas, keep latest)
  const f1 = makeFakeAi({ reply: 'Hello there.' });
  f1.ai.streamSpeech = async () => ({
    async *[Symbol.asyncIterator]() {
      yield { audio: new Uint8Array(24000), sampleRate: 24000, usage: { inputTokens: 4 } };
      yield { audio: new Uint8Array(48000), sampleRate: 24000, usage: { inputTokens: 11 } };
    },
  });
  const s1 = makeSession(f1);
  await s1.session.start();
  s1.session.handleClientMessage({ type: 'text_prompt', text: 'hi' });
  await flush();
  assert.equal(s1.session.usage().ttsInTokens, 11);
  assert.equal(s1.session.usage().ttsAudioSec, 1.5);

  // Omitted usage -> falls back to estimateTextTokens(segment)
  const segText = 'Hello there. How are you today?';
  const f2 = makeFakeAi({ reply: segText, ttsUsage: null, ttsChunks: 3, ttsBytes: 16000 });
  const s2 = makeSession(f2);
  await s2.session.start();
  s2.session.handleClientMessage({ type: 'text_prompt', text: 'hi' });
  await flush();
  assert.equal(s2.session.usage().ttsInTokens, estimateTextTokens(segText));
  assert.equal(s2.session.usage().ttsAudioSec, 1);
});

test('summary includes echoDrops and ttsStreams counts', async () => {
  const fake = makeFakeAi({ ttsBytes: 120000, ttsChunks: 2, reply: 'How are you today?' });
  const { session, logs } = makeSession(fake);
  await session.start();
  session.handleClientMessage({ type: 'text_prompt', text: 'start' });
  await flush();
  fake.stt[0].cb.onmessage(finalSeg('how are you today'));
  session.close();
  const summary = logs.find((l) => l.startsWith('[poc-summary]'))!;
  assert.ok(summary.includes('echoDrops=1'), `expected echoDrops=1 in ${summary}`);
  assert.ok(summary.includes('ttsStreams=1'), `expected ttsStreams=1 in ${summary}`);
});

test('speech stream failing while the text still streams is reported, not swallowed as an abort', async () => {
  const fake = makeFakeAi();
  fake.ai.streamText = async (req) => ({
    async *[Symbol.asyncIterator]() {
      yield { text: 'First sentence here. Second one now. ' };
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      if (req.signal.aborted) {
        const e: any = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      yield { text: 'Third.' };
    },
  });
  fake.ai.streamSpeech = async () => {
    throw new Error('tts 503');
  };
  const { session, sent, logs } = makeSession(fake);
  await session.start();
  session.handleClientMessage({ type: 'text_prompt', text: 'hi' });
  await flush();
  assert.ok(!types(sent).includes('turnComplete'));
  assert.deepEqual(sent[sent.length - 1], { type: 'error', error: 'cascade_turn_failed' });
  assert.ok(logs.includes('[poc] stage=turn_error msg=tts 503'));
});

test('cascade socket: speech goes through the separate v1beta client, text and STT through the default one', async () => {
  const handlers: Record<string, (x?: any) => void> = {};
  const out: any[] = [];
  const ws = { readyState: 1, send: (d: string) => out.push(JSON.parse(d)), close() {}, on: (ev: string, fn: any) => (handlers[ev] = fn) };
  const used: string[] = [];
  const main = {
    live: { connect: async () => (used.push('main.live'), { sendRealtimeInput() {}, close() {} }) },
    models: {
      generateContentStream: async () => {
        used.push('main.text');
        return (async function* () {
          yield { text: 'Hello. How are you?' };
        })();
      },
    },
    interactions: { create: async () => { throw new Error('speech must not use the default client'); } },
  };
  const v1beta = {
    interactions: {
      create: async () => {
        used.push('v1beta.speech');
        return (async function* () {
          yield { event_type: 'step.delta', delta: { type: 'audio', data: Buffer.alloc(480).toString('base64') } };
        })();
      },
    },
  };
  handleCascadeConnection(ws as any, { getGenAI: () => main, getTtsGenAI: () => v1beta, log: () => {} });
  handlers.message(JSON.stringify({ type: 'init', systemInstruction: 'x', voiceName: 'Kore' }));
  await flush();
  handlers.message(JSON.stringify({ type: 'text_prompt', text: 'hi' }));
  await flush(60);
  assert.deepEqual(used, ['main.live', 'main.text', 'v1beta.speech']);
  assert.ok(out.some((m) => m.type === 'audio'));
  assert.ok(out.some((m) => m.type === 'turnComplete'));
  handlers.close();
});

test('Gemini adapter: an Interactions error event or failed status ends the speech stream with an error', async () => {
  for (const bad of [
    { event_type: 'error', error: { message: 'quota' } },
    { event_type: 'interaction.status_update', status: 'failed' },
  ]) {
    const ttsGenai = {
      interactions: {
        create: async () =>
          (async function* () {
            yield { event_type: 'step.delta', delta: { type: 'audio', data: Buffer.alloc(4).toString('base64') } };
            yield bad;
          })(),
      },
    };
    const ai = createGeminiCascadeAi({}, { stt: 's', text: 't', tts: 'v' }, ttsGenai);
    const got: any[] = [];
    await assert.rejects(async () => {
      for await (const item of await ai.streamSpeech({ text: 'Hi.', voiceName: 'Kore', signal: new AbortController().signal })) {
        got.push(item);
      }
    }, /tts_stream_(error quota|failed)/);
    assert.equal(got.length, 1, 'audio before the error was still delivered');
  }
});
