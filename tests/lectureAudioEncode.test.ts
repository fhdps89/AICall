import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeLectureAudio,
  encodePcmToMp3,
  findFfmpeg,
  parsePcmWav,
  resetFfmpegCache,
  transcodeWavToMp3,
  wavFromPcm,
} from '../server/lectureAudioEncode.ts';

function withMissingFfmpeg<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = '/no/such/ffmpeg';
  resetFfmpegCache();
  return fn().finally(() => {
    if (prev === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prev;
    resetFfmpegCache();
  });
}

function assertLooksLikeMp3(buf: Buffer) {
  assert.ok(buf.length > 0, 'mp3 buffer must be non-empty');
  const isId3 = buf.subarray(0, 3).toString('ascii') === 'ID3';
  const isMpegSync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
  assert.ok(isId3 || isMpegSync, `unexpected mp3 header bytes: ${buf.subarray(0, 4).toString('hex')}`);
}

test('wavFromPcm writes a 44-byte header plus PCM', () => {
  const pcm = Buffer.alloc(4800);
  const wav = wavFromPcm(pcm, 24000);
  assert.equal(wav.length, 44 + 4800);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  const parsed = parsePcmWav(wav);
  assert.equal(parsed.rate, 24000);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.bitsPerSample, 16);
  assert.equal(parsed.pcm.length, 4800);
});

test('encodeLectureAudio uses ffmpeg libmp3lame when present and returns mp3 (not m4a)', async () => {
  resetFfmpegCache();
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return;
  const pcm = Buffer.alloc(24000 * 2 * 5); // 5 seconds of silence
  const wav = wavFromPcm(pcm, 24000);
  const out = await encodeLectureAudio(pcm, 24000);
  assert.equal(out.ext, 'mp3');
  assert.equal(out.mime, 'audio/mpeg');
  assert.ok(out.buffer.length < wav.length / 2, `encoded ${out.buffer.length} vs wav ${wav.length}`);
  assertLooksLikeMp3(out.buffer);
});

test('encodeLectureAudio falls back to pure-JS lamejs mp3 when FFMPEG_PATH is missing', async () => {
  await withMissingFfmpeg(async () => {
    const pcm = Buffer.alloc(24000 * 2 * 5); // 5 seconds of silence
    const wav = wavFromPcm(pcm, 24000);
    const out = await encodeLectureAudio(pcm, 24000);
    assert.equal(out.ext, 'mp3');
    assert.equal(out.mime, 'audio/mpeg');
    assert.ok(out.buffer.length < wav.length, `encoded ${out.buffer.length} vs wav ${wav.length}`);
    assertLooksLikeMp3(out.buffer);
  });
});

test('encodePcmToMp3 and transcodeWavToMp3 produce valid mp3 without ffmpeg and reject invalid input', async () => {
  const pcm = Buffer.alloc(24000 * 2 * 2);
  const directMp3 = await encodePcmToMp3(pcm, 24000);
  assertLooksLikeMp3(directMp3);

  const wav = wavFromPcm(pcm, 24000);
  await withMissingFfmpeg(async () => {
    const transcoded = await transcodeWavToMp3(wav);
    assert.equal(transcoded.ext, 'mp3');
    assert.equal(transcoded.mime, 'audio/mpeg');
    assert.ok(transcoded.buffer.length < wav.length);
    assertLooksLikeMp3(transcoded.buffer);
  });

  await assert.rejects(() => transcodeWavToMp3(Buffer.from('RIFFdata')));
  await assert.rejects(() => withMissingFfmpeg(() => encodeLectureAudio(Buffer.alloc(0), 24000)));
  await assert.rejects(() => withMissingFfmpeg(() => encodeLectureAudio(pcm, 0)));
});
