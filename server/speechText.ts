/**
 * Pure text helpers that strip stage directions, narrator labels, and markdown
 * from morning lecture scripts before saving or sending to TTS.
 */

export interface LectureScriptItemLike {
  naturalPhrase: string;
  explanation: string;
  dialogue: { speaker: 'Coach' | 'Partner'; line: string }[];
  meaningKo: string;
  answerEnglish: string;
  similarExample?: string;
  extraExamples?: string[];
}

const NARRATOR_LINE_RE =
  /^(narrator|narration|stage directions?|sfx|sound effects?|내레이터|내레이션|나레이션|지문|효과음)\s*:/i;

const SPEAKER_LABEL_RE = /^(Coach|Partner)\s*(\([^()\n]{0,40}\))?\s*:\s*/;

const SPEECH_PREFIX_RE =
  /^(say|speak|read)\s+([a-z]+ly|in an? [a-z ]{1,30}(tone|voice))\s*:\s*/i;

const LEADING_HEADING_RE = /^#{1,6}\s+/;
const LEADING_BULLET_RE = /^[-*•]\s+/;

const BACKTICK_RE = /`([^`\n]+?)`/g;
const BOLD_STAR_RE = /\*\*(?=\S)([^*\n]*?\S)\*\*/g;
const BOLD_UNDER_RE = /__(?=\S)([^_\n]*?\S)__/g;
const ITALIC_STAR_RE = /(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g;

const BRACKET_RE = /\[[^\[\]\n]{1,60}\]/g;
const PAREN_RE = /\(([^()\n]{1,40})\)/g;

const EN_ALLOWED_RE = /^[A-Za-z0-9 ,.'-]+$/;
const EN_DIRECTION_RE =
  /\b(paus(e|es|ed|ing)|beat|silen(ce|t)|laugh(s|ing)?|chuckl(e|es|ing)|smil(e|es|ing)|sigh(s|ing)?|giggl(e|es|ing)|whisper(s|ing)?|clears? throat|music|sfx|sound effects?|applause|\d+\s*(secs?|seconds?)|cheerfully|warmly|softly|slowly|excitedly|happily|gently|brightly|enthusiastically)\b/i;

const KO_DIRECTION_RE =
  /무음|침묵|정적|효과음|배경음|시스템이 넣|^\s*\d+\s*초\s*$|^\s*(잠시\s*)?(쉼|멈춤|웃음|미소|한숨|박수)\s*$|웃으며|미소 지으며/;

function isDirection(inner: string): boolean {
  if (EN_ALLOWED_RE.test(inner) && EN_DIRECTION_RE.test(inner)) return true;
  return KO_DIRECTION_RE.test(inner);
}

function stripLineBody(rawBody: string): { body: string; changed: boolean } {
  let body = rawBody;
  body = body.replace(SPEECH_PREFIX_RE, '');
  body = body.replace(LEADING_HEADING_RE, '');
  body = body.replace(LEADING_BULLET_RE, '');
  body = body.replace(BACKTICK_RE, '$1');
  body = body.replace(BOLD_STAR_RE, '$1');
  body = body.replace(BOLD_UNDER_RE, '$1');
  body = body.replace(ITALIC_STAR_RE, '$1$2');
  body = body.replace(BRACKET_RE, '');
  body = body.replace(PAREN_RE, (full, inner: string) => (isDirection(inner) ? '' : full));

  if (body === rawBody) {
    return { body: rawBody, changed: false };
  }

  body = body
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,!?;:…])/g, '$1')
    .trim();

  return { body, changed: true };
}

export function stripSpeechDirections(text: string): string {
  if (!text) return '';
  const out: string[] = [];

  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (NARRATOR_LINE_RE.test(trimmed)) continue;

    const labelMatch = SPEAKER_LABEL_RE.exec(trimmed);
    const label = labelMatch ? `${labelMatch[1]}: ` : '';
    const hasLabelParen = Boolean(labelMatch?.[2]);
    const rawBody = labelMatch ? trimmed.slice(labelMatch[0].length) : trimmed;

    const { body, changed } = stripLineBody(rawBody);
    if (!body) continue;

    if (!changed && !hasLabelParen) {
      out.push(trimmed);
    } else {
      out.push(`${label}${body}`);
    }
  }

  return out.join('\n');
}

export function cleanLectureScriptItem<T extends LectureScriptItemLike>(it: T): T {
  const explanation = stripSpeechDirections(it.explanation || '');
  const meaningKo = stripSpeechDirections(it.meaningKo || '');
  const similarExample = it.similarExample
    ? stripSpeechDirections(it.similarExample)
    : it.similarExample;
  const extraExamples = Array.isArray(it.extraExamples)
    ? it.extraExamples
        .map((ex) => stripSpeechDirections(String(ex || '')).trim())
        .filter(Boolean)
    : undefined;
  const answerEnglish = stripSpeechDirections(it.answerEnglish || '') || it.naturalPhrase;
  const dialogue = Array.isArray(it.dialogue)
    ? it.dialogue.flatMap((d) => {
        const cleaned = stripSpeechDirections(d.line || '')
          .replace(/^(Coach|Partner)\s*:\s*/, '')
          .trim();
        return cleaned ? [{ ...d, line: cleaned }] : [];
      })
    : [];
  const out: T = {
    ...it,
    explanation,
    meaningKo,
    similarExample,
    answerEnglish,
    dialogue,
  };
  if (extraExamples && extraExamples.length > 0) {
    out.extraExamples = extraExamples;
  } else {
    delete out.extraExamples;
  }
  return out;
}
