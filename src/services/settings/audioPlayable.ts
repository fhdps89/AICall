/**
 * 오디오 base64 응답을 브라우저 <audio>에서 재생 가능한 data URI로 변환한다.
 * 원시 PCM(audio/L16, audio/pcm 등)인 경우 44바이트 WAV 헤더를 붙여 audio/wav로 반환한다.
 * 브라우저와 Node 모두에서 동작하도록 Buffer 대신 Uint8Array/DataView/atob/btoa만 사용한다.
 */

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function parseSampleRate(mime: string): number {
  const match = mime.match(/rate=(\d+)/i);
  if (!match) return 24000;
  const parsed = parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24000;
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export function toPlayableAudioUrl(mimeType: string | undefined, base64: string): string {
  const mime = (mimeType || "audio/wav").trim() || "audio/wav";
  const lower = mime.toLowerCase();

  if (!lower.includes("l16") && !lower.includes("pcm")) {
    return `data:${mime};base64,${base64}`;
  }

  const sampleRate = parseSampleRate(mime);
  const pcmBytes = base64ToUint8(base64);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 16-bit mono byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, pcmBytes.length, true);

  const wavBytes = new Uint8Array(44 + pcmBytes.length);
  wavBytes.set(new Uint8Array(header), 0);
  wavBytes.set(pcmBytes, 44);

  return `data:audio/wav;base64,${uint8ToBase64(wavBytes)}`;
}
