# 📜 전체 변경 이력 상세 기록 (Changelog Archive)

> **일시 표기 기준**: 모든 버전 릴리즈 및 작업 일시는 **한국 표준시 (KST, UTC+9)** 기준으로 기록됩니다.

---

### [2026-10-14 KST] v2.7.4 — 배포 서버 Gemini 키 우회 (GitHub PR, Claude)
- **문제 원인 (Root Cause)**: AI Studio에서 Publish한 서버(aicall.ai.studio)에 Secrets의 키가 전달되지 않음. `/api/gemini/status` 결과 `hasServerKey:false`, `keySource:"none"`(환경 변수·파일·/proc 어디에도 쓸 수 있는 키 없음). 코드가 아닌 AI Studio 쪽 문제로, Google 포럼에도 같은 신고가 있고 공식 해결책은 없음.
- **적용된 수정 내역 (Changes)**:
  - `server/userKey.ts`(신규): 로그인한 사용자가 저장한 키를 Firestore REST(`users/{uid}/private/gemini`)에서 사용자 본인 토큰으로 읽어 서버 메모리에만 보관(10분 캐시). 배포 환경에 진짜 키가 있으면 그 키가 항상 우선.
  - `server/auth.ts`: 로그인 확인 직후 실행되는 훅(`setAfterAuthHook`). `server.ts`: 키 찾기 마지막 단계에 사용자 저장 키 추가, `/live` 연결 때도 읽음, `/api/gemini/key-refresh` 추가, 키 없음 안내 문구를 "설정 → Gemini 키"로 변경.
  - 설정 화면에 **Gemini 키** 탭(`src/ui/settings/GeminiKeyPanel.tsx`): 키 저장·삭제, 현재 어느 키로 통화하는지 표시.

---

### [2026-10-14 KST] v2.7.3 — 저장소 검수 반영 (GitHub PR, Claude)
- **문제 원인 (Root Cause)**:
  - 녹음 10초 조각은 각각 완결된 WebM 파일인데, 받아쓰기 전에 바이트로 이어 붙였음. 이렇게 만든 파일은 앞부분만 읽혀서(시험: 3초×3개 → 5.9초만 해독) 기록용 받아쓰기에서 말이 빠질 수 있었음.
  - Live 재연결이 실패하면 약 4초마다 끝없이 다시 시도 → 시도마다 토큰 요청과 통화 시작(하루 60회 한도)이 쌓임.
  - 그록봇 피드가 실패한 강의를 요청 때마다 다시 생성 시작.
  - 서버가 모델 이름을 `models.ts`가 아닌 자기 상수로 따로 관리(기획 v4 B-1 위반), Live 기본 지시문이 v1의 "한국어 친구".
  - `/api/sessions/heartbeat`·`interrupted-check`가 로그인 사용자 대신 요청에 적힌 `userId`를 사용.
- **적용된 수정 내역 (Changes)**:
  - `src/services/recording/audioMerge.ts`(신규): 조각을 Web Audio로 풀어 16kHz 모노 WAV로 합침. `chunkRecorder.ts`(1분 임시 받아쓰기), `reviewPipeline.ts`(최종 받아쓰기를 1분씩 요청 후 순서대로 이어 붙임)에 적용.
  - `geminiLiveProvider.ts`: 재연결 5번 연속 실패 시 중단하고 오류 안내.
  - `server/feed.ts`: 실패한 강의는 30분에 한 번만 다시 시도.
  - `server.ts`, `server/lecture.ts`: 모델 이름을 `src/config/models.ts`에서 가져옴(동작 동일, 발음 듣기용 `GEMINI_TTS_LITE_MODEL` 추가). 기본 지시문 영어 튜터로. 시작 로그의 "Gemini 2.5" 문구 정리. 세션 상태 API는 로그인 사용자 기준.
  - 앱 이름 One Call English(`metadata.json`, `index.html`, `public/manifest.json`). `README.md` 현재 기능 기준으로 새로 씀, `PROJECT_CONTEXT.md` 번호·버전 기록 정리, `docs/README.md`에 v1 문서 안내.
- **바로잡음**: 아래 v2.7.2 다음 항목의 "`.env.example` 신규 추가"는 실제 저장소에 반영되지 않았음.

---

### [2026-10-14 KST] Gemini API 키 유효성 검증 및 런타임 모델 명칭 동기화 (v2.7.2)
- **문제 원인 (Root Cause)**:
  - 사용자 질문: "제대로 들어가있는데 왜 계속 오류가 나는가?"
  - 정밀 진단 결과, 사용자가 AI Studio Secrets에 등록한 Gemini API 키는 정상 주입되어 있었음.
  - 그러나 과거 구버전 런타임에서 기본 더미 키(`MY_GEMINI_API_KEY`)가 `process.env`를 선점하여 실시간 유효 키 덮어쓰기가 차단되었던 잔재와, 서버 재시작 전 런타임 메모리 불일치로 인해 팝업이 발생했던 이력 확인.
  - 추가로 `/api/gemini/status`의 모델 표시 라벨이 구버전(`Gemini 2.5 Flash Native Audio Dialog`)으로 잔존해 있어 혼선을 유발함.
- **적용된 수정 내역 (Changes)**:
  - `server.ts`:
    - `/api/gemini/status`의 `modelName` 라벨을 공식 실시간 음성 통화 모델인 `Gemini 3.8 Live Native Audio Dialog`로 교정.
    - 실제 Gemini SDK 통신(`ai.models.generateContent`, `ai.live.connect`, `ai.authTokens.create`) 전수 실시간 호출 검증 통과 (`gemini-3.8-flash`, `gemini-3.8-live`, `gemini-3.5-transcribe` 모두 정상 응답).
  - 런타임 메모리 동기화: `restart_dev_server`를 통해 변경된 키 주입 로직 및 모델 명칭을 활성 메모리에 즉각 반영.
  - `README.md`, `PROJECT_CONTEXT.md`: 최신 빌드 버전(`20261014-multilingual-1522` / `v2.7.2`) 및 키 주입 안내 갱신.
- **방어 조치 (Prevention)**:
  - 키 존재 여부뿐 아니라 SDK 실호출 가능 여부를 검증하고, 더미 키 발생 시 즉각 런타임 동적 감지 로직으로 대체하도록 안전망 유지.
  - KST 기준 일관된 버전 관리 및 Zero-Quota 캐시/보안 정책 100% 보존.

---

### [2026-10-14 KST] Gemini API 키 탐색 및 Cloud Run 환경변수 동기화 강화
- **문제 원인 (Root Cause)**:
  - 통화 시작 시 "서버가 Gemini 키를 찾지 못했어요. AI Studio Secrets의 GEMINI_API_KEY를 확인하고 다시 Publish해 주세요." 팝업이 노출되고, [다시 시도] 시에도 동일 오류가 반복되는 현상 접수.
  - 근본 원인 1: Cloud Run 배포(Publish) 인스턴스는 로컬 전용 파일(`.dev.env.json`)이 배포 컨테이너에 포함되지 않으므로, AI Studio [Settings] > [Secrets]에 등록된 `GEMINI_API_KEY`가 주입되어야만 동작함.
  - 근본 원인 2: `server.ts`의 `resolveGeminiApiKey()`가 `if (found && !process.env.GEMINI_API_KEY)`로 되어 있어, 기본 컨테이너 더미 값(`MY_GEMINI_API_KEY`)이 존재할 경우 유효 키(`found`)를 탐색해도 `process.env`에 덮어쓰지 못하는 버그 존재.
- **적용된 수정 내역 (Changes)**:
  - `server.ts`:
    - `resolveGeminiApiKey()`에서 더미 값 감지 시(`!isUsableKey(process.env.GEMINI_API_KEY)`) 유효 키로 즉시 교체하고 `GOOGLE_API_KEY`, `GOOGLE_GENAI_API_KEY` 동시 동기화.
    - Secret Volume 마운트 경로(`/secrets`, `/etc/secrets`, `/var/run/secrets`, `/var/secrets`) 및 다양한 시크릿 파일명 탐색 확장.
  - `.env.example`: 필수 환경변수 템플릿 신규 추가. *(2026-10-14 확인: 이 파일은 저장소에 없음)*
- **방어 조치 (Prevention)**:
  - `isUsableKey`를 통한 더미 키 차단, Zero-Quota 디스크 캐시 및 Rate Limit 로직 100% 보존.
  - 사용자 화면 및 API 오류 응답에 키/스택 트레이스 비노출 정책 철저 유지.

---

### [2026-10-14 KST] 루트 중복 문서 정리 및 배포 설정 동기화
- **문제 원인 (Root Cause)**:
  - 과거 작업 과정에서 생성되었던 구버전 백업 잔재 파일인 `Project_context.MD`(v2.3.0 시점, 8.8KB)가 루트 경로에 남아 공식 최신 표준 문서인 `PROJECT_CONTEXT.md`(v2.7.0, 14.8KB)와 혼선을 유발함.
- **적용된 수정 내역 (Changes)**:
  - `Project_context.MD`: 불필요한 구버전 중복 파일 영구 삭제.
  - `.dockerignore`, `.gcloudignore`: 무시 제외 목록의 대소문자 표기를 공식 정식 파일명인 `!PROJECT_CONTEXT.md`로 일치시켜 Cloud Run 배포 격리 정책 동기화.
  - `docs/README.md`: 문서 정책 표기 내 `Project_context.MD`를 `PROJECT_CONTEXT.md`로 교정.
- **방어 조치 (Prevention)**:
  - 공식 프로젝트 컨텍스트 단일 진실 공급원(`PROJECT_CONTEXT.md`) 일원화 및 Cloud Run 컨테이너 빌드 정합성 확보.

---

### [2026-10-14 KST] v2.7.0 — [작업 지시서 8] 3단계 코치 — 가이드 B-9 완료
- **문제 원인 및 기획 의도 (Context & Motivation)**:
  - 4대 목표(OPIc, Philly, Travel, Bluey) 트랙을 수강생(찬식님)의 실제 생활 일정(출장, 야근, 휴식, 시험일 등)에 맞게 유연하게 조정하면서도, 데이터 손실이나 임의 조작 없이 안전하게 학습 루틴을 관리할 수 있는 3단계 텍스트 코치 및 스케줄 자동화 파이프라인 구현.
  - LLM 모델이 독단적으로 사용자 계획을 수정하지 못하도록 엄격한 "제안(proposed) → 사용자 승인(approved)" 방어 체계를 확립하고, 언제든 직전 상태로 복구할 수 있는 "되돌리기(reverted)" 라이프사이클 구축.
  - 사용자가 하루 수업을 건너뛰었을 때 과 진도가 낭비되지 않도록 하는 "하루 빠짐 보존" 규칙과, OPIc 시험 1~2주 전 모의고사(14과) 집중 배치 자동 제안, 그리고 2일 연속 결석 시 부드러운 복귀 넛지 배너 제공.
- **적용된 수정 내역 (Applied Changes)**:
  1. **B-11 데이터 모델 완성 (`src/services/firebase/db.ts`)**:
     - `users/{uid}/plan`: `weeklyPattern`, `minutesPerDay`, `updatedAt` 저장. 문서 부재 시 기본 4대 트랙 루틴(월·토 opic, 화·목 philly, 수 bluey, 금 travel, 일 주간복기)으로 자동 초기화(`initUserPlanIfMissing`).
     - `users/{uid}/planChanges`: `requestedText`, `summary`, `before`, `after`, `status`('proposed' | 'approved' | 'rejected' | 'reverted'), `at`, `appliedAt`.
     - `users/{uid}/coachMemory`: `constraints`, `preferences`, `weakPoints`, `updatedAt`. 항목별 개별 삭제 지원(`removeCoachMemoryItem`).
     - `users/{uid}/coachMessages`: 대화 로그 및 제안 카드 ID 연동.
     - `goals/{goalId}.deadline`: OPIc 시험일 등 D-day 기한 저장 및 조회 지원.
     - `users/{uid}/settings/general`: `coachNudges`(`["weekly", "absence2d"]` 기본값, 4주/2주 전 마감 토글 포함).
  2. **스케줄 자동화 규칙 구현**:
     - **하루 빠짐 보존**: 통화 세션이 `status=done`으로 완료된 경우에만 `nextLessonIndex += 1`을 가산(`advanceGoalAfterCompletedCall` in `reviewPipeline.ts`). 당일 통화가 없거나 완료되지 않은 경우 다음 배정 요일에도 동일한 과 번호를 유지하여 과를 건너뛰지 않도록 보장.
     - **OPIc 시험 1~2주 전 모의고사 자동 제안 (`checkOpicDeadlineMockProposal`)**: OPIc deadline이 7~14일 남은 구간 감지 시 실전 모의고사(14과)를 월·토 OPIc 슬롯에 집중 배치하는 `planChange` 제안 카드를 자동 생성. **승인 전에는 MASTER/오늘 카드에 절대 미반영**.
     - **홈 「오늘 수업」 계산 고도화 (`HomeScreen.tsx`)**: 하드코드 `WEEKLY_ROUTINE` 대신 `plan.weeklyPattern + goals.nextLessonIndex`를 최우선으로 반영하여 오늘 추천 수업 및 요일별 집중 루틴 표출.
  3. **코치 탭 UI 구현 (`src/ui/coach/CoachModal.tsx`)**:
     - 홈 상단 헤더의 [AI 코치] 버튼 및 "더 보기" 내 AI 코치 전용 카드 진입점 제공.
     - 채팅 인터페이스: 한국어로 편하게 입력 ➔ 코치 답변 + 변경 제안 카드(before/after 요약 diff) 생성.
     - [승인] 버튼 클릭 시에만 `applyPlanChange` 실행 (plan 및 goals 동시 반영).
     - [거절] 버튼 클릭 시 `rejectPlanChange` 실행 (status=rejected).
     - [변경 이력] 탭: 과거 제안 목록 조회 및 승인된 항목에 대해 [되돌리기] 지원 (`revertPlanChange`, 직전 before 스냅샷 복구, status=reverted).
     - [코치가 기억하는 것] 탭: 제약/선호도/취약점 목록 확인 및 항목별 X 버튼으로 즉시 삭제.
  4. **코치 LLM 엔드포인트 (`server.ts`, `POST /api/coach/chat`)**:
     - `gemini-3.8-flash` 기반 함수 호출 지원: `propose_plan_change`, `get_progress`, `get_mistake_stats`.
     - 모델이 `apply_plan_change`를 직접 호출하려 시도할 경우 400 에러를 반환하여 임의 적용 원천 차단.
  5. **먼저 말 걸기 (넛지)**:
     - **2일 연속 결석 배너 (`checkTwoDayAbsence`)**: 한국시간 기준 어제와 그제 모두 통화 done 세션이 없으면 홈 상단에 "이틀째 쉬었어요. 오늘 수업만 해도 좋아요" 배너 및 [오늘 수업 시작] 바로가기 제공.
     - **일요일 주간 리뷰 아침 강의 (`server/lecture.ts`)**: 일요일 강의 생성 시 coachNote를 한 주간 완수한 진도 및 누적 졸업 표현 성과를 짚어주는 주간 리뷰 톤으로 자동 고도화.
     - **환경설정 탭 확장 (`SettingsModal.tsx`)**: 코치 알림(넛지) 전용 탭을 추가하여 주간 리뷰, 2일 연속 결석, 마감 4주/2주 전 알림 개별 토글 지원.
- **방어 조치 및 호환성 (Safety & Guardrails)**:
  - 모델명(`gemini-3.8-live`, `gemini-3.8-flash`) 및 단일 허용 계정(`episode.kim@gmail.com`) 100% 보존.
  - Live 음성 통화, 퀴즈 채점, 아침 강의, 피드, Keep 가져오기 등 기존 핵심 파이프라인 회귀 없음.
  - 공식 빌드 버전 `20261014-multilingual-1330` 동기화.

---

### [2026-10-14 KST] v2.6.1 — Gemini Live "연결 준비 중" 무한 대기 버그 수정 및 세션 연결 안정화
- **문제 원인 및 기획 의도 (Context & Motivation)**:
  - 전화걸기 실행 시 Gemini Live 통화 화면에서 "연결 중..." 또는 "튜터 연결 준비 중..." 상태에서 멈추고 대화 화면으로 진입하지 못하는 현상 발생.
  - 근본 원인 분석:
    1. **서버 프로세스 환경변수 불일치**: AI Studio 컨테이너 구동 시 컨테이너의 기본 프로세스(PID 1, 53)에는 더미 키(`MY_GEMINI_API_KEY`)가 있었고, 실제 발급된 유효 키는 `/app/.dev.env.json`에 기록되어 있었음. 기존 `server.ts`의 `resolveGeminiApiKeyInner()`가 해당 파일을 조회하지 않아, 클라이언트의 `/api/gemini/token` 요청 및 서버 중계 웹소켓(`/api/gemini/live`) 연결 시 `fallback_required` 에러를 반환.
    2. **클라이언트 이벤트 리스너 덮어쓰기 버그**: `geminiLiveProvider.ts`의 `connectDirect()`에서 웹소켓 오픈 즉시 `wireWebSocketEvents(true)`를 호출하여 `socket.onerror`와 `socket.onclose`를 덮어씀. 이로 인해 직접 연결 실패 시 `reject()`가 실행되지 않고 8초 풀 타임아웃까지 무의미하게 대기.
    3. **마이크 권한 획득 블로킹 결함**: `connect()` 메서드 맨 끝에 `await micPromise;`가 포함되어 있어, 마이크 승인이 지연되거나 완료되기 전까지 세션 연결 수립(`connected`)이 반환되지 못하고 대기 상태에 갇힘.
- **적용된 수정 내역 (Applied Changes)**:
  1. **서버 키 탐색 고도화 (`server.ts`)**:
     - `resolveGeminiApiKeyInner()`에 `/app/.dev.env.json`, `/etc/environment` 파싱 및 전체 `/proc` 프로세스 환경변수 스캔을 추가하여 실제 유효 키를 즉시 동적으로 인식하도록 보강.
     - `LIVE_CONNECT_TIMEOUT_MS`를 6,000ms에서 10,000ms로 조정하여 네트워크 지연 시의 조기 중단 방지.
     - 웹소켓 upgrade 시 URL pathname 파싱 예외 처리 방어 로직 강화.
  2. **클라이언트 직접 연결 생명주기 분리 (`geminiLiveProvider.ts`)**:
     - `connectDirect()`에서 `setupComplete` 수신 전까지는 에러 발생 시 즉시 `reject()`하여 타임아웃 대기 없이 즉시 서버 중계(Proxy)로 폴백하도록 수정.
     - 직접 연결 타임아웃을 8초에서 5초로 최적화.
  3. **마이크 스트림 완전 비동기화 (`geminiLiveProvider.ts`)**:
     - `connect()` 메서드 말미의 `await micPromise;` 블로킹을 해제하고 백그라운드 비동기 처리로 전환.
     - 세션 연결이 성공하면 마이크 승인 여부와 무관하게 즉시 `connected` 상태로 진입하고, 마이크는 준비되는 즉시 오디오 청크를 스트리밍하도록 개선.
- **방어 조치 및 호환성 (Safety & Guardrails)**:
  - 모델명(`gemini-3.8-live`, `gemini-3.8-flash`) 및 화이트리스트 계정(`episode.kim@gmail.com`) 100% 보존.
  - 직접 연결 및 서버 중계 웹소켓 연결 테스트 정상 완료 확인 (`ready`, `session_resumption_update` 수신 검증).
  - 공식 빌드 버전 `20261014-multilingual-1330` 동기화.

---

### [2026-10-13 KST] v2.6.0 — [작업 지시서 6] 2-B 퀴즈 — 가이드 B-6 완료
- **문제 원인 및 기획 의도 (Context & Motivation)**:
  - B-5 간격 반복(1→3→7→14일) 단계에서 누적된 복습 대상 실수를 플래시카드 퀴즈로 능동 인출(Active Recall)하고 졸업(Graduation)시킬 수 있는 카드형 퀴즈 엔진 구현.
  - 학습자의 발화 편의성을 위해 음성(말하기, `gemini-3.5-transcribe` VERBATIM) 및 텍스트(타이핑) 두 가지 모드를 지원하고, `gemini-3.8-flash` 기반의 엄격하면서도 합리적인 의미 기반 채점 로직 구축.
  - 오답 기억 왜곡을 방지하기 위해 정답 확인 전에는 과거 오답(`myPhrase`)을 은닉하고, 실패 시 1회 재도전 큐를 제공하여 학습 효과 극대화.
- **적용된 수정 내역 (Applied Changes)**:
  1. **퀴즈 대상 산출 및 홈 화면 연동 (`HomeScreen.tsx`, `getDueMistakes`)**:
     - `getDueMistakes(today)` 결과를 그대로 사용하여 보류(`deferred`) 실수가 최우선 맨 앞에 정렬.
     - 하루 최대 10개 제한(`Math.min(dueMistakes.length, 10)`).
     - 홈 화면 간격 반복 카드 내 "오늘 복습 N개" 옆에 "오늘 퀴즈 N개" 카운터 및 "퀴즈 풀기" 버튼 배치.
  2. **카드형 플래시카드 & 즉시 피드백 인터페이스 (`src/ui/quiz/QuizModal.tsx`)**:
     - **카드 앞면**: 원어민 표현의 한국어 뜻(`meaningKo`) + 한 줄 이유(`reason`) 힌트 노출.
     - **한국어 뜻 자동 생성 및 Firestore 영구 저장**: 실수 문서에 `meaningKo` 필드가 없으면 퀴즈 시작 시 `gemini-3.8-flash`(`/api/quiz/meaning-ko`)로 한 번 번역 생성 후 Firestore `mistakes/{id}.meaningKo`에 저장하여 재사용 (`updateMistakeMeaningKo`).
     - **과거 오답 은닉**: 학습자가 과거 통화에서 했던 오답(`myPhrase`)은 채점 및 정답 확인 뒤에만 노출.
  3. **말하기 vs 타이핑 2가지 입력 모드**:
     - **말하기 모드**: Web Audio 녹음 ➔ `POST /api/gemini/transcribe-final` (`gemini-3.5-transcribe`, VERBATIM) 전사 ➔ 받아쓴 문장을 화면에 "인식된 발화 (VERBATIM): ..."로 그대로 노출 ➔ 즉시 채점.
     - **타이핑 모드**: 텍스트 입력창 ➔ 제출 시 입력한 문장 그대로 채점.
  4. **채점 서버 API (`/api/quiz/grade`, `gemini-3.8-flash`)**:
     - 프롬프트 지침: "핵심 교정 포인트(reason이 고친 부분)가 맞으면 통과(passed: true). 사소한 철자(typo), 관사(a/an/the), 구두점, 대소문자 차이는 허용."
     - 응답 스키마(JSON Schema): `{ passed: boolean, feedback: string(한국어 1~2문장), correctAnswer: string }`.
  5. **결과 반영 & 1회 재도전 로직**:
     - **통과**: `graduateMistakeAfterQuiz(userId, mistakeId)` 호출 (`status = 'graduated'`), 카드에 "졸업!" 축하 배지 및 통계 갱신.
     - **실패**: 정답, 이유, 과거 오답을 즉시 노출하고, 해당 문항을 오늘 퀴즈 **맨 뒤에 1회 재도전 문항(`isRetry: true`)으로 다시 추가**. 재도전도 틀리면 상태는 그대로 유지하고 다음으로 진행.
     - **퀴즈 시도 기록 영구 보존**: Firestore `users/{uid}/quizAttempts` 서브컬렉션에 `{ mistakeId, mode, answer, passed, feedback, createdAt }` 기록 (`saveQuizAttempt`).
  6. **B-5 잔여 연동 확장 (`reviewPipeline.ts`, Requirement 5)**:
     - 복기 파이프라인에서 복기 AI에 전달하는 복습 대상 실수 필터를 `status == 'reviewing'`뿐만 아니라 **`reviewing` + `deferred`**로 확장하여, 보류 상태의 실수도 통화 중 자연스럽게 맞게 쓰면 빠른 졸업(`usedCorrectly`)되도록 연동.
  7. **엄격한 규칙 준수**:
     - 수동 졸업 버튼 배제, 아침 강의(B-7) 미연결 시 홈 진입만 제공, 말해보카 등 상표 및 문제 복제 금지.
- **방어 조치 및 호환성 (Safety & Guardrails)**:
  - 기존 Live 직접연결·중계·세션 재개·10초 청크 녹음·B-4 복기 경로 100% 무변경 유지.
  - `src/config/models.ts` 모델명 및 Firebase 단일 계정 화이트리스트(`episode.kim@gmail.com`) 불변 유지.
  - 빌드 버전 `20261013-multilingual-1652` 동기화.

---

### [2026-10-13 KST] v2.5.0 — [작업 지시서 5] 2-A 간격 반복과 졸업 — 가이드 B-5 완료
- **문제 원인 및 기획 의도 (Context & Motivation)**:
  - 오답 분석을 통해 수집된 실수를 망각 곡선에 따라 체계적으로 장기 기억화하기 위해, 1일 ➔ 3일 ➔ 7일 ➔ 14일 간격 반복(Spaced Repetition) 단계 시스템과 졸업/보류/재학습 라이프사이클 구현.
  - 다음 통화에서 맞게 발화했을 경우(`usedCorrectly`) 퀴즈 없이 즉시 졸업시키는 빠른 졸업 경로와, 이미 졸업한 실수를 재반복했을 경우(`repeatedMistakes`) 1일차로 강등시켜 다시 학습시키는 안전망 연동.
  - 퀴즈(B-6) 및 아침 강의(B-7) 출시에 앞서 핵심 데이터 모델, 상태 전이 함수, 오늘 복습 대상 쿼리 및 임시 디버그 검증 도구 완비.
- **적용된 수정 내역 (Applied Changes)**:
  1. **실수 상태 모델 확장 (`db.ts`, `firebase-blueprint.json`)**:
     - `MistakeData` 필드 정의: `stage`(1 | 3 | 7 | 14), `status`("reviewing" | "graduated" | "deferred"), `nextReviewAt`(KST YYYY-MM-DD), `graduatedAt`, `graduatedReason`, `reopenedAt`, `reopenCount`.
     - 신규 실수 저장 시(`saveCallMistakes`) `stage: 1일`, `status: "reviewing"`, `nextReviewAt: 내일(KST+1일)` 자동 설정.
  2. **아침 강의 수강 기반 단계 진행 (`advanceMistakeAfterLesson`)**:
     - `reviewing` 상태의 실수를 다음 단계로 승급하고 KST 기준 `nextReviewAt` 갱신:
       - 1일차 ➔ 3일차 (`nextReviewAt = 오늘 + 3일`)
       - 3일차 ➔ 7일차 (`nextReviewAt = 오늘 + 7일`)
       - 7일차 ➔ 14일차 (`nextReviewAt = 오늘 + 14일`)
       - 14일차에서 수강 완료(퀴즈 미통과 상태) ➔ `status = "deferred"` (보류).
     - 홈 화면에 "임시 디버그: 단계 진행" 시뮬레이터 제공: 각 실수 항목 옆 `[이 실수 강의 들었음 처리]` 버튼을 제공하여 1→3→7→14→deferred 순차 전진을 실시간 수동 테스트 가능.
  3. **빠른 졸업 & 다시 복습 실반영 (`applyCallMistakeUpdates`, `reviewPipeline.ts`)**:
     - 지시서 4에서 저장만 해 두었던 `sessions.review.usedCorrectly` 및 `repeatedMistakes`를 실제로 Firestore에 반영:
       - `usedCorrectly`: `status = "graduated"`, `graduatedReason = "call_used_correctly"`, `graduatedAt` 갱신 (퀴즈 없이 즉시 졸업).
       - `repeatedMistakes`: `status = "reviewing"`, `stage = 1일`, `nextReviewAt = 내일`, `reopenCount += 1`, `reopenedAt` 갱신 (1일차 다시 복습).
  4. **퀴즈 통과 졸업 훅 준비 (`graduateMistakeAfterQuiz`)**:
     - B-6 퀴즈 통과 시 단일 호출할 수 있는 `graduateMistakeAfterQuiz(userId, mistakeId)` 함수 구현 (`status = "graduated"`, `graduatedReason = "quiz_passed"`). 퀴즈 UI는 만들지 않고 훅만 보존.
  5. **오늘 복습 대상 집계 쿼리 (`getDueMistakes`)**:
     - `status == "deferred"` 및 `status == "reviewing" && nextReviewAt <= 오늘` 필터링.
     - **`deferred`(보류) 실수가 목록의 맨 앞**에 위치하도록 정렬.
     - 홈 화면에 "오늘 복습 N개" 숫자 카드 표출 (보류 개수 및 오늘 대상 개수 보조 표시).
  6. **수동 졸업 버튼 엄격 배제**:
     - 기획 스펙 지침에 따라 임의 수동 졸업 버튼은 일체 배치하지 않고, 통화 정상 발화 또는 퀴즈를 통해서만 졸업되도록 통제.
- **방어 조치 및 호환성 (Safety & Guardrails)**:
  - 기존 Live·녹음·복기·세션 재개 경로 100% 무변경 유지.
  - `src/config/models.ts` 모델명 및 Firebase 단일 계정 화이트리스트(`episode.kim@gmail.com`) 불변 유지.
  - 빌드 버전 `20261013-multilingual-1632` 동기화.

---

### [2026-10-13 KST] v2.4.0 — [작업 지시서 4] 1-D 통화 후 복기 (기록용) — 가이드 B-4 완료
- **문제 원인 및 기획 의도 (Context & Motivation)**:
  - 통화가 끝난 후 사용자의 실제 발화 실수를 왜곡 없이 정확하게 짚어내기 위해, "임의로 다듬지 않는" 원문 그대로의 기록용 받아쓰기(VERBATIM sttFinal) 기반 정밀 복기 파이프라인 구현.
  - 음성 인식 오인식으로 인한 잘못된 오답 지적을 사용자가 직접 신고 및 제외할 수 있는 피드백 메커니즘 제공 및 Google Keep 단일 블록 복사 지원.
  - 지시서 3에서 남은 미완료 통화 판정 및 실패 청크 자동 재업로드 보완.
- **적용된 수정 내역 (Applied Changes)**:
  0. **지시서 3 보완 (Requirement 0)**:
     - 10초 조각 업로드 시마다 Firestore `sessions.lastChunkAt` 갱신 (`db.ts`, `appendSessionChunk`).
     - "끊긴 통화" 판단을 Firestore 기준으로 일원화: `in-progress` 상태에서 `lastChunkAt`이 2분을 초과하면 `pending_review`로 전환 (`checkAndMarkInterruptedSessions`). 앱 시작 시에도 동일 검사 실행.
     - 앱 시작 시 IndexedDB에 남은 미업로드 조각 자동 재업로드 및 Firestore `recordingChunks.uploaded: true` 갱신 후 IndexedDB 삭제 (`retryPendingUploads`).
  1. **최종 받아쓰기 (기록용 sttFinal - `reviewPipeline.ts`, `server.ts`)**:
     - 통화 종료(정상 종료 및 끊긴 통화) 시 저장된 10초 조각들을 순서대로 결합하여 `/api/gemini/transcribe-final` (`gemini-3.5-transcribe` VERBATIM)으로 전사.
     - 전사 결과를 Firestore `sessions.sttFinal`에 영구 보존.
     - 최종 받아쓰기 실패 시 통화 중 임시본(`sttPartial`)을 이어붙여 폴백 처리하며 `sourceStt: 'sttPartial_fallback'` 명시.
  2. **복기 생성 파이프라인 (`/api/review`, `gemini-3.8-flash`)**:
     - [기록용 받아쓰기(sttFinal) + Live 대화 로그 + 오늘 수업 지시서 + 기존 실수 목록]을 입력으로 주입.
     - "인식이 어색하면 적당히 다듬어라" 지시를 완전히 삭제하고, `myPhrase`는 기록용 받아쓰기 문장을 글자 그대로 복사(절대 수정 금지).
     - `mistakes[]`: `myPhrase`(글자 그대로 복사), `naturalPhrase`, `reason`(한국어 1~2문장), `sourceStt`.
     - `keyExpressions[]`: 정확히 5개 필수 암기 표현.
     - `estimatedLevel`: IM2, IH, AL, Native 등급.
     - `usedCorrectly`: 현재 복습 중인 실수 중 이번 통화에서 맞게 쓴 ID 목록 저장.
     - `repeatedMistakes`: 이미 졸업한 실수를 이번 통화에서 다시 틀린 ID 목록 저장.
  3. **결과 화면 (Review Screen - `ReviewModal.tsx`)**:
     - 표: 내가 한 말 (verbatim) -> 자연스러운 표현 (발음 듣기 지원) -> 교정 이유.
     - 외울 표현 5선 목록 및 TTS 발음 재생.
     - AI 예상 레벨 옆에 **"AI 예상치, 공식 등급 아님"** 문구 명시.
     - 각 실수 항목 옆 **"이건 내가 한 말이 아니에요"** 버튼: 클릭 시 해당 실수를 숨기고 `qualityReports` 컬렉션에 `(sessionId, myPhrase, sourceStt, 시각)` 즉시 보존.
     - **"Keep에 붙여넣기용 복사"** 버튼: 화면에 표시된 실수 목록을 줄마다 `[내가 한 말] -> [자연스러운 표현]` 단일 텍스트 블록으로 일괄 복사.
     - "끝나지 않은 통화가 있어요" 복구 모달에서 **"복기 시작"** 클릭 시 본 복기 화면으로 자연스럽게 이어지도록 연동.
  4. **영구 저장**:
     - 실수는 `mistakes` 컬렉션에 `stage: 1`, `status: "reviewing"`, `source: "call"`, `sessionId`와 함께 자동 저장.
     - 세션 문서에 review 결과와 `status: "done"` 저장.
- **방어 조치 및 호환성 (Safety & Guardrails)**:
  - 기존 Live 직접연결·중계·세션 재개·청크 녹음 경로 무변경 보존.
  - `src/config/models.ts` 모델명 절대 불변 준수(`gemini-3.8-live`, `gemini-3.5-transcribe`, `gemini-3.8-flash`).
  - 단일 허용 계정(`episode.kim@gmail.com`) ABAC 보안 규칙 및 firestore.rules 호환 검증.

---

### [2026-10-13 KST] v2.3.0 — [작업 지시서 3] 1-C 통화 중 녹음 (끊김 대비) — 가이드 B-3 완료
- **문제 원인 및 기획 의도 (Context & Motivation)**:
  - 모바일 웹앱 환경에서 화면 꺼짐, 네트워크 순단, 브라우저 탭 닫힘 등으로 인해 Live 연결이 끊기더라도 학생의 음성과 대화 맥락이 유실되지 않도록 이중 안전망 구축 필요.
  - 10초 단위 로컬 우선(Local-First IndexedDB) 저장 후 클라우드 스토리지 전송, 세션 재개 실패 시 대화 요약 자동 주입, 미완료 통화 자동 복기 감지 파이프라인 구현.
- **적용된 수정 내역 (Applied Changes)**:
  1. **마이크 청크 녹음 파이프라인 (`chunkIndexedDb.ts`, `chunkRecorder.ts`)**:
     - `MediaRecorder`를 활용하여 마이크 음성을 독립적으로 **10초** 조각으로 분할 녹음.
     - 각 조각을 IndexedDB(`OneCallRecordingsDB`의 `pending_chunks`)에 먼저 즉시 영구 저장 후 Cloud Storage(`uploadAudioFile`)로 업로드.
     - 업로드 성공 시 IndexedDB에서 해당 조각 삭제(순단 시 보존 및 백그라운드 재시도).
     - Live 소켓 재연결/GoAway/프록시 전환과 완전 분리되어 녹음이 끊김 없이 연속 진행.
  2. **통화 중 1분 단위 임시 받아쓰기 (`server.ts`, `/api/gemini/transcribe-partial`)**:
     - 녹음이 6조각(~60초) 쌓일 때마다 서버가 비동기로 `gemini-3.5-transcribe` **VERBATIM** 모드로 전사하여 Firestore `sessions.sttPartial`에 누적 기록.
     - 실시간 Live 대화와 별도 비동기로 동작하며 환경 설정(SettingsModal)에서 On/Off 토글 지원.
  3. **Live 대화 로그 지속 저장 & 세션 재개 실패 대비 (`geminiLiveProvider.ts`, `db.ts`)**:
     - Live 대화 턴이 발생할 때마다 실시간으로 Firestore `sessions.liveTranscript`에 동기화.
     - 세션 재개 handle이 거부/실패할 경우, 그때까지의 대화 히스토리 요약을 새 세션 시스템 프롬프트에 자동 주입하여 튜터가 맥락을 잃지 않고 대화를 연속하도록 안전망 구축.
  4. **끊긴 통화 자동 처리 및 복구 모달 (`server.ts`, `UnfinishedSessionModal.tsx`, `App.tsx`)**:
     - 마지막 조각 이후 **2분** 동안 새 조각이 인입되지 않으면 서버 워치독 및 클라이언트가 끊긴 통화로 판정하여 `pending_review`("복기 대기")로 상태 자동 전환.
     - 사용자가 앱을 닫았다가 다시 열면 **"끝나지 않은 통화가 있어요. 복기할까요?"** 복구 모달 표시.
  5. **화면 안내 및 Screen Wake Lock (`NewCallScreen.tsx`)**:
     - 통화 화면 상단에 **"통화 중에는 화면을 켜 두세요"** 안내 배너 및 10초 녹음 조각 카운터/보존 상태 표시.
     - Screen Wake Lock API(`navigator.wakeLock.request('screen')`) 자동 요청.
  6. **세션 메타데이터 & 스토리지 보관함 인스펙터 (`db.ts`, `firebase-blueprint.json`, `SettingsModal.tsx`)**:
     - `sessions.recordingChunks`에 각 조각의 index, path, storageUrl, timestamp, uploaded, durationSeconds 저장.
     - 설정 모달 내 "녹음 보관함 (Storage Chunks)" 탭을 신설하여 실제 저장된 10초 파일 목록과 1분 부분 전사 기록을 바로 검증할 수 있도록 지원.
- **방어 조치 및 호환성 (Safety & Guardrails)**:
  - `src/config/models.ts` 모델명 절대 불변 준수(`gemini-3.8-live`, `gemini-3.5-transcribe` VERBATIM).
  - 허용 계정(`episode.kim@gmail.com`) 인증 규칙 및 CORS, 스토리지 폴백 보존.
  - 빌드 버전 `20261013-multilingual-1529` KST 동기화.

---

### [2026-10-13 KST] v2.2.1 — [수정 지시서 2-1] 브라우저 직접 연결 고치기 (B-2 직접 연결 파이프라인 최적화)
- **문제 원인 분석 (Root Cause)**:
  - 기존 직접 연결 엔드포인트 URL이 `BidiGenerateContent?key=토큰` 형태로 지정되어 임시 토큰 인증 규격과 불일치(403/거절 발생 시 중계로 넘어감).
  - 소켓 개방 즉시 `connected`로 판정하여 세션 `setupPayload` 거절 시 프록시 전환 기회를 놓칠 위험 존재.
- **적용된 수정 내역 (Applied Changes)**:
  - **직접 연결 주소 규격 동기화 (`geminiLiveProvider.ts`)**: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${token}`로 수정.
  - **서버 임시 토큰 발급 설정 보강 (`server.ts`, `/api/gemini/token`)**:
    - `GoogleGenAI` 생성 시 `httpOptions.apiVersion: 'v1alpha'` 명시.
    - `authTokens.create` 설정: `uses: 1`, `expireTime: now + 30분 (ISO)`, `newSessionExpireTime: now + 1분 (ISO)` 구성.
    - 실제 API 키 노출 없이 `token.name`만 클라이언트로 안전하게 반환.
  - **엄격한 "연결됨" 판정 시점 (`geminiLiveProvider.ts`)**:
    - 소켓 `open` 후 setup을 전송하고, Gemini 서버로부터 `setupComplete` 메시지를 수신한 시점에만 `connected`로 전환.
    - `setupComplete` 수신 전 소켓 종료/에러 발생 시 또는 8초 타임아웃 경과 시 "직접 연결 실패"로 판정하고 투명하게 서버 중계 프록시(`/api/gemini/live`)로 즉시 전환.
  - **재연결 토큰 라이프사이클 (`geminiLiveProvider.ts`)**:
    - `goAway` 수신 또는 일시 끊김 발생 시 기존 소켓 이벤트 클린업 후 `/api/gemini/token`에서 새로운 임시 토큰을 발급받아 세션 핸들(`resumeHandle`)을 이어 직접 연결부터 재시도.
    - 새 토큰 발급 또는 직결 실패 시 서버 프록시로 안전 전환.
  - **연결 경로 및 텔레메트리 영구 기록 (`geminiLiveProvider.ts`, `NewCallScreen.tsx`, `App.tsx`)**:
    - 연결 수립 시 브라우저 콘솔에 `[Live] path=direct` 또는 `[Live] path=proxy` 1행 로깅.
    - 통화 종료 시 Firestore `users/{userId}/sessions/{sessionId}` 문서에 `connectionPath`(마지막 연결 경로) 및 `directFailCount`(직접 직결 실패 횟수) 필드 영구 저장.
- **방어 조치**:
  - `firebase-blueprint.json` 내 `Session` 엔티티에 `connectionPath`, `directFailCount` 스키마 추가.
  - 서버 프록시 경로, 통화 화면, 5대 제어 버튼, 음성 받아쓰기, `models.ts` 모델명 불변성 엄격 유지.

---

### [2026-10-13 KST] v2.2.0 — Part B-2 실시간 통화(대화용 파이프) 구현 완료
- **`gemini-3.8-live` 세션 재개 & 컨텍스트 창 압축 기본 탑재 (`geminiLiveProvider.ts`, `server.ts`)**:
  - `sessionResumption: { handle: resumeHandle, transparent: true }` 적용을 통해 연결 끊김 시 이전 세션 상태 복원 및 맥락 유지.
  - `contextWindowCompression: { slidingWindow: {} }` 설정으로 15분 이상 장시간 지속 통화 지원 (토큰 한도 초과 방지).
- **GoAway 자동 재연결 및 상태 표시 UI (`NewCallScreen.tsx`)**:
  - 서버 `goAway` 신호 또는 일시적 네트워크 단절 수신 시 저장된 세션 핸들(`resumeHandle`)을 이용해 1초 내 즉시 재연결 수행.
  - 재연결 중 사용자 화면 상단에 "연결 유지 중" 상태 뱃지를 짧게 노출하여 안정감 제공.
- **임시 토큰 직결 및 서버 프록시 이중 파이프라인 구축 (`POST /api/gemini/token`, `/api/gemini/live`)**:
  - 브라우저가 먼저 서버의 임시 토큰 발급 API를 호출하여 Gemini 엔드포인트 직결을 시도하고, 임시 토큰 미지원 또는 실패 시 서버 WebSocket 프록시로 투명하게 자동 전환.
- **오늘 수업 지시서 시스템 프롬프트 주입 (`lessonPromptBuilder.ts`)**:
  - 목표명, 과 내용, 사용자 커스텀 변수([직무], [서베이 주제], [Philly 역할]) 치환본, 복습 대상 실수 최대 3개(대화 중 자연스럽게 유도)를 결합하여 Gemini Live 초기 세션에 주입.
- **5대 핵심 화면 제어 버튼 탑재**:
  - `Done`: 답변 종료 및 40초 이내 핵심 피드백(등급, 교정, AL 표현) 요청.
  - `Feedback`: 즉시 발화 교정 요청.
  - `Model answer`: 60초 AL 모범 답안 요청.
  - `Pause`: 장면 일시 정지 및 점검.
  - `Slow`: 천천히 또박또박 말하기 요청.
- **Live 자체 받아쓰기 보조 저장**:
  - `inputAudioTranscription`을 실시간 활성화하여 통화 화면에 롤링 자막으로 노출하고, 통화 종료 시 Firestore `users/{userId}/sessions/{sessionId}`의 `liveTranscript` 필드에 보조 데이터로 저장.
- **격리 원칙 준수**:
  - 녹음(10초 청크), 받아쓰기(gemini-3.5-transcribe), 복기(Mistake Vault), Keep 가져오기 등 후속 단계 기능은 요청에 따라 배제하고 B-2 통화 파이프에만 집중.

---

### [2026-10-13 KST] v2.1.0 — Part B-12 1단계 뼈대 구축 완료
- **Firebase 단일 계정 접근 제어 & 클라우드 스토리지 연동 (`B-1`, `B-11`)**:
  - `episode.kim@gmail.com` 1인 전용 Google 로그인 인증 체계 구현 (`src/services/firebase/auth.ts`).
  - 비인가 계정으로 로그인 시 즉시 세션 차단, 자동 로그아웃 및 전용 에러 메시지(`UnauthorizedUserError`) 반환.
  - Firestore 엔티티 스키마 청사진(`firebase-blueprint.json`) 작성 및 단일 사용자 ABAC 보안 규칙(`firestore.rules`) 배포 완료.
  - Firestore 에러 표준화 함수(`handleFirestoreError`) 및 Cloud Storage 오디오 버킷 연동(`src/services/firebase/storage.ts`).
- **Part B-1 모델 설정 및 공급자 인터페이스 뼈대 (`models.ts`, `providers/`)**:
  - `src/config/models.ts` 내 확정 모델명 및 엔진 선언:
    - `LIVE_MODEL = "gemini-3.8-live"`
    - `TEXT_MODEL = "gemini-3.8-flash"`
    - `STT_ENGINE = "gemini"` (`gemini-3.5-transcribe`, 모드 `VERBATIM`) / 대안 `universal-3-5-pro` (AssemblyAI)
    - `TTS_ENGINE = "gemini"` (`gemini-3.8-flash-tts`) / 대안 `elevenlabs`
    - B-10 사용량 산출용 단가표(`PRICING_RATES`) 일원화 관리.
  - 공급자 인터페이스 추상화: `LiveProvider`, `SttProvider`, `LlmProvider`, `TtsProvider` 정의 (`src/services/providers/types.ts`) 및 팩토리 분리. UI 컴포넌트가 공급자 벤더명을 직접 호출하지 않도록 아키텍처 격리.
- **4대 목표 데이터 영구 보존 & 요일 루틴 엔진 (`B-9`, `부록`)**:
  - 4개 목표 커리큘럼 내장 (`src/data/defaultGoals.ts`): OPIc AL (14과), 필리조선소 주재원 (15과), 미국·호주 여행 (13과), Bluey 듣기 (12과).
  - 마스터 체크리스트 부록 원문 튜터 프롬프트(Google Keep 연동 및 Gemini 앱 특화 지시사항 포함) 100% 무삭제 원문 보존.
  - 프롬프트 커스텀 변수 슬롯 처리기(`src/data/promptCustomizer.ts`): 원문의 `[직무]`, `[Survey topics I chose]`, `[My role in Philly]`, `[Recent weak points]`를 설정 화면에서 사용자가 직접 입력하여 동적으로 치환 가능하도록 지원.
  - B-9 요일별 루틴 엔진: 월·토 OPIc, 화·목 Philly, 수 Bluey, 금 여행, 일 주간 복기.
- **첫 실행 진도 설정 모달 & 홈 화면 오늘 수업 카드 (`src/ui/`)**:
  - 첫 로그인 시 목표별 진도를 설정하는 `InitialProgressModal` 구현 (OPIc 10/10 1과, 10/11 2과, 10/12 3과 진행 히스토리를 반영한 추천 및 커스텀 선택).
  - 오늘 요일에 맞춘 `오늘의 추천 수업 카드` 실시간 렌더링, 현재 진행 과명, 목표 설명, 진도 변경 드롭다운 제공.
  - 원문 튜터 프롬프트 뷰어 모달(부록 원본 vs 변수 치환본 토글 보기) 및 환경설정 모달 제공.
- **통화·녹음·복기 격리 원칙 준수**:
  - 사용자 지시에 따라 1단계에서는 통화/녹음/STT/복기 엔진을 선제 실행하지 않고 뼈대와 데이터 파이프라인에 집중.

---

### v2.0.0 (2026-10-13 KST) — AI 1:1 전화영어 올인원 랩 전면 탈바꿈
- **4대 집중 트랙 및 10/10~1/9 일자별 커리큘럼 탑재 (`src/data/curriculums.ts`, `src/data/schedule.ts`)**:
  - 🎯 **OPIc 코치**: 1~14과 (자기소개, 집/동네 묘사, 설문 3종, 롤플레이 A/B/C, 돌발 주제, 사회 이슈 비교, 실전 모의고사 15문항).
  - 🏭 **Philly 출근 (한화 필리 조선소)**: 1~15과 (첫 출근 인사, 생산 회의, 지연 보고/만회 계획, 안전 Toolbox Talk, 용접/블록 결함, 공손한 반대, 벤더 전화, Eagles/Phillies 스몰토크, 본사 결정 전달 등).
  - ✈️ **여행 (미국 · 호주)**: 1~13과 (미국 입국심사, 렌터카, 호텔 컴플레인, 레스토랑 주문/팁, 약국 아이 해열제, 호주 검역, 로컬 카페 Flat white, 본다이 해변 안전, 놀이터 BBQ 스몰토크).
  - 🦘 **Bluey 리스닝**: S1E01~S1E13 (3줄 줄거리, 호주 슬랭 10개, 호주 모음 발음 포인트, 5편 단위 누적 퀴즈 및 섀도잉 악센트 드릴).
  - **주간 루틴 및 날짜 계산**: 월(OPIc), 화(Philly), 수(Bluey), 목(Philly), 금(여행), 토(OPIc 모의고사), 일(주간 복기).
- **통화 종료 후 자동 복기 & Mistake Log 생성 (`POST /api/review`, `ReviewModal.tsx`)**:
  - Gemini 3.8 Flash의 정밀 JSON Schema를 활용해 대화 트랜스크립트 전체를 1회 정밀 분석.
  - `[내가 한 말 -> 자연스러운 원어민 표현 -> 이유]` 교정 표, 오늘 꼭 외울 표현 5선(상황/예문), 예상 OPIc 레벨(IM2/IH/AL), Google Keep 양식 자동 생성.
- **Google Keep 스타일 카드형 Mistake Vault (`MistakeVaultModal.tsx`, `AppStorage.ts`)**:
  - 로컬스토리지 영구 보존 및 트랙별 필터링, 복습 완료 체크박스, 원클릭 Keep 전체 복사, 개별 표현 원어민 TTS 발음 청취 기능 지원.
- **아침 7시 맞춤형 복습 팟캐스트 & 텔레그램 연동 (`POST /api/podcast`, `POST /api/telegram/send`, `MorningPodcastModal.tsx`)**:
  - 미완료 실수를 엮어 출근길에 듣는 3분 1:1 맞춤형 오디오 강의 스크립트 자동 생성.
  - Gemini 3.8 Flash Lite TTS 고음질 음성 합성 및 앱 내 플레이어(재생/일시정지/10초 앞뒤 이동) 제공.
  - 텔레그램 봇 토큰 및 Chat ID 등록 시 텔레그램으로 오디오 파일 자동 전송 지원.
- **전화 통화 엔진 확장 (`src/voice/VoiceCallEngine.ts`, `CallScreen.tsx`)**:
  - `VoiceCallContext`를 통해 트랙별 전문 시스템 프롬프트, 원어민 악센트 보이스(Kore, Puck, Charon, Zephyr), 레슨 시작 프롬프트 주입.
  - 통화 중 원터치 음성 명령어 툴바 지원 ("Next lesson", "Answer starts/Done", "Feedback", "Pause", "Model answer", "Slower").
  - 전체 통화 트랜스크립트 실시간 누적 수집 후 통화 종료 시 복기 엔진으로 자동 전달.

---

### v1.2.2 (2026-10-01 KST) — 한국어 귀 고정 (Korean Ear Lock)
- **Gemini Live 세션 언어 고정 (`server.ts`)**:
  - `speechConfig`에 `languageCode: 'ko-KR'` 명시 및 입출력 오디오 전사(`inputAudioTranscription`, `outputAudioTranscription`)에 `languageCodes: ['ko-KR']` 고정 적용.
  - 점진적 폴백 체계 구축: `ko-KR` 전사 옵션 거절 시 빈 전사 객체(`{}`) 및 `speechConfig.languageCode: 'ko-KR'` 유지, 최종 거절 시 세션 종료 없이 `voice-only` 모드로 안전 폴백.
- **페르소나 프롬프트 귀 고정 및 반말 일치 (`PersonaPrompt.ts`, `VoiceCallEngine.ts`)**:
  - `PersonaPrompt.systemInstruction`에 외국어(일본어/러시아어/중국어/영어) 오인식 판단 금지, 가나/키릴/한자/라틴 문자 발생 시 오인식 재청취 규칙 명시.
  - 첫인사 `text_prompt`를 반말 및 외국어 금지 지시(`(통화가 연결됐어. ${nick}에게 반말로 짧게 먼저 인사해. 외국어는 쓰지 마.)`)로 통일하여 초기 언어 드리프트 원천 차단.
- **폴백 전사 언어 고정 (`/api/gemini/transcribe`)**:
  - 전사 프롬프트 첫 줄에 `언어는 한국어(ko-KR)로 고정. 일본어·러시아어로 전사하지 마.` 추가. Live 세션 중 텍스트 프롬프트로 재주입하지 않는 단일 귀(Single Ear) 원칙 엄수.
- **P4 오디오 관측 인스펙터에 Language Lock 표시 (`CallScreen.tsx`)**:
  - 실시간 세션 언어 고정 상태(`ko-KR` / `voice-only`)를 인스펙터 패널에 실시간 노출.

---

### v1.2.1 (2026-10-01 KST) — 실측 관측성 및 실증 도구 장착
- **P4 오디오 관측 인스펙터 공식 탑재 (`CallScreen.tsx`)**:
  - 통화 화면 상단에 접이식 인스펙터 패널 추가.
  - 실시간 측정값 노출:
    - `Capture → Decimate`: 하드웨어 실제 샘플레이트 (예: `48000Hz → 16000Hz`)
    - `Mic RMS`: 실시간 마이크 입력 에너지 (실측 4자리 부동소수점)
    - `Packets Sent`: 16kHz PCM 전송 누적 패킷 수
    - `Echo Gate`: `OPEN (마이크 송출)` / `CLOSED (스피커 보호 음소거)` 실시간 상태
    - `Live Input Transcript`: Gemini Live의 `inputAudioTranscription`이 반환한 원본 전사 문자열
    - `First Sound Latency`: 실측 응답 지연 시간 (ms)
- **16kHz 마이크 변환 2초 WAV 원음 검증기 탑재 (`playWavProof`)**:
  - 통화 중 다운샘플링된 16kHz PCM 스트림을 2초 원형 링 버퍼(`Int16Array(32000)`)에 실시간 보관.
  - 화면의 「마이크 16kHz 변환 녹음 청취 (WAV 검증)」 버튼 클릭 시, 브라우저 메모리에서 16kHz 16-bit Mono 표준 WAV를 즉석 생성하여 1.0배속으로 재생.
  - 내 목소리가 정상 피치로 들리는지 귀로 즉시 물리적 검증 가능.
- **하드코딩 제거 및 실측 레이턴시 연동**:
  - 기존의 하드코딩 레이턴시(`firstSoundMs: 300, modelMs: 250`)를 완전히 삭제하고, `userLastSpokeAt`부터 `audio` 청크 도착 시점까지의 실제 경과 시간(`measuredLatencyMs`) 측정.
- **Live 인터럽트 공식 SDK 메서드 연동**:
  - `liveSession.sendClientContent({ turnComplete: true })` 호출로 서버 세션 인터럽트 보장.
- **폴백 모델 생존성 실측 증명**:
  - `gemini-3.8-flash`, `gemini-3.5-transcribe`, `gemini-3.8-flash-lite-tts` API 200 OK 응답 검증 완료.

---

### v1.2.0 (2026-10-01 KST) — Grok 기획 검수 수용 및 단일 오디오 소스 구축
- **Grok 기획 검수 전면 수용 및 단일 오디오 소스(Single Ear) 아키텍처 구축**:
  - Live 통화 중 WebSpeech API 및 MediaRecorder 전면 비활성화 (귀를 하나로 일원화).
  - Gemini Live 서버의 `inputAudioTranscription` 및 `outputAudioTranscription` 활성화로 정확한 음성 전사 자막 직결.
- **하드웨어 오디오 경로 결함 해소**:
  - `ScriptProcessor` 스피커 직결 버그 제거 (Zero-Gain 무음 노드로 격리).
  - 7.5kHz 안티에일리어싱 저역 통과 필터(`BiquadFilterNode`) 탑재.
  - `fastUint8ToBase64` 청킹 인코딩으로 CPU 오버헤드 해소.
- **에코 및 버퍼 잔류 동기화**:
  - `PcmAudioSink` 실제 스피커 큐 소진 시간 계산 후 마이크 게이트 오픈.
  - Barge-in 시 로컬 오디오 즉각 정지 및 서버 `{ type: 'interrupt' }` 전송.
- **UX 개선**:
  - 통화 화면 상단에 `🎧 이어폰을 착용하시면 더 선명하게 대화할 수 있어요` 팁 배지 추가.
- **합의 문서 추가**:
  - Grok 기획 검수 합의서 `GROK_REVIEW_RESPONSE.md` 생성 및 진단서 `v1.2.0` 승격.

---

### v1.1.1 (2026-09-30 KST) — 오디오 다운샘플링 왜곡 및 환청 하이재킹 해결
- **오디오 다운샘플링 왜곡(1/3배속 슬로모션) 해결**:
  - `downsampleTo16kHz` 선형 보간 알고리즘을 도입하여 48kHz/44.1kHz 기기 환경에서도 왜곡 없는 정밀 16,000Hz PCM 음성 스트리밍 보장.
- **WebSpeech 환청 텍스트 하이재킹 차단**:
  - 브라우저 음성 인식이 발생시킨 오인식 텍스트("치과", "사랑해" 등)가 Live WebSocket으로 `text_prompt`로 주입되던 구조적 결함 제거.
  - Gemini Live가 순수 마이크 음성만을 듣고 정확하게 답변하도록 단일 오디오 소스 파이프라인 정립.
- **에코 방지 마이크 게이트(Echo Suppression Gate)**:
  - AI 발화 중 마이크 오디오 전송을 일시 차단하여 스피커 하울링 및 재유입 방지.
- **상세 진단 보고서 작성**:
  - 외부 전문가 공유 및 아키텍처 분석용 `DIAGNOSIS_AND_SOLUTIONS.md` 생성.

---

### v1.1.0 (2026-09-30 KST) — Gemini 2.5 Flash Native Audio 정식 연동
- **Gemini 2.5 Flash Native Audio Dialog 정식 연동**:
  - Google AI Studio Tier 1 Live API 모델 식별자(`gemini-2.5-flash-native-audio-latest`)로 매핑 수정 및 연결 성공.
- **하드웨어 마이크(`getUserMedia`) 파이프라인 구현**:
  - 통화 시작 시 명시적 마이크 권한 획득 및 16kHz PCM 양방향 스트리밍 활성화.
  - 실시간 볼륨(RMS) 기반 Glowing Orb 발광 애니메이션 및 음성 파형 바 UI 추가.
- **다중 음성 인식 폴백 체계 구축**:
  - Native Audio WebSocket 스트리밍 + Web Speech API + VAD/MediaRecorder 기반 Gemini Transcribe 백업 연동.
- **사용자 편의성 향상**:
  - 통화 화면에 추천 대화 칩(Quick Prompts) 및 마이크 재시도 안내 버튼 추가.
- **서버 엔드포인트 고도화**:
  - `/api/gemini/transcribe` 신설 및 `/api/gemini/status` 모델 식별 정보 동기화.

---

### v1.0.0 (2026-09-29 KST) — 초기 런칭
- 영화 "HER" 감성의 AI 친구와 실시간 음성 통화를 나누는 풀스택 웹 앱 초기 릴리즈.
- Express 백엔드, React + Vite 프론트엔드, Glowing Orb 앰버 테마 구축.
