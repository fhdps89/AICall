export type BootPhase =
  | "auth"
  | "data"
  | "home"
  | "mistakes"
  | "lectureLocal"
  | "lectureServer";

const BOOT_PHASES: readonly BootPhase[] = [
  "auth",
  "data",
  "home",
  "mistakes",
  "lectureLocal",
  "lectureServer",
];

const BOOT_LOG_TIMEOUT_MS = 60_000;

export type BootTimerFn = (cb: () => void, ms: number) => unknown;

/**
 * Create a per-page boot timing recorder that logs once when both `mistakes` and
 * `lectureServer` have settled, or after 60s if any phase lags.
 */
export function createBootTimer(
  now: () => number,
  log: (msg: string) => void,
  setTimer: BootTimerFn,
  clearTimer?: (handle: unknown) => void
): (phase: BootPhase) => void {
  const marks: Partial<Record<BootPhase, number>> = {};
  let logged = false;
  let timerScheduled = false;
  let timeoutHandle: unknown = undefined;

  const flush = () => {
    if (logged) return;
    logged = true;
    if (timeoutHandle !== undefined && clearTimer) {
      clearTimer(timeoutHandle);
      timeoutHandle = undefined;
    }
    const summary = BOOT_PHASES.map((phase) => {
      const value = marks[phase];
      return `${phase}=${value !== undefined ? `${Math.round(value)}ms` : "-"}`;
    }).join(" ");
    log(`[boot] ${summary}`);
  };

  return (phase: BootPhase) => {
    if (marks[phase] === undefined) {
      marks[phase] = now();
    }
    if (logged) return;

    if (!timerScheduled) {
      timerScheduled = true;
      timeoutHandle = setTimer(flush, BOOT_LOG_TIMEOUT_MS);
    }

    if (marks.mistakes !== undefined && marks.lectureServer !== undefined) {
      flush();
    }
  };
}

export interface BootTimerRuntime {
  /** True in a browser page. `unref` there can drop the 60s fallback. */
  window: boolean;
  node: boolean;
}

function defaultBootTimerRuntime(): BootTimerRuntime {
  return {
    window: typeof window !== "undefined",
    node: typeof process !== "undefined" && typeof process.versions?.node === "string",
  };
}

/** Node tests may unref so the process can exit. A page timer must stay armed. */
export function shouldUnrefBootTimer(
  handle: unknown,
  runtime: BootTimerRuntime = defaultBootTimerRuntime()
): boolean {
  if (runtime.window || !runtime.node) return false;
  return (
    typeof handle === "object" &&
    handle !== null &&
    "unref" in handle &&
    typeof (handle as { unref?: unknown }).unref === "function"
  );
}

const defaultMarkBoot = createBootTimer(
  () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  (msg) => console.info(msg),
  (cb, ms) => {
    const id = setTimeout(cb, ms);
    if (shouldUnrefBootTimer(id)) {
      (id as { unref: () => void }).unref();
    }
    return id;
  },
  (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
);

export function markBoot(phase: BootPhase): void {
  defaultMarkBoot(phase);
}

/**
 * Mark `phase` when `run` settles, whether it succeeds or throws, and before the
 * caller decides the result is stale. Used for the home mistakes read.
 */
export async function settleBootPhase<T>(phase: BootPhase, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    markBoot(phase);
  }
}
