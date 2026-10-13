# 📜 전체 변경 이력 상세 기록 (Changelog Archive)

> **일시 표기 기준**: 모든 버전 릴리즈 및 작업 일시는 **한국 표준시 (KST, UTC+9)** 기준으로 기록됩니다.

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
