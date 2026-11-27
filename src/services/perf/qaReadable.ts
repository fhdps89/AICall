import { parseQaParam } from "../../data/qaMode";

declare global {
  interface Window {
    /** Flushed `[boot] ...` line. QA automation reads this when console.info is dropped. */
    __AICALL_BOOT__?: string;
    /** Latest `[poc-summary]` line under `?qa=1`. */
    __AICALL_POC_SUMMARY__?: string;
    /** Latest `[poc-usage]` line under `?qa=1`. */
    __AICALL_POC_USAGE__?: string;
    /** Latest `[live-usage]` line (normal Live engine) under `?qa=1`. */
    __AICALL_LIVE_USAGE__?: string;
  }
}

export type QaReadableDest = {
  /** camelCase dataset key, e.g. `"bootTiming"` → `data-boot-timing`. */
  datasetKey?: string;
  /** `window` field, e.g. `"__AICALL_BOOT__"`. */
  windowKey?: string;
  /**
   * If true, write the attribute and window field only when the URL has `?qa=1`
   * (PoC lines). If omitted or false, those writes always happen and only
   * `console.warn` is gated on `?qa=1` (the `[boot]` summary).
   */
  attributesOnlyInQa?: boolean;
};

/** True only for the page URL `?qa=1` (not the persisted `oc_qa_mode` flag). */
export function urlHasQaOn(search: unknown): boolean {
  return typeof search === "string" && parseQaParam(search) === "on";
}

/**
 * Put a line where QA automation can read it without console.info/log.
 * `document` and `window` are guarded separately so Node tests can publish.
 * `console.warn` fires only when the page URL has `?qa=1` (not the persisted QA flag).
 */
export function publishQaReadableLine(line: string, dest: QaReadableDest = {}): void {
  const qaOn =
    typeof window !== "undefined" && urlHasQaOn(window.location?.search);
  const writeAttrs = dest.attributesOnlyInQa ? qaOn : true;

  if (writeAttrs && dest.datasetKey && typeof document !== "undefined" && document.documentElement) {
    document.documentElement.dataset[dest.datasetKey] = line;
  }
  if (writeAttrs && dest.windowKey && typeof window !== "undefined") {
    (window as unknown as Record<string, string>)[dest.windowKey] = line;
  }
  if (qaOn) {
    console.warn(line);
  }
}
