/**
 * 1-F (B-12 1단계) STT quality benchmark engines.
 * Same recording → ① Live own transcription ② gemini-3.5-transcribe VERBATIM ③ AssemblyAI Universal-3.5 Pro (if ASSEMBLYAI_API_KEY)
 */
import { GoogleGenAI, Modality } from '@google/genai';

export const VERBATIM_PROMPT =
  '언어: 영어. 모드: VERBATIM(있는 그대로 음성 전사). 생략, 요약, 문법 교정 없이 화자가 실제로 말한 단어, 문법적 실수, 감탄사, 망설임을 있는 그대로 토씨 하나 틀리지 않고 텍스트로 옮겨 적으시오. 부가 설명이나 인사말 없이 전사 텍스트만 단독 출력하시오.';

// AssemblyAI docs (POST /v2/transcript): speech_models supported values `universal-3-5-pro`, `universal-2`
export const ASSEMBLYAI_SPEECH_MODELS = ['universal-3-5-pro'];

export function assemblyAvailable(): boolean {
  const k = process.env.ASSEMBLYAI_API_KEY;
  return Boolean(k && k.trim().length > 10 && !k.startsWith('MY_'));
}

export async function transcribeGemini(ai: GoogleGenAI, model: string, audioBase64: string, mimeType: string): Promise<string> {
  const response = await ai.models.generateContent({
    model,
    contents: { parts: [{ inlineData: { data: audioBase64, mimeType } }, { text: VERBATIM_PROMPT }] },
  });
  return response.text?.trim() || '';
}

export async function transcribeAssembly(audio: Buffer): Promise<string> {
  const key = process.env.ASSEMBLYAI_API_KEY!.trim();
  const base = 'https://api.assemblyai.com';
  const up = await fetch(`${base}/v2/upload`, {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/octet-stream' },
    body: new Uint8Array(audio),
  });
  if (!up.ok) throw new Error(`AssemblyAI upload ${up.status}`);
  const { upload_url } = (await up.json()) as any;
  const create = await fetch(`${base}/v2/transcript`, {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify({
      audio_url: upload_url,
      speech_models: ASSEMBLYAI_SPEECH_MODELS,
      language_code: 'en',
      disfluencies: true,
      prompt: 'Verbatim transcription of a non-native English learner. Keep every grammatical error exactly as spoken; do not correct grammar.',
    }),
  });
  if (!create.ok) throw new Error(`AssemblyAI transcript ${create.status}: ${await create.text()}`);
  const { id } = (await create.json()) as any;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await fetch(`${base}/v2/transcript/${id}`, { headers: { authorization: key } });
    const j: any = await poll.json();
    if (j.status === 'completed') return String(j.text || '').trim();
    if (j.status === 'error') throw new Error(`AssemblyAI error: ${j.error}`);
  }
  throw new Error('AssemblyAI timeout');
}

/** Feed recorded 16kHz mono PCM into a Live session and collect its own input transcription. */
export async function transcribeLive(ai: GoogleGenAI, model: string, pcm16kBase64: string): Promise<string> {
  const pcm = Buffer.from(pcm16kBase64, 'base64');
  let text = '';
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => (resolveDone = r));
  const session = await ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      systemInstruction: 'You are a silent transcription probe. Do not answer; reply with a single short "ok".',
    },
    callbacks: {
      onmessage: (msg: any) => {
        const t = msg?.serverContent?.inputTranscription?.text;
        if (t) text += t;
        if (msg?.serverContent?.turnComplete || msg?.serverContent?.generationComplete) resolveDone();
      },
      onerror: () => resolveDone(),
      onclose: () => resolveDone(),
    },
  });
  try {
    const CHUNK = 16000 * 2 * 0.25; // 250ms
    for (let off = 0; off < pcm.length; off += CHUNK) {
      session.sendRealtimeInput({
        audio: { data: pcm.subarray(off, off + CHUNK).toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      });
      await new Promise((r) => setTimeout(r, 60));
    }
    // 1s trailing silence so VAD closes the turn, then explicit stream end
    session.sendRealtimeInput({ audio: { data: Buffer.alloc(32000).toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
    session.sendRealtimeInput({ audioStreamEnd: true });
    await Promise.race([done, new Promise((r) => setTimeout(r, 20000))]);
  } finally {
    try {
      session.close();
    } catch {
      // ignore
    }
  }
  return text.trim();
}
