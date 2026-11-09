/**
 * Text that is safe to show the user for a caught error.
 * Short Korean sentences written for the user (from our own server replies and checks) pass
 * through; anything that looks internal (JSON dumps with account details from the Firestore
 * helper, SDK codes, URLs, long traces) is replaced by the given fallback sentence.
 */
export function friendlyError(err: unknown, fallback = "문제가 생겼어요. 잠시 후 다시 시도해 주세요."): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const m = (raw || "").trim();
  if (!m) return fallback;
  if (/Failed to fetch|NetworkError|network request failed|client is offline/i.test(m)) {
    return "인터넷 연결이 불안정해요. 연결을 확인하고 다시 시도해 주세요.";
  }
  if (/permission|insufficient|unauthenticated|401|403/i.test(m)) {
    return "로그인이 만료됐거나 권한이 없어요. 다시 로그인한 뒤 시도해 주세요.";
  }
  const looksInternal =
    m.length > 90 || /^[\[{]/.test(m) || /https?:\/\/|\/api\/|→|Firebase|Firestore|\bat\s+\S+:\d+|Error:|undefined|null\b/i.test(m);
  const hasKorean = /[가-힣]/.test(m);
  return looksInternal || !hasKorean ? fallback : m;
}
