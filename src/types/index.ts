export type CallPhase = 'Idle' | 'Greeting' | 'Listening' | 'Thinking' | 'Speaking' | 'Ended';

export type VoiceGender = 'female' | 'male';

export type TtsVoiceOption =
  | 'kore'
  | 'leda'
  | 'zephyr'
  | 'aoede'
  | 'puck'
  | 'charon'
  | 'fenrir'
  | '2'
  | '1'
  | '7';

export interface TtsVoice {
  option: TtsVoiceOption;
  model: string;
  voice: string;
  gender: VoiceGender;
  name: string;
  vibe: string;
  description: string;
  sampleText: string;
  personaStyle: string;
  googleStyle: boolean;
  shortLabel: string;
}

export interface ChatTurn {
  role: 'user' | 'model' | 'system';
  text: string;
  timestamp?: number;
}

export type ReplySource = 'Ai' | 'Local' | 'Fallback';

export interface ReplyLatency {
  firstSoundMs: number;
  modelMs?: number | null;
  source: ReplySource;
  sinceSpeechMs?: number | null;
  voiceMs?: number | null;
  remoteVoice?: boolean;
}

export type ReplyOrigin =
  | { kind: 'Ai' }
  | { kind: 'LocalNoKey' }
  | { kind: 'AiFailed'; reason: string };

export function getReplyOriginLabel(origin: ReplyOrigin): string {
  switch (origin.kind) {
    case 'Ai':
      return 'AI 대답';
    case 'LocalNoKey':
      return '기본 대답(키 없음)';
    case 'AiFailed':
      return `AI 실패: ${origin.reason}`;
  }
}

// ----------------------------------------------------
// AI Phone English (전화영어) Specialized Domain Models
// ----------------------------------------------------

export type TrackId = 'opic' | 'philly' | 'travel' | 'bluey';

export interface LessonItem {
  id: string;
  lessonNum: number;
  title: string;
  subtitle: string;
  targetMinutes: number;
  starterPrompt: string;
  sceneDescription?: string;
  keyGoals?: string[];
}

export interface TrackConfig {
  id: TrackId;
  name: string;
  shortName: string;
  emoji: string;
  accentColor: string;
  tagline: string;
  personaTitle: string;
  accentVoice: 'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr';
  systemPrompt: string;
  lessons: LessonItem[];
}

export interface ScheduleItem {
  date: string; // YYYY-MM-DD
  dayOfWeek: '월' | '화' | '수' | '목' | '금' | '토' | '일';
  trackId: TrackId;
  lessonNum: number;
  title: string;
  durationMinutes: number;
  note?: string;
}

export interface MistakeItem {
  id: string;
  createdAt: string;
  trackId: TrackId;
  lessonTitle: string;
  myPhrase: string;
  naturalPhrase: string;
  reason: string;
  reviewed: boolean;
}

export interface KeyExpression {
  expression: string;
  situation: string;
  exampleSentence: string;
}

export interface PostCallReview {
  id: string;
  date: string;
  trackId: TrackId;
  lessonNum: number;
  lessonTitle: string;
  durationSeconds: number;
  overallEvaluation: string;
  estimatedLevel: 'IM2' | 'IH' | 'AL' | 'Native';
  mistakes: Array<{
    myPhrase: string;
    naturalPhrase: string;
    reason: string;
  }>;
  keyExpressions: KeyExpression[];
  keepSyncText: string;
  progressTag: string;
}

export interface MorningPodcast {
  id: string;
  date: string;
  title: string;
  script: string;
  audioBase64?: string;
  audioMimeType?: string;
  sourceMistakeCount: number;
  durationEstimate: string;
}

export interface UserProfileSettings {
  jobRole: string;
  postingTarget: string;
  surveyTopics: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}
