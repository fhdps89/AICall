/**
 * 1-F STT benchmark client: users/{uid}/sttBenchmark/{id}
 * { sentenceRef, myPhrase, naturalPhrase, audioUrl, engine(live|gemini_transcribe|assemblyai), output, errorPreserved, autoSuggested, at }
 */
import { collection, doc, getDocs, setDoc } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "../firebase/config";
import { authJson } from "../api/authFetch";

export type BenchEngine = "live" | "gemini_transcribe" | "assemblyai";
export const BENCH_ENGINES: BenchEngine[] = ["live", "gemini_transcribe", "assemblyai"];
export const ENGINE_LABEL: Record<BenchEngine, string> = {
  live: "① Live 자체 받아쓰기",
  gemini_transcribe: "② gemini-3.5-transcribe VERBATIM",
  assemblyai: "③ AssemblyAI Universal-3.5 Pro",
};

export interface BenchRecord {
  id?: string;
  sentenceRef: string;
  myPhrase: string;
  naturalPhrase: string;
  audioUrl: string | null;
  engine: BenchEngine;
  output: string;
  errorPreserved: boolean;
  autoSuggested: boolean | null;
  at: string;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

function wordDistance(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/**
 * Auto-suggestion (사람이 최종 O/X): the error is "preserved" when the output is
 * closer (word edit distance) to what I actually said (myPhrase) than to the corrected phrase.
 */
export function suggestPreserved(output: string, myPhrase: string, naturalPhrase: string): boolean | null {
  const o = norm(output);
  if (o.length === 0) return null;
  const dm = wordDistance(o, norm(myPhrase));
  const dn = wordDistance(o, norm(naturalPhrase));
  if (dm === dn) return null;
  return dm < dn;
}

export async function getEngineAvailability(): Promise<Record<BenchEngine, boolean>> {
  const r = await authJson<{ engines: Record<BenchEngine, boolean> }>("/api/stt-bench/engines", undefined, "GET");
  return r.engines;
}

export async function runEngine(
  engine: BenchEngine,
  audio: { base64: string; mimeType: string; pcm16kBase64: string }
): Promise<{ ok: boolean; output?: string; error?: string; skipped?: boolean }> {
  try {
    const r = await authJson<{ output: string }>("/api/stt-bench/transcribe", {
      engine,
      audioBase64: engine === "live" ? undefined : audio.base64,
      mimeType: audio.mimeType,
      pcm16kBase64: engine === "live" ? audio.pcm16kBase64 : undefined,
    });
    return { ok: true, output: r.output };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), skipped: /ASSEMBLYAI_API_KEY/.test(String(e?.message)) };
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Decode a recorded blob and resample to 16kHz mono Int16 PCM (base64) for the Live engine. */
export async function blobToPcm16kBase64(blob: Blob): Promise<string> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.ceil(decoded.duration * 16000);
    const off = new OfflineAudioContext(1, frames, 16000);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    const f32 = rendered.getChannelData(0);
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
    return blobToBase64(new Blob([i16.buffer]));
  } finally {
    ctx.close();
  }
}

export async function uploadBenchAudio(uid: string, blob: Blob): Promise<string | null> {
  try {
    const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm";
    const sref = ref(storage, `users/${uid}/sttBenchmark/${Date.now()}.${ext}`);
    await uploadBytes(sref, blob, { contentType: blob.type || "audio/webm" });
    return await getDownloadURL(sref);
  } catch (err) {
    console.warn("[SttBench] audio upload failed:", err);
    return null;
  }
}

export async function saveBenchRecord(uid: string, rec: BenchRecord): Promise<string> {
  const d = doc(collection(db, "users", uid, "sttBenchmark"));
  await setDoc(d, { ...rec, id: d.id });
  return d.id;
}

export async function listBenchRecords(uid: string): Promise<BenchRecord[]> {
  const snap = await getDocs(collection(db, "users", uid, "sttBenchmark"));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as BenchRecord) }));
}

export function preservationTable(records: BenchRecord[]) {
  return BENCH_ENGINES.map((engine) => {
    const rs = records.filter((r) => r.engine === engine);
    const kept = rs.filter((r) => r.errorPreserved).length;
    return { engine, total: rs.length, kept, rate: rs.length ? Math.round((kept / rs.length) * 1000) / 10 : null };
  });
}

export function tableAsMarkdown(records: BenchRecord[]): string {
  const sentences = new Set(records.map((r) => r.sentenceRef)).size;
  const lines = ["| 엔진 | 문장 수 | 보존(O) | 보존율 |", "|---|---|---|---|"];
  for (const r of preservationTable(records)) {
    lines.push(`| ${ENGINE_LABEL[r.engine]} | ${r.total} | ${r.kept} | ${r.rate === null ? "-" : r.rate + "%"} |`);
  }
  return `받아쓰기 품질 시험 결과 (녹음 문장 ${sentences}개)\n` + lines.join("\n");
}
