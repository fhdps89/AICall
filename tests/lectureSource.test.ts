import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUtterance,
  buildUserCorpus,
  verifyAgainstTranscript,
  isEligibleLectureSession,
  extractReviewLectureItems,
  planBackfill,
  collectNewLectureItems,
  backfillDocId,
  type SessionSourceLike,
} from '../src/services/lecture/lectureSource.ts';
import { SHORT_SESSION_SEC } from '../src/services/lecture/lecturePick.ts';

const CUTOFF = Date.parse('2026-11-21T01:00:00.000Z'); // 10:00 KST 11/21

const OWNER: SessionSourceLike = {
  id: 'call-1795270951478',
  startedAt: '2026-11-21T14:22:32Z',
  endedAt: '2026-11-21T14:28:41Z',
  source: 'call',
  lessonTitle: 'USA: immigration at Philadelphia airport',
  sttFinal: {
    transcript:
      "Okay, here you are. This is my passport. I'm here for my business trip. For five days until until Friday. On Friday, I will I will come to my country and I'll stay at the hotel. The hotel name is what? Marriott. Element Hotel in Philadelphia downtown. Okay, this is my reservation. This is my reservation ticket. Yeah, I'm working on Hanwha Ocean in Korea and I'll I have a business meeting with Philadelphia Philly Shipyard. Uh, no, no, Hanwha Philly Shipyard. Yeah. Yeah, uh David Kim, uh the head",
  },
  sttPartial: [
    { transcript: "Okay, here you are. This is my passport. I'm here for my business trip. For five days until until Friday. On Friday, I will I will come to my country and I'll stay at the hotel. The hotel name is what? Marriott." },
    { transcript: "Element Hotel in Philadelphia downtown. Okay, this is my reservation. This is my reservation ticket. Yeah, I'm working on Hanwha Ocean in Korea and I'll I have a business meeting with Philadelphia Philly Shipyard. Uh, no, no, Hanwha Philly Shipyard. Yeah." },
    { transcript: "Yeah, uh David Kim, uh the head of uh what? Uh the head of finance team. Yes, David Kim is David Kim of Hanwha Phillips-Medisense is my main contact partner. Yeah, let me see. I I wrote I wrote the address" },
    { transcript: "in my phone. Yes, here you are. Okay, thank you. But could you give me some more questions? Uh this is too short in 3 minutes. Oh no, I just have I just carried I'm I just have carrying I'm carrying the notebook" },
    { transcript: "and some clothes. Yeah, I have just uh $200. No, no. Just notebook uh my work my work for my work. Yes, I I have been in uh Los Angeles uh when I was 17 years old. And oh yes, two years ago I've been Hawaii." },
  ],
  liveTranscript: [
    { role: 'user', text: 'Okay, here you are. This is my passport.' },
    { role: 'model', text: 'What is the purpose of your visit?' },
    { role: 'user', text: 'Ahm here. For my business trip.' },
    { role: 'user', text: 'On Friday I will I will come to my country.' },
    { role: 'user', text: "I wrote the address in my phone. Yes, here you are." },
    { role: 'user', text: "two years ago I've been Hawaii." },
  ],
  review: {
    mistakesSaved: true,
    mistakes: [
      { myPhrase: "I'm here for my business trip.", naturalPhrase: "I'm here on a business trip.", reason: '전치사' },
      { id: '1tTjWrskCDWqZzEpvXnv', myPhrase: 'On Friday, I will I will come to my country', naturalPhrase: "I'll be returning to my home country on Friday", reason: 'will 반복, come' },
      { myPhrase: "I'm working on Hanwha Ocean in Korea", naturalPhrase: 'I work at Hanwha Ocean in Korea', reason: 'work at' },
      { myPhrase: 'is my main contact partner.', naturalPhrase: 'He is my main contact.', reason: 'partner' },
      { myPhrase: 'I wrote the address in my phone.', naturalPhrase: 'I have the address on my phone.', reason: 'on my phone' },
      { myPhrase: "two years ago I've been Hawaii.", naturalPhrase: "I went to Hawaii two years ago.", reason: 'been to' },
    ],
  },
};

test('normalizeUtterance collapses case, punctuation, and quotes', () => {
  assert.equal(normalizeUtterance("  On Friday, I will I will come to my country. "), 'on friday i will i will come to my country');
});

test('verifyAgainstTranscript accepts the six review phrases and rejects an invented sentence', () => {
  const corpus = buildUserCorpus(OWNER);
  const phrases = (OWNER.review?.mistakes || []).map((m) => m.myPhrase as string);
  for (const p of phrases) {
    const got = verifyAgainstTranscript(p, corpus);
    assert.equal(got.ok, true, `expected to find: ${p} (score=${got.score})`);
  }
  const invented = verifyAgainstTranscript('Yesterday I go to the office and check the safety gear', corpus);
  assert.equal(invented.ok, false);
  const short = verifyAgainstTranscript('Hi', corpus);
  assert.equal(short.ok, false);
});

test('extractReviewLectureItems drops hidden items and keeps the six visible review mistakes', () => {
  const hidden = {
    ...OWNER,
    review: {
      mistakes: [
        ...(OWNER.review?.mistakes || []),
        { myPhrase: 'this was hidden', naturalPhrase: 'This was hidden.', hidden: true },
      ],
    },
  };
  const items = extractReviewLectureItems(hidden);
  assert.equal(items.length, 6);
  assert.equal(items.some((i) => i.myPhrase === 'this was hidden'), false);
  assert.equal(items[1].id, '1tTjWrskCDWqZzEpvXnv');
  assert.equal(items[0].id, backfillDocId('call-1795270951478', 0));
  assert.equal(items[0].lessonTitle, 'USA: immigration at Philadelphia airport');
});

test('isEligibleLectureSession: short, QA, before cutoff, or no review are excluded', () => {
  assert.equal(isEligibleLectureSession(OWNER, CUTOFF), true);
  assert.equal(
    isEligibleLectureSession({ ...OWNER, endedAt: '2026-11-21T00:30:00Z', startedAt: '2026-11-21T00:20:00Z' }, CUTOFF),
    false
  );
  assert.equal(isEligibleLectureSession({ ...OWNER, source: 'qa' }, CUTOFF), false);
  const shortEnd = '2026-11-21T14:24:00Z'; // 88s from 14:22:32
  assert.equal(
    isEligibleLectureSession({ ...OWNER, startedAt: '2026-11-21T14:22:32Z', endedAt: shortEnd }, CUTOFF),
    false
  );
  assert.ok(SHORT_SESSION_SEC === 180);
  assert.equal(isEligibleLectureSession({ ...OWNER, review: { mistakes: [] } }, CUTOFF), false);
});

test('planBackfill creates missing docs, links the already-saved phrase, and skips hidden', () => {
  const existing = [
    { id: '1tTjWrskCDWqZzEpvXnv', sessionId: 'call-1795270951478', myPhrase: 'On Friday, I will I will come to my country' },
  ];
  const plan = planBackfill('call-1795270951478', OWNER.review!.mistakes!, existing);
  assert.equal(plan.toCreate.length, 5);
  assert.equal(plan.toCreate.some((c) => c.item.myPhrase?.includes('On Friday')), false);
  const noIdReview = (OWNER.review?.mistakes || []).map((m, i) => (i === 1 ? { ...m, id: undefined } : m));
  const linked = planBackfill('call-1795270951478', noIdReview, existing);
  assert.ok(linked.idPatches.some((p) => p.id === '1tTjWrskCDWqZzEpvXnv'));
  assert.equal(linked.toCreate.length, 5);
  const withHidden = planBackfill(
    'call-1795270951478',
    [{ myPhrase: 'nope', naturalPhrase: 'Nope', hidden: true }],
    []
  );
  assert.equal(withHidden.toCreate.length, 0);
});

test('collectNewLectureItems uses only eligible session reviews, caps at 6, and does not pad', () => {
  const qaShort: SessionSourceLike = {
    id: 'call-qa',
    startedAt: '2026-11-21T13:30:43Z',
    endedAt: '2026-11-21T13:31:31Z',
    source: 'call',
    sttFinal: { transcript: 'industry in my city has moved to other countries' },
    review: {
      mistakes: [
        { myPhrase: 'industry in my city has moved to other countries', naturalPhrase: 'industries have moved overseas' },
      ],
    },
  };
  const items = collectNewLectureItems([OWNER, qaShort], CUTOFF);
  assert.equal(items.length, 6);
  assert.deepEqual(
    items.map((i) => i.myPhrase),
    (OWNER.review?.mistakes || []).map((m) => m.myPhrase)
  );
  assert.equal(collectNewLectureItems([], CUTOFF).length, 0);
});
