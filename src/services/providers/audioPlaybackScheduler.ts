export const BASE_LEAD_SEC = 0.12;
export const MAX_LEAD_SEC = 0.4;
export const LEAD_STEP_SEC = 0.06;
export const NEW_UTTERANCE_GAP_SEC = 1.0;

const CLEAN_CHUNKS_FOR_DECAY = 50;

export interface PlaybackSchedulerState {
  nextPlaybackTime: number;
  leadSec: number;
  underruns: number;
  cleanChunks: number;
  hasScheduled: boolean;
}

export interface ScheduleChunkInput {
  now: number;
  durationSec: number;
}

export interface ScheduleChunkResult {
  startTime: number;
  underrun: boolean;
  newUtterance: boolean;
}

/**
 * Create a fresh jitter-buffer playback scheduler state for a new call or AudioContext.
 */
export function createScheduler(initialNow: number = 0): PlaybackSchedulerState {
  return {
    nextPlaybackTime: initialNow,
    leadSec: BASE_LEAD_SEC,
    underruns: 0,
    cleanChunks: 0,
    hasScheduled: false,
  };
}

/**
 * Schedule an incoming PCM audio chunk with an adaptive lead buffer to avoid underrun gaps.
 */
export function scheduleChunk(
  state: PlaybackSchedulerState,
  input: ScheduleChunkInput
): ScheduleChunkResult {
  const { now, durationSec } = input;
  let startTime: number;
  let underrun = false;
  let newUtterance = false;

  if (!state.hasScheduled || now - state.nextPlaybackTime >= NEW_UTTERANCE_GAP_SEC) {
    newUtterance = true;
    startTime = now + state.leadSec;
    state.hasScheduled = true;
  } else if (state.nextPlaybackTime >= now) {
    startTime = state.nextPlaybackTime;
    state.cleanChunks += 1;
    if (state.cleanChunks >= CLEAN_CHUNKS_FOR_DECAY) {
      state.cleanChunks = 0;
      state.leadSec = Math.max(BASE_LEAD_SEC, state.leadSec - LEAD_STEP_SEC / 2);
    }
  } else {
    underrun = true;
    state.underruns += 1;
    state.cleanChunks = 0;
    state.leadSec = Math.min(MAX_LEAD_SEC, state.leadSec + LEAD_STEP_SEC);
    startTime = now + state.leadSec;
  }

  state.nextPlaybackTime = startTime + durationSec;
  return { startTime, underrun, newUtterance };
}

/**
 * Reset the playback cursor on interruption while preserving learned leadSec and underruns.
 */
export function resetScheduler(state: PlaybackSchedulerState, now: number): void {
  state.nextPlaybackTime = now;
  state.hasScheduled = false;
  state.cleanChunks = 0;
}

/**
 * Format scheduler telemetry for turnComplete diagnostic logs.
 */
export function describeScheduler(state: PlaybackSchedulerState): string {
  return `underruns=${state.underruns} leadMs=${Math.round(state.leadSec * 1000)}`;
}
