import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeLectureAudio, findFfmpeg, resetFfmpegCache, wavFromPcm } from '../server/lectureAudioEncode.ts';

test('wavFromPcm writes a 44-byte header plus PCM', () => {
  const pcm = Buffer.alloc(4800);
  const wav = wavFromPcm(pcm, 24000);
  assert.equal(wav.length, 44 + 4800);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
});

test('encodeLectureAudio uses ffmpeg when present and shrinks a long silent buffer', async () => {
  resetFfmpegCache();
  const ffmpeg = findFfmpeg();
  const pcm = Buffer.alloc(24000 * 2 * 5); // 5 seconds of silence
  const wav = wavFromPcm(pcm, 24000);
  if (!ffmpeg) {
    const out = await encodeLectureAudio(pcm, 24000);
    assert.equal(out.ext, 'wav');
    assert.equal(out.buffer.length, wav.length);
    return;
  }
  const out = await encodeLectureAudio(pcm, 24000);
  assert.ok(out.ext === 'm4a' || out.ext === 'mp3');
  assert.ok(out.buffer.length < wav.length / 2, `encoded ${out.buffer.length} vs wav ${wav.length}`);
});

test('encodeLectureAudio falls back to wav when FFMPEG_PATH is missing', async () => {
  const prev = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = '/no/such/ffmpeg';
  resetFfmpegCache();
  try {
    const pcm = Buffer.alloc(2400);
    const out = await encodeLectureAudio(pcm, 24000);
    assert.equal(out.ext, 'wav');
    assert.equal(out.mime, 'audio/wav');
  } finally {
    if (prev === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prev;
    resetFfmpegCache();
  }
});
