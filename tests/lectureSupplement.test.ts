import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GoogleGenAI } from '@google/genai';
import {
  SUPPLEMENT_MAX_CORPUS_CHARS,
  SUPPLEMENT_MAX_ITEMS,
  SUPPLEMENT_TIMEOUT_MS,
  shouldSkipSupplement,
  buildSupplementPrompt,
  runLectureSupplement,
} from '../server/lectureSupplement.ts';
import { LECTURE_STEP_TIMEOUT_MS } from '../server/lecture.ts';

test('supplement constants align with lecture step timeout and caps', () => {
  assert.equal(SUPPLEMENT_TIMEOUT_MS, LECTURE_STEP_TIMEOUT_MS);
  assert.equal(SUPPLEMENT_TIMEOUT_MS, 90_000);
  assert.equal(SUPPLEMENT_MAX_CORPUS_CHARS, 8000);
  assert.equal(SUPPLEMENT_MAX_ITEMS, 8);
});

test('shouldSkipSupplement guards QA, short (<180s), and empty/filler-only corpora', () => {
  const usable = 'I am here for my business trip until Friday and stay at the hotel.';
  assert.equal(shouldSkipSupplement({ qa: true, durationSec: 360, corpus: usable }), 'qa');
  assert.equal(shouldSkipSupplement({ qa: false, durationSec: 47, corpus: usable }), 'short_session');
  assert.equal(shouldSkipSupplement({ qa: false, durationSec: 179, corpus: usable }), 'short_session');
  assert.equal(shouldSkipSupplement({ qa: false, durationSec: 180, corpus: usable }), null);
  assert.equal(shouldSkipSupplement({ qa: false, durationSec: 360, corpus: '' }), 'no_usable_speech');
  assert.equal(shouldSkipSupplement({ qa: false, durationSec: 360, corpus: 'uh um okay yeah' }), 'no_usable_speech');
  assert.equal(shouldSkipSupplement({ qa: false, durationSec: 360, corpus: '[silence] (noise)' }), 'no_usable_speech');
});

test('buildSupplementPrompt includes known phrases, lesson topic, corpus, and verbatim rules', () => {
  const prompt = buildSupplementPrompt({
    corpus: 'The hotel name is what? Marriott.',
    knownPhrases: ["I'm here for my business trip."],
    lessonTitle: 'USA: immigration',
  });
  assert.ok(prompt.includes('USA: immigration'));
  assert.ok(prompt.includes("I'm here for my business trip."));
  assert.ok(prompt.includes('The hotel name is what?'));
  assert.ok(prompt.includes('WORD-FOR-WORD, EXACTLY VERBATIM'));
});

test('runLectureSupplement skips without calling AI when cost guard triggers', async () => {
  let called = 0;
  const ai = {
    models: {
      generateContent: async () => {
        called += 1;
        return { text: '[]' };
      },
    },
  } as unknown as GoogleGenAI;

  const qaRes = await runLectureSupplement(ai, {
    corpus: 'I am here for my business trip.',
    durationSec: 300,
    qa: true,
  });
  assert.equal(qaRes.status, 'skipped');
  assert.deepEqual(qaRes.items, []);
  assert.equal(called, 0);

  const shortRes = await runLectureSupplement(ai, {
    corpus: 'I am here for my business trip.',
    durationSec: 47,
  });
  assert.equal(shortRes.status, 'skipped');
  assert.deepEqual(shortRes.items, []);
  assert.equal(called, 0);

  const emptyRes = await runLectureSupplement(ai, {
    corpus: '   ',
    durationSec: 300,
  });
  assert.equal(emptyRes.status, 'skipped');
  assert.deepEqual(emptyRes.items, []);
  assert.equal(called, 0);
});

test('runLectureSupplement merges, verifies, deduplicates, caps at 8, and tracks usage', async () => {
  const corpus =
    "I'm here for my business trip. The hotel name is what? Element Hotel in Philadelphia downtown. This is my reservation ticket. the head of finance team. I'm carrying the notebook and some clothes. I have just $200. I have been in uh Los Angeles uh when I was 17 years old.";
  const ai = {
    models: {
      generateContent: async () => ({
        text: JSON.stringify([
          { myPhrase: "I'm here for my business trip.", naturalPhrase: 'dup', reason: 'dup', sourceStt: 'sttFinal' },
          { myPhrase: 'I go to the office', naturalPhrase: 'I went to the office', reason: 'invented', sourceStt: 'sttFinal' },
          { myPhrase: 'uh', naturalPhrase: 'uh', reason: 'filler', sourceStt: 'sttFinal' },
          { myPhrase: 'The hotel name is what?', naturalPhrase: 'What is the name of the hotel?', reason: '어순', sourceStt: 'sttFinal' },
          { myPhrase: 'I have just $200.', naturalPhrase: 'I only have $200.', reason: '어순', sourceStt: 'sttFinal' },
        ]),
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45 },
      }),
    },
  } as unknown as GoogleGenAI;

  const res = await runLectureSupplement(ai, {
    corpus,
    knownPhrases: [{ myPhrase: "I'm here for my business trip." }],
    durationSec: 369,
    lessonTitle: 'USA: immigration',
  });
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.usage, { inputTokens: 120, outputTokens: 45 });
  assert.deepEqual(
    res.items.map((i) => i.myPhrase),
    ['The hotel name is what?', 'I have just $200.']
  );
});

test('runLectureSupplement returns failed + empty items when generateContent throws or times out', async () => {
  const throwingAi = {
    models: {
      generateContent: async () => {
        throw new Error('Gemini unavailable');
      },
    },
  } as unknown as GoogleGenAI;

  const failed = await runLectureSupplement(throwingAi, {
    corpus: 'The hotel name is what? I stay at Marriott.',
    durationSec: 300,
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'SUPPLEMENT_FAILED');
  assert.deepEqual(failed.items, []);

  const timeoutAi = {
    models: {
      generateContent: async () => {
        throw new Error('lecture supplement timed out after 90000ms');
      },
    },
  } as unknown as GoogleGenAI;

  const timedOut = await runLectureSupplement(timeoutAi, {
    corpus: 'The hotel name is what? I stay at Marriott.',
    durationSec: 300,
  });
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.error, 'TIMED_OUT');
  assert.deepEqual(timedOut.items, []);
});
