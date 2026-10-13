import React, { useState, useEffect, useRef } from 'react';
import { MorningPodcast, MistakeItem } from '../../types';
import { AppStorage } from '../../data/storage';
import { Play, Pause, RotateCcw, RotateCw, Send, Check, X, Headphones, Sparkles, Loader2 } from 'lucide-react';

interface MorningPodcastModalProps {
  isOpen: boolean;
  onClose: () => void;
  onMistakesUpdated?: () => void;
}

export const MorningPodcastModal: React.FC<MorningPodcastModalProps> = ({
  isOpen,
  onClose,
  onMistakesUpdated,
}) => {
  const [loading, setLoading] = useState(false);
  const [podcast, setPodcast] = useState<MorningPodcast | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [telegramStatus, setTelegramStatus] = useState<string | null>(null);
  const [markedDone, setMarkedDone] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (isOpen && !podcast) {
      loadOrCreatePodcast();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const loadOrCreatePodcast = async () => {
    // Check existing recent podcast
    const existing = AppStorage.getPodcasts();
    const today = new Date().toISOString().slice(0, 10);
    const todayPod = existing.find((p) => p.date === today);

    if (todayPod) {
      setPodcast(todayPod);
      return;
    }

    // Generate new podcast from unreviewed mistakes
    await handleGenerateNewPodcast();
  };

  const handleGenerateNewPodcast = async () => {
    setLoading(true);
    setTelegramStatus(null);
    setMarkedDone(false);

    try {
      const mistakes = AppStorage.getUnreviewedMistakes();
      const res = await fetch('/api/podcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mistakes: mistakes.slice(0, 8) }),
      });

      const data = await res.json();
      if (data.ok) {
        const newPod: MorningPodcast = {
          id: `podcast-${Date.now()}`,
          date: new Date().toISOString().slice(0, 10),
          title: data.title || '출근길 영어 복습 팟캐스트',
          script: data.script,
          audioBase64: data.audioBase64,
          audioMimeType: data.audioMimeType || 'audio/wav',
          sourceMistakeCount: mistakes.length,
          durationEstimate: '약 2~3분',
        };
        AppStorage.savePodcast(newPod);
        setPodcast(newPod);
      }
    } catch (err) {
      console.error('Failed to generate podcast:', err);
    } finally {
      setLoading(false);
    }
  };

  const togglePlay = () => {
    if (!audioRef.current && podcast?.audioBase64) {
      audioRef.current = new Audio(`data:${podcast.audioMimeType || 'audio/wav'};base64,${podcast.audioBase64}`);
      audioRef.current.ontimeupdate = () => {
        if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
      };
      audioRef.current.onloadedmetadata = () => {
        if (audioRef.current) setDuration(audioRef.current.duration);
      };
      audioRef.current.onended = () => {
        setIsPlaying(false);
        setCurrentTime(0);
      };
    }

    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().then(() => setIsPlaying(true)).catch(console.error);
    }
  };

  const skipTime = (seconds: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = Math.max(0, Math.min(audioRef.current.duration || 0, audioRef.current.currentTime + seconds));
    }
  };

  const handleSendTelegram = async () => {
    const profile = AppStorage.getProfile();
    if (!profile.telegramBotToken || !profile.telegramChatId) {
      setTelegramStatus('설정에서 텔레그램 봇 토큰과 채팅 ID를 먼저 등록해 주세요.');
      return;
    }

    setTelegramStatus('텔레그램으로 전송 중...');
    try {
      const res = await fetch('/api/telegram/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          botToken: profile.telegramBotToken,
          chatId: profile.telegramChatId,
          text: `🎧 ${podcast?.title}\n\n${podcast?.script?.slice(0, 800)}...`,
          audioBase64: podcast?.audioBase64,
          filename: `review_${podcast?.date}.wav`,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTelegramStatus('✓ 텔레그램 전송 완료!');
      } else {
        setTelegramStatus(`전송 실패: ${data.error}`);
      }
    } catch {
      setTelegramStatus('네트워크 오류로 전송에 실패했습니다.');
    }
  };

  const handleMarkAllReviewed = () => {
    const mistakes = AppStorage.getMistakes();
    const updated = mistakes.map((m) => ({ ...m, reviewed: true }));
    AppStorage.saveMistakes(updated);
    setMarkedDone(true);
    onMistakesUpdated?.();
  };

  const formatSeconds = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md overflow-y-auto">
      <div className="relative w-full max-w-2xl max-h-[92vh] overflow-y-auto bg-[#161D2A] border border-slate-800 rounded-3xl p-6 text-slate-100 shadow-2xl flex flex-col gap-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-400">
              <Headphones size={14} />
              <span>Grok & ElevenLabs 스타일 아침 7시 파이프라인</span>
            </div>
            <h2 className="text-xl font-bold text-white mt-1">
              {podcast?.title || '출근길 맞춤형 팟캐스트'}
            </h2>
          </div>
          <button
            onClick={() => {
              if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
              }
              onClose();
            }}
            className="p-2 rounded-full hover:bg-slate-800 text-slate-400 hover:text-white transition cursor-pointer"
            aria-label="닫기"
          >
            <X size={20} />
          </button>
        </div>

        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center gap-3 text-slate-400">
            <Loader2 size={36} className="animate-spin text-amber-400" />
            <p className="text-sm font-medium">전날 미완료 실수를 분석하여 맞춤형 음성 강의를 생성하고 있습니다...</p>
          </div>
        ) : podcast ? (
          <>
            {/* Audio Player Card */}
            <div className="bg-[#1C2433] border border-slate-800 rounded-3xl p-5 flex flex-col gap-4 shadow-lg">
              <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
                <span className="flex items-center gap-1.5 text-amber-300">
                  <Sparkles size={14} />
                  <span>Gemini 3.8 고음질 원어민 보이스</span>
                </span>
                <span className="font-mono tabular-nums">
                  {formatSeconds(currentTime)} / {duration > 0 ? formatSeconds(duration) : '02:30'}
                </span>
              </div>

              {/* Progress bar */}
              <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                <div
                  className="bg-amber-400 h-full transition-all duration-200"
                  style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
                />
              </div>

              {/* Player Controls */}
              <div className="flex items-center justify-center gap-6 py-2">
                <button
                  onClick={() => skipTime(-10)}
                  className="p-2 rounded-full text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
                  title="10초 되감기"
                >
                  <RotateCcw size={22} />
                </button>

                <button
                  onClick={togglePlay}
                  className="w-14 h-14 rounded-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold flex items-center justify-center shadow-lg shadow-amber-500/25 active:scale-95 transition cursor-pointer"
                  aria-label={isPlaying ? '일시 정지' : '재생'}
                >
                  {isPlaying ? <Pause size={26} /> : <Play size={26} className="ml-1" />}
                </button>

                <button
                  onClick={() => skipTime(10)}
                  className="p-2 rounded-full text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
                  title="10초 앞으로"
                >
                  <RotateCw size={22} />
                </button>
              </div>
            </div>

            {/* Script Viewer */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-slate-300">
                  강의 스크립트 전문 (Transcript)
                </h4>
                <button
                  onClick={handleGenerateNewPodcast}
                  className="text-xs text-amber-400 hover:underline cursor-pointer"
                >
                  새로 생성하기
                </button>
              </div>
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 max-h-56 overflow-y-auto text-xs md:text-sm text-slate-300 leading-relaxed whitespace-pre-line font-sans">
                {podcast.script}
              </div>
            </div>

            {/* Actions: Telegram & Mark Reviewed */}
            <div className="flex flex-col md:flex-row items-center justify-between gap-3 pt-2">
              <div className="flex items-center gap-2 w-full md:w-auto">
                <button
                  onClick={handleSendTelegram}
                  className="px-3.5 py-2 rounded-xl bg-sky-900/40 border border-sky-600/40 text-sky-200 text-xs font-semibold hover:bg-sky-900/60 transition flex items-center gap-1.5 cursor-pointer"
                >
                  <Send size={13} />
                  <span>내 텔레그램으로 전송</span>
                </button>

                <button
                  onClick={handleMarkAllReviewed}
                  disabled={markedDone}
                  className="px-3.5 py-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 text-xs font-semibold hover:bg-slate-700 transition flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <Check size={13} className="text-emerald-400" />
                  <span>{markedDone ? '전체 복습 완료됨' : '복습 완료 처리'}</span>
                </button>
              </div>

              {telegramStatus && (
                <span className="text-xs text-amber-300 animate-pulse text-center md:text-right">
                  {telegramStatus}
                </span>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
};
