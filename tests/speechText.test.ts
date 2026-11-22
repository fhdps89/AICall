import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripSpeechDirections,
  cleanLectureScriptItem,
  type LectureScriptItemLike,
} from '../server/speechText.ts';

const STRIP_CASES: readonly [string, string, string][] = [
  ['S1', '(pause)', ''],
  ['S2', 'Hello. (pause) Nice to meet you.', 'Hello. Nice to meet you.'],
  ['S3', '(3초 무음)', ''],
  ['S4', '정답을 떠올려 보세요. (3초 무음은 시스템이 넣음)', '정답을 떠올려 보세요.'],
  ['S5', '[Coach smiles] Great job!', 'Great job!'],
  ['S6', 'Narrator: The coach explains.', ''],
  ['S7', 'Narrator: The coach explains.\nCoach: Hello.', 'Coach: Hello.'],
  ['S8', '**굵게** 말해요', '굵게 말해요'],
  ['S9', '*기울임* 표현', '기울임 표현'],
  ['S10', '`코드` 예시', '코드 예시'],
  ['S11', 'Coach (smiling): Hi there.', 'Coach: Hi there.'],
  ['S12', 'Partner: (laughs)', ''],
  ['S13', 'Say cheerfully: Hello!', 'Hello!'],
  ['S14', '## 오늘의 표현', '오늘의 표현'],
  ['S15', '((pause))', ''],
];

const KEEP_CASES: readonly [string, string, string][] = [
  ['K1', 'thank you (감사합니다)', 'thank you (감사합니다)'],
  ['K2', '자연스러운 표현은 I work for (소속) 입니다.', '자연스러운 표현은 I work for (소속) 입니다.'],
  ['K3', 'Coach: Hello.', 'Coach: Hello.'],
  ['K4', 'Partner: Hi.', 'Partner: Hi.'],
  ['K5', 'I work for Hanwha Ocean in Korea', 'I work for Hanwha Ocean in Korea'],
  ['K6', 'Hello  world', 'Hello  world'],
  ['K7', '5 * 3 = 15', '5 * 3 = 15'],
  ['K8', '일시정지 (pause)', '일시정지'],
  ['K9', 'the 1990s (1990s)', 'the 1990s (1990s)'],
  ['K10', '쉼표 (쉼표)', '쉼표 (쉼표)'],
];

const EMPTY_CASES: readonly [string, string, string][] = [
  ['E1', '', ''],
  ['E2', '   \n\t ', ''],
  ['E3', 'Coach: 안녕하세요.\n(pause)\n\nPartner: Hi.', 'Coach: 안녕하세요.\nPartner: Hi.'],
  ['E4', '[music]\n(3초 무음)', ''],
];

test('stripSpeechDirections strips directions, markdown, and narrator lines (S1–S15) idempotently', () => {
  for (const [id, input, expected] of STRIP_CASES) {
    const out = stripSpeechDirections(input);
    assert.equal(out, expected, `${id}: strip mismatch`);
    assert.equal(stripSpeechDirections(out), out, `${id}: not idempotent`);
  }
});

test('stripSpeechDirections preserves normal speech and non-direction parens (K1–K10) idempotently', () => {
  for (const [id, input, expected] of KEEP_CASES) {
    const out = stripSpeechDirections(input);
    assert.equal(out, expected, `${id}: keep mismatch`);
    assert.equal(stripSpeechDirections(out), out, `${id}: not idempotent`);
  }
});

test('stripSpeechDirections handles empty input and cleans blank lines (E1–E4) idempotently', () => {
  for (const [id, input, expected] of EMPTY_CASES) {
    const out = stripSpeechDirections(input);
    assert.equal(out, expected, `${id}: empty/line mismatch`);
    assert.equal(stripSpeechDirections(out), out, `${id}: not idempotent`);
  }
});

test('cleanLectureScriptItem strips direction fields while preserving myPhrase and metadata (C1–C6)', () => {
  type FullItem = LectureScriptItemLike & {
    mistakeId: string;
    kind: 'new' | 'review';
    myPhrase: string;
    startSec: number;
  };

  const base: FullItem = {
    mistakeId: 'm1',
    kind: 'new',
    myPhrase: 'I go (pause) **home**',
    naturalPhrase: 'work for (소속)',
    explanation: '(pause) 과거시제를 써요.',
    dialogue: [
      { speaker: 'Partner', line: 'Partner: Hi' },
      { speaker: 'Coach', line: '(laughs)' },
    ],
    meaningKo: '[warmly] 집에 갔다',
    answerEnglish: '*I went home*',
    startSec: 12.5,
  };

  const cleaned = cleanLectureScriptItem(base);

  // C1: myPhrase preserved byte-for-byte
  assert.equal(cleaned.myPhrase, 'I go (pause) **home**');
  // C2: naturalPhrase, mistakeId, kind, startSec preserved
  assert.equal(cleaned.naturalPhrase, 'work for (소속)');
  assert.equal(cleaned.mistakeId, 'm1');
  assert.equal(cleaned.kind, 'new');
  assert.equal(cleaned.startSec, 12.5);
  // C3: explanation stripped
  assert.equal(cleaned.explanation, '과거시제를 써요.');
  // C4: dialogue strips duplicate speaker label and drops empty lines
  assert.deepEqual(cleaned.dialogue, [{ speaker: 'Partner', line: 'Hi' }]);
  // meaningKo stripped
  assert.equal(cleaned.meaningKo, '집에 갔다');
  // C5: answerEnglish stripped
  assert.equal(cleaned.answerEnglish, 'I went home');

  // C6: empty answerEnglish after strip falls back to naturalPhrase
  const fallback = cleanLectureScriptItem({
    ...base,
    naturalPhrase: 'I went home',
    answerEnglish: '(pause)',
  });
  assert.equal(fallback.answerEnglish, 'I went home');
});
