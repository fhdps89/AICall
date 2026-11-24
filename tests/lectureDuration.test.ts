import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import {
  RATE,
  LECTURE_MIN_SEC,
  LECTURE_MAX_SEC_HARD,
  LECTURE_MAX_SEC_GUARD,
  LECTURE_MAX_FALLBACK_PAD_SEC,
  SLOT,
  DRILL_GAP_SEC,
  DRILL_TAIL_SEC,
  fitLectureTimeline,
  assembleLecturePcm,
  type MeasuredLecture,
} from '../server/lectureDuration.ts';
import {
  DATA_DIR,
  lectureAudioPath,
  lectureRebuildInFlight,
  readLectureState,
  startLectureAudioRebuild,
  startLectureJob,
  type LectureMistakeInput,
  type LectureScriptItem,
} from '../server/lecture.ts';
import { wavFromPcm } from '../server/lectureAudioEncode.ts';

function makeMeasured(n: number, bodySec = 28, answerSec = 2, kindAt?: (i: number) => 'new' | 'review'): MeasuredLecture {
  const items = Array.from({ length: n }, (_, i) => ({
    index: i,
    kind: kindAt ? kindAt(i) : ('new' as const),
    bodySamples: Math.round(bodySec * RATE),
    answerSamples: Math.round(answerSec * RATE),
    bodyChars: Math.round(bodySec * 10),
    answerChars: Math.round(answerSec * 10),
  }));
  const speechSamples =
    Math.round(4 * RATE) +
    Math.round(8 * RATE) +
    items.reduce((a, it) => a + it.bodySamples + it.answerSamples, 0);
  const speechChars = Math.round((speechSamples / RATE) * 10);
  return {
    openingSamples: Math.round(4 * RATE),
    closingSamples: Math.round(8 * RATE),
    items,
    speechChars,
    speechSamples,
  };
}

function runTwoPass(m: MeasuredLecture, extraSec = 18) {
  const r1 = fitLectureTimeline(m);
  if (!r1.want) return r1;
  const extras =
    r1.want === 'recap'
      ? { recap: Math.round(extraSec * RATE) }
      : { drillIntro: Math.round(5 * RATE) };
  const r2 = fitLectureTimeline(m, extras);
  assert.equal(r2.want, null, 'second call must never return want');
  return r2;
}

test('1) pure fit lands in [360s, 370s] for N = 1, 2, 3, 5, 8, 15 and extraTtsCalls <= 1', () => {
  for (const n of [1, 2, 3, 5, 8, 15]) {
    const m = makeMeasured(n, n <= 2 ? 75 : 35, 2.5, (i) => (i === n - 1 && n > 2 ? 'review' : 'new'));
    const r = runTwoPass(m);
    assert.ok(
      r.totalSamples >= LECTURE_MIN_SEC * RATE && r.totalSamples <= LECTURE_MAX_SEC_HARD * RATE,
      `N=${n} out of window: ${r.totalSamples / RATE}s`
    );
    assert.ok(r.fit.extraTtsCalls <= 1);
  }
});

test('2) overfill drops reviews first, then new items from end; body startSec increases monotonically', () => {
  const m = makeMeasured(5, 85, 3, (i) => (i === 1 ? 'review' : 'new'));
  const r = runTwoPass(m);
  assert.equal(r.keptItems.includes(1), false, 'review item should drop first');
  assert.deepEqual(r.keptItems, [0, 2, 3]);
  assert.ok(r.totalSamples >= LECTURE_MIN_SEC * RATE && r.totalSamples <= LECTURE_MAX_SEC_HARD * RATE);

  const bodySegs = r.timeline.filter((t): t is { seg: 'body'; item: number } => 'seg' in t && t.seg === 'body');
  let sampleOff = 0;
  const starts: number[] = [];
  for (const t of r.timeline) {
    if ('silence' in t) sampleOff += t.silence;
    else if (t.seg === 'opening') sampleOff += m.openingSamples;
    else if (t.seg === 'closing') sampleOff += m.closingSamples;
    else if (t.seg === 'body') {
      starts.push(sampleOff);
      sampleOff += m.items[t.item].bodySamples;
    } else if (t.seg === 'answer') {
      sampleOff += m.items[t.item].answerSamples;
    }
  }
  assert.equal(starts.length, bodySegs.length);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] > starts[i - 1]);
  }
});

test('3) small overshoot (+3s above target) is resolved by shrinking without dropping', () => {
  // Base for 5 items: 4 + 0.6 + 5*(68 + 3 + 2 + 0.8) + 8 = 381.6s? Wait: aim for ~368s (target+3, below max 370)
  // Or 373s (above 370s hard max, within shrink ~7.3s): 4 + 0.6 + 5*(66.3 + 3 + 2 + 0.8) + 8 = 373.1s
  const m = makeMeasured(5, 66.3, 2);
  const r = fitLectureTimeline(m);
  assert.equal(r.want, null);
  assert.equal(r.fit.droppedCount, 0);
  assert.equal(r.keptItems.length, 5);
  assert.ok(r.totalSamples >= LECTURE_MIN_SEC * RATE && r.totalSamples <= LECTURE_MAX_SEC_HARD * RATE);
});

test('4) recap failed / drillIntro failed caps trailing stretch silence at <= 5s instead of padding to 360s', () => {
  const m = makeMeasured(1, 30, 2);
  const r1 = fitLectureTimeline(m);
  assert.equal(r1.want, 'recap');
  const rFailRecap = fitLectureTimeline(m, { recap: 'failed' });
  assert.equal(rFailRecap.want, null);
  assert.ok(rFailRecap.totalSamples < LECTURE_MIN_SEC * RATE);
  assert.ok(rFailRecap.fit.guardPadSec <= LECTURE_MAX_FALLBACK_PAD_SEC);
  const lastRecap = rFailRecap.timeline[rFailRecap.timeline.length - 1];
  const trailingRecapSec = lastRecap && 'silence' in lastRecap ? lastRecap.silence / RATE : 0;
  assert.ok(trailingRecapSec <= LECTURE_MAX_FALLBACK_PAD_SEC, `trailing=${trailingRecapSec}s`);

  // With N=2, 1 item ~155s -> 322s + replays skipped (<45) -> recap skipped (<20) -> drillIntro wanted!
  const mNeedDrill = makeMeasured(2, 155, 2);
  // base = 4 + 0.6 + 2*(155+3+2+0.8) + 8 = 334.2, padUp = 0.9 + 2*4.2 + 4 = 13.3, G = 30.8
  // G - padUp = 17.5 (<20 recap min, >0) => wants drillIntro!
  const rd1 = fitLectureTimeline(mNeedDrill);
  assert.equal(rd1.want, 'drillIntro');
  const rd2 = fitLectureTimeline(mNeedDrill, { drillIntro: 'failed' });
  assert.equal(rd2.want, null);
  assert.ok(rd2.totalSamples < LECTURE_MIN_SEC * RATE);
  assert.ok(rd2.fit.guardPadSec <= LECTURE_MAX_FALLBACK_PAD_SEC);
  const lastDrill = rd2.timeline[rd2.timeline.length - 1];
  const trailingDrillSec = lastDrill && 'silence' in lastDrill ? lastDrill.silence / RATE : 0;
  assert.ok(trailingDrillSec <= LECTURE_MAX_FALLBACK_PAD_SEC, `trailing=${trailingDrillSec}s`);
});

test('5) pathological 400s single item is truncated to <=369.8s (within 360-370s) with 100ms fade-out', () => {
  const m = makeMeasured(1, 400, 2);
  const r = fitLectureTimeline(m);
  assert.equal(r.want, null);
  assert.equal(r.totalSamples, LECTURE_MAX_SEC_GUARD * RATE);
  assert.ok(r.totalSamples >= LECTURE_MIN_SEC * RATE && r.totalSamples <= LECTURE_MAX_SEC_HARD * RATE);
  assert.ok(r.fit.truncatedSec > 0);

  // Near-370s single item with no shrink headroom also guards down to <= 369.8s
  const mNear = makeMeasured(1, 353.55, 2); // base = 4 + 0.6 + 353.55 + 3 + 2 + 0.8 + 8 = 371.95s, min-shrink 1.7s -> 370.25s > 369.8s
  const rNear = fitLectureTimeline(mNear);
  assert.ok(rNear.totalSamples >= LECTURE_MIN_SEC * RATE && rNear.totalSamples <= LECTURE_MAX_SEC_HARD * RATE);
  assert.ok(rNear.totalSamples <= LECTURE_MAX_SEC_GUARD * RATE);

  const bodyBuf = Buffer.alloc(m.items[0].bodySamples * 2);
  for (let i = 0; i < m.items[0].bodySamples; i++) bodyBuf.writeInt16LE(10000, i * 2);
  const { pcm } = assembleLecturePcm(
    r.timeline,
    {
      opening: Buffer.alloc(m.openingSamples * 2),
      closing: Buffer.alloc(m.closingSamples * 2),
      bodyByItem: new Map([[0, bodyBuf]]),
      answerByItem: new Map([[0, Buffer.alloc(m.items[0].answerSamples * 2)]]),
    },
    r.totalSamples,
    RATE
  );
  assert.equal(pcm.length, LECTURE_MAX_SEC_GUARD * RATE * 2);
  // Last sample faded to 0
  assert.equal(pcm.readInt16LE(pcm.length - 2), 0);
});

test('6) every non-guard slot stays within its min/max bounds', () => {
  const m = makeMeasured(4, 70, 2.5);
  const r = runTwoPass(m);
  const silences = r.timeline.filter((e): e is { silence: number } => 'silence' in e);
  // First silence is open slot
  assert.ok(silences[0].silence >= Math.round(SLOT.open.min * RATE));
  assert.ok(silences[0].silence <= Math.round(SLOT.open.max * RATE));
  // Allowed silence values for answer/itemGap/drill/end
  const minBound = Math.round(Math.min(SLOT.open.min, SLOT.answer.min, SLOT.itemGap.min, DRILL_TAIL_SEC) * RATE);
  const maxBound = Math.round(Math.max(SLOT.answer.max, SLOT.itemGap.max, DRILL_GAP_SEC, SLOT.end.max) * RATE);
  for (let i = 0; i < silences.length - (r.fit.guardPadSec > 0 ? 1 : 0); i++) {
    assert.ok(silences[i].silence >= minBound || silences[i].silence === 0);
    assert.ok(silences[i].silence <= maxBound);
  }
});

test('7) integration via startLectureAudioRebuild writes 360-370s WAV, agrees with durationSec, preserves inputNewIds', async () => {
  const uid = `test_n1_int_${process.pid}`;
  const date = '2026-11-24';
  const script: LectureScriptItem[] = Array.from({ length: 12 }, (_, i) => ({
    mistakeId: `m${i}`,
    kind: i === 11 ? 'review' : 'new',
    myPhrase: `I go ${i}`,
    naturalPhrase: `I went ${i}`,
    explanation: '과거 시제를 사용해야 합니다. '.repeat(20),
    dialogue: [
      { speaker: 'Coach', line: 'How was your trip?' },
      { speaker: 'Partner', line: `I went ${i} yesterday.` },
    ],
    meaningKo: '갔다',
    answerEnglish: `I went ${i}`,
    similarExample: 'She went home early.',
  }));

  let synthCalls = 0;
  try {
    startLectureAudioRebuild(
      {} as GoogleGenAI,
      uid,
      date,
      {
        title: '길이 맞추기 통합',
        coachNote: '첫 문장. 둘째 문장.',
        script,
        inputNewIds: script.filter((s) => s.kind === 'new').map((s) => s.mistakeId),
        inputReviewIds: script.filter((s) => s.kind === 'review').map((s) => s.mistakeId),
      },
      {
        synthesizeFn: async (_ai, _e, text) => {
          synthCalls += 1;
          const samples = Math.round((text.length / 10) * RATE);
          return { data: Buffer.alloc(samples * 2), rate: RATE };
        },
        encodeFn: async (pcm, rate) => ({ ext: 'wav', mime: 'audio/wav', buffer: wavFromPcm(pcm, rate) }),
      }
    );
    await lectureRebuildInFlight(uid, date);

    const wavPath = lectureAudioPath(uid, date)!;
    assert.ok(wavPath);
    const wavBuf = fs.readFileSync(wavPath);
    const dataLen = wavBuf.length - 44;
    const sec = dataLen / (RATE * 2);
    assert.ok(sec >= 360 && sec <= 370, `WAV sec=${sec} out of [360,370]`);

    const st = readLectureState(uid, date)!;
    assert.equal(st.durationSec, Math.round(sec));
    assert.equal(st.itemCount, st.script?.length);
    const keptSet = new Set(st.script?.map((s) => s.mistakeId));
    for (const id of st.newMistakeIds) assert.ok(keptSet.has(id));
    assert.equal(st.inputNewIds?.length, 11);
    assert.equal(st.inputReviewIds?.length, 1);
    // Main plan calls = 2 + 2 * 12 = 26, plus at most 1 extra call
    assert.ok(synthCalls <= 27);
  } finally {
    fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
  }
});

function shortScript(): LectureScriptItem[] {
  return [
    {
      mistakeId: 'm0',
      kind: 'new',
      myPhrase: 'I go yesterday',
      naturalPhrase: 'I went yesterday',
      explanation: '과거 시제를 사용해야 합니다.',
      dialogue: [
        { speaker: 'Coach', line: 'How was your trip?' },
        { speaker: 'Partner', line: 'I went yesterday.' },
      ],
      meaningKo: '어제 갔다',
      answerEnglish: 'I went yesterday',
      similarExample: 'She went home early.',
    },
  ];
}

test('8) recap TTS fails once then succeeds on retry -> lands in [360s, 370s] with 2 recap calls', async () => {
  const uid = `test_n1_recap_retry_${process.pid}`;
  const date = '2026-11-24';
  let recapCalls = 0;
  try {
    startLectureAudioRebuild(
      {} as GoogleGenAI,
      uid,
      date,
      { title: '재시도 통합', coachNote: '첫 문장. 둘째 문장.', script: shortScript() },
      {
        synthesizeFn: async (_ai, _e, text) => {
          if (text.includes('오늘 표현을 다시 정리해 볼게요')) {
            recapCalls += 1;
            if (recapCalls === 1) throw new Error('transient recap TTS error');
          }
          const samples = Math.round((text.length / 10) * RATE);
          return { data: Buffer.alloc(samples * 2), rate: RATE };
        },
        encodeFn: async (pcm, rate) => ({ ext: 'wav', mime: 'audio/wav', buffer: wavFromPcm(pcm, rate) }),
      }
    );
    await lectureRebuildInFlight(uid, date);

    assert.equal(recapCalls, 2);
    const wavPath = lectureAudioPath(uid, date)!;
    assert.ok(wavPath);
    const sec = (fs.readFileSync(wavPath).length - 44) / (RATE * 2);
    assert.ok(sec >= 360 && sec <= 370, `WAV sec=${sec} out of [360,370]`);
    const st = readLectureState(uid, date)!;
    assert.equal(st.status, 'ready');
    assert.equal(st.durationFit?.recap, true);
  } finally {
    fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
  }
});

test('9) recap TTS fails twice -> ready under 360s, trailing stretch pad <= 5s, and logs warning', async () => {
  const uid = `test_n1_recap_fail2_${process.pid}`;
  const date = '2026-11-24';
  let recapCalls = 0;
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  };
  try {
    startLectureAudioRebuild(
      {} as GoogleGenAI,
      uid,
      date,
      { title: '실패 폴백', coachNote: '첫 문장. 둘째 문장.', script: shortScript() },
      {
        synthesizeFn: async (_ai, _e, text) => {
          if (text.includes('오늘 표현을 다시 정리해 볼게요')) {
            recapCalls += 1;
            throw new Error('persistent recap TTS error');
          }
          const samples = Math.round((text.length / 10) * RATE);
          return { data: Buffer.alloc(samples * 2), rate: RATE };
        },
        encodeFn: async (pcm, rate) => ({ ext: 'wav', mime: 'audio/wav', buffer: wavFromPcm(pcm, rate) }),
      }
    );
    await lectureRebuildInFlight(uid, date);

    assert.equal(recapCalls, 2);
    const wavPath = lectureAudioPath(uid, date)!;
    assert.ok(wavPath);
    const sec = (fs.readFileSync(wavPath).length - 44) / (RATE * 2);
    assert.ok(sec < LECTURE_MIN_SEC, `expected <360s, got ${sec}s`);
    assert.ok(sec < 120, `expected short lecture without dead-air pad, got ${sec}s`);

    const st = readLectureState(uid, date)!;
    assert.equal(st.status, 'ready');
    assert.equal(st.audioStatus, 'ready');
    assert.ok((st.durationSec ?? 999) < LECTURE_MIN_SEC);
    assert.ok((st.durationFit?.guardPadSec ?? 999) <= LECTURE_MAX_FALLBACK_PAD_SEC);
    assert.ok(
      warns.some((w) => w.includes('under 6:00') && /\d+\.\d+s/.test(w)),
      `expected under-6:00 warning, got: ${JSON.stringify(warns)}`
    );
  } finally {
    console.warn = origWarn;
    fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
  }
});

test('10) N1 generation path (startLectureJob -> runJob -> renderAndSaveAudio) with m4a 80ms pad stub stays <= 370s', async () => {
  const uid = `test_n1_gen_m4a_${process.pid}`;
  const date = '2026-11-24';
  const script: LectureScriptItem[] = Array.from({ length: 12 }, (_, i) => ({
    mistakeId: `m${i}`,
    kind: i === 11 ? 'review' : 'new',
    myPhrase: `I go ${i}`,
    naturalPhrase: `I went ${i}`,
    explanation: '과거 시제를 사용해야 합니다. '.repeat(20),
    dialogue: [
      { speaker: 'Coach', line: 'How was your trip?' },
      { speaker: 'Partner', line: `I went ${i} yesterday.` },
    ],
    meaningKo: '갔다',
    answerEnglish: `I went ${i}`,
    similarExample: 'She went home early.',
  }));
  const newInputs: LectureMistakeInput[] = script
    .filter((s) => s.kind === 'new')
    .map((s) => ({ id: s.mistakeId, myPhrase: s.myPhrase, naturalPhrase: s.naturalPhrase }));
  const reviewInputs: LectureMistakeInput[] = script
    .filter((s) => s.kind === 'review')
    .map((s) => ({ id: s.mistakeId, myPhrase: s.myPhrase, naturalPhrase: s.naturalPhrase }));

  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((r) => {
    resolveReady = r;
  });

  try {
    const started = startLectureJob({} as GoogleGenAI, uid, date, newInputs, reviewInputs, {
      generateScriptFn: async () => ({
        title: '생성 경로 통합',
        coachNote: '첫 문장. 둘째 문장.',
        items: script,
        tokens: 321,
      }),
      synthesizeFn: async (_ai, _e, text) => {
        const samples = Math.round((text.length / 10) * RATE);
        return { data: Buffer.alloc(samples * 2), rate: RATE };
      },
      encodeFn: async (pcm, rate) => {
        const padSamples = Math.round(0.08 * rate);
        const padded = Buffer.concat([pcm, Buffer.alloc(padSamples * 2)]);
        return { ext: 'm4a', mime: 'audio/mp4', buffer: wavFromPcm(padded, rate) };
      },
      onReady: () => {
        resolveReady();
      },
    });
    assert.equal(started.status, 'generating');
    await readyPromise;

    const audioPath = lectureAudioPath(uid, date);
    assert.ok(audioPath && audioPath.endsWith('.m4a'), `expected .m4a path, got ${audioPath}`);
    const wavBuf = fs.readFileSync(audioPath);
    const measuredSec = (wavBuf.length - 44) / (RATE * 2);
    assert.ok(measuredSec >= 360 && measuredSec <= 370, `m4a stub sec=${measuredSec} out of [360,370]`);

    const st = readLectureState(uid, date)!;
    assert.equal(st.status, 'ready');
    assert.equal(st.audioMime, 'audio/mp4');
    assert.equal(st.textTokens, 321);
    assert.equal(st.durationSec, Math.round(measuredSec - 0.08));
  } finally {
    fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
  }
});
