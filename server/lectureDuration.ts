/**
 * Pure sample-accurate timeline fitter for the 6:00–6:10 (360–370 s) morning lecture window.
 * No Gemini or filesystem imports; operates strictly on 24 kHz PCM sample counts.
 */

export const RATE = 24000;
export const LECTURE_MIN_SEC = 360;
export const LECTURE_MAX_SEC_HARD = 370;
export const LECTURE_MAX_SEC_GUARD = 369.8;
export const LECTURE_TARGET_SEC = 365;
export const LECTURE_EST_MAX_SEC = 420;

export const SLOT = {
  open: { base: 0.6, min: 0.3, max: 1.5 },
  answer: { base: 3.0, min: 2.0, max: 5.0 },
  itemGap: { base: 0.8, min: 0.4, max: 3.0 },
  end: { base: 0, min: 0, max: 4.0 },
} as const;

export const DRILL_GAP_SEC = 4.0;
export const DRILL_TAIL_SEC = 1.0;
export const MAX_DRILL_UNITS = 12;
export const REPLAY_MIN_GAP_SEC = 45;
export const RECAP_MIN_GAP_SEC = 20;
export const RECAP_MAX_ITEMS = 8;
export const MAX_EXTRA_TTS_CALLS = 1;

export const DRILL_INTRO_TEXT =
  'Coach: 이제 오늘 표현을 한 번 더 들어 볼게요. 영어 문장이 나오면 따라 말해 보세요.';

export function buildRecapText(items: ReadonlyArray<{ meaningKo?: string; naturalPhrase: string }>): string {
  const body = items
    .slice(0, RECAP_MAX_ITEMS)
    .map((it, i) => {
      const meaning = (it.meaningKo || '').trim() || '이 표현';
      return `Coach: ${i + 1}번, ${meaning}. 영어로는 "${it.naturalPhrase}".`;
    })
    .join('\n');
  return (
    'Coach: 오늘 표현을 다시 정리해 볼게요.\n' +
    body +
    '\nCoach: 이제 영어 문장만 들려 드릴게요. 따라 말해 보세요.'
  );
}

export interface MeasuredLectureItem {
  index: number;
  kind: 'new' | 'review';
  bodySamples: number;
  answerSamples: number;
  bodyChars: number;
  answerChars: number;
}

export interface MeasuredLecture {
  openingSamples: number;
  closingSamples: number;
  items: MeasuredLectureItem[];
  speechChars: number;
  speechSamples: number;
  recapChars?: number;
}

export type Extras = {
  recap?: number | 'failed';
  drillIntro?: number | 'failed';
};

export type TimelineEntry =
  | { seg: 'opening' | 'closing' | 'recap' | 'drillIntro' }
  | { seg: 'body' | 'answer'; item: number }
  | { silence: number };

export interface LectureDurationFit {
  baseSec: number;
  droppedCount: number;
  replayCount: number;
  recap: boolean;
  drillUnits: number;
  padSec: number;
  guardPadSec: number;
  truncatedSec: number;
  extraTtsCalls: number;
}

export interface FitResult {
  want: 'recap' | 'drillIntro' | null;
  timeline: TimelineEntry[];
  keptItems: number[];
  totalSamples: number;
  fit: LectureDurationFit;
}

const s = (sec: number): number => Math.round(sec * RATE);

function baseSamples(m: MeasuredLecture, kept: MeasuredLectureItem[]): number {
  let sum = m.openingSamples + s(SLOT.open.base) + m.closingSamples;
  for (const it of kept) {
    sum += it.bodySamples + s(SLOT.answer.base) + it.answerSamples + s(SLOT.itemGap.base);
  }
  return sum;
}

function padUpSamples(itemCount: number): number {
  return (
    s(SLOT.open.max - SLOT.open.base) +
    itemCount * (s(SLOT.answer.max - SLOT.answer.base) + s(SLOT.itemGap.max - SLOT.itemGap.base)) +
    s(SLOT.end.max)
  );
}

function shrinkSamples(itemCount: number): number {
  return (
    s(SLOT.open.base - SLOT.open.min) +
    itemCount * (s(SLOT.answer.base - SLOT.answer.min) + s(SLOT.itemGap.base - SLOT.itemGap.min))
  );
}

/** Drop order: review items (last index first), then new items (last index first). */
function dropOrderIndices(kept: MeasuredLectureItem[]): number[] {
  const reviews: number[] = [];
  const news: number[] = [];
  for (let i = kept.length - 1; i >= 0; i--) {
    if (kept[i].kind === 'review') reviews.push(i);
    else news.push(i);
  }
  return [...reviews, ...news];
}

function replayPriorityOrder(kept: MeasuredLectureItem[]): MeasuredLectureItem[] {
  const news: MeasuredLectureItem[] = [];
  const reviews: MeasuredLectureItem[] = [];
  for (const it of kept) {
    if (it.kind === 'new') news.push(it);
    else reviews.push(it);
  }
  return [...news, ...reviews];
}

interface MutableSlot {
  samples: number;
  min: number;
  max: number;
}

function emptyResult(m: MeasuredLecture, kept: MeasuredLectureItem[], want: 'recap' | 'drillIntro'): FitResult {
  return {
    want,
    timeline: [],
    keptItems: kept.map((it) => it.index),
    totalSamples: 0,
    fit: {
      baseSec: Math.round((baseSamples(m, kept) / RATE) * 10) / 10,
      droppedCount: m.items.length - kept.length,
      replayCount: 0,
      recap: false,
      drillUnits: 0,
      padSec: 0,
      guardPadSec: 0,
      truncatedSec: 0,
      extraTtsCalls: 0,
    },
  };
}

export function fitLectureTimeline(m: MeasuredLecture, extras: Extras = {}): FitResult {
  const kept = m.items.slice();
  const minSamples = s(LECTURE_MIN_SEC);
  const maxSamples = s(LECTURE_MAX_SEC_HARD);
  const guardMaxSamples = s(LECTURE_MAX_SEC_GUARD);
  const targetSamples = s(LECTURE_TARGET_SEC);

  // 1. Overfill: drop lowest-priority items until within [MIN - padUp, MAX + shrink] or down to 1 item
  while (baseSamples(m, kept) - shrinkSamples(kept.length) > maxSamples && kept.length > 1) {
    const order = dropOrderIndices(kept);
    let dropAt = order.find((idx) => {
      const next = kept.filter((_, j) => j !== idx);
      const b = baseSamples(m, next);
      return b >= minSamples - padUpSamples(next.length) && b <= maxSamples + shrinkSamples(next.length);
    });
    if (dropAt === undefined) dropAt = order[0];
    kept.splice(dropAt, 1);
  }

  const baseSum = baseSamples(m, kept);
  const padUp = padUpSamples(kept.length);
  const shrinkMax = shrinkSamples(kept.length);
  let G = targetSamples - baseSum;

  // 2. Underfill layers (only while G > padUp)
  const replays: MeasuredLectureItem[] = [];
  let useRecap = false;
  let recapSamples = 0;
  let needDrill = false;
  let drillIntroSamples = 0;
  let useDrillIntro = false;
  const drillItems: MeasuredLectureItem[] = [];

  if (G > padUp && kept.length > 0) {
    for (const it of replayPriorityOrder(kept)) {
      const L = it.bodySamples + s(SLOT.answer.base) + it.answerSamples + s(SLOT.itemGap.base);
      if (G - padUp >= s(REPLAY_MIN_GAP_SEC) && L <= G - padUp + s(5)) {
        replays.push(it);
        G -= L;
      }
    }

    useRecap = G - padUp >= s(RECAP_MIN_GAP_SEC);
    if (useRecap) {
      if (extras.recap === undefined) {
        if (extras.drillIntro === undefined) {
          const recapCharsEst =
            m.recapChars ??
            55 + kept.slice(0, RECAP_MAX_ITEMS).reduce((acc, it) => acc + 30 + it.answerChars, 0);
          const ratePerChar = m.speechChars > 0 ? m.speechSamples / m.speechChars : RATE / 10;
          const estimate = recapCharsEst * ratePerChar * 1.2;
          if (estimate > G - padUp + s(5)) {
            useRecap = false;
          } else {
            return emptyResult(m, kept, 'recap');
          }
        } else {
          useRecap = false;
        }
      } else if (extras.recap === 'failed') {
        useRecap = false;
      } else {
        recapSamples = extras.recap;
        G -= recapSamples + s(SLOT.itemGap.base);
      }
    }

    needDrill = G > padUp && extras.recap !== 'failed';
    if (needDrill && !useRecap) {
      if (extras.drillIntro === undefined) {
        return emptyResult(m, kept, 'drillIntro');
      }
      if (extras.drillIntro === 'failed') {
        needDrill = false;
      } else {
        useDrillIntro = true;
        drillIntroSamples = extras.drillIntro;
        G -= drillIntroSamples + s(SLOT.itemGap.base);
      }
    }

    let u = 0;
    const maxOvershoot = s(LECTURE_MAX_SEC_HARD - LECTURE_TARGET_SEC) + shrinkMax;
    while (needDrill && G > padUp && u < MAX_DRILL_UNITS) {
      const it = kept[u % kept.length];
      const unitCost = 2 * it.answerSamples + s(DRILL_GAP_SEC + DRILL_TAIL_SEC);
      if (G - unitCost < -maxOvershoot) break;
      drillItems.push(it);
      G -= unitCost;
      u += 1;
    }
  }

  // 3. Distribute remaining G across adjustable slots (open, per-kept answer/itemGap, end)
  const openSlot: MutableSlot = { samples: s(SLOT.open.base), min: s(SLOT.open.min), max: s(SLOT.open.max) };
  const answerSlots: MutableSlot[] = kept.map(() => ({
    samples: s(SLOT.answer.base),
    min: s(SLOT.answer.min),
    max: s(SLOT.answer.max),
  }));
  const itemGapSlots: MutableSlot[] = kept.map(() => ({
    samples: s(SLOT.itemGap.base),
    min: s(SLOT.itemGap.min),
    max: s(SLOT.itemGap.max),
  }));
  const endSlot: MutableSlot = { samples: s(SLOT.end.base), min: s(SLOT.end.min), max: s(SLOT.end.max) };
  const slots: MutableSlot[] = [openSlot, ...answerSlots, ...itemGapSlots, endSlot];

  let step3PadSamples = 0;
  if (G >= 0) {
    const totalHeadUp = slots.reduce((sum, sl) => sum + (sl.max - sl.samples), 0);
    let distributed = 0;
    const headUps = slots.map((sl) => sl.max - sl.samples);
    for (let j = 0; j < slots.length; j++) {
      const hu = headUps[j];
      const delta = totalHeadUp > 0 ? Math.min(hu, Math.floor((G * hu) / totalHeadUp)) : 0;
      slots[j].samples += delta;
      distributed += delta;
    }
    const rem = G - distributed;
    if (rem > 0) {
      const endAdd = Math.min(endSlot.max - endSlot.samples, rem);
      endSlot.samples += endAdd;
      distributed += endAdd;
    }
    step3PadSamples = distributed;
  } else {
    let need = -G;
    const totalHeadDown = slots.reduce((sum, sl) => sum + (sl.samples - sl.min), 0);
    const headDowns = slots.map((sl) => sl.samples - sl.min);
    let shrunk = 0;
    for (let j = 0; j < slots.length; j++) {
      const hd = headDowns[j];
      const delta = totalHeadDown > 0 ? Math.min(hd, Math.floor((need * hd) / totalHeadDown)) : 0;
      slots[j].samples -= delta;
      shrunk += delta;
    }
    let rem = need - shrunk;
    for (let j = 0; j < slots.length && rem > 0; j++) {
      const avail = slots[j].samples - slots[j].min;
      if (avail > 0) {
        const take = Math.min(avail, rem);
        slots[j].samples -= take;
        rem -= take;
      }
    }
  }

  // Assemble timeline
  const buildTimeline = (endSilenceSamples: number): { timeline: TimelineEntry[]; total: number } => {
    const tl: TimelineEntry[] = [];
    let total = 0;
    const pushSeg = (entry: TimelineEntry, len: number) => {
      tl.push(entry);
      total += len;
    };
    const pushSilence = (len: number) => {
      if (len <= 0) return;
      tl.push({ silence: len });
      total += len;
    };

    pushSeg({ seg: 'opening' }, m.openingSamples);
    pushSilence(openSlot.samples);

    for (let k = 0; k < kept.length; k++) {
      const it = kept[k];
      pushSeg({ seg: 'body', item: it.index }, it.bodySamples);
      pushSilence(answerSlots[k].samples);
      pushSeg({ seg: 'answer', item: it.index }, it.answerSamples);
      pushSilence(itemGapSlots[k].samples);
    }

    for (const it of replays) {
      pushSeg({ seg: 'body', item: it.index }, it.bodySamples);
      pushSilence(s(SLOT.answer.base));
      pushSeg({ seg: 'answer', item: it.index }, it.answerSamples);
      pushSilence(s(SLOT.itemGap.base));
    }

    if (useRecap) {
      pushSeg({ seg: 'recap' }, recapSamples);
      pushSilence(s(SLOT.itemGap.base));
    }

    if (useDrillIntro) {
      pushSeg({ seg: 'drillIntro' }, drillIntroSamples);
      pushSilence(s(SLOT.itemGap.base));
    }

    for (const it of drillItems) {
      pushSeg({ seg: 'answer', item: it.index }, it.answerSamples);
      pushSilence(s(DRILL_GAP_SEC));
      pushSeg({ seg: 'answer', item: it.index }, it.answerSamples);
      pushSilence(s(DRILL_TAIL_SEC));
    }

    pushSeg({ seg: 'closing' }, m.closingSamples);
    pushSilence(endSilenceSamples);
    return { timeline: tl, total };
  };

  let { timeline, total } = buildTimeline(endSlot.samples);
  let guardPadSamples = 0;
  let truncatedSamples = 0;

  // 4. Final guard on exact sum T (leave ~0.2 s headroom for AAC encoder padding)
  if (total < minSamples) {
    guardPadSamples = targetSamples - total;
    ({ timeline, total } = buildTimeline(endSlot.samples + guardPadSamples));
  } else if (total > guardMaxSamples) {
    let over = total - guardMaxSamples;
    for (let j = 0; j < slots.length && over > 0; j++) {
      const avail = slots[j].samples - slots[j].min;
      if (avail > 0) {
        const take = Math.min(avail, over);
        slots[j].samples -= take;
        over -= take;
      }
    }
    ({ timeline, total } = buildTimeline(endSlot.samples));
    if (total > guardMaxSamples) {
      truncatedSamples = total - guardMaxSamples;
      total = guardMaxSamples;
    }
  }

  const extraTtsCalls =
    (extras.recap !== undefined ? 1 : 0) + (extras.drillIntro !== undefined ? 1 : 0);

  return {
    want: null,
    timeline,
    keptItems: kept.map((it) => it.index),
    totalSamples: total,
    fit: {
      baseSec: Math.round((baseSum / RATE) * 10) / 10,
      droppedCount: m.items.length - kept.length,
      replayCount: replays.length,
      recap: useRecap,
      drillUnits: drillItems.length,
      padSec: Math.round((step3PadSamples / RATE) * 10) / 10,
      guardPadSec: Math.round((guardPadSamples / RATE) * 10) / 10,
      truncatedSec: Math.round((truncatedSamples / RATE) * 10) / 10,
      extraTtsCalls: Math.min(MAX_EXTRA_TTS_CALLS, extraTtsCalls),
    },
  };
}

/** Assemble mono 16-bit PCM from timeline segments, applying a 100 ms linear fade-out if truncated. */
export function assembleLecturePcm(
  timeline: TimelineEntry[],
  segments: {
    opening: Buffer;
    closing: Buffer;
    recap?: Buffer;
    drillIntro?: Buffer;
    bodyByItem: Map<number, Buffer>;
    answerByItem: Map<number, Buffer>;
  },
  totalSamples: number,
  rate = RATE
): { pcm: Buffer; bodyStartSecByItem: Map<number, number> } {
  const parts: Buffer[] = [];
  const bodyStartSecByItem = new Map<number, number>();
  let sampleOffset = 0;

  for (const entry of timeline) {
    let buf: Buffer;
    if ('silence' in entry) {
      buf = Buffer.alloc(entry.silence * 2);
    } else if (entry.seg === 'opening') {
      buf = segments.opening;
    } else if (entry.seg === 'closing') {
      buf = segments.closing;
    } else if (entry.seg === 'recap') {
      buf = segments.recap || Buffer.alloc(0);
    } else if (entry.seg === 'drillIntro') {
      buf = segments.drillIntro || Buffer.alloc(0);
    } else if (entry.seg === 'body') {
      if (!bodyStartSecByItem.has(entry.item)) {
        bodyStartSecByItem.set(entry.item, Math.round((sampleOffset / rate) * 10) / 10);
      }
      buf = segments.bodyByItem.get(entry.item) || Buffer.alloc(0);
    } else if (entry.seg === 'answer') {
      buf = segments.answerByItem.get(entry.item) || Buffer.alloc(0);
    } else {
      buf = Buffer.alloc(0);
    }
    parts.push(buf);
    sampleOffset += Math.floor(buf.length / 2);
  }

  let pcm = Buffer.concat(parts);
  const maxBytes = totalSamples * 2;
  if (pcm.length > maxBytes) {
    pcm = Buffer.from(pcm.subarray(0, maxBytes));
    const fadeSamples = Math.min(totalSamples, Math.round(0.1 * rate));
    const fadeStart = totalSamples - fadeSamples;
    for (let i = 0; i < fadeSamples; i++) {
      const idx = (fadeStart + i) * 2;
      const gain = 1 - (i + 1) / fadeSamples;
      const v = Math.round(pcm.readInt16LE(idx) * gain);
      pcm.writeInt16LE(Math.max(-32768, Math.min(32767, v)), idx);
    }
  }
  return { pcm, bodyStartSecByItem };
}
