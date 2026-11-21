export const MAX_CLUSTER_ITEMS = 120;
export const MAX_DISPLAY_CLUSTERS = 3;
export const MY_PHRASE_MAX_LEN = 200;
export const NATURAL_PHRASE_MAX_LEN = 200;
export const REASON_MAX_LEN = 300;

export interface ClusterInputMistake {
  id?: string;
  myPhrase?: string;
  naturalPhrase?: string;
  reason?: string;
  status?: string;
}

export interface ClusterRequestItem {
  id: string;
  myPhrase: string;
  naturalPhrase: string;
  reason: string;
}

export interface MistakeCluster {
  key: string;
  name: string;
  description: string;
  memberIds: string[];
  size: number;
}

export interface ClusterUsage {
  inputTokens: number;
  outputTokens: number;
  sieEmbeddingTokens: number;
}

export type ClusterResponse =
  | { ok: true; enabled: true; clusters: MistakeCluster[]; usage: ClusterUsage }
  | {
      ok: true;
      enabled: false;
      clusters: [];
      disabledReason: string;
      usage: ClusterUsage;
    };

function cleanField(raw: string | undefined, maxLen: number): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").slice(0, maxLen);
}

export function buildClusterRequest(mistakes: ClusterInputMistake[]): {
  items: ClusterRequestItem[];
  shouldRequest: boolean;
  signature: string;
} {
  const items: ClusterRequestItem[] = [];
  const seenIds = new Set<string>();

  for (const m of mistakes) {
    if (!m || typeof m.id !== "string") continue;
    const id = m.id.trim();
    if (!id || seenIds.has(id)) continue;
    if (m.status === "graduated") continue;

    const myPhrase = cleanField(m.myPhrase, MY_PHRASE_MAX_LEN);
    const naturalPhrase = cleanField(m.naturalPhrase, NATURAL_PHRASE_MAX_LEN);
    if (!myPhrase || !naturalPhrase) continue;

    seenIds.add(id);
    items.push({
      id,
      myPhrase,
      naturalPhrase,
      reason: cleanField(m.reason, REASON_MAX_LEN),
    });

    if (items.length >= MAX_CLUSTER_ITEMS) break;
  }

  return {
    items,
    shouldRequest: items.length >= 2,
    signature: JSON.stringify(items),
  };
}

export function pickDisplayClusters(res: ClusterResponse | null | undefined): MistakeCluster[] {
  if (!res || !res.ok || !res.enabled || !Array.isArray(res.clusters)) {
    return [];
  }
  return res.clusters
    .filter((c) => c && c.size >= 2 && Array.isArray(c.memberIds) && c.memberIds.length >= 2)
    .slice(0, MAX_DISPLAY_CLUSTERS);
}
