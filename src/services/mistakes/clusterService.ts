import { authFetch } from "../api/authFetch";
import type { MistakeData } from "../firebase/db";
import { recordUsage } from "../usage/usageService";
import {
  buildClusterRequest,
  pickDisplayClusters,
  type ClusterResponse,
  type MistakeCluster,
} from "./clusterRequest";

const CLUSTER_FETCH_TIMEOUT_MS = 30_000;
const sessionMemo = new Map<string, MistakeCluster[]>();

export function clearClusterMemo(): void {
  sessionMemo.clear();
}

export async function fetchMistakeClusters(
  uid: string,
  mistakes: MistakeData[],
  externalSignal?: AbortSignal
): Promise<MistakeCluster[] | null> {
  const { items, shouldRequest, signature } = buildClusterRequest(mistakes);
  if (!shouldRequest) return null;

  const cacheKey = `${uid}:${signature}`;
  const memoized = sessionMemo.get(cacheKey);
  if (memoized !== undefined) {
    return memoized;
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CLUSTER_FETCH_TIMEOUT_MS);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      return null;
    }
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const res = await authFetch("/api/mistakes/clusters", {
      method: "POST",
      body: JSON.stringify({ items }),
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const json = (await res.json().catch(() => null)) as ClusterResponse | null;
    if (!json || !json.ok || !json.enabled) {
      return null;
    }

    const u = json.usage;
    if (u) {
      const inputTokens = u.inputTokens || 0;
      const outputTokens = u.outputTokens || 0;
      const sieEmbeddingTokens = u.sieEmbeddingTokens || 0;
      if (inputTokens + outputTokens + sieEmbeddingTokens > 0) {
        void recordUsage(uid, {
          textInputTokens: inputTokens,
          textOutputTokens: outputTokens,
          sieEmbeddingTokens,
        });
      }
    }

    const clusters = pickDisplayClusters(json);
    sessionMemo.set(cacheKey, clusters);
    return clusters;
  } catch (err) {
    if (timedOut) {
      console.warn("[MistakeClusters] request timed out");
    } else if (!externalSignal?.aborted) {
      console.warn("[MistakeClusters] fetch failed (non-fatal):", err);
    }
    return null;
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}
