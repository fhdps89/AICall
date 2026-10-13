import React, { useEffect, useRef, useState } from "react";
import { User } from "firebase/auth";
import { X, Mic, Square, Loader2, ChevronRight, Copy, Save } from "lucide-react";
import { getUserMistakes, MistakeData } from "../../services/firebase/db";
import { recordUsage } from "../../services/usage/usageService";
import {
  BENCH_ENGINES,
  BenchEngine,
  BenchRecord,
  ENGINE_LABEL,
  blobToBase64,
  blobToPcm16kBase64,
  getEngineAvailability,
  listBenchRecords,
  preservationTable,
  runEngine,
  saveBenchRecord,
  suggestPreserved,
  tableAsMarkdown,
  uploadBenchAudio,
} from "../../services/sttBench/sttBenchService";

interface EngineResult {
  status: "idle" | "running" | "done" | "error" | "skipped";
  output?: string;
  error?: string;
  suggested?: boolean | null;
  judged?: boolean | null; // my O/X
}

/** 1-F 받아쓰기 품질 시험 페이지 (B-12 1단계 완료 조건) */
export const SttBenchmarkModal: React.FC<{ user: User; onClose: () => void }> = ({ user, onClose }) => {
  const [sentences, setSentences] = useState<MistakeData[]>([]);
  const [idx, setIdx] = useState(0);
  const [avail, setAvail] = useState<Record<BenchEngine, boolean> | null>(null);
  const [recording, setRecording] = useState(false);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [results, setResults] = useState<Record<BenchEngine, EngineResult>>(() => emptyResults());
  const [records, setRecords] = useState<BenchRecord[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startRef = useRef<number>(0);

  function emptyResults(): Record<BenchEngine, EngineResult> {
    return { live: { status: "idle" }, gemini_transcribe: { status: "idle" }, assemblyai: { status: "idle" } };
  }

  useEffect(() => {
    (async () => {
      const all = await getUserMistakes(user.uid).catch(() => []);
      const keep = all.filter((m) => m.source === "keep_import");
      setSentences(keep.length ? keep : all);
      setRecords(await listBenchRecords(user.uid).catch(() => []));
      setAvail(await getEngineAvailability().catch(() => ({ live: true, gemini_transcribe: true, assemblyai: false })));
    })();
  }, [user.uid]);

  const cur = sentences[idx];
  const doneRefs = new Set(records.map((r) => r.sentenceRef));

  const startRec = async () => {
    setMsg(null);
    setBlob(null);
    setResults(emptyResults());
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream);
    chunksRef.current = [];
    mr.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
    mr.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const b = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
      setBlob(b);
      runAll(b, (Date.now() - startRef.current) / 60000);
    };
    recRef.current = mr;
    startRef.current = Date.now();
    mr.start();
    setRecording(true);
  };

  const stopRec = () => {
    recRef.current?.stop();
    setRecording(false);
  };

  const runAll = async (b: Blob, minutes: number) => {
    if (!cur) return;
    const [base64, pcm] = await Promise.all([blobToBase64(b), blobToPcm16kBase64(b).catch(() => "")]);
    const audio = { base64, mimeType: b.type || "audio/webm", pcm16kBase64: pcm };
    await Promise.all(
      BENCH_ENGINES.map(async (engine) => {
        if (engine === "assemblyai" && avail && !avail.assemblyai) {
          setResults((r) => ({ ...r, [engine]: { status: "skipped", error: "ASSEMBLYAI_API_KEY 없음" } }));
          return;
        }
        setResults((r) => ({ ...r, [engine]: { status: "running" } }));
        const out = await runEngine(engine, audio);
        if (out.ok) {
          const suggested = suggestPreserved(out.output || "", cur.myPhrase, cur.naturalPhrase);
          setResults((r) => ({ ...r, [engine]: { status: "done", output: out.output, suggested, judged: suggested } }));
          if (engine !== "live") recordUsage(user.uid, { sttMinutes: minutes, sttEngine: engine === "assemblyai" ? "assemblyai" : "gemini" });
          else recordUsage(user.uid, { liveMinutes: minutes });
        } else {
          setResults((r) => ({ ...r, [engine]: { status: out.skipped ? "skipped" : "error", error: out.error } }));
        }
      })
    );
  };

  const judge = (engine: BenchEngine, v: boolean) =>
    setResults((r) => ({ ...r, [engine]: { ...r[engine], judged: v } }));

  const saveAndNext = async () => {
    if (!cur || !blob) return;
    const pending = BENCH_ENGINES.filter((e) => results[e].status === "done");
    if (pending.some((e) => results[e].judged === null || results[e].judged === undefined)) {
      setMsg("모든 엔진 결과에 O/X를 표시해 주세요.");
      return;
    }
    setSaving(true);
    try {
      const audioUrl = await uploadBenchAudio(user.uid, blob);
      const at = new Date().toISOString();
      const saved: BenchRecord[] = [];
      for (const engine of pending) {
        const rec: BenchRecord = {
          sentenceRef: cur.id || "",
          myPhrase: cur.myPhrase,
          naturalPhrase: cur.naturalPhrase,
          audioUrl,
          engine,
          output: results[engine].output || "",
          errorPreserved: Boolean(results[engine].judged),
          autoSuggested: results[engine].suggested ?? null,
          at,
        };
        rec.id = await saveBenchRecord(user.uid, rec);
        saved.push(rec);
      }
      setRecords((r) => [...r, ...saved]);
      setBlob(null);
      setResults(emptyResults());
      setIdx((i) => Math.min(i + 1, sentences.length - 1));
    } catch (e: any) {
      setMsg(`저장 실패: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  const table = preservationTable(records);
  const sentenceCount = new Set(records.map((r) => r.sentenceRef)).size;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3">
      <div className="w-full max-w-3xl max-h-[92vh] overflow-y-auto bg-[#161D2A] border border-slate-800 rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div>
            <div className="text-xs font-bold text-violet-400">받아쓰기 품질 시험 (1-F)</div>
            <div className="text-lg font-black text-white">틀린 문장을 틀린 그대로 읽어 주세요</div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {sentences.length === 0 ? (
            <div className="text-sm text-slate-400">실수 보관함이 비어 있어요. 먼저 Keep 가져오기를 해 주세요.</div>
          ) : (
            <>
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>
                  문장 {idx + 1} / {sentences.length} · 녹음 완료 {sentenceCount}개 (목표 27개 이상)
                </span>
                <button
                  onClick={() => {
                    setIdx((i) => (i + 1) % sentences.length);
                    setBlob(null);
                    setResults(emptyResults());
                  }}
                  className="flex items-center gap-1 text-slate-300 cursor-pointer"
                >
                  건너뛰기 <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
                <div className="text-[11px] text-slate-500 mb-1">읽을 문장 (내가 한 말, 틀린 그대로){cur?.id && doneRefs.has(cur.id) ? " · 이미 녹음함" : ""}</div>
                <div className="text-xl font-bold text-rose-300">{cur?.myPhrase}</div>
                <div className="text-[11px] text-slate-500 mt-2">참고: 자연스러운 표현 — {cur?.naturalPhrase}</div>
              </div>
              <div className="flex gap-2">
                {!recording ? (
                  <button onClick={startRec} className="px-4 py-2 rounded-xl bg-violet-500 hover:bg-violet-400 text-white text-xs font-black flex items-center gap-1.5 cursor-pointer">
                    <Mic className="w-4 h-4" /> 녹음 시작
                  </button>
                ) : (
                  <button onClick={stopRec} className="px-4 py-2 rounded-xl bg-rose-500 hover:bg-rose-400 text-white text-xs font-black flex items-center gap-1.5 cursor-pointer animate-pulse">
                    <Square className="w-4 h-4" /> 녹음 끝
                  </button>
                )}
              </div>

              {blob && (
                <div className="space-y-2">
                  {BENCH_ENGINES.map((engine) => {
                    const r = results[engine];
                    return (
                      <div key={engine} className="p-3 rounded-xl border border-slate-800 bg-slate-900/40">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-slate-200">{ENGINE_LABEL[engine]}</span>
                          {r.status === "done" && (
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] text-slate-500 mr-1">
                                자동 제안: {r.suggested === null ? "판단 어려움" : r.suggested ? "O" : "X"}
                              </span>
                              {[true, false].map((v) => (
                                <button
                                  key={String(v)}
                                  onClick={() => judge(engine, v)}
                                  className={`w-8 h-7 rounded-lg text-xs font-black cursor-pointer ${r.judged === v ? (v ? "bg-emerald-500 text-slate-950" : "bg-rose-500 text-white") : "bg-slate-800 text-slate-300"}`}
                                >
                                  {v ? "O" : "X"}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="text-sm mt-1 text-slate-100">
                          {r.status === "running" ? (
                            <span className="flex items-center gap-1 text-slate-400"><Loader2 className="w-3.5 h-3.5 animate-spin" />받아쓰는 중…</span>
                          ) : r.status === "done" ? (
                            r.output || <span className="text-slate-500">(빈 결과)</span>
                          ) : r.status === "skipped" ? (
                            <span className="text-slate-500">건너뜀: {r.error}</span>
                          ) : r.status === "error" ? (
                            <span className="text-rose-300">오류: {r.error}</span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                  <div className="text-[11px] text-slate-500">O = 원래 틀린 부분이 받아쓰기에 그대로 남았음 · X = 엔진이 고쳐 버렸거나 다르게 적음</div>
                  <button
                    onClick={saveAndNext}
                    disabled={saving || BENCH_ENGINES.some((e) => results[e].status === "running")}
                    className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-xs font-black flex items-center gap-1.5 cursor-pointer"
                  >
                    {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} 저장하고 다음 문장
                  </button>
                </div>
              )}
              {msg && <div className="text-xs text-amber-300">{msg}</div>}
            </>
          )}

          <div className="pt-2 border-t border-slate-800">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-slate-200">엔진별 보존율</span>
              <button
                onClick={() => navigator.clipboard.writeText(tableAsMarkdown(records)).then(() => setMsg("결과 표를 복사했어요."))}
                className="text-[11px] text-violet-300 flex items-center gap-1 cursor-pointer"
              >
                <Copy className="w-3 h-3" /> 결과 표 복사
              </button>
            </div>
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <th className="p-2 text-left">엔진</th>
                  <th className="p-2 text-right">문장</th>
                  <th className="p-2 text-right">보존(O)</th>
                  <th className="p-2 text-right">보존율</th>
                </tr>
              </thead>
              <tbody>
                {table.map((t) => (
                  <tr key={t.engine} className="border-t border-slate-800">
                    <td className="p-2 text-slate-300">{ENGINE_LABEL[t.engine]}</td>
                    <td className="p-2 text-right font-mono">{t.total}</td>
                    <td className="p-2 text-right font-mono">{t.kept}</td>
                    <td className={`p-2 text-right font-mono ${t.rate !== null && t.rate >= 90 ? "text-emerald-300" : "text-slate-200"}`}>
                      {t.rate === null ? "-" : `${t.rate}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-[11px] text-slate-500 mt-1">보존율이 가장 높은 엔진을 STT_ENGINE으로 정해요. 제안 기준 90% 이상 [추정].</div>
          </div>
        </div>
      </div>
    </div>
  );
};
