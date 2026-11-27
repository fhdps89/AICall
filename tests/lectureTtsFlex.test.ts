import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleGenAI, ServiceTier } from '@google/genai';
import {
  LECTURE_TTS_FLEX_COOLDOWN_MS,
  LECTURE_TTS_FLEX_TIMEOUT_MS,
  resetLectureTtsFlexStateForTest,
  synthesizeGemini,
} from '../server/lecture.ts';

function fakeAudioResponse() {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              inlineData: {
                data: Buffer.alloc(240).toString('base64'),
                mimeType: 'audio/pcm;rate=24000',
              },
            },
          ],
        },
      },
    ],
  };
}

test('(1) flex success makes exactly 1 call with config.serviceTier === "flex"', async () => {
  resetLectureTtsFlexStateForTest();
  const prevEnv = process.env.LECTURE_TTS_FLEX;
  delete process.env.LECTURE_TTS_FLEX;
  const captured: any[] = [];
  try {
    const pcm = await synthesizeGemini(
      {
        models: {
          generateContent: async (req: any) => {
            captured.push(req);
            return fakeAudioResponse();
          },
        },
      } as unknown as GoogleGenAI,
      'Coach: hello',
      false,
      undefined,
      { sleepFn: async () => {}, now: () => 1_000_000 }
    );
    assert.equal(pcm.rate, 24000);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].config.serviceTier, ServiceTier.FLEX);
    assert.equal(captured[0].config.serviceTier, 'flex');
  } finally {
    if (prevEnv === undefined) delete process.env.LECTURE_TTS_FLEX;
    else process.env.LECTURE_TTS_FLEX = prevEnv;
    resetLectureTtsFlexStateForTest();
  }
});

test('(2) flex 503 falls back to standard (no serviceTier) and activates cooldown for immediate next call', async () => {
  resetLectureTtsFlexStateForTest();
  const prevEnv = process.env.LECTURE_TTS_FLEX;
  delete process.env.LECTURE_TTS_FLEX;
  const origWarn = console.warn;
  const warnLogs: string[] = [];
  console.warn = (...args: unknown[]) => warnLogs.push(args.map(String).join(' '));

  let clock = 10_000_000;
  const captured: any[] = [];
  const fakeAi = {
    models: {
      generateContent: async (req: any) => {
        captured.push(req);
        if (req.config?.serviceTier === ServiceTier.FLEX) {
          clock += 250;
          throw Object.assign(new Error('503 Service Unavailable SECRET_BODY'), {
            status: 503,
            name: 'ApiError',
          });
        }
        return fakeAudioResponse();
      },
    },
  } as unknown as GoogleGenAI;

  try {
    const pcm1 = await synthesizeGemini(fakeAi, 'Coach: first', false, undefined, {
      sleepFn: async () => {},
      now: () => clock,
    });
    assert.equal(pcm1.rate, 24000);
    assert.equal(captured.length, 2);
    assert.equal(captured[0].config.serviceTier, 'flex');
    assert.equal('serviceTier' in captured[1].config, false);

    const flexWarns = warnLogs.filter((l) => l.startsWith('[Lecture] TTS flex fallback: '));
    assert.equal(flexWarns.length, 1);
    assert.equal(flexWarns[0].includes('SECRET_BODY'), false);
    const parsed = JSON.parse(flexWarns[0].replace('[Lecture] TTS flex fallback: ', ''));
    assert.deepEqual(parsed, { elapsedMs: 250, errName: 'ApiError' });

    // Immediate next call skips flex during cooldown
    clock += 1000;
    const pcm2 = await synthesizeGemini(fakeAi, 'Coach: second', false, undefined, {
      sleepFn: async () => {},
      now: () => clock,
    });
    assert.equal(pcm2.rate, 24000);
    assert.equal(captured.length, 3);
    assert.equal('serviceTier' in captured[2].config, false);

    // After cooldown expires, flex is tried again
    clock += LECTURE_TTS_FLEX_COOLDOWN_MS;
    const pcm3 = await synthesizeGemini(fakeAi, 'Coach: third', false, undefined, {
      sleepFn: async () => {},
      now: () => clock,
    });
    assert.equal(pcm3.rate, 24000);
    assert.equal(captured.length, 5);
    assert.equal(captured[3].config.serviceTier, 'flex');
    assert.equal('serviceTier' in captured[4].config, false);
  } finally {
    console.warn = origWarn;
    if (prevEnv === undefined) delete process.env.LECTURE_TTS_FLEX;
    else process.env.LECTURE_TTS_FLEX = prevEnv;
    resetLectureTtsFlexStateForTest();
  }
});

test('(3) flex: false and LECTURE_TTS_FLEX=off skip flex and omit serviceTier', async () => {
  resetLectureTtsFlexStateForTest();
  const prevEnv = process.env.LECTURE_TTS_FLEX;
  delete process.env.LECTURE_TTS_FLEX;
  try {
    const captured1: any[] = [];
    await synthesizeGemini(
      {
        models: {
          generateContent: async (req: any) => {
            captured1.push(req);
            return fakeAudioResponse();
          },
        },
      } as unknown as GoogleGenAI,
      'Coach: opt off',
      false,
      undefined,
      { flex: false, sleepFn: async () => {} }
    );
    assert.equal(captured1.length, 1);
    assert.equal('serviceTier' in captured1[0].config, false);

    process.env.LECTURE_TTS_FLEX = 'off';
    const captured2: any[] = [];
    await synthesizeGemini(
      {
        models: {
          generateContent: async (req: any) => {
            captured2.push(req);
            return fakeAudioResponse();
          },
        },
      } as unknown as GoogleGenAI,
      'Coach: env off',
      false,
      undefined,
      { sleepFn: async () => {} }
    );
    assert.equal(captured2.length, 1);
    assert.equal('serviceTier' in captured2[0].config, false);
  } finally {
    if (prevEnv === undefined) delete process.env.LECTURE_TTS_FLEX;
    else process.env.LECTURE_TTS_FLEX = prevEnv;
    resetLectureTtsFlexStateForTest();
  }
});

test('(4) flex timeout caps at LECTURE_TTS_FLEX_TIMEOUT_MS (20s) and falls back to standard on timeout', async () => {
  assert.equal(LECTURE_TTS_FLEX_TIMEOUT_MS, 20_000);
  assert.equal(LECTURE_TTS_FLEX_COOLDOWN_MS, 30 * 60 * 1000);
  resetLectureTtsFlexStateForTest();
  const prevEnv = process.env.LECTURE_TTS_FLEX;
  delete process.env.LECTURE_TTS_FLEX;
  const origWarn = console.warn;
  console.warn = () => {};
  const captured: any[] = [];
  try {
    const pcm = await synthesizeGemini(
      {
        models: {
          generateContent: (req: any) => {
            captured.push(req);
            if (req.config?.serviceTier === ServiceTier.FLEX) {
              const sig = req.config.abortSignal as AbortSignal;
              return new Promise((_resolve, reject) => {
                sig.addEventListener(
                  'abort',
                  () => reject(Object.assign(new Error('flex timed out'), { name: 'TimeoutError' })),
                  { once: true }
                );
              });
            }
            return Promise.resolve(fakeAudioResponse());
          },
        },
      } as unknown as GoogleGenAI,
      'Coach: timeout fallback',
      false,
      undefined,
      { stepTimeoutMs: 40, sleepFn: async () => {} }
    );
    assert.equal(pcm.rate, 24000);
    assert.equal(captured.length, 2);
    assert.equal(captured[0].config.serviceTier, 'flex');
    assert.equal(captured[0].config.abortSignal.aborted, true);
    assert.equal('serviceTier' in captured[1].config, false);
  } finally {
    console.warn = origWarn;
    if (prevEnv === undefined) delete process.env.LECTURE_TTS_FLEX;
    else process.env.LECTURE_TTS_FLEX = prevEnv;
    resetLectureTtsFlexStateForTest();
  }
});

test('(5) standard 3-attempt retry, sleeps, and attemptMs are unaffected when flex fails', async () => {
  resetLectureTtsFlexStateForTest();
  const prevEnv = process.env.LECTURE_TTS_FLEX;
  delete process.env.LECTURE_TTS_FLEX;
  const origWarn = console.warn;
  console.warn = () => {};

  let clock = 10_000;
  const fakeNow = () => {
    clock += 1000;
    return clock;
  };
  const captured: any[] = [];
  const sleeps: number[] = [];
  let caught: any;
  try {
    try {
      await synthesizeGemini(
        {
          models: {
            generateContent: async (req: any) => {
              captured.push(req);
              throw Object.assign(new Error('transient failure'), { name: 'CustomTtsError' });
            },
          },
        } as unknown as GoogleGenAI,
        'Coach: retry check',
        false,
        undefined,
        {
          sleepFn: async (ms) => {
            sleeps.push(ms);
          },
          now: fakeNow,
        }
      );
      assert.fail('expected synthesizeGemini to throw');
    } catch (err) {
      caught = err;
    }

    assert.equal(captured.length, 4);
    assert.equal(captured[0].config.serviceTier, 'flex');
    for (let i = 1; i < 4; i++) {
      assert.equal('serviceTier' in captured[i].config, false);
    }
    assert.equal(caught.attempts, 3);
    assert.deepEqual(caught.attemptMs, [1000, 1000, 1000]);
    assert.deepEqual(sleeps, [1500, 3000]);
  } finally {
    console.warn = origWarn;
    if (prevEnv === undefined) delete process.env.LECTURE_TTS_FLEX;
    else process.env.LECTURE_TTS_FLEX = prevEnv;
    resetLectureTtsFlexStateForTest();
  }
});

test('(6) slow flex success keeps the audio but sends later segments to standard', async () => {
  resetLectureTtsFlexStateForTest();
  const prevEnv = process.env.LECTURE_TTS_FLEX;
  delete process.env.LECTURE_TTS_FLEX;
  const origWarn = console.warn;
  console.warn = () => {};
  let clock = 50_000_000;
  const captured: any[] = [];
  const fakeAi = {
    models: {
      generateContent: async (req: any) => {
        captured.push(req);
        if (req.config?.serviceTier === 'flex') clock += 16_000; // slower than LECTURE_TTS_FLEX_SLOW_MS
        return fakeAudioResponse();
      },
    },
  } as unknown as GoogleGenAI;
  try {
    const a = await synthesizeGemini(fakeAi, 'Coach: one', false, undefined, { sleepFn: async () => {}, now: () => clock });
    assert.equal(a.rate, 24000);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].config.serviceTier, 'flex');
    await synthesizeGemini(fakeAi, 'Coach: two', false, undefined, { sleepFn: async () => {}, now: () => clock });
    assert.equal(captured.length, 2);
    assert.equal('serviceTier' in captured[1].config, false);
  } finally {
    console.warn = origWarn;
    if (prevEnv === undefined) delete process.env.LECTURE_TTS_FLEX;
    else process.env.LECTURE_TTS_FLEX = prevEnv;
    resetLectureTtsFlexStateForTest();
  }
});

test('(7) job abort during the flex attempt rethrows without falling back or starting the cooldown', async () => {
  resetLectureTtsFlexStateForTest();
  const prevEnv = process.env.LECTURE_TTS_FLEX;
  delete process.env.LECTURE_TTS_FLEX;
  const origWarn = console.warn;
  const warns: string[] = [];
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(' '));
  const job = new AbortController();
  const captured: any[] = [];
  const fakeAi = {
    models: {
      generateContent: (req: any) => {
        captured.push(req);
        if (req.config?.serviceTier === 'flex') {
          setTimeout(() => job.abort(), 5);
          return new Promise((_r, reject) =>
            req.config.abortSignal.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            )
          );
        }
        return Promise.resolve(fakeAudioResponse());
      },
    },
  } as unknown as GoogleGenAI;
  try {
    await assert.rejects(
      synthesizeGemini(fakeAi, 'Coach: abort', false, job.signal, { sleepFn: async () => {} })
    );
    assert.equal(captured.length, 1);
    assert.equal(warns.some((w) => w.startsWith('[Lecture] TTS flex fallback')), false);
    // No cooldown was set: a fresh job still tries flex first.
    const captured2: any[] = [];
    await synthesizeGemini(
      { models: { generateContent: async (req: any) => (captured2.push(req), fakeAudioResponse()) } } as unknown as GoogleGenAI,
      'Coach: next job',
      false,
      undefined,
      { sleepFn: async () => {} }
    );
    assert.equal(captured2[0].config.serviceTier, 'flex');
    // Already-aborted job never calls the API.
    const captured3: any[] = [];
    const done = new AbortController();
    done.abort();
    await assert.rejects(
      synthesizeGemini(
        { models: { generateContent: async (req: any) => (captured3.push(req), fakeAudioResponse()) } } as unknown as GoogleGenAI,
        'Coach: aborted',
        false,
        done.signal,
        { sleepFn: async () => {} }
      )
    );
    assert.equal(captured3.length, 0);
  } finally {
    console.warn = origWarn;
    if (prevEnv === undefined) delete process.env.LECTURE_TTS_FLEX;
    else process.env.LECTURE_TTS_FLEX = prevEnv;
    resetLectureTtsFlexStateForTest();
  }
});
