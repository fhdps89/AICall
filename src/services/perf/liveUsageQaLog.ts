import { publishQaReadableLine } from "./qaReadable";

/**
 * Normal Live engine `[live-usage]` line: console.info always; under `?qa=1` also
 * `<html data-live-usage>` / `window.__AICALL_LIVE_USAGE__` (and console.warn) so QA can read it.
 */
export function infoLiveUsage(line: string): void {
  console.info(line);
  publishQaReadableLine(line, {
    datasetKey: "liveUsage",
    windowKey: "__AICALL_LIVE_USAGE__",
    attributesOnlyInQa: true,
  });
}
