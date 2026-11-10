# One Call English — AI 1:1 전화영어 (옛 이름: 오늘도 한 통)

> **버전**: `v2.9.1` (빌드 표기 `20261111-multilingual-HHmm`, `server.ts` 수정 시각에서 자동 계산) | **최종 갱신**: 2026-11-11 (KST)
> **기준 기획**: [`docs/plan/implementation_plan_v4.md`](./docs/plan/implementation_plan_v4.md) Part B · 진행 가이드 [`docs/plan/ai-studio-build-guide.md`](./docs/plan/ai-studio-build-guide.md)
> 아키텍처와 버전 기록: [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md) · 상세 변경 기록: [`docs/history/changelog.md`](./docs/history/changelog.md) · 최근 전체 코드 리뷰: [`docs/reviews/2026-11-full-code-review.md`](./docs/reviews/2026-11-full-code-review.md) · 안드로이드 실기기 QC 체크리스트: [`docs/qc/2026-11-android-qc-checklist.html`](./docs/qc/2026-11-android-qc-checklist.html)

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
| 2단계 | 그록봇 피드: `/feed/{비밀키}/today` 주소로 오늘 강의 상태·음성 링크 제공. 서버가 만든 강의는 계정(Firestore·Storage)에도 저장돼 앱과 피드 링크가 서버 재시작 뒤에도 유지(v2.9.1) | `server/feed.ts`, `server/lectureStore.ts`, `src/ui/settings/FeedSettingsPanel.tsx` |
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

## v2.9.1에서 바뀐 것 (2026-11-11 KST, 아침 강의 사라짐 수정)
- 그록봇 피드가 아침에 만든 강의가 앱에 「아직 오늘 강의가 없어요」로 나오고 피드 링크도 「Not found」가 되던 문제를 고쳤습니다. 강의가 서버 한 대의 임시 폴더에만 있었기 때문입니다.
- 이제 서버가 강의를 다 만들면 찬식님 계정(Firestore `users/{uid}/lectures/{날짜}`, Storage `users/{uid}/lectures/{날짜}.wav`)에 바로 저장합니다. 앱은 그것을 읽고, 새로 켜진 서버는 강의를 다시 만들지 않고 저장본을 피드에 보여 주며, 예전 피드 음성 링크는 저장본으로 넘겨 줍니다.
- 이를 위해 앱이 피드 동기화 때 로그인 정보(Firebase 새로 고침 토큰)를 서버에 맡깁니다. 서버 메모리와 피드 암호화 백업(`feeds/{id}`)에만 들어갑니다. 피드 비밀주소가 새면 이 앱 계정 데이터에 접근할 수 있게 되므로, 그럴 때는 설정 → 그록봇 피드 → 비밀키 새로 바꾸기를 누르세요(사용자 결정, 2026-11-11).
- 서버가 저장한 강의의 사용량(토큰·TTS 글자 수)은 앱이 처음 열 때 한 번만 더합니다.

## v2.9.0에서 바뀐 것 (2026-11-10 KST, 전체 코드 리뷰 2차)
- 통화를 끊으면 그 통화는 "복기 대기"로 남고, 복기가 저장돼야 "완료"가 됩니다. 복기 중에 앱을 닫아도 홈 아래 **「끝나지 않은 통화 N개 · 복기하기」** 버튼에서 다시 만들 수 있습니다.
- 복기가 끝나면 바로 아침 강의(그록봇 피드) 후보를 서버로 보냅니다. 복기 화면에서 앱을 닫아도 그날 실수가 다음 날 강의에 들어갑니다.
- 인터넷이 느려도 1분 임시 받아쓰기가 녹음 순서대로 만들어집니다. 기록용 받아쓰기는 실패한 분만 다시 시도하고, 그래도 안 되면 그 분만 임시 받아쓰기로 채웁니다.
- 「통화 종료」 두 번 누름 방지, 통화 중 연결이 끊겼을 때 「여기서 끝내고 복기 보기」, 화면 꺼짐 방지 다시 걸기.
- 내 말이 전혀 기록되지 않은 통화는 진도를 올리지 않고 AI 복기도 부르지 않습니다.
- 오류 안내: 서버 응답과 화면에는 정해진 한국어 문구와 코드만 나갑니다(내부 오류 원문·계정 정보는 서버 로그/콘솔에만). 키가 없을 때 안내는 「설정 → Gemini 키」로 통일.
- 코치 대화 50개 초과 시 새 메시지가 안 보이던 문제, 복기 AI가 돌려준 실수 id 검사, 빈 녹음 조각을 "저장됨"으로 답하던 서버 문제 수정.
- 자세한 목록과 근거: [`docs/reviews/2026-11-full-code-review.md`](./docs/reviews/2026-11-full-code-review.md)

## 보안·한도
- 오류 응답은 `server/errors.ts`의 `apiError()`만 사용합니다: `{ ok: false, code, error }`에서 `error`는 사용자용 한국어 문장, `code`는 `NO_SERVER_KEY`·`REVIEW_FAILED`·`TRANSCRIBE_FAILED` 등 정해진 값입니다. `err.message`를 응답에 넣으면 `npm test`가 실패합니다.
- 응답 헤더: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. 다른 출처에는 CORS 허용 헤더를 보내지 않습니다(같은 출처 전용).
- 피드 암호화 백업에는 Gemini 키(v2.8.1)와 앱 로그인 새로 고침 토큰(v2.9.1)이 들어 있습니다. 피드 비밀주소를 가진 사람은 둘 다 꺼낼 수 있으니 그록봇 외에는 공유하지 마세요.
- 모든 비용 발생 API와 Live 연결은 Firebase 로그인 토큰이 있어야 합니다(`server/auth.ts`). 서버는 자기 Gemini 키만 쓰고, 앱이 보낸 키는 받지 않습니다.
- 1인당 한도: 1분 60회, 하루 1,500회 Gemini 호출, 하루 60번 통화 시작(`server/rateLimit.ts`, 서버 메모리 기준).

## 알아 둘 한계
- 아침 강의 음성, 그록봇 피드 설정, 서버 예비 녹음은 서버 안 `.data/` 폴더에 저장됩니다. AI Studio 배포(Cloud Run)에서는 서버가 다시 켜지면 지워질 수 있습니다. 피드 설정과 설정에 저장한 Gemini 키는 Firestore `feeds/{id}`에 암호화 백업되어, 새로 켜진 서버가 그록봇 요청만으로 복원합니다(v2.8.1). 다 만든 아침 강의는 계정에도 저장됩니다(v2.9.1). 서버 예비 녹음과, 다 만들기 전에 서버가 꺼진 강의는 여전히 지워질 수 있습니다.
- 허용 계정 이메일이 `firestore.rules`, `server/auth.ts`, `src/services/firebase/auth.ts`에 고정돼 있습니다(베타 전에 바꿔야 함).
- `npm audit`에 10건(high 8, moderate 2, 2026-11-10 기준)이 나옵니다. Firebase가 쓰는 `@grpc/grpc-js`(서버용 통신 라이브러리), 개발 서버용 `vite`·`esbuild`, `qs`·`re2js`·`source-map-js` 등입니다. `npm audit fix`는 Firebase SDK 버전을 올리므로 실기기 QC 뒤에 따로 적용하는 것을 권장합니다.
- 설정 → 사용량의 "예상 비용"은 `src/config/models.ts`의 단가표로 계산한 추정치입니다. 통화 단가(`livePerMinute`)는 공식 단가로 확인되지 않은 값이라 실제 청구액보다 낮게 나올 수 있습니다.

## 실행

```bash
npm install
npm run dev        # 개발 서버 (포트 3000)
npm run lint       # 앱 타입 검사
npx tsc -p tsconfig.server.json --noEmit   # 서버 타입 검사
npm run build      # 배포용 빌드
npm test           # 자동 테스트 (tests/*.test.ts, 25개)
npm start          # NODE_ENV=production 에서 dist/ 를 서빙 (NODE_ENV가 없어도 Vite가 없으면 dist/ 서빙)
```

서버에는 `GEMINI_API_KEY`가 있어야 합니다(AI Studio: Settings → Secrets). 상태 확인: `/api/gemini/status`(키 값과 파일 경로는 보여 주지 않고, 찾았는지와 찾은 곳의 종류 `env`·`file`·`proc`·`firestore:user-settings` 등만 표시).

**배포 서버에 키가 안 들어갈 때**(2026-10 현재 AI Studio Publish가 Secrets를 서버에 전달하지 않는 문제): 앱의 설정 → **Gemini 키** 탭에서 키를 저장하면 됩니다. 키는 내 계정 Firestore(`users/{uid}/private/gemini`)에만 저장되고, 서버는 로그인 토큰으로 읽어 메모리에만 둡니다(`server/userKey.ts`). 배포 환경에 진짜 키가 생기면 그 키가 우선이고, 이때 `keySource`가 `firestore:user-settings`가 아닌 값으로 바뀝니다.

## AI Studio ↔ GitHub 작업 규칙
- GitHub에서 PR을 병합했다면, **AI Studio에서 먼저 GitHub 변경을 가져오기(pull)** 한 뒤에 AI Studio에서 작업하세요. 가져오지 않고 올리면(push) AI Studio의 옛 파일이 GitHub의 새 파일을 덮어씁니다(2026-10-14에 `package-lock.json`이 이렇게 되돌아가 CI가 실패했음).
- `package.json`을 바꾸면 `package-lock.json`도 함께 다시 만들어 올려야 CI(`npm ci`)가 통과합니다.
- 모든 push와 PR에서 GitHub Actions CI가 설치 → 타입 검사(앱·서버·테스트) → 빌드 → 자동 테스트(`npm test`)를 확인합니다(`.github/workflows/ci.yml`).
