# 현재 앱 ↔ 기획 v4 차이표 (2026-10-14 KST 갱신)

> 기준 기획: [implementation_plan_v4.md](implementation_plan_v4.md) (Part B). 비교 대상: `main`의 `2c7c166` (README 기준 v2.6.0, 2026-10-14 08:04 KST).
> 표시: [확인] 코드에서 직접 본 것 / [추정] 판단.

## v4대로 된 것 [확인: server.ts 엔드포인트와 버전 히스토리]
- 1단계: 로그인·Firestore·Storage, `models.ts`·공급자 인터페이스, 4개 목표·루틴, Live 통화(임시 토큰 + 서버 중계, 세션 재개), 10초 조각 녹음, 1분 단위 받아쓰기, 끊긴 통화 복구, 통화 후 최종 받아쓰기(`/api/gemini/transcribe-final`), 복기(`myPhrase` 틀린 그대로 규칙), Keep 가져오기, 받아쓰기 품질 시험(`/api/stt-bench/*`)
- 2단계: 퀴즈(`/api/quiz/grade`), 아침 강의(`/api/lecture/*`), 그록봇 피드(`/feed/:secret/today`)

## 아직 v4와 어긋나는 것

| # | 현재 | v4 | 위치 |
|---|---|---|---|
| 1 | 예전 "아침 팟캐스트" 화면과 텔레그램 전송이 남아 있음 | 텔레그램 없음. 아침 강의(B-7)와 피드(B-8)만 | `server.ts` `/api/podcast`, `/api/telegram/send`, `src/ui/podcast/MorningPodcastModal.tsx`, 프로필의 `telegramBotToken`·`telegramChatId` |
| 2 | 앱 이름 "오늘도 한 통 (One Call Today)" | "One Call English" | `metadata.json` |
| 3 | 예전 받아쓰기 `/api/gemini/transcribe`가 "한국어(ko-KR)로 고정" | 영어 VERBATIM (새 경로 `transcribe-final`은 이미 맞음) | `server.ts` 약 438행, `src/voice/GeminiClient.ts`에서 호출 |

## 정리 요청문
AI Studio에 붙여넣을 요청문: [ai-studio-work-order-2.txt](ai-studio-work-order-2.txt).
