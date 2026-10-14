import { auth } from "../firebase/config";

/**
 * fetch() wrapper that attaches the signed-in user's Firebase ID token.
 * Server routes guarded by server/auth.ts requireAuth need this.
 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const user = auth.currentUser;
  if (!user) throw new Error("로그인이 필요합니다.");
  const token = await user.getIdToken();
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status === 429) {
    const json = await res.clone().json().catch(() => ({} as any));
    throw new Error(json?.error || "요청이 너무 많아요. 잠시 뒤에 다시 시도해 주세요.");
  }
  return res;
}

export async function authJson<T = any>(input: string, body?: unknown, method = "POST"): Promise<T> {
  const res = await authFetch(input, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    throw new Error(json?.error || `${input} → ${res.status}`);
  }
  return json as T;
}
