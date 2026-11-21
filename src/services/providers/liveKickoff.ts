/**
 * 통화 시작 첫 인사(kickoff) 재전송 여부와 튜터 발화 수신 판정(순수 모듈, DOM/Firebase 비의존).
 */

import type { LiveWireKind } from "./liveWire";

export const MAX_KICKOFF_ATTEMPTS = 2;

export interface KickoffState {
  /** resumeToken 없이 시작한 새 통화 여부 */
  startedFresh: boolean;
  /** 이번 Live 맥락에서 모델 오디오·전사·텍스트를 1번이라도 받았는가 */
  tutorSpoke: boolean;
  /** 지금 ready 된 소켓에 이미 kickoff 를 보냈는가 */
  sentOnThisSocket: boolean;
  /** 이번 통화 맥락에서 이미 kickoff 를 보낸 누적 횟수 */
  attempts: number;
}

export function shouldSendKickoff(s: KickoffState): boolean {
  return s.startedFresh && !s.tutorSpoke && !s.sentOnThisSocket && s.attempts < MAX_KICKOFF_ATTEMPTS;
}

/**
 * 수신 메시지가 튜터(모델)의 실제 발화 출력(오디오·출력 전사·텍스트)인지 판정한다.
 * 사용자 입력 전사(inputTranscription)나 제어 이벤트(setupComplete/goAway 등)는 false.
 */
export function isTutorOutput(wire: LiveWireKind, msg: any): boolean {
  if (!msg || typeof msg !== "object") return false;

  if (wire === "direct") {
    const sc = msg.serverContent;
    if (!sc || typeof sc !== "object") return false;
    if (typeof sc.outputTranscription?.text === "string" && sc.outputTranscription.text.length > 0) {
      return true;
    }
    const parts = sc.modelTurn?.parts;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (!p || typeof p !== "object") continue;
        if (typeof p.inlineData?.data === "string" && p.inlineData.data.length > 0) return true;
        if (typeof p.text === "string" && p.text.length > 0) return true;
      }
    }
    return false;
  }

  return msg.type === "audio" || msg.type === "output_transcript" || msg.type === "text";
}
