# 오늘도 한 통 (One Call English) — AI 1:1 전화영어 올인원 랩

> **버전**: `v2.6.0` | **빌드**: `20261013-multilingual-1652` | **최종 갱신**: 2026-10-13 (KST)
>
> **기준 기획 (2026-10-13~)**: [`docs/plan/implementation_plan_v4.md`](./docs/plan/implementation_plan_v4.md) Part B · 진행 가이드 [`docs/plan/ai-studio-build-guide.md`](./docs/plan/ai-studio-build-guide.md) · 현재 앱과의 차이 [`docs/plan/gap-v2.1.0-vs-plan-v4.md`](./docs/plan/gap-v2.1.0-vs-plan-v4.md)  
> 아래 기능 중 텔레그램 발송과 예전 아침 팟캐스트는 v2.0.0 때 예전 기획으로 만든 것이며 정리될 예정입니다(차이표 참고).

여러 도구(Claude, Gemini Live, Google Keep, Grok, ElevenLabs, Telegram)로 분산되어 있던 실전 영어회화 학습 파이프라인을 **단 하나의 통합 웹/모바일 앱에서 원클릭으로 완벽하게 자동화**한 AI 1:1 전화영어 플랫폼입니다.

### 📌 [Phase 2: B-6 퀴즈 (2-B) 완성]
- **퀴즈 대상 산출 (최대 10개)**:
  - `getDueMistakes(today)` 결과를 그대로 사용하여 보류(`deferred`) 실수가 목록 최우선 맨 앞에 정렬.
  - 홈 화면의 "오늘 복습 N개" 옆에 **"오늘 퀴즈 N개"** 카운터(`N = min(대상 수, 10)`) 및 **"퀴즈 풀기"** 버튼 배치.
- **카드형 플래시카드 & 즉시 피드백 (`QuizModal`)**:
  - **카드 앞면**: 원어민 표현의 한국어 뜻(`meaningKo`) + 교정 이유(`reason`) 한 줄 힌트 노출.
  - **한국어 뜻 자동 생성 & 영구 보존**: 실수 문서에 `meaningKo`가 없으면 퀴즈 시작 시 `gemini-3.8-flash`(`/api/quiz/meaning-ko`)로 한 번 번역하여 Firestore `mistakes.meaningKo`에 저장 후 영구 재사용.
  - **오답 은닉 원칙**: 내가 과거 통화에서 했던 오답(`myPhrase`)은 **정답 확인 뒤에만 노출**하여 힌트 노출 및 기억 왜곡 원천 차단.
- **2가지 응답 방식 (말하기 vs 타이핑)**:
  - **말하기**: 마이크 녹음 ➔ `gemini-3.5-transcribe` **VERBATIM** 모드로 전사(`/api/gemini/transcribe-final`) ➔ 인식된 문장을 화면에 그대로 보여준 뒤 채점.
  - **타이핑**: 텍스트 입력창에 작성한 문장 그대로 채점.
- **엄격한 채점 엔진 (`gemini-3.8-flash`, `/api/quiz/grade`)**:
  - 채점 규칙: **"핵심 교정 포인트(reason이 고친 부분)가 맞으면 통과."** 사소한 철자(typo), 관사(a/an/the), 구두점, 대소문자 차이는 허용.
  - 응답 JSON Schema 강제: `{ passed: boolean, feedback: string(한국어 1~2문장), correctAnswer: string }`.
- **결과 반영 & 1회 재도전 큐**:
  - **통과 시**: `graduateMistakeAfterQuiz(mistakeId)` 자동 호출 (`status = graduated`, "졸업!" 축하 배지 표시).
  - **실패 시**: 정답(`correctAnswer`), 이유(`reason`), 과거 오답(`myPhrase`)을 즉시 표시하고, 해당 문항을 오늘 퀴즈 **맨 뒤에 1회 재도전 문항으로 다시 추가**. 재시도도 틀리면 상태를 유지하고 통과.
  - **퀴즈 기록 저장**: `users/{uid}/quizAttempts` 서브컬렉션에 `{ mistakeId, mode, answer, passed, feedback, createdAt }` 영구 저장.
- **B-5 연동 보완 (Requirement 5)**:
  - 복기 파이프라인(`reviewPipeline.ts`)이 복기 AI에 전달하는 복습 대상 목록을 `status == 'reviewing'` 뿐만 아니라 **`reviewing` + `deferred`**로 확장하여, 보류 상태의 실수도 통화 중 자연스럽게 사용하면 빠른 졸업(`usedCorrectly`)되도록 연동.
- **규정 준수**: 수동 졸업 버튼 배제, 아침 강의(B-7) 미연결 시 홈 진입만 제공, 말해보카 등 상표 및 문제 복제 금지.

### 📌 [Phase 2: B-5 간격 반복과 졸업 (2-A) 완성]
- **실수 간격 반복 모델 (mistakes 컬렉션)**:
  - `stage`: 1일 → 3일 → 7일 → 14일 (일수 단계 관리).
  - `status`: `reviewing` (복습 중) | `graduated` (졸업) | `deferred` (보류).
  - `nextReviewAt`: KST 기준 다음 복습일자 (`YYYY-MM-DD`).
  - 신규 등록 실수(복기 결과)는 기본 `stage=1일`, `status=reviewing`, `nextReviewAt=내일(KST+1일)`로 시작.
- **아침 강의 수강 기반 단계 진행 (`advanceMistakeAfterLesson`)**:
  - `reviewing` 상태의 실수를 다음 단계로 승급하고 `nextReviewAt` 갱신:
    - 1일차 ➔ 3일차 (`nextReviewAt = 오늘 + 3일`)
    - 3일차 ➔ 7일차 (`nextReviewAt = 오늘 + 7일`)
    - 7일차 ➔ 14일차 (`nextReviewAt = 오늘 + 14일`)
    - 14일차에서 강의 수강 완료(퀴즈 미응시) ➔ `status = deferred` (보류).
  - 홈 화면에 **"임시 디버그: 단계 진행"** 시뮬레이터를 제공하여, 각 실수의 1→3→7→14→deferred 진행을 `[이 실수 강의 들었음 처리]` 버튼으로 수동 검증 지원.
- **빠른 졸업 & 다시 복습 (복기 결과 연동)**:
  - 통화 복기 시 `sessions.review.usedCorrectly[]`에 포함된 실수 ID ➔ `status = graduated` (퀴즈 없이 즉시 졸업).
  - `sessions.review.repeatedMistakes[]`에 포함된 실수 ID ➔ `status = reviewing`, `stage = 1일`, `nextReviewAt = 내일` (다시 복습으로 강등).
- **퀴즈 통과 졸업 훅 (`graduateMistakeAfterQuiz`)**:
  - B-6 퀴즈 연동을 위한 함수 준비 완료 (호출 시 `status = graduated`, `graduatedReason = 'quiz_passed'`).
- **오늘 복습 대상 집계 (`getDueMistakes`)**:
  - `status == 'reviewing'` 및 `nextReviewAt <= 오늘` 인 항목 + `status == 'deferred'` 인 항목 집계.
  - 정렬 순서: **`deferred`(보류) 항목이 목록 맨 앞**에 위치.
  - 홈 화면 상단에 **"오늘 복습 N개"** 카운터 명시 (보류 수 및 오늘 복습 대상 수 세부 표시).
- **엄격한 수동 졸업 버튼 배제**: 임의 조작 방지를 위해 수동 졸업 버튼은 배제하고, 복기 정상 발화(`usedCorrectly`) 및 퀴즈 통과를 통해서만 졸업되도록 시스템 규칙 준수.

### 📌 [Phase 1: B-4 통화 후 복기 (기록용) 완성]
- **최종 받아쓰기 (기록용 sttFinal)**:
  - 통화 종료(정상 종료 또는 끊긴 통화 판정) 시 세션의 10초 녹음 조각들을 순서대로 합쳐 `gemini-3.5-transcribe` **VERBATIM** 모드로 전사 후 `sessions.sttFinal`에 영구 보존 (화자가 발화한 말 토씨 하나 틀리지 않고 그대로 전사).
  - 최종 받아쓰기 실패 시 통화 중 임시본(`sttPartial`)을 이어 붙여 자동 대체(`sourceStt: 'sttPartial_fallback'`).
- **구조화된 복기 생성 (`gemini-3.8-flash`)**:
  - [기록용 받아쓰기(sttFinal) + Live 대화 로그 + 오늘 수업 지시서 + 기존 오답 목록]을 주입하여 엄격한 JSON 스키마로 복기 생성.
  - **myPhrase 절대 불변 규칙**: "인식이 어색하면 적당히 다듬어라" 지시를 완전히 삭제하고, 기록용 받아쓰기 문장을 글자 그대로 복사하여 학습자의 실제 문법 오류와 어색한 어휘를 가감 없이 보존.
  - **오답 교정 (mistakes[])**: `myPhrase`(글자 그대로 복사), `naturalPhrase`(원어민 자연스러운 표현), `reason`(한국어 1~2문장 교정 이유), `sourceStt`.
  - **외울 표현 5개 (keyExpressions[])**: 오늘 꼭 외워야 할 핵심 표현 정확히 5개 추출 (상황 및 예문 포함).
  - **AI 예상 레벨 (estimatedLevel)**: IM2 / IH / AL / Native 산출.
  - **복습 연동 데이터 (usedCorrectly / repeatedMistakes)**: 복습 중인 실수를 맞게 쓴 것 및 이미 졸업한 실수를 재반복한 것의 ID를 감지 및 저장.
- **복기 결과 화면 (Review Screen)**:
  - 표: 내가 한 말 (verbatim) -> 원어민 자연스러운 표현 (발음 듣기) -> 교정 이유.
  - AI 예상 레벨 옆에 **"AI 예상치, 공식 등급 아님"** 안내 명시.
  - 각 실수 항목별 **"이건 내가 한 말이 아니에요"** 버튼: 클릭 시 해당 항목을 화면과 Keep 복사 블록에서 숨기고 `qualityReports` 컬렉션에 `(sessionId, myPhrase, sourceStt, 시각)` 즉시 기록.
  - **"Keep에 붙여넣기용 복사"** 버튼: 줄마다 `[내가 한 말] -> [원어민 표현]` 형태로 일괄 클립보드 복사.
  - "끝나지 않은 통화가 있어요" 복구 모달에서 **"복기 시작"** 클릭 시 본 복기 파이프라인으로 자연스럽게 연결.
- **지시서 3 보완 (Requirement 0)**:
  - 조각 업로드 시마다 Firestore `sessions.lastChunkAt` 자동 갱신.
  - 끊긴 통화 기준을 **Firestore 기준**으로 일원화: `in-progress` 상태에서 `lastChunkAt`이 2분 초과 시 `pending_review`로 전환하고 복기 가능하도록 처리 (서버 잠듦 대비 앱 시작 시 자동 판정).
  - 앱 실행 시 IndexedDB에 남아 있는 업로드 실패 조각 자동 재업로드 및 `recordingChunks.uploaded: true` 갱신 후 IndexedDB 삭제.

### 📌 [Phase 1: B-3 통화 중 녹음 (끊김 대비) 완성]
- **마이크 청크 녹음 (10초 단위 Local-First)**:
  - `MediaRecorder`로 10초마다 완전한 WebM 오디오 조각 생성.
  - IndexedDB(`OneCallRecordingsDB`)에 즉시 1차 저장 후 Cloud Storage로 업로드, 업로드 완료 시 IndexedDB에서 자동 삭제.
  - Live 연결 끊김이나 GoAway, 서버 재연결 중에도 녹음은 백그라운드에서 중단 없이 지속.
- **1분 단위 임시 받아쓰기 (비동기 STT)**:
  - 약 1분(6조각) 누적 시 서버가 `gemini-3.5-transcribe` **VERBATIM** 모드로 음성을 전사하여 `sessions.sttPartial`에 자동 저장.
  - 실시간 Live 대화에 영향 주지 않는 비동기 처리, 환경설정(SettingsModal)에서 자유롭게 On/Off 가능.
- **Live 대화 로그 지속 저장 & 세션 재개 실패 대비**:
  - 통화 중 실시간으로 Firestore `sessions.liveTranscript`에 대화 로그 누적.
  - 세션 재개 handle이 거절/실패할 경우, 직전 대화 요약을 신규 세션 시스템 프롬프트에 자동 주입하여 튜터가 맥락을 유지한 채 대화 지속.
- **끊긴 통화 자동 감지 & 복구 모달**:
  - 마지막 조각 이후 2분 이상 새 조각이 없으면 끊긴 통화로 보고 `pending_review`("복기 대기")로 자동 전환.
  - 브라우저를 닫았다가 다시 열면 **"끝나지 않은 통화가 있어요. 복기할까요?"** 복구 모달 자동 노출.
- **화면 안내 및 Screen Wake Lock**:
  - 통화 화면 상단에 **"통화 중에는 화면을 켜 두세요"** 배너 및 10초 녹음 조각 카운터/보존 현황 표시.
  - Screen Wake Lock API를 호출하여 화면 꺼짐 방지.
- **녹음 보관함 (Storage Chunks) 인스펙터**:
  - 환경설정 모달 내 "녹음 보관함" 탭에서 실제 저장된 10초 오디오 파일 목록과 1분 전사본을 직접 확인 및 검증 가능.

### 📌 [기존 탑재 기능: B-2 실시간 통화 & 직접 연결 최적화]
- **브라우저 직접 연결 최적화 (2-1)**: `BidiGenerateContentConstrained?access_token=${token}` 정식 규격, v1alpha 임시 토큰, `setupComplete` 기반 엄격한 연결 판정, 서버 프록시 자동 폴백, `connectionPath` / `directFailCount` 텔레메트리.
- **B-2 실시간 음성 통화 (`gemini-3.8-live`)**: 세션 재개 & 컨텍스트 압축 기본 적용, GoAway 자동 재연결, 5대 핵심 제어 버튼(Done / Feedback / Model / Pause / Slow).
- **Firebase 단일 계정 접근 제어 (B-1)**: `episode.kim@gmail.com` 1인 전용 Google 로그인, 비인가 계정 즉시 차단 및 자동 로그아웃, Firestore 및 Cloud Storage 연결.
- **4대 목표 데이터 & 요일 루틴 (B-9)**: OPIc AL (14과), 필리조선소 주재원 (15과), 미국·호주 여행 (13과), Bluey 듣기 (12과), 부록 원문 프롬프트 100% 무삭제 보존 및 변수 커스텀.

---

## 🚀 4대 집중 트랙 및 커리큘럼

1. **🎯 OPIc 코치 (AL 등급 목표)**:
   - 1~14과 체계적 커리큘럼: 자기소개, 집/동네 묘사, 설문 주제(영화·공원·여행), 롤플레이 A/B/C, 돌발 주제, 사회 이슈 비교, 15문항 실전 모의고사.
   - 답변 종료 시 즉시 예상 등급(IM2/IH/AL) 산출, 실수 2개 교정, AL 격상 표현 및 모범답안 제시.
2. **🏭 Philly 출근 (한화 필리 조선소 실전 업무)**:
   - 1~15과 현장 비즈니스: 첫 출근 인사, 아침 생산 회의, 지연 보고 및 만회 계획, 안전 Toolbox Talk, 용접/블록 결함 설명, 정중한 반대, 납기 독촉 전화, 필라델피아 로컬 스몰토크(Eagles/치즈스테이크), 본사 결정 전달 등.
   - 미국 현지 동료 특유의 빠른 구어체, 이디엄, 자연스러운 핑퐁 대화.
3. **✈️ 여행 (미국 · 호주 가족 여행)**:
   - 1~13과 실전 롤플레이: 미국 입국심사, 렌터카 누락 문제, 호텔 컴플레인, 레스토랑 주문 및 팁 계산, 아이 해열제 약국 구입, 호주 생물보안 검역, 로컬 카페(Flat white, babycino), 본다이 해변 안전, 놀이터 BBQ 스몰토크.
   - 미국 표준 억양 및 호주 로컬 슬랭(arvo, no worries, reckon, mate).
4. **🦘 Bluey 리스닝 (호주 애니메이션 90% 청취)**:
   - S1E01 ~ S1E13 전편 에피소드 기반: 3줄 줄거리 예습, 호주 슬랭/어휘 10개, 호주 모음 발음 포인트, 5편 단위 누적 퀴즈 및 섀도잉 악센트 드릴.

---

## 🌟 핵심 자동화 파이프라인

- **일자별 스케줄러 & 'Next Lesson' 엔진**: 10/10 시작 기준 7주+12월 전체 일자별 진도표 및 요일별 루틴(월: OPIc, 화: Philly, 수: Bluey, 목: Philly, 금: 여행, 토: OPIc, 일: 주간 복기) 자동 추적.
- **실시간 전화 통화 (Gemini Live Native Audio)**: 초저지연(~300ms) 양방향 16kHz PCM 스트리밍, 원터치 음성 명령어("Next lesson", "Answer starts/Done", "Feedback", "Pause", "Model answer", "Slower").
- **통화 종료 후 자동 복기 (Mistake Log)**: 대화 종료 즉시 전체 트랜스크립트를 정밀 분석하여 `[내가 한 말 -> 자연스러운 표현 -> 이유]` 표, 오늘 꼭 외울 표현 5선, Google Keep 양식 자동 생성.
- **실수 보관함 (Mistake Vault)**: Google Keep 스타일 카드 뷰로 실수 내역 영구 보존, 원클릭 복사, 복습 완료 체크.
- **아침 7시 맞춤형 복습 팟캐스트**: 미완료 실수를 엮어 Grok 스타일의 3분 출근길 오디오 강의 스크립트 작성 및 고품질 Gemini TTS 음성 생성.
- **텔레그램 봇 자동 발송**: 생성된 복습 오디오를 내 텔레그램으로 전송하여 출근길에 간편 청취.

---

## 🛠 실행 및 빌드

```bash
# 개발 모드 실행 (포트 3000)
npm run dev

# 프로덕션 빌드 & 테스트
npm run build
npm run lint
npm start
```
