import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { Mp3Encoder } from '@breezystack/lamejs';

const execFileP = promisify(execFile);

export type EncodedLectureAudio = {
  ext: 'm4a' | 'mp3' | 'wav';
  mime: 'audio/mp4' | 'audio/mpeg' | 'audio/wav';
  buffer: Buffer;
};

export const LECTURE_MP3_KBPS = 48;

export function wavFromPcm(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

let cachedFfmpeg: string | null | undefined;

export function resetFfmpegCache(): void {
  cachedFfmpeg = undefined;
}

export function findFfmpeg(): string | null {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg;
  const env = process.env.FFMPEG_PATH?.trim();
  if (env) {
    cachedFfmpeg = fs.existsSync(env) ? env : null;
    return cachedFfmpeg;
  }
  try {
    const out = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim();
    cachedFfmpeg = out || null;
  } catch {
    cachedFfmpeg = null;
  }
  return cachedFfmpeg;
}

export function mimeForAudioFile(fileName: string | undefined): EncodedLectureAudio['mime'] {
  if (fileName?.endsWith('.m4a')) return 'audio/mp4';
  if (fileName?.endsWith('.mp3')) return 'audio/mpeg';
  return 'audio/wav';
}

export type LectureEncodeFn = (pcm: Buffer, rate: number) => Promise<EncodedLectureAudio>;

/** Yield to the event loop this often while encoding (64 frames ≈ 3s of 24kHz audio). */
export const LAME_YIELD_EVERY_FRAMES = 64;

/** Encode 16-bit LE mono PCM to 48kbps MP3 using pure-JS lamejs. Yields periodically so the event loop is not blocked for a full lecture. */
export async function encodePcmToMp3(pcm: Buffer, rate: number): Promise<Buffer> {
  if (!Buffer.isBuffer(pcm) || pcm.length < 2) {
    throw new Error('Cannot encode empty PCM buffer to MP3');
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Invalid sample rate: ${rate}`);
  }
  const usableBytes = pcm.length - (pcm.length % 2);
  let samples: Int16Array;
  if (pcm.byteOffset % 2 === 0) {
    samples = new Int16Array(pcm.buffer, pcm.byteOffset, usableBytes / 2);
  } else {
    const aligned = Buffer.allocUnsafe(usableBytes);
    pcm.copy(aligned, 0, 0, usableBytes);
    samples = new Int16Array(aligned.buffer, aligned.byteOffset, usableBytes / 2);
  }

  const enc = new Mp3Encoder(1, rate, LECTURE_MP3_KBPS);
  const block = 1152;
  const parts: Buffer[] = [];
  let frames = 0;
  for (let i = 0; i < samples.length; i += block) {
    const buf = enc.encodeBuffer(samples.subarray(i, i + block));
    if (buf && buf.length) parts.push(Buffer.from(buf));
    frames += 1;
    if (frames % LAME_YIELD_EVERY_FRAMES === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  const end = enc.flush();
  if (end && end.length) parts.push(Buffer.from(end));
  const out = Buffer.concat(parts);
  if (out.length === 0) {
    throw new Error('MP3 encoding produced empty output');
  }
  return out;
}

/** Parse a standard 16-bit mono PCM WAV buffer and return its sample rate and raw PCM slice. */
export function parsePcmWav(wav: Buffer): { rate: number; channels: number; bitsPerSample: number; pcm: Buffer } {
  if (!Buffer.isBuffer(wav) || wav.length < 44) {
    throw new Error('Invalid WAV buffer: too short');
  }
  if (wav.subarray(0, 4).toString('ascii') !== 'RIFF' || wav.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('Invalid WAV header');
  }
  let offset = 12;
  let audioFormat: number | undefined;
  let channels: number | undefined;
  let rate: number | undefined;
  let bitsPerSample: number | undefined;
  let pcm: Buffer | undefined;

  while (offset + 8 <= wav.length) {
    const chunkId = wav.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = wav.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = Math.min(wav.length, bodyStart + chunkSize);
    if (chunkId === 'fmt ' && chunkSize >= 16 && bodyStart + 16 <= wav.length) {
      audioFormat = wav.readUInt16LE(bodyStart);
      channels = wav.readUInt16LE(bodyStart + 2);
      rate = wav.readUInt32LE(bodyStart + 4);
      bitsPerSample = wav.readUInt16LE(bodyStart + 14);
    } else if (chunkId === 'data') {
      pcm = wav.subarray(bodyStart, bodyEnd);
      break;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (audioFormat !== 1 || !rate || !channels || bitsPerSample !== 16 || !pcm) {
    throw new Error('Unsupported WAV format: expected 16-bit PCM');
  }
  if (channels !== 1) {
    throw new Error(`Unsupported WAV channels: ${channels}`);
  }
  return { rate, channels, bitsPerSample, pcm };
}

async function encodeWavAndPcmToMp3(wav: Buffer, pcm: Buffer, rate: number): Promise<EncodedLectureAudio> {
  const ffmpeg = findFfmpeg();
  if (ffmpeg) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lec-aud-'));
    const inPath = path.join(dir, 'in.wav');
    const outPath = path.join(dir, 'out.mp3');
    try {
      fs.writeFileSync(inPath, wav);
      await execFileP(
        ffmpeg,
        ['-y', '-i', inPath, '-c:a', 'libmp3lame', '-b:a', `${LECTURE_MP3_KBPS}k`, outPath],
        {
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
        }
      );
      const buffer = fs.readFileSync(outPath);
      if (buffer.length > 0) return { ext: 'mp3', mime: 'audio/mpeg', buffer };
    } catch {
      // fall back to pure-JS lamejs when ffmpeg fails or lacks libmp3lame
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const buffer = await encodePcmToMp3(pcm, rate);
  return { ext: 'mp3', mime: 'audio/mpeg', buffer };
}

/** Encode 16-bit mono PCM to 48kbps MP3 (ffmpeg libmp3lame if available, otherwise pure-JS lamejs). */
export async function encodeLectureAudio(pcm: Buffer, rate: number): Promise<EncodedLectureAudio> {
  if (!Buffer.isBuffer(pcm) || pcm.length < 2) {
    throw new Error('Cannot encode empty PCM buffer to MP3');
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Invalid sample rate: ${rate}`);
  }
  const wav = wavFromPcm(pcm, rate);
  return encodeWavAndPcmToMp3(wav, pcm, rate);
}

/** Transcode a 16-bit mono PCM WAV buffer to 48kbps MP3. */
export async function transcodeWavToMp3(wav: Buffer): Promise<EncodedLectureAudio> {
  const { pcm, rate } = parsePcmWav(wav);
  return encodeWavAndPcmToMp3(wav, pcm, rate);
}
