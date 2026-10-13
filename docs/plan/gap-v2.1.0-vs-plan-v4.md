# 현재 앱(v2.1.0) ↔ 기획 v4 차이표 (2026-10-13 KST)

> 기준 기획: [implementation_plan_v4.md](implementation_plan_v4.md) (Part B). 비교 대상: `main`의 `0c42085` (v2.1.0, 2026-10-13 14:16 KST).
> v2.0.0은 예전 기획(텔레그램, Grok식 3분 팟캐스트, 통화 자막 기반 복기)으로 만들어졌고, v2.1.0에서 작업 지시서 1(로그인·모델 설정·목표)이 반영됐습니다.
> 표시: [확인] 코드에서 직접 본 것 / [추정] 판단.

## 이미 v4대로 된 것 [확인]
- `src/config/models.ts`: `gemini-3.8-live`, `gemini-3.8-flash`, `gemini-3.5-transcribe` VERBATIM, `gemini-3.8-flash-tts`
- 공급자 인터페이스 `src/services/providers/` (Live/Stt/Llm/Tts)
- Firebase 로그인(계정 1개), Firestore에 프로필·목표 저장, Cloud Storage 연결
- 4개 목표, 튜터 프롬프트 원문 보존, 빈칸 설정, 요일 루틴, 첫 실행 진도 입력, 오늘 수업 카드
- 기존 오디오 처리(16kHz 변환, 에코 게이트, 말 끊기)는 `src/voice/`에 그대로 남아 있음

## v4와 어긋나는 것 (고칠 순서대로)

| # | 현재 | v4 | 위치 | 언제 |
|---|---|---|---|---|
| 1 | 복기 프롬프트가 "인식이 약간 틀렸으면 **적당히 다듬어라**" | `myPhrase`는 **틀린 그대로**, 절대 고쳐 쓰지 않음 (제품의 핵심) | `server.ts` `/api/review` | **지금** |
| 2 | 받아쓰기 엔드포인트가 "한국어(ko-KR)로 고정해서 전사" | 영어 발화를 VERBATIM으로 | `server.ts` `/api/gemini/transcribe` | **지금** |
| 3 | 텔레그램 봇 전송(설정에 봇 토큰·채팅 ID) | 텔레그램 없음, 그록봇이 피드 주소를 읽음(B-8) | `server.ts` `/api/telegram/send`, `MorningPodcastModal.tsx`, `storage.ts`, `types/index.ts` | **지금** (제거) |
| 4 | 앱 이름 "오늘도 한 통 (One Call Today)" | "One Call English" | `metadata.json` | **지금** |
| 5 | 실수·복기·팟캐스트를 브라우저 localStorage에 저장 | Firestore(`mistakes`, `sessions`, `lectures`), localStorage는 임시용만 | `src/data/storage.ts` | 1-D 때 |
| 6 | 복기 재료가 Live 통화 자막(`turns`)뿐 | 10초 조각 녹음 → 기록용 받아쓰기가 우선, Live 자막은 보조 | `/api/review`, 통화 화면 | 1-C, 1-D |
| 7 | 실수 보관함에 수동 "복습 완료" 체크 | 수동 졸업 없음. 1→3→7→14일 단계, 퀴즈 통과·통화에서 맞게 사용 시 졸업 | `MistakeVaultModal.tsx` | 2단계 |
| 8 | 아침 팟캐스트: 2~3분, 진행자 1명 말투, 3초 무음 없음 | 5분 이내, 새 실수 6 + 복습 3, 항목마다 3초 무음, 2인 화자, 영어는 영어 철자 | `/api/podcast`, `MorningPodcastModal.tsx` | 2단계 |
| 9 | 브라우저에 API 키 입력 경로(`customApiKey`)가 남아 있음 | 서버 Secrets(`GEMINI_API_KEY`)만 | `server.ts` 각 엔드포인트 | 지금 숨기고 나중에 삭제 |
| 10 | 단가표: Live 분당 $0.004 등 | v4 추정: Live 입력 분당 $0.005 + AI 말하기 분당 $0.018 등 | `models.ts` `PRICING_RATES` | 1-E 때 공식 가격 재확인 |
| 11 | 세션 재개·컨텍스트 압축·임시 토큰 없음 [추정: 코드에서 못 찾음] | 필수 (B-2) | `server.ts` Live 중계 | 1-B |

## 정리 요청문
AI Studio에 붙여넣을 요청문: [ai-studio-work-order-2.txt](ai-studio-work-order-2.txt) (위 1~4, 9번).
