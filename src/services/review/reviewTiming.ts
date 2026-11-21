import type { SttFinalData } from "../firebase/db";

export type ReviewStep = "collectChunks" | "transcribe" | "fallback" | "review" | "save";

export interface ReviewTiming {
  startedAt: string;
  totalMs: number;
  steps: Partial<Record<ReviewStep, number>>;
  minutes: number;            // number of 1-minute groups
  transcribeRequests: number; // includes retries
  outcome: "ok" | "empty" | "failed";
  sourceStt?: SttFinalData["sourceStt"];
}

export function createStepTimer(now: () => number = () => Date.now()): {
  start(step: ReviewStep): void;
  end(step: ReviewStep): void;
  snapshot(): Pick<ReviewTiming, "steps" | "totalMs">;
} {
  const starts = new Map<ReviewStep, number>();
  const steps: Partial<Record<ReviewStep, number>> = {};

  return {
    start(step: ReviewStep): void {
      starts.set(step, now());
    },
    end(step: ReviewStep): void {
      const t0 = starts.get(step);
      if (t0 === undefined) return;
      starts.delete(step);
      const elapsed = Math.max(0, now() - t0);
      steps[step] = (steps[step] ?? 0) + elapsed;
    },
    snapshot(): Pick<ReviewTiming, "steps" | "totalMs"> {
      const copy: Partial<Record<ReviewStep, number>> = { ...steps };
      let totalMs = 0;
      for (const ms of Object.values(copy)) {
        if (typeof ms === "number") totalMs += ms;
      }
      return { steps: copy, totalMs };
    },
  };
}
