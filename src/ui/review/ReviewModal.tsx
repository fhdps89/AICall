import React, { useState } from 'react';
import { PostCallReview, MistakeItem } from '../../types';
import { TRACK_CONFIGS } from '../../data/curriculums';
import { AppStorage } from '../../data/storage';
import { Check, Copy, Volume2, X, BookmarkCheck, ArrowRight, Sparkles } from 'lucide-react';

interface ReviewModalProps {
  review: PostCallReview;
  onClose: () => void;
  onOpenPodcast?: () => void;
}

export const ReviewModal: React.FC<ReviewModalProps> = ({ review, onClose, onOpenPodcast }) => {
  const [copied, setCopied] = useState(false);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const track = TRACK_CONFIGS[review.trackId] || TRACK_CONFIGS.opic;

  const handleCopyKeep = () => {
    navigator.clipboard.writeText(review.keepSyncText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handlePlayTts = async (text: string, index: number) => {
    try {
      setPlayingIndex(index);
      const res = await fetch('/api/gemini/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voiceName: track.accentVoice || 'Puck',
        }),
      });
      const data = await res.json();
      if (data.audioBase64) {
        const audio = new Audio(`data:${data.mimeType || 'audio/wav'};base64,${data.audioBase64}`);
        audio.onended = () => setPlayingIndex(null);
        audio.onerror = () => setPlayingIndex(null);
        await audio.play();
      } else {
        setPlayingIndex(null);
      }
    } catch {
      setPlayingIndex(null);
    }
  };

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'AL':
      case 'Native':
        return 'text-emerald-400 bg-emerald-950/60 border-emerald-500/40';
      case 'IH':
        return 'text-amber-400 bg-amber-950/60 border-amber-500/40';
      default:
        return 'text-sky-400 bg-sky-950/60 border-sky-500/40';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md overflow-y-auto">
      <div className="relative w-full max-w-2xl max-h-[92vh] overflow-y-auto bg-[#161D2A] border border-slate-800 rounded-3xl p-6 text-slate-100 shadow-2xl flex flex-col gap-6">
        {/* Top Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-800/80 pb-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-slate-400">
              <span className="text-base">{track.emoji}</span>
              <span>{track.name}</span>
              <span aria-hidden="true">·</span>
              <span>Lesson {review.lessonNum}</span>
            </div>
            <h2 className="text-xl font-bold text-white mt-1">
              통화 복기 & 실수 분석 리포트
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-slate-800 text-slate-400 hover:text-white transition cursor-pointer"
            aria-label="닫기"
          >
            <X size={20} />
          </button>
        </div>

        {/* Level & Evaluation Banner */}
        <div className="bg-[#1C2433] border border-slate-800 rounded-2xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <span className="text-xs text-slate-400 font-medium">오늘의 총평</span>
            <p className="text-sm md:text-base font-semibold text-slate-100 leading-snug">
              {review.overallEvaluation}
            </p>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <span className="text-xs text-slate-400 font-medium">예상 등급:</span>
            <span className={`px-3 py-1 rounded-xl text-sm font-extrabold border ${getLevelColor(review.estimatedLevel)}`}>
              {review.estimatedLevel}
            </span>
          </div>
        </div>

        {/* Mistake Log Table */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-400"></span>
              오늘의 실수 교정 내역 ({review.mistakes.length}개)
            </h3>
            <span className="text-xs text-slate-400">
              실수 보관함에 자동 저장됨
            </span>
          </div>

          {review.mistakes.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-400 bg-[#1C2433]/50 rounded-2xl">
              오늘 대화에서는 큰 문법적 실수가 발견되지 않았습니다. 훌륭합니다!
            </div>
          ) : (
            <div className="space-y-3">
              {review.mistakes.map((m, idx) => (
                <div
                  key={idx}
                  className="bg-[#1C2433] border border-slate-800/80 rounded-2xl p-4 transition hover:border-slate-700"
                >
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                    {/* My Phrase */}
                    <div className="p-2.5 rounded-xl bg-red-950/20 border border-red-900/30">
                      <span className="text-xs font-semibold text-red-400 block mb-1">
                        내가 한 말
                      </span>
                      <p className="text-red-200 line-through decoration-red-400/60 font-mono text-xs md:text-sm">
                        "{m.myPhrase}"
                      </p>
                    </div>

                    {/* Natural Phrase */}
                    <div className="p-2.5 rounded-xl bg-emerald-950/30 border border-emerald-900/40 relative">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-emerald-400">
                          원어민 자연스러운 표현
                        </span>
                        <button
                          onClick={() => handlePlayTts(m.naturalPhrase, idx)}
                          disabled={playingIndex === idx}
                          className="text-xs text-emerald-300 hover:text-emerald-100 flex items-center gap-1 cursor-pointer"
                          title="발음 듣기"
                        >
                          <Volume2 size={14} className={playingIndex === idx ? 'animate-pulse text-amber-300' : ''} />
                          <span>{playingIndex === idx ? '재생 중' : '발음'}</span>
                        </button>
                      </div>
                      <p className="text-emerald-200 font-semibold text-xs md:text-sm">
                        "{m.naturalPhrase}"
                      </p>
                    </div>
                  </div>

                  {/* Reason & Tips */}
                  <div className="mt-2.5 pt-2 border-t border-slate-800/60 text-xs text-slate-400 leading-relaxed">
                    <span className="font-semibold text-slate-300">교정 이유: </span>
                    {m.reason}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Key Expressions (5개) */}
        {review.keyExpressions && review.keyExpressions.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <Sparkles size={16} className="text-amber-400" />
              오늘 꼭 외울 필수 표현 5선
            </h3>
            <div className="grid grid-cols-1 gap-2.5">
              {review.keyExpressions.map((k, i) => (
                <div
                  key={i}
                  className="bg-[#1C2433] border border-slate-800 rounded-xl p-3 flex flex-col md:flex-row md:items-center justify-between gap-2"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-amber-300 text-sm">{k.expression}</span>
                      <span className="text-xs text-slate-400">({k.situation})</span>
                    </div>
                    <p className="text-xs text-slate-300 italic">"{k.exampleSentence}"</p>
                  </div>
                  <button
                    onClick={() => handlePlayTts(k.exampleSentence, 100 + i)}
                    disabled={playingIndex === 100 + i}
                    className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 self-end md:self-auto cursor-pointer"
                    title="예문 발음 듣기"
                  >
                    <Volume2 size={16} className={playingIndex === 100 + i ? 'animate-pulse text-amber-300' : ''} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Google Keep Copy Box */}
        <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
              <BookmarkCheck size={14} className="text-emerald-400" />
              Google Keep 복사 블록
            </span>
            <button
              onClick={handleCopyKeep}
              className="px-3 py-1 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg flex items-center gap-1.5 transition cursor-pointer"
            >
              {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
              <span>{copied ? '복사 완료!' : 'Keep 양식 복사'}</span>
            </button>
          </div>
          <pre className="text-xs font-mono text-slate-400 bg-black/40 p-3 rounded-xl overflow-x-auto whitespace-pre-wrap max-h-28">
            {review.keepSyncText}
          </pre>
        </div>

        {/* Bottom Actions */}
        <div className="flex items-center justify-between gap-3 pt-2">
          {onOpenPodcast ? (
            <button
              onClick={() => {
                onClose();
                onOpenPodcast();
              }}
              className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm font-semibold text-amber-300 flex items-center gap-1.5 transition cursor-pointer"
            >
              <span>🎧 아침 복습 오디오 듣기</span>
            </button>
          ) : <div />}

          <button
            onClick={onClose}
            className="px-6 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm flex items-center gap-1.5 transition cursor-pointer shadow-lg shadow-amber-500/20"
          >
            <span>확인 완료</span>
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
};
