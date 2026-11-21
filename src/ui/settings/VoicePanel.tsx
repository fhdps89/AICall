import React, { useEffect, useRef, useState } from "react";
import { Volume2, Square, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import {
  DEFAULT_VOICE,
  PREVIEW_PHRASE,
  VOICE_OPTIONS,
  type VoiceId,
} from "../../config/voices";
import { authFetch } from "../../services/api/authFetch";
import { toPlayableAudioUrl } from "../../services/settings/audioPlayable";
import {
  getPreferredVoice,
  setPreferredVoice,
} from "../../services/settings/voicePreferenceDefault";

interface VoicePanelProps {
  userId?: string;
}

export const VoicePanel: React.FC<VoicePanelProps> = ({ userId }) => {
  const [selectedVoice, setSelectedVoice] = useState<VoiceId>(DEFAULT_VOICE);
  const [loading, setLoading] = useState<boolean>(true);
  const [previewingVoice, setPreviewingVoice] = useState<VoiceId | null>(null);
  const [loadingPreviewVoice, setLoadingPreviewVoice] = useState<VoiceId | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewSeqRef = useRef<number>(0);
  const userTouchedRef = useRef<boolean>(false);

  const stopPreview = () => {
    previewSeqRef.current += 1;
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current = null;
    }
    setPreviewingVoice(null);
    setLoadingPreviewVoice(null);
  };

  useEffect(() => {
    let cancelled = false;
    userTouchedRef.current = false;
    setLoading(true);
    getPreferredVoice(userId)
      .then((voice) => {
        if (!cancelled && !userTouchedRef.current) {
          setSelectedVoice(voice);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    return () => {
      stopPreview();
    };
  }, []);

  const handleSelectVoice = (voiceId: VoiceId) => {
    userTouchedRef.current = true;
    setSelectedVoice(voiceId);
    setPreferredVoice(userId, voiceId).catch((err) => {
      console.warn("[VoicePanel] Failed to save voice preference:", err);
    });
  };

  const handlePreview = async (voiceId: VoiceId) => {
    if (previewingVoice === voiceId || loadingPreviewVoice === voiceId) {
      stopPreview();
      return;
    }

    stopPreview();
    const seq = previewSeqRef.current;
    setPreviewError(null);
    setLoadingPreviewVoice(voiceId);

    try {
      const res = await authFetch("/api/gemini/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: PREVIEW_PHRASE,
          voiceName: voiceId,
        }),
      });
      if (!res.ok) {
        throw new Error(`Preview request failed (${res.status})`);
      }
      const data = await res.json();
      if (seq !== previewSeqRef.current) return;
      if (!data?.audioBase64) {
        throw new Error("Missing preview audio");
      }

      const audioUrl = toPlayableAudioUrl(data.mimeType, data.audioBase64);
      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      audio.onended = () => {
        if (seq !== previewSeqRef.current) return;
        audioRef.current = null;
        setPreviewingVoice(null);
      };
      audio.onerror = () => {
        if (seq !== previewSeqRef.current) return;
        audioRef.current = null;
        setPreviewingVoice(null);
        setPreviewError("미리 듣기를 못 했어요. 잠시 후 다시 시도해 주세요.");
      };

      setLoadingPreviewVoice(null);
      setPreviewingVoice(voiceId);
      await audio.play();
    } catch {
      if (seq !== previewSeqRef.current) return;
      stopPreview();
      setPreviewError("미리 듣기를 못 했어요. 잠시 후 다시 시도해 주세요.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/25 text-xs text-amber-200 space-y-1">
        <p className="font-semibold">다음 통화부터 적용돼요. 통화 중에는 바뀌지 않아요.</p>
        <p className="text-[11px] text-amber-300/80">
          목소리는 하나로 고정해 보내지만, 드물게 음색이 달라 들릴 수 있어요.
        </p>
      </div>

      {previewError && (
        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
          <span>{previewError}</span>
        </div>
      )}

      {loading ? (
        <div className="py-6 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>목소리 설정을 불러오는 중...</span>
        </div>
      ) : (
        <div role="radiogroup" aria-label="AI 목소리 선택" className="space-y-2.5">
          {VOICE_OPTIONS.map((option) => {
            const isSelected = selectedVoice === option.id;
            const isLoadingPreview = loadingPreviewVoice === option.id;
            const isPlaying = previewingVoice === option.id;

            return (
              <div
                key={option.id}
                className={`p-3.5 rounded-xl border transition-colors flex items-center justify-between gap-3 ${
                  isSelected
                    ? "bg-amber-500/10 border-amber-400/60"
                    : "bg-slate-900/60 border-slate-800 hover:border-slate-700"
                }`}
              >
                <label className="flex items-center gap-3 flex-1 cursor-pointer min-w-0">
                  <input
                    type="radio"
                    name="ai-voice"
                    value={option.id}
                    checked={isSelected}
                    onChange={() => handleSelectVoice(option.id)}
                    className="w-4 h-4 accent-amber-500 cursor-pointer shrink-0"
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold text-white">{option.label}</span>
                      {isSelected && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-semibold">
                          <CheckCircle2 className="w-3 h-3" />
                          선택됨
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5">{option.desc}</p>
                  </div>
                </label>

                <button
                  type="button"
                  onClick={() => handlePreview(option.id)}
                  disabled={isLoadingPreview}
                  className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold flex items-center gap-1.5 shrink-0 cursor-pointer transition-colors disabled:opacity-60 ${
                    isPlaying
                      ? "bg-amber-500 text-slate-950"
                      : "bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                  }`}
                >
                  {isLoadingPreview ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>준비 중</span>
                    </>
                  ) : isPlaying ? (
                    <>
                      <Square className="w-3 h-3 fill-current" />
                      <span>정지</span>
                    </>
                  ) : (
                    <>
                      <Volume2 className="w-3.5 h-3.5" />
                      <span>미리 듣기</span>
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
