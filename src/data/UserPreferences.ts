import { TtsVoiceOption } from '../types';
import { DEFAULT_VOICE_OPTION, getTtsVoice } from '../voice/TtsVoice';

const PREFS_KEY_NICKNAME = 'aivoice_nickname';
const PREFS_KEY_GEMINI_KEY = 'aivoice_gemini_api_key';
const PREFS_KEY_OPENROUTER_KEY = 'aivoice_openrouter_api_key';
const PREFS_KEY_TTS_VOICE = 'aivoice_tts_voice_option';

export const DEFAULT_NICKNAME = '친구';
export const FIXED_VOICE_NAME = '기본 한국어 음성';

const QUOTE_CHARS = new Set(['"', "'", '`', '“', '”', '‘', '’']);

export class UserPreferences {
  static cleanApiKey(raw?: string | null): string {
    if (!raw) return '';
    let result = '';
    for (const ch of raw) {
      if (QUOTE_CHARS.has(ch)) continue;
      const code = ch.charCodeAt(0);
      // Skip whitespace and control characters
      if (/\s/.test(ch) || code < 32 || (code >= 127 && code <= 159)) continue;
      // Skip invisible unicode format characters (zero-width space, BOM, etc.)
      if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) continue;
      result += ch;
    }
    return result.trim();
  }

  static maskKey(key?: string | null): string {
    if (!key || key.trim() === '') return '';
    const clean = key.trim();
    if (clean.length <= 8) return '•'.repeat(clean.length);
    return clean.slice(0, 4) + '••••••••' + clean.slice(-4);
  }

  static getNickname(): string {
    const val = localStorage.getItem(PREFS_KEY_NICKNAME);
    if (!val || val.trim() === '') return DEFAULT_NICKNAME;
    return val.trim();
  }

  static setNickname(nickname: string): void {
    const clean = nickname.trim() || DEFAULT_NICKNAME;
    localStorage.setItem(PREFS_KEY_NICKNAME, clean);
  }

  static getGeminiApiKey(): string | null {
    const raw = localStorage.getItem(PREFS_KEY_GEMINI_KEY);
    const cleaned = this.cleanApiKey(raw);
    return cleaned.length > 0 ? cleaned : null;
  }

  static setGeminiApiKey(key?: string | null): void {
    const cleaned = this.cleanApiKey(key);
    if (!cleaned) {
      localStorage.removeItem(PREFS_KEY_GEMINI_KEY);
    } else {
      localStorage.setItem(PREFS_KEY_GEMINI_KEY, cleaned);
    }
  }

  static getOpenRouterApiKey(): string | null {
    const raw = localStorage.getItem(PREFS_KEY_OPENROUTER_KEY);
    const cleaned = this.cleanApiKey(raw);
    return cleaned.length > 0 ? cleaned : null;
  }

  static setOpenRouterApiKey(key?: string | null): void {
    const cleaned = this.cleanApiKey(key);
    if (!cleaned) {
      localStorage.removeItem(PREFS_KEY_OPENROUTER_KEY);
    } else {
      localStorage.setItem(PREFS_KEY_OPENROUTER_KEY, cleaned);
    }
  }

  static getTtsVoiceOption(): TtsVoiceOption {
    const val = localStorage.getItem(PREFS_KEY_TTS_VOICE) as TtsVoiceOption | null;
    if (val === '1' || val === '2' || val === '7') {
      return val;
    }
    return DEFAULT_VOICE_OPTION;
  }

  static setTtsVoiceOption(option: TtsVoiceOption): void {
    localStorage.setItem(PREFS_KEY_TTS_VOICE, option);
  }

  static getVoiceDisplayName(): string {
    const orKey = this.getOpenRouterApiKey();
    if (orKey) {
      const voice = getTtsVoice(this.getTtsVoiceOption());
      return voice.shortLabel;
    }
    return FIXED_VOICE_NAME;
  }
}
