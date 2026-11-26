import { publishQaReadableLine } from "./qaReadable";

/**
 * Browser `[poc…]` lines that QA automation cannot read from console.info/log.
 * Server-only lines (notably `[poc-tts]`) are included so the same helper
 * mirrors them if they are ever printed in the page.
 */
export type PocQaKind = "summary" | "usage" | "other";

export function pocQaKind(line: string): PocQaKind | null {
  if (line.startsWith("[poc-summary]")) return "summary";
  if (line.startsWith("[poc-usage]")) return "usage";
  if (
    line.startsWith("[poc-turn]") ||
    line.startsWith("[poc-play]") ||
    line.startsWith("[poc-tts]") ||
    line.startsWith("[poc]")
  ) {
    return "other";
  }
  return null;
}

/**
 * Under `?qa=1` only: `console.warn` the same text, and for the latest
 * `[poc-summary]` / `[poc-usage]` also write `<html data-poc-summary>` /
 * `data-poc-usage` (and the matching `window` fields). No-op when the URL is
 * not `?qa=1`. The persisted QA flag is ignored, same as `[boot]`.
 */
export function mirrorPocQaLine(line: string): void {
  const kind = pocQaKind(line);
  if (!kind) return;
  if (kind === "summary") {
    publishQaReadableLine(line, {
      datasetKey: "pocSummary",
      windowKey: "__AICALL_POC_SUMMARY__",
      attributesOnlyInQa: true,
    });
    return;
  }
  if (kind === "usage") {
    publishQaReadableLine(line, {
      datasetKey: "pocUsage",
      windowKey: "__AICALL_POC_USAGE__",
      attributesOnlyInQa: true,
    });
    return;
  }
  publishQaReadableLine(line, { attributesOnlyInQa: true });
}

export function logPoc(line: string): void {
  console.log(line);
  mirrorPocQaLine(line);
}

export function infoPoc(line: string): void {
  console.info(line);
  mirrorPocQaLine(line);
}
