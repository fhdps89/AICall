import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import {
  DATA_DIR,
  readLectureState,
  startLectureJob,
  synthesizeGemini,
  type LecturePcm,
  type LectureScriptItem,
  type LectureState,
} from '../server/lecture.ts';
import { buildLectureSpeechPlan } from '../server/lectureMaterial.ts';
import { classifyLectureAudioError, sanitizeAudioError } from '../server/lectureAudioError.ts';
import { wavFromPcm, type LectureEncodeFn } from '../server/lectureAudioEncode.ts';

const ai = {} as GoogleGenAI;

function uidFor(name: string): string {
  return `test_ttstiming_${name}_${process.pid}`;
}

function cleanup(uid: string) {
  fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
}

function silentPcm(): LecturePcm {
  return { data: Buffer.alloc(2400 * 2), rate: 24000 };
}

const wavEncode: LectureEncodeFn = async (pcm, rate) => ({
  ext: 'wav',
  mime: 'audio/wav',
  buffer: wavFromPcm(pcm, rate),
});

async function waitForJobSettled(
  uid: string,
  date: string,
  timeoutMs = 2000
): Promise<LectureState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = readLectureState(uid, date);
    if (st && st.status !== 'generating') return st;
    await new Promise((r) => setTimeout(r, 15));
  }
  return readLectureState(uid, date);
}

test('(a) synthesizeGemini records attemptMs deltas via opts.now, logs safe attempt warnings, and classifies with attemptMs and errName', async () => {
  let clock = 10_000;
  const fakeNow = () => {
    clock += 1000;
    return clock;
  };
  const origWarn = console.warn;
  const warnLogs: string[] = [];
  console.warn = (...args: unknown[]) => warnLogs.push(args.map(String).join(' '));

  let caught: any;
  try {
    try {
      await synthesizeGemini(
        {
          models: {
            generateContent: async () => {
              throw Object.assign(new Error('SECRET_RAW_MSG_SHOULD_NOT_LOG'), {
                name: 'CustomTtsError',
              });
            },
          },
        } as unknown as GoogleGenAI,
        'Coach: hi',
        false,
        undefined,
        { sleepFn: async () => {}, now: fakeNow }
      );
      assert.fail('expected synthesizeGemini to throw');
    } catch (err) {
      caught = err;
    }
  } finally {
    console.warn = origWarn;
  }

  assert.equal(caught.attempts, 3);
  assert.deepEqual(caught.attemptMs, [1000, 1000, 1000]);

  const attemptWarns = warnLogs.filter((l) => l.startsWith('[Lecture] TTS attempt failed: '));
  assert.equal(attemptWarns.length, 3);
  attemptWarns.forEach((line, idx) => {
    assert.equal(line.includes('SECRET_RAW_MSG_SHOULD_NOT_LOG'), false);
    const parsed = JSON.parse(line.replace('[Lecture] TTS attempt failed: ', ''));
    assert.equal(typeof parsed.loopDelayMaxMs, 'number');
    assert.equal(Number.isInteger(parsed.loopDelayMaxMs) && parsed.loopDelayMaxMs >= 0, true);
    const { loopDelayMaxMs: _ld, ...rest } = parsed;
    assert.deepEqual(rest, {
      attempt: idx + 1,
      elapsedMs: 1000,
      errName: 'CustomTtsError',
      code: 'UNKNOWN',
    });
  });

  const classified = classifyLectureAudioError(caught, { stage: 'tts' });
  assert.equal(classified.code, 'UNKNOWN');
  assert.equal(classified.attempts, 3);
  assert.deepEqual(classified.attemptMs, [1000, 1000, 1000]);
  assert.equal(classified.errName, 'CustomTtsError');
});

test('(b) synthesizeGemini real GoogleGenAI SDK body stall classifies STEP_TIMEOUT after 3 attempts with attemptMs >= 150', async () => {
  const sockets = new Set<Socket>();
  let requestCount = 0;
  const server = http.createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"candidates":[{"content":');
    // Intentionally never end response so body read stalls until stepTimeoutMs
  });
  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.once('close', () => sockets.delete(sock));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const addr = server.address() as AddressInfo;
    const sdkAi = new GoogleGenAI({
      apiKey: 'test-not-a-key',
      httpOptions: { baseUrl: `http://127.0.0.1:${addr.port}` },
    });
    let caught: any;
    try {
      await synthesizeGemini(sdkAi, 'Coach: body stall', false, undefined, {
        stepTimeoutMs: 200,
        sleepFn: async () => {},
      });
      assert.fail('expected synthesizeGemini to throw');
    } catch (err) {
      caught = err;
    }

    assert.equal(requestCount, 3);
    assert.equal(caught.attempts, 3);
    assert.ok(Array.isArray(caught.attemptMs));
    assert.equal(caught.attemptMs.length, 3);
    for (const ms of caught.attemptMs) {
      assert.ok(ms >= 150 && ms < 200 * 3, `expected 150 <= attemptMs < 600, got ${ms}`);
    }

    const classified = classifyLectureAudioError(caught, { stage: 'tts' });
    assert.equal(classified.code, 'STEP_TIMEOUT');
    assert.equal(classified.errName, 'TimeoutError');
    assert.equal(classified.attempts, 3);
    assert.equal(classified.attemptMs?.length, 3);
    for (const ms of classified.attemptMs ?? []) {
      assert.ok(ms >= 150 && ms < 200 * 3, `expected 150 <= classified attemptMs < 600, got ${ms}`);
    }
  } finally {
    for (const sock of sockets) sock.destroy();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('(c) sanitizeAudioError keeps valid new fields, drops invalid ones, and preserves old shape without them', () => {
  const base = {
    stage: 'tts' as const,
    code: 'STEP_TIMEOUT' as const,
    httpStatus: null,
    googleStatus: null,
    quota: null,
    retryDelaySec: null,
    attempts: 3,
    completed: 2,
    total: 7,
    at: '2026-11-26T00:00:00.000Z',
    origin: 'local' as const,
  };

  assert.deepEqual(sanitizeAudioError(base), base);

  const withValid = {
    ...base,
    segIndex: 4,
    segChars: 85,
    elapsedMs: 90123,
    attemptMs: [90001, 90002, 90003],
    loopDelayMaxMs: 420,
    errName: 'TimeoutError',
  };
  assert.deepEqual(sanitizeAudioError(withValid), withValid);

  const invalidCases: Array<Record<string, unknown>> = [
    {
      ...base,
      segIndex: -1,
      segChars: -5,
      elapsedMs: -10,
      attemptMs: [100, -1],
      loopDelayMaxMs: -1,
      errName: 'https://bad-name',
    },
    {
      ...base,
      segIndex: Number.NaN,
      segChars: 100_001,
      elapsedMs: 3_600_001,
      attemptMs: [10, 20, 30, 40],
      loopDelayMaxMs: 3_600_001,
      errName: '1startsWithDigit',
    },
    {
      ...base,
      segIndex: 1.5,
      segChars: Number.POSITIVE_INFINITY,
      elapsedMs: '123',
      attemptMs: [10, Number.NaN],
      loopDelayMaxMs: 12.5,
      errName: 'A'.repeat(42),
    },
  ];

  for (const invalid of invalidCases) {
    const out = sanitizeAudioError(invalid);
    assert.ok(out);
    assert.deepEqual(out, base);
    assert.equal('segIndex' in out, false);
    assert.equal('segChars' in out, false);
    assert.equal('elapsedMs' in out, false);
    assert.equal('attemptMs' in out, false);
    assert.equal('loopDelayMaxMs' in out, false);
    assert.equal('errName' in out, false);
  }
});

test('(d) end-to-end startLectureJob/renderAndSaveAudio attaches segIndex, segChars, elapsedMs when 3rd speech segment throws', async () => {
  const uid = uidFor('seg3_fail');
  const date = '2026-11-26';
  const items: LectureScriptItem[] = [
    {
      mistakeId: 'm1',
      kind: 'new',
      myPhrase: 'I go yesterday',
      naturalPhrase: 'I went yesterday',
      explanation: '과거 시제를 써야 해요.',
      dialogue: [{ speaker: 'Coach', line: 'I went yesterday.' }],
      meaningKo: '나는 어제 갔다',
      answerEnglish: 'I went yesterday',
    },
  ];
  const title = '오늘의 표현 연습';
  const coachNote = '잘 하셨어요. 꾸준히 연습해 보세요.';
  const plan = buildLectureSpeechPlan(title, items, coachNote, date);
  const speechIndices = plan
    .map((seg, idx) => (seg.kind === 'speech' ? idx : -1))
    .filter((idx) => idx >= 0);
  assert.ok(speechIndices.length >= 4);
  const thirdPlanIdx = speechIndices[2];
  const thirdSeg = plan[thirdPlanIdx];
  assert.equal(thirdSeg.kind, 'speech');
  const thirdText = thirdSeg.text;
  const closingSeg = plan[speechIndices[speechIndices.length - 1]];
  const closingText = closingSeg.kind === 'speech' ? closingSeg.text : '';

  const origLog = console.log;
  const origErr = console.error;
  const segOkLogs: string[] = [];
  const jobErrLogs: string[] = [];
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[Lecture] TTS segment ok: ')) segOkLogs.push(line);
  };
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[Lecture] job failed: ')) jobErrLogs.push(line);
  };

  try {
    startLectureJob(
      ai,
      uid,
      date,
      [{ id: 'm1', myPhrase: 'I go yesterday', naturalPhrase: 'I went yesterday' }],
      [],
      {
        generateScriptFn: async () => ({
          title,
          items,
          coachNote,
        }),
        synthesizeFn: async (_ai, _engine, text) => {
          if (text === thirdText) {
            await new Promise((r) => setTimeout(r, 15));
            throw Object.assign(new Error('segment 3 boom'), {
              name: 'TimeoutError',
              attempts: 3,
              attemptMs: [40, 50, 60],
              loopDelayMaxMs: 75,
            });
          }
          if (text === closingText) {
            await new Promise((r) => setTimeout(r, 40));
          }
          return silentPcm();
        },
        encodeFn: wavEncode,
      }
    );

    const settled = await waitForJobSettled(uid, date);
    assert.ok(settled);
    assert.equal(settled.status, 'failed');
    assert.equal(settled.error, 'GENERATION_FAILED');
    assert.ok(settled.audioError);
    assert.equal(settled.audioError.stage, 'tts');
    assert.equal(settled.audioError.code, 'STEP_TIMEOUT');
    assert.equal(settled.audioError.segIndex, thirdPlanIdx);
    assert.equal(settled.audioError.segChars, thirdText.length);
    assert.ok(thirdText.length > 0);
    assert.equal(typeof settled.audioError.elapsedMs, 'number');
    assert.ok((settled.audioError.elapsedMs ?? -1) >= 0);
    assert.equal(settled.audioError.completed, 2);
    assert.equal(settled.audioError.total, speechIndices.length);
    assert.deepEqual(settled.audioError.attemptMs, [40, 50, 60]);
    assert.equal(settled.audioError.loopDelayMaxMs, 75);
    assert.equal(settled.audioError.errName, 'TimeoutError');

    assert.ok(segOkLogs.length >= 2);
    const parsedSeg0 = JSON.parse(segOkLogs[0].replace('[Lecture] TTS segment ok: ', ''));
    assert.equal(parsedSeg0.cached, false);
    assert.equal(typeof parsedSeg0.elapsedMs, 'number');
    assert.ok(parsedSeg0.segChars > 0);

    assert.equal(jobErrLogs.length, 1);
    const parsedJobErr = JSON.parse(jobErrLogs[0].replace('[Lecture] job failed: ', ''));
    assert.equal(parsedJobErr.segIndex, thirdPlanIdx);
    assert.equal(parsedJobErr.segChars, thirdText.length);
    assert.equal(typeof parsedJobErr.elapsedMs, 'number');
    assert.deepEqual(parsedJobErr.attemptMs, [40, 50, 60]);
    assert.equal(parsedJobErr.loopDelayMaxMs, 75);
  } finally {
    console.log = origLog;
    console.error = origErr;
    cleanup(uid);
  }
});

test('(e) synthesizeGemini generic error keeps 3 attempts and [1500, 3000] sleeps unchanged', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  await assert.rejects(
    synthesizeGemini(
      {
        models: {
          generateContent: async () => {
            calls += 1;
            throw new Error('generic failure');
          },
        },
      } as unknown as GoogleGenAI,
      'Coach: hi',
      false,
      undefined,
      { sleepFn: async (ms) => { sleeps.push(ms); }, now: () => 1_000_000 }
    ),
    (err: any) => err?.attempts === 3
  );
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1500, 3000]);
});

test('(f) superseded caller abort produces no TTS attempt failed console.warn', async () => {
  const ac = new AbortController();
  const origWarn = console.warn;
  const warnLogs: string[] = [];
  console.warn = (...args: unknown[]) => warnLogs.push(args.map(String).join(' '));
  let clock = 5000;
  let caught: any;
  try {
    try {
      await synthesizeGemini(
        {
          models: {
            generateContent: (req: any) => {
              const sig = req.config.abortSignal as AbortSignal;
              setTimeout(() => ac.abort(), 5);
              return new Promise((_resolve, reject) => {
                sig.addEventListener(
                  'abort',
                  () => reject(Object.assign(new Error('aborted by caller'), { name: 'AbortError' })),
                  { once: true }
                );
              });
            },
          },
        } as unknown as GoogleGenAI,
        'Coach: hi',
        false,
        ac.signal,
        {
          sleepFn: async () => {},
          now: () => (clock += 250),
          loopDelayMonitor: () => ({ stop: () => 5 }),
        }
      );
      assert.fail('expected synthesizeGemini to throw');
    } catch (err) {
      caught = err;
    }
  } finally {
    console.warn = origWarn;
  }
  assert.equal(caught.attempts, 1);
  assert.deepEqual(caught.attemptMs, [250]);
  const attemptWarns = warnLogs.filter((l) => l.startsWith('[Lecture] TTS attempt failed: '));
  assert.equal(attemptWarns.length, 0);
});

test('(g) injected loopDelayMonitor values flow into error.loopDelayMaxMs (max across attempts) and classify/sanitize', async () => {
  const samples = [25, 180, 60];
  let monitorIdx = 0;
  const origWarn = console.warn;
  const warnLogs: string[] = [];
  console.warn = (...args: unknown[]) => warnLogs.push(args.map(String).join(' '));
  let caught: any;
  try {
    try {
      await synthesizeGemini(
        {
          models: {
            generateContent: async () => {
              throw new Error('transient boom');
            },
          },
        } as unknown as GoogleGenAI,
        'Coach: hi',
        false,
        undefined,
        {
          sleepFn: async () => {},
          now: () => 10_000,
          loopDelayMonitor: () => ({ stop: () => samples[monitorIdx++] ?? 0 }),
        }
      );
      assert.fail('expected synthesizeGemini to throw');
    } catch (err) {
      caught = err;
    }
  } finally {
    console.warn = origWarn;
  }

  assert.equal(caught.loopDelayMaxMs, 180);
  const attemptWarns = warnLogs.filter((l) => l.startsWith('[Lecture] TTS attempt failed: '));
  assert.equal(attemptWarns.length, 3);
  attemptWarns.forEach((line, idx) => {
    const parsed = JSON.parse(line.replace('[Lecture] TTS attempt failed: ', ''));
    assert.equal(parsed.loopDelayMaxMs, samples[idx]);
  });

  const classified = classifyLectureAudioError(caught, { stage: 'tts' });
  assert.equal(classified.loopDelayMaxMs, 180);
  const sanitized = sanitizeAudioError(classified);
  assert.equal(sanitized?.loopDelayMaxMs, 180);

  const droppedNeg = sanitizeAudioError({ ...classified, loopDelayMaxMs: -1 });
  assert.equal('loopDelayMaxMs' in (droppedNeg ?? {}), false);
  const droppedHuge = sanitizeAudioError({ ...classified, loopDelayMaxMs: 3_600_001 });
  assert.equal('loopDelayMaxMs' in (droppedHuge ?? {}), false);
  const droppedFloat = sanitizeAudioError({ ...classified, loopDelayMaxMs: 12.3 });
  assert.equal('loopDelayMaxMs' in (droppedFloat ?? {}), false);
  const droppedStr = sanitizeAudioError({ ...classified, loopDelayMaxMs: '180' as any });
  assert.equal('loopDelayMaxMs' in (droppedStr ?? {}), false);
});
