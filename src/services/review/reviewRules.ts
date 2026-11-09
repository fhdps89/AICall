/**
 * Small rules of the post-call review, kept free of browser / Firebase code so they can be
 * tested with `npm test`.
 */

/** Keep only ids that were really in the list we sent to the model (it can invent or mix up ids). */
export function keepKnownIds(ids: unknown, allowed: Iterable<string | undefined>): string[] {
  const known = new Set<string>();
  for (const id of allowed) if (id) known.add(id);
  if (!Array.isArray(ids)) return [];
  return Array.from(new Set(ids.filter((id): id is string => typeof id === "string" && known.has(id))));
}

export interface MinutePartial {
  minuteIndex: number;
  transcript: string;
}

export interface MergedTranscript {
  text: string;
  /** "sttFinal": every minute came from the final pass. "sttPartial_fallback": some came from the in-call backup. */
  source: "sttFinal" | "sttPartial_fallback";
  /** Minutes that neither pass could transcribe. */
  missingMinutes: number[];
}

/**
 * Join the per-minute final transcripts. A minute whose final pass failed (null) is filled from
 * the in-call 1-minute backup of the same minute, instead of throwing the whole final transcript
 * away because one request failed.
 */
export function mergeMinuteTranscripts(finalByMinute: Array<string | null>, partials: MinutePartial[] = []): MergedTranscript {
  const backup = new Map<number, string>();
  for (const p of partials) if (p && typeof p.transcript === "string") backup.set(p.minuteIndex, p.transcript.trim());
  const texts: string[] = [];
  const missingMinutes: number[] = [];
  let usedBackup = false;
  finalByMinute.forEach((t, i) => {
    if (t !== null) {
      if (t.trim()) texts.push(t.trim());
      return;
    }
    const b = backup.get(i);
    if (b) {
      texts.push(b);
      usedBackup = true;
    } else {
      missingMinutes.push(i);
    }
  });
  return { text: texts.join("\n"), source: usedBackup ? "sttPartial_fallback" : "sttFinal", missingMinutes };
}
