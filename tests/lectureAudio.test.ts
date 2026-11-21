import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import {
  DATA_DIR,
  LECTURE_AUDIO_SCRIPT_MISSING,
  lectureAudioPath,
  lectureHasLocalScript,
  lectureRebuildInFlight,
  readLectureState,
  sanitizeLectureScriptPayload,
  startLectureAudioRebuild,
  type LecturePcm,
  type LectureScriptItem,
  type LectureState,
  type LectureSynthesizeFn,
} from '../server/lecture.ts';

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

function writeReadyWithoutWav(uid: string, date: string, script = sampleScript()) {
  const dir = path.join(DATA_DIR, 'lectures', uid);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const state: LectureState = {
    uid,
    date,
    status: 'ready',
    title: '테스트 강의',
    script,
    coachNote: '잘하고 있어요',
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
  const tooMany = Array.from({ length: 10 }, (_, i) => sampleScript()[0] && { ...sampleScript()[0], mistakeId: `m${i}` });
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
    const first = startLectureAudioRebuild(ai, uid, date, undefined, { synthesizeFn: mockSynth(calls) });
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
    const second = startLectureAudioRebuild(ai, uid, date, undefined, { synthesizeFn: mockSynth(calls) });
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
      { synthesizeFn: mockSynth(calls) }
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
    const a = startLectureAudioRebuild(ai, uid, date, undefined, { synthesizeFn: mockSynth(calls, 40) });
    const b = startLectureAudioRebuild(ai, uid, date, undefined, { synthesizeFn: mockSynth(calls, 40) });
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
    startLectureAudioRebuild(ai, uid, date, undefined, { synthesizeFn: mockSynth({ n: 0 }, 0, true) });
    await lectureRebuildInFlight(uid, date);
    const st = readLectureState(uid, date);
    assert.equal(st?.status, 'ready');
    assert.equal(st?.audioStatus, 'missing');
    assert.equal(st?.error, 'GENERATION_FAILED');
    assert.equal(lectureAudioPath(uid, date), null);
    const dir = path.join(DATA_DIR, 'lectures', uid);
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.wav') || f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    cleanup(uid);
  }
});
