import React, { useState } from 'react';
import { Settings } from 'lucide-react';
import { GlowingOrb } from '../components/GlowingOrb';
import { SettingsSheet } from './SettingsSheet';
import { UserPreferences } from '../../data/UserPreferences';

interface HomeScreenProps {
  onStartCall: () => void;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({ onStartCall }) => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voiceName, setVoiceName] = useState(UserPreferences.getVoiceDisplayName());

  const handlePreferencesUpdated = () => {
    setVoiceName(UserPreferences.getVoiceDisplayName());
  };

  return (
    <div className="relative min-h-screen w-full bg-[#1A1210] text-[#F5EDE6] flex flex-col justify-between px-7 py-10 select-none max-w-md mx-auto">
      {/* Top bar with title & settings trigger */}
      <div className="relative w-full pt-6 text-center">
        <button
          onClick={() => setSettingsOpen(true)}
          className="absolute right-0 top-6 p-2 rounded-full text-[#F5EDE6]/40 hover:text-[#F5EDE6] hover:bg-white/5 transition"
          title="설정"
          aria-label="설정 열기"
        >
          <Settings size={20} />
        </button>

        <h1 className="text-3xl font-extrabold tracking-tight text-[#F5EDE6]">
          오늘도 한 통
        </h1>
      </div>

      {/* Center glowing orb & voice label */}
      <div className="flex flex-col items-center justify-center my-auto py-8">
        <GlowingOrb
          mode="Idle"
          size={230}
          onClick={() => setSettingsOpen(true)}
        />

        <div className="mt-7 text-center">
          <button
            onClick={() => setSettingsOpen(true)}
            className="px-4 py-2 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 active:scale-95 transition text-sm text-[#F5EDE6]/80 cursor-pointer"
          >
            지금 목소리: <span className="text-[#E8A87C] font-semibold">{voiceName}</span>
          </button>
        </div>
      </div>

      {/* Bottom call button & hint */}
      <div className="w-full flex flex-col items-center pb-6">
        <button
          onClick={onStartCall}
          className="w-full h-14 rounded-full bg-[#E8A87C] text-[#1A1210] text-lg font-bold shadow-lg shadow-[#E8A87C]/20 hover:bg-[#dca074] active:scale-[0.98] transition-all flex items-center justify-center cursor-pointer"
        >
          통화하기
        </button>

        <p className="mt-3 text-sm text-[#F5EDE6]/50 text-center">
          오브를 눌러 설정을 엽니다
        </p>
      </div>

      {/* Settings Bottom Sheet / Modal */}
      <SettingsSheet
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={handlePreferencesUpdated}
      />
    </div>
  );
};
