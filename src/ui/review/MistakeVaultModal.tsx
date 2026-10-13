import React, { useState } from 'react';
import { MistakeItem, TrackId } from '../../types';
import { AppStorage } from '../../data/storage';
import { TRACK_CONFIGS } from '../../data/curriculums';
import { Check, Copy, Volume2, X, Headphones, CheckSquare, Square, Filter } from 'lucide-react';

interface MistakeVaultModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGeneratePodcast: () => void;
}

export const MistakeVaultModal: React.FC<MistakeVaultModalProps> = ({
  isOpen,
  onClose,
  onGeneratePodcast,
}) => {
  const [mistakes, setMistakes] = useState<MistakeItem[]>(AppStorage.getMistakes());
  const [selectedTrack, setSelectedTrack] = useState<TrackId | 'all'>('all');
  const [onlyUnreviewed, setOnlyUnreviewed] = useState<boolean>(true);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState<boolean>(false);

  if (!isOpen) return null;

  const handleToggleReviewed = (id: string) => {
    const updated = AppStorage.toggleMistakeReviewed(id);
    setMistakes(updated);
  };

  const handlePlayTts = async (text: string, id: string, trackId: TrackId) => {
    try {
      setPlayingId(id);
      const track = TRACK_CONFIGS[trackId] || TRACK_CONFIGS.opic;
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
        audio.onended = () => setPlayingId(null);
        audio.onerror = () => setPlayingId(null);
        await audio.play();
      } else {
        setPlayingId(null);
      }
    } catch {
      setPlayingId(null);
    }
  };

  const filteredMistakes = mistakes.filter((m) => {
    if (selectedTrack !== 'all' && m.trackId !== selectedTrack) return false;
    if (onlyUnreviewed && m.reviewed) return false;
    return true;
  });

  const unreviewedCount = mistakes.filter((m) => !m.reviewed).length;

  const handleCopyAllKeep = () => {
    const lines = filteredMistakes.map(
      (m) => `[${TRACK_CONFIGS[m.trackId]?.shortName || m.trackId}] ${m.myPhrase} -> ${m.naturalPhrase}`
    );
    navigator.clipboard.writeText(lines.join('\n'));
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md overflow-y-auto">
      <div className="relative w-full max-w-3xl max-h-[92vh] overflow-y-auto bg-[#161D2A] border border-slate-800 rounded-3xl p-6 text-slate-100 shadow-2xl flex flex-col gap-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-400">
              <span>Google Keep 연동형</span>
              <span aria-hidden="true">·</span>
              <span>미완료 실수 {unreviewedCount}개 대기 중</span>
            </div>
            <h2 className="text-xl font-bold text-white mt-1">
              실수 보관함 (Mistake Vault)
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

        {/* Action Controls & Filters */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          {/* Track Filter Segmented Buttons */}
          <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-900/80 rounded-xl border border-slate-800">
            <button
              onClick={() => setSelectedTrack('all')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition cursor-pointer ${
                selectedTrack === 'all'
                  ? 'bg-amber-500 text-slate-950 font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              전체
            </button>
            {(['opic', 'philly', 'travel', 'bluey'] as TrackId[]).map((tid) => {
              const trk = TRACK_CONFIGS[tid];
              return (
                <button
                  key={tid}
                  onClick={() => setSelectedTrack(tid)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-lg transition cursor-pointer flex items-center gap-1 ${
                    selectedTrack === tid
                      ? 'bg-slate-700 text-white font-bold shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span>{trk.emoji}</span>
                  <span>{trk.shortName}</span>
                </button>
              );
            })}
          </div>

          {/* Toggle unreviewed & Actions */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setOnlyUnreviewed(!onlyUnreviewed)}
              className={`px-3 py-1.5 text-xs font-medium rounded-xl border transition flex items-center gap-1.5 cursor-pointer ${
                onlyUnreviewed
                  ? 'bg-amber-950/40 text-amber-300 border-amber-600/40'
                  : 'bg-slate-800 text-slate-400 border-slate-700'
              }`}
            >
              <Filter size={13} />
              <span>{onlyUnreviewed ? '미완료만 보기' : '전체 보기'}</span>
            </button>

            <button
              onClick={handleCopyAllKeep}
              className="px-3 py-1.5 text-xs font-medium rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-1.5 transition cursor-pointer"
              title="Google Keep 형식으로 클립보드에 복사"
            >
              {copiedAll ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
              <span>{copiedAll ? '복사됨!' : 'Keep 복사'}</span>
            </button>
          </div>
        </div>

        {/* Quick Morning Podcast CTA banner */}
        <div className="bg-gradient-to-r from-amber-950/40 via-amber-900/20 to-slate-900 border border-amber-500/30 rounded-2xl p-4 flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <h4 className="text-sm font-bold text-amber-200 flex items-center gap-1.5">
              <Headphones size={16} className="text-amber-400" />
              아침 7시 맞춤형 복습 팟캐스트
            </h4>
            <p className="text-xs text-slate-400">
              미완료 실수 {unreviewedCount}개를 엮어 출근길 3분 오디오 강의로 생성합니다.
            </p>
          </div>
          <button
            onClick={() => {
              onClose();
              onGeneratePodcast();
            }}
            className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold shrink-0 transition flex items-center gap-1.5 cursor-pointer shadow-lg shadow-amber-500/20"
          >
            <span>오디오 생성</span>
          </button>
        </div>

        {/* Card Grid */}
        <div className="space-y-3">
          {filteredMistakes.length === 0 ? (
            <div className="p-12 text-center text-sm text-slate-400 bg-[#1C2433]/40 rounded-2xl border border-slate-800">
              해당 조건의 실수 내역이 없습니다.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {filteredMistakes.map((m) => {
                const trk = TRACK_CONFIGS[m.trackId] || TRACK_CONFIGS.opic;
                return (
                  <div
                    key={m.id}
                    className={`bg-[#1C2433] border rounded-2xl p-4 transition flex flex-col justify-between gap-3 ${
                      m.reviewed
                        ? 'border-slate-800/60 opacity-60'
                        : 'border-slate-700/80 shadow-md'
                    }`}
                  >
                    <div>
                      {/* Top row */}
                      <div className="flex items-center justify-between gap-2 mb-2 text-xs text-slate-400">
                        <span className="font-semibold text-slate-300 flex items-center gap-1">
                          <span>{trk.emoji}</span>
                          <span>{trk.shortName}</span>
                          <span aria-hidden="true">·</span>
                          <span className="text-slate-400">{m.lessonTitle}</span>
                        </span>
                        <span>{m.createdAt.slice(5, 16)}</span>
                      </div>

                      {/* My phrase */}
                      <div className="p-2 rounded-xl bg-red-950/20 border border-red-900/30 text-xs mb-2">
                        <span className="text-[11px] font-semibold text-red-400 block">내가 한 말</span>
                        <p className="text-red-200 line-through decoration-red-400/60 font-mono">
                          "{m.myPhrase}"
                        </p>
                      </div>

                      {/* Natural phrase */}
                      <div className="p-2 rounded-xl bg-emerald-950/30 border border-emerald-900/40 text-xs relative">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-[11px] font-semibold text-emerald-400">
                            원어민 자연스러운 표현
                          </span>
                          <button
                            onClick={() => handlePlayTts(m.naturalPhrase, m.id, m.trackId)}
                            disabled={playingId === m.id}
                            className="text-emerald-300 hover:text-white flex items-center gap-1 text-[11px] cursor-pointer"
                            title="발음 듣기"
                          >
                            <Volume2 size={13} className={playingId === m.id ? 'animate-pulse text-amber-300' : ''} />
                          </button>
                        </div>
                        <p className="text-emerald-200 font-bold">
                          "{m.naturalPhrase}"
                        </p>
                      </div>

                      {/* Reason */}
                      <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                        <span className="font-semibold text-slate-300">이유: </span>
                        {m.reason}
                      </p>
                    </div>

                    {/* Footer Toggle */}
                    <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between">
                      <button
                        onClick={() => handleToggleReviewed(m.id)}
                        className={`text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
                          m.reviewed ? 'text-emerald-400' : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {m.reviewed ? <CheckSquare size={16} /> : <Square size={16} />}
                        <span>{m.reviewed ? '복습 완료' : '복습 전'}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
