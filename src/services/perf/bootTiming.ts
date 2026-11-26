import { parseQaParam } from "../../data/qaMode";

export type BootPhase =
  | "auth"
  | "data"
  | "home"
  | "mistakes"
  | "lectureLocal"
  | "lectureServer";

declare global {
  interface Window {
    /** Flushed `[boot] ...` line. QA automation reads this when console.info is dropped. */
    __AICALL_BOOT__?: string;
  }
}

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
 * Put the flushed line where automation can read it without a console.
 * `document` and `window` are guarded separately so Node tests can flush.
 * `console.warn` fires only when the page URL has `?qa=1` (not the persisted QA flag).
 */
function publishBootSummary(summary: string): void {
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.dataset.bootTiming = summary;
  }
  if (typeof window !== "undefined") {
    window.__AICALL_BOOT__ = summary;
    const search = window.location?.search;
    if (typeof search === "string" && parseQaParam(search) === "on") {
      console.warn(summary);
    }
  }
}

/**
 * Create a per-page boot timing recorder that logs once when both `mistakes` and
 * `lectureServer` have settled, or after 60s if any phase lags.
 * The same line is copied to `<html data-boot-timing>` and `window.__AICALL_BOOT__`.
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
    const summary = `[boot] ${BOOT_PHASES.map((phase) => {
      const value = marks[phase];
      return `${phase}=${value !== undefined ? `${Math.round(value)}ms` : "-"}`;
    }).join(" ")}`;
    log(summary);
    publishBootSummary(summary);
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
