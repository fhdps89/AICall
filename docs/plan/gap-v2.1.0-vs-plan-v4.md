# 현재 앱 ↔ 기획 v4 차이표 (2026-10-19 KST 갱신)

> 기준 기획: [implementation_plan_v4.md](implementation_plan_v4.md) (Part B). 비교 대상: 처음 `main`의 `0bd6ffc` (2026-10-14 14:30 KST), 2026-10-19에 v2.8.0(브랜치 `claude/trusting-johnson-0b9s97`) 기준으로 2·3행 갱신.
> 표시: [확인] 코드에서 직접 본 것 / [추정] 판단.

## v4대로 된 것 [확인: server.ts 엔드포인트와 버전 히스토리]
- 1단계: 로그인·Firestore·Storage, `models.ts`·공급자 인터페이스, 4개 목표·루틴, Live 통화(임시 토큰 + 서버 중계, 세션 재개), 10초 조각 녹음, 1분 단위 받아쓰기, 끊긴 통화 복구, 통화 후 최종 받아쓰기(`/api/gemini/transcribe-final`), 복기(`myPhrase` 틀린 그대로 규칙), Keep 가져오기, 받아쓰기 품질 시험(`/api/stt-bench/*`)
- 2단계: 퀴즈(`/api/quiz/grade`), 아침 강의(`/api/lecture/*`), 그록봇 피드(`/feed/:secret/today`)

## 아직 v4와 어긋나는 것

| # | 현재 | v4 | 위치 |
|---|---|---|---|
| 1 | ~~앱 이름 "오늘도 한 통 (One Call Today)"~~ → v2.7.3에서 "One Call English"로 바꿈 | "One Call English" | `metadata.json` |
| 2 | 통화가 끊긴 뒤 2분이 지나면 앱을 열 때 "복기 대기"로 표시만 하고, 복기는 사용자가 시작 [확인: `checkAndMarkInterruptedSessions`. 서버 메모리 감시는 v2.8.0에서 삭제] | 서버가 자동으로 복기 시작 | B-4 |
| 3 | 코치 함수는 `propose_plan_change`, `get_progress`, `get_mistake_stats` 3개(승인 후 적용은 앱 버튼, v2.8.0부터 적용 전 형식 검사) [확인] | `set_goal`, `pause_goal`, `set_exam_date`, `apply_plan_change`(승인 후)도 포함 | B-9 |
| 4 | 단가표 `PRICING_RATES`(예: 받아쓰기 $0.003/분)가 기획 v4 비용표(약 $0.005/분)와 다름 [확인: 두 문서 비교, 공식 단가는 재확인 안 함] | 단가표 한 곳 | B-10 |

텔레그램·예전 팟캐스트 제거와 예전 받아쓰기의 한국어 고정 해제는 14:30 KST까지 main에 반영됨 [확인: `telegram`, `ko-KR)로 고정` 검색 결과 없음].

## 정리 요청문
AI Studio에 붙여넣을 요청문: [ai-studio-work-order-2.txt](ai-studio-work-order-2.txt).
