import React, { useState } from 'react';
import { HomeScreen } from './ui/home/HomeScreen';
import { CallScreen } from './ui/call/CallScreen';

export const App: React.FC = () => {
  const [currentScreen, setCurrentScreen] = useState<'home' | 'call'>('home');

  return (
    <div className="min-h-screen bg-[#1A1210] flex justify-center items-center">
      <main className="w-full min-h-screen max-w-md bg-[#1A1210] shadow-2xl relative overflow-hidden flex flex-col">
        {currentScreen === 'home' ? (
          <HomeScreen onStartCall={() => setCurrentScreen('call')} />
        ) : (
          <CallScreen onHangUp={() => setCurrentScreen('home')} />
        )}
      </main>
    </div>
  );
};

export default App;
