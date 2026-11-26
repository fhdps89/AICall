import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POC_VOICE_ADDENDUM,
  TTS_FIRST_SEGMENT_MIN_CHARS,
  takeFirstSpeechSegment,
  splitSentences,
  flushSentences,
  stripMarkdownForSpeech,
  wavToPcm,
  ttsAudioToPcm,
  pcmSeconds,
  isLikelyEcho,
  shouldBargeIn,
  truncateModelTurnAfterBargeIn,
  buildContents,
  sanitizeHistory,
  median,
  percentile,
  estimateTextTokens,
} from '../server/cascadeText.ts';
import {
  pocCostUsd,
  pocTtsRates,
  pocTextRates,
  POC_TEXT_THINKING_LEVEL,
  sanitizePocUsage,
  emptyPocUsage,
  POC_STT_MODEL,
  POC_TEXT_MODEL,
  POC_TTS_MODEL,
  POC_WS_PATH,
} from '../src/config/cascadePoc.ts';

function wav(pcmBytes: number, rate: number, extraChunk = false): Uint8Array {
  const extra = extraChunk ? 8 + 3 + 1 : 0; // odd-sized LIST chunk + pad byte
  const buf = new Uint8Array(44 + extra + pcmBytes);
  const v = new DataView(buf.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => (buf[o + i] = c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, buf.length - 8, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  let o = 36;
  if (extraChunk) {
    w(o, 'LIST');
    v.setUint32(o + 4, 3, true);
    o += 12;
  }
  w(o, 'data');
  v.setUint32(o + 4, pcmBytes, true);
  return buf;
}

test('models and socket path are the plan values', () => {
  assert.equal(POC_STT_MODEL, 'gemini-3.5-transcribe-live');
  assert.equal(POC_TEXT_MODEL, 'gemini-3.8-flash');
  assert.equal(POC_TEXT_THINKING_LEVEL, 'low');
  assert.equal(POC_TTS_MODEL, 'gemini-3.8-flash-tts');
  assert.equal(POC_WS_PATH, '/api/gemini/cascade');
});

test('splitSentences cuts finished sentences and keeps the tail', () => {
  const r = splitSentences('Hi there! How was your day? I went to');
  assert.deepEqual(r.sentences, ['Hi there!', 'How was your day?']);
  assert.equal(r.rest, 'I went to');
  assert.deepEqual(flushSentences(r.rest), ['I went to']);
  assert.deepEqual(flushSentences('   '), []);
});

test('splitSentences does not cut abbreviations or decimals', () => {
  const r = splitSentences('Mr. Kim paid 3.5 dollars at 9 a.m. today. Next');
  assert.deepEqual(r.sentences, ['Mr. Kim paid 3.5 dollars at 9 a.m. today.']);
  assert.equal(r.rest, 'Next');
  // A period at the very end of the stream so far is a boundary only once the next char is known.
  assert.deepEqual(splitSentences('좋아요. 다음').sentences, ['좋아요.']);
});

test('stripMarkdownForSpeech removes list markers, emphasis and emoji', () => {
  assert.equal(stripMarkdownForSpeech('- **Great** job! 😀'), 'Great job!');
  assert.equal(stripMarkdownForSpeech('1. Say `hello`'), 'Say hello');
});

test('wavToPcm walks chunks (odd padding) and reads the rate', () => {
  const a = wavToPcm(wav(48000, 24000));
  assert.equal(a.sampleRate, 24000);
  assert.equal(a.pcm.byteLength, 48000);
  const b = wavToPcm(wav(100, 16000, true));
  assert.equal(b.sampleRate, 16000);
  assert.equal(b.pcm.byteLength, 100);
  assert.equal(pcmSeconds(48000, 24000), 1);
  assert.equal(pcmSeconds(-1, 24000), 0);
});

test('ttsAudioToPcm takes raw L16 rate from the mime type, WAV from its header', () => {
  const raw = new Uint8Array(32000);
  assert.equal(ttsAudioToPcm(raw, 'audio/L16;codec=pcm;rate=16000').sampleRate, 16000);
  assert.equal(ttsAudioToPcm(raw, 'audio/pcm').sampleRate, 24000);
  assert.equal(ttsAudioToPcm(raw, 'audio/L16;rate=16000').pcm, raw);
  const w = ttsAudioToPcm(wav(10, 22050), 'audio/wav');
  assert.equal(w.sampleRate, 22050);
  assert.equal(w.pcm.byteLength, 10);
});

test('barge-in rule: 2+ words, tutor speaking, not an echo of the tutor', () => {
  const tutor = 'What did you do this weekend with your family';
  assert.equal(shouldBargeIn({ interim: 'wait sorry', tutorSpeaking: true, tutorRecentText: tutor }), true);
  assert.equal(shouldBargeIn({ interim: 'wait', tutorSpeaking: true, tutorRecentText: tutor }), false);
  assert.equal(shouldBargeIn({ interim: 'wait sorry', tutorSpeaking: false, tutorRecentText: tutor }), false);
  // Echo: >= 70% of the heard words are the tutor's own words.
  assert.equal(isLikelyEcho('this weekend with your', tutor), true);
  assert.equal(shouldBargeIn({ interim: 'this weekend with your', tutorSpeaking: true, tutorRecentText: tutor }), false);
  assert.equal(isLikelyEcho('I went hiking with my dad', tutor), false);
});

test('history after barge-in keeps only spoken sentences', () => {
  assert.equal(truncateModelTurnAfterBargeIn(['Hello.', ' How are you? ']), 'Hello. How are you? [interrupted]');
  assert.equal(truncateModelTurnAfterBargeIn([]), '[interrupted before speaking]');
});

test('buildContents merges same-role turns and starts with a user turn', () => {
  const c = buildContents([
    { role: 'model', text: 'Hi!' },
    { role: 'user', text: 'Hello' },
    { role: 'user', text: 'again' },
  ]);
  assert.deepEqual(c.map((x) => x.role), ['user', 'model', 'user']);
  assert.equal(c[2].parts[0].text, 'Hello\nagain');
  assert.deepEqual(sanitizeHistory([{ role: 'x', text: 'a' }, { role: 'user', text: ' ok ' }, null]), [{ role: 'user', text: 'ok' }]);
});

test('stats helpers', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(median([]), 0);
  assert.equal(estimateTextTokens('abcdefgh'), 2);
});

test('PoC cost: 3.8-flash text and 3.8-flash-tts rates, 2026 vs 2027 switch at 2027-01-01 00:00 KST', () => {
  assert.deepEqual(pocTtsRates(Date.parse('2026-12-31T14:59:59Z')), { inPer1M: 0.5, outAudioPer1M: 9 });
  assert.deepEqual(pocTtsRates(Date.parse('2026-12-31T15:00:00Z')), { inPer1M: 1, outAudioPer1M: 18 });
  assert.deepEqual(pocTextRates(Date.parse('2026-12-31T14:59:59Z')), { inPer1M: 0.75, outPer1M: 3.75 });
  assert.deepEqual(pocTextRates(Date.parse('2026-12-31T15:00:00Z')), { inPer1M: 1.5, outPer1M: 7.5 });
  // Plan's 10-minute call: 600 s mic, 300 s tutor audio, 40 turns x ~4,500 input tokens.
  const u = { ...emptyPocUsage(), sttAudioSec: 600, sttOutTokens: 1750, textInTokens: 180_000, textOutTokens: 12_000, ttsInTokens: 4000, ttsAudioSec: 300 };
  const c2026 = pocCostUsd(u, Date.parse('2026-11-26T12:00:00Z'));
  const c2027 = pocCostUsd(u, Date.parse('2027-01-02T00:00:00Z'));
  assert.ok(Math.abs(c2026 - (600 * 25 * 3.5 + 1750 * 21 + 180_000 * 0.75 + 12_000 * 3.75 + 4000 * 0.5 + 300 * 25 * 9) / 1e6) < 1e-12);
  assert.ok(Math.abs(c2027 - (600 * 25 * 3.5 + 1750 * 21 + 180_000 * 1.5 + 12_000 * 7.5 + 4000 * 1 + 300 * 25 * 18) / 1e6) < 1e-12);
  assert.equal(pocCostUsd(null), 0);
  assert.equal(pocCostUsd({ sttAudioSec: -5, ttsAudioSec: Number.NaN }), 0);
});

test('sanitizePocUsage coerces untrusted client data', () => {
  const s = sanitizePocUsage({ sttAudioSec: '12', ttsAudioSec: -3, turns: 2.7, sttOutEstimated: 1, extra: 'x' });
  assert.equal(s.sttAudioSec, 12);
  assert.equal(s.ttsAudioSec, 0);
  assert.equal(s.turns, 2);
  assert.equal(s.sttOutEstimated, true);
  assert.deepEqual(sanitizePocUsage('nope'), emptyPocUsage());
});

test('POC_VOICE_ADDENDUM states 1-2 short sentences (~25 words) and one open question', () => {
  assert.match(POC_VOICE_ADDENDUM, /^Voice call output rules:/);
  assert.match(POC_VOICE_ADDENDUM, /1 to 2 short/i);
  assert.match(POC_VOICE_ADDENDUM, /25 words/i);
  assert.match(POC_VOICE_ADDENDUM, /one open question/i);
  assert.match(POC_VOICE_ADDENDUM, /markdown/i);
});

test('takeFirstSpeechSegment covers all branches (empty, 1 short, 2+ sentences, >=80 chars, streamDone)', () => {
  assert.equal(TTS_FIRST_SEGMENT_MIN_CHARS, 80);
  // Empty input
  assert.equal(takeFirstSpeechSegment([], false), null);
  assert.equal(takeFirstSpeechSegment([], true), null);
  // Single short sentence before streamDone waits
  assert.equal(takeFirstSpeechSegment(['Short sentence.'], false), null);
  // Single short sentence when streamDone takes all
  assert.deepEqual(takeFirstSpeechSegment(['Short sentence.'], true), {
    segment: 'Short sentence.',
    used: 1,
  });
  // Branch (a): 2+ sentences available -> takes first 2
  assert.deepEqual(takeFirstSpeechSegment(['First one.', 'Second one.', 'Third one.'], false), {
    segment: 'First one. Second one.',
    used: 2,
  });
  // Branch (b): single sentence >= 80 chars -> takes just that 1 sentence
  const long1 = 'A'.repeat(80) + '.';
  assert.deepEqual(takeFirstSpeechSegment([long1], false), {
    segment: long1,
    used: 1,
  });
  // Branch (b) with multiple sentences where first already reaches 80 chars -> takes as few leading sentences as reach 80 (1)
  assert.deepEqual(takeFirstSpeechSegment([long1, 'Second.', 'Third.'], false), {
    segment: long1,
    used: 1,
  });
  // Branch (b) where first 2 sentences together reach >= 80 chars -> takes 2
  const med1 = 'B'.repeat(45) + '.';
  const med2 = 'C'.repeat(45) + '.';
  assert.deepEqual(takeFirstSpeechSegment([med1, med2, 'Third.'], false), {
    segment: `${med1} ${med2}`,
    used: 2,
  });
});
