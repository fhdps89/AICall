/**
 * B-7 Morning Lecture generator (server side).
 * - Script: gemini-3.8-flash with responseSchema
 * - Voice: gemini-3.8-flash-tts, 2 speakers (Coach / Partner), raw PCM per segment
 * - Concatenate PCM, insert 3s silence before each answer, save one WAV file
 * - Jobs run in the background; state is persisted under .data/lectures/{uid}/{date}.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, '..', '.data');
const LECTURE_DIR = path.join(DATA_DIR, 'lectures');

const SCRIPT_MODEL = 'gemini-3.8-flash';
const LECTURE_TTS_MODEL = 'gemini-3.8-flash-tts';
const VOICE_COACH = 'Kore';
const VOICE_PARTNER = 'Puck';
const SILENCE_SEC = 3;
const MAX_NEW = 6;
const MAX_REVIEW = 3;

export interface LectureMistakeInput {
  id: string;
  myPhrase: string;
  naturalPhrase: string;
  reason?: string;
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
  startSec?: number;
}

export interface LectureState {
  uid: string;
  date: string;
  status: 'generating' | 'ready' | 'failed';
  title?: string;
  script?: LectureScriptItem[];
  coachNote?: string;
  itemCount?: number;
  newMistakeIds: string[];
  reviewMistakeIds: string[];
  ttsEngine: 'gemini' | 'elevenlabs';
  chars?: number;
  textTokens?: number;
  durationSec?: number;
  audioFile?: string; // relative file name inside LECTURE_DIR/{uid}
  error?: string;
  createdAt: string;
  updatedAt: string;
}

function userDir(uid: string): string {
  const safe = uid.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(LECTURE_DIR, safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  return date;
}

export function kstToday(): string {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

export function readLectureState(uid: string, date: string): LectureState | null {
  const file = path.join(userDir(uid), `${safeDate(date)}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function writeLectureState(state: LectureState): void {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(userDir(state.uid), `${safeDate(state.date)}.json`), JSON.stringify(state, null, 2));
}

export function lectureAudioPath(uid: string, date: string): string | null {
  const st = readLectureState(uid, date);
  if (!st?.audioFile) return null;
  const p = path.join(userDir(uid), path.basename(st.audioFile));
  return fs.existsSync(p) ? p : null;
}

const running = new Set<string>();

/**
 * Start (or return existing) lecture job. Never regenerates a ready lecture unless force=true.
 */
export function startLectureJob(
  ai: GoogleGenAI,
  uid: string,
  date: string,
  newMistakes: LectureMistakeInput[],
  reviewMistakes: LectureMistakeInput[],
  opts: { force?: boolean } = {}
): LectureState {
  safeDate(date);
  const key = `${uid}:${date}`;
  const existing = readLectureState(uid, date);
  if (existing && (running.has(key) || (existing.status === 'ready' && !opts.force))) {
    return existing;
  }
  const clean = (list: LectureMistakeInput[], max: number) =>
    (Array.isArray(list) ? list : [])
      .filter((m) => m && typeof m.id === 'string' && m.myPhrase && m.naturalPhrase)
      .slice(0, max)
      .map((m) => ({
        id: String(m.id),
        myPhrase: String(m.myPhrase).slice(0, 400),
        naturalPhrase: String(m.naturalPhrase).slice(0, 400),
        reason: String(m.reason || '').slice(0, 600),
      }));
  const newList = clean(newMistakes, MAX_NEW);
  const reviewList = clean(reviewMistakes, MAX_REVIEW).filter((r) => !newList.some((n) => n.id === r.id));

  const engine = process.env.LECTURE_TTS_ENGINE === 'elevenlabs' ? 'elevenlabs' : 'gemini';
  const now = new Date().toISOString();
  const state: LectureState = {
    uid,
    date,
    status: 'generating',
    newMistakeIds: newList.map((m) => m.id),
    reviewMistakeIds: reviewList.map((m) => m.id),
    ttsEngine: engine,
    createdAt: now,
    updatedAt: now,
  };
  if (newList.length + reviewList.length === 0) {
    state.status = 'failed';
    state.error = 'NOTHING_TO_TEACH';
    writeLectureState(state);
    return state;
  }
  writeLectureState(state);
  running.add(key);
  runJob(ai, state, newList, reviewList)
    .catch((err) => {
      console.error('[Lecture] job failed:', err);
      state.status = 'failed';
      state.error = err?.message || String(err);
      writeLectureState(state);
    })
    .finally(() => running.delete(key));
  return state;
}

function isSundayKst(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
}

async function generateScript(
  ai: GoogleGenAI,
  date: string,
  newList: LectureMistakeInput[],
  reviewList: LectureMistakeInput[]
): Promise<{ title: string; items: LectureScriptItem[]; coachNote: string; tokens: number }> {
  const sunday = isSundayKst(date);
  const fmt = (list: LectureMistakeInput[], kind: string) =>
    list
      .map((m) => `- id=${m.id} | kind=${kind} | myPhrase="${m.myPhrase}" | naturalPhrase="${m.naturalPhrase}" | reason="${m.reason || ''}"`)
      .join('\n');

  const prompt = `당신은 한국인 성인 학습자를 위한 5분짜리 아침 영어 오디오 강의 작가입니다.
아래 실수 목록으로 강의 대본을 만드세요. 해설자는 "Coach"(한국어로 설명), 대화 상대는 "Partner"(영어 원어민)입니다.

[실수 목록]
${fmt(newList, 'new')}
${fmt(reviewList, 'review')}

[대본 규칙 - 반드시 지킬 것]
1. 영어는 영어 철자 그대로 쓰세요. 영어를 한글 발음으로 적지 마세요(예: "땡큐" 금지, "thank you"로).
2. 항목마다 순서: 어젯밤 하신 말(myPhrase, 입력 그대로, 고치지 말 것) → 자연스러운 표현(naturalPhrase) → 이유 1~2문장(explanation, 한국어) → 짧은 2인 대화(dialogue, 2~4줄, Coach와 Partner가 번갈아 영어로, naturalPhrase가 자연스럽게 들어감) → 한국어 뜻(meaningKo, naturalPhrase의 한국어 뜻) → (3초 무음은 시스템이 넣음) → 정답 영어(answerEnglish = naturalPhrase).
3. 입력 목록 순서대로, 각 항목의 mistakeId와 kind는 입력 값 그대로 쓰세요. 항목을 빼거나 합치지 마세요.
4. 전체 분량은 5분 이내가 되도록 explanation과 dialogue를 짧게 유지하세요.
5. title: 오늘 강의 제목(한국어, 20자 이내).
6. coachNote: 끝에 코치 한마디(한국어 2~3문장).${sunday ? ' 오늘은 일요일이므로 한 주를 총정리하는 주간 리뷰 톤으로 쓰세요. 이번 주 완수한 수업 진도와 누적 복습/졸업 표현 성과를 짚어주고 다음 주 실전 통화를 응원하는 따뜻하고 구체적인 코칭 메시지로 작성하세요.' : ''}
7. 시험·교재의 상표나 문제를 복제하지 마세요.`;

  const response = await ai.models.generateContent({
    model: SCRIPT_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                mistakeId: { type: Type.STRING },
                kind: { type: Type.STRING, enum: ['new', 'review'] },
                myPhrase: { type: Type.STRING },
                naturalPhrase: { type: Type.STRING },
                explanation: { type: Type.STRING },
                dialogue: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      speaker: { type: Type.STRING, enum: ['Coach', 'Partner'] },
                      line: { type: Type.STRING },
                    },
                    required: ['speaker', 'line'],
                  },
                },
                meaningKo: { type: Type.STRING },
                answerEnglish: { type: Type.STRING },
              },
              required: ['mistakeId', 'kind', 'myPhrase', 'naturalPhrase', 'explanation', 'dialogue', 'meaningKo', 'answerEnglish'],
            },
          },
          coachNote: { type: Type.STRING },
        },
        required: ['title', 'items', 'coachNote'],
      },
    },
  });
  const parsed = JSON.parse(response.text?.trim() || '{}');
  const inputs = new Map([...newList, ...reviewList].map((m) => [m.id, m]));
  const items: LectureScriptItem[] = (parsed.items || [])
    .filter((it: any) => inputs.has(it.mistakeId))
    .map((it: any) => {
      const src = inputs.get(it.mistakeId)!;
      return {
        ...it,
        // myPhrase must stay verbatim (never let the model "fix" it)
        myPhrase: src.myPhrase,
        naturalPhrase: src.naturalPhrase,
        answerEnglish: it.answerEnglish || src.naturalPhrase,
        dialogue: Array.isArray(it.dialogue) ? it.dialogue.slice(0, 4) : [],
      };
    });
  if (items.length === 0) throw new Error('대본 생성 결과가 비어 있습니다.');
  return {
    title: String(parsed.title || '오늘 아침 강의'),
    items,
    coachNote: String(parsed.coachNote || ''),
    tokens: Number(response.usageMetadata?.totalTokenCount || 0),
  };
}

interface Pcm {
  data: Buffer;
  rate: number;
}

function parseAudio(base64: string, mimeType: string): Pcm {
  let buf = Buffer.from(base64, 'base64');
  const rateMatch = /rate=(\d+)/i.exec(mimeType || '');
  let rate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
  if (/wav/i.test(mimeType) || buf.subarray(0, 4).toString('ascii') === 'RIFF') {
    rate = buf.readUInt32LE(24);
    // find "data" chunk
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.subarray(off, off + 4).toString('ascii');
      const size = buf.readUInt32LE(off + 4);
      if (id === 'data') {
        buf = buf.subarray(off + 8, off + 8 + size);
        break;
      }
      off += 8 + size;
    }
  }
  return { data: buf, rate };
}

/** ElevenLabs Text-to-Dialogue branch: skeleton only (no key, no call yet). */
async function synthesizeElevenLabs(_text: string, _twoSpeakers: boolean): Promise<Pcm> {
  throw new Error('ElevenLabs 경로는 아직 미구현(비교용 예정)');
}

async function synthesizeGemini(ai: GoogleGenAI, text: string, twoSpeakers: boolean): Promise<Pcm> {
  const speechConfig: any = twoSpeakers
    ? {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: [
            { speaker: 'Coach', voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_COACH } } },
            { speaker: 'Partner', voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_PARTNER } } },
          ],
        },
      }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_COACH } } };
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: LECTURE_TTS_MODEL,
        contents: [{ role: 'user', parts: [{ text }] }],
        config: { responseModalities: ['AUDIO'], speechConfig },
      });
      const part = response.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
      if (!part?.inlineData?.data) throw new Error('TTS 음성 데이터 없음');
      return parseAudio(part.inlineData.data, part.inlineData.mimeType || '');
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function synthesize(ai: GoogleGenAI, engine: 'gemini' | 'elevenlabs', text: string, twoSpeakers: boolean): Promise<Pcm> {
  if (engine === 'elevenlabs') {
    try {
      return await synthesizeElevenLabs(text, twoSpeakers);
    } catch (err: any) {
      console.warn('[Lecture] ElevenLabs unavailable, falling back to Gemini TTS:', err?.message);
    }
  }
  return synthesizeGemini(ai, text, twoSpeakers);
}

function resample(p: Pcm, rate: number): Buffer {
  if (p.rate === rate) return p.data;
  // simple nearest-neighbour resample (all Gemini TTS output is 24kHz in practice)
  const inSamples = Math.floor(p.data.length / 2);
  const outSamples = Math.floor((inSamples * rate) / p.rate);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const src = Math.min(inSamples - 1, Math.floor((i * p.rate) / rate));
    out.writeInt16LE(p.data.readInt16LE(src * 2), i * 2);
  }
  return out;
}

function wavFromPcm(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const TTS_STYLE = 'Read this morning English lesson warmly and clearly. Korean lines in natural Korean; English lines in natural American English (never Korean-accented transliteration).';

async function runJob(
  ai: GoogleGenAI,
  state: LectureState,
  newList: LectureMistakeInput[],
  reviewList: LectureMistakeInput[]
): Promise<void> {
  const script = await generateScript(ai, state.date, newList, reviewList);
  state.title = script.title;
  state.coachNote = script.coachNote;
  state.itemCount = script.items.length;
  state.textTokens = script.tokens;
  writeLectureState(state);

  const RATE = 24000;
  const pieces: Buffer[] = [];
  let totalBytes = 0;
  let chars = 0;
  const push = (b: Buffer) => {
    pieces.push(b);
    totalBytes += b.length;
  };
  const say = async (text: string, two: boolean) => {
    chars += text.length;
    push(resample(await synthesize(ai, state.ttsEngine, `${TTS_STYLE}\n\n${text}`, two), RATE));
  };
  const silence = (sec: number) => push(Buffer.alloc(Math.round(sec * RATE) * 2));

  await say(`Coach: 좋은 아침이에요. 오늘 아침 강의, ${script.title}. 모두 ${script.items.length}개 표현을 함께 볼게요.`, false);
  silence(0.6);

  for (let i = 0; i < script.items.length; i++) {
    const it = script.items[i];
    it.startSec = Math.round((totalBytes / 2 / RATE) * 10) / 10;
    const label = it.kind === 'review' ? '복습 표현' : '새 표현';
    const body = [
      `Coach: ${i + 1}번, ${label}이에요. 어젯밤 하신 말은 "${it.myPhrase}" 였어요.`,
      `Coach: 자연스러운 표현은 "${it.naturalPhrase}" 입니다. ${it.explanation}`,
      `Coach: 짧은 대화로 들어 볼게요.`,
      ...it.dialogue.map((d) => `${d.speaker === 'Partner' ? 'Partner' : 'Coach'}: ${d.line}`),
      `Coach: 한국어 뜻은 "${it.meaningKo}". 영어로 말해 보세요.`,
    ].join('\n');
    await say(body, true);
    silence(SILENCE_SEC);
    await say(`Coach: ${it.answerEnglish}`, false);
    silence(0.8);
  }
  if (script.coachNote) {
    await say(`Coach: 오늘의 코치 한마디. ${script.coachNote}`, false);
  }

  const pcm = Buffer.concat(pieces);
  const fileName = `${state.date}.wav`;
  fs.writeFileSync(path.join(userDir(state.uid), fileName), wavFromPcm(pcm, RATE));
  state.script = script.items;
  state.chars = chars;
  state.durationSec = Math.round(pcm.length / 2 / RATE);
  state.audioFile = fileName;
  state.status = 'ready';
  delete state.error;
  writeLectureState(state);
}
