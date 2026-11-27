/**
 * Gemini Live usageMetadata 파싱 및 세션 단위 누적기(순수 모듈, DOM/Firebase 비의존).
 *
 * Gemini Live 의 usageMetadata 는 턴 단위 스냅샷(해당 턴의 전체 컨텍스트 재청구분 포함)이며
 * 같은 턴 안에서 여러 메시지에 반복·갱신되어 도착할 수 있다.
 * - 턴 내부: 마지막 스냅샷만 유지(last-wins). 단, 프롬프트 토큰 수가 다른 스냅샷은 다른 요청이므로 앞 것을 커밋
 * - 턴 종료(turnComplete / interrupted / 재연결 / 종료): pending 스냅샷을 누적 합계에 커밋
 */

export interface LiveUsageTotals {
  turns: number;
  inAudio: number;
  inText: number;
  outAudio: number;
  outText: number;
  thoughts: number;
  cached: number;
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
  unsplitPromptTokens: number;
}

export interface LiveUsageAccumulator {
  observe(usageMetadata: unknown): void;
  commitTurn(): void;
  snapshot(): LiveUsageTotals;
  finalize(): LiveUsageTotals;
  reset(): void;
  hasData(): boolean;
  /** Largest single-turn promptTokenCount seen this call (re-billed context incl. system prompt; shows whether compression caps it). */
  peakPromptTokens(): number;
}

function emptyTotals(): LiveUsageTotals {
  return {
    turns: 0,
    inAudio: 0,
    inText: 0,
    outAudio: 0,
    outText: 0,
    thoughts: 0,
    cached: 0,
    promptTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    unsplitPromptTokens: 0,
  };
}

function addTotals(a: LiveUsageTotals, b: LiveUsageTotals): LiveUsageTotals {
  return {
    turns: a.turns + b.turns,
    inAudio: a.inAudio + b.inAudio,
    inText: a.inText + b.inText,
    outAudio: a.outAudio + b.outAudio,
    outText: a.outText + b.outText,
    thoughts: a.thoughts + b.thoughts,
    cached: a.cached + b.cached,
    promptTokens: a.promptTokens + b.promptTokens,
    responseTokens: a.responseTokens + b.responseTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    unsplitPromptTokens: a.unsplitPromptTokens + b.unsplitPromptTokens,
  };
}

function posNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function splitDetails(details: unknown): { audio: number; text: number } {
  let audio = 0;
  let text = 0;
  if (!Array.isArray(details)) return { audio, text };

  for (const item of details) {
    if (!item || typeof item !== "object") continue;
    const count = posNum((item as Record<string, unknown>).tokenCount);
    if (count === 0) continue;
    const rawModality = (item as Record<string, unknown>).modality;
    const modality = typeof rawModality === "string" ? rawModality.toUpperCase() : "";
    if (modality === "AUDIO") {
      audio += count;
    } else {
      text += count;
    }
  }

  return { audio, text };
}

/**
 * 단일 usageMetadata 페이로드를 1턴 스냅샷(turns=1)으로 파싱한다.
 * 유효한 토큰 카운트가 전혀 없거나 잘못된 페이로드면 null 을 반환한다.
 */
export function parseUsageMetadata(raw: unknown): LiveUsageTotals | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const promptTokens = posNum(obj.promptTokenCount);
  const responseTokens = posNum(obj.responseTokenCount) || posNum(obj.candidatesTokenCount);
  const totalTokens = posNum(obj.totalTokenCount);
  const thoughts = posNum(obj.thoughtsTokenCount);
  const cached = posNum(obj.cachedContentTokenCount);

  const promptSplit = splitDetails(obj.promptTokensDetails);
  let inAudio = promptSplit.audio;
  let inText = promptSplit.text;
  let unsplitPromptTokens = 0;

  if (inAudio + inText === 0 && promptTokens > 0) {
    // 모달리티 세부 정보가 없으면 보수적으로 단가가 높은 입력 오디오로 집계하고 진단 카운터에 남긴다.
    inAudio = promptTokens;
    unsplitPromptTokens = promptTokens;
  }

  const responseSplit = splitDetails(obj.responseTokensDetails);
  let outAudio = responseSplit.audio;
  let outText = responseSplit.text;

  if (outAudio + outText === 0 && responseTokens > 0) {
    outAudio = responseTokens;
  }

  if (
    inAudio === 0 &&
    inText === 0 &&
    outAudio === 0 &&
    outText === 0 &&
    thoughts === 0 &&
    cached === 0 &&
    promptTokens === 0 &&
    responseTokens === 0 &&
    totalTokens === 0
  ) {
    return null;
  }

  return {
    turns: 1,
    inAudio,
    inText,
    outAudio,
    outText,
    thoughts,
    cached,
    promptTokens,
    responseTokens,
    totalTokens,
    unsplitPromptTokens,
  };
}

/**
 * 통화(세션) 단위 usageMetadata 누적기를 생성한다.
 * 재연결 시에는 commitTurn()만 호출해 동일 통화의 합계를 이어간다.
 */
export function createLiveUsageAccumulator(): LiveUsageAccumulator {
  let committed: LiveUsageTotals = emptyTotals();
  let pending: LiveUsageTotals | null = null;
  // 직전에 커밋한 스냅샷과 그 커밋 전 합계. 같은 요청(프롬프트 토큰 수 동일)의 스냅샷이 커밋 뒤에
  // 다시 오면(예: interrupted 뒤 turnComplete와 함께 갱신본 도착) 새 턴으로 더하지 않고 그 턴을 다시 연다(이중 집계 방지).
  let lastCommitted: LiveUsageTotals | null = null;
  let committedBeforeLast: LiveUsageTotals = emptyTotals();
  let peakPrompt = 0;

  const commitTurn = (): void => {
    if (!pending) return;
    committedBeforeLast = committed;
    lastCommitted = pending;
    committed = addTotals(committed, pending);
    pending = null;
  };

  return {
    observe(usageMetadata: unknown): void {
      const parsed = parseUsageMetadata(usageMetadata);
      if (!parsed) return;
      if (parsed.promptTokens > peakPrompt) peakPrompt = parsed.promptTokens;
      // 같은 생성 요청의 스냅샷은 프롬프트 토큰 수가 같다. 프롬프트 수가 달라졌다면 앞 요청의
      // 스냅샷이 turnComplete 뒤에 늦게 도착한 것이므로, 덮어쓰지 말고 먼저 커밋한다(과소 집계 방지).
      if (pending && pending.promptTokens !== parsed.promptTokens) commitTurn();
      if (!pending && lastCommitted && lastCommitted.promptTokens === parsed.promptTokens) {
        committed = committedBeforeLast;
        lastCommitted = null;
      }
      pending = parsed;
    },
    commitTurn,
    snapshot(): LiveUsageTotals {
      return pending ? addTotals(committed, pending) : { ...committed };
    },
    finalize(): LiveUsageTotals {
      commitTurn();
      return { ...committed };
    },
    reset(): void {
      committed = emptyTotals();
      pending = null;
      lastCommitted = null;
      committedBeforeLast = emptyTotals();
      peakPrompt = 0;
    },
    hasData(): boolean {
      return committed.turns > 0 || pending !== null;
    },
    peakPromptTokens(): number {
      return peakPrompt;
    },
  };
}

/**
 * 숫자/메타데이터만 포함하는 한 줄 요약 로그를 생성한다.
 */
export function formatLiveUsageLog(
  t: LiveUsageTotals,
  extra?: Record<string, number | string>,
): string {
  const parts = [
    "[live-usage]",
    `turns=${t.turns}`,
    `inAudio=${t.inAudio}`,
    `inText=${t.inText}`,
    `outAudio=${t.outAudio}`,
    `outText=${t.outText}`,
    `thoughts=${t.thoughts}`,
  ];

  if (extra) {
    for (const [key, val] of Object.entries(extra)) {
      if (typeof val === "number") {
        if (!Number.isFinite(val)) continue;
        const formatted = key.endsWith("Usd") ? val.toFixed(4) : String(val);
        parts.push(`${key}=${formatted}`);
      } else if (typeof val === "string") {
        const safe = val.replace(/\s+/g, "_");
        parts.push(`${key}=${safe}`);
      }
    }
  }

  return parts.join(" ");
}
