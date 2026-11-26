import React, { useEffect, useState } from "react";
import { Loader2, Flame } from "lucide-react";
import {
  getUsageMonths,
  lectureAudioCostPerMinute,
  liveCostPerMinute,
  liveUsageBasis,
  priceUsage,
  USAGE_COST_COMPONENTS,
  UsageDay,
  UsageMonth,
} from "../../services/usage/usageService";
import {
  getRecentMonthKeys,
  isActiveLearningDay,
  summarizeLearningLog,
} from "../../services/usage/learningLog";
import { getKSTToday } from "../../services/firebase/db";
import { useDevMode } from "../../data/devMode";

/** B-10 이번 달 사용량·예상 비용 + 내 학습 기록 */
export const UsagePanel: React.FC<{ userId?: string }> = ({ userId }) => {
  const devMode = useDevMode();
  const [months, setMonths] = useState<Record<string, UsageMonth | null>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const today = getKSTToday();
  const month = today.slice(0, 7);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    getUsageMonths(userId, getRecentMonthKeys(today, 3))
      .then((res) => {
        if (!cancelled) {
          setMonths(res);
          setLoadError(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMonths({});
          setLoadError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, today]);

  if (!userId) return <div className="text-xs text-slate-400">로그인 후 사용할 수 있어요.</div>;
  if (loading) return <div className="text-xs text-slate-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />불러오는 중…</div>;

  const usage = months[month] ?? null;
  const log = summarizeLearningLog(months, today);
  const hasCallHistory =
    log.thisMonth.calls > 0 ||
    log.thisMonth.minutes > 0 ||
    log.bestStreakDays > 0 ||
    Object.values(months).some(
      (m) => (m?.calls || 0) > 0 || (m?.liveMinutes || 0) > 0 || (m?.pocMinutes || 0) > 0
    );
  const maxRecentMinutes = Math.max(
    1,
    ...log.recentDays.map((day) => day.minutes)
  );

  const d = usage?.days?.[today.slice(8, 10)];
  const monthCost = priceUsage(usage);
  const dayCost = priceUsage(d);
  const monthBasis = liveUsageBasis(usage);
  const dayBasis = liveUsageBasis(d);
  const livePerMin = liveCostPerMinute(usage);
  const lectureAudioPerMin = lectureAudioCostPerMinute();
  const usd = (n?: number) => `$${(n || 0).toFixed(4)}`;
  const fmtBasis = (b: { measuredMinutes: number; estimatedMinutes: number }) =>
    `실측 ${b.measuredMinutes.toFixed(1)}분 · 추정 ${b.estimatedMinutes.toFixed(1)}분`;
  const fmtLiveTokens = (u: UsageDay | UsageMonth | null | undefined) => {
    const inTok = Math.round(
      (u?.liveInputAudioTokens || 0) +
        (u?.liveInputTextTokens || 0) +
        (u?.qaLiveInputAudioTokens || 0) +
        (u?.qaLiveInputTextTokens || 0)
    );
    const outTok = Math.round(
      (u?.liveOutputAudioTokens || 0) +
        (u?.liveOutputTextTokens || 0) +
        (u?.liveThoughtTokens || 0) +
        (u?.qaLiveOutputAudioTokens || 0) +
        (u?.qaLiveOutputTextTokens || 0) +
        (u?.qaLiveThoughtTokens || 0)
    );
    return `in ${inTok.toLocaleString()} · out ${outTok.toLocaleString()}`;
  };
  const rows: [string, string, string][] = [
    ["통화", `${(usage?.liveMinutes || 0).toFixed(1)}분`, `${(d?.liveMinutes || 0).toFixed(1)}분`],
    ["받아쓰기", `${(usage?.sttMinutes || 0).toFixed(1)}분`, `${(d?.sttMinutes || 0).toFixed(1)}분`],
    ...(devMode
      ? ([
          ["시험 통화(구글 스트리밍)", `${(usage?.pocMinutes || 0).toFixed(1)}분`, `${(d?.pocMinutes || 0).toFixed(1)}분`],
          ["임시 받아쓰기", `${(usage?.partialSttMinutes || 0).toFixed(1)}분`, `${(d?.partialSttMinutes || 0).toFixed(1)}분`],
          ["통화 비용 기준", fmtBasis(monthBasis), fmtBasis(dayBasis)],
          ["통화 실측 토큰", fmtLiveTokens(usage), fmtLiveTokens(d)],
          ["텍스트 토큰", `${Math.round(usage?.textTokens || 0).toLocaleString()}`, `${Math.round(d?.textTokens || 0).toLocaleString()}`],
          ["TTS 글자 수", `${Math.round(usage?.ttsChars || 0).toLocaleString()}`, `${Math.round(d?.ttsChars || 0).toLocaleString()}`],
          ...USAGE_COST_COMPONENTS.map(({ key, label }): [string, string, string] => [
            label,
            usd(monthCost[key]),
            usd(dayCost[key]),
          ]),
        ] as [string, string, string][])
      : []),
    ["예상 비용", usd(monthCost.total), usd(dayCost.total)],
  ];
  return (
    <div className="space-y-4">
      <section className="rounded-xl bg-slate-900/60 border border-slate-800 p-3.5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-bold text-white">내 학습 기록</h3>
          {!loadError && hasCallHistory && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-300">
              <Flame className="w-3.5 h-3.5 text-amber-400" />
              <span>연속 학습 {log.streakDays}일 (최고 {log.bestStreakDays}일)</span>
            </span>
          )}
        </div>

        {loadError ? (
          <p className="text-xs text-rose-300 py-2">
            기록을 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.
          </p>
        ) : !hasCallHistory ? (
          <p className="text-xs text-slate-400 py-2">
            아직 통화 기록이 없어요. 오늘 첫 통화를 해 보세요.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg bg-[#121824] border border-slate-800/80 p-2.5">
                <div className="text-[11px] text-slate-400">오늘 통화</div>
                <div className="mt-1 font-bold text-white">
                  {log.today.calls}회 · {log.today.minutes.toFixed(1)}분
                </div>
              </div>
              <div className="rounded-lg bg-[#121824] border border-slate-800/80 p-2.5">
                <div className="text-[11px] text-slate-400">이번 달</div>
                <div className="mt-1 font-bold text-white">
                  {log.thisMonth.calls}회 · {log.thisMonth.minutes.toFixed(1)}분
                </div>
                <div className="text-[11px] text-slate-400 mt-0.5">
                  학습한 날 {log.thisMonth.activeDays}일
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>최근 14일</span>
                <span>날짜별 통화 분 (학습한 날 강조)</span>
              </div>
              <div className="grid grid-cols-[repeat(14,minmax(0,1fr))] gap-1 items-end pt-1">
                {log.recentDays.map((day) => {
                  const active = isActiveLearningDay(day.calls, day.minutes);
                  const isToday = day.date === today;
                  const pct =
                    day.minutes > 0
                      ? Math.max(18, Math.round((day.minutes / maxRecentMinutes) * 100))
                      : active
                      ? 18
                      : 8;
                  return (
                    <div
                      key={day.date}
                      title={`${day.date} · ${day.calls}회 · ${day.minutes.toFixed(1)}분`}
                      className="flex flex-col items-center gap-1"
                    >
                      <div className="w-full h-14 flex items-end justify-center">
                        <div
                          style={{ height: `${pct}%` }}
                          className={`w-full rounded-t transition-all ${
                            active
                              ? "bg-amber-400"
                              : day.minutes > 0
                              ? "bg-slate-600"
                              : "bg-slate-800/80"
                          } ${isToday ? "ring-1 ring-amber-200/80" : ""}`}
                        />
                      </div>
                      <span
                        className={`text-[9px] font-mono leading-none ${
                          isToday
                            ? "text-amber-300 font-bold"
                            : active
                            ? "text-slate-300"
                            : "text-slate-500"
                        }`}
                      >
                        {Number(day.date.slice(8, 10))}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </section>

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
        예상 비용은 추정치예요. 실제 청구액과 다를 수 있어요.
        {devMode && (
          <> (공식 단가 기준 2026-11 · 통화 1분 ≈ ${livePerMin.toFixed(3)}(이번 달 평균, 문맥 재과금 포함 추정) · 받아쓰기 2회(통화 중+종료 후) · 강의 음성 1분 ≈ ${lectureAudioPerMin.toFixed(4)} · 재생성·QA봇 서버 작업 제외)</>
        )}
      </div>
    </div>
  );
};
