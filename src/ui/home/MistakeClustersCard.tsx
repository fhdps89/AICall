import React, { useMemo, useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight, Repeat } from "lucide-react";
import type { MistakeData } from "../../services/firebase/db";
import type { MistakeCluster } from "../../services/mistakes/clusterRequest";

interface MistakeClustersCardProps {
  clusters: MistakeCluster[] | null;
  mistakes: MistakeData[];
}

export const MistakeClustersCard: React.FC<MistakeClustersCardProps> = ({
  clusters,
  mistakes,
}) => {
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});

  const mistakesById = useMemo(() => {
    const map = new Map<string, MistakeData>();
    for (const m of mistakes) {
      if (m.id) map.set(m.id, m);
    }
    return map;
  }, [mistakes]);

  if (!clusters || clusters.length === 0) {
    return null;
  }

  const visibleClusters = clusters.filter((c) => c.size >= 2).slice(0, 3);
  if (visibleClusters.length === 0) {
    return null;
  }

  const toggle = (key: string) => {
    setExpandedKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <section className="bg-[#161D2A] border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-lg space-y-3">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-400 flex items-center justify-center shrink-0">
          <Repeat className="w-4 h-4" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-white">반복되는 실수</h3>
          <p className="text-[11px] text-slate-400">자주 겹치는 표현 실수를 묶어서 보여 드려요</p>
        </div>
      </div>

      <div className="space-y-2">
        {visibleClusters.map((cluster) => {
          const isOpen = Boolean(expandedKeys[cluster.key]);
          const members = cluster.memberIds
            .map((id) => mistakesById.get(id))
            .filter((m): m is MistakeData => Boolean(m));

          return (
            <div
              key={cluster.key}
              className="rounded-xl bg-slate-900/60 border border-slate-800/90 overflow-hidden"
            >
              <button
                type="button"
                onClick={() => toggle(cluster.key)}
                className="w-full px-3.5 py-2.5 flex items-center justify-between gap-3 text-left hover:bg-slate-800/40 transition-colors cursor-pointer"
                aria-expanded={isOpen}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white truncate">{cluster.name}</span>
                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30 shrink-0">
                      {cluster.size}개
                    </span>
                  </div>
                  {cluster.description && (
                    <p className="text-[11px] text-slate-400 mt-0.5 truncate">
                      {cluster.description}
                    </p>
                  )}
                </div>
                {isOpen ? (
                  <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                )}
              </button>

              {isOpen && members.length > 0 && (
                <ul className="px-3.5 pb-3 pt-1 border-t border-slate-800/70 space-y-1.5">
                  {members.map((m, idx) => (
                    <li
                      key={m.id || idx}
                      className="text-xs flex flex-wrap items-center gap-1.5 text-slate-300"
                    >
                      <span className="text-rose-300/90 line-through decoration-rose-400/50">
                        {m.myPhrase}
                      </span>
                      <ArrowRight className="w-3 h-3 text-slate-500 shrink-0" />
                      <span className="text-emerald-300 font-medium">{m.naturalPhrase}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};
