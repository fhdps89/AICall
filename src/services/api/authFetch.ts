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
  return fetch(input, { ...init, headers });
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
