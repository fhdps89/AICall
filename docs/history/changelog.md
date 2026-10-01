# 📜 전체 변경 이력 상세 기록 (Changelog Archive)

> **일시 표기 기준**: 모든 버전 릴리즈 및 작업 일시는 **한국 표준시 (KST, UTC+9)** 기준으로 기록됩니다.

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
