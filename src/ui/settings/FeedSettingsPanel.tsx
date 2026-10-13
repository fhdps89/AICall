import React, { useEffect, useState } from "react";
import { Copy, RefreshCw, Rss, Loader2 } from "lucide-react";
import { syncFeed, rotateFeedSecret, feedUrls, grokBotInstruction } from "../../services/feed/feedService";

/** B-8 settings: feed URL, Grok Bot instruction, rotate secret */
export const FeedSettingsPanel: React.FC<{ userId?: string }> = ({ userId }) => {
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    syncFeed(userId)
      .then(setSecret)
      .catch((e) => setMsg(`피드 동기화 실패: ${e?.message || e}`));
  }, [userId]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMsg("복사했어요.");
    } catch {
      setMsg("복사 실패: 직접 선택해서 복사해 주세요.");
    }
  };

  const rotate = async () => {
    if (!userId || !confirm("비밀키를 새로 바꾸면 기존 피드 주소는 바로 막혀요. 그록봇에 새 주소를 다시 알려 줘야 해요. 계속할까요?")) return;
    setBusy(true);
    try {
      setSecret(await rotateFeedSecret(userId));
      setMsg("새 비밀키로 바꿨어요.");
    } catch (e: any) {
      setMsg(`변경 실패: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  if (!userId) return <div className="text-xs text-slate-400">로그인 후 사용할 수 있어요.</div>;
  if (!secret) return <div className="text-xs text-slate-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />피드 준비 중… {msg}</div>;
  const urls = feedUrls(secret);
  const instruction = grokBotInstruction(urls.page);
  const box = "w-full bg-[#121824] border border-slate-700 rounded-lg px-3 py-2 text-[11px] text-slate-200 font-mono break-all";
  return (
    <div className="space-y-4">
      <div className="p-3 rounded-lg bg-sky-500/5 border border-sky-500/20 text-xs text-sky-300 flex gap-2">
        <Rss className="w-4 h-4 shrink-0" />
        이 주소는 로그인 없이 열려요. 비밀키가 곧 열쇠이니 그록봇 외에는 공유하지 마세요. 주소가 열렸을 때 오늘 강의가 없고 새 실수·복습 대상이 있으면 그 자리에서 강의 생성을 시작해요.
      </div>
      {[["사람이 읽는 페이지", urls.page], ["JSON", urls.json], ["그록봇에 줄 말", instruction]].map(([label, val]) => (
        <div key={label}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-slate-300">{label}</span>
            <button onClick={() => copy(val)} className="text-[11px] text-sky-300 flex items-center gap-1 cursor-pointer">
              <Copy className="w-3 h-3" /> 복사
            </button>
          </div>
          <div className={box}>{val}</div>
        </div>
      ))}
      <button
        onClick={rotate}
        disabled={busy}
        className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} 비밀키 새로 바꾸기
      </button>
      {msg && <div className="text-[11px] text-slate-400">{msg}</div>}
    </div>
  );
};
