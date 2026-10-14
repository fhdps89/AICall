/**
 * B-8 Grok Bot feed client: secret lives in users/{uid}.feedSecret (UserProfileData).
 * syncFeed() pushes secret + today's candidates to the server so the feed URL works without login.
 */
import { getUserProfile, saveUserProfile, getDueMistakes } from "../firebase/db";
import { authJson } from "../api/authFetch";
import { pickLectureMistakes } from "../lecture/lectureService";

export function generateFeedSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function ensureFeedSecret(uid: string): Promise<string> {
  const profile = await getUserProfile(uid);
  const existing = profile?.feedSecret;
  if (existing && /^[A-Za-z0-9_-]{24,128}$/.test(existing)) return existing;
  const secret = generateFeedSecret();
  await saveUserProfile(uid, { feedSecret: secret });
  return secret;
}

export async function syncFeed(uid: string, secretOverride?: string, previousSecret?: string): Promise<string> {
  const secret = secretOverride || (await ensureFeedSecret(uid));
  const [picked, due] = await Promise.all([pickLectureMistakes(uid), getDueMistakes(uid)]);
  await authJson("/api/feed/sync", {
    secret,
    previousSecret,
    quizCount: Math.min(due.length, 10),
    ...picked,
  });
  return secret;
}

/** 설정에서 비밀키 새로 바꾸기: old URL stops working immediately after sync. */
export async function rotateFeedSecret(uid: string): Promise<string> {
  const previous = (await getUserProfile(uid))?.feedSecret;
  const secret = generateFeedSecret();
  await saveUserProfile(uid, { feedSecret: secret });
  await syncFeed(uid, secret, previous);
  return secret;
}

export function feedUrls(secret: string) {
  const origin = window.location.origin;
  return {
    page: `${origin}/feed/${secret}/today`,
    json: `${origin}/feed/${secret}/today.json`,
  };
}

export function grokBotInstruction(pageUrl: string): string {
  return `매일 오전 6시 40분에 ${pageUrl} 를 열어 줘. 7시에 다시 열어서 상태가 준비 완료면 제목, 코치 한마디, 강의 재생 링크를 나에게 알려줘. 아직 생성 중이면 7시 15분에 한 번 더 확인해줘. 할 게 없다고 나오면 "오늘은 강의 없음"이라고만 알려줘.`;
}
