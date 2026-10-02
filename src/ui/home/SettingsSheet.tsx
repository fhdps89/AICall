import React, { useState, useRef, useEffect } from 'react';
import { X, Check, Sparkles, Volume2, Play, Square, Loader2, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { UserPreferences, AiEngineMode } from '../../data/UserPreferences';
import { TtsVoiceOption, VoiceGender, TtsVoice } from '../../types';
import { TTS_VOICE_LIST, getTtsVoice } from '../../voice/TtsVoice';
import { GeminiClient } from '../../voice/GeminiClient';

interface SettingsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export const SettingsSheet: React.FC<SettingsSheetProps> = ({ isOpen, onClose, onSaved }) => {
  const [nickname, setNickname] = useState(UserPreferences.getNickname());
  const [nicknameSavedNotice, setNicknameSavedNotice] = useState(false);

  // Engine mode
  const [engineMode] = useState<AiEngineMode>(UserPreferences.getPreferredEngine());

  // Gemini server status
  const [geminiStatus, setGeminiStatus] = useState<{ available: boolean; modelName?: string; defaultModel?: string } | null>(null);
  const [geminiTesting, setGeminiTesting] = useState(false);
  const [geminiTestResult, setGeminiTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Voice choice & gender filter
  const [selectedVoice, setSelectedVoice] = useState<TtsVoiceOption>(UserPreferences.getTtsVoiceOption());
  const [genderFilter, setGenderFilter] = useState<'all' | VoiceGender>('all');
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      GeminiClient.checkStatus().then((status) => {
        setGeminiStatus(status);
      });
    }
  }, [isOpen]);

  // Stop preview audio when sheet closes or unmounts
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const handleStopPreview = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setPreviewingVoice(null);
    setPreviewLoading(null);
  };

  const handleClose = () => {
    handleStopPreview();
    onClose();
  };

  if (!isOpen) return null;

  const currentVoice = getTtsVoice(selectedVoice);

  const handleSaveNickname = () => {
    UserPreferences.setNickname(nickname);
    setNicknameSavedNotice(true);
    setTimeout(() => setNicknameSavedNotice(false), 2000);
    onSaved();
  };

  const handleSelectVoice = (opt: TtsVoiceOption) => {
    setSelectedVoice(opt);
    UserPreferences.setTtsVoiceOption(opt);
    onSaved();
  };

  // Preview voice sample via Gemini 3.8 Flash-Lite TTS
  const handlePlayPreview = async (e: React.MouseEvent, voice: TtsVoice) => {
    e.stopPropagation();

    if (previewingVoice === voice.option) {
      handleStopPreview();
      return;
    }

    handleStopPreview();
    setPreviewLoading(voice.option);

    try {
      const res = await GeminiClient.executeTts(voice.sampleText, voice.voice);
      if (!res || !res.audioBase64) {
        throw new Error('음성 데이터 생성 실패');
      }

      const mimeType = res.mimeType || 'audio/wav';
      const audio = new Audio(`data:${mimeType};base64,${res.audioBase64}`);
      audioRef.current = audio;

      audio.onended = () => {
        setPreviewingVoice(null);
        setPreviewLoading(null);
        audioRef.current = null;
      };

      audio.onerror = () => {
        setPreviewingVoice(null);
        setPreviewLoading(null);
        audioRef.current = null;
      };

      setPreviewLoading(null);
      setPreviewingVoice(voice.option);
      await audio.play();
    } catch {
      handleStopPreview();
    }
  };

  const handleTestGeminiKey = async () => {
    setGeminiTesting(true);
    setGeminiTestResult(null);
    const res = await GeminiClient.testKey();
    setGeminiTesting(false);
    setGeminiTestResult({ ok: res.ok, text: res.label });
  };

  const filteredVoices = TTS_VOICE_LIST.filter((v) => {
    if (genderFilter === 'all') return true;
    return v.gender === genderFilter;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity">
      <div
        className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-[#2A1F1B] text-[#F5EDE6] p-6 shadow-2xl border border-white/5"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10 sticky top-0 bg-[#2A1F1B]/95 backdrop-blur z-10">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight text-[#F5EDE6]">통화 설정</h2>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#E8A87C]/15 text-[#E8A87C] font-medium">
              Gemini 2.5 Flash Native Audio
            </span>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-full text-[#F5EDE6]/60 hover:text-[#F5EDE6] hover:bg-white/5 transition-colors cursor-pointer"
            aria-label="닫기"
          >
            <X size={22} />
          </button>
        </div>

        <div className="py-4 space-y-6">
          {/* Active Voice Summary */}
          <div className="p-3.5 rounded-2xl bg-[#E8A87C]/10 border border-[#E8A87C]/25 flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="text-[11px] font-semibold text-[#E8A87C] uppercase tracking-wider flex items-center gap-1.5">
                <Volume2 size={13} />
                현재 선택된 목소리 & 캐릭터
              </div>
              <div className="text-sm font-bold text-[#F5EDE6]">
                {currentVoice.name} · <span className="text-[#E8A87C]">{currentVoice.vibe}</span>
              </div>
              <div className="text-xs text-[#F5EDE6]/60">
                {currentVoice.gender === 'female' ? '여성' : '남성'} · Gemini 2.5 Flash Native Audio
              </div>
            </div>
            <button
              onClick={(e) => handlePlayPreview(e, currentVoice)}
              className="px-3 py-1.5 rounded-xl bg-[#E8A87C] text-[#1A1210] text-xs font-bold hover:bg-[#d8976b] transition active:scale-95 flex items-center gap-1 shadow cursor-pointer shrink-0"
            >
              {previewLoading === currentVoice.option ? (
                <Loader2 size={13} className="animate-spin" />
              ) : previewingVoice === currentVoice.option ? (
                <>
                  <Square size={12} className="fill-current" />
                  정지
                </>
              ) : (
                <>
                  <Play size={12} className="fill-current" />
                  미리듣기
                </>
              )}
            </button>
          </div>

          {/* Nickname Setting */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-[#F5EDE6]/80">
              호칭 (AI가 나를 부를 이름)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="예: 민수, 지은, 친구"
                className="flex-1 px-4 py-2.5 rounded-xl bg-[#1A1210] border border-[#F5EDE6]/20 text-[#F5EDE6] placeholder-[#F5EDE6]/30 focus:outline-none focus:border-[#E8A87C] transition-colors text-sm"
              />
              <button
                onClick={handleSaveNickname}
                className="px-5 py-2.5 rounded-xl bg-[#E8A87C] text-[#1A1210] text-sm font-semibold hover:bg-[#d8976b] active:scale-95 transition cursor-pointer"
              >
                저장
              </button>
            </div>
            {nicknameSavedNotice && (
              <p className="text-xs text-[#E8A87C] flex items-center gap-1">
                <Check size={14} /> 호칭이 저장되었습니다.
              </p>
            )}
          </div>

          <div className="border-t border-white/10" />

          {/* Voice & Persona Selection */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-[#F5EDE6] flex items-center gap-1.5">
                  <Volume2 size={16} className="text-[#E8A87C]" />
                  AI 목소리 및 성별/분위기 선택
                </div>
                <div className="text-xs text-[#F5EDE6]/50 mt-0.5">
                  목소리 톤에 맞춰 AI의 말투와 대화 성격도 자동으로 어우러집니다.
                </div>
              </div>
            </div>

            {/* Gender Filter Chips */}
            <div className="flex items-center gap-1.5 p-1 rounded-xl bg-[#1A1210]/60 border border-white/5">
              <button
                type="button"
                onClick={() => setGenderFilter('all')}
                className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  genderFilter === 'all'
                    ? 'bg-[#E8A87C] text-[#1A1210] shadow'
                    : 'text-[#F5EDE6]/60 hover:text-[#F5EDE6] hover:bg-white/5'
                }`}
              >
                전체 (7개)
              </button>
              <button
                type="button"
                onClick={() => setGenderFilter('female')}
                className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center justify-center gap-1 ${
                  genderFilter === 'female'
                    ? 'bg-rose-500 text-white shadow'
                    : 'text-[#F5EDE6]/60 hover:text-[#F5EDE6] hover:bg-white/5'
                }`}
              >
                <span>여성 목소리</span>
                <span className="text-[10px] opacity-80">(4)</span>
              </button>
              <button
                type="button"
                onClick={() => setGenderFilter('male')}
                className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center justify-center gap-1 ${
                  genderFilter === 'male'
                    ? 'bg-sky-600 text-white shadow'
                    : 'text-[#F5EDE6]/60 hover:text-[#F5EDE6] hover:bg-white/5'
                }`}
              >
                <span>남성 목소리</span>
                <span className="text-[10px] opacity-80">(3)</span>
              </button>
            </div>

            {/* Voice Cards */}
            <div className="space-y-2.5">
              {filteredVoices.map((voice) => {
                const isSelected = selectedVoice === voice.option;
                const isPlaying = previewingVoice === voice.option;
                const isLoading = previewLoading === voice.option;

                return (
                  <div
                    key={voice.option}
                    onClick={() => handleSelectVoice(voice.option)}
                    className={`p-3.5 rounded-2xl border transition-all cursor-pointer ${
                      isSelected
                        ? 'border-[#E8A87C] bg-[#E8A87C]/12 shadow-sm ring-1 ring-[#E8A87C]/40'
                        : 'border-white/5 bg-[#1A1210]/40 hover:bg-[#1A1210]/80 hover:border-white/10'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${
                              voice.gender === 'female'
                                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                                : 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                            }`}
                          >
                            {voice.gender === 'female' ? '여성' : '남성'}
                          </span>
                          <span className={`text-sm font-bold ${isSelected ? 'text-[#E8A87C]' : 'text-[#F5EDE6]'}`}>
                            {voice.name}
                          </span>
                          <span className="text-xs text-[#E8A87C]/90 font-medium">
                            {voice.vibe}
                          </span>
                        </div>

                        <p className="text-xs text-[#F5EDE6]/70 leading-relaxed">
                          {voice.description}
                        </p>

                        <div className="flex items-center gap-2 pt-0.5">
                          <span className="text-[11px] text-[#F5EDE6]/40">
                            말투: <span className="text-[#F5EDE6]/60">{voice.personaStyle}</span>
                          </span>
                        </div>
                      </div>

                      {/* Preview Button */}
                      <button
                        type="button"
                        onClick={(e) => handlePlayPreview(e, voice)}
                        className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition active:scale-95 flex items-center gap-1.5 shrink-0 cursor-pointer ${
                          isPlaying
                            ? 'bg-rose-500 text-white animate-pulse'
                            : isSelected
                            ? 'bg-[#E8A87C] text-[#1A1210] hover:bg-[#d8976b]'
                            : 'bg-white/10 text-[#F5EDE6] hover:bg-white/20'
                        }`}
                      >
                        {isLoading ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : isPlaying ? (
                          <>
                            <Square size={11} className="fill-current" />
                            정지
                          </>
                        ) : (
                          <>
                            <Play size={11} className="fill-current" />
                            미리듣기
                          </>
                        )}
                      </button>
                    </div>

                    {/* Sample speech text preview */}
                    <div className="mt-2.5 pt-2 border-t border-white/5 text-[11px] text-[#F5EDE6]/50 italic">
                      "{voice.sampleText}"
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="border-t border-white/10" />

          {/* Engine & Advanced Connection */}
          <div className="space-y-3">
            <div className="text-sm font-bold text-[#F5EDE6] flex items-center gap-1.5">
              <Sparkles size={16} className="text-[#E8A87C]" />
              AI 연결 엔진 및 API 키
            </div>

            {/* Google Gemini Server Connection Card */}
            <div
              className={`p-3.5 rounded-2xl border transition-all ${
                engineMode === 'gemini' ? 'bg-[#E8A87C]/5 border-[#E8A87C]/30' : 'bg-[#1A1210]/40 border-white/5'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5 text-xs font-bold text-[#E8A87C]">
                  {geminiStatus?.modelName || 'Gemini 실시간 AI 음성 대화'}
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-semibold flex items-center gap-1">
                  <CheckCircle2 size={11} />
                  서버 연동 완료
                </span>
              </div>

              <div className="p-2.5 rounded-xl bg-[#1A1210] border border-white/5 space-y-1 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-[#F5EDE6]/50">실시간 통화 모델</span>
                  <span className="font-semibold text-[#E8A87C]">Gemini 3.8 Live / 2.5 Flash</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#F5EDE6]/50">통화 전송 프로토콜</span>
                  <span className="font-semibold text-[#E8A87C]">Live API (전이중 실시간 오디오)</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#F5EDE6]/50">서버 키 상태</span>
                  <span className="font-semibold text-emerald-400">정상 활성화됨</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-xs pt-2">
                <button
                  onClick={handleTestGeminiKey}
                  disabled={geminiTesting}
                  className="px-3.5 py-1.5 rounded-lg bg-[#E8A87C] text-[#1A1210] font-semibold hover:bg-[#dca074] cursor-pointer transition shadow flex items-center gap-1.5"
                >
                  {geminiTesting ? (
                    <>
                      <Loader2 size={13} className="animate-spin" />
                      연결 테스트 중…
                    </>
                  ) : (
                    <>
                      <RefreshCw size={13} />
                      Gemini 서버 연결 테스트
                    </>
                  )}
                </button>
              </div>

              {geminiTestResult && (
                <div
                  className={`text-xs p-2.5 rounded-lg mt-2 whitespace-pre-line leading-relaxed flex items-start gap-1.5 ${
                    geminiTestResult.ok
                      ? 'bg-[#E8A87C]/15 text-[#E8A87C] border border-[#E8A87C]/30'
                      : 'bg-[#E07070]/15 text-[#E07070] border border-[#E07070]/30'
                  }`}
                >
                  {geminiTestResult.ok ? <CheckCircle2 size={14} className="shrink-0 mt-0.5" /> : <AlertCircle size={14} className="shrink-0 mt-0.5" />}
                  <span>{geminiTestResult.text}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="pt-4 border-t border-white/10 flex justify-end sticky bottom-0 bg-[#2A1F1B]/95 backdrop-blur">
          <button
            onClick={handleClose}
            className="px-6 py-2.5 rounded-xl bg-[#E8A87C] text-[#1A1210] font-bold hover:bg-[#d8976b] active:scale-95 transition cursor-pointer shadow"
          >
            설정 완료
          </button>
        </div>
      </div>
    </div>
  );
};
