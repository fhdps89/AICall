/**
 * Merge recorded audio chunks into one valid WAV file.
 *
 * Each 10-second chunk is a complete, standalone WebM (or MP4) file. Gluing those files
 * together byte-by-byte does NOT make a valid longer file: decoders read only the first
 * part, so most of the call would be lost before transcription. Instead, decode every
 * chunk to PCM, join the samples, and write a 16 kHz mono WAV.
 */

export const STT_SAMPLE_RATE = 16000;
/** Chunks per transcription request: 6 x 10 s = 1 minute (≈1.9 MB WAV, ≈2.6 MB base64). */
export const CHUNKS_PER_MINUTE = 6;

type OfflineCtor = typeof OfflineAudioContext;

function getOfflineCtor(): OfflineCtor | null {
  const w = globalThis as any;
  return (w.OfflineAudioContext || w.webkitOfflineAudioContext || null) as OfflineCtor | null;
}

async function decodeToMono(blob: Blob, ctor: OfflineCtor): Promise<Float32Array> {
  const buf = await blob.arrayBuffer();
  // decodeAudioData resamples to the context rate (16 kHz here).
  const ctx = new ctor(1, 1, STT_SAMPLE_RATE);
  const audio = await ctx.decodeAudioData(buf);
  if (audio.numberOfChannels === 1) return audio.getChannelData(0).slice();
  const out = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < ch.length; i++) out[i] += ch[i] / audio.numberOfChannels;
  }
  return out;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 2;
  const view = new DataView(new ArrayBuffer(44 + dataBytes));
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

/**
 * Decode chunks (in the given order) and return one 16 kHz mono WAV.
 * Chunks that fail to decode are skipped; returns null when nothing decodes
 * or the browser has no Web Audio decoder.
 */
export async function mergeChunksToWav(blobs: Blob[]): Promise<{ wav: Blob; decodedChunks: number; seconds: number } | null> {
  const ctor = getOfflineCtor();
  if (!ctor || blobs.length === 0) return null;
  const parts: Float32Array[] = [];
  for (const b of blobs) {
    try {
      parts.push(await decodeToMono(b, ctor));
    } catch (err) {
      console.warn("[audioMerge] Could not decode a chunk, skipping:", err);
    }
  }
  if (parts.length === 0) return null;
  const total = parts.reduce((n, p) => n + p.length, 0);
  const joined = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    joined.set(p, off);
    off += p.length;
  }
  return { wav: encodeWav(joined, STT_SAMPLE_RATE), decodedChunks: parts.length, seconds: total / STT_SAMPLE_RATE };
}

/** Split chunks into consecutive groups (default: 1-minute groups). */
export function groupChunks<T>(items: T[], size = CHUNKS_PER_MINUTE): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}
