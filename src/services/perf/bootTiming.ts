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

const defaultMarkBoot = createBootTimer(
  () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  (msg) => console.info(msg),
  (cb, ms) => {
    const id = setTimeout(cb, ms);
    if (
      typeof id === "object" &&
      id !== null &&
      "unref" in id &&
      typeof (id as { unref?: () => void }).unref === "function"
    ) {
      (id as { unref: () => void }).unref();
    }
    return id;
  },
  (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
);

export function markBoot(phase: BootPhase): void {
  defaultMarkBoot(phase);
}
