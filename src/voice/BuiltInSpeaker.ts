export class BuiltInSpeaker {
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private onErrorCallback?: (msg: string) => void;

  constructor(onErrorCallback?: (msg: string) => void) {
    this.onErrorCallback = onErrorCallback;
  }

  speak(
    text: string,
    onStart?: () => void,
    onEnd?: () => void,
    isCancelled?: () => boolean
  ): void {
    if (!('speechSynthesis' in window)) {
      this.onErrorCallback?.('이 브라우저에서는 음성 합성을 지원하지 않습니다.');
      onEnd?.();
      return;
    }

    if (isCancelled && isCancelled()) return;

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    // Pick Korean voice if available
    const voices = window.speechSynthesis.getVoices();
    const koreanVoice =
      voices.find((v) => v.lang === 'ko-KR' || v.lang === 'ko_KR') ||
      voices.find((v) => v.lang.startsWith('ko'));
    if (koreanVoice) {
      utterance.voice = koreanVoice;
    }

    let started = false;
    utterance.onstart = () => {
      if (isCancelled && isCancelled()) {
        window.speechSynthesis.cancel();
        return;
      }
      started = true;
      onStart?.();
    };

    utterance.onend = () => {
      this.currentUtterance = null;
      onEnd?.();
    };

    utterance.onerror = (e) => {
      this.currentUtterance = null;
      if (e.error !== 'canceled' && e.error !== 'interrupted') {
        this.onErrorCallback?.(`음성 출력 오류: ${e.error}`);
      }
      onEnd?.();
    };

    this.currentUtterance = utterance;

    // Workaround for Chrome voice bug
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }

    window.speechSynthesis.speak(utterance);

    // Fallback if onstart takes too long or doesn't fire
    setTimeout(() => {
      if (!started && this.currentUtterance === utterance) {
        onStart?.();
      }
    }, 150);
  }

  stop(): void {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.currentUtterance = null;
  }
}
