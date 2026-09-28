import { TtsVoice, TtsVoiceOption } from '../types';

export const TTS_VOICES: Record<TtsVoiceOption, TtsVoice> = {
  '2': {
    option: '2',
    model: 'google/gemini-3.8-flash-lite-tts',
    voice: 'Puck',
    description: 'Gemini Flash-Lite TTS · 남 · 기본',
    googleStyle: true,
    shortLabel: '2번 Puck',
  },
  '1': {
    option: '1',
    model: 'google/gemini-3.8-flash-tts',
    voice: 'Leda',
    description: 'Gemini Flash TTS · 여',
    googleStyle: true,
    shortLabel: '1번 Leda',
  },
  '7': {
    option: '7',
    model: 'qwen/qwen-audio-3.0-tts-flash',
    voice: 'longanhuan_v3.6',
    description: 'Qwen TTS Flash · 여',
    googleStyle: false,
    shortLabel: '7번 longanhuan_v3.6',
  },
};

export const DEFAULT_VOICE_OPTION: TtsVoiceOption = '2';

export function getTtsVoice(option?: string | null): TtsVoice {
  if (option && (option === '1' || option === '2' || option === '7')) {
    return TTS_VOICES[option as TtsVoiceOption];
  }
  return TTS_VOICES[DEFAULT_VOICE_OPTION];
}

export const TTS_VOICE_LIST: TtsVoice[] = [
  TTS_VOICES['2'],
  TTS_VOICES['1'],
  TTS_VOICES['7'],
];
