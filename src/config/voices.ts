/**
 * Live / TTS 음성 선택 상수 및 정규화 유틸리티 (순수 모듈, 외부 import 없음).
 */

export const VOICE_OPTIONS = [
  { id: "Kore", label: "Kore", desc: "또렷하고 단단한 톤" },
  { id: "Zephyr", label: "Zephyr", desc: "밝은 톤" },
  { id: "Puck", label: "Puck", desc: "경쾌한 톤" },
  { id: "Charon", label: "Charon", desc: "차분하게 알려 주는 톤" },
  { id: "Fenrir", label: "Fenrir", desc: "활기찬 톤" },
] as const;

export type VoiceOption = (typeof VOICE_OPTIONS)[number];
export type VoiceId = VoiceOption["id"];

export const DEFAULT_VOICE: VoiceId = "Kore";

/**
 * 실시간 대화 연결 시 speechConfig.languageCode 설정.
 * null이면 직접 연결·서버 중계 모두 languageCode 키를 보내지 않는다.
 */
export const LIVE_LANGUAGE_CODE: string | null = null;

export const PREVIEW_PHRASE = "Hi, I'm your English coach. Let's talk for a few minutes.";

/**
 * 입력된 음성 이름을 허용 목록(5종)으로 정규화한다.
 * 대소문자·앞뒤 공백을 무시하며, 목록 밖이거나 문자열이 아니면 DEFAULT_VOICE를 반환한다.
 */
export function normalizeVoiceName(x: unknown): VoiceId {
  if (typeof x !== "string") return DEFAULT_VOICE;
  const trimmed = x.trim().toLowerCase();
  if (!trimmed) return DEFAULT_VOICE;
  const match = VOICE_OPTIONS.find((v) => v.id.toLowerCase() === trimmed);
  return match ? match.id : DEFAULT_VOICE;
}
