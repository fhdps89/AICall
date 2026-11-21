import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FILLER_WORDS,
  MIN_SPEECH_CHARS,
  MIN_SPEECH_WORDS,
  decideSttSource,
  hasLearnerSpeech,
  stripTimeHeaders,
} from "../src/services/review/speechCheck.ts";
import { isEmptyReview } from "../src/services/review/reviewView.ts";

test("speech thresholds and filler list are defined", () => {
  assert.equal(MIN_SPEECH_WORDS, 3);
  assert.equal(MIN_SPEECH_CHARS, 8);
  assert.equal(FILLER_WORDS.has("uh"), true);
  assert.equal(FILLER_WORDS.has("음"), true);
});

test("stripTimeHeaders removes [mm:ss - mm:ss] minute headers cleanly", () => {
  assert.equal(stripTimeHeaders(""), "");
  assert.equal(stripTimeHeaders("[00:00 - 01:00] "), "");
  assert.equal(stripTimeHeaders("[00:00 - 01:00] Hello world"), "Hello world");
  assert.equal(
    stripTimeHeaders("[00:00 - 01:00] Hello\n\n[01:00 - 02:00] world"),
    "Hello\n\nworld"
  );
  assert.equal(stripTimeHeaders("[00:00 - 01:00] \n\n[01:00 - 02:00] "), "");
});

test("hasLearnerSpeech rejects empty, whitespace, headers, sound tags, and short fillers", () => {
  assert.equal(hasLearnerSpeech(""), false);
  assert.equal(hasLearnerSpeech("   \n\t  "), false);
  assert.equal(hasLearnerSpeech("[00:00 - 01:00]"), false);
  assert.equal(hasLearnerSpeech("[00:00 - 01:00] "), false);
  assert.equal(hasLearnerSpeech("[noise]"), false);
  assert.equal(hasLearnerSpeech("(silence)"), false);
  assert.equal(hasLearnerSpeech("[music] <unk> (laughter)"), false);
  assert.equal(hasLearnerSpeech("[00:00 - 01:00] [noise] (silence) <unk>"), false);
  assert.equal(hasLearnerSpeech("uh"), false);
  assert.equal(hasLearnerSpeech("um... ah."), false);
  // 3 short words under 8 chars total
  assert.equal(hasLearnerSpeech("I go to"), false);
  assert.equal(hasLearnerSpeech("hi ok no"), false);
  // 2 words even if >= 8 chars
  assert.equal(hasLearnerSpeech("hello everybody"), false);
  // numbers and punctuation only
  assert.equal(hasLearnerSpeech("123 456 7890 ... ???"), false);
  // header + empty transcripts
  assert.equal(hasLearnerSpeech("[00:00 - 01:00] \n\n[01:00 - 02:00] "), false);
});

test("hasLearnerSpeech rejects repeated fillers alone and accepts fillers mixed with a real sentence", () => {
  assert.equal(hasLearnerSpeech("uh uh uh uh"), false);
  assert.equal(hasLearnerSpeech("um uh hmm yeah okay"), false);
  assert.equal(hasLearnerSpeech("UH UM HMM ER AH OH"), false);
  assert.equal(hasLearnerSpeech("음 어 음 어"), false);
  assert.equal(hasLearnerSpeech("아 으 어 음 응 에"), false);
  assert.equal(hasLearnerSpeech("uh I go"), false);

  assert.equal(hasLearnerSpeech("Um, uh, I went to the park yesterday"), true);
  assert.equal(hasLearnerSpeech("Uh yeah I like apples"), true);
  assert.equal(hasLearnerSpeech("음 어 오늘 날씨가 좋아요"), true);
  assert.equal(hasLearnerSpeech("어, 저는 오늘 영어를 공부했어요"), true);
});

test("hasLearnerSpeech accepts English 3+ word sentences and Korean sentences >= 8 chars", () => {
  assert.equal(hasLearnerSpeech("I like apples"), true);
  assert.equal(hasLearnerSpeech("I'm going home"), true);
  assert.equal(hasLearnerSpeech("오늘 날씨가 좋아요"), true);
  assert.equal(hasLearnerSpeech("저는 오늘 영어를 공부했어요"), true);
  assert.equal(
    hasLearnerSpeech("[00:00 - 01:00] I went to the park yesterday"),
    true
  );
  assert.equal(
    hasLearnerSpeech("[00:00 - 01:00] [noise] Well, I think that works"),
    true
  );
});

test("decideSttSource uses finalText when it contains learner speech and preserves finalSource", () => {
  const decided = decideSttSource({
    finalText: "I went to the grocery store yesterday.",
    partials: [
      { minuteIndex: 0, timeRange: "00:00 - 01:00", transcript: "fallback text here" },
    ],
    liveTranscript: [{ role: "user", text: "live fallback text here" }],
  });
  assert.deepEqual(decided, {
    text: "I went to the grocery store yesterday.",
    source: "sttFinal",
  });

  const partialMerged = decideSttSource({
    finalText: "I went to the grocery store yesterday.",
    finalSource: "sttPartial_fallback",
  });
  assert.deepEqual(partialMerged, {
    text: "I went to the grocery store yesterday.",
    source: "sttPartial_fallback",
  });
});

test("decideSttSource returns none when final is missing and sttPartial has only empty transcripts", () => {
  const decided = decideSttSource({
    finalText: "",
    partials: [
      { minuteIndex: 0, timeRange: "00:00 - 01:00", transcript: "" },
      { minuteIndex: 1, timeRange: "01:00 - 02:00", transcript: "   " },
    ],
    liveTranscript: [],
  });
  assert.deepEqual(decided, { text: "", source: "none" });
});

test("decideSttSource falls back to sttPartial when partials contain real speech and ignores time headers", () => {
  const decided = decideSttSource({
    finalText: "[noise]",
    partials: [
      { minuteIndex: 1, timeRange: "01:00 - 02:00", transcript: "and then I went home" },
      { minuteIndex: 0, timeRange: "00:00 - 01:00", transcript: "" },
    ],
    liveTranscript: [{ role: "user", text: "should not be chosen first" }],
  });
  assert.deepEqual(decided, {
    text: "[00:00 - 01:00] \n\n[01:00 - 02:00] and then I went home",
    source: "sttPartial_fallback",
  });
});

test("decideSttSource skips noise partials and uses liveTranscript user turns", () => {
  const decided = decideSttSource({
    finalText: "uh",
    partials: [
      { minuteIndex: 0, timeRange: "00:00 - 01:00", transcript: "[noise] (silence)" },
    ],
    liveTranscript: [
      { role: "model", text: "Hello! How was your weekend?" },
      { role: "user", text: "I visited my family in Busan." },
    ],
  });
  assert.deepEqual(decided, {
    text: "I visited my family in Busan.",
    source: "liveTranscript_fallback",
  });
});

test("decideSttSource returns none for tutor-only calls with no learner speech in any source", () => {
  const decided = decideSttSource({
    finalText: "[noise] uh",
    partials: [
      { minuteIndex: 0, timeRange: "00:00 - 01:00", transcript: "(silence)" },
    ],
    liveTranscript: [
      { role: "model", text: "Hi! Are you there? Can you hear me today?" },
      { role: "model", text: "Looks like there is no audio on your side." },
    ],
  });
  assert.deepEqual(decided, { text: "", source: "none" });
});

test("isEmptyReview also treats short or noise sttFinal transcripts as empty when transcript is provided", () => {
  assert.equal(isEmptyReview({ lessonAdvanced: true }, "sttFinal", "uh"), true);
  assert.equal(
    isEmptyReview({ lessonAdvanced: true }, "sttPartial_fallback", "[00:00 - 01:00] "),
    true
  );
  assert.equal(
    isEmptyReview(
      { lessonAdvanced: true },
      "sttFinal",
      "I went to the park yesterday."
    ),
    false
  );
  assert.equal(isEmptyReview({ lessonAdvanced: true }, "sttFinal"), false);
});
