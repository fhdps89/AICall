import { test } from "node:test";
import assert from "node:assert/strict";
import { toPlayableAudioUrl } from "../src/services/settings/audioPlayable.ts";

function decodeDataUri(uri: string): { mime: string; bytes: Uint8Array } {
  const match = uri.match(/^data:([^;]+);base64,(.+)$/);
  assert.ok(match, `Expected data URI, got: ${uri.slice(0, 40)}`);
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return { mime: match[1], bytes };
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

test("toPlayableAudioUrl wraps raw PCM (audio/pcm and audio/L16) with a 44-byte WAV header", () => {
  const pcm = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
  const pcmBase64 = btoa(String.fromCharCode(...pcm));

  for (const [mimeType, expectedRate] of [
    ["audio/pcm;rate=24000", 24000],
    ["audio/L16;rate=16000", 16000],
    ["audio/pcm", 24000],
  ] as const) {
    const uri = toPlayableAudioUrl(mimeType, pcmBase64);
    const { mime, bytes } = decodeDataUri(uri);
    assert.equal(mime, "audio/wav");
    assert.equal(bytes.length, 44 + pcm.length);

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(readAscii(bytes, 0, 4), "RIFF");
    assert.equal(view.getUint32(4, true), 36 + pcm.length);
    assert.equal(readAscii(bytes, 8, 4), "WAVE");
    assert.equal(readAscii(bytes, 12, 4), "fmt ");
    assert.equal(view.getUint32(16, true), 16);
    assert.equal(view.getUint16(20, true), 1); // PCM
    assert.equal(view.getUint16(22, true), 1); // mono
    assert.equal(view.getUint32(24, true), expectedRate);
    assert.equal(view.getUint32(28, true), expectedRate * 2);
    assert.equal(view.getUint16(32, true), 2);
    assert.equal(view.getUint16(34, true), 16);
    assert.equal(readAscii(bytes, 36, 4), "data");
    assert.equal(view.getUint32(40, true), pcm.length);
    assert.deepEqual(bytes.subarray(44), pcm);
  }
});

test("toPlayableAudioUrl passes through non-PCM audio formats unchanged", () => {
  const b64 = "UklGRg==";
  assert.equal(toPlayableAudioUrl("audio/wav", b64), `data:audio/wav;base64,${b64}`);
  assert.equal(toPlayableAudioUrl("audio/mpeg", b64), `data:audio/mpeg;base64,${b64}`);
  assert.equal(toPlayableAudioUrl(undefined, b64), `data:audio/wav;base64,${b64}`);
});
