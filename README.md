# 오늘도 한 통 (One Call Today) — AI 음성 통화 웹 앱

영화 "HER" 감성의 어둡고 따뜻한 무드(`Amber & Charcoal`) 속에서 빛나는 오브(Glowing Orb)와 함께 자연스러운 한국어 실시간 음성 통화를 나누는 풀스택 웹 애플리케이션입니다.

---

## 🚀 현재 빌드 버전 및 모델 스펙 (v1.2.1)

- **실시간 양방향 음성 대화 모델 (Live API)**: `gemini-2.5-flash-native-audio-latest`
  - **공식 명칭**: **Gemini 2.5 Flash Native Audio Dialog**
  - **프로토콜**: WebSocket 양방향 스트리밍 (`/live`)
  - **입력**: 브라우저 마이크 16kHz PCM 모노 실시간 인풋
  - **출력**: Gemini Native Audio 24kHz PCM 모노 음성 스트리밍 (지연시간 ~300ms 초저지연)
  - **계정 등급**: Google AI Studio Tier 1 Live API 무제한 RPM / 1M TPM 한도 연동
- **텍스트 대화 엔진 (HTTP Chat 폴백)**: `gemini-3.8-flash`
- **고품질 음성 합성 (TTS 폴백)**: `gemini-3.8-flash-lite-tts` (24kHz WAV)
- **음성 인식/전사 백업 (STT 폴백)**: `gemini-3.5-transcribe`

---

## 🌟 주요 기능 및 시스템 구조

### 1. 홈 화면 (Home Screen)
- 모바일 뷰포트 최적화 반응형 레이아웃 (`#1A1210`, `#E8A87C`)
- 대기 상태에서 잔잔하게 맥동하는 빛나는 오브 (Glowing Orb)
- 현재 설정된 목소리 페르소나 배지 표시
- 오브를 터치하거나 우측 상단 아이콘을 눌러 설정 시트(Settings Sheet) 호출
- 하단 「통화하기」 버튼으로 즉시 실시간 통화 세션 연결

### 2. 통화 화면 (Call Screen)
- **하드웨어 마이크 실시간 입력 (`getUserMedia`)**:
  - 에코 캔슬레이션(AEC), 노이즈 억제, 자동 게인 제어(AGC) 적용
  - 마이크 권한 요청/승인/차단 상태 표시 및 차단 시 원클릭 재시도 버튼 제공
- **실시간 음성 반응형 오브 & 파형 바 (Audio Visualizer)**:
  - Web Audio API `AnalyserNode`를 통해 사용자 목소리 음량(RMS)을 실시간 측정 (0.0 ~ 1.0)
  - 사용자가 말할 때 빛나는 오브가 음량에 맞춰 유기적으로 팽창 및 발광
  - 통화 중 청취 상태를 직관적으로 확인할 수 있는 7단 이퀄라이저 파형 바 표시
- **단일 오디오 소스(Single Ear) 실시간 음성 파이프라인**:
  - **Live Native Audio**: Gemini 2.5 Flash Native Audio 양방향 16kHz PCM 다이렉트 스트리밍 (STT 변환 지연 없이 모델이 음성을 직접 이해)
  - **공식 실시간 자막 직결**: Gemini Live 서버의 `inputAudioTranscription` 및 `outputAudioTranscription`을 실시간 수신하여 화면 자막에 표시 (WebSpeech 환각 자막 차단)
  - **P4 오디오 관측 인스펙터**: 하드웨어 샘플레이트(`48kHz → 16kHz`), 실시간 RMS, 송출 패킷 수, 에코 게이트 상태, Gemini Live 수신 전사문 실시간 노출
  - **16kHz 마이크 변환 2초 WAV 원음 검증기**: 원클릭으로 클라이언트 리샘플링 버퍼 원본을 즉시 재생하여 음성 왜곡 여부 청취 검증 가능
- **Barge-in (말 끊기 인터럽트)**:
  - AI가 말하는 도중 사용자가 말을 시작하면 로컬 오디오 즉각 중단 + `liveSession.sendClientContent({ turnComplete: true })` 호출로 서버 세션 실시간 인터럽트
- **추천 대화 칩 (Quick Prompt Chips)**:
  - "안녕! 오늘 하루 어땠어?", "지금 무슨 생각해?", "나 오늘 좀 피곤했어", "따뜻한 위로 한마디 해줘" 등 원터치 발화 칩 제공
- **텍스트 직접 입력창 (시뮬레이션/조용한 환경용)**:
  - 마이크를 사용하기 어려운 환경이나 테스트 시 텍스트로 즉시 발화 주입 가능
- **통화 제어**: 마이크 음소거(Mute) 토글 및 즉시 통화 종료(끊기)
- **통계/상태 배지**: 통화 시간, 연결된 AI 모델명, 응답 레이턴시(첫 소리, 모델, 음성 지연) 표시

### 3. 음성 페르소나 (TTS Voices)
Google Gemini 공식 5개 사전 구축 음성(Prebuilt Voice)과 매핑된 다채로운 한국어 캐릭터:
1. **코레 (Kore)**: 차분하고 포근한 여사친 (다정함 · 기본값)
2. **레다 (Zephyr 매핑)**: 밝고 통통 튀는 활기찬 여사친 (생동감)
3. **제피르 (Zephyr)**: 나긋나긋하고 부드러운 톤 (차분함)
4. **아오이데 (Kore 매핑)**: 세련되고 또렷한 똑순이 친구 (이지적)
5. **퍽 (Puck)**: 쾌활하고 싹싹한 남사친 (경쾌함)
6. **카론 (Charon)**: 차분하고 듬직한 중저음 남사친 (신뢰감)
7. **펜리르 (Fenrir)**: 따뜻하고 자신감 있는 든든한 톤 (응원)

### 4. 설정 시트 (Settings Sheet)
- **호칭 설정**: 사용자가 불리고 싶은 닉네임 설정 (기본값: "친구")
- **목소리 변경**: 7가지 캐릭터 프리셋 선택 및 즉시 반영
- **API 키 관리**: Google AI Studio Gemini API 키 및 예비 OpenRouter 키 커스텀 등록/마스킹 지원 (서버 기본 GDP 크레딧 자동 연동)

---

## 🛠 기술 스택 & 서버 아키텍처

- **프론트엔드**: React 18, TypeScript, Tailwind CSS, Lucide Icons, Vite
- **백엔드/서버**: Node.js, Express 5, WebSocket (`ws`), `@google/genai` SDK
- **아키텍처**:
  - Express와 Vite 미들웨어가 단일 포트(`PORT: 3000`)에서 구동되는 풀스택 아키텍처
  - `/live`: Gemini 2.5 Flash Native Audio Dialog WebSocket 브리지
  - `/api/gemini/status`: 서버 AI 연결 및 Tier 1 크레딧 상태 점검
  - `/api/gemini/test`: Gemini 응답 연결성 진단
  - `/api/gemini/chat`: 폴백 멀티턴 대화 엔드포인트 (`gemini-3.8-flash`)
  - `/api/gemini/tts`: 폴백 음성 합성 엔드포인트 (`gemini-3.8-flash-lite-tts`)
  - `/api/gemini/transcribe`: 폴백 오디오 전사 엔드포인트 (`gemini-3.5-transcribe`)

---

## 💻 로컬 개발 및 실행

```bash
# 의존성 설치
npm install

# 개발 서버 실행 (포트 3000, Vite + Express + WebSocket 통합 구동)
npm run dev

# 타입 검사 및 린트
npm run lint

# 프로덕션 빌드
npm run build

# 프로덕션 서버 시작
npm run start
```

---

## 📝 변경 이력 (Changelog)

### v1.2.1 (2026-10-01)
- **P4 오디오 관측 인스펙터 공식 탑재**:
  - 통화 화면에 실시간 샘플레이트(`48000Hz → 16000Hz`), 실시간 RMS, 송출 패킷 수, 에코 게이트 상태, Gemini Live 수신 전사문 실시간 노출
- **16kHz 마이크 변환 2초 WAV 원음 검증 도구 내장**:
  - `playWavProof`: 클라이언트가 다운샘플링한 16kHz PCM 원본을 브라우저에서 즉시 재생하여 음성 왜곡 여부를 귀로 직접 검증 가능
- **하드코딩 제거 및 실측 레이턴시 동기화**:
  - 발화 종료부터 첫 사운드 청크 수신까지의 실제 경과 시간(`measuredLatencyMs`) 측정 로직 구현
- **Live 인터럽트 공식 SDK 메서드 연동**:
  - `liveSession.sendClientContent({ turnComplete: true })` 호출로 서버 세션 인터럽트 보장
- **폴백 모델 생존성 실측 증명**:
  - `gemini-3.8-flash`, `gemini-3.5-transcribe`, `gemini-3.8-flash-lite-tts` API 200 OK 응답 검증 완료

### v1.2.0 (2026-10-01)
- **Grok 기획 검수 전면 수용 및 단일 오디오 소스(Single Ear) 아키텍처 구축**:
  - Live 통화 중 WebSpeech API 및 MediaRecorder 전면 비활성화 (귀를 하나로 일원화)
  - Gemini Live 서버의 `inputAudioTranscription` 및 `outputAudioTranscription` 활성화로 정확한 음성 전사 자막 직결
- **하드웨어 오디오 경로 결함 해소**:
  - `ScriptProcessor` 스피커 직결 버그 제거 (Zero-Gain 무음 노드로 격리)
  - 7.5kHz 안티에일리어싱 저역 통과 필터(`BiquadFilterNode`) 탑재
  - `fastUint8ToBase64` 청킹 인코딩으로 CPU 오버헤드 해소
- **에코 및 버퍼 잔류 동기화**:
  - `PcmAudioSink` 실제 스피커 큐 소진 시간 계산 후 마이크 게이트 오픈
  - Barge-in 시 로컬 오디오 즉각 정지 및 서버 `{ type: 'interrupt' }` 전송
- **UX 개선**:
  - 통화 화면 상단에 `🎧 이어폰을 착용하시면 더 선명하게 대화할 수 있어요` 팁 배지 추가
- **합의 문서 추가**:
  - Grok 기획 검수 합의서 `GROK_REVIEW_RESPONSE.md` 생성 및 진단서 `v1.2.0` 승격

### v1.1.1 (2026-09-30)
- **오디오 다운샘플링 왜곡(1/3배속 슬로모션) 해결**:
  - `downsampleTo16kHz` 선형 보간 알고리즘을 도입하여 48kHz/44.1kHz 기기 환경에서도 왜곡 없는 정밀 16,000Hz PCM 음성 스트리밍 보장
- **WebSpeech 환청 텍스트 하이재킹 차단**:
  - 브라우저 음성 인식이 발생시킨 오인식 텍스트("치과", "사랑해" 등)가 Live WebSocket으로 `text_prompt`로 주입되던 구조적 결함 제거
  - Gemini Live가 순수 마이크 음성만을 듣고 정확하게 답변하도록 단일 오디오 소스 파이프라인 정립
- **에코 방지 마이크 게이트(Echo Suppression Gate)**:
  - AI 발화 중 마이크 오디오 전송을 일시 차단하여 스피커 하울링 및 재유입 방지
- **상세 진단 보고서 작성**:
  - 외부 전문가 공유 및 아키텍처 분석용 `DIAGNOSIS_AND_SOLUTIONS.md` 생성

### v1.1.0 (2026-09-30)
- **Gemini 2.5 Flash Native Audio Dialog 정식 연동**:
  - Google AI Studio Tier 1 Live API 모델 식별자(`gemini-2.5-flash-native-audio-latest`)로 매핑 수정 및 연결 성공
- **하드웨어 마이크(`getUserMedia`) 파이프라인 구현**:
  - 통화 시작 시 명시적 마이크 권한 획득 및 16kHz PCM 양방향 스트리밍 활성화
  - 실시간 볼륨(RMS) 기반 Glowing Orb 발광 애니메이션 및 음성 파형 바 UI 추가
- **다중 음성 인식 폴백 체계 구축**:
  - Native Audio WebSocket 스트리밍 + Web Speech API + VAD/MediaRecorder 기반 Gemini Transcribe 백업 연동
- **사용자 편의성 향상**:
  - 통화 화면에 추천 대화 칩(Quick Prompts) 및 마이크 재시도 안내 버튼 추가
- **서버 엔드포인트 고도화**:
  - `/api/gemini/transcribe` 신설 및 `/api/gemini/status` 모델 식별 정보 동기화

---

## 📚 관련 프로젝트 관리 및 히스토리 문서
- **[`Project_context.MD`](./Project_context.MD)**: 시스템 아키텍처, 오디오 파이프라인 다이어그램, 상세 버전 히스토리 및 개발 컨텍스트 관리 총괄 문서 (README와 상시 동기화)
- **[`GROK_REVIEW_RESPONSE.md`](./GROK_REVIEW_RESPONSE.md)**: Grok 기획 검수에 대한 정식 기술 답변 및 실측 검증 합의서
- **[`DIAGNOSIS_AND_SOLUTIONS.md`](./DIAGNOSIS_AND_SOLUTIONS.md)**: 물리 음향학적 원인 분석 및 아키텍처 진단 보고서

