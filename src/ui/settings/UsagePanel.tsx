import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { getUsageMonth, UsageMonth } from "../../services/usage/usageService";
import { getKSTToday } from "../../services/firebase/db";
import { PRICING_RATES } from "../../config/models";

/** B-10 이번 달 사용량·예상 비용 */
export const UsagePanel: React.FC<{ userId?: string }> = ({ userId }) => {
  const [usage, setUsage] = useState<UsageMonth | null>(null);
  const [loading, setLoading] = useState(true);
  const today = getKSTToday();
  const month = today.slice(0, 7);

  useEffect(() => {
    if (!userId) return;
    getUsageMonth(userId, month)
      .then(setUsage)
      .catch(() => setUsage(null))
      .finally(() => setLoading(false));
  }, [userId, month]);

  if (!userId) return <div className="text-xs text-slate-400">로그인 후 사용할 수 있어요.</div>;
  if (loading) return <div className="text-xs text-slate-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />불러오는 중…</div>;
  const d = usage?.days?.[today.slice(8, 10)];
  const usd = (n?: number) => `$${(n || 0).toFixed(4)}`;
  const rows: [string, string, string][] = [
    ["통화", `${(usage?.liveMinutes || 0).toFixed(1)}분`, `${(d?.liveMinutes || 0).toFixed(1)}분`],
    ["받아쓰기", `${(usage?.sttMinutes || 0).toFixed(1)}분`, `${(d?.sttMinutes || 0).toFixed(1)}분`],
    ["텍스트 토큰", `${Math.round(usage?.textTokens || 0).toLocaleString()}`, `${Math.round(d?.textTokens || 0).toLocaleString()}`],
    ["TTS 글자 수", `${Math.round(usage?.ttsChars || 0).toLocaleString()}`, `${Math.round(d?.ttsChars || 0).toLocaleString()}`],
    ["예상 비용", usd(usage?.estCostUsd), usd(d?.estCostUsd)],
  ];
  return (
    <div className="space-y-3">
      <table className="w-full text-xs">
        <thead className="text-slate-400">
          <tr>
            <th className="p-2 text-left">항목</th>
            <th className="p-2 text-right">이번 달 ({month})</th>
            <th className="p-2 text-right">오늘</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, m, t]) => (
            <tr key={k} className="border-t border-slate-800">
              <td className="p-2 text-slate-300">{k}</td>
              <td className="p-2 text-right font-mono text-white">{m}</td>
              <td className="p-2 text-right font-mono text-slate-300">{t}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-[11px] text-slate-500">
        예상 비용은 src/config/models.ts 단가표(PRICING_RATES) 기준 추정치예요. 실제 청구액과 다를 수 있어요. 통화 1분 ${PRICING_RATES.livePerMinute} · 받아쓰기 1분 ${PRICING_RATES.sttPerMinuteGemini}
      </div>
    </div>
  );
};
