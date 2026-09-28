import React, { useState } from 'react';
import { Eye, EyeOff, X, Check } from 'lucide-react';
import { UserPreferences } from '../../data/UserPreferences';
import { TtsVoiceOption } from '../../types';
import { TTS_VOICE_LIST, getTtsVoice } from '../../voice/TtsVoice';
import { GeminiClient } from '../../voice/GeminiClient';
import { OpenRouterClient } from '../../voice/OpenRouterClient';

interface SettingsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export const SettingsSheet: React.FC<SettingsSheetProps> = ({ isOpen, onClose, onSaved }) => {
  const [nickname, setNickname] = useState(UserPreferences.getNickname());
  const [nicknameSavedNotice, setNicknameSavedNotice] = useState(false);

  // OpenRouter state
  const [orKey, setOrKey] = useState(UserPreferences.getOpenRouterApiKey() || '');
  const [orEditing, setOrEditing] = useState(false);
  const [orDraft, setOrDraft] = useState('');
  const [orVisible, setOrVisible] = useState(false);
  const [orTesting, setOrTesting] = useState(false);
  const [orTestResult, setOrTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Gemini state
  const [geminiKey, setGeminiKey] = useState(UserPreferences.getGeminiApiKey() || '');
  const [geminiEditing, setGeminiEditing] = useState(false);
  const [geminiDraft, setGeminiDraft] = useState('');
  const [geminiVisible, setGeminiVisible] = useState(false);
  const [geminiTesting, setGeminiTesting] = useState(false);
  const [geminiTestResult, setGeminiTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Voice choice
  const [selectedVoice, setSelectedVoice] = useState<TtsVoiceOption>(UserPreferences.getTtsVoiceOption());

  if (!isOpen) return null;

  const currentVoiceName = UserPreferences.getVoiceDisplayName();

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

  // OpenRouter key actions
  const handleSaveOrKey = () => {
    UserPreferences.setOpenRouterApiKey(orDraft);
    setOrKey(UserPreferences.getOpenRouterApiKey() || '');
    setOrEditing(false);
    setOrDraft('');
    setOrTestResult(null);
    onSaved();
  };

  const handleClearOrKey = () => {
    UserPreferences.setOpenRouterApiKey(null);
    setOrKey('');
    setOrEditing(false);
    setOrDraft('');
    setOrTestResult(null);
    onSaved();
  };

  const handleTestOrKey = async (keyToTest: string) => {
    setOrTesting(true);
    setOrTestResult(null);
    const voice = getTtsVoice(selectedVoice);
    const res = await OpenRouterClient.testKey(keyToTest, voice);
    setOrTesting(false);
    setOrTestResult({ ok: res.ok, text: res.label });
  };

  // Gemini key actions
  const handleSaveGeminiKey = () => {
    UserPreferences.setGeminiApiKey(geminiDraft);
    setGeminiKey(UserPreferences.getGeminiApiKey() || '');
    setGeminiEditing(false);
    setGeminiDraft('');
    setGeminiTestResult(null);
    onSaved();
  };

  const handleClearGeminiKey = () => {
    UserPreferences.setGeminiApiKey(null);
    setGeminiKey('');
    setGeminiEditing(false);
    setGeminiDraft('');
    setGeminiTestResult(null);
    onSaved();
  };

  const handleTestGeminiKey = async (keyToTest: string) => {
    setGeminiTesting(true);
    setGeminiTestResult(null);
    const res = await GeminiClient.testKey(keyToTest);
    setGeminiTesting(false);
    setGeminiTestResult({ ok: res.ok, text: res.label });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity">
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-[#2A1F1B] text-[#F5EDE6] p-6 shadow-2xl border border-white/5"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10">
          <h2 className="text-xl font-bold tracking-tight text-[#F5EDE6]">설정</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-full text-[#F5EDE6]/60 hover:text-[#F5EDE6] hover:bg-white/5 transition-colors"
            aria-label="닫기"
          >
            <X size={22} />
          </button>
        </div>

        <div className="py-4 space-y-6">
          {/* Current Voice */}
          <div>
            <div className="text-sm text-[#F5EDE6]/60">지금 목소리</div>
            <div className="text-base font-semibold text-[#E8A87C] mt-1">{currentVoiceName}</div>
          </div>

          {/* Nickname */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-[#F5EDE6]/80">
              호칭 (AI가 부를 이름)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="예: 민수, 엄마, 친구"
                className="flex-1 px-4 py-2.5 rounded-xl bg-[#1A1210] border border-[#F5EDE6]/20 text-[#F5EDE6] placeholder-[#F5EDE6]/30 focus:outline-none focus:border-[#E8A87C] transition-colors"
              />
              <button
                onClick={handleSaveNickname}
                className="px-5 py-2.5 rounded-xl bg-[#E8A87C] text-[#1A1210] font-medium hover:bg-[#d8976b] active:scale-95 transition"
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

          {/* OpenRouter Key Section */}
          <div className="space-y-2">
            <div
              className={`p-3 rounded-xl bg-[#1A1210]/60 border border-white/5 ${
                !orEditing ? 'cursor-pointer hover:bg-white/5 transition-colors' : ''
              }`}
              onClick={() => {
                if (!orEditing) {
                  setOrDraft(orKey);
                  setOrEditing(true);
                }
              }}
            >
              <div className="text-sm font-medium text-[#F5EDE6]/70">
                AI 키 설정 (테스트용) · OpenRouter
              </div>
              <div className="text-sm font-semibold text-[#E8A87C] mt-0.5">
                {orKey ? UserPreferences.maskKey(orKey) : '설정 안 됨 · 누르면 입력'}
              </div>
              <div className="text-xs text-[#F5EDE6]/50 mt-1">
                대화: {OpenRouterClient.CHAT_MODEL} · 목소리도 이 키로
              </div>
            </div>

            {orEditing ? (
              <div className="p-3 rounded-xl bg-[#1A1210] border border-[#E8A87C]/40 space-y-3 mt-2">
                <div className="relative flex items-center">
                  <input
                    type={orVisible ? 'text' : 'password'}
                    value={orDraft}
                    onChange={(e) => setOrDraft(e.target.value)}
                    placeholder="OpenRouter 키 붙여넣기 (sk-or-…)"
                    className="w-full px-3 py-2 pr-20 rounded-lg bg-[#241A17] border border-white/10 text-sm text-[#F5EDE6] focus:outline-none focus:border-[#E8A87C]"
                  />
                  <div className="absolute right-2 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setOrVisible(!orVisible)}
                      className="p-1 text-[#F5EDE6]/50 hover:text-[#F5EDE6]"
                      title={orVisible ? '키 숨기기' : '키 보기'}
                    >
                      {orVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const text = await navigator.clipboard.readText();
                          if (text) setOrDraft(text.trim());
                        } catch {
                          // Clipboard permission
                        }
                      }}
                      className="text-xs px-2 py-1 rounded bg-[#E8A87C]/20 text-[#E8A87C] hover:bg-[#E8A87C]/30"
                    >
                      붙여넣기
                    </button>
                  </div>
                </div>

                <p className="text-xs text-[#F5EDE6]/50">키는 이 기기(브라우저)에만 저장됩니다.</p>

                <div className="flex justify-end gap-2 text-xs">
                  <button
                    onClick={() => {
                      setOrEditing(false);
                      setOrDraft('');
                    }}
                    className="px-3 py-1.5 rounded-lg text-[#F5EDE6]/60 hover:text-[#F5EDE6]"
                  >
                    취소
                  </button>
                  <button
                    onClick={() => handleTestOrKey(orDraft)}
                    disabled={!orDraft.trim() || orTesting}
                    className="px-3 py-1.5 rounded-lg bg-white/10 text-[#F5EDE6] hover:bg-white/20 disabled:opacity-40"
                  >
                    {orTesting ? '테스트 중…' : '키 테스트'}
                  </button>
                  <button
                    onClick={handleSaveOrKey}
                    disabled={!orDraft.trim()}
                    className="px-3 py-1.5 rounded-lg bg-[#E8A87C] text-[#1A1210] font-medium hover:bg-[#d8976b] disabled:opacity-40"
                  >
                    키 저장
                  </button>
                </div>
              </div>
            ) : orKey ? (
              <div className="flex gap-2 text-xs pt-1">
                <button
                  onClick={() => handleTestOrKey(orKey)}
                  disabled={orTesting}
                  className="px-3 py-1 rounded-lg bg-[#E8A87C]/15 text-[#E8A87C] hover:bg-[#E8A87C]/25"
                >
                  {orTesting ? '테스트 중…' : '키 테스트'}
                </button>
                <button
                  onClick={() => {
                    setOrDraft(orKey);
                    setOrEditing(true);
                  }}
                  className="px-3 py-1 rounded-lg bg-white/5 text-[#F5EDE6]/70 hover:bg-white/10"
                >
                  키 변경
                </button>
                <button
                  onClick={handleClearOrKey}
                  className="px-3 py-1 rounded-lg bg-white/5 text-[#E07070] hover:bg-[#E07070]/15"
                >
                  키 삭제
                </button>
              </div>
            ) : null}

            {orTestResult && (
              <div
                className={`text-xs p-2.5 rounded-lg mt-2 whitespace-pre-line leading-relaxed ${
                  orTestResult.ok
                    ? 'bg-[#E8A87C]/15 text-[#E8A87C] border border-[#E8A87C]/30'
                    : 'bg-[#E07070]/15 text-[#E07070] border border-[#E07070]/30'
                }`}
              >
                {orTestResult.text}
              </div>
            )}
          </div>

          {/* Voice Choice Section */}
          <div className="space-y-2 pt-1">
            <div className="text-sm text-[#F5EDE6]/70 font-medium">목소리 선택 (테스트용)</div>
            <div className="space-y-2">
              {TTS_VOICE_LIST.map((voice) => {
                const isSelected = selectedVoice === voice.option;
                return (
                  <label
                    key={voice.option}
                    onClick={() => handleSelectVoice(voice.option)}
                    className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition ${
                      isSelected
                        ? 'border-[#E8A87C] bg-[#E8A87C]/10'
                        : 'border-white/5 bg-[#1A1210]/40 hover:bg-white/5'
                    }`}
                  >
                    <input
                      type="radio"
                      name="voiceOption"
                      checked={isSelected}
                      onChange={() => handleSelectVoice(voice.option)}
                      className="mt-1 accent-[#E8A87C]"
                    />
                    <div>
                      <div className={`text-sm font-medium ${isSelected ? 'text-[#E8A87C]' : 'text-[#F5EDE6]'}`}>
                        {voice.shortLabel}
                      </div>
                      <div className="text-xs text-[#F5EDE6]/50">{voice.description}</div>
                    </div>
                  </label>
                );
              })}
            </div>
            {!orKey && (
              <p className="text-xs text-[#F5EDE6]/40 pt-1">
                OpenRouter 키가 있어야 이 목소리로 말해요. 없으면 기본 음성.
              </p>
            )}
          </div>

          <div className="border-t border-white/10" />

          {/* Gemini Key Section */}
          <div className="space-y-2">
            <div
              className={`p-3 rounded-xl bg-[#1A1210]/60 border border-white/5 ${
                !geminiEditing ? 'cursor-pointer hover:bg-white/5 transition-colors' : ''
              }`}
              onClick={() => {
                if (!geminiEditing) {
                  setGeminiDraft(geminiKey);
                  setGeminiEditing(true);
                }
              }}
            >
              <div className="text-sm font-medium text-[#F5EDE6]/70">
                예비 Gemini 키 (OpenRouter 키 없을 때만)
              </div>
              <div className="text-sm font-semibold text-[#E8A87C] mt-0.5">
                {geminiKey ? UserPreferences.maskKey(geminiKey) : '설정 안 됨 · 누르면 입력'}
              </div>
              <div className="text-xs text-[#F5EDE6]/50 mt-1">
                모델: {GeminiClient.MODEL_ID} · 기본 음성
              </div>
            </div>

            {geminiEditing ? (
              <div className="p-3 rounded-xl bg-[#1A1210] border border-[#E8A87C]/40 space-y-3 mt-2">
                <div className="relative flex items-center">
                  <input
                    type={geminiVisible ? 'text' : 'password'}
                    value={geminiDraft}
                    onChange={(e) => setGeminiDraft(e.target.value)}
                    placeholder="Gemini API 키 붙여넣기"
                    className="w-full px-3 py-2 pr-20 rounded-lg bg-[#241A17] border border-white/10 text-sm text-[#F5EDE6] focus:outline-none focus:border-[#E8A87C]"
                  />
                  <div className="absolute right-2 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setGeminiVisible(!geminiVisible)}
                      className="p-1 text-[#F5EDE6]/50 hover:text-[#F5EDE6]"
                      title={geminiVisible ? '키 숨기기' : '키 보기'}
                    >
                      {geminiVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const text = await navigator.clipboard.readText();
                          if (text) setGeminiDraft(text.trim());
                        } catch {
                          // Clipboard permission
                        }
                      }}
                      className="text-xs px-2 py-1 rounded bg-[#E8A87C]/20 text-[#E8A87C] hover:bg-[#E8A87C]/30"
                    >
                      붙여넣기
                    </button>
                  </div>
                </div>

                <p className="text-xs text-[#F5EDE6]/50">키는 이 기기(브라우저)에만 저장됩니다.</p>

                <div className="flex justify-end gap-2 text-xs">
                  <button
                    onClick={() => {
                      setGeminiEditing(false);
                      setGeminiDraft('');
                    }}
                    className="px-3 py-1.5 rounded-lg text-[#F5EDE6]/60 hover:text-[#F5EDE6]"
                  >
                    취소
                  </button>
                  <button
                    onClick={() => handleTestGeminiKey(geminiDraft)}
                    disabled={!geminiDraft.trim() || geminiTesting}
                    className="px-3 py-1.5 rounded-lg bg-white/10 text-[#F5EDE6] hover:bg-white/20 disabled:opacity-40"
                  >
                    {geminiTesting ? '테스트 중…' : '키 테스트'}
                  </button>
                  <button
                    onClick={handleSaveGeminiKey}
                    disabled={!geminiDraft.trim()}
                    className="px-3 py-1.5 rounded-lg bg-[#E8A87C] text-[#1A1210] font-medium hover:bg-[#d8976b] disabled:opacity-40"
                  >
                    키 저장
                  </button>
                </div>
              </div>
            ) : geminiKey ? (
              <div className="flex gap-2 text-xs pt-1">
                <button
                  onClick={() => handleTestGeminiKey(geminiKey)}
                  disabled={geminiTesting}
                  className="px-3 py-1 rounded-lg bg-[#E8A87C]/15 text-[#E8A87C] hover:bg-[#E8A87C]/25"
                >
                  {geminiTesting ? '테스트 중…' : '키 테스트'}
                </button>
                <button
                  onClick={() => {
                    setGeminiDraft(geminiKey);
                    setGeminiEditing(true);
                  }}
                  className="px-3 py-1 rounded-lg bg-white/5 text-[#F5EDE6]/70 hover:bg-white/10"
                >
                  키 변경
                </button>
                <button
                  onClick={handleClearGeminiKey}
                  className="px-3 py-1 rounded-lg bg-white/5 text-[#E07070] hover:bg-[#E07070]/15"
                >
                  키 삭제
                </button>
              </div>
            ) : null}

            {geminiTestResult && (
              <div
                className={`text-xs p-2.5 rounded-lg mt-2 whitespace-pre-line ${
                  geminiTestResult.ok
                    ? 'bg-[#E8A87C]/15 text-[#E8A87C] border border-[#E8A87C]/30'
                    : 'bg-[#E07070]/15 text-[#E07070] border border-[#E07070]/30'
                }`}
              >
                {geminiTestResult.text}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="pt-4 border-t border-white/10 flex justify-end">
          <button
            onClick={onClose}
            className="px-6 py-2.5 rounded-xl bg-white/10 text-[#F5EDE6] font-medium hover:bg-white/15 transition"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
};
