# 📜 전체 변경 이력 상세 기록 (Changelog Archive)

> **일시 표기 기준**: 모든 버전 릴리즈 및 작업 일시는 **한국 표준시 (KST, UTC+9)** 기준으로 기록됩니다.

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
