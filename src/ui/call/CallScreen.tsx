import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Mic, MicOff, PhoneOff, Send, MessageSquare } from 'lucide-react';
import { GlowingOrb, phaseToOrbMode } from '../components/GlowingOrb';
import { VoiceCallEngine } from '../../voice/VoiceCallEngine';
import { UserPreferences } from '../../data/UserPreferences';
import { CallPhase, ReplyLatency, ReplyOrigin, getReplyOriginLabel } from '../../types';
import { getTtsVoice } from '../../voice/TtsVoice';

interface CallScreenProps {
  onHangUp: () => void;
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function formatLatency(latency: ReplyLatency): string {
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}초`;
  const parts: string[] = [`첫 소리까지 ${sec(latency.firstSoundMs)}`];
  if (latency.source === 'Ai' && latency.modelMs != null) {
    parts.push(`모델 ${sec(latency.modelMs)}`);
  } else if (latency.source === 'Local') {
    parts.push('기본 응답');
  } else if (latency.source === 'Fallback') {
    parts.push('AI 응답 실패');
  }
  if (latency.voiceMs != null) {
    parts.push(`음성 ${sec(latency.voiceMs)}`);
  }
  return parts.join(' · ');
}

export const CallScreen: React.FC<CallScreenProps> = ({ onHangUp }) => {
  const [phase, setPhase] = useState<CallPhase>('Idle');
  const [muted, setMuted] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [partialText, setPartialText] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [latencyText, setLatencyText] = useState<string | null>(null);
  const [replySourceText, setReplySourceText] = useState<string | null>(null);
  const [voiceInfoText, setVoiceInfoText] = useState<string | null>(null);
  const [voiceFailureText, setVoiceFailureText] = useState<string | null>(null);
  const [aiKeyMissing, setAiKeyMissing] = useState(false);

  // Manual speech test input
  const [showSimulatedInput, setShowSimulatedInput] = useState(false);
  const [manualSpeechText, setManualSpeechText] = useState('');

  const engineRef = useRef<VoiceCallEngine | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const handleHangUp = useCallback(() => {
    if (engineRef.current) {
      engineRef.current.stop();
      engineRef.current = null;
    }
    onHangUp();
  }, [onHangUp]);

  useEffect(() => {
    const hasKeys =
      Boolean(UserPreferences.getOpenRouterApiKey()) ||
      Boolean(UserPreferences.getGeminiApiKey());
    setAiKeyMissing(!hasKeys);

    const callStartedAt = performance.now();
    const timerInterval = setInterval(() => {
      setElapsedMs(performance.now() - callStartedAt);
    }, 250);

    const engine = new VoiceCallEngine(
      () => UserPreferences.getNickname(),
      () => UserPreferences.getGeminiApiKey(),
      () => UserPreferences.getOpenRouterApiKey(),
      () => getTtsVoice(UserPreferences.getTtsVoiceOption()),
      () => mutedRef.current,
      {
        onPhase: (newPhase) => {
          setPhase(newPhase);
          if (newPhase === 'Ended') {
            handleHangUp();
          }
        },
        onPartialText: (text) => setPartialText(text),
        onErrorMessage: (msg) => setErrorMessage(msg),
        onLatency: (latency) => setLatencyText(formatLatency(latency)),
        onReplyOrigin: (origin: ReplyOrigin) => {
          setReplySourceText(getReplyOriginLabel(origin));
          setAiKeyMissing(origin.kind === 'LocalNoKey');
        },
        onVoiceInfo: (info) => setVoiceInfoText(info),
        onVoiceFailure: (failure) => setVoiceFailureText(failure),
      }
    );

    engineRef.current = engine;
    engine.start();

    return () => {
      clearInterval(timerInterval);
      if (engineRef.current) {
        engineRef.current.stop();
        engineRef.current = null;
      }
    };
  }, [handleHangUp]);

  const toggleMute = () => {
    const nextMuted = !muted;
    setMuted(nextMuted);
    engineRef.current?.setMuted(nextMuted);
  };

  const handleSendManualSpeech = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualSpeechText.trim()) return;
    engineRef.current?.injectUserSpeech(manualSpeechText.trim());
    setManualSpeechText('');
  };

  const getPhaseDisplay = () => {
    if (muted) return '음소거';
    switch (phase) {
      case 'Listening':
      case 'Thinking':
        return '듣는 중…';
      case 'Speaking':
      case 'Greeting':
        return '말하는 중…';
      case 'Ended':
        return '끊기';
      default:
        return '…';
    }
  };

  return (
    <div className="relative min-h-screen w-full bg-[#1A1210] text-[#F5EDE6] flex flex-col justify-between px-6 py-8 select-none max-w-md mx-auto">
      {/* Top Header / Metadata */}
      <div className="w-full flex flex-col items-center pt-2 space-y-2">
        <div className="px-4 py-1.5 rounded-full bg-[#2A1F1B] border border-white/5 shadow-sm">
          <span className="text-xs font-semibold text-[#E8A87C] tracking-wide">
            AI 음성
          </span>
        </div>

        <div className="text-3xl font-extrabold tracking-tight text-[#F5EDE6] pt-1">
          {formatElapsed(elapsedMs)}
        </div>

        <div className="text-base text-[#F5EDE6]/60 font-medium">
          {getPhaseDisplay()}
        </div>

        {/* Small detail badges matching Android layout */}
        {replySourceText && (
          <div
            className={`text-xs text-center font-medium ${
              replySourceText.startsWith('AI 실패') ? 'text-[#E07070]' : 'text-[#F5EDE6]/60'
            }`}
          >
            {replySourceText}
          </div>
        )}

        {voiceInfoText && (
          <div className="text-[11px] text-[#F5EDE6]/50 text-center">
            {voiceInfoText}
          </div>
        )}

        {voiceFailureText && (
          <div className="text-xs text-[#E07070] text-center font-medium">
            {voiceFailureText}
          </div>
        )}

        {latencyText && (
          <div className="text-[11px] text-[#F5EDE6]/50 text-center font-mono">
            {latencyText}
          </div>
        )}

        {aiKeyMissing && (
          <div className="text-xs text-[#F5EDE6]/50 text-center">
            AI 키 미설정 · 기본 응답 모드
          </div>
        )}
      </div>

      {/* Center glowing orb and live transcript */}
      <div className="flex flex-col items-center justify-center my-auto py-4">
        <GlowingOrb
          mode={phaseToOrbMode(phase)}
          size={240}
        />

        {/* Live speech transcript */}
        <div className="min-h-12 flex items-center justify-center mt-5 px-4 text-center">
          {partialText ? (
            <p className="text-sm font-medium text-[#F5EDE6]/80 leading-relaxed bg-[#2A1F1B]/60 px-4 py-2 rounded-2xl border border-white/5 animate-pulse">
              {partialText}
            </p>
          ) : (
            <p className="text-xs text-[#F5EDE6]/30">
              {phase === 'Listening' ? '듣고 있어요, 편하게 말씀하세요' : ''}
            </p>
          )}
        </div>

        {errorMessage && (
          <div className="mt-2 text-xs text-[#E07070] text-center px-4">
            {errorMessage}
          </div>
        )}
      </div>

      {/* Bottom Controls */}
      <div className="w-full flex flex-col items-center pb-4">
        {/* Toggleable manual speech simulation bar for easy testing */}
        <div className="w-full mb-6">
          <div className="flex justify-center mb-2">
            <button
              onClick={() => setShowSimulatedInput(!showSimulatedInput)}
              className="text-[11px] text-[#F5EDE6]/40 hover:text-[#E8A87C] flex items-center gap-1 transition"
            >
              <MessageSquare size={13} />
              {showSimulatedInput ? '직접 입력창 닫기' : '마이크 없이 직접 말해보기 (테스트용)'}
            </button>
          </div>

          {showSimulatedInput && (
            <form onSubmit={handleSendManualSpeech} className="flex gap-2">
              <input
                type="text"
                value={manualSpeechText}
                onChange={(e) => setManualSpeechText(e.target.value)}
                placeholder="한국어로 말을 입력하고 전송하세요"
                className="flex-1 px-3 py-2 text-xs rounded-xl bg-[#2A1F1B] border border-white/10 text-[#F5EDE6] focus:outline-none focus:border-[#E8A87C]"
              />
              <button
                type="submit"
                className="px-3 py-2 rounded-xl bg-[#E8A87C] text-[#1A1210] text-xs font-semibold hover:bg-[#dca074] transition"
              >
                <Send size={14} />
              </button>
            </form>
          )}
        </div>

        {/* Action Buttons: Mute & Hangup */}
        <div className="w-full flex items-center justify-around px-8">
          {/* Mute button */}
          <div className="flex flex-col items-center">
            <button
              onClick={toggleMute}
              className={`w-16 h-16 rounded-full flex items-center justify-center transition-all ${
                muted
                  ? 'bg-[#E8A87C] text-[#1A1210] shadow-md shadow-[#E8A87C]/30'
                  : 'bg-[#2A1F1B] text-[#F5EDE6] hover:bg-white/10'
              }`}
              title={muted ? '음소거 해제' : '음소거'}
              aria-label={muted ? '음소거 해제' : '음소거'}
            >
              {muted ? <MicOff size={26} /> : <Mic size={26} />}
            </button>
            <span className="text-xs text-[#F5EDE6]/60 mt-2 font-medium">
              {muted ? '음소거 해제' : '음소거'}
            </span>
          </div>

          {/* Hang up button */}
          <div className="flex flex-col items-center">
            <button
              onClick={handleHangUp}
              className="w-18 h-18 rounded-full bg-[#E07070] text-white flex items-center justify-center shadow-lg shadow-[#E07070]/30 hover:bg-[#c95e5e] active:scale-95 transition-all cursor-pointer"
              title="통화 종료"
              aria-label="끊기"
            >
              <PhoneOff size={30} />
            </button>
            <span className="text-xs text-[#F5EDE6]/60 mt-2 font-medium">
              끊기
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
