import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import {
  DATA_DIR,
  LECTURE_AUDIO_SCRIPT_MISSING,
  MAX_LECTURE_SCRIPT_ITEMS,
  lectureAudioPath,
  lectureHasLocalScript,
  lectureRebuildInFlight,
  readLectureState,
  sanitizeLectureScriptPayload,
  startLectureAudioRebuild,
  lectureStatusPayload,
  toSpeechParts,
  type LecturePcm,
  type LectureScriptItem,
  type LectureState,
  type LectureSynthesizeFn,
} from '../server/lecture.ts';
import { wavFromPcm, type LectureEncodeFn } from '../server/lectureAudioEncode.ts';

const ai = {} as GoogleGenAI;

function sampleScript(): LectureScriptItem[] {
  return [
    {
      mistakeId: 'm1',
      kind: 'new',
      myPhrase: 'I go yesterday',
      naturalPhrase: 'I went yesterday',
      explanation: '과거시제',
      dialogue: [
        { speaker: 'Coach', line: 'What did you do yesterday?' },
        { speaker: 'Partner', line: 'I went yesterday.' },
      ],
      meaningKo: '나는 어제 갔다',
      answerEnglish: 'I went yesterday',
    },
  ];
}

function silentPcm(): LecturePcm {
  return { data: Buffer.alloc(2400 * 2), rate: 24000 };
}

const wavEncode: LectureEncodeFn = async (pcm, rate) => ({
  ext: 'wav',
  mime: 'audio/wav',
  buffer: wavFromPcm(pcm, rate),
});

function mockSynth(calls: { n: number }, delayMs = 0, fail = false): LectureSynthesizeFn {
  return async () => {
    calls.n += 1;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (fail) throw new Error('TTS boom');
    return silentPcm();
  };
}

function uidFor(name: string): string {
  return `test_rebuild_${name}_${process.pid}`;
}

function cleanup(uid: string) {
  fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
}

function writeReadyWithoutWav(
  uid: string,
  date: string,
  script = sampleScript(),
  opts: { title?: string; coachNote?: string } = {}
) {
  const dir = path.join(DATA_DIR, 'lectures', uid);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const state: LectureState = {
    uid,
    date,
    status: 'ready',
    title: opts.title ?? '테스트 강의',
    script,
    coachNote: opts.coachNote ?? '잘하고 있어요',
    itemCount: script.length,
    newMistakeIds: script.map((s) => s.mistakeId),
    reviewMistakeIds: [],
    ttsEngine: 'gemini',
    audioFile: `${date}.wav`,
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(state, null, 2));
}

test('lectureAudioPath is null when the json is ready but the wav is missing', () => {
  const uid = uidFor('missing_wav');
  const date = '2026-11-21';
  try {
    writeReadyWithoutWav(uid, date);
    assert.equal(lectureHasLocalScript(uid, date), true);
    assert.equal(lectureAudioPath(uid, date), null);
    const st = readLectureState(uid, date);
    assert.equal(st?.status, 'ready');
  } finally {
    cleanup(uid);
  }
});

test('sanitizeLectureScriptPayload rejects empty and oversized scripts', () => {
  assert.equal(sanitizeLectureScriptPayload({ script: [] }).ok, false);
  const tooMany = Array.from(
    { length: MAX_LECTURE_SCRIPT_ITEMS + 1 },
    (_, i) => sampleScript()[0] && { ...sampleScript()[0], mistakeId: `m${i}` }
  );
  const res = sanitizeLectureScriptPayload({ script: tooMany });
  assert.equal(res.ok, false);
  const ok = sanitizeLectureScriptPayload({ script: sampleScript(), title: '아침' });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.payload.script.length, 1);
});

test('rebuild from a ready script writes a wav, keeps status=ready, and is idempotent', async () => {
  const uid = uidFor('rebuild_ok');
  const date = '2026-11-21';
  const calls = { n: 0 };
  try {
    writeReadyWithoutWav(uid, date);
    const first = startLectureAudioRebuild(ai, uid, date, undefined, {  synthesizeFn: mockSynth(calls), encodeFn: wavEncode });
    assert.equal(first.status, 'ready');
    assert.equal(first.audioStatus, 'rebuilding');
    await lectureRebuildInFlight(uid, date);
    const st = readLectureState(uid, date);
    assert.equal(st?.status, 'ready');
    assert.equal(st?.audioStatus, 'ready');
    assert.ok(lectureAudioPath(uid, date));
    assert.ok((st?.script?.[0].startSec ?? -1) >= 0);
    const wav = lectureAudioPath(uid, date)!;
    assert.ok(fs.statSync(wav).size > 44);

    const before = calls.n;
    const second = startLectureAudioRebuild(ai, uid, date, undefined, {  synthesizeFn: mockSynth(calls), encodeFn: wavEncode });
    assert.equal(second.audioStatus, 'ready');
    assert.equal(calls.n, before);
  } finally {
    cleanup(uid);
  }
});

test('rebuild without any script returns SCRIPT_MISSING and does not leave a wav', () => {
  const uid = uidFor('no_script');
  const date = '2026-11-21';
  try {
    const st = startLectureAudioRebuild(ai, uid, date);
    assert.equal(st.error, LECTURE_AUDIO_SCRIPT_MISSING);
    assert.notEqual(st.status, 'generating');
    assert.equal(lectureAudioPath(uid, date), null);
  } finally {
    cleanup(uid);
  }
});

test('rebuild from a client script restores audio after a wiped .data folder', async () => {
  const uid = uidFor('from_payload');
  const date = '2026-11-21';
  const calls = { n: 0 };
  try {
    const st = startLectureAudioRebuild(
      ai,
      uid,
      date,
      { title: '복구 강의', script: sampleScript(), coachNote: '다시 만들었어요' },
      {  synthesizeFn: mockSynth(calls), encodeFn: wavEncode }
    );
    assert.equal(st.status, 'ready');
    assert.equal(st.audioStatus, 'rebuilding');
    await lectureRebuildInFlight(uid, date);
    const ready = readLectureState(uid, date);
    assert.equal(ready?.status, 'ready');
    assert.equal(ready?.title, '복구 강의');
    assert.ok(lectureAudioPath(uid, date));
    assert.ok(calls.n > 0);
  } finally {
    cleanup(uid);
  }
});

test('concurrent rebuilds share one TTS job', async () => {
  const uid = uidFor('concurrent');
  const date = '2026-11-21';
  const calls = { n: 0 };
  try {
    writeReadyWithoutWav(uid, date);
    const a = startLectureAudioRebuild(ai, uid, date, undefined, {  synthesizeFn: mockSynth(calls, 40), encodeFn: wavEncode });
    const b = startLectureAudioRebuild(ai, uid, date, undefined, {  synthesizeFn: mockSynth(calls, 40), encodeFn: wavEncode });
    assert.equal(a.audioStatus, 'rebuilding');
    assert.equal(b.audioStatus, 'rebuilding');
    await lectureRebuildInFlight(uid, date);
    // Opening + body + answer (+ optional coach note) is several TTS calls, but only one job.
    // The second start must not have launched a second job: call count stays from the first job only.
    const after = calls.n;
    assert.ok(after >= 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.n, after);
    assert.ok(lectureAudioPath(uid, date));
  } finally {
    cleanup(uid);
  }
});

test('TTS failure leaves no half-written wav and keeps status ready', async () => {
  const uid = uidFor('tts_fail');
  const date = '2026-11-21';
  try {
    writeReadyWithoutWav(uid, date);
    startLectureAudioRebuild(ai, uid, date, undefined, { synthesizeFn: mockSynth({ n: 0 }, 0, true), encodeFn: wavEncode });
    await lectureRebuildInFlight(uid, date);
    const st = readLectureState(uid, date);
    assert.equal(st?.status, 'ready');
    assert.equal(st?.audioStatus, 'missing');
    assert.equal(st?.error, 'GENERATION_FAILED');
    assert.equal(lectureAudioPath(uid, date), null);
    const dir = path.join(DATA_DIR, 'lectures', uid);
    const leftovers = fs.readdirSync(dir).filter((f) => /\.(wav|m4a|mp3|tmp)$/.test(f));
    assert.deepEqual(leftovers, []);
  } finally {
    cleanup(uid);
  }
});

test('rebuild strips directions before TTS while keeping myPhrase verbatim (R1–R6)', async () => {
  const uid = uidFor('strip_directions');
  const date = '2026-11-22';
  const captured: { text: string; twoSpeakers: boolean }[] = [];
  const synthCapture: LectureSynthesizeFn = async (_ai, _engine, text, twoSpeakers) => {
    captured.push({ text, twoSpeakers });
    return silentPcm();
  };
  const myPhrase = 'I go (pause) **home**';
  const item: LectureScriptItem = {
    mistakeId: 'm1',
    kind: 'new',
    myPhrase,
    naturalPhrase: 'work for (소속)',
    explanation: '(pause) 과거시제를 써요.',
    dialogue: [
      { speaker: 'Partner', line: 'Partner: Hi' },
      { speaker: 'Coach', line: '(laughs)' },
    ],
    meaningKo: '집에 갔다',
    answerEnglish: '*I went home*',
  };

  try {
    writeReadyWithoutWav(uid, date, [item], {
      title: '테스트 (pause) 강의',
      coachNote: '**잘했어요** (pause)',
    });
    startLectureAudioRebuild(ai, uid, date, undefined, {  synthesizeFn: synthCapture, encodeFn: wavEncode });
    await lectureRebuildInFlight(uid, date);

    // R1: 4 synth calls (opening, body, answer, coachNote)
    assert.equal(captured.length, 4);

    // R2: myPhrase stays verbatim in the item body
    assert.ok(captured[1].text.includes(`"${myPhrase}"`));

    // R3: outside myPhrase, no stage directions, markdown, duplicate labels, or empty Partner lines remain
    const outsideMyPhrase = captured.map((c) => c.text).join('\n').replaceAll(myPhrase, '');
    for (const forbidden of ['(pause)', '[', '**', '3초 무음', '(laughs)', 'Partner: Partner']) {
      assert.equal(outsideMyPhrase.includes(forbidden), false, `unexpected ${forbidden} in TTS input`);
    }
    assert.equal(/^Partner:\s*$/m.test(outsideMyPhrase), false);

    // R4: answer call is clean
    assert.equal(captured[2].text, 'Coach: I went home');

    // R5: stored state.script[0] is cleaned and has numeric startSec
    const st = readLectureState(uid, date);
    const saved = st?.script?.[0];
    assert.ok(saved);
    assert.equal(saved.myPhrase, myPhrase);
    assert.equal(saved.naturalPhrase, 'work for (소속)');
    assert.equal(saved.explanation, '과거시제를 써요.');
    assert.deepEqual(saved.dialogue, [{ speaker: 'Partner', line: 'Hi' }]);
    assert.equal(typeof saved.startSec, 'number');

    // R6: toSpeechParts output for every captured call never contains TTS_STYLE text
    const STYLE_LEAK_RE = /Read this morning English lesson|Korean-accented transliteration/;
    for (const call of captured) {
      for (const part of toSpeechParts(call.text, call.twoSpeakers)) {
        assert.equal(STYLE_LEAK_RE.test(part.text), false);
      }
    }
  } finally {
    cleanup(uid);
  }
});

test('lectureStatusPayload reports hasAudio false while rebuilding and true after encode', async () => {
  const uid = uidFor('status_payload');
  const date = '2026-11-21';
  const calls = { n: 0 };
  try {
    writeReadyWithoutWav(uid, date);
    startLectureAudioRebuild(ai, uid, date, undefined, { synthesizeFn: mockSynth(calls, 30), encodeFn: wavEncode });
    const mid = lectureStatusPayload(uid, date);
    assert.equal(mid?.status, 'ready');
    assert.equal(mid?.audioStatus, 'rebuilding');
    assert.equal(mid?.hasAudio, false);
    assert.ok((mid?.audioProgress?.total ?? 0) >= 1);
    await lectureRebuildInFlight(uid, date);
    const done = lectureStatusPayload(uid, date);
    assert.equal(done?.audioStatus, 'ready');
    assert.equal(done?.hasAudio, true);
    assert.equal(done?.audioMime, 'audio/wav');
  } finally {
    cleanup(uid);
  }
});

test('stuck rebuilding without a running job is reported as missing/INTERRUPTED', () => {
  const uid = uidFor('stuck_rebuild');
  const date = '2026-11-21';
  try {
    writeReadyWithoutWav(uid, date);
    const dir = path.join(DATA_DIR, 'lectures', uid);
    const file = path.join(dir, `${date}.json`);
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    st.audioStatus = 'rebuilding';
    delete st.audioFile;
    fs.writeFileSync(file, JSON.stringify(st, null, 2));
    const payload = lectureStatusPayload(uid, date);
    assert.equal(payload?.status, 'ready');
    assert.equal(payload?.audioStatus, 'missing');
    assert.equal(payload?.error, 'INTERRUPTED');
    assert.equal(payload?.hasAudio, false);
  } finally {
    cleanup(uid);
  }
});
