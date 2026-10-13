import React, { useState } from "react";
import { User } from "firebase/auth";
import { X, Loader2, ClipboardPaste, CheckCircle2 } from "lucide-react";
import { authJson } from "../../services/api/authFetch";
import { saveCallMistakes, MistakeData } from "../../services/firebase/db";
import { recordUsage } from "../../services/usage/usageService";

interface ParsedItem {
  myPhrase: string;
  naturalPhrase: string;
  reason: string;
  selected: boolean;
}

/** B-10 Keep 가져오기: paste → gemini-3.8-flash preview → confirm → mistakes (source=keep_import, stage 1) */
export const KeepImportModal: React.FC<{ user: User; onClose: () => void; onSaved?: (n: number) => void }> = ({
  user,
  onClose,
  onSaved,
}) => {
  const [text, setText] = useState("");
  const [items, setItems] = useState<ParsedItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  const parse = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await authJson<{ items: Omit<ParsedItem, "selected">[]; usage?: { inputTokens: number; outputTokens: number } }>(
        "/api/keep/parse",
        { text }
      );
      setItems(res.items.map((it) => ({ ...it, selected: true })));
      if (res.usage) recordUsage(user.uid, { textInputTokens: res.usage.inputTokens, textOutputTokens: res.usage.outputTokens });
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!items) return;
    setBusy(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      const docs: MistakeData[] = items
        .filter((i) => i.selected)
        .map((i) => ({
          createdAt: now,
          source: "keep_import",
          lessonTitle: "Keep 가져오기",
          myPhrase: i.myPhrase,
          naturalPhrase: i.naturalPhrase,
          reason: i.reason,
          sourceStt: "keep_import",
          stage: 1,
          status: "reviewing",
        }));
      const ids = await saveCallMistakes(user.uid, docs);
      setSaved(ids.length);
      onSaved?.(ids.length);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const selectedCount = items?.filter((i) => i.selected).length || 0;
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3">
      <div className="w-full max-w-3xl max-h-[92vh] overflow-y-auto bg-[#161D2A] border border-slate-800 rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div>
            <div className="text-xs font-bold text-emerald-400">Keep 가져오기 (B-10)</div>
            <div className="text-lg font-black text-white">English mistake log 붙여넣기</div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          {error && <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">{error}</div>}
          {saved !== null ? (
            <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 text-sm flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5" /> {saved}개를 실수 보관함에 저장했어요 (1일 단계부터 복습).
            </div>
          ) : !items ? (
            <>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={12}
                placeholder="Keep 목록 텍스트를 그대로 붙여넣으세요."
                className="w-full bg-[#121824] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono focus:outline-none focus:border-emerald-400"
              />
              <button
                onClick={parse}
                disabled={busy || !text.trim()}
                className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-xs font-black flex items-center gap-1.5 cursor-pointer"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ClipboardPaste className="w-3.5 h-3.5" />} 미리보기
              </button>
            </>
          ) : (
            <>
              <div className="text-xs text-slate-300">
                {items.length}개 문장을 찾았어요. 저장할 항목을 고르세요. (선택 {selectedCount}개)
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-slate-400">
                    <tr>
                      <th className="p-2 w-8"></th>
                      <th className="p-2 text-left">내가 한 말</th>
                      <th className="p-2 text-left">자연스러운 표현</th>
                      <th className="p-2 text-left">이유</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, i) => (
                      <tr key={i} className="border-t border-slate-800 align-top">
                        <td className="p-2">
                          <input
                            type="checkbox"
                            checked={it.selected}
                            onChange={() => setItems(items.map((x, j) => (j === i ? { ...x, selected: !x.selected } : x)))}
                          />
                        </td>
                        <td className="p-2 text-rose-300">{it.myPhrase}</td>
                        <td className="p-2 text-emerald-300">{it.naturalPhrase}</td>
                        <td className="p-2 text-slate-300">{it.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={save}
                  disabled={busy || selectedCount === 0}
                  className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-xs font-black flex items-center gap-1.5 cursor-pointer"
                >
                  {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} 확인 · {selectedCount}개 저장
                </button>
                <button onClick={() => setItems(null)} className="px-4 py-2 rounded-xl bg-slate-800 text-slate-200 text-xs font-bold cursor-pointer">
                  다시 붙여넣기
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
