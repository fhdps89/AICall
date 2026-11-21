/** Turns raw server/network errors into a short Korean reason. */
export function friendlyReviewError(raw: string): string {
  const m = raw || "";
  if (/연결 키가 없어요|Gemini 키가 없어요|GEMINI_API_KEY|연동이 준비되지/.test(m))
    return "튜터 서버에 연결 키가 없어 복기를 만들 수 없어요. 설정 맨 아래 「고급 설정 보기」를 누른 뒤 「연결 키」 탭에서 키를 저장하고 다시 만들어 주세요.";
  if (/로그인|인증|401/.test(m)) return "로그인이 만료됐어요. 다시 로그인한 뒤 다시 만들어 주세요.";
  if (/Failed to fetch|NetworkError|network/i.test(m)) return "인터넷 연결이 불안정해요. 연결을 확인하고 다시 만들어 주세요.";
  return m.length > 80 ? "복기를 만드는 중 문제가 생겼어요." : m;
}
