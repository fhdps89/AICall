import React, { useEffect, useState } from "react";
import { KeyRound, Loader2, Trash2 } from "lucide-react";
import { saveUserGeminiKey, deleteUserGeminiKey, getUserGeminiKeyHint } from "../../services/firebase/db";
import { authJson } from "../../services/api/authFetch";

interface KeyStatus {
  hasServerKey: boolean;
  keySource: string;
}

function describe(st: KeyStatus | null): string {
  if (!st) return "확인 중…";
  if (!st.hasServerKey) return "서버에 쓸 수 있는 키가 없어요. 아래에 키를 저장해 주세요.";
  if (st.keySource === "firestore:user-settings") return "여기 저장한 키로 통화하고 있어요.";
  return "배포 서버 자체 키(AI Studio Secrets)로 통화하고 있어요. 여기 저장한 키는 쓰지 않아요.";
}

/** Fallback for AI Studio Publish not passing Secrets to the server: save the key in your own Firestore. */
export const GeminiKeyPanel: React.FC<{ userId?: string }> = ({ userId }) => {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    const st = await authJson<KeyStatus>("/api/gemini/key-refresh", {});
    setStatus(st);
    return st;
  };

  useEffect(() => {
    if (!userId) return;
    getUserGeminiKeyHint(userId).then(setHint).catch(() => setHint(null));
    refresh().catch((e) => setMsg(`상태 확인 실패: ${e?.message || e}`));
  }, [userId]);

  const save = async () => {
    const key = input.trim();
    if (!userId) return;
    if (key.length < 20 || /\s/.test(key)) {
      setMsg("키 형식이 이상해요. AI Studio의 API Keys 화면에서 키 전체를 복사해 붙여 넣어 주세요.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await saveUserGeminiKey(userId, key);
      setHint(key.slice(-4));
      setInput("");
      const st = await refresh();
      setMsg(st.hasServerKey ? "저장했어요. 이제 통화를 걸어 보세요." : "저장했지만 서버가 아직 키를 못 읽었어요. 잠시 뒤 다시 열어 주세요.");
    } catch (e: any) {
      setMsg(`저장 실패: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!userId || !confirm("저장한 키를 지울까요? 배포 서버에 자체 키가 없으면 통화가 안 돼요.")) return;
    setBusy(true);
    try {
      await deleteUserGeminiKey(userId);
      setHint(null);
      await refresh();
      setMsg("지웠어요.");
    } catch (e: any) {
      setMsg(`삭제 실패: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs">
        <span className="font-bold flex items-center gap-1.5 mb-1">
          <KeyRound className="w-4 h-4 text-amber-400" />
          Gemini API 키 (배포 서버에 키가 없을 때만 사용)
        </span>
        <p className="text-[11px] text-amber-300/80 leading-relaxed">
          AI Studio에서 Publish한 서버에 Secrets 키가 전달되지 않는 문제가 있어서 만든 우회 방법이에요. 키는 내 계정의 Firestore에만 저장되고, 서버는 메모리에만 들고 있어요.
        </p>
      </div>

      <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 text-xs text-slate-300 space-y-1">
        <div>현재 상태: {describe(status)}</div>
        <div>저장된 키: {hint ? `…${hint}` : "없음"}</div>
      </div>

      <div className="space-y-2">
        <input
          type="password"
          autoComplete="off"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="AIza… 로 시작하는 Gemini API 키 붙여 넣기"
          className="w-full bg-[#121824] border border-slate-700 rounded-lg px-3.5 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-400"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={busy || !input.trim()}
            className="px-4 py-2 rounded-lg bg-amber-500 text-slate-900 text-xs font-bold disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            키 저장
          </button>
          {hint && (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="px-4 py-2 rounded-lg border border-slate-700 text-slate-300 text-xs flex items-center gap-1.5 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              키 지우기
            </button>
          )}
        </div>
      </div>

      {msg && <p className="text-[11px] text-slate-300">{msg}</p>}
    </div>
  );
};
