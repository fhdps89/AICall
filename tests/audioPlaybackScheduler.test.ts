import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_LEAD_SEC,
  MAX_LEAD_SEC,
  LEAD_STEP_SEC,
  NEW_UTTERANCE_GAP_SEC,
  createScheduler,
  scheduleChunk,
  resetScheduler,
  describeScheduler,
} from '../src/services/providers/audioPlaybackScheduler.ts';
import { GeminiLiveProvider } from '../src/services/providers/geminiLiveProvider.ts';

function createLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function generateJitteredArrivals(
  count: number,
  chunkDurationSec: number,
  maxJitterSec: number,
  seed: number
): number[] {
  const rand = createLcg(seed);
  const arrivals: number[] = [];
  let prevArrival = 0.05;
  let burstRemaining = 0;
  let burstDelay = 0;

  for (let i = 0; i < count; i++) {
    const idealTime = 0.05 + i * chunkDurationSec;
    if (burstRemaining === 0 && rand() < 0.08) {
      // Burst event: delay one packet near maxJitterSec, then flush queued packets rapidly.
      burstRemaining = 3 + Math.floor(rand() * 4);
      burstDelay = maxJitterSec * (0.75 + 0.25 * rand());
    }

    let jitterSec: number;
    if (burstRemaining > 0) {
      jitterSec = burstDelay;
      burstDelay = Math.max(0, burstDelay - chunkDurationSec * 0.8);
      burstRemaining -= 1;
    } else {
      jitterSec = rand() * maxJitterSec;
    }

    const arrival = Math.max(prevArrival + 0.001, idealTime + jitterSec);
    arrivals.push(arrival);
    prevArrival = arrival;
  }

  return arrivals;
}

function simulateLegacyGaps(arrivals: number[], chunkDurationSec: number): number {
  let nextPlaybackTime = arrivals[0];
  let prevEnd: number | null = null;
  let gaps = 0;

  for (const now of arrivals) {
    const startTime = Math.max(now, nextPlaybackTime);
    if (prevEnd !== null && startTime > prevEnd + 1e-9) {
      gaps += 1;
    }
    prevEnd = startTime + chunkDurationSec;
    nextPlaybackTime = prevEnd;
  }

  return gaps;
}

function simulateSchedulerGaps(arrivals: number[], chunkDurationSec: number): {
  gaps: number;
  underruns: number;
  leadSec: number;
} {
  const state = createScheduler(arrivals[0]);
  let prevEnd: number | null = null;
  let gaps = 0;

  for (const now of arrivals) {
    const { startTime } = scheduleChunk(state, { now, durationSec: chunkDurationSec });
    if (prevEnd !== null && startTime > prevEnd + 1e-9) {
      gaps += 1;
    }
    prevEnd = startTime + chunkDurationSec;
  }

  return { gaps, underruns: state.underruns, leadSec: state.leadSec };
}

test('seeded LCG jitter simulation: 300x 40ms chunks with 0~110ms jitter & bursts reduces silent gaps', () => {
  const chunkDurationSec = 0.04;
  const arrivalsWithinLead = generateJitteredArrivals(300, chunkDurationSec, 0.11, 112201);
  const oldGapsWithin = simulateLegacyGaps(arrivalsWithinLead, chunkDurationSec);
  const newWithin = simulateSchedulerGaps(arrivalsWithinLead, chunkDurationSec);

  assert.ok(oldGapsWithin > 0, `expected legacy scheduler to suffer gaps, got ${oldGapsWithin}`);
  assert.ok(
    newWithin.gaps < oldGapsWithin,
    `expected fewer gaps (${newWithin.gaps}) than legacy (${oldGapsWithin})`
  );
  assert.equal(newWithin.gaps, 0, 'jitter <= 110ms should be absorbed cleanly by 120ms base lead');

  // Heavy jitter (up to 220ms) exceeds base lead: adaptive scheduler still beats legacy strictly.
  const arrivalsHeavy = generateJitteredArrivals(300, chunkDurationSec, 0.22, 112202);
  const oldGapsHeavy = simulateLegacyGaps(arrivalsHeavy, chunkDurationSec);
  const newHeavy = simulateSchedulerGaps(arrivalsHeavy, chunkDurationSec);

  assert.ok(oldGapsHeavy > 0);
  assert.ok(
    newHeavy.gaps < oldGapsHeavy,
    `expected adaptive scheduler gaps (${newHeavy.gaps}) < legacy gaps (${oldGapsHeavy})`
  );
  assert.ok(newHeavy.underruns > 0, 'heavy jitter should trigger adaptive underrun recovery');
});

test('first chunk and >= NEW_UTTERANCE_GAP_SEC silence are treated as newUtterance without counting underrun', () => {
  const state = createScheduler();

  const first = scheduleChunk(state, { now: 0.05, durationSec: 0.04 });
  assert.equal(first.newUtterance, true);
  assert.equal(first.underrun, false);
  assert.ok(Math.abs(first.startTime - (0.05 + BASE_LEAD_SEC)) < 1e-12);
  assert.equal(state.underruns, 0);

  // Trigger one underrun so leadSec increases above BASE_LEAD_SEC.
  const lateNow = state.nextPlaybackTime + 0.05;
  const midTurnUnderrun = scheduleChunk(state, { now: lateNow, durationSec: 0.04 });
  assert.equal(midTurnUnderrun.newUtterance, false);
  assert.equal(midTurnUnderrun.underrun, true);
  assert.equal(state.underruns, 1);
  const elevatedLead = state.leadSec;
  assert.ok(elevatedLead > BASE_LEAD_SEC);

  // After >= 1.0s silence, next chunk is a new utterance: not an underrun, and keeps learned leadSec.
  const afterSilenceNow = state.nextPlaybackTime + NEW_UTTERANCE_GAP_SEC;
  const secondUtterance = scheduleChunk(state, { now: afterSilenceNow, durationSec: 0.04 });
  assert.equal(secondUtterance.newUtterance, true);
  assert.equal(secondUtterance.underrun, false);
  assert.equal(state.underruns, 1);
  assert.equal(state.leadSec, elevatedLead);
  assert.ok(Math.abs(secondUtterance.startTime - (afterSilenceNow + elevatedLead)) < 1e-12);
});

test('queued chunks append seamlessly at previous nextPlaybackTime', () => {
  const state = createScheduler(10);
  const first = scheduleChunk(state, { now: 10, durationSec: 0.04 });
  const prevEnd = state.nextPlaybackTime;
  assert.ok(Math.abs(prevEnd - (first.startTime + 0.04)) < 1e-12);

  const second = scheduleChunk(state, { now: 10.03, durationSec: 0.05 });
  assert.equal(second.newUtterance, false);
  assert.equal(second.underrun, false);
  assert.equal(second.startTime, prevEnd);
  assert.ok(Math.abs(state.nextPlaybackTime - (prevEnd + 0.05)) < 1e-12);
});

test('repeated underruns cap leadSec at MAX_LEAD_SEC', () => {
  const state = createScheduler();
  let t = 1.0;
  scheduleChunk(state, { now: t, durationSec: 0.04 });

  for (let i = 0; i < 20; i++) {
    t = state.nextPlaybackTime + 0.05;
    const res = scheduleChunk(state, { now: t, durationSec: 0.04 });
    assert.equal(res.underrun, true);
    assert.ok(state.leadSec <= MAX_LEAD_SEC);
  }

  assert.equal(state.leadSec, MAX_LEAD_SEC);
  assert.equal(state.underruns, 20);
});

test('50 clean queued chunks reduce leadSec by LEAD_STEP_SEC/2 without dropping below BASE_LEAD_SEC', () => {
  const state = createScheduler();
  scheduleChunk(state, { now: 0.1, durationSec: 0.04 });

  // Raise leadSec by 1 step: 0.12 -> 0.18
  const late = state.nextPlaybackTime + 0.05;
  scheduleChunk(state, { now: late, durationSec: 0.04 });
  assert.ok(Math.abs(state.leadSec - (BASE_LEAD_SEC + LEAD_STEP_SEC)) < 1e-12);

  // 49 clean queued chunks: leadSec must not decay yet
  for (let i = 0; i < 49; i++) {
    const now = state.nextPlaybackTime - 0.02;
    const res = scheduleChunk(state, { now, durationSec: 0.04 });
    assert.equal(res.underrun, false);
    assert.equal(res.newUtterance, false);
  }
  assert.ok(Math.abs(state.leadSec - (BASE_LEAD_SEC + LEAD_STEP_SEC)) < 1e-12);

  // 50th clean chunk decays by LEAD_STEP_SEC / 2 (0.18 -> 0.15)
  scheduleChunk(state, { now: state.nextPlaybackTime - 0.02, durationSec: 0.04 });
  assert.ok(Math.abs(state.leadSec - (BASE_LEAD_SEC + LEAD_STEP_SEC / 2)) < 1e-12);

  // Another 50 clean chunks -> 0.12 (BASE_LEAD_SEC)
  for (let i = 0; i < 50; i++) {
    scheduleChunk(state, { now: state.nextPlaybackTime - 0.02, durationSec: 0.04 });
  }
  assert.ok(Math.abs(state.leadSec - BASE_LEAD_SEC) < 1e-12);

  // Another 100 clean chunks -> never drops below BASE_LEAD_SEC
  for (let i = 0; i < 100; i++) {
    scheduleChunk(state, { now: state.nextPlaybackTime - 0.02, durationSec: 0.04 });
  }
  assert.equal(state.leadSec, BASE_LEAD_SEC);
});

test('resetScheduler resets nextPlaybackTime=now while preserving leadSec and underruns', () => {
  const state = createScheduler();
  scheduleChunk(state, { now: 1.0, durationSec: 0.04 });
  scheduleChunk(state, { now: state.nextPlaybackTime + 0.05, durationSec: 0.04 });
  const learnedLead = state.leadSec;
  const recordedUnderruns = state.underruns;
  assert.equal(recordedUnderruns, 1);
  assert.ok(learnedLead > BASE_LEAD_SEC);

  resetScheduler(state, 25.5);
  assert.equal(state.nextPlaybackTime, 25.5);
  assert.equal(state.leadSec, learnedLead);
  assert.equal(state.underruns, recordedUnderruns);
  assert.equal(describeScheduler(state), `underruns=1 leadMs=${Math.round(learnedLead * 1000)}`);

  // Next chunk right after reset starts as a new utterance with the preserved leadSec.
  const next = scheduleChunk(state, { now: 25.6, durationSec: 0.04 });
  assert.equal(next.newUtterance, true);
  assert.equal(next.underrun, false);
  assert.ok(Math.abs(next.startTime - (25.6 + learnedLead)) < 1e-12);
});

test('GeminiLiveProvider playAudioChunk handles odd byteLength, schedules with lead, and logs playback_stats with interrupts', async () => {
  const g = globalThis as any;
  const origWindow = g.window;
  const origConsoleLog = console.log;
  const origConsoleWarn = console.warn;

  const startedAt: number[] = [];
  const createdBufferLengths: number[] = [];
  const logs: string[] = [];

  class FakeAudioContext {
    public currentTime = 5.0;
    public state = 'running';
    public destination = {};
    createBuffer(_channels: number, length: number, _sampleRate: number) {
      createdBufferLengths.push(length);
      const data = new Float32Array(length);
      return {
        duration: length / 24000,
        getChannelData: () => data,
      };
    }
    createBufferSource() {
      return {
        buffer: null as any,
        onended: null as (() => void) | null,
        connect() {},
        start(when: number) {
          startedAt.push(when);
        },
        stop() {},
      };
    }
    async resume() {}
    async close() {}
  }

  g.window = { AudioContext: FakeAudioContext };
  console.log = (...args: any[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.warn = () => {};

  try {
    const provider = new GeminiLiveProvider() as any;
    await provider.initAudioPlayback();

    // Odd byteLength (5 bytes -> truncated to 4 bytes = 2 samples, no RangeError)
    provider.playAudioChunk(new Uint8Array([1, 2, 3, 4, 5]).buffer);
    assert.deepEqual(createdBufferLengths, [2]);
    assert.ok(Math.abs(startedAt[0] - (5.0 + BASE_LEAD_SEC)) < 1e-12);

    // 1-byte chunk is safely ignored without throwing
    provider.playAudioChunk(new Uint8Array([99]).buffer);
    assert.deepEqual(createdBufferLengths, [2]);

    // Simulated direct & proxy interrupted + turnComplete handling
    provider.handleIncomingMessage({ serverContent: { interrupted: true } }, 'direct');
    provider.handleIncomingMessage({ serverContent: { turnComplete: true } }, 'direct');
    provider.handleIncomingMessage({ type: 'interrupted' }, 'proxy');
    provider.handleIncomingMessage({ type: 'turnComplete' }, 'proxy');

    const statsLogs = logs.filter((l) => l.includes('[Live] stage=playback_stats'));
    assert.equal(statsLogs.length, 2);
    assert.equal(statsLogs[0], '[Live] stage=playback_stats underruns=0 leadMs=120 interrupts=1');
    assert.equal(statsLogs[1], '[Live] stage=playback_stats underruns=0 leadMs=120 interrupts=2');
  } finally {
    console.log = origConsoleLog;
    console.warn = origConsoleWarn;
    g.window = origWindow;
  }
});
