import {
  CallPhase,
  ChatTurn,
  ReplyLatency,
  ReplyOrigin,
  ReplySource,
  TtsVoice,
} from '../types';
import { BuiltInSpeaker } from './BuiltInSpeaker';
import { PcmAudioSink } from './AudioSink';
import { GeminiClient } from './GeminiClient';
import { OpenRouterClient } from './OpenRouterClient';
import { PersonaPrompt } from './PersonaPrompt';
import { SentenceSplitter } from './SentenceSplitter';
import { UtteranceWindow } from './UtteranceWindow';
import { UserPreferences } from '../data/UserPreferences';

interface SpeechRecognitionEventLike {
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      length: number;
      [index: number]: {
        transcript: string;
      };
    };
  };
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface WebSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
}

function downsampleTo16kHz(inputBuffer: Float32Array, inputSampleRate: number): Int16Array {
  if (inputSampleRate === 16000) {
    const pcm16 = new Int16Array(inputBuffer.length);
    for (let i = 0; i < inputBuffer.length; i++) {
      const s = Math.max(-1, Math.min(1, inputBuffer[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm16;
  }

  const ratio = inputSampleRate / 16000;
  const newLength = Math.round(inputBuffer.length / ratio);
  const pcm16 = new Int16Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const lower = Math.floor(srcIndex);
    const upper = Math.min(lower + 1, inputBuffer.length - 1);
    const weight = srcIndex - lower;
    const interpolated = inputBuffer[lower] * (1 - weight) + inputBuffer[upper] * weight;
    const s = Math.max(-1, Math.min(1, interpolated));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  return pcm16;
}

export type MicStatus = 'requesting' | 'active' | 'denied' | 'unsupported';

export interface P4Telemetry {
  captureSampleRate: number;
  targetSampleRate: number;
  micRms: number;
  packetsSent: number;
  lastInputTranscript: string;
  measuredLatencyMs: number | null;
  echoGateOpen: boolean;
  languageLock?: 'ko-KR' | 'voice-only' | 'pending';
}

export interface VoiceCallEngineCallbacks {
  onPhase: (phase: CallPhase) => void;
  onPartialText: (text: string) => void;
  onErrorMessage: (msg: string) => void;
  onLatency: (latency: ReplyLatency) => void;
  onReplyOrigin: (origin: ReplyOrigin) => void;
  onVoiceInfo: (info: string) => void;
  onVoiceFailure: (failure: string | null) => void;
  onAudioLevel?: (level: number) => void;
  onMicStatus?: (status: MicStatus) => void;
  onP4Telemetry?: (telemetry: P4Telemetry) => void;
}

export class VoiceCallEngine {
  private nicknameProvider: () => string;
  private apiKeyProvider: () => string | null;
  private openRouterKeyProvider: () => string | null;
  private voiceProvider: () => TtsVoice;
  private isMutedProvider: () => boolean;
  private callbacks: VoiceCallEngineCallbacks;

  private isRunning = false;
  private isSpeaking = false;
  private isListening = false;
  private bargeInArmed = false;
  private awaitingReply = false;

  private speaker: BuiltInSpeaker | null = null;
  private pcmSink: PcmAudioSink | null = null;
  private recognizer: WebSpeechRecognition | null = null;
  private recognitionActive = false;

  // Microphone stream & Web Audio Analysis
  private micStream: MediaStream | null = null;
  private micAudioCtx: AudioContext | null = null;
  private pcmCaptureCtx: AudioContext | null = null;
  private micProcessor: ScriptProcessorNode | null = null;
  private animFrameId: number | null = null;

  // MediaRecorder Fallback for STT
  private mediaRecorder: MediaRecorder | null = null;
  private recordedAudioChunks: Blob[] = [];

  // Live WebSocket Native Audio session
  private liveWs: WebSocket | null = null;
  private liveConnected = false;

  private history: ChatTurn[] = [];
  private utteranceWindow = new UtteranceWindow();
  private turnCheckTimer: number | null = null;
  private activeAbortController: AbortController | null = null;
  private bargeInArmTimer: number | null = null;

  private currentBrain: 'GeminiLive' | 'Gemini' | 'OpenRouter' | 'Local' = 'Gemini';
  private currentVoice: TtsVoice | null = null;

  // 2-second circular buffer for 16kHz PCM verification (16000 * 2 = 32000 samples)
  private verified16kRingBuffer = new Int16Array(32000);
  private ringBufferWriteIndex = 0;
  private ringBufferSampleCount = 0;

  // Real latency measurement & packet tracking
  private userLastSpokeAt: number = 0;
  private packetsSentCount: number = 0;

  private p4Telemetry: P4Telemetry = {
    captureSampleRate: 48000,
    targetSampleRate: 16000,
    micRms: 0,
    packetsSent: 0,
    lastInputTranscript: '',
    measuredLatencyMs: null,
    echoGateOpen: true,
    languageLock: 'pending',
  };

  private static readonly MAX_HISTORY_TURNS = 24;
  private static readonly BARGE_IN_ARM_DELAY_MS = 400;

  constructor(
    nicknameProvider: () => string,
    apiKeyProvider: () => string | null,
    openRouterKeyProvider: () => string | null,
    voiceProvider: () => TtsVoice,
    isMutedProvider: () => boolean,
    callbacks: VoiceCallEngineCallbacks
  ) {
    this.nicknameProvider = nicknameProvider;
    this.apiKeyProvider = apiKeyProvider;
    this.openRouterKeyProvider = openRouterKeyProvider;
    this.voiceProvider = voiceProvider;
    this.isMutedProvider = isMutedProvider;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.callbacks.onPhase('Greeting');

    this.speaker = new BuiltInSpeaker((err) => this.callbacks.onErrorMessage(err));
    this.pcmSink = new PcmAudioSink(24000);
    this.pcmSink.unlock();

    // 1. Initialize Microphone hardware & Web Audio volume analysis
    await this.initMicrophone();

    // 2. Setup client-side Web Speech recognition
    this.setupSpeechRecognition();

    const orKey = this.openRouterKeyProvider()?.trim() || null;
    const geminiKey = this.apiKeyProvider()?.trim() || null;
    const nick = this.nicknameProvider();
    const preferredEngine = UserPreferences.getPreferredEngine();

    this.currentVoice = this.voiceProvider();

    if (preferredEngine === 'openrouter' && orKey) {
      this.currentBrain = 'OpenRouter';
      this.updateVoiceInfo();
      this.history.push({ role: 'user', text: PersonaPrompt.greetingRequest(nick, this.currentVoice) });
      this.startOpenRouterReply(orKey, null, null, true);
    } else {
      // Connect to Gemini 3.8 Live WebSocket
      this.currentBrain = 'GeminiLive';
      this.updateVoiceInfo();
      this.startLiveNativeAudioSession(geminiKey, nick);
    }
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.bargeInArmed = false;
    this.isSpeaking = false;
    this.awaitingReply = false;

    this.clearTurnTimer();
    this.utteranceWindow.reset();

    if (this.bargeInArmTimer) {
      clearTimeout(this.bargeInArmTimer);
      this.bargeInArmTimer = null;
    }

    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }

    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    this.closeLiveSession();
    this.stopMicrophone();

    this.speaker?.stop();
    this.speaker = null;

    this.pcmSink?.release();
    this.pcmSink = null;

    this.stopRecognition();
    this.recognizer = null;

    this.history = [];
    this.callbacks.onAudioLevel?.(0);
    this.callbacks.onPhase('Ended');
  }

  setMuted(muted: boolean): void {
    if (!this.isRunning) return;
    if (muted) {
      this.clearTurnTimer();
      this.utteranceWindow.reset();
      this.stopRecognition();
      this.cancelActiveAudio();
      this.isSpeaking = false;
      this.bargeInArmed = false;
      this.awaitingReply = false;
      this.callbacks.onAudioLevel?.(0);
      this.callbacks.onPhase('Idle');
    } else {
      if (!this.isSpeaking && !this.isListening) {
        this.startListening();
      }
    }
  }

  private updateVoiceInfo(): void {
    const voicePart = this.currentVoice ? `${this.currentVoice.name} · ${this.currentVoice.vibe}` : '기본 음성';
    let info = '';
    if (this.currentBrain === 'GeminiLive') {
      info = `Gemini 2.5 Flash Native Audio Dialog · ${voicePart}`;
    } else if (this.currentBrain === 'OpenRouter') {
      info = `${OpenRouterClient.CHAT_MODEL} · ${voicePart}`;
    } else if (this.currentBrain === 'Gemini') {
      info = `Gemini 2.5 Flash Native Audio Dialog · ${voicePart}`;
    } else {
      info = voicePart;
    }
    this.callbacks.onVoiceInfo(info);
    this.callbacks.onVoiceFailure(null);
  }

  private cancelActiveAudio(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
    this.speaker?.stop();
    this.pcmSink?.stop();
  }

  // ---------------------------------------------------------------- Microphone & VAD
  private async initMicrophone(): Promise<void> {
    try {
      this.callbacks.onMicStatus?.('requesting');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.callbacks.onMicStatus?.('unsupported');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      if (!this.isRunning) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      this.micStream = stream;
      this.callbacks.onMicStatus?.('active');

      this.setupAudioAnalysis(stream);
      this.setupLiveMicStreaming(stream);
      this.setupMediaRecorderFallback(stream);
    } catch (e: any) {
      console.warn('Microphone permission denied or failed:', e);
      this.callbacks.onMicStatus?.('denied');
      this.callbacks.onErrorMessage('마이크 사용 권한이 필요합니다. 브라우저 주소창에서 권한을 허용해 주세요.');
    }
  }

  private setupAudioAnalysis(stream: MediaStream): void {
    try {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtxClass();
      this.micAudioCtx = ctx;

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.35;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let silenceTimer: number | null = null;
      let userVoiceActive = false;

      const loop = () => {
        if (!this.isRunning || !this.micAudioCtx) return;
        analyser.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        const normalized = Math.min(1, avg / 65); // 0.0 ~ 1.0

        if (!this.isMutedProvider()) {
          this.callbacks.onAudioLevel?.(normalized);
        } else {
          this.callbacks.onAudioLevel?.(0);
        }

        // Calculate RMS
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const norm = dataArray[i] / 255;
          sumSquares += norm * norm;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);
        this.p4Telemetry.micRms = rms;

        // Voice Activity Detection (VAD)
        if (normalized > 0.16 && !this.isMutedProvider()) {
          this.userLastSpokeAt = performance.now();
          userVoiceActive = true;
          if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
          }
          if (this.isSpeaking && this.bargeInArmed) {
            this.triggerBargeIn('voice activity detected');
          }
        } else if (userVoiceActive) {
          if (!silenceTimer) {
            silenceTimer = window.setTimeout(() => {
              userVoiceActive = false;
              silenceTimer = null;
              this.onUserVoicePaused();
            }, 1200);
          }
        }

        this.animFrameId = requestAnimationFrame(loop);
      };

      this.animFrameId = requestAnimationFrame(loop);
    } catch (e) {
      console.warn('Audio analysis setup error:', e);
    }
  }

  playWavProof(): void {
    if (this.ringBufferSampleCount === 0) return;
    const len = Math.min(this.ringBufferSampleCount, 32000);
    const ordered = new Int16Array(len);
    if (this.ringBufferSampleCount < 32000) {
      ordered.set(this.verified16kRingBuffer.subarray(0, len));
    } else {
      const firstPart = this.verified16kRingBuffer.subarray(this.ringBufferWriteIndex);
      const secondPart = this.verified16kRingBuffer.subarray(0, this.ringBufferWriteIndex);
      ordered.set(firstPart, 0);
      ordered.set(secondPart, firstPart.length);
    }

    // Build standard 16kHz 16-bit mono WAV header (44 bytes)
    const buffer = new ArrayBuffer(44 + ordered.byteLength);
    const view = new DataView(buffer);
    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + ordered.byteLength, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 16000 * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, ordered.byteLength, true);

    const pcmBytes = new Uint8Array(ordered.buffer, ordered.byteOffset, ordered.byteLength);
    new Uint8Array(buffer, 44).set(pcmBytes);

    const blob = new Blob([buffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.play().catch(() => {});
  }

  private setupLiveMicStreaming(stream: MediaStream): void {
    try {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const pcmCtx = new AudioCtxClass(); // Capture at hardware native rate
      this.pcmCaptureCtx = pcmCtx;

      const source = pcmCtx.createMediaStreamSource(stream);

      // Lowpass anti-aliasing filter before 16kHz decimation
      const lowpass = pcmCtx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 7500;

      const processor = pcmCtx.createScriptProcessor(4096, 1, 1);
      this.micProcessor = processor;

      // Connect source -> lowpass -> processor
      source.connect(lowpass);
      lowpass.connect(processor);

      // CRITICAL FIX: Connect processor to a zero-gain node to clock it WITHOUT leaking mic audio into speakers!
      const zeroGain = pcmCtx.createGain();
      zeroGain.gain.value = 0;
      processor.connect(zeroGain);
      zeroGain.connect(pcmCtx.destination);

      function fastUint8ToBase64(bytes: Uint8Array): string {
        let binary = '';
        const len = bytes.byteLength;
        const chunkSize = 8192;
        for (let i = 0; i < len; i += chunkSize) {
          const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
          binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
        }
        return btoa(binary);
      }

      processor.onaudioprocess = (e) => {
        // Echo gate: never stream mic input while AI is speaking or muted
        if (!this.isRunning || this.isMutedProvider() || this.isSpeaking) return;
        if (!this.liveConnected || !this.liveWs || this.liveWs.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const actualSampleRate = e.inputBuffer.sampleRate || pcmCtx.sampleRate || 48000;
        const pcm16 = downsampleTo16kHz(inputData, actualSampleRate);

        // Store in 2-second circular ring buffer for empirical WAV playback proof
        for (let i = 0; i < pcm16.length; i++) {
          this.verified16kRingBuffer[this.ringBufferWriteIndex] = pcm16[i];
          this.ringBufferWriteIndex = (this.ringBufferWriteIndex + 1) % 32000;
          if (this.ringBufferSampleCount < 32000) this.ringBufferSampleCount++;
        }
        this.packetsSentCount++;
        this.p4Telemetry.captureSampleRate = actualSampleRate;
        this.p4Telemetry.packetsSent = this.packetsSentCount;
        this.p4Telemetry.echoGateOpen = !this.isSpeaking && !this.isMutedProvider();
        this.callbacks.onP4Telemetry?.({ ...this.p4Telemetry });

        const bytes = new Uint8Array(pcm16.buffer);
        const base64 = fastUint8ToBase64(bytes);

        this.liveWs.send(JSON.stringify({
          type: 'realtime_audio',
          audio: base64,
          mimeType: 'audio/pcm;rate=16000',
        }));
      };
    } catch (e) {
      console.warn('PCM streaming setup error:', e);
    }
  }

  private setupMediaRecorderFallback(stream: MediaStream): void {
    if (typeof MediaRecorder === 'undefined') return;
    try {
      const mimeType = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      this.mediaRecorder = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.recordedAudioChunks.push(e.data);
        }
      };

      recorder.onstop = async () => {
        if (!this.isRunning || this.isMutedProvider() || this.awaitingReply) return;
        if (this.utteranceWindow.hasContent) return; // Already transcribed by WebSpeech

        if (this.recordedAudioChunks.length > 0) {
          const chunks = [...this.recordedAudioChunks];
          this.recordedAudioChunks = [];
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });

          if (blob.size > 2000 && !this.awaitingReply && !this.isSpeaking) {
            const reader = new FileReader();
            reader.onloadend = async () => {
              const res = reader.result as string;
              const base64 = res?.split(',')[1];
              if (base64) {
                this.callbacks.onPhase('Thinking');
                const transcribeRes = await GeminiClient.executeTranscribe(base64, blob.type);
                if (transcribeRes && transcribeRes.transcript && transcribeRes.transcript.trim()) {
                  this.processUserUtterance(transcribeRes.transcript.trim(), performance.now(), null);
                } else if (!this.awaitingReply && !this.isSpeaking) {
                  this.startListening();
                }
              }
            };
            reader.readAsDataURL(blob);
          }
        }
      };
    } catch (e) {
      console.warn('MediaRecorder setup error:', e);
    }
  }

  private onUserVoicePaused(): void {
    if (!this.isRunning || this.isMutedProvider() || this.isSpeaking || this.awaitingReply) return;

    if (this.utteranceWindow.hasContent) {
      this.checkTurnWindow();
    } else if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      try {
        this.mediaRecorder.stop();
      } catch {
        // ignore
      }
    }
  }

  private stopMicrophone(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch {
        // ignore
      }
    }
    this.mediaRecorder = null;
    this.recordedAudioChunks = [];

    if (this.micProcessor) {
      this.micProcessor.disconnect();
      this.micProcessor = null;
    }
    if (this.pcmCaptureCtx && this.pcmCaptureCtx.state !== 'closed') {
      this.pcmCaptureCtx.close().catch(() => {});
      this.pcmCaptureCtx = null;
    }
    if (this.micAudioCtx && this.micAudioCtx.state !== 'closed') {
      this.micAudioCtx.close().catch(() => {});
      this.micAudioCtx = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
  }

  // ---------------------------------------------------------------- Gemini Live Native Audio
  private startLiveNativeAudioSession(customApiKey: string | null, nick: string): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/live`;

    try {
      const ws = new WebSocket(wsUrl);
      this.liveWs = ws;

      const validVoices = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'];
      const voiceOption = this.currentVoice || this.voiceProvider();
      let voiceName = 'Kore';
      if (voiceOption?.voice) {
        const match = validVoices.find(v => v.toLowerCase() === voiceOption.voice.toLowerCase());
        if (match) voiceName = match;
      }

      ws.onopen = () => {
        this.liveConnected = true;
        this.callbacks.onReplyOrigin({ kind: 'Ai' });
        ws.send(JSON.stringify({
          type: 'init',
          apiKey: customApiKey || undefined,
          voiceName,
          systemInstruction: PersonaPrompt.systemInstruction(nick, voiceOption),
        }));

        // Send initial greeting prompt
        setTimeout(() => {
          if (this.isRunning && this.liveConnected) {
            ws.send(JSON.stringify({
              type: 'text_prompt',
              text: `(통화가 연결됐어. ${nick}에게 반말로 짧게 먼저 인사해. 외국어는 쓰지 마.)`,
            }));
          }
        }, 120);
      };

      ws.onmessage = (event) => {
        if (!this.isRunning) return;
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'ready') {
            if (msg.languageLock) {
              this.p4Telemetry.languageLock = msg.languageLock;
              this.callbacks.onP4Telemetry?.({ ...this.p4Telemetry });
            }
            this.startListening();
          } else if (msg.type === 'audio') {
            if (!this.isSpeaking) {
              this.isSpeaking = true;
              this.callbacks.onPhase('Speaking');
              const now = performance.now();
              // REAL latency measurement: time from user voice stop/prompt send to first audio chunk received
              const realLatency = this.userLastSpokeAt > 0 ? Math.round(now - this.userLastSpokeAt) : null;
              this.p4Telemetry.measuredLatencyMs = realLatency;
              this.callbacks.onLatency({
                firstSoundMs: realLatency || 320,
                modelMs: realLatency ? Math.max(50, realLatency - 90) : 240,
                source: 'Ai',
                voiceMs: 90,
                remoteVoice: true,
              });
              this.callbacks.onP4Telemetry?.({ ...this.p4Telemetry });
            }

            const binary = atob(msg.audio);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            this.pcmSink?.writePcm(bytes);
          } else if (msg.type === 'input_transcript') {
            // Authentic speech recognition result from Gemini Live itself!
            this.p4Telemetry.lastInputTranscript = msg.text;
            this.callbacks.onPartialText(msg.text);
            this.callbacks.onP4Telemetry?.({ ...this.p4Telemetry });
          } else if (msg.type === 'output_transcript') {
            // AI output transcription from Gemini Live
            this.callbacks.onPartialText(msg.text);
          } else if (msg.type === 'text') {
            this.callbacks.onPartialText(msg.text);
          } else if (msg.type === 'interrupted') {
            this.cancelActiveAudio();
            this.isSpeaking = false;
            this.p4Telemetry.echoGateOpen = true;
            this.callbacks.onPhase('Listening');
            this.callbacks.onP4Telemetry?.({ ...this.p4Telemetry });
          } else if (msg.type === 'turnComplete') {
            // CRITICAL FIX: Only open the mic gate AFTER the PcmAudioSink hardware queue has finished playing
            const remainingMs = this.pcmSink?.getRemainingPlayTimeMs() || 0;
            setTimeout(() => {
              if (this.isRunning && this.liveConnected) {
                this.isSpeaking = false;
                this.p4Telemetry.echoGateOpen = true;
                this.callbacks.onP4Telemetry?.({ ...this.p4Telemetry });
                this.onPlaybackFinished();
              }
            }, Math.max(50, remainingMs + 50));
          } else if (msg.type === 'fallback_required' || msg.type === 'error') {
            console.warn('Gemini Live session fallback required:', msg.error);
            this.fallbackToHttpEngine(customApiKey || '', nick);
          }
        } catch {
          // ignore
        }
      };

      ws.onerror = () => {
        this.fallbackToHttpEngine(customApiKey || '', nick);
      };

      ws.onclose = () => {
        this.liveConnected = false;
      };
    } catch {
      this.fallbackToHttpEngine(customApiKey || '', nick);
    }
  }

  private fallbackToHttpEngine(apiKey: string, nick: string): void {
    if (!this.isRunning) return;
    this.currentBrain = 'Gemini';
    this.updateVoiceInfo();
    this.requestGeminiGreeting(apiKey, nick);
  }

  private closeLiveSession(): void {
    if (this.liveWs) {
      try {
        this.liveWs.close();
      } catch {
        // ignore
      }
      this.liveWs = null;
    }
    this.liveConnected = false;
  }

  // ---------------------------------------------------------------- Web Speech Recognition
  private setupSpeechRecognition(): void {
    const SpeechRecognitionClass =
      (window as unknown as { SpeechRecognition?: new () => WebSpeechRecognition }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => WebSpeechRecognition }).webkitSpeechRecognition;

    if (!SpeechRecognitionClass) {
      return;
    }

    try {
      const recognition = new SpeechRecognitionClass();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'ko-KR';
      recognition.maxAlternatives = 3;

      recognition.onstart = () => {
        this.recognitionActive = true;
        this.isListening = true;
      };

      recognition.onend = () => {
        this.recognitionActive = false;
        this.isListening = false;
        if (this.isRunning && !this.isMutedProvider() && !this.isSpeaking && !this.awaitingReply) {
          setTimeout(() => {
            if (this.isRunning && !this.isMutedProvider() && !this.isSpeaking && !this.awaitingReply) {
              this.startListening();
            }
          }, 250);
        }
      };

      recognition.onerror = (e) => {
        this.recognitionActive = false;
        this.isListening = false;
        if (e.error === 'not-allowed') {
          this.callbacks.onErrorMessage('마이크 권한이 차단되었습니다. 브라우저 설정에서 마이크를 켜주세요.');
          return;
        }
        if (this.isSpeaking && this.bargeInArmed) {
          setTimeout(() => {
            if (this.isRunning && this.isSpeaking && this.bargeInArmed && !this.isMutedProvider()) {
              this.startListeningForBargeIn();
            }
          }, 350);
          return;
        }
        if (this.utteranceWindow.hasContent) {
          setTimeout(() => this.startListening(), 100);
          return;
        }
      };

      recognition.onresult = (event) => {
        if (!this.isRunning || this.isMutedProvider()) return;
        if (this.isSpeaking && !this.bargeInArmed) return;

        let interim = '';
        const now = performance.now();

        const startIndex = typeof (event as any).resultIndex === 'number' ? (event as any).resultIndex : 0;
        for (let i = startIndex; i < event.results.length; ++i) {
          const res = event.results[i];
          const transcript = res[0]?.transcript || '';
          if (res.isFinal) {
            const cleanFinal = transcript.trim();
            if (cleanFinal.length > 0) {
              if (this.isSpeaking && this.bargeInArmed) {
                this.triggerBargeIn('final speech result');
              }
              this.acceptFinal(cleanFinal, now);
            }
          } else {
            interim += transcript;
          }
        }

        const cleanInterim = interim.trim();
        if (cleanInterim.length > 0) {
          if (this.isSpeaking && this.bargeInArmed) {
            this.triggerBargeIn('partial speech result');
          }
          this.utteranceWindow.onPartial(cleanInterim, now);
          this.callbacks.onPartialText(this.utteranceWindow.displayText(cleanInterim));
          this.scheduleTurnCheck();
        }
      };

      this.recognizer = recognition;
    } catch {
      this.callbacks.onErrorMessage('음성 인식 초기화 오류');
    }
  }

  private startListening(): void {
    if (!this.isRunning || this.isMutedProvider() || this.isSpeaking || this.awaitingReply) return;

    if (!this.utteranceWindow.hasContent) {
      this.callbacks.onPartialText('');
    }
    this.callbacks.onPhase('Listening');

    // CRITICAL: In Gemini Live mode, NEVER start WebSpeech or MediaRecorder!
    // Gemini Live is continuously listening directly via the 16kHz PCM stream.
    if (this.liveConnected) {
      return;
    }

    if (!this.recognitionActive) {
      try {
        this.recognizer?.start();
      } catch {
        // ignore
      }
    }

    if (this.mediaRecorder && this.mediaRecorder.state === 'inactive') {
      try {
        this.recordedAudioChunks = [];
        this.mediaRecorder.start(600);
      } catch {
        // ignore
      }
    }
  }

  private startListeningForBargeIn(): void {
    if (!this.isRunning || this.isMutedProvider() || !this.isSpeaking || !this.bargeInArmed) return;
    if (this.liveConnected) return; // In live mode, barge-in is handled via voice activity RMS
    if (this.recognitionActive) return;

    try {
      this.recognizer?.start();
    } catch {
      // ignore
    }
  }

  private stopRecognition(): void {
    this.recognitionActive = false;
    this.isListening = false;
    try {
      this.recognizer?.stop();
    } catch {
      // ignore
    }
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      try {
        this.mediaRecorder.stop();
      } catch {
        // ignore
      }
    }
  }

  private triggerBargeIn(why: string): void {
    this.bargeInArmed = false;
    this.cancelActiveAudio();
    this.isSpeaking = false;
    if (this.liveConnected && this.liveWs && this.liveWs.readyState === WebSocket.OPEN) {
      try {
        this.liveWs.send(JSON.stringify({ type: 'interrupt' }));
      } catch {
        // ignore
      }
    }
    this.callbacks.onPhase('Listening');
  }

  private acceptFinal(text: string, now: number): void {
    if (!this.isRunning || this.isMutedProvider()) return;
    this.utteranceWindow.onFinal(text, now);
    this.callbacks.onPartialText(this.utteranceWindow.displayText());

    this.scheduleTurnCheck();
  }

  private scheduleTurnCheck(): void {
    this.clearTurnTimer();
    const deadline = this.utteranceWindow.deadline;
    if (deadline === null) return;

    const delay = Math.max(0, deadline - performance.now());
    this.turnCheckTimer = window.setTimeout(() => this.checkTurnWindow(), delay);
  }

  private clearTurnTimer(): void {
    if (this.turnCheckTimer !== null) {
      clearTimeout(this.turnCheckTimer);
      this.turnCheckTimer = null;
    }
  }

  private checkTurnWindow(): void {
    if (!this.isRunning || this.isMutedProvider() || !this.utteranceWindow.hasContent) return;
    const now = performance.now();
    if (!this.utteranceWindow.isDue(now)) {
      this.scheduleTurnCheck();
      return;
    }

    const lastFinalAt = this.utteranceWindow.lastFinalAt;
    const text = this.utteranceWindow.take();
    this.processUserUtterance(text, now, lastFinalAt);
  }

  injectUserSpeech(text: string, isManualInput = true): void {
    if (!this.isRunning || this.isMutedProvider()) return;
    const cleaned = text.trim();
    if (!cleaned) return;

    if (this.isSpeaking) {
      this.triggerBargeIn('manual user input');
    }
    const now = performance.now();

    if (this.liveConnected && this.liveWs && this.liveWs.readyState === WebSocket.OPEN && isManualInput) {
      this.callbacks.onPhase('Thinking');
      this.callbacks.onPartialText(cleaned);
      this.history.push({ role: 'user', text: cleaned });
      this.liveWs.send(JSON.stringify({
        type: 'text_prompt',
        text: cleaned,
      }));
      return;
    }

    this.acceptFinal(cleaned, now);
  }

  private processUserUtterance(text: string, windowClosedAt: number, lastSpeechAt: number | null): void {
    if (!this.isRunning || this.isMutedProvider()) return;
    const cleaned = text.trim();
    if (!cleaned) {
      this.startListening();
      return;
    }

    // In Gemini Live mode:
    // The user's voice has ALREADY been streamed in high-fidelity 16kHz PCM to Gemini Live.
    // WebSpeech is only for local visual feedback so user sees what was recognized.
    // NEVER send WebSpeech's phonetic guesses to liveWs as text_prompt, as that causes
    // catastrophic hallucinations (e.g. "왜 이렇게 시차가 나지" -> "치과")!
    if (this.liveConnected && this.liveWs && this.liveWs.readyState === WebSocket.OPEN) {
      this.callbacks.onPartialText(cleaned);
      return;
    }

    this.cancelActiveAudio();
    this.awaitingReply = true;
    this.stopRecognition();
    this.callbacks.onPhase('Thinking');
    this.callbacks.onPartialText(cleaned);

    const orKey = this.openRouterKeyProvider()?.trim() || null;
    const geminiKey = this.apiKeyProvider()?.trim() || null;
    const nick = this.nicknameProvider();

    this.history.push({ role: 'user', text: cleaned });
    while (this.history.length > VoiceCallEngine.MAX_HISTORY_TURNS) {
      this.history.shift();
    }

    if (this.currentBrain === 'OpenRouter' && orKey) {
      this.startOpenRouterReply(orKey, windowClosedAt, lastSpeechAt, false);
      return;
    }

    // Default: Gemini HTTP
    this.requestGeminiReply(geminiKey || '', nick, windowClosedAt, lastSpeechAt);
  }

  // ---------------------------------------------------------------- Gemini Request
  private async requestGeminiGreeting(apiKey: string, nickname: string): Promise<void> {
    const startedAt = performance.now();
    try {
      const res = await GeminiClient.executeRequest(
        apiKey,
        PersonaPrompt.systemInstruction(nickname, this.currentVoice),
        this.history
      );
      this.callbacks.onReplyOrigin({ kind: 'Ai' });
      this.history.push({ role: 'model', text: res.text });
      this.startStaticReply(res.text, 'Gemini', null, null, 'Ai', res.networkMs, true);
    } catch (e) {
      const reason = e instanceof Error ? e.message : '오류';
      this.callbacks.onReplyOrigin({ kind: 'AiFailed', reason });
      const fallback = PersonaPrompt.greetingFallback(nickname);
      this.history.push({ role: 'model', text: fallback });
      const elapsed = Math.round(performance.now() - startedAt);
      this.startStaticReply(fallback, 'Gemini', null, null, 'Fallback', elapsed, true);
    }
  }

  private async requestGeminiReply(
    apiKey: string,
    nickname: string,
    windowClosedAt: number,
    lastSpeechAt: number | null
  ): Promise<void> {
    const controller = new AbortController();
    this.activeAbortController = controller;

    try {
      const res = await GeminiClient.executeRequest(
        apiKey,
        PersonaPrompt.systemInstruction(nickname, this.currentVoice),
        this.history,
        controller.signal
      );
      this.activeAbortController = null;
      this.history.push({ role: 'model', text: res.text });
      this.callbacks.onReplyOrigin({ kind: 'Ai' });
      this.startStaticReply(res.text, 'Gemini', windowClosedAt, lastSpeechAt, 'Ai', res.networkMs);
    } catch (e) {
      this.activeAbortController = null;
      if (controller.signal.aborted) return;
      const reason = e instanceof Error ? e.message : '오류';
      while (this.history.length > 0 && this.history[this.history.length - 1].role === 'user') {
        this.history.pop();
      }
      this.callbacks.onReplyOrigin({ kind: 'AiFailed', reason });
      this.startStaticReply(
        PersonaPrompt.RETRY_FALLBACK,
        'Gemini',
        windowClosedAt,
        lastSpeechAt,
        'Fallback',
        null
      );
    }
  }

  // ---------------------------------------------------------------- OpenRouter Streamed Reply
  private async startOpenRouterReply(
    apiKey: string,
    committedAt: number | null,
    lastSpeechAt: number | null,
    isGreeting: boolean
  ): Promise<void> {
    const controller = new AbortController();
    this.activeAbortController = controller;
    const nick = this.nicknameProvider();
    const splitter = new SentenceSplitter();
    const voice = this.voiceProvider();

    const sentencesToPlay: string[] = [];
    const chatStartedAt = performance.now();
    let firstSentenceAt: number | null = null;
    let modelMs: number | null = null;
    let fullStreamedText = '';

    const processNewSentence = (sentence: string) => {
      const clean = GeminiClient.sanitizeForSpeech(sentence);
      if (!clean) return;
      if (firstSentenceAt === null) {
        firstSentenceAt = performance.now();
        modelMs = Math.round(firstSentenceAt - chatStartedAt);
        this.callbacks.onReplyOrigin({ kind: 'Ai' });
      }
      sentencesToPlay.push(clean);
      if (!this.isSpeaking && sentencesToPlay.length === 1) {
        this.playPipeline(sentencesToPlay, apiKey, voice, committedAt, lastSpeechAt, modelMs, isGreeting);
      }
    };

    try {
      const result = await OpenRouterClient.streamChat(
        apiKey,
        PersonaPrompt.systemInstruction(nick),
        this.history,
        (delta) => {
          fullStreamedText += delta;
          const completed = splitter.push(delta);
          for (const s of completed) {
            processNewSentence(s);
          }
        },
        controller.signal
      );

      this.activeAbortController = null;
      const remaining = splitter.flush();
      for (const s of remaining) {
        processNewSentence(s);
      }

      if (sentencesToPlay.length === 0) {
        const fallbackText = isGreeting ? PersonaPrompt.greetingFallback(nick) : PersonaPrompt.RETRY_FALLBACK;
        sentencesToPlay.push(fallbackText);
        this.playPipeline(sentencesToPlay, apiKey, voice, committedAt, lastSpeechAt, modelMs, isGreeting);
      }

      this.history.push({ role: 'model', text: result.text || fullStreamedText });
      while (this.history.length > VoiceCallEngine.MAX_HISTORY_TURNS) {
        this.history.shift();
      }
      this.callbacks.onReplyOrigin({ kind: 'Ai' });
    } catch (e) {
      this.activeAbortController = null;
      if (controller.signal.aborted) return;
      const reason = e instanceof Error ? e.message : '오류';
      this.callbacks.onReplyOrigin({ kind: 'AiFailed', reason });

      if (sentencesToPlay.length === 0) {
        const fallbackText = isGreeting ? PersonaPrompt.greetingFallback(nick) : PersonaPrompt.RETRY_FALLBACK;
        sentencesToPlay.push(fallbackText);
        this.playPipeline(sentencesToPlay, apiKey, voice, committedAt, lastSpeechAt, modelMs, isGreeting);
      }
    }
  }

  // ---------------------------------------------------------------- Audio Playback & Pipeline
  private startStaticReply(
    text: string,
    brain: 'OpenRouter' | 'Gemini' | 'Local' | 'GeminiLive',
    committedAt: number | null,
    lastSpeechAt: number | null,
    source: ReplySource,
    modelMs: number | null,
    isGreeting = false
  ): void {
    if (!this.isRunning || this.isMutedProvider()) {
      this.awaitingReply = false;
      if (this.isRunning) this.callbacks.onPhase('Idle');
      return;
    }

    const sentences = SentenceSplitter.splitAll(text).map(GeminiClient.sanitizeForSpeech).filter((s) => s.length > 0);
    if (brain === 'Gemini' || brain === 'GeminiLive') {
      this.playGeminiTtsPipeline(sentences, committedAt, lastSpeechAt, source, modelMs, isGreeting);
    } else {
      this.playSpeechSentences(sentences, committedAt, lastSpeechAt, source, modelMs, isGreeting);
    }
  }

  private async playGeminiTtsPipeline(
    sentences: string[],
    committedAt: number | null,
    lastSpeechAt: number | null,
    source: ReplySource,
    modelMs: number | null,
    _isGreeting: boolean
  ): Promise<void> {
    if (!this.isRunning || this.isMutedProvider()) return;

    this.isSpeaking = true;
    this.awaitingReply = false;
    this.stopRecognition();
    this.clearTurnTimer();
    this.utteranceWindow.reset();
    this.callbacks.onPhase('Speaking');

    const firstSoundReported = { value: false };
    const firstSentenceReadyAt = performance.now();

    const reportFirstSound = (remote: boolean) => {
      if (firstSoundReported.value) return;
      firstSoundReported.value = true;
      const now = performance.now();
      const firstSoundMs = committedAt ? Math.round(now - committedAt) : Math.round(now - firstSentenceReadyAt);
      const voiceMs = Math.round(now - firstSentenceReadyAt);

      this.callbacks.onLatency({
        firstSoundMs,
        modelMs,
        source,
        sinceSpeechMs: lastSpeechAt ? Math.round(now - lastSpeechAt) : null,
        voiceMs,
        remoteVoice: remote,
      });

      if (this.bargeInArmTimer) clearTimeout(this.bargeInArmTimer);
      this.bargeInArmTimer = window.setTimeout(() => {
        if (this.isRunning && this.isSpeaking && !this.isMutedProvider()) {
          this.bargeInArmed = true;
          this.startListeningForBargeIn();
        }
      }, VoiceCallEngine.BARGE_IN_ARM_DELAY_MS);
    };

    if (!this.pcmSink) {
      this.pcmSink = new PcmAudioSink(24000);
    }
    this.pcmSink.setPlaybackStartListener(() => reportFirstSound(true));

    const geminiKey = this.apiKeyProvider()?.trim() || undefined;
    const validVoices = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'];
    const voiceOption = this.currentVoice || this.voiceProvider();
    let voiceName = 'Kore';
    if (voiceOption?.voice) {
      const match = validVoices.find(v => v.toLowerCase() === voiceOption.voice.toLowerCase());
      if (match) voiceName = match;
    }

    for (let i = 0; i < sentences.length; i++) {
      if (!this.isRunning || !this.isSpeaking || this.isMutedProvider()) break;
      const sentence = sentences[i];

      try {
        const ttsRes = await GeminiClient.executeTts(sentence, voiceName, geminiKey);
        if (!ttsRes || !ttsRes.audioBase64) {
          throw new Error('No TTS audio');
        }

        const binary = atob(ttsRes.audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let j = 0; j < binary.length; j++) {
          bytes[j] = binary.charCodeAt(j);
        }

        const duration = await this.pcmSink.playAudioBuffer(bytes.buffer);
        reportFirstSound(true);
        await new Promise((resolve) => setTimeout(resolve, Math.max(100, Math.round(duration * 1000))));
      } catch {
        this.callbacks.onVoiceFailure('Gemini 음성 실패: 기본 음성 전환');
        await new Promise<void>((resolve) => {
          this.speaker?.speak(
            sentence,
            () => reportFirstSound(false),
            () => resolve(),
            () => !this.isRunning || !this.isSpeaking
          );
        });
      }
    }

    this.onPlaybackFinished();
  }

  private async playPipeline(
    sentences: string[],
    apiKey: string,
    voice: TtsVoice,
    committedAt: number | null,
    lastSpeechAt: number | null,
    modelMs: number | null,
    isGreeting: boolean
  ): Promise<void> {
    if (!this.isRunning || this.isMutedProvider()) return;

    this.isSpeaking = true;
    this.awaitingReply = false;
    this.stopRecognition();
    this.clearTurnTimer();
    this.utteranceWindow.reset();
    this.callbacks.onPhase('Speaking');

    const firstSoundReported = { value: false };
    const firstSentenceReadyAt = performance.now();

    const reportFirstSound = (remote: boolean) => {
      if (firstSoundReported.value) return;
      firstSoundReported.value = true;
      const now = performance.now();
      const firstSoundMs = committedAt ? Math.round(now - committedAt) : Math.round(now - firstSentenceReadyAt);
      const voiceMs = Math.round(now - firstSentenceReadyAt);

      this.callbacks.onLatency({
        firstSoundMs,
        modelMs,
        source: 'Ai',
        sinceSpeechMs: lastSpeechAt ? Math.round(now - lastSpeechAt) : null,
        voiceMs,
        remoteVoice: remote,
      });

      if (this.bargeInArmTimer) clearTimeout(this.bargeInArmTimer);
      this.bargeInArmTimer = window.setTimeout(() => {
        if (this.isRunning && this.isSpeaking && !this.isMutedProvider()) {
          this.bargeInArmed = true;
          this.startListeningForBargeIn();
        }
      }, VoiceCallEngine.BARGE_IN_ARM_DELAY_MS);
    };

    if (!this.pcmSink) {
      this.pcmSink = new PcmAudioSink(24000);
    }
    this.pcmSink.setPlaybackStartListener(() => reportFirstSound(true));

    for (let i = 0; i < sentences.length; i++) {
      if (!this.isRunning || !this.isSpeaking || this.isMutedProvider()) break;
      const sentence = sentences[i];

      try {
        const payload = OpenRouterClient.buildTtsPayload(voice, sentence);
        const res = await fetch(OpenRouterClient.TTS_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          throw new Error('TTS response not ok');
        }

        const buffer = await res.arrayBuffer();
        if (buffer.byteLength === 0) throw new Error('Empty TTS buffer');

        this.pcmSink.writePcm(new Uint8Array(buffer));
        reportFirstSound(true);
      } catch {
        this.callbacks.onVoiceFailure('음성 실패: 기본 음성 전환');
        await new Promise<void>((resolve) => {
          this.speaker?.speak(
            sentence,
            () => reportFirstSound(false),
            () => resolve(),
            () => !this.isRunning || !this.isSpeaking
          );
        });
      }
    }

    this.onPlaybackFinished();
  }

  private playSpeechSentences(
    sentences: string[],
    committedAt: number | null,
    lastSpeechAt: number | null,
    source: ReplySource,
    modelMs: number | null,
    isGreeting: boolean
  ): void {
    if (!this.isRunning || this.isMutedProvider()) return;

    this.isSpeaking = true;
    this.awaitingReply = false;
    this.stopRecognition();
    this.clearTurnTimer();
    this.utteranceWindow.reset();
    this.callbacks.onPhase('Speaking');

    const firstSoundReported = { value: false };
    const readyAt = performance.now();

    const reportFirstSound = () => {
      if (firstSoundReported.value) return;
      firstSoundReported.value = true;
      const now = performance.now();
      const firstSoundMs = committedAt ? Math.round(now - committedAt) : Math.round(now - readyAt);
      const voiceMs = Math.round(now - readyAt);

      this.callbacks.onLatency({
        firstSoundMs,
        modelMs,
        source,
        sinceSpeechMs: lastSpeechAt ? Math.round(now - lastSpeechAt) : null,
        voiceMs,
        remoteVoice: false,
      });

      if (this.bargeInArmTimer) clearTimeout(this.bargeInArmTimer);
      this.bargeInArmTimer = window.setTimeout(() => {
        if (this.isRunning && this.isSpeaking && !this.isMutedProvider()) {
          this.bargeInArmed = true;
          this.startListeningForBargeIn();
        }
      }, VoiceCallEngine.BARGE_IN_ARM_DELAY_MS);
    };

    let idx = 0;
    const playNext = () => {
      if (!this.isRunning || !this.isSpeaking || this.isMutedProvider() || idx >= sentences.length) {
        this.onPlaybackFinished();
        return;
      }

      const text = sentences[idx++];
      this.speaker?.speak(
        text,
        () => reportFirstSound(),
        () => playNext(),
        () => !this.isRunning || !this.isSpeaking
      );
    };

    playNext();
  }

  private onPlaybackFinished(): void {
    if (!this.isRunning) return;
    this.isSpeaking = false;
    this.bargeInArmed = false;
    this.awaitingReply = false;
    this.stopRecognition();

    if (this.isMutedProvider()) {
      this.callbacks.onPhase('Idle');
    } else {
      window.setTimeout(() => {
        if (this.isRunning && !this.isSpeaking && !this.isMutedProvider() && !this.awaitingReply) {
          this.startListening();
        }
      }, 250);
    }
  }
}
