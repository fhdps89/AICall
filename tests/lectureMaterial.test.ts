import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import {
  sanitizeLectureInputs,
  applyModelScriptToInputs,
  introLine,
  openingLine,
  buildLectureSpeechPlan,
  trimItemsToBudget,
  estimatePlanDurationSec,
  LECTURE_MAX_SEC,
  PRACTICE_OUTRO,
  type LectureMistakeInput,
  type LectureScriptItem,
} from '../server/lectureMaterial.ts';
import { DATA_DIR, startLectureJob, readLectureState, sanitizeLectureScriptPayload } from '../server/lecture.ts';

const LECTURE_DATE = '2026-11-22';

function input(partial: Partial<LectureMistakeInput> & { id: string }): LectureMistakeInput {
  return {
    myPhrase: `my-${partial.id}`,
    naturalPhrase: `nat-${partial.id}`,
    reason: '시제',
    ...partial,
  };
}

function scriptItem(partial: Partial<LectureScriptItem> & { mistakeId: string }): LectureScriptItem {
  return {
    kind: 'new',
    myPhrase: `my-${partial.mistakeId}`,
    naturalPhrase: `nat-${partial.mistakeId}`,
    explanation: '이유는 이렇습니다.',
    dialogue: [
      { speaker: 'Partner', line: 'How was it?' },
      { speaker: 'Coach', line: `nat-${partial.mistakeId}` },
    ],
    meaningKo: '뜻',
    answerEnglish: `nat-${partial.mistakeId}`,
    similarExample: 'I went there yesterday.',
    ...partial,
  };
}

test('sanitizeLectureInputs: non-arrays, QA, missing fields, caps, createdAt, overlap', () => {
  assert.deepEqual(sanitizeLectureInputs(null, undefined), { newList: [], reviewList: [] });
  const long = 'x'.repeat(700);
  const got = sanitizeLectureInputs(
    [
      { id: 'qa', myPhrase: 'a', naturalPhrase: 'b', source: 'qa', createdAt: '2026-11-21T00:00:00Z' },
      { id: 'ok', myPhrase: 'I go', naturalPhrase: 'I went', reason: long, createdAt: '2026-11-21T12:00:00Z', lessonTitle: '여행 1과' },
      { id: 'bad-date', myPhrase: 'a', naturalPhrase: 'b', createdAt: 'not-a-date' },
      { id: '', myPhrase: 'a', naturalPhrase: 'b' },
      { id: 'no-phrase', myPhrase: '', naturalPhrase: 'b' },
    ],
    [
      { id: 'ok', myPhrase: 'I go', naturalPhrase: 'I went' },
      { id: 'rev', myPhrase: 'c', naturalPhrase: 'd', createdAt: '2026-11-01T00:00:00Z' },
    ]
  );
  assert.deepEqual(got.newList.map((x) => x.id), ['ok', 'bad-date']);
  assert.equal(got.newList[0].createdAt, '2026-11-21T12:00:00Z');
  assert.equal(got.newList[0].lessonTitle, '여행 1과');
  assert.equal(got.newList[0].reason?.length, 600);
  assert.equal(got.newList[1].createdAt, undefined);
  assert.deepEqual(got.reviewList.map((x) => x.id), ['rev']);
});

test('applyModelScriptToInputs: keeps input phrases/kind/order, drops unknown ids, fills gaps', () => {
  const newList = [
    input({ id: 'n1', myPhrase: 'I go', naturalPhrase: 'I went', createdAt: '2026-11-21T15:00:00Z', lessonTitle: '조선소' }),
    input({ id: 'n2', myPhrase: 'cheap', naturalPhrase: 'affordable', reason: '어휘' }),
  ];
  const reviewList = [input({ id: 'r1', myPhrase: 'fix it', naturalPhrase: 'look into it' })];
  const parsed = [
    {
      mistakeId: 'r1',
      kind: 'new',
      myPhrase: 'MODEL CHANGED',
      naturalPhrase: 'nope',
      answerEnglish: 'nope',
      explanation: '복습 설명',
      meaningKo: '고치다',
      similarExample: 'Could you look into this?',
      dialogue: [{ speaker: 'Partner', line: 'Sure' }],
    },
    { mistakeId: 'unknown', myPhrase: 'invented', naturalPhrase: 'x', explanation: 'x', meaningKo: 'x', dialogue: [] },
    {
      mistakeId: 'n1',
      kind: 'review',
      myPhrase: 'wrong',
      naturalPhrase: 'wrong',
      explanation: '새 설명',
      meaningKo: '갔다',
      similarExample: 'She went home.',
      dialogue: [{ speaker: 'Coach', line: 'I went' }, { speaker: 'Partner', line: 'Nice' }],
    },
    { mistakeId: 'n1', explanation: 'duplicate should be ignored' },
  ];
  const { items, matched } = applyModelScriptToInputs(newList, reviewList, parsed);
  assert.equal(matched, 2);
  assert.deepEqual(items.map((i) => i.mistakeId), ['n1', 'n2', 'r1']);
  assert.equal(items[0].kind, 'new');
  assert.equal(items[0].myPhrase, 'I go');
  assert.equal(items[0].naturalPhrase, 'I went');
  assert.equal(items[0].answerEnglish, 'I went');
  assert.equal(items[0].explanation, '새 설명');
  assert.equal(items[0].sourceDateKst, '2026-11-22');
  assert.equal(items[0].lessonTitle, '조선소');
  // n2 was omitted by the model
  assert.equal(items[1].explanation, '어휘');
  assert.deepEqual(items[1].dialogue, []);
  assert.equal(items[1].meaningKo, '');
  assert.equal(items[1].myPhrase, 'cheap');
  assert.equal(items[2].kind, 'review');
  assert.equal(items[2].myPhrase, 'fix it');
  assert.equal(applyModelScriptToInputs(newList, [], []).matched, 0);
  assert.equal(applyModelScriptToInputs(newList, [], null).matched, 0);
});

test('introLine follows source date and never says last night for review', () => {
  const p = (kind: 'new' | 'review', date?: string) =>
    introLine({ kind, myPhrase: 'I go', sourceDateKst: date }, LECTURE_DATE);
  assert.equal(p('review', '2026-11-21'), '복습 표현이에요. 11월 21일에 하신 말은 "I go" 였어요.');
  assert.equal(p('review', '2026-11-21').includes('어젯밤'), false);
  assert.equal(p('new', '2026-11-21'), '새 표현이에요. 어젯밤 하신 말은 "I go" 였어요.');
  assert.equal(p('new', '2026-11-22'), '새 표현이에요. 오늘 하신 말은 "I go" 였어요.');
  assert.equal(p('new', '2026-11-20'), '새 표현이에요. 11월 20일에 하신 말은 "I go" 였어요.');
  for (const date of [undefined, 'nope', '2026-11-23']) {
    const line = p('new', date);
    assert.equal(line, '새 표현이에요. 하신 말은 "I go" 였어요.');
    assert.equal(line.includes('어젯밤'), false);
    assert.equal(line.includes('오늘'), false);
  }
});

test('openingLine uses real dates, topics, and counts; never hardcodes yesterday', () => {
  const yesterday = openingLine(
    [
      { kind: 'new', sourceDateKst: '2026-11-21', lessonTitle: '여행 1과' },
      { kind: 'new', sourceDateKst: '2026-11-21', lessonTitle: '여행 1과' },
      { kind: 'review', sourceDateKst: '2026-11-10', lessonTitle: '여행 1과' },
    ],
    LECTURE_DATE
  );
  assert.equal(yesterday, '찬식님, 좋은 아침이에요. 어제 여행 1과 수업에서 나온 새 표현 2개와 복습 표현 1개를 함께 볼게요.');

  const today = openingLine(
    [{ kind: 'new', sourceDateKst: '2026-11-22', lessonTitle: '필리조선소 4과' }],
    LECTURE_DATE
  );
  assert.equal(today, '찬식님, 좋은 아침이에요. 오늘 필리조선소 4과 수업에서 나온 표현 1개를 함께 볼게요.');

  const mixed = openingLine(
    [
      { kind: 'new', sourceDateKst: '2026-11-21', lessonTitle: '여행 1과' },
      { kind: 'new', sourceDateKst: '2026-11-22', lessonTitle: '필리조선소 4과' },
    ],
    LECTURE_DATE
  );
  assert.equal(mixed.includes('어제'), false);
  assert.equal(mixed, '찬식님, 좋은 아침이에요. 여러 수업에서 나온 표현 2개를 함께 볼게요.');

  const noTopic = openingLine([{ kind: 'new', sourceDateKst: '2026-11-21' }], LECTURE_DATE);
  assert.equal(noTopic, '찬식님, 좋은 아침이에요. 어제 나온 표현 1개를 함께 볼게요.');

  const reviewOnly = openingLine([{ kind: 'review', sourceDateKst: '2026-11-10' }], LECTURE_DATE);
  assert.equal(reviewOnly, '찬식님, 좋은 아침이에요. 복습할 표현 1개를 함께 볼게요.');
});

test('buildLectureSpeechPlan: example, skip empty dialogue/meaning, no you-said claim when empty, closing outro', () => {
  const empty = buildLectureSpeechPlan('제목', [], '코치 한마디', LECTURE_DATE);
  const emptyText = empty.filter((s) => s.kind === 'speech').map((s) => s.text).join('\n');
  assert.equal(emptyText.includes('하신 말'), false);
  assert.ok(emptyText.includes(PRACTICE_OUTRO));

  const item = scriptItem({
    mistakeId: 'n1',
    sourceDateKst: '2026-11-21',
    similarExample: 'She went to the office.',
    dialogue: [],
    meaningKo: '',
    explanation: '과거 시제를 씁니다.',
  });
  const plan = buildLectureSpeechPlan('제목', [item], '일요일 코칭', LECTURE_DATE);
  const texts = plan.filter((s) => s.kind === 'speech').map((s) => s.text);
  assert.equal(texts[0].includes('찬식님, 좋은 아침이에요.'), true);
  assert.equal(texts[1].includes('비슷한 예로, She went to the office.'), true);
  assert.equal(texts[1].includes('짧은 대화로'), false);
  assert.equal(texts[1].includes('한국어 뜻은 ""'), false);
  assert.equal(texts[1].includes('자연스러운 표현을 영어로 말해 보세요.'), true);
  assert.equal(texts.at(-1)?.includes('오늘의 코치 한마디. 일요일 코칭'), true);
  assert.equal(texts.at(-1)?.includes(PRACTICE_OUTRO), true);
  assert.equal(texts.length, 4); // opening, body, answer, closing
});

test('trimItemsToBudget drops review before new and never shortens kept explanations or examples', () => {
  const longExplain = '이 규칙이 필요한 이유입니다. '.repeat(40);
  const example = 'This is a complete similar example that must stay intact.';
  const items: LectureScriptItem[] = [
    scriptItem({ mistakeId: 'n1', kind: 'new', explanation: longExplain, similarExample: example }),
    scriptItem({ mistakeId: 'n2', kind: 'new', explanation: longExplain, similarExample: example }),
    scriptItem({ mistakeId: 'r1', kind: 'review', explanation: longExplain, similarExample: example }),
    scriptItem({ mistakeId: 'r2', kind: 'review', explanation: longExplain, similarExample: example }),
  ];
  const fitted = trimItemsToBudget(items, LECTURE_DATE, '제목', '코치', 40);
  assert.ok(fitted.length >= 1 && fitted.length < items.length);
  assert.equal(fitted.some((it) => it.kind === 'review'), false);
  for (const it of fitted) {
    assert.equal(it.explanation, longExplain);
    assert.equal(it.similarExample, example);
  }
});

test('trimItemsToBudget keeps a single item even if it still exceeds the cap, and does not drop when under 10 minutes', () => {
  const one = [
    scriptItem({
      mistakeId: 'n1',
      explanation: '아주 긴 설명입니다. '.repeat(80),
      similarExample: 'A very long similar example remains. '.repeat(10),
    }),
  ];
  const kept = trimItemsToBudget(one, LECTURE_DATE, '제목', '', 5);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].explanation, one[0].explanation);
  assert.equal(kept[0].similarExample, one[0].similarExample);

  const short = [
    scriptItem({ mistakeId: 'n1', explanation: '짧습니다.', similarExample: 'I went.' }),
    scriptItem({ mistakeId: 'r1', kind: 'review', explanation: '짧습니다.', similarExample: 'I went.' }),
  ];
  const under = trimItemsToBudget(short, LECTURE_DATE, '제목', '코치');
  assert.equal(under.length, 2);
  assert.ok(estimatePlanDurationSec(buildLectureSpeechPlan('제목', under, '코치', LECTURE_DATE)) <= LECTURE_MAX_SEC);
});

test('sanitizeLectureScriptPayload keeps a valid sourceDateKst and drops a bad one', () => {
  const ok = sanitizeLectureScriptPayload({
    title: 't',
    coachNote: 'c',
    script: [
      {
        mistakeId: 'm1',
        kind: 'new',
        myPhrase: 'I go',
        naturalPhrase: 'I went',
        explanation: '시제',
        dialogue: [],
        meaningKo: '갔다',
        answerEnglish: 'I went',
        sourceDateKst: '2026-11-21',
        similarExample: 'She went.',
        lessonTitle: '여행 1과',
      },
    ],
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.payload.script[0].sourceDateKst, '2026-11-21');
    assert.equal(ok.payload.script[0].similarExample, 'She went.');
    assert.equal(ok.payload.script[0].lessonTitle, '여행 1과');
  }
  const bad = sanitizeLectureScriptPayload({
    script: [
      {
        mistakeId: 'm1',
        myPhrase: 'I go',
        naturalPhrase: 'I went',
        sourceDateKst: '11/21',
      },
    ],
  });
  assert.equal(bad.ok, true);
  if (bad.ok) assert.equal(bad.payload.script[0].sourceDateKst, undefined);
});

test('startLectureJob with only QA or empty candidates is NOTHING_TO_TEACH and does not run the job', () => {
  const uid = `test_nothing_${process.pid}`;
  const date = '2026-11-22';
  const ai = {} as GoogleGenAI;
  let calls = 0;
  try {
    for (const payload of [
      { newMistakes: [], reviewMistakes: [] },
      {
        newMistakes: [{ id: 'qa', myPhrase: 'I go', naturalPhrase: 'I went', source: 'qa' }],
        reviewMistakes: [],
      },
    ]) {
      calls = 0;
      const st = startLectureJob(ai, uid, date, payload.newMistakes as any, payload.reviewMistakes as any, {
        force: true,
        runJobFn: async () => {
          calls += 1;
        },
      });
      assert.equal(st.status, 'failed');
      assert.equal(st.error, 'NOTHING_TO_TEACH');
      assert.equal(calls, 0);
      assert.equal(readLectureState(uid, date)?.error, 'NOTHING_TO_TEACH');
    }
  } finally {
    fs.rmSync(path.join(DATA_DIR, 'lectures', uid), { recursive: true, force: true });
  }
});
