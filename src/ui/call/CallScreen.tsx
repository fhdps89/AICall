import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Mic, MicOff, PhoneOff, Send, MessageSquare, AlertCircle, Sparkles, Activity, Volume2 } from 'lucide-react';
import { GlowingOrb, phaseToOrbMode } from '../components/GlowingOrb';
import { VoiceCallEngine, MicStatus, P4Telemetry } from '../../voice/VoiceCallEngine';
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

const QUICK_PROMPTS = [
  '안녕! 오늘 하루 어땠어?',
  '지금 무슨 생각해?',
  '나 오늘 좀 피곤했어',
  '따뜻한 위로 한마디 해줘',
];

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

  // Microphone status and dynamic voice level
  const [audioLevel, setAudioLevel] = useState(0);
  const [micStatus, setMicStatus] = useState<MicStatus>('requesting');

  // P4 Real-time Observability Telemetry
  const [telemetry, setTelemetry] = useState<P4Telemetry | null>(null);
  const [showTelemetry, setShowTelemetry] = useState(false);

  // Manual speech input and quick suggestions
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
    setAiKeyMissing(false);

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
        onAudioLevel: (level) => setAudioLevel(level),
        onMicStatus: (status) => setMicStatus(status),
        onP4Telemetry: (tel) => setTelemetry(tel),
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

  const handleQuickPromptClick = (prompt: string) => {
    engineRef.current?.injectUserSpeech(prompt);
  };

  const retryMicPermission = () => {
    setErrorMessage(null);
    if (engineRef.current) {
      engineRef.current.stop();
      engineRef.current.start();
    }
  };

  const getPhaseDisplay = () => {
    if (muted) return '음소거 됨';
    switch (phase) {
      case 'Listening':
        return audioLevel > 0.15 ? '목소리 듣는 중…' : '듣는 중… 말씀해 보세요';
      case 'Thinking':
        return '생각하는 중…';
      case 'Speaking':
      case 'Greeting':
        return '말하는 중…';
      case 'Ended':
        return '통화 종료';
      default:
        return '연결 중…';
    }
  };

  return (
    <div className="relative min-h-screen w-full bg-[#1A1210] text-[#F5EDE6] flex flex-col justify-between px-6 py-6 select-none max-w-md mx-auto">
      {/* Top Header / Metadata */}
      <div className="w-full flex flex-col items-center pt-2 space-y-2">
        <div className="flex items-center gap-2">
          <div className="px-3.5 py-1 rounded-full bg-[#2A1F1B] border border-white/5 shadow-sm flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${micStatus === 'active' ? 'bg-[#55B374] animate-pulse' : micStatus === 'denied' ? 'bg-[#E07070]' : 'bg-[#E8A87C]'}`} />
            <span className="text-xs font-semibold text-[#E8A87C] tracking-wide">
              {micStatus === 'denied' ? '마이크 차단됨' : 'AI 실시간 음성'}
            </span>
          </div>
        </div>

        <div className="text-3xl font-extrabold tracking-tight text-[#F5EDE6] pt-1">
          {formatElapsed(elapsedMs)}
        </div>

        <div className="text-sm font-medium transition-colors text-[#F5EDE6]/80 flex items-center gap-2">
          {getPhaseDisplay()}
        </div>

        {/* Reply origin & voice badges */}
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

        {/* Earphone recommendation tip */}
        <div className="text-[11px] text-[#E8A87C]/80 bg-[#E8A87C]/10 border border-[#E8A87C]/20 px-3 py-1 rounded-full flex items-center gap-1.5 shadow-sm">
          <span>🎧 이어폰을 착용하시면 더 선명하게 대화할 수 있어요</span>
        </div>

        {/* P4 Observability & Telemetry Inspector */}
        <div className="w-full flex flex-col items-center">
          <button
            onClick={() => setShowTelemetry(!showTelemetry)}
            className="text-[10px] text-[#E8A87C]/60 hover:text-[#E8A87C] transition flex items-center gap-1 mt-1 font-mono cursor-pointer"
          >
            <Activity size={11} />
            <span>P4 실시간 오디오 관측 로그 {showTelemetry ? '▲' : '▼'}</span>
          </button>

          {showTelemetry && telemetry && (
            <div className="w-full mt-1.5 p-2 rounded-lg bg-[#251A17] border border-[#E8A87C]/20 text-[10px] font-mono text-[#F5EDE6]/80 flex flex-col gap-1 text-left">
              <div className="flex justify-between items-center border-b border-[#E8A87C]/10 pb-1">
                <span className="text-[#E8A87C]">Capture → Decimate</span>
                <span>{telemetry.captureSampleRate}Hz → {telemetry.targetSampleRate}Hz</span>
              </div>
              <div className="flex justify-between items-center">
                <span>Mic RMS (실시간 음량)</span>
                <span>{telemetry.micRms.toFixed(4)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span>Packets Sent (16k PCM)</span>
                <span>{telemetry.packetsSent} pkts</span>
              </div>
              <div className="flex justify-between items-center">
                <span>Echo Gate</span>
                <span className={telemetry.echoGateOpen ? 'text-emerald-400' : 'text-amber-400'}>
                  {telemetry.echoGateOpen ? 'OPEN (마이크 송출 중)' : 'CLOSED (스피커 보호 음소거)'}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span>First Sound Latency</span>
                <span>{telemetry.measuredLatencyMs ? `${telemetry.measuredLatencyMs}ms (실측)` : '-'}</span>
              </div>
              <div className="flex flex-col gap-0.5 pt-1 border-t border-[#E8A87C]/10">
                <span className="text-[#E8A87C]">Live Input Transcript:</span>
                <span className="text-white bg-black/40 p-1 rounded truncate">
                  {telemetry.lastInputTranscript || '(사용자 음성 대기 중...)'}
                </span>
              </div>
              <button
                onClick={() => engineRef.current?.playWavProof()}
                className="mt-1 w-full py-1 rounded bg-[#E8A87C]/20 hover:bg-[#E8A87C]/30 text-[#E8A87C] text-[10px] font-semibold flex items-center justify-center gap-1 transition cursor-pointer"
              >
                <Volume2 size={12} />
                <span>마이크 16kHz 변환 녹음 청취 (WAV 검증)</span>
              </button>
            </div>
          )}
        </div>

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

        {micStatus === 'denied' && (
          <div className="w-full mt-2 p-2.5 rounded-xl bg-[#E07070]/15 border border-[#E07070]/30 flex flex-col items-center text-center">
            <div className="flex items-center gap-1 text-[#E07070] text-xs font-semibold">
              <AlertCircle size={14} />
              마이크 사용 권한이 필요합니다
            </div>
            <p className="text-[11px] text-[#F5EDE6]/70 mt-1">
              브라우저 주소창 왼쪽 자물쇠/설정 아이콘에서 마이크 권한을 허용해 주세요.
            </p>
            <button
              onClick={retryMicPermission}
              className="mt-2 px-3 py-1 rounded-lg bg-[#E07070] text-white text-xs font-semibold hover:bg-[#c95e5e] transition"
            >
              마이크 다시 시도
            </button>
          </div>
        )}
      </div>

      {/* Center glowing orb and live transcript */}
      <div className="flex flex-col items-center justify-center my-auto py-2">
        <GlowingOrb
          mode={phaseToOrbMode(phase)}
          size={230}
          audioLevel={audioLevel}
        />

        {/* Live Audio Visualizer Bar when listening */}
        {phase === 'Listening' && !muted && (
          <div className="flex items-center gap-1 mt-4 h-5 px-3 py-1 rounded-full bg-[#2A1F1B]/60 border border-white/5">
            {[4, 8, 14, 20, 14, 8, 4].map((h, i) => {
              const activeH = Math.max(3, Math.min(22, Math.round(h * (0.3 + audioLevel * 1.5))));
              return (
                <div
                  key={i}
                  className="w-1 bg-[#E8A87C] rounded-full transition-all duration-75"
                  style={{ height: `${activeH}px`, opacity: 0.35 + audioLevel * 0.65 }}
                />
              );
            })}
          </div>
        )}

        {/* Live speech transcript */}
        <div className="min-h-14 flex items-center justify-center mt-3 px-4 text-center max-w-sm">
          {partialText ? (
            <p className="text-sm font-medium text-[#F5EDE6]/90 leading-relaxed bg-[#2A1F1B]/80 px-4 py-2.5 rounded-2xl border border-white/10 shadow-sm animate-pulse">
              {partialText}
            </p>
          ) : (
            <p className="text-xs text-[#F5EDE6]/40">
              {phase === 'Listening' && !muted
                ? (audioLevel > 0.15 ? '목소리가 입력되고 있습니다…' : '듣고 있어요, 편하게 말씀하세요')
                : phase === 'Thinking'
                ? '대답을 준비하고 있어요…'
                : ''}
            </p>
          )}
        </div>

        {errorMessage && (
          <div className="mt-2 text-xs text-[#E07070] text-center px-4 bg-[#E07070]/10 py-1 rounded-lg">
            {errorMessage}
          </div>
        )}
      </div>

      {/* Bottom Controls */}
      <div className="w-full flex flex-col items-center">
        {/* Quick Suggestion Chips */}
        <div className="w-full mb-3">
          <div className="flex items-center justify-center gap-1 mb-1.5 text-[11px] text-[#F5EDE6]/40">
            <Sparkles size={11} className="text-[#E8A87C]" />
            <span>추천 대화 (누르면 바로 말하기)</span>
          </div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {QUICK_PROMPTS.map((prompt, i) => (
              <button
                key={i}
                onClick={() => handleQuickPromptClick(prompt)}
                className="px-2.5 py-1 rounded-full bg-[#2A1F1B] border border-white/10 text-[11px] text-[#F5EDE6]/80 hover:text-[#E8A87C] hover:border-[#E8A87C]/30 active:scale-95 transition"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>

        {/* Toggleable manual speech test input */}
        <div className="w-full mb-4">
          <div className="flex justify-center mb-1">
            <button
              onClick={() => setShowSimulatedInput(!showSimulatedInput)}
              className="text-[11px] text-[#F5EDE6]/40 hover:text-[#E8A87C] flex items-center gap-1 transition"
            >
              <MessageSquare size={12} />
              {showSimulatedInput ? '직접 입력창 닫기' : '텍스트로 직접 말하기'}
            </button>
          </div>

          {showSimulatedInput && (
            <form onSubmit={handleSendManualSpeech} className="flex gap-2 mt-1">
              <input
                type="text"
                value={manualSpeechText}
                onChange={(e) => setManualSpeechText(e.target.value)}
                placeholder="한국어로 하고 싶은 말을 입력하세요"
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
        <div className="w-full flex items-center justify-around px-8 pb-2">
          {/* Mute button */}
          <div className="flex flex-col items-center">
            <button
              onClick={toggleMute}
              className={`w-16 h-16 rounded-full flex items-center justify-center transition-all cursor-pointer ${
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
