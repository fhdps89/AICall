import React from 'react';
import { CallPhase } from '../../types';

export type OrbMode = 'Idle' | 'Listening' | 'Speaking';

export function phaseToOrbMode(phase: CallPhase): OrbMode {
  switch (phase) {
    case 'Listening':
    case 'Thinking':
      return 'Listening';
    case 'Speaking':
    case 'Greeting':
      return 'Speaking';
    default:
      return 'Idle';
  }
}

interface GlowingOrbProps {
  mode: OrbMode;
  size?: number; // size in px, defaults to 220
  onClick?: () => void;
  className?: string;
}

export const GlowingOrb: React.FC<GlowingOrbProps> = ({
  mode,
  size = 220,
  onClick,
  className = '',
}) => {
  // Mode-specific colors and animation durations
  const isSpeaking = mode === 'Speaking';
  const isListening = mode === 'Listening';

  // Base colors matching Kotlin Compose GlowingOrb.kt
  // Idle: HerAmber (#E8A87C)
  // Listening: #FFC9A0
  // Speaking: #FFD4B0
  const coreColor = isSpeaking ? '#FFD4B0' : isListening ? '#FFC9A0' : '#E8A87C';
  const glowColor = 'rgba(255, 176, 122, 0.45)';

  const animClass = isSpeaking
    ? 'animate-orb-speaking'
    : isListening
    ? 'animate-orb-listening'
    : 'animate-orb-idle';

  return (
    <div
      onClick={onClick}
      style={{ width: `${size}px`, height: `${size}px` }}
      className={`relative flex items-center justify-center select-none ${
        onClick ? 'cursor-pointer active:scale-95 transition-transform' : ''
      } ${className}`}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label="빛나는 오브"
    >
      {/* Outer soft glow layer */}
      <div
        className={`absolute inset-0 rounded-full blur-2xl pointer-events-none transition-all duration-700 ${animClass}`}
        style={{
          background: `radial-gradient(circle, ${glowColor} 0%, rgba(26,18,16,0) 70%)`,
          transform: isSpeaking ? 'scale(1.3)' : isListening ? 'scale(1.2)' : 'scale(1.1)',
        }}
      />

      {/* Mid ring */}
      <div
        className={`absolute rounded-full blur-md pointer-events-none transition-all duration-500 ${animClass}`}
        style={{
          width: `${size * 0.85}px`,
          height: `${size * 0.85}px`,
          background: `radial-gradient(circle, ${coreColor} 10%, rgba(255,176,122,0.3) 55%, transparent 75%)`,
        }}
      />

      {/* Radiant Core */}
      <div
        className={`relative rounded-full shadow-2xl transition-all duration-300 ${animClass}`}
        style={{
          width: `${size * 0.65}px`,
          height: `${size * 0.65}px`,
          background: `radial-gradient(circle at 45% 45%, #FFFFFF 0%, ${coreColor} 50%, #B86B3E 100%)`,
          boxShadow: `0 0 40px ${glowColor}, inset 0 0 20px rgba(255,255,255,0.7)`,
        }}
      />
    </div>
  );
};
