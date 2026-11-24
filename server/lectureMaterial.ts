/**
 * Pure lecture-script helpers: input sanitizing, model-output validation,
 * intro wording, speech plan, and a 10-minute spoken-length budget.
 */
import { kstDateOfIso, addDaysKst, formatLectureDuration } from '../src/services/lecture/lecturePick.ts';
export { formatLectureDuration };
import { stripSpeechDirections } from './speechText.ts';

export const MAX_NEW = 20;
export const MAX_REVIEW = 1;
export const MAX_DIALOGUE_LINES = 6;
export const MAX_EXTRA_EXAMPLES = 2;
export const LECTURE_MAX_SEC = 10 * 60;
/** Mixed Korean/English TTS pace used for the budget (chars / second). */
export const SPEECH_CHARS_PER_SEC = 10;
export const SILENCE_SEC = 3;

export const COACH_NOTE_FALLBACK = [
  '오늘 표현들을 끝까지 잘 따라오셨어요.',
  '틀린 표현은 실력이 자라고 있다는 신호예요.',
] as const;

export function splitKoreanSentences(text: string): string[] {
  const lines = String(text || '').split(/\r?\n+/);
  const out: string[] = [];
  const boundaryRe = /([가-힣)"'”’][.!?…。！？]+["'”’)\]]*)(?:\s+|$)/g;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    let last = 0;
    boundaryRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = boundaryRe.exec(line)) !== null) {
      const end = m.index + m[1].length;
      const part = line.slice(last, end).trim();
      if (part) out.push(part);
      last = m.index + m[0].length;
    }
    const tail = line.slice(last).trim();
    if (tail) out.push(tail);
  }
  return out;
}

export function normalizeCoachNote(raw: string): string {
  const cleaned = stripSpeechDirections(String(raw || ''));
  const sentences = splitKoreanSentences(cleaned).map((s) =>
    /[.!?…。！？]["'”’)\]]*$/.test(s) ? s : `${s}.`
  );
  if (sentences.length >= 2) return `${sentences[0]} ${sentences[1]}`;
  if (sentences.length === 1) {
    if (sentences[0] === COACH_NOTE_FALLBACK[1]) {
      return `${COACH_NOTE_FALLBACK[0]} ${sentences[0]}`;
    }
    return `${sentences[0]} ${COACH_NOTE_FALLBACK[1]}`;
  }
  return COACH_NOTE_FALLBACK.join(' ');
}

export interface LectureMistakeInput {
  id: string;
  myPhrase: string;
  naturalPhrase: string;
  reason?: string;
  createdAt?: string;
  lessonTitle?: string;
}

export interface LectureScriptItem {
  mistakeId: string;
  kind: 'new' | 'review';
  myPhrase: string;
  naturalPhrase: string;
  explanation: string;
  dialogue: { speaker: 'Coach' | 'Partner'; line: string }[];
  meaningKo: string;
  answerEnglish: string;
  similarExample?: string;
  extraExamples?: string[];
  sourceDateKst?: string;
  lessonTitle?: string;
  startSec?: number;
}

export type PlanSeg =
  | { kind: 'speech'; text: string; two: boolean; itemIndex?: number; role?: 'opening' | 'body' | 'answer' | 'closing' }
  | { kind: 'silence'; sec: number };

const MAX_PHRASE = 400;
const MAX_REASON = 600;
const MAX_TITLE = 80;

function asList(raw: unknown): any[] {
  return Array.isArray(raw) ? raw : [];
}

export function sanitizeLectureInputs(
  newRaw: unknown,
  reviewRaw: unknown
): { newList: LectureMistakeInput[]; reviewList: LectureMistakeInput[] } {
  const clean = (list: unknown, max: number) =>
    asList(list)
      .filter((m) => m && m.source !== 'qa')
      .filter((m) => m && typeof m.id === 'string' && m.id && m.myPhrase && m.naturalPhrase)
      .map((m) => {
        const item: LectureMistakeInput = {
          id: String(m.id),
          myPhrase: String(m.myPhrase).slice(0, MAX_PHRASE),
          naturalPhrase: String(m.naturalPhrase).slice(0, MAX_PHRASE),
          reason: String(m.reason || '').slice(0, MAX_REASON),
        };
        if (typeof m.createdAt === 'string' && Number.isFinite(Date.parse(m.createdAt))) {
          item.createdAt = m.createdAt;
        }
        if (typeof m.lessonTitle === 'string' && m.lessonTitle.trim()) {
          item.lessonTitle = String(m.lessonTitle).trim().slice(0, MAX_TITLE);
        }
        return item;
      })
      .slice(0, max);
  const newList = clean(newRaw, MAX_NEW);
  const newIds = new Set(newList.map((n) => n.id));
  // Filter overlap with new BEFORE slicing so an overlapping due item doesn't leave 0 reviews.
  const reviewList = clean(reviewRaw, Number.MAX_SAFE_INTEGER)
    .filter((r) => !newIds.has(r.id))
    .slice(0, MAX_REVIEW);
  return { newList, reviewList };
}

function firstById(parsedItems: unknown): Map<string, any> {
  const map = new Map<string, any>();
  if (!Array.isArray(parsedItems)) return map;
  for (const it of parsedItems) {
    if (!it || typeof it !== 'object') continue;
    const id = typeof it.mistakeId === 'string' ? it.mistakeId : '';
    if (!id || map.has(id)) continue;
    map.set(id, it);
  }
  return map;
}

export function applyModelScriptToInputs(
  newList: LectureMistakeInput[],
  reviewList: LectureMistakeInput[],
  parsedItems: unknown
): { items: LectureScriptItem[]; matched: number } {
  const model = firstById(parsedItems);
  const inputs: { src: LectureMistakeInput; kind: 'new' | 'review' }[] = [
    ...newList.map((src) => ({ src, kind: 'new' as const })),
    ...reviewList.map((src) => ({ src, kind: 'review' as const })),
  ];
  let matched = 0;
  const items: LectureScriptItem[] = inputs.map(({ src, kind }) => {
    const it = model.get(src.id);
    if (it) matched += 1;
    const dialogue = Array.isArray(it?.dialogue)
      ? it.dialogue.slice(0, MAX_DIALOGUE_LINES).flatMap((d: any) => {
          if (!d || typeof d !== 'object' || typeof d.line !== 'string') return [];
          const speaker = d.speaker === 'Partner' ? 'Partner' : 'Coach';
          return [{ speaker: speaker as 'Coach' | 'Partner', line: String(d.line) }];
        })
      : [];
    const extraExamples = Array.isArray(it?.extraExamples)
      ? it.extraExamples
          .slice(0, MAX_EXTRA_EXAMPLES)
          .filter((x: unknown): x is string => typeof x === 'string' && x.trim().length > 0)
          .map((x: string) => x.trim().slice(0, MAX_PHRASE))
      : undefined;
    return {
      mistakeId: src.id,
      kind,
      myPhrase: src.myPhrase,
      naturalPhrase: src.naturalPhrase,
      answerEnglish: src.naturalPhrase,
      explanation: it ? String(it.explanation || '') : String(src.reason || ''),
      dialogue: it ? dialogue : [],
      meaningKo: it ? String(it.meaningKo || '') : '',
      similarExample: it ? String(it.similarExample || '') : '',
      ...(extraExamples && extraExamples.length > 0 ? { extraExamples } : {}),
      sourceDateKst: kstDateOfIso(src.createdAt),
      lessonTitle: src.lessonTitle,
    };
  });
  return { items, matched };
}

function md(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}월 ${d}일`;
}

export function introLine(
  item: { kind: 'new' | 'review'; myPhrase: string; sourceDateKst?: string },
  lectureDateKst: string
): string {
  const label = item.kind === 'review' ? '복습 표현' : '새 표현';
  const date = item.sourceDateKst;
  const valid = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const yesterday = addDaysKst(lectureDateKst, -1);
  const quoted = `"${item.myPhrase}"`;
  if (item.kind === 'review' && valid && date <= lectureDateKst) {
    return `${label}이에요. ${md(date)}에 하신 말은 ${quoted} 였어요.`;
  }
  if (item.kind === 'new' && valid && date === yesterday) {
    return `${label}이에요. 어젯밤 하신 말은 ${quoted} 였어요.`;
  }
  if (item.kind === 'new' && valid && date === lectureDateKst) {
    return `${label}이에요. 오늘 하신 말은 ${quoted} 였어요.`;
  }
  if (item.kind === 'new' && valid && date < yesterday) {
    return `${label}이에요. ${md(date)}에 하신 말은 ${quoted} 였어요.`;
  }
  return `${label}이에요. 하신 말은 ${quoted} 였어요.`;
}

export function openingLine(
  items: { kind: 'new' | 'review'; sourceDateKst?: string; lessonTitle?: string }[],
  lectureDateKst: string
): string {
  const nNew = items.filter((i) => i.kind === 'new').length;
  const nReview = items.filter((i) => i.kind === 'review').length;
  const datedPool = (nNew ? items.filter((i) => i.kind === 'new') : items)
    .map((i) => i.sourceDateKst)
    .filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
  const uniqueDates = [...new Set(datedPool)];
  const yesterday = addDaysKst(lectureDateKst, -1);
  let when = '';
  if (uniqueDates.length === 1 && uniqueDates[0] === yesterday) when = '어제 ';
  else if (uniqueDates.length === 1 && uniqueDates[0] === lectureDateKst) when = '오늘 ';

  const topics = [
    ...new Set(items.map((i) => (i.lessonTitle || '').trim()).filter(Boolean)),
  ];
  let origin = '';
  if (when && topics.length === 1) origin = `${when}${topics[0]} 수업에서 나온 `;
  else if (when && topics.length > 1) origin = `${when}여러 수업에서 나온 `;
  else if (when) origin = `${when}나온 `;
  else if (topics.length === 1) origin = `${topics[0]} 수업에서 나온 `;
  else if (topics.length > 1) origin = `여러 수업에서 나온 `;

  let material: string;
  if (nNew && nReview) material = `${origin}새 표현 ${nNew}개와 복습 표현 ${nReview}개`;
  else if (nReview && !nNew) material = `복습할 표현 ${nReview}개`;
  else material = `${origin}표현 ${nNew}개`;
  return `찬식님, 좋은 아침이에요. ${material}를 함께 볼게요.`;
}

export const PRACTICE_OUTRO =
  '오늘 강의는 여기까지예요. 직접 말한다고 생각하고 소리 내서 두세 번 연습해 보세요. 오늘도 화이팅이에요, 찬식님!';

export function estimateSpeechSec(text: string): number {
  const chars = (text || '').replace(/\s+/g, ' ').trim().length;
  return chars / SPEECH_CHARS_PER_SEC;
}

export function estimatePlanDurationSec(plan: PlanSeg[]): number {
  return (plan || []).reduce((sum, seg) => {
    if (seg.kind === 'silence') return sum + seg.sec;
    return sum + estimateSpeechSec(seg.text);
  }, 0);
}

/**
 * Fit a lecture under the 10-minute cap without shortening explanations or examples.
 * Drops whole items, lowest priority first (review, then oldest new). Keeps at least one item.
 */
export function trimItemsToBudget(
  items: LectureScriptItem[],
  lectureDateKst: string,
  title: string,
  coachNote: string,
  maxSec = LECTURE_MAX_SEC
): LectureScriptItem[] {
  const copy: LectureScriptItem[] = items.map((it) => ({
    ...it,
    dialogue: Array.isArray(it.dialogue) ? it.dialogue.map((d) => ({ ...d })) : [],
  }));
  const duration = (list: LectureScriptItem[]) =>
    estimatePlanDurationSec(buildLectureSpeechPlan(title, list, coachNote, lectureDateKst));
  if (duration(copy) <= maxSec) return copy;
  const kept = copy.slice();
  while (kept.length > 1 && duration(kept) > maxSec) {
    let dropAt = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i].kind === 'review') {
        dropAt = i;
        break;
      }
    }
    if (dropAt < 0) dropAt = kept.length - 1;
    kept.splice(dropAt, 1);
  }
  return kept;
}

export function buildLectureSpeechPlan(
  title: string,
  items: LectureScriptItem[],
  coachNote: string,
  lectureDateKst: string
): PlanSeg[] {
  const plan: PlanSeg[] = [];
  const opening = items.length
    ? openingLine(items, lectureDateKst)
    : '찬식님, 좋은 아침이에요.';
  plan.push({ kind: 'speech', text: `Coach: ${opening}`, two: false, role: 'opening' });
  plan.push({ kind: 'silence', sec: 0.6 });

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const lines = [
      `Coach: ${i + 1}번, ${introLine(it, lectureDateKst)}`,
      `Coach: 자연스러운 표현은 "${stripSpeechDirections(it.naturalPhrase)}" 입니다.${it.explanation ? ` ${it.explanation}` : ''}`,
    ];
    const example = (it.similarExample || '').trim();
    if (example) lines.push(`Coach: 비슷한 예로, ${example}`);
    for (const ex of it.extraExamples || []) {
      const trimmedEx = String(ex || '').trim();
      if (trimmedEx) lines.push(`Coach: 하나 더, ${trimmedEx}`);
    }
    if (it.dialogue.length > 0) {
      lines.push('Coach: 짧은 대화로 들어 볼게요.');
      for (const d of it.dialogue) {
        lines.push(`${d.speaker === 'Partner' ? 'Partner' : 'Coach'}: ${d.line}`);
      }
    }
    if ((it.meaningKo || '').trim()) {
      lines.push(`Coach: 한국어 뜻은 "${it.meaningKo}". 영어로 말해 보세요.`);
    } else {
      lines.push('Coach: 자연스러운 표현을 영어로 말해 보세요.');
    }
    plan.push({ kind: 'speech', text: lines.join('\n'), two: true, itemIndex: i, role: 'body' });
    plan.push({ kind: 'silence', sec: SILENCE_SEC });
    plan.push({ kind: 'speech', text: `Coach: ${it.answerEnglish}`, two: false, itemIndex: i, role: 'answer' });
    plan.push({ kind: 'silence', sec: 0.8 });
  }

  const note = (coachNote || '').trim();
  const closing = note
    ? `Coach: 오늘의 코치 한마디. ${note} ${PRACTICE_OUTRO}`
    : `Coach: ${PRACTICE_OUTRO}`;
  plan.push({ kind: 'speech', text: closing, two: false, role: 'closing' });
  return plan;
}
