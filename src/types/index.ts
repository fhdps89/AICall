export type CallPhase = 'Idle' | 'Greeting' | 'Listening' | 'Thinking' | 'Speaking' | 'Ended';

export type TtsVoiceOption = '2' | '1' | '7';

export interface TtsVoice {
  option: TtsVoiceOption;
  model: string;
  voice: string;
  description: string;
  googleStyle: boolean;
  shortLabel: string;
}

export interface ChatTurn {
  role: 'user' | 'model' | 'system';
  text: string;
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
