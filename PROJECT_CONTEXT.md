# 📖 프로젝트 컨텍스트 및 히스토리 (Project Context)

> **프로젝트**: One Call English (옛 이름: 「오늘도 한 통」) — AI 1:1 전화영어  
> **현재 버전**: `v2.8.0` | **최종 갱신**: 2026-10-19 (KST)  
> **기준 기획**: [`docs/plan/implementation_plan_v4.md`](./docs/plan/implementation_plan_v4.md) Part B · 진행 가이드 [`docs/plan/ai-studio-build-guide.md`](./docs/plan/ai-studio-build-guide.md) · 현재 앱과의 차이 [`docs/plan/gap-v2.1.0-vs-plan-v4.md`](./docs/plan/gap-v2.1.0-vs-plan-v4.md)  
> **관리 규칙**: `README.md` 변경 시 본 문서의 아키텍처 및 히스토리를 함께 최신화하며, 모든 일시는 한국 표준시(KST)를 기준으로 합니다.

---

## 0. Gemini API Key 런타임 동적 주입 및 검증 체계 (2026-10-14 KST)
- **더미 환경변수 방어 교체**: AI Studio 기본 컨테이너의 `MY_GEMINI_API_KEY` 더미 값을 감지하여, 유효한 키 탐색 시 `process.env.GEMINI_API_KEY` 및 `GOOGLE_API_KEY`, `GOOGLE_GENAI_API_KEY`를 즉시 실시간 동기화.
- **다중 시크릿 탐색**: `.dev.env.json`, `.env`, Secret Manager 볼륨 마운트(`/secrets`, `/etc/secrets` 등) 전수 스캔.
- **탐색 순서와 비용**: ① `process.env`(매 요청 확인) → ② 키 파일·`.env`·서버를 띄운 부모 프로세스들의 `/proc/<pid>/environ`(결과를 1분간 기억) → ③ 사용자가 설정에 저장한 키. `/proc`은 이 서버의 부모 프로세스만 보고, 관계없는 프로세스는 보지 않음(v2.8.0).
- **상태 엔드포인트**: `/api/gemini/status`는 로그인 없이 키를 찾았는지(`hasServerKey`)와 찾은 곳의 **종류**(`env`·`file`·`json`·`proc`·`firestore:user-settings`·`none`)만 보여 줌. 파일 경로와 키 값은 비노출(v2.8.0). 자세한 위치는 로그인이 필요한 `/api/gemini/key-refresh`와 서버 로그에서만 보임. 모델 라벨은 `models.ts`의 `LIVE_MODEL`을 그대로 표시.

---

## 1. Phase 3: B-9 3단계 코치 & 스케줄 자동화 아키텍처 (2026-10-14 KST)
- **데이터 모델**:
  - `users/{uid}/plan`: `{ weeklyPattern: { mon:[goalId], tue:..., ..., sun:[] }, minutesPerDay, updatedAt }`. 초기 진입 시 기존 4대 목표 루틴으로 자동 1회 초기화.
  - `users/{uid}/planChanges/{id}`: `{ requestedText, summary, before, after, status: proposed|approved|rejected|reverted, at, appliedAt? }`. before/after 스냅샷 격리.
  - `users/{uid}/coachMemory`: `{ constraints[], preferences[], weakPoints[], updatedAt }`. 항목별 삭제 지원.
  - `users/{uid}/coachMessages/{id}`: 대화 로그 및 제안 카드 ID 연동.
  - `goals/{goalId}.deadline`: OPIc 시험일 등 D-day 목표 기한 연동.
  - `settings.coachNudges`: `["weekly", "absence2d"]` 기본값.
- **스케줄 불변 안전망**:
  - **하루 빠짐 보존**: 통화 세션이 `status=done`이 아니면 다음 배정 요일에도 같은 `nextLessonIndex` 유지(건너뛰지 않음). 오직 통화 완료 및 복기 저장 시에만 `nextLessonIndex += 1`.
  - **OPIc 시험 1~2주 전 모의고사 자동 제안**: deadline 7~14일 전 구간에 실전 모의고사(14과)를 월·토 OPIc 슬롯에 배치하는 제안 카드 생성 (**승인 전 절대 반영 금지**).
  - **홈 「오늘 수업」**: `plan.weeklyPattern + goals.nextLessonIndex` 우선 계산.
- **코치 UI 및 LLM 통제**:
  - `CoachModal.tsx`: 채팅, 변경 카드 승인/거절, 변경 이력 되돌리기(`reverted`), 코치 메모리 개별 삭제. 코치 답장도 대화 기록에 저장됨(v2.8.0 전에는 제안 없는 답장이 저장되지 않았음).
  - `POST /api/coach/chat`: `gemini-3.8-flash` 기반 함수 호출(`propose_plan_change`, `get_progress`, `get_mistake_stats`). 적용하는 도구는 모델에게 아예 주지 않음(제안만 가능).
  - **제안 검사** (`src/data/planValidation.ts`, v2.8.0): 코치가 만든 변경은 카드로 보여 주기 전과 승인해 적용하기 전에 검사. 있는 목표·있는 과 번호·실제 날짜(YYYY-MM-DD)·요일별 목표 id 목록·하루 5~240분만 남기고 나머지는 버림. 남는 게 없으면 카드를 만들지 않음.
  - **승인·되돌리기** (v2.8.0): 승인하는 순간의 실제 값을 `before`로, 실제로 적용한 값을 `after`로 저장. 되돌리기는 그 변경이 바꾼 항목만 복원(그 사이 다른 트랙의 진도는 그대로). 변경 전에 시험일이 없었으면 시험일을 지움. 승인·되돌리기 뒤에는 홈의 목표 목록을 다시 불러옴.
- **먼저 말 걸기 (2일 결석 배너 & 일요일 주간 리뷰)**:
  - 2일 연속 결석 시 홈 상단에 "이틀째 쉬었어요. 오늘 수업만 해도 좋아요" 배너 노출.
  - 일요일 아침 강의 coachNote를 주간 리뷰 톤으로 자동 편성.

---

## 2. 프로젝트 비전 및 디자인
- **정체성**: 4개 특화 트랙(OPIc AL, 한화 필리 조선소 비즈니스, 미국·호주 여행, Bluey 호주 리스닝)의 일자별 커리큘럼에 맞춰 AI와 실시간 음성 통화를 나누고, 통화 종료 후 즉시 정밀 복기 리포트와 실수 노트를 자동 추출하며, 아침 출근길용 1:1 맞춤형 복습 오디오 강의까지 제공하는 완성형 AI 전화영어 애플리케이션.
- **디자인 무드**: 심야 서재의 차분한 다크 슬레이트 캔버스(`bg-[#0F141C]`), 정갈한 카드 서피스(`bg-[#161D2A]`), 웜 골드/앰버 액센트(`text-amber-400`), 모바일 반응형 터치 인터페이스.

---

## 3. 모델 인프라 구성 (Part B-1 확정 사양, 모델 이름은 `src/config/models.ts` 한 곳)
- **실시간 통화 (Live)**: `LIVE_MODEL = "gemini-3.8-live"`
- **통화 복기 & 퀴즈 채점·코치 (Text)**: `TEXT_MODEL = "gemini-3.8-flash"`
- **기록용 받아쓰기 & 퀴즈 음성 전사 (STT)**: `STT_ENGINE = "gemini"` (`gemini-3.5-transcribe`, 모드 `VERBATIM`) / 비실시간 대안 `universal-3-5-pro` (AssemblyAI)
- **오디오 합성 (TTS)**: `TTS_ENGINE = "gemini"` — 아침 강의 `GEMINI_TTS_MODEL = "gemini-3.8-flash-tts"`, 복기 화면 발음 듣기 `GEMINI_TTS_LITE_MODEL = "gemini-3.8-flash-lite-tts"` / 2인 대화 대안 ElevenLabs(미연결)
- **공급자 추상화 레이어 (`src/services/providers/`)**: `LiveProvider`, `SttProvider`, `LlmProvider`, `TtsProvider` 인터페이스 분리(`types.ts`). 브라우저에 구현된 것은 Live(`GeminiLiveProvider`)뿐이고, **통화마다 새 인스턴스**를 만듦(`createLiveProvider()`, v2.8.0). 같은 통화 안의 "다시 시도"는 같은 인스턴스를 써서 대화 기록·세션 재개 핸들을 이어 감. 받아쓰기·텍스트·음성 합성은 서버(`server.ts`, `server/lecture.ts`, `server/sttBench.ts`)에서 처리하며, 브라우저용 빈 뼈대 구현은 v2.8.0에서 삭제.

---

## 4. 핵심 자동화 아키텍처 (Part B-12 뼈대 & B-2 통화 & B-3 녹음 & B-4 복기 & B-5 간격반복 & B-6 퀴즈)
1. **B-6 퀴즈 파이프라인 (`QuizModal.tsx`, `/api/quiz/grade`, `/api/quiz/meaning-ko`, `db.ts`)**:
   - **퀴즈 대상 풀**: `getDueMistakes(today)` 기준 보류(`deferred`) 항목을 목록 맨 앞 배치, 1일 최대 10개 큐 구성.
   - **플래시카드 카드 앞면**: 한국어 뜻(`meaningKo`) + 이유(`reason`) 한 줄 힌트. 실수 문서에 뜻이 없으면 `gemini-3.8-flash`로 한 번 생성하여 `mistakes.meaningKo`에 저장 후 재사용.
   - **과거 오답 은닉**: 내가 과거에 했던 틀린 말(`myPhrase`)은 정답 확인 뒤에만 노출.
   - **응답 방식**: [말하기](`MediaRecorder` ➔ `gemini-3.5-transcribe` VERBATIM 전사 ➔ 인식 텍스트 그대로 표시 ➔ 채점) 또는 [타이핑]. 녹음 형식은 브라우저가 지원하는 것(webm/opus → webm → mp4 → ogg)을 자동 선택(아이폰 Safari 대응, v2.8.0). 권한 거부와 녹음 불가를 다른 안내로 보여 줌.
   - **채점 기준**: "핵심 교정 포인트(reason이 고친 부분)가 맞으면 통과." 사소한 철자/관사/구두점 차이 허용.
   - **상태 전이**: 통과 시 `graduateMistakeAfterQuiz`로 즉시 졸업, 실패 시 정답 및 과거 오답을 보여주고 오늘 퀴즈 맨 뒤에 1회 재도전 큐 추가.
   - **퀴즈 기록 영구 보존**: `users/{uid}/quizAttempts`에 저장.
   - **복기 AI 연동 확장**: `reviewPipeline.ts`에서 검토 대상 실수를 `reviewing` + `deferred`로 확장하여 보류 실수도 통화 중 맞게 발화 시 빠른 졸업(`usedCorrectly`)되도록 보장.
2. **B-5 간격 반복과 졸업 파이프라인 (`db.ts`, `reviewPipeline.ts`, `HomeScreen.tsx`)**:
   - **실수 간격 반복 모델**: `stage`(1일→3일→7일→14일), `status`(reviewing | graduated | deferred), `nextReviewAt`(KST YYYY-MM-DD). 신규 실수는 1일차 reviewing, nextReviewAt=내일로 시작.
   - **아침 강의 수강 기반 승급 (`advanceMistakeAfterLesson`)**: reviewing 상태에서 1→3→7→14일로 단계 승급 및 nextReviewAt 계산. 14일차 수강 후 퀴즈 미통과 시 `status = deferred`(보류) 전환.
   - **빠른 졸업 & 재복습 연동 (`applyCallMistakeUpdates`)**: 복기 생성 시 `usedCorrectly`에 매칭된 실수는 퀴즈 없이 즉시 `status = graduated`. `repeatedMistakes`에 매칭된 졸업 실수는 `status = reviewing`, 1일차, 내일로 강등 재학습.
   - **오늘 복습 대상 쿼리 (`getDueMistakes`)**: `status == 'deferred'`(목록 최우선 맨 앞) + `status == 'reviewing' && nextReviewAt <= 오늘`. 홈 화면에 "오늘 복습 N개" 숫자 표출.
   - **디버그 시뮬레이터**: 홈 화면에 "임시 디버그: 단계 진행" 패널 제공 (`[이 실수 강의 들었음 처리]` 버튼으로 1→3→7→14→deferred 단계 전진 수동 테스트 가능). 수동 졸업 버튼은 엄격 배제.
3. **B-4 통화 후 복기 파이프라인 (`reviewPipeline.ts`, `ReviewModal.tsx`, `/api/review`, `/api/gemini/transcribe-final`)**:
   - **기록용 최종 받아쓰기 (sttFinal)**: 세션 종료 시 10초 조각(각각 완결된 WebM)을 브라우저에서 PCM으로 풀어 1분 단위 16kHz WAV로 합친 뒤 분마다 `gemini-3.5-transcribe` VERBATIM 전사, 순서대로 이어 붙임(`src/services/recording/audioMerge.ts`). WebM 파일을 바이트로 이어 붙이면 앞부분만 읽히므로 쓰지 않음. 실패 시 `sttPartial` 합본으로 폴백하여 `sessions.sttFinal`에 저장.
   - **myPhrase 원문 보존 복기 생성**: `gemini-3.8-flash` 기반 오답 분석 시 "적당히 다듬어라"를 배제하고 sttFinal의 학습자 발화를 글자 그대로 복사하여 `mistakes[]`에 수록.
   - **5대 핵심 표현 & AI 등급**: 오늘 외울 표현 5개 추출, `estimatedLevel` 산출 및 "AI 예상치, 공식 등급 아님" 안내.
   - **오인식 신고 ("이건 내가 한 말이 아니에요")**: Firestore `qualityReports`에 기록하고, 저장된 실수 문서를 **삭제**해 퀴즈·아침 강의에 나오지 않게 함. 세션의 `review.mistakes[i].hidden = true`로 다시 열어도 숨김 유지(v2.8.0). 복기 결과의 각 실수에 `mistakes` 문서 id를 함께 저장하며, id가 없는 예전 복기는 "같은 통화 + 같은 문장"으로 찾아 지움.
   - **다시 복기해도 안전** (v2.8.0): 같은 통화를 다시 복기하면 이전 실행이 저장한 실수를 지우고 새 결과로 바꿈(중복 없음). 진도(`nextLessonIndex`)는 앞으로만 움직여서, 오래된 미완료 통화를 나중에 복기해도 진도가 뒤로 가지 않음. 복기가 끝나면 홈의 목표 목록을 다시 불러와 "오늘 수업"이 바로 다음 과로 바뀜.
   - **Keep 양식 복사**: `[내가 한 말] -> [자연스러운 표현]` 줄 단위 일괄 복사.
   - **미완료 통화 복기 연결**: 지시서 3의 "끝나지 않은 통화" 모달에서 "복기 시작" 클릭 시 즉시 복기 파이프라인 가동.
   - **mistakes 컬렉션 자동 저장**: stage 1, status reviewing, source call 메타데이터 저장.
   - **통화 마지막 말 포함** (v2.8.0): 통화 종료 시 녹음기가 마지막(10초 미만) 조각이 다 만들어질 때까지 기다린 뒤(최대 3초) 복기에 넘김.
4. **B-3 통화 중 녹음 & 끊김 대비 이중 안전망 (`chunkIndexedDb.ts`, `chunkRecorder.ts`, `NewCallScreen.tsx`)**:
   - **10초 마이크 청크 녹음**: `MediaRecorder`로 10초 조각 생성 -> IndexedDB(`OneCallRecordingsDB`)에 선저장 -> Cloud Storage 즉시 업로드 -> 성공 시 IndexedDB 삭제.
   - **연결 독립성 보장**: Live 연결이 끊기거나(GoAway, 소켓 재연결, 프록시 전환) 불안정해도 마이크 녹음은 중단 없이 독립 백그라운드 구동.
   - **1분 단위 임시 받아쓰기**: 약 1분(6조각)마다 WAV로 합쳐 비동기로 `gemini-3.5-transcribe` VERBATIM 전사 -> `sessions.sttPartial` 누적. 설정 → 모델 탭(개발자 모드에서 보임) 스위치로 끄고 켬(이 브라우저에 저장, v2.8.0부터 실제로 통화에 적용됨).
   - **조각 번호** (v2.8.0): 같은 통화에서 "다시 시도"로 녹음이 다시 시작돼도 조각 번호를 이어서 매김(복기에서 두 녹음이 섞이지 않음). 새 통화는 0부터.
   - **업로드 실패 시 기록** (v2.8.0): Firestore를 `ignoreUndefinedProperties`로 초기화(`src/services/firebase/config.ts`). 값이 없는 항목(업로드 실패한 조각의 `storageUrl` 등)은 빼고 저장해서, 조각 기록과 `lastChunkAt`이 거부되지 않음.
   - **Live 대화 로그 지속 저장 & 재개 실패 대비**: 통화 중 실시간으로 `sessions.liveTranscript`에 동기화. 세션 재개 실패 시 직전 대화 요약을 신규 세션 프롬프트에 자동 주입하여 문맥 보존.
   - **끊긴 통화 자동 처리**: 앱을 열 때 Firestore에서 `in-progress`·`pending_review` 통화만 읽어(v2.8.0 전에는 모든 통화를 읽었음), 마지막 조각(`lastChunkAt`) 이후 2분이 지난 통화를 `pending_review`("복기 대기")로 바꿈(`checkAndMarkInterruptedSessions`). **"끝나지 않은 통화가 있어요. 복기할까요?"** 모달 자동 노출. 서버 메모리의 감시 기능(`/api/sessions/heartbeat`, `/api/sessions/interrupted-check`)은 앱이 읽지 않아 v2.8.0에서 삭제.
   - **화면 꺼짐 방지 & 안내**: 통화 화면에 "통화 중에는 화면을 켜 두세요" 안내 배너 및 10초 녹음 카운터 표시, Screen Wake Lock API 자동 요청.
   - **스토리지 보관함 인스펙터**: 설정 모달 내 "녹음 보관함 (Storage Chunks)" 탭에서 실제 저장된 10초 오디오 파일 및 1분 전사본 목록 직접 확인.
5. **B-2 실시간 통화 엔진 (`geminiLiveProvider.ts`, `NewCallScreen.tsx`)**:
   - `gemini-3.8-live` 세션 재개(Session Resumption) 및 컨텍스트 창 압축(Sliding Window) 기본 탑재 (15분 이상 장시간 대화 유지).
   - GoAway 수신 및 네트워크 단절 시 자동 재연결(화면에 "연결 유지 중" 표시). 재연결이 5번 연속 실패하면 멈추고 오류 안내(하루 통화 시작 한도 보호).
   - 통화마다 새 Live 인스턴스(v2.8.0): 새로고침 없이 두 번째 통화를 걸어도 앞 통화의 대화 기록·세션 재개 핸들이 섞이지 않음.
   - **브라우저 직접 연결 최적화 (수정 지시서 2-1)**:
     - `BidiGenerateContentConstrained?access_token=${token}` 정식 주소 규격 및 `@google/genai` v1alpha 임시 토큰 발급 (`uses: 1`, `expireTime: +30m`, `newSessionExpireTime: +1m`).
     - Gemini의 `setupComplete` 수신 시에만 연결됨 판정 (8초 타임아웃 및 조기 종료 시 서버 프록시로 투명 전환).
     - 재연결 시 신규 토큰 발급 및 `resumeHandle` 지속 유지.
     - 연결 경로 콘솔 로깅(`[Live] path=direct` / `[Live] path=proxy`) 및 Firestore `sessions` 문서에 `connectionPath`, `directFailCount` 저장.
   - 오늘 수업 지시서 주입 (`src/data/lessonPromptBuilder.ts`): 목표, 과 내용, 복습 대상 실수 최대 3개.
   - 5대 제어 버튼: Done / Feedback / Model answer / Pause / Slow.
   - Live 자체 받아쓰기 실시간 화면 롤링 표시 및 `sessions.liveTranscript`에 보조 저장.
6. **Firebase 1인 전용 보안 및 클라우드 동기화**:
   - `episode.kim@gmail.com` 단일 계정 엄격 화이트리스트 검증 (`src/services/firebase/auth.ts`).
   - Firestore 엔티티 블루프린트(`firebase-blueprint.json`) 및 ABAC 보안 규칙(`firestore.rules`).
   - Cloud Storage(`src/services/firebase/storage.ts`) 연동.
7. **4대 목표 데이터 & 부록 원문 프롬프트 보존 (`src/data/defaultGoals.ts`)**:
   - OPIc AL (14과), 필리조선소 주재원 (15과), 미국·호주 여행 (13과), Bluey 듣기 (12과).
   - 마스터 체크리스트 부록 튜터 프롬프트 원문 100% 무삭제 보존.
   - 요일별 집중 루틴: 월·토 OPIc, 화·목 Philly, 수 Bluey, 금 여행, 일 주간 복기.
8. **프롬프트 슬롯 커스터마이징 (`src/data/promptCustomizer.ts`)**:
   - `[직무]`, `[Survey topics I chose]`, `[My role in Philly]`, `[Recent weak points]`를 설정 모달에서 사용자가 직접 입력 및 저장(`users/{uid}` 프로필).
   - 최근 취약점은 OPIc·필리·여행 3개를 따로 저장(`opicWeakPoints`, `phillyWeakPoints`, `travelWeakPoints`, v2.8.0 전에는 저장되지 않았음). 필리와 여행 원문 프롬프트가 같은 자리 표시(`[복기 프롬프트 결과 3줄 또는 "none yet"]`)를 써서, `hydrateTutorPrompt(prompt, placeholders, goalId)`가 트랙에 맞는 값을 넣음(예전엔 여행에도 필리 값이 들어갔음).
9. **첫 실행 진도 설정 & 오늘 수업 카드 UI (`src/ui/onboarding/`, `src/ui/home/`)**:
   - 첫 실행 시 OPIc 10/10 1과, 10/11 2과, 10/12 3과 히스토리를 반영한 진도 설정 모달 제공.
   - 홈 화면 요일별 루틴 뱃지, 오늘 요일에 해당하는 수업 카드 및 즉시 통화 시작 버튼.

---
10. **B-7 아침 강의 · B-8 그록봇 피드 (`server/lecture.ts`, `server/feed.ts`, `src/ui/lecture/`)**:
   - 새 실수 최대 6개 + 복습 실수 최대 3개로 `gemini-3.8-flash` 대본 → `gemini-3.8-flash-tts` 2인 음성, 답 전 3초 무음, WAV 1개. 앱에서 재생·오프라인 보관.
   - 그록봇은 `/feed/{비밀키}/today(.json)`만 열면 됨. 앱이 홈 화면을 열 때마다 비밀키·후보 실수를 서버에 다시 보냄(`syncFeed`). 강의가 없으면 피드 요청 때 생성 시작, 실패한 강의는 30분에 한 번만 다시 시도.
   - **한계**: 강의 음성·피드 설정은 서버의 `.data/` 폴더에 저장되어, Cloud Run 서버가 다시 켜지면 지워질 수 있음.
   - **만들던 중 서버가 다시 켜진 강의** (v2.8.0): 서버 기록이 "생성 중"인데 실제 작업이 없으면 `failed`/`INTERRUPTED`로 알려 줌. 서버 기록 자체가 지워졌으면 앱이 Firestore의 "생성 중"을 같은 상태로 바꿈. 홈 카드는 "서버가 다시 시작되어 만들던 강의가 멈췄어요"와 **오늘 강의 만들기** 버튼을 보여 주고, 그록봇 피드는 30분 기다리지 않고 바로 다시 만듦.
11. **B-10 Keep 가져오기 · 사용량 · 1-F 받아쓰기 품질 시험**:
   - Keep "English mistake log" 붙여넣기 → `gemini-3.8-flash`로 [내가 한 말/자연스러운 표현/이유] 미리보기 → 저장(1일 단계부터).
   - 통화 분·받아쓰기 분·토큰·TTS 글자 수 기록, 설정에 이번 달 예상 비용(단가표 `models.ts` `PRICING_RATES`, 기획 v4 단가와 재확인 필요).
   - 품질 시험(개발자 메뉴): 같은 녹음을 Live 자체 받아쓰기 / `gemini-3.5-transcribe` / AssemblyAI로 비교.
12. **서버 보안·한도 (`server/auth.ts`, `server/rateLimit.ts`)**:
   - 비용이 드는 모든 `/api`와 Live WebSocket(`?token=`)에 Firebase ID 토큰 필수, 허용 이메일 1개. 앱이 보낸 Gemini 키는 받지 않음. 서버 녹음은 사용자별 폴더, `../` 경로 차단. 통화 상태 확인 API도 로그인한 사용자 것만 다룸.
   - 1인당 1분 60회·하루 1,500회 Gemini 호출, 하루 60번 통화 시작(서버 메모리, 재시작 시 초기화).
   - 녹음 파일 경로 검사는 `server/recordingPath.ts`(사용자 폴더 밖으로 나가는 `../` 경로 거부).
   - `NODE_ENV`가 없는 배포 서버에 개발 도구(Vite)가 없으면, 죽지 않고 빌드된 `dist/`를 내보냄(v2.8.0).

13. **테스트·빌드 (v2.8.0)**:
   - `npm test`: Node 내장 테스트(`node:test`) + `tsx`, `tests/*.test.ts` 17개. 코치 제안 검사, 트랙별 취약점 치환, 복습 실수 3개 제한, 서버 재시작 강의 상태, 2인 음성 조각, 피드 비밀키 형식, 1분 호출 한도, 녹음 경로 차단, 잘못된 로그인 토큰 거부, 1분 묶음, KST 날짜 계산, 비용 계산, 녹음기(마지막 조각 포함·재시작 번호). 녹음기 테스트는 저장 함수를 가짜로 바꿔 끼워 실제 Firebase에 접속하지 않음(`ChunkRecorder` 생성자의 `deps`).
   - CI(`.github/workflows/ci.yml`): 설치 → 앱 타입 검사 → 서버·테스트 타입 검사(`tsconfig.server.json`이 `tests/`도 포함) → 빌드 → `npm test`.
   - 빌드는 라이브러리를 `firebase`·`react`·`icons`·`vendor` 파일로 나눔(`vite.config.ts`). Firebase SDK 자체가 약 590KB(압축 140KB)라 경고 기준을 700KB로 둠.
   - `npm audit`의 high 4건은 Firebase가 쓰는 `@grpc/grpc-js`(서버용 통신 라이브러리)에서 나옴. 브라우저 앱에서는 쓰이지 않는 부분으로 보고 그대로 둠(추정). 고치려면 Firebase 큰 버전 업그레이드가 필요.

---

## 5. 버전 히스토리
- **v2.8.0 (2026-10-19 KST)**: [전체 코드 리뷰 반영] 통화마다 새 Live 인스턴스(앞 통화 섞임 해결), 통화 마지막 말 복기 포함, "다시 시도" 시 녹음 번호 이어 가기, Firestore `ignoreUndefinedProperties`(코치 답장·업로드 실패 조각 기록 저장), 복기·코치 승인 뒤 목표 다시 불러오기, 코치 되돌리기는 바꾼 항목만, 오인식 신고 시 실수 삭제, 서버 재시작으로 멈춘 강의 복구, 다시 복기해도 중복·진도 후퇴 없음, 1분 받아쓰기 스위치 연결, 퀴즈 녹음 형식 자동 선택, 취약점 3개 저장(여행 치환 수정), 코치 제안 검사, 키 탐색 1분 캐시·부모 프로세스만, 상태 API 경로 비노출, 미완료 통화만 읽기, 안 쓰는 코드 삭제, 빌드 파일 나누기, 자동 테스트 17개. 상세: [`docs/reviews/2026-10-full-code-review.md`](./docs/reviews/2026-10-full-code-review.md).
- **v2.7.8 (2026-10-15 KST)**: [오디오 404] `.data/` 아래 파일을 `sendFile`이 거부하던 문제 수정(`dotfiles: 'allow'`). 강의·피드·녹음 오디오 재생.
- **v2.7.7 (2026-10-14 KST)**: [블루이 피드백] 아침 강의 2인 음성 요청 형식 수정(speechMetadata.speaker), 통화 지시문에 앱 통화 규칙(짧게 말하기·같은 목소리·오늘 과만·마무리 인사) 추가, 복기 화면에 "통화 후 할 일"과 자동 저장 안내, Keep 복사는 선택 항목.
- **v2.7.6 (2026-10-14 KST)**: [통화 소리] 튜터 목소리를 `<audio>` 요소(MediaStream)로 재생해 휴대폰 볼륨 버튼·이어폰 경로를 따르게 함. iOS는 audioSession을 play-and-record로. 통화 중 이어폰 연결 시 마이크 자동 전환(녹음은 끊기지 않음).
- **v2.7.5 (2026-10-14 KST)**: [버그] 설정 버튼을 눌러도 화면이 안 뜨던 문제(`SettingsModal`의 훅 순서) 수정.
- **v2.7.4 (2026-10-14 KST)**: [키 우회] AI Studio Publish 서버에 Secrets 키가 전달되지 않는 문제 우회. 설정 → Gemini 키에서 저장한 키(내 Firestore `users/{uid}/private/gemini`)를 서버가 사용자 토큰으로 읽어 메모리에만 보관. 배포 환경 키가 있으면 그쪽 우선.
- **v2.7.3 (2026-10-14 KST)**: [검수 반영] CI 잠금 파일(`package-lock.json`) 다시 생성, 녹음 조각을 WAV로 합쳐 받아쓰기(바이트 이어 붙이기로 음성이 빠지던 문제), 재연결 5번 실패 시 중단, 실패한 강의의 피드 재시도 30분 간격, 모델 이름을 서버도 `models.ts`에서 읽기, 통화 상태 API 사용자 고정, Live 기본 지시문 영어 튜터로, 앱 이름 One Call English, 문서 정리.
- **v2.7.2 (2026-10-14 KST)**: Gemini 키 탐색 경로 확장(`/secrets` 등), 상태 라벨 갱신.
- **v2.7.0 (2026-10-14 KST)**: [B-9] 3단계 텍스트 코치, 계획 변경 제안·승인·되돌리기, 하루 빠짐 보존, 2일 결석 배너.
- **v2.6.1 (2026-10-14 KST)**: Live "연결 준비 중" 무한 대기 수정(마이크와 연결 분리, 서버 연결 시간 제한).
- **2026-10-13~14 KST (englead)**: 화면 개선(UX 1~8), 모든 비용 API 로그인 필수, 1인당 한도, 서버 키만 사용, 예전 코드(통화 엔진·텔레그램·팟캐스트·Mistake Vault) 삭제, GitHub Actions CI 추가.
- **v2.6.0 (2026-10-13 KST)**: [B-6] 퀴즈. · **B-7/B-8/B-10/1-F**: 아침 강의, 그록봇 피드, Keep 가져오기·사용량, 받아쓰기 품질 시험.
- **v2.5.0 (2026-10-13 KST)**: [B-5] 간격 반복과 졸업.
- **v2.4.0 (2026-10-13 KST)**: [B-4] 통화 후 복기(기록용).
- **v2.3.0 (2026-10-13 KST)**: [Phase 1: B-3 통화 중 녹음 (끊김 대비) 완성] 10초 단위 마이크 청크 녹음(IndexedDB 선저장 -> Cloud Storage 업로드), Live 연결 상태와 무관한 독립 녹음, 1분 단위 gemini-3.5-transcribe VERBATIM 비동기 전사(sessions.sttPartial), Live 세션 재개 실패 시 직전 대화 요약 프롬프트 자동 주입, 끊긴 통화 자동 처리(마지막 조각 2분 경과 시 pending_review 자동 전환) 및 "끝나지 않은 통화가 있어요. 복기할까요?" 복구 모달, 화면 꺼짐 방지(Screen Wake Lock & 안내 배너), 설정 모달 내 녹음 보관함(Storage Chunks) 인스펙터 탑재.
- **v2.2.1 (2026-10-13 KST)**: [수정 지시서 2-1: 브라우저 직접 연결 최적화] BidiGenerateContentConstrained?access_token=${token} 정식 규격, v1alpha 임시 토큰(uses:1, expire:30m, newSessionExpire:1m), setupComplete 수신 기반 엄격한 연결 판정, GoAway 신규 토큰 발급 및 handle 유지, connectionPath / directFailCount 텔레메트리.
- **v2.2.0 (2026-10-13 KST)**: [Phase 1: B-2 실시간 통화(대화용) 완성] gemini-3.8-live 세션 재개 & 컨텍스트 압축, GoAway 자동 재연결(연결 유지 중), 임시 토큰 직결 및 서버 프록시 2중화, 오늘 수업 지시서(목표·과·복습실수 3개) 주입, 5대 제어 버튼(Done/Feedback/Model/Pause/Slow), Live 자체 받아쓰기 sessions.liveTranscript 저장, NewCallScreen UI 탑재.
- **v2.1.0 (2026-10-13 KST)**: [Phase 1: 1단계 뼈대 구축 완료] Firebase 단일 계정(episode.kim@gmail.com) 인증, Firestore/Cloud Storage 연동, Part B-1 models.ts 및 Provider 인터페이스 뼈대, 4대 목표 부록 원문 프롬프트 영구 저장, 첫 실행 진도 입력 모달, 오늘 수업 카드 UI 완성.
- **v2.0.0 (2026-10-13 KST)**: AI 1:1 전화영어 올인원 랩 전면 개편. 4대 집중 트랙 및 10/10~1/9 일자별 스케줄러 엔진, 통화 종료 후 정밀 복기 리포트, Mistake Vault, 아침 7시 맞춤형 복습 팟캐스트 및 텔레그램 연동 (텔레그램·팟캐스트·Mistake Vault는 2026-10-14에 삭제).
- **v1.2.2**: 한국어 귀 고정 (Korean Ear Lock), 점진적 폴백 체계.
- **v1.2.1**: P4 오디오 관측 인스펙터 탑재, 2초 16kHz WAV 원음 검증기.
- **v1.2.0**: Grok 검수 수용, 단일 오디오 소스(Single Ear) 아키텍처 개편.
- **v1.1.0**: Gemini 2.5 Flash Native Audio 정식 연동.
- **v1.0.0**: 풀스택 음성 통화 웹앱 초기 릴리즈.
