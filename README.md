# One Call English — AI 1:1 전화영어 (옛 이름: 오늘도 한 통)

> **버전**: `v2.8.1` | **최종 갱신**: 2026-10-19 (KST)
> **기준 기획**: [`docs/plan/implementation_plan_v4.md`](./docs/plan/implementation_plan_v4.md) Part B · 진행 가이드 [`docs/plan/ai-studio-build-guide.md`](./docs/plan/ai-studio-build-guide.md)
> 아키텍처와 버전 기록: [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md) · 상세 변경 기록: [`docs/history/changelog.md`](./docs/history/changelog.md) · 최근 전체 코드 리뷰: [`docs/reviews/2026-10-full-code-review.md`](./docs/reviews/2026-10-full-code-review.md)

AI 튜터와 영어로 통화하고, 통화에서 **틀린 말을 틀린 그대로 기록**한 뒤, 아침 강의·퀴즈로 복습하고, 다음 통화에서 맞게 쓰면 졸업시키는 "실수 루프" 앱입니다. 지금은 1인 테스트판(웹)입니다.

## 지금 되는 것

| 단계 | 기능 | 주요 파일 |
|---|---|---|
| 1단계 | Google 로그인(허용된 1개 계정만), Firestore·Cloud Storage | `src/services/firebase/`, `firestore.rules`, `server/auth.ts` |
| 1단계 | 4개 목표(OPIc AL·필리조선소 업무·미국/호주 여행·Bluey 듣기)와 요일 루틴, 오늘 수업 카드 | `src/data/defaultGoals.ts`, `src/ui/home/` |
| 1단계 | 실시간 통화 `gemini-3.8-live`: 임시 토큰 직접 연결 → 실패 시 서버 중계, 세션 재개, 재연결(5번 실패하면 멈추고 안내). 통화마다 새 연결 객체라 앞 통화가 섞이지 않음 | `src/services/providers/geminiLiveProvider.ts`, `server.ts` `/live` |
| 1단계 | 10초 조각 녹음(IndexedDB 먼저 저장 → Storage 업로드, 통화 마지막 조각까지 포함), 1분 단위 임시 받아쓰기(설정에서 끄기 가능), 끊긴 통화 복구 | `src/services/recording/` |
| 1단계 | 통화 후 복기: 녹음을 1분 WAV로 합쳐 `gemini-3.5-transcribe` VERBATIM 받아쓰기 → `gemini-3.8-flash` 복기(`myPhrase`는 틀린 그대로). "내가 한 말 아님" 신고 시 그 실수는 복습 목록에서 빠짐. 다시 복기해도 중복·진도 후퇴 없음 | `src/services/review/reviewPipeline.ts`, `/api/review` |
| 1단계 | Keep 실수 목록 붙여넣기 가져오기, 사용량·예상 비용, 받아쓰기 품질 시험(개발자 메뉴) | `src/ui/keep/`, `src/ui/settings/UsagePanel.tsx`, `src/ui/sttBench/` |
| 2단계 | 간격 반복(1→3→7→14일, 보류, 졸업)과 퀴즈(말하기/타이핑, `gemini-3.8-flash` 채점) | `src/services/firebase/db.ts`, `src/ui/quiz/` |
| 2단계 | 아침 강의(대본 `gemini-3.8-flash`, 2인 음성 `gemini-3.8-flash-tts`, 답 전 3초 무음). 서버 재시작으로 멈추면 "다시 만들기" 안내 | `server/lecture.ts`, `src/ui/lecture/` |
| 2단계 | 그록봇 피드: `/feed/{비밀키}/today` 주소로 오늘 강의 상태·음성 링크 제공 | `server/feed.ts`, `src/ui/settings/FeedSettingsPanel.tsx` |
| 3단계 | 텍스트 코치: 일정·시험일 변경 제안 카드(승인 전에는 바뀌지 않음, 적용 전 형식 검사), 되돌리기(바꾼 항목만), 코치 메모 | `src/ui/coach/CoachModal.tsx`, `src/data/planValidation.ts`, `/api/coach/chat` |

## 모델

모델 이름은 [`src/config/models.ts`](./src/config/models.ts) 한 곳에서만 정합니다(앱과 서버 모두 이 파일을 씀).

| 용도 | 모델 |
|---|---|
| 실시간 통화 | `gemini-3.8-live` |
| 복기·퀴즈 채점·강의 대본·코치·Keep 분석 | `gemini-3.8-flash` |
| 기록용 받아쓰기 | `gemini-3.5-transcribe` (VERBATIM) |
| 아침 강의 음성 | `gemini-3.8-flash-tts` |
| 복기 화면 "발음 듣기" | `gemini-3.8-flash-lite-tts` |

## 보안·한도
- 모든 비용 발생 API와 Live 연결은 Firebase 로그인 토큰이 있어야 합니다(`server/auth.ts`). 서버는 자기 Gemini 키만 쓰고, 앱이 보낸 키는 받지 않습니다.
- 1인당 한도: 1분 60회, 하루 1,500회 Gemini 호출, 하루 60번 통화 시작(`server/rateLimit.ts`, 서버 메모리 기준).

## 알아 둘 한계
- 아침 강의 음성, 그록봇 피드 설정, 서버 예비 녹음은 서버 안 `.data/` 폴더에 저장됩니다. AI Studio 배포(Cloud Run)에서는 서버가 다시 켜지면 지워질 수 있습니다. 앱을 열면 피드 설정은 다시 보내집니다.
- 허용 계정 이메일이 `firestore.rules`, `server/auth.ts`, `src/services/firebase/auth.ts`에 고정돼 있습니다(베타 전에 바꿔야 함).
- `npm audit`에 high 4건이 나옵니다. Firebase가 쓰는 `@grpc/grpc-js`(서버용 통신 라이브러리)에서 나오며 브라우저 앱에서는 쓰이지 않는 부분으로 보고 있습니다(추정). 고치려면 Firebase 큰 버전 업그레이드가 필요합니다.

## 실행

```bash
npm install
npm run dev        # 개발 서버 (포트 3000)
npm run lint       # 앱 타입 검사
npx tsc -p tsconfig.server.json --noEmit   # 서버 타입 검사
npm run build      # 배포용 빌드
npm test           # 자동 테스트 (tests/*.test.ts, 17개)
npm start          # NODE_ENV=production 에서 dist/ 를 서빙 (NODE_ENV가 없어도 Vite가 없으면 dist/ 서빙)
```

서버에는 `GEMINI_API_KEY`가 있어야 합니다(AI Studio: Settings → Secrets). 상태 확인: `/api/gemini/status`(키 값과 파일 경로는 보여 주지 않고, 찾았는지와 찾은 곳의 종류 `env`·`file`·`proc`·`firestore:user-settings` 등만 표시).

**배포 서버에 키가 안 들어갈 때**(2026-10 현재 AI Studio Publish가 Secrets를 서버에 전달하지 않는 문제): 앱의 설정 → **Gemini 키** 탭에서 키를 저장하면 됩니다. 키는 내 계정 Firestore(`users/{uid}/private/gemini`)에만 저장되고, 서버는 로그인 토큰으로 읽어 메모리에만 둡니다(`server/userKey.ts`). 배포 환경에 진짜 키가 생기면 그 키가 우선이고, 이때 `keySource`가 `firestore:user-settings`가 아닌 값으로 바뀝니다.

## AI Studio ↔ GitHub 작업 규칙
- GitHub에서 PR을 병합했다면, **AI Studio에서 먼저 GitHub 변경을 가져오기(pull)** 한 뒤에 AI Studio에서 작업하세요. 가져오지 않고 올리면(push) AI Studio의 옛 파일이 GitHub의 새 파일을 덮어씁니다(2026-10-14에 `package-lock.json`이 이렇게 되돌아가 CI가 실패했음).
- `package.json`을 바꾸면 `package-lock.json`도 함께 다시 만들어 올려야 CI(`npm ci`)가 통과합니다.
- 모든 push와 PR에서 GitHub Actions CI가 설치 → 타입 검사(앱·서버·테스트) → 빌드 → 자동 테스트(`npm test`)를 확인합니다(`.github/workflows/ci.yml`).
