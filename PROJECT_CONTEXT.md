# 📖 프로젝트 컨텍스트 및 히스토리 (Project Context)

> **프로젝트**: 「오늘도 한 통」 (One Call English) — AI 1:1 전화영어 올인원 랩  
> **현재 버전**: `v2.7.2` | **공식 빌드 버전**: `20261014-multilingual-1522` | **최종 갱신**: 2026-10-14 (KST)  
> **관리 규칙**: `README.md` 변경 시 본 문서의 아키텍처 및 히스토리를 함께 최신화하며, 모든 일시는 한국 표준시(KST)를 기준으로 합니다.

---

## 0. Gemini API Key 런타임 동적 주입 및 검증 체계 (2026-10-14 KST)
- **더미 환경변수 방어 교체**: AI Studio 기본 컨테이너의 `MY_GEMINI_API_KEY` 더미 값을 감지하여, 유효한 키 탐색 시 `process.env.GEMINI_API_KEY` 및 `GOOGLE_API_KEY`, `GOOGLE_GENAI_API_KEY`를 즉시 실시간 동기화.
- **다중 시크릿 탐색**: `.dev.env.json`, `.env`, Secret Manager 볼륨 마운트(`/secrets`, `/etc/secrets` 등) 전수 스캔.
- **상태 엔드포인트 정합성**: `/api/gemini/status`의 모델 라벨을 최신 `Gemini 3.8 Live Native Audio Dialog`로 동기화.

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
  - `CoachModal.tsx`: 채팅, 변경 카드 승인/거절, 변경 이력 되돌리기(`reverted`), 코치 메모리 개별 삭제.
  - `POST /api/coach/chat`: `gemini-3.8-flash` 기반 함수 호출(`propose_plan_change`, `get_progress`, `get_mistake_stats`). 모델이 `apply`를 직접 호출하면 400 반환 차단.
- **먼저 말 걸기 (2일 결석 배너 & 일요일 주간 리뷰)**:
  - 2일 연속 결석 시 홈 상단에 "이틀째 쉬었어요. 오늘 수업만 해도 좋아요" 배너 노출.
  - 일요일 아침 강의 coachNote를 주간 리뷰 톤으로 자동 편성.

---

## 1. 프로젝트 비전 및 디자인
- **정체성**: 4개 특화 트랙(OPIc AL, 한화 필리 조선소 비즈니스, 미국·호주 여행, Bluey 호주 리스닝)의 일자별 커리큘럼에 맞춰 AI와 실시간 음성 통화를 나누고, 통화 종료 후 즉시 정밀 복기 리포트와 실수 노트를 자동 추출하며, 아침 출근길용 1:1 맞춤형 복습 오디오 강의까지 제공하는 완성형 AI 전화영어 애플리케이션.
- **디자인 무드**: 심야 서재의 차분한 다크 슬레이트 캔버스(`bg-[#0F141C]`), 정갈한 카드 서피스(`bg-[#161D2A]`), 웜 골드/앰버 액센트(`text-amber-400`), 모바일 반응형 터치 인터페이스.

---

## 2. 모델 인프라 구성 (Part B-1 ~ B-6 확정 사양)
- **실시간 통화 (Live)**: `LIVE_MODEL = "gemini-3.8-live"`
- **통화 복기 & 퀴즈 채점·코치 (Text)**: `TEXT_MODEL = "gemini-3.8-flash"`
- **기록용 받아쓰기 & 퀴즈 음성 전사 (STT)**: `STT_ENGINE = "gemini"` (`gemini-3.5-transcribe`, 모드 `VERBATIM`) / 비실시간 대안 `universal-3-5-pro` (AssemblyAI)
- **오디오 합성 (TTS)**: `TTS_ENGINE = "gemini"` (`gemini-3.8-flash-tts` / `gemini-3.8-flash-lite-tts`) / 2인 대화 대안 ElevenLabs
- **공급자 추상화 레이어 (`src/services/providers/`)**: `LiveProvider`, `SttProvider`, `LlmProvider`, `TtsProvider` 인터페이스 분리.

---

## 3. 핵심 자동화 아키텍처 (Part B-12 뼈대 & B-2 통화 & B-3 녹음 & B-4 복기 & B-5 간격반복 & B-6 퀴즈)
1. **B-6 퀴즈 파이프라인 (`QuizModal.tsx`, `/api/quiz/grade`, `/api/quiz/meaning-ko`, `db.ts`)**:
   - **퀴즈 대상 풀**: `getDueMistakes(today)` 기준 보류(`deferred`) 항목을 목록 맨 앞 배치, 1일 최대 10개 큐 구성.
   - **플래시카드 카드 앞면**: 한국어 뜻(`meaningKo`) + 이유(`reason`) 한 줄 힌트. 실수 문서에 뜻이 없으면 `gemini-3.8-flash`로 한 번 생성하여 `mistakes.meaningKo`에 저장 후 재사용.
   - **과거 오답 은닉**: 내가 과거에 했던 틀린 말(`myPhrase`)은 정답 확인 뒤에만 노출.
   - **응답 방식**: [말하기](`MediaRecorder` ➔ `gemini-3.5-transcribe` VERBATIM 전사 ➔ 인식 텍스트 그대로 표시 ➔ 채점) 또는 [타이핑].
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
2. **B-4 통화 후 복기 파이프라인 (`reviewPipeline.ts`, `ReviewModal.tsx`, `/api/review`, `/api/gemini/transcribe-final`)**:
   - **기록용 최종 받아쓰기 (sttFinal)**: 세션 종료 시 10초 조각들을 합쳐 `gemini-3.5-transcribe` VERBATIM 전사. 실패 시 `sttPartial` 합본으로 폴백하여 `sessions.sttFinal`에 저장.
   - **myPhrase 원문 보존 복기 생성**: `gemini-3.8-flash` 기반 오답 분석 시 "적당히 다듬어라"를 배제하고 sttFinal의 학습자 발화를 글자 그대로 복사하여 `mistakes[]`에 수록.
   - **5대 핵심 표현 & AI 등급**: 오늘 외울 표현 5개 추출, `estimatedLevel` 산출 및 "AI 예상치, 공식 등급 아님" 안내.
   - **오인식 신고 ("이건 내가 한 말이 아니에요")**: 해당 실수 숨김 처리 및 Firestore `qualityReports` 컬렉션에 자동 저장.
   - **Keep 양식 복사**: `[내가 한 말] -> [자연스러운 표현]` 줄 단위 일괄 복사.
   - **미완료 통화 복기 연결**: 지시서 3의 "끝나지 않은 통화" 모달에서 "복기 시작" 클릭 시 즉시 복기 파이프라인 가동.
   - **mistakes 컬렉션 자동 저장**: stage 1, status reviewing, source call 메타데이터 저장.
2. **B-3 통화 중 녹음 & 끊김 대비 이중 안전망 (`chunkIndexedDb.ts`, `chunkRecorder.ts`, `NewCallScreen.tsx`)**:
   - **10초 마이크 청크 녹음**: `MediaRecorder`로 10초 조각 생성 -> IndexedDB(`OneCallRecordingsDB`)에 선저장 -> Cloud Storage 즉시 업로드 -> 성공 시 IndexedDB 삭제.
   - **연결 독립성 보장**: Live 연결이 끊기거나(GoAway, 소켓 재연결, 프록시 전환) 불안정해도 마이크 녹음은 중단 없이 독립 백그라운드 구동.
   - **1분 단위 임시 받아쓰기**: 약 1분(6조각)마다 비동기로 `gemini-3.5-transcribe` VERBATIM 전사 -> `sessions.sttPartial` 누적. 환경설정에서 토글 가능.
   - **Live 대화 로그 지속 저장 & 재개 실패 대비**: 통화 중 실시간으로 `sessions.liveTranscript`에 동기화. 세션 재개 실패 시 직전 대화 요약을 신규 세션 프롬프트에 자동 주입하여 문맥 보존.
   - **끊긴 통화 자동 처리**: 마지막 조각 이후 2분 이상 인입 없으면 `pending_review`("복기 대기")로 자동 전환. 앱 재오픈 시 **"끝나지 않은 통화가 있어요. 복기할까요?"** 모달 자동 노출.
   - **화면 꺼짐 방지 & 안내**: 통화 화면에 "통화 중에는 화면을 켜 두세요" 안내 배너 및 10초 녹음 카운터 표시, Screen Wake Lock API 자동 요청.
   - **스토리지 보관함 인스펙터**: 설정 모달 내 "녹음 보관함 (Storage Chunks)" 탭에서 실제 저장된 10초 오디오 파일 및 1분 전사본 목록 직접 확인.
2. **B-2 실시간 통화 엔진 (`geminiLiveProvider.ts`, `NewCallScreen.tsx`)**:
   - `gemini-3.8-live` 세션 재개(Session Resumption) 및 컨텍스트 창 압축(Sliding Window) 기본 탑재 (15분 이상 장시간 대화 유지).
   - GoAway 수신 및 네트워크 단절 시 자동 재연결(화면에 "연결 유지 중" 표시).
   - **브라우저 직접 연결 최적화 (수정 지시서 2-1)**:
     - `BidiGenerateContentConstrained?access_token=${token}` 정식 주소 규격 및 `@google/genai` v1alpha 임시 토큰 발급 (`uses: 1`, `expireTime: +30m`, `newSessionExpireTime: +1m`).
     - Gemini의 `setupComplete` 수신 시에만 연결됨 판정 (8초 타임아웃 및 조기 종료 시 서버 프록시로 투명 전환).
     - 재연결 시 신규 토큰 발급 및 `resumeHandle` 지속 유지.
     - 연결 경로 콘솔 로깅(`[Live] path=direct` / `[Live] path=proxy`) 및 Firestore `sessions` 문서에 `connectionPath`, `directFailCount` 저장.
   - 오늘 수업 지시서 주입 (`src/data/lessonPromptBuilder.ts`): 목표, 과 내용, 복습 대상 실수 최대 3개.
   - 5대 제어 버튼: Done / Feedback / Model answer / Pause / Slow.
   - Live 자체 받아쓰기 실시간 화면 롤링 표시 및 `sessions.liveTranscript`에 보조 저장.
2. **Firebase 1인 전용 보안 및 클라우드 동기화**:
   - `episode.kim@gmail.com` 단일 계정 엄격 화이트리스트 검증 (`src/services/firebase/auth.ts`).
   - Firestore 엔티티 블루프린트(`firebase-blueprint.json`) 및 ABAC 보안 규칙(`firestore.rules`).
   - Cloud Storage(`src/services/firebase/storage.ts`) 연동.
3. **4대 목표 데이터 & 부록 원문 프롬프트 보존 (`src/data/defaultGoals.ts`)**:
   - OPIc AL (14과), 필리조선소 주재원 (15과), 미국·호주 여행 (13과), Bluey 듣기 (12과).
   - 마스터 체크리스트 부록 튜터 프롬프트 원문 100% 무삭제 보존.
   - 요일별 집중 루틴: 월·토 OPIc, 화·목 Philly, 수 Bluey, 금 여행, 일 주간 복기.
4. **프롬프트 슬롯 커스터마이징 (`src/data/promptCustomizer.ts`)**:
   - `[직무]`, `[Survey topics I chose]`, `[My role in Philly]`, `[Recent weak points]`를 설정 모달에서 사용자가 직접 입력 및 저장.
5. **첫 실행 진도 설정 & 오늘 수업 카드 UI (`src/ui/onboarding/`, `src/ui/home/`)**:
   - 첫 실행 시 OPIc 10/10 1과, 10/11 2과, 10/12 3과 히스토리를 반영한 진도 설정 모달 제공.
   - 홈 화면 요일별 루틴 뱃지, 오늘 요일에 해당하는 수업 카드 및 즉시 통화 시작 버튼.

---

## 4. 버전 히스토리
- **v2.3.0 (2026-10-13 KST)**: [Phase 1: B-3 통화 중 녹음 (끊김 대비) 완성] 10초 단위 마이크 청크 녹음(IndexedDB 선저장 -> Cloud Storage 업로드), Live 연결 상태와 무관한 독립 녹음, 1분 단위 gemini-3.5-transcribe VERBATIM 비동기 전사(sessions.sttPartial), Live 세션 재개 실패 시 직전 대화 요약 프롬프트 자동 주입, 끊긴 통화 자동 처리(마지막 조각 2분 경과 시 pending_review 자동 전환) 및 "끝나지 않은 통화가 있어요. 복기할까요?" 복구 모달, 화면 꺼짐 방지(Screen Wake Lock & 안내 배너), 설정 모달 내 녹음 보관함(Storage Chunks) 인스펙터 탑재.
- **v2.2.1 (2026-10-13 KST)**: [수정 지시서 2-1: 브라우저 직접 연결 최적화] BidiGenerateContentConstrained?access_token=${token} 정식 규격, v1alpha 임시 토큰(uses:1, expire:30m, newSessionExpire:1m), setupComplete 수신 기반 엄격한 연결 판정, GoAway 신규 토큰 발급 및 handle 유지, connectionPath / directFailCount 텔레메트리.
- **v2.2.0 (2026-10-13 KST)**: [Phase 1: B-2 실시간 통화(대화용) 완성] gemini-3.8-live 세션 재개 & 컨텍스트 압축, GoAway 자동 재연결(연결 유지 중), 임시 토큰 직결 및 서버 프록시 2중화, 오늘 수업 지시서(목표·과·복습실수 3개) 주입, 5대 제어 버튼(Done/Feedback/Model/Pause/Slow), Live 자체 받아쓰기 sessions.liveTranscript 저장, NewCallScreen UI 탑재.
- **v2.1.0 (2026-10-13 KST)**: [Phase 1: 1단계 뼈대 구축 완료] Firebase 단일 계정(episode.kim@gmail.com) 인증, Firestore/Cloud Storage 연동, Part B-1 models.ts 및 Provider 인터페이스 뼈대, 4대 목표 부록 원문 프롬프트 영구 저장, 첫 실행 진도 입력 모달, 오늘 수업 카드 UI 완성.
- **v2.0.0 (2026-10-13 KST)**: AI 1:1 전화영어 올인원 랩 전면 개편. 4대 집중 트랙 및 10/10~1/9 일자별 스케줄러 엔진, 통화 종료 후 정밀 복기 리포트, Mistake Vault, 아침 7시 맞춤형 복습 팟캐스트 및 텔레그램 연동.
- **v2.0.0 (2026-10-13 KST)**: AI 1:1 전화영어 올인원 랩 전면 개편. 4대 집중 트랙 및 10/10~1/9 일자별 스케줄러 엔진, 통화 종료 후 정밀 복기 리포트, Mistake Vault, 아침 7시 맞춤형 복습 팟캐스트 및 텔레그램 연동.
- **v1.2.2**: 한국어 귀 고정 (Korean Ear Lock), 점진적 폴백 체계.
- **v1.2.1**: P4 오디오 관측 인스펙터 탑재, 2초 16kHz WAV 원음 검증기.
- **v1.2.0**: Grok 검수 수용, 단일 오디오 소스(Single Ear) 아키텍처 개편.
- **v1.1.0**: Gemini 2.5 Flash Native Audio 정식 연동.
- **v1.0.0**: 풀스택 음성 통화 웹앱 초기 릴리즈.
