import React, { useEffect, useState, useRef, useCallback } from 'react';
import { PhoneOff, MessageSquare, Volume2, Sparkles, ChevronDown, ChevronUp, Subtitles, HelpCircle } from 'lucide-react';
import { GlowingOrb, phaseToOrbMode } from '../components/GlowingOrb';
import { VoiceCallEngine, MicStatus, P4Telemetry, VoiceCallContext } from '../../voice/VoiceCallEngine';
import { UserPreferences } from '../../data/UserPreferences';
import { CallPhase, ReplyLatency, ReplyOrigin, getReplyOriginLabel, TrackId } from '../../types';
import { getTtsVoice } from '../../voice/TtsVoice';
import { TRACK_CONFIGS } from '../../data/curriculums';

interface CallScreenProps {
  trackId: TrackId;
  lessonNum: number;
  lessonTitle: string;
  onHangUp: (turns: Array<{ role: 'user' | 'model'; text: string; timestamp: number }>) => void;
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export const CallScreen: React.FC<CallScreenProps> = ({
  trackId,
  lessonNum,
  lessonTitle,
  onHangUp,
}) => {
  const [phase, setPhase] = useState<CallPhase>('Idle');
  const [muted, setMuted] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [partialText, setPartialText] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [micStatus, setMicStatus] = useState<MicStatus>('requesting');
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [showCommands, setShowCommands] = useState(false);
  const [manualText, setManualText] = useState('');
  const [showManualInput, setShowManualInput] = useState(false);

  const track = TRACK_CONFIGS[trackId] || TRACK_CONFIGS.opic;
  const currentLesson = track.lessons.find((l) => l.lessonNum === lessonNum) || track.lessons[0];

  const engineRef = useRef<VoiceCallEngine | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const handleHangUp = useCallback(() => {
    let turns: Array<{ role: 'user' | 'model'; text: string; timestamp: number }> = [];
    if (engineRef.current) {
      turns = engineRef.current.getConversationTurns();
      engineRef.current.stop();
      engineRef.current = null;
    }
    onHangUp(turns);
  }, [onHangUp]);

  useEffect(() => {
    const callStartedAt = performance.now();
    const timerInterval = setInterval(() => {
      setElapsedMs(performance.now() - callStartedAt);
    }, 250);

    const callContext: VoiceCallContext = {
      trackId,
      lessonNum,
      lessonTitle,
      systemInstruction: track.systemPrompt,
      starterPrompt: currentLesson?.starterPrompt || `(The phone call is connected. Greet the learner in English, announce Lesson ${lessonNum}: "${lessonTitle}", and ask the opening question.)`,
      voiceName: track.accentVoice || 'Puck',
      languageCode: trackId === 'bluey' || (trackId === 'travel' && lessonNum >= 8) ? 'en-AU' : 'en-US',
    };

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
        onLatency: () => {},
        onReplyOrigin: () => {},
        onVoiceInfo: () => {},
        onVoiceFailure: () => {},
        onAudioLevel: (level) => setAudioLevel(level),
        onMicStatus: (status) => setMicStatus(status),
        onP4Telemetry: () => {},
      },
      callContext
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
  }, [handleHangUp, trackId, lessonNum, lessonTitle, track, currentLesson]);

  const sendVoiceCommand = (cmd: string) => {
    engineRef.current?.injectUserSpeech(cmd);
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualText.trim()) return;
    engineRef.current?.injectUserSpeech(manualText.trim());
    setManualText('');
  };

  const getPhaseDisplay = () => {
    if (muted) return '음소거 됨';
    switch (phase) {
      case 'Listening':
        return audioLevel > 0.15 ? '원어민 튜터가 듣는 중…' : '말씀하세요 (영어)';
      case 'Thinking':
        return 'AI 튜터 생각 중…';
      case 'Speaking':
      case 'Greeting':
        return 'AI 튜터 말하는 중…';
      case 'Ended':
        return '통화 종료';
      default:
        return '통화 연결 중…';
    }
  };

  return (
    <div className="relative min-h-screen w-full bg-[#0F141C] text-slate-100 flex flex-col justify-between px-5 py-6 select-none max-w-md mx-auto">
      {/* Top Header / Lesson Meta */}
      <div className="w-full flex flex-col items-center pt-2 space-y-2">
        {/* Track Badge & Lesson Number */}
        <div className="flex items-center gap-2">
          <span className="px-3 py-1 rounded-full bg-slate-800/80 border border-slate-700/60 text-xs font-semibold text-amber-300 flex items-center gap-1.5 shadow-sm">
            <span>{track.emoji}</span>
            <span>{track.shortName}</span>
            <span aria-hidden="true">·</span>
            <span>Lesson {lessonNum}</span>
          </span>
          <span className="text-[11px] text-slate-400 font-mono">
            {currentLesson?.targetMinutes || 25}분 목표
          </span>
        </div>

        {/* Lesson Title */}
        <h2 className="text-base font-bold text-center text-white px-2 truncate max-w-full">
          {lessonTitle}
        </h2>

        {/* Timer */}
        <div className="text-3xl font-extrabold tracking-tight text-white font-mono tabular-nums">
          {formatElapsed(elapsedMs)}
        </div>

        {/* Phase Indicator */}
        <div className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${micStatus === 'active' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
          <span>{getPhaseDisplay()}</span>
        </div>
      </div>

      {/* Center Glowing Orb & Subtitles */}
      <div className="flex flex-col items-center justify-center my-auto py-4 relative">
        <GlowingOrb
          mode={phaseToOrbMode(phase)}
          size={190}
          audioLevel={audioLevel}
        />

        {/* Real-time Subtitles */}
        {showSubtitles && partialText && (
          <div className="mt-5 w-full max-w-xs bg-slate-900/90 border border-slate-800 rounded-2xl p-3 text-center shadow-xl animate-fade-in backdrop-blur-sm">
            <p className="text-xs text-slate-200 leading-relaxed font-medium">
              "{partialText}"
            </p>
          </div>
        )}

        {/* Subtitle toggle button */}
        <button
          onClick={() => setShowSubtitles(!showSubtitles)}
          className={`mt-3 px-3 py-1 rounded-full text-[11px] font-medium border transition flex items-center gap-1 cursor-pointer ${
            showSubtitles
              ? 'bg-slate-800 text-amber-300 border-slate-700'
              : 'bg-transparent text-slate-500 border-slate-800'
          }`}
        >
          <Subtitles size={12} />
          <span>{showSubtitles ? '실시간 자막 켜짐' : '자막 숨김'}</span>
        </button>
      </div>

      {/* Bottom Command Center */}
      <div className="w-full flex flex-col items-center space-y-3 pb-2">
        {/* Quick Voice Command Buttons (1-Tap Convenience) */}
        <div className="w-full">
          <div className="flex items-center justify-between text-xs text-slate-400 px-1 mb-1.5">
            <span className="font-semibold text-slate-300 flex items-center gap-1">
              <Sparkles size={13} className="text-amber-400" />
              <span>실시간 음성 명령어 (원터치)</span>
            </span>
            <button
              onClick={() => setShowCommands(!showCommands)}
              className="text-[11px] text-amber-400 flex items-center gap-0.5 cursor-pointer hover:underline"
            >
              <span>{showCommands ? '접기' : '더보기'}</span>
              {showCommands ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          </div>

          {/* Primary Quick Buttons */}
          <div className="grid grid-cols-3 gap-2 text-xs">
            {trackId === 'opic' ? (
              <>
                <button
                  onClick={() => sendVoiceCommand('Answer starts.')}
                  className="py-2 px-2.5 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-slate-200 border border-slate-700 font-medium active:scale-95 transition cursor-pointer text-center"
                >
                  ⏱️ "Answer starts"
                </button>
                <button
                  onClick={() => sendVoiceCommand('Done.')}
                  className="py-2 px-2.5 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-slate-200 border border-slate-700 font-medium active:scale-95 transition cursor-pointer text-center"
                >
                  ✅ "Done."
                </button>
                <button
                  onClick={() => sendVoiceCommand('Model answer, please.')}
                  className="py-2 px-2.5 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-slate-200 border border-slate-700 font-medium active:scale-95 transition cursor-pointer text-center"
                >
                  🌟 "Model answer"
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => sendVoiceCommand('Pause.')}
                  className="py-2 px-2.5 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-slate-200 border border-slate-700 font-medium active:scale-95 transition cursor-pointer text-center"
                >
                  ⏸️ "Pause" (피드백)
                </button>
                <button
                  onClick={() => sendVoiceCommand('How would a native say that?')}
                  className="py-2 px-2.5 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-slate-200 border border-slate-700 font-medium active:scale-95 transition cursor-pointer text-center"
                >
                  💡 "원어민 표현은?"
                </button>
                <button
                  onClick={() => sendVoiceCommand('Next lesson.')}
                  className="py-2 px-2.5 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-slate-200 border border-slate-700 font-medium active:scale-95 transition cursor-pointer text-center"
                >
                  👉 "Next lesson"
                </button>
              </>
            )}
          </div>

          {/* Secondary Expanded Buttons */}
          {showCommands && (
            <div className="grid grid-cols-3 gap-2 mt-2 text-xs animate-fade-in">
              <button
                onClick={() => sendVoiceCommand('Slower, please.')}
                className="py-1.5 px-2 rounded-lg bg-slate-900/80 text-slate-400 hover:text-white border border-slate-800 active:scale-95 transition cursor-pointer"
              >
                🐢 "천천히 말해줘"
              </button>
              <button
                onClick={() => sendVoiceCommand('Speak at natural native speed now.')}
                className="py-1.5 px-2 rounded-lg bg-slate-900/80 text-slate-400 hover:text-white border border-slate-800 active:scale-95 transition cursor-pointer"
              >
                🐇 "원어민 원래 속도"
              </button>
              <button
                onClick={() => sendVoiceCommand('Korean please.')}
                className="py-1.5 px-2 rounded-lg bg-slate-900/80 text-slate-400 hover:text-white border border-slate-800 active:scale-95 transition cursor-pointer"
              >
                🇰🇷 "한국어로 설명"
              </button>
            </div>
          )}
        </div>

        {/* Manual Keyboard Input Option (In case user is in public space) */}
        {showManualInput ? (
          <form onSubmit={handleManualSubmit} className="w-full flex items-center gap-1.5">
            <input
              type="text"
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              placeholder="영어로 타이핑하여 말하기..."
              className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-400"
            />
            <button
              type="submit"
              className="px-3 py-2 bg-amber-500 text-slate-950 font-bold rounded-xl text-xs"
            >
              전송
            </button>
          </form>
        ) : (
          <button
            onClick={() => setShowManualInput(true)}
            className="text-[11px] text-slate-500 hover:text-slate-300 cursor-pointer"
          >
            키보드로 타이핑해서 말하기
          </button>
        )}

        {/* Primary Action Button: End Call & Generate Mistake Review */}
        <button
          onClick={handleHangUp}
          className="w-full h-14 rounded-2xl bg-red-600 hover:bg-red-500 active:scale-[0.98] text-white font-bold text-base shadow-lg shadow-red-600/30 flex items-center justify-center gap-2 transition cursor-pointer"
        >
          <PhoneOff size={20} />
          <span>통화 종료 & 복기 리포트 생성</span>
        </button>
      </div>
    </div>
  );
};
