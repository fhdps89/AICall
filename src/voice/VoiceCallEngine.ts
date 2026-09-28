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
import { GeminiClient, GeminiErrors } from './GeminiClient';
import { OpenRouterClient } from './OpenRouterClient';
import { PersonaPrompt } from './PersonaPrompt';
import { ReplyGenerator } from './ReplyGenerator';
import { SentenceSplitter } from './SentenceSplitter';
import { UtteranceWindow } from './UtteranceWindow';

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

export interface VoiceCallEngineCallbacks {
  onPhase: (phase: CallPhase) => void;
  onPartialText: (text: string) => void;
  onErrorMessage: (msg: string) => void;
  onLatency: (latency: ReplyLatency) => void;
  onReplyOrigin: (origin: ReplyOrigin) => void;
  onVoiceInfo: (info: string) => void;
  onVoiceFailure: (failure: string | null) => void;
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

  private history: ChatTurn[] = [];
  private utteranceWindow = new UtteranceWindow();
  private turnCheckTimer: number | null = null;
  private activeAbortController: AbortController | null = null;
  private bargeInArmTimer: number | null = null;

  private currentBrain: 'OpenRouter' | 'Gemini' | 'Local' = 'Local';
  private currentVoice: TtsVoice | null = null;

  private static readonly MAX_HISTORY_TURNS = 24;
  private static readonly BARGE_IN_ARM_DELAY_MS = 450;

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

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.callbacks.onPhase('Greeting');

    this.speaker = new BuiltInSpeaker((err) => this.callbacks.onErrorMessage(err));
    this.setupSpeechRecognition();

    const orKey = this.openRouterKeyProvider()?.trim() || null;
    const geminiKey = this.apiKeyProvider()?.trim() || null;
    const nick = this.nicknameProvider();

    if (orKey) {
      this.currentBrain = 'OpenRouter';
      this.currentVoice = this.voiceProvider();
    } else if (geminiKey) {
      this.currentBrain = 'Gemini';
      this.currentVoice = null;
    } else {
      this.currentBrain = 'Local';
      this.currentVoice = null;
    }

    this.updateVoiceInfo();

    if (this.currentBrain === 'OpenRouter' && orKey) {
      this.history.push({ role: 'user', text: PersonaPrompt.greetingRequest(nick) });
      this.startOpenRouterReply(orKey, null, null, true);
    } else if (this.currentBrain === 'Gemini' && geminiKey) {
      this.history.push({ role: 'user', text: PersonaPrompt.greetingRequest(nick) });
      this.requestGeminiGreeting(geminiKey, nick);
    } else {
      this.callbacks.onReplyOrigin({ kind: 'LocalNoKey' });
      const greeting = ReplyGenerator.greeting(nick);
      this.startStaticReply(greeting, 'Local', null, null, 'Local', null, true);
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

    this.speaker?.stop();
    this.speaker = null;

    this.pcmSink?.release();
    this.pcmSink = null;

    this.stopRecognition();
    this.recognizer = null;

    this.history = [];
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
      this.callbacks.onPhase('Idle');
    } else {
      if (!this.isSpeaking && !this.isListening) {
        this.startListening();
      }
    }
  }

  private updateVoiceInfo(): void {
    const voicePart = this.currentVoice ? `목소리 ${this.currentVoice.shortLabel}` : '기본 음성';
    let info = '';
    if (this.currentBrain === 'OpenRouter') {
      info = `${OpenRouterClient.CHAT_MODEL} · ${voicePart}`;
    } else if (this.currentBrain === 'Gemini') {
      info = `${GeminiClient.MODEL_ID}(Gemini 키) · ${voicePart}`;
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

  // ---------------------------------------------------------------- STT
  private setupSpeechRecognition(): void {
    const SpeechRecognitionClass =
      (window as unknown as { SpeechRecognition?: new () => WebSpeechRecognition }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => WebSpeechRecognition }).webkitSpeechRecognition;

    if (!SpeechRecognitionClass) {
      this.callbacks.onErrorMessage('이 브라우저에서는 음성 인식을 지원하지 않습니다. 텍스트 입력을 활용하세요.');
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
          // Restart recognition
          setTimeout(() => {
            if (this.isRunning && !this.isMutedProvider() && !this.isSpeaking && !this.awaitingReply) {
              this.startListening();
            }
          }, 300);
        }
      };

      recognition.onerror = (e) => {
        this.recognitionActive = false;
        this.isListening = false;
        if (e.error === 'not-allowed') {
          this.callbacks.onErrorMessage('마이크 권한이 필요합니다.');
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

        let interim = '';
        let final = '';

        for (let i = 0; i < event.results.length; ++i) {
          const res = event.results[i];
          const transcript = res[0]?.transcript || '';
          if (res.isFinal) {
            final += transcript;
          } else {
            interim += transcript;
          }
        }

        const now = performance.now();

        if (final.trim().length > 0) {
          if (this.isSpeaking) {
            this.triggerBargeIn('final speech result');
          }
          this.acceptFinal(final.trim(), now);
        } else if (interim.trim().length > 0) {
          if (this.isSpeaking && this.bargeInArmed) {
            this.triggerBargeIn('partial speech result');
          }
          this.utteranceWindow.onPartial(interim.trim(), now);
          this.callbacks.onPartialText(this.utteranceWindow.displayText(interim.trim()));
        }
      };

      this.recognizer = recognition;
    } catch {
      this.callbacks.onErrorMessage('음성 인식 초기화 오류');
    }
  }

  private startListening(): void {
    if (!this.isRunning || this.isMutedProvider() || this.isSpeaking || this.awaitingReply) return;
    if (this.recognitionActive) return;

    if (!this.utteranceWindow.hasContent) {
      this.callbacks.onPartialText('');
    }
    this.callbacks.onPhase('Listening');

    try {
      this.recognizer?.start();
    } catch {
      // In case already started or error
    }
  }

  private startListeningForBargeIn(): void {
    if (!this.isRunning || this.isMutedProvider() || !this.isSpeaking || !this.bargeInArmed) return;
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
  }

  private triggerBargeIn(why: string): void {
    this.bargeInArmed = false;
    this.cancelActiveAudio();
    this.isSpeaking = false;
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

  /**
   * For testing or when browser microphone is unavailable,
   * manually inject recognized speech as if the user spoke it.
   */
  injectUserSpeech(text: string): void {
    if (!this.isRunning || this.isMutedProvider()) return;
    const cleaned = text.trim();
    if (!cleaned) return;

    if (this.isSpeaking) {
      this.triggerBargeIn('manual user input');
    }
    const now = performance.now();
    this.acceptFinal(cleaned, now);
  }

  private processUserUtterance(text: string, windowClosedAt: number, lastSpeechAt: number | null): void {
    if (!this.isRunning || this.isMutedProvider()) return;
    const cleaned = text.trim();
    if (!cleaned) {
      this.startListening();
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

    if (!orKey && !geminiKey) {
      const reply = ReplyGenerator.reply(cleaned, nick);
      this.callbacks.onReplyOrigin({ kind: 'LocalNoKey' });
      this.startStaticReply(reply, 'Local', windowClosedAt, lastSpeechAt, 'Local', null);
      return;
    }

    this.history.push({ role: 'user', text: cleaned });
    while (this.history.length > VoiceCallEngine.MAX_HISTORY_TURNS) {
      this.history.shift();
    }

    if (orKey) {
      this.startOpenRouterReply(orKey, windowClosedAt, lastSpeechAt, false);
      return;
    }

    if (geminiKey) {
      this.requestGeminiReply(geminiKey, nick, windowClosedAt, lastSpeechAt);
    }
  }

  // ---------------------------------------------------------------- Gemini Request
  private async requestGeminiGreeting(apiKey: string, nickname: string): Promise<void> {
    const startedAt = performance.now();
    try {
      const res = await GeminiClient.executeRequest(
        apiKey,
        PersonaPrompt.systemInstruction(nickname),
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
        PersonaPrompt.systemInstruction(nickname),
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
      // Drop the unanswered user turn
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
    let chatStartedAt = performance.now();
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
    brain: 'OpenRouter' | 'Gemini' | 'Local',
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
    this.playSpeechSentences(sentences, committedAt, lastSpeechAt, source, modelMs, isGreeting);
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
    // Attempt progressive PCM synthesis via OpenRouter TTS for each sentence
    // If it fails or times out, fallback seamlessly to BuiltInSpeaker
    if (!this.isRunning || this.isMutedProvider()) return;

    this.isSpeaking = true;
    this.awaitingReply = false;
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

      // Arm barge-in shortly after audio starts
      if (this.bargeInArmTimer) clearTimeout(this.bargeInArmTimer);
      this.bargeInArmTimer = window.setTimeout(() => {
        if (this.isRunning && this.isSpeaking && !this.isMutedProvider()) {
          this.bargeInArmed = true;
          this.startListeningForBargeIn();
        }
      }, VoiceCallEngine.BARGE_IN_ARM_DELAY_MS);
    };

    if (!this.pcmSink) {
      this.pcmSink = new PcmAudioSink();
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
        // Fallback to built-in speech synthesis
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
      this.startListening();
    }
  }
}
