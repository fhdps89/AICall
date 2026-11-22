import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileP = promisify(execFile);

export type EncodedLectureAudio = {
  ext: 'm4a' | 'mp3' | 'wav';
  mime: 'audio/mp4' | 'audio/mpeg' | 'audio/wav';
  buffer: Buffer;
};

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

export async function encodeLectureAudio(pcm: Buffer, rate: number): Promise<EncodedLectureAudio> {
  const wav = wavFromPcm(pcm, rate);
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return { ext: 'wav', mime: 'audio/wav', buffer: wav };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lec-aud-'));
  const inPath = path.join(dir, 'in.wav');
  try {
    fs.writeFileSync(inPath, wav);
    const attempts: Array<{ ext: 'm4a' | 'mp3'; mime: EncodedLectureAudio['mime']; args: string[] }> = [
      {
        ext: 'm4a',
        mime: 'audio/mp4',
        args: ['-y', '-i', inPath, '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart'],
      },
      {
        ext: 'mp3',
        mime: 'audio/mpeg',
        args: ['-y', '-i', inPath, '-c:a', 'libmp3lame', '-b:a', '48k'],
      },
    ];
    for (const attempt of attempts) {
      const outPath = path.join(dir, `out.${attempt.ext}`);
      try {
        await execFileP(ffmpeg, [...attempt.args, outPath], {
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        const buffer = fs.readFileSync(outPath);
        if (buffer.length > 0) return { ext: attempt.ext, mime: attempt.mime, buffer };
      } catch {
        // try the next codec (some builds lack libfdk/aac or lame)
      }
    }
    return { ext: 'wav', mime: 'audio/wav', buffer: wav };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
