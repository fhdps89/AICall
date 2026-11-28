import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CORRECTION_MEMO_HEADING,
  CORRECTION_MEMO_MAX_CHARS,
  CORRECTION_MEMO_MAX_ITEMS,
  appendMemoToSystemPrompt,
  detectCompression,
  estimateMemoTokens,
  extractCorrections,
  extractRecastBySimilarity,
  extractUnquotedCues,
  formatCorrectionMemo,
  isQuestionSentence,
  tokenSimilarity,
  tokenizePhrase,
  mergeCorrections,
  memoSignature,
  shouldReinjectMemo,
  type CallCorrection,
} from "../src/services/call/correctionMemo.ts";

test("extracts you said / more natural is pairs and an optional rule", () => {
  const items = extractCorrections(
    "I go yesterday",
    'You said "I go yesterday." A more natural way is "I went yesterday" (past tense).',
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].myPhrase, "I go yesterday.");
  assert.equal(items[0].naturalPhrase, "I went yesterday");
  assert.equal(items[0].rule, "past tense");
});

test("extracts not X but Y and arrow pairs", () => {
  const a = extractCorrections("", 'It is not "I have 20 years" but "I am 20 years old".');
  assert.equal(a.length, 1);
  assert.equal(a[0].myPhrase, "I have 20 years");
  assert.equal(a[0].naturalPhrase, "I am 20 years old");

  const b = extractCorrections("", '"goed" -> "went"');
  assert.equal(b.length, 1);
  assert.deepEqual(b[0], { myPhrase: "goed", naturalPhrase: "went", rule: undefined });
});

test("extracts Korean 아니라 quotes and two-quote fallback using the user line", () => {
  const ko = extractCorrections("나는 어제 가다", '"나는 어제 가다"가 아니라 "나는 어제 갔어요"');
  assert.equal(ko.length, 1);
  assert.equal(ko[0].naturalPhrase, "나는 어제 갔어요");

  const two = extractCorrections(
    "I didn't went",
    'A better sentence is "I didn\'t go" instead of repeating "I didn\'t went" no wait — try "I didn\'t go".',
  );
  // may match via quotes; at least one pair, wrong side close to the user line
  assert.ok(two.length >= 1);
});

test("ignores greetings and identical quotes (no false correction)", () => {
  assert.deepEqual(extractCorrections("Hi", "Hello! How was your day? Let's start lesson 2."), []);
  assert.deepEqual(extractCorrections("", 'You said "okay" and I also said "okay".'), []);
  assert.deepEqual(extractCorrections("", "Hi"), []);
});

test("QA recast (aee7997 live text call): unquoted 'I went to the park...' is a correction", () => {
  const user = "I go to park with my friend yesterday.";
  const tutor = "I went to the park with my friend yesterday.";
  const items = extractCorrections(user, tutor);
  assert.equal(items.length, 1, `expected a recast, got ${JSON.stringify(items)}`);
  assert.equal(items[0].myPhrase, user);
  assert.match(items[0].naturalPhrase, /went to the park with my friend yesterday/i);
  const u = tokenizePhrase(user);
  const t = tokenizePhrase(tutor);
  assert.ok(tokenSimilarity(u, t) >= 0.6, `similarity ${tokenSimilarity(u, t)}`);
  assert.ok(tokenSimilarity(u, t) < 1);
});

test("voice-style recast: unpunctuated tutor turn plus a short explanation still matches", () => {
  const user = "I go to park with my friend yesterday";
  const tutor =
    "I went to the park with my friend yesterday we use the past tense went and we say the park";
  const items = extractCorrections(user, tutor);
  assert.equal(items.length, 1);
  assert.match(items[0].naturalPhrase, /went to the park with my friend yesterday/i);
});

test("voice-style recast in a punctuated tutor turn with praise around it", () => {
  const items = extractCorrections(
    "She have two brother",
    "Good try. She has two brothers. We add s for more than one brother.",
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].myPhrase, "She have two brother");
  assert.match(items[0].naturalPhrase, /She has two brothers/i);
});

test("unquoted cue phrases: you can say, try saying, better to say, we say X instead of Y, Korean 라고 하면 돼요", () => {
  const can = extractUnquotedCues(
    "I go yesterday",
    "You can say I went yesterday because it is past.",
  );
  assert.equal(can.length, 1);
  assert.match(can[0].naturalPhrase, /I went yesterday/i);

  const trySay = extractCorrections("I go to park", "Try saying I went to the park.");
  assert.equal(trySay.length, 1);
  assert.match(trySay[0].naturalPhrase, /I went to the park/i);

  const better = extractCorrections(
    "I have 20 years",
    "It's better to say I am 20 years old.",
  );
  assert.equal(better.length, 1);
  assert.match(better[0].naturalPhrase, /I am 20 years old/i);

  const instead = extractCorrections("", "We say I went yesterday instead of I go yesterday.");
  assert.equal(instead.length, 1);
  assert.match(instead[0].myPhrase, /I go yesterday/i);
  assert.match(instead[0].naturalPhrase, /I went yesterday/i);

  const ko = extractCorrections(
    "나는 어제 공원에 가다",
    "나는 어제 공원에 갔어요라고 하면 돼요.",
  );
  assert.equal(ko.length, 1);
  assert.match(ko[0].naturalPhrase, /갔어요/);
});

test("recast detector ignores echoes, short lines, and questions that only reuse words", () => {
  const user = "I go to park with my friend yesterday.";
  assert.deepEqual(extractRecastBySimilarity(user, user), []);
  assert.deepEqual(extractRecastBySimilarity(user, "I go to park with my friend yesterday."), []);
  assert.deepEqual(extractCorrections("ok yes", "Okay, yes, let's continue with the next sentence."), []);
  assert.equal(isQuestionSentence("Did you go to the park with your friend yesterday?"), true);
  assert.deepEqual(
    extractRecastBySimilarity(user, "Did you go to the park with your friend yesterday?"),
    [],
  );
  assert.deepEqual(
    extractCorrections(user, "Did you go to the park with your friend yesterday?"),
    [],
  );
  assert.deepEqual(extractCorrections("Hi there", "How was your day at the park yesterday?"), []);
  // A short praise plus a question must not leak a recast from the question's words.
  assert.deepEqual(
    extractCorrections(user, "Great! Did you go to the park with your friend yesterday?"),
    [],
  );
  // Exact echo plus a follow-up must not treat "… yesterday tell" as a correction.
  assert.deepEqual(
    extractRecastBySimilarity(user, "I go to park with my friend yesterday. Tell me more about it!"),
    [],
  );
  assert.deepEqual(
    extractRecastBySimilarity(user, "I go to park with my friend yesterday tell me more about it"),
    [],
  );
});

test("recast helpers reject empty and too-short lines, and keep the 0.6 / 3-token bars", () => {
  assert.deepEqual(extractCorrections("", ""), []);
  assert.deepEqual(extractRecastBySimilarity("", "I went to the park yesterday."), []);
  assert.deepEqual(extractUnquotedCues("", ""), []);
  // 2 tokens: below RECAST_MIN_TOKENS
  assert.deepEqual(extractRecastBySimilarity("I go", "I went"), []);
  // 3 tokens, one substitution (go→went): similarity 2/3 ≈ 0.67, should match
  const three = extractCorrections("I go yesterday", "I went yesterday.");
  assert.equal(three.length, 1);
  assert.match(three[0].naturalPhrase, /I went yesterday/i);
  // Clearly different sentences stay unmatched
  assert.deepEqual(
    extractRecastBySimilarity("I like apples", "She enjoys swimming every morning."),
    [],
  );
});

test("merge caps at 8 items, updates in place, and stays within the character budget", () => {
  const many: CallCorrection[] = Array.from({ length: 10 }, (_, i) => ({
    myPhrase: `wrong ${i}`,
    naturalPhrase: `right ${i}`,
  }));
  const capped = mergeCorrections([], many);
  assert.equal(capped.length, CORRECTION_MEMO_MAX_ITEMS);
  assert.equal(capped[0].myPhrase, "wrong 2");
  assert.equal(capped.at(-1)?.myPhrase, "wrong 9");

  const updated = mergeCorrections(capped, [{ myPhrase: "wrong 2", naturalPhrase: "RIGHT 2", rule: "article" }]);
  assert.equal(updated.length, CORRECTION_MEMO_MAX_ITEMS);
  assert.equal(updated.at(-1)?.naturalPhrase, "RIGHT 2");
  assert.equal(updated.at(-1)?.rule, "article");

  const long: CallCorrection[] = Array.from({ length: 8 }, (_, i) => ({
    myPhrase: `I always say this very long incorrect phrase number ${i} when I talk`,
    naturalPhrase: `A much more natural version of that long phrase number ${i} would be this`,
    rule: "long phrasing habit",
  }));
  const tight = mergeCorrections([], long);
  const text = formatCorrectionMemo(tight);
  assert.ok(text.length <= CORRECTION_MEMO_MAX_CHARS, `memo was ${text.length} chars`);
  assert.ok(estimateMemoTokens(text) <= 300, `est tokens ${estimateMemoTokens(text)}`);
  assert.match(text, new RegExp(CORRECTION_MEMO_HEADING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("shouldReinjectMemo fires on change or compression, not on an empty or identical recent list", () => {
  const items: CallCorrection[] = [{ myPhrase: "goed", naturalPhrase: "went" }];
  const sig = memoSignature(items);
  assert.equal(
    shouldReinjectMemo({ items: [], lastSentSignature: "", lastSentAtMs: 0, nowMs: 1, compressed: false }),
    false,
  );
  assert.equal(
    shouldReinjectMemo({ items, lastSentSignature: "", lastSentAtMs: 0, nowMs: 1, compressed: false }),
    true,
  );
  assert.equal(
    shouldReinjectMemo({
      items,
      lastSentSignature: sig,
      lastSentAtMs: 10_000,
      nowMs: 11_000,
      compressed: false,
    }),
    false,
  );
  assert.equal(
    shouldReinjectMemo({
      items,
      lastSentSignature: sig,
      lastSentAtMs: 10_000,
      nowMs: 11_000,
      compressed: true,
    }),
    true,
  );
  // Resume is a new Live RPC: force re-inject even if the same note was sent on the previous socket.
  assert.equal(
    shouldReinjectMemo({
      items,
      lastSentSignature: sig,
      lastSentAtMs: 10_000,
      nowMs: 11_000,
      compressed: false,
      reason: "resume",
    }),
    true,
  );
});

test("detectCompression looks for a sharp drop from near the 12k trigger toward the 6k target", () => {
  assert.equal(detectCompression(11_800, 6_200), true);
  assert.equal(detectCompression(4_000, 4_500), false);
  assert.equal(detectCompression(9_000, 8_700), false);
  assert.equal(detectCompression(0, 6_000), false);
});

test("appendMemoToSystemPrompt adds a replaceable block and leaves the prompt alone when empty", () => {
  const base = "You are a tutor.";
  assert.equal(appendMemoToSystemPrompt(base, []), base);
  const once = appendMemoToSystemPrompt(base, [{ myPhrase: "goed", naturalPhrase: "went" }]);
  assert.match(once, /\[Call corrections this session\]/);
  assert.match(once, /"goed" -> "went"/);
  const twice = appendMemoToSystemPrompt(once, [
    { myPhrase: "goed", naturalPhrase: "went" },
    { myPhrase: "I go", naturalPhrase: "I went" },
  ]);
  assert.equal(twice.split("[Call corrections this session]").length, 2);
  assert.match(twice, /"I go" -> "I went"/);
});
