export class PcmAudioSink {
  private audioCtx: AudioContext | null = null;
  private nextPlayTime = 0;
  private sampleRate = 24000;
  private channels = 1;
  private onPlaybackStart?: () => void;
  private hasReportedFirstSound = false;
  private activeSources: AudioBufferSourceNode[] = [];
  private isStopped = false;

  constructor(sampleRate = 24000, channels = 1) {
    this.sampleRate = sampleRate;
    this.channels = channels;
  }

  setPlaybackStartListener(listener: () => void): void {
    this.onPlaybackStart = listener;
  }

  configure(sampleRate: number, channels: number): void {
    this.sampleRate = sampleRate;
    this.channels = channels;
  }

  unlock(): void {
    try {
      const ctx = this.ensureAudioContext();
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      // Play a 1-sample silent buffer to forcefully unlock mobile audio
      const silentBuffer = ctx.createBuffer(1, 1, 24000);
      const source = ctx.createBufferSource();
      source.buffer = silentBuffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch {
      // ignore
    }
  }

  private ensureAudioContext(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioCtxClass({ sampleRate: this.sampleRate });
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  isPlaying(): boolean {
    if (this.isStopped) return false;
    if (!this.audioCtx) return false;
    return this.activeSources.length > 0 || this.audioCtx.currentTime < this.nextPlayTime;
  }

  getRemainingPlayTimeMs(): number {
    if (!this.audioCtx || this.isStopped) return 0;
    const diff = this.nextPlayTime - this.audioCtx.currentTime;
    return Math.max(0, Math.round(diff * 1000));
  }

  reset(): void {
    this.stop();
    this.isStopped = false;
    this.hasReportedFirstSound = false;
  }

  writePcm(data: Uint8Array): void {
    this.isStopped = false;
    const ctx = this.ensureAudioContext();

    // 16-bit LE PCM mono
    const int16Array = new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
    if (int16Array.length === 0) return;

    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }

    const audioBuffer = ctx.createBuffer(this.channels, float32Array.length, this.sampleRate);
    audioBuffer.copyToChannel(float32Array, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startTime = Math.max(now, this.nextPlayTime);
    source.start(startTime);
    this.nextPlayTime = startTime + audioBuffer.duration;

    this.activeSources.push(source);
    source.onended = () => {
      const idx = this.activeSources.indexOf(source);
      if (idx !== -1) {
        this.activeSources.splice(idx, 1);
      }
    };

    if (!this.hasReportedFirstSound) {
      this.hasReportedFirstSound = true;
      const delayMs = Math.max(0, (startTime - now) * 1000);
      setTimeout(() => {
        if (!this.isStopped) {
          this.onPlaybackStart?.();
        }
      }, delayMs);
    }
  }

  async playAudioBuffer(arrayBuffer: ArrayBuffer): Promise<number> {
    if (this.isStopped) return 0;
    const ctx = this.ensureAudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }
    // Clone arrayBuffer because decodeAudioData detaches it
    const copy = arrayBuffer.slice(0);
    const audioBuffer = await ctx.decodeAudioData(copy);
    if (this.isStopped) return 0;

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startTime = Math.max(now, this.nextPlayTime);
    source.start(startTime);
    this.nextPlayTime = startTime + audioBuffer.duration;

    this.activeSources.push(source);
    source.onended = () => {
      const idx = this.activeSources.indexOf(source);
      if (idx !== -1) {
        this.activeSources.splice(idx, 1);
      }
    };

    if (!this.hasReportedFirstSound) {
      this.hasReportedFirstSound = true;
      const delayMs = Math.max(0, (startTime - now) * 1000);
      setTimeout(() => {
        if (!this.isStopped) {
          this.onPlaybackStart?.();
        }
      }, delayMs);
    }

    return audioBuffer.duration;
  }

  stop(): void {
    this.isStopped = true;
    for (const src of this.activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // ignore
      }
    }
    this.activeSources = [];
    this.nextPlayTime = 0;
  }

  release(): void {
    this.stop();
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }
}
