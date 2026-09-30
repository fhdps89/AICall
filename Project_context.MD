# 📖 프로젝트 컨텍스트 및 히스토리 관리 문서 (Project Context & History)

> **프로젝트 명**: 「오늘도 한 통」 (One Call Today) — AI 음성 통화 웹 애플리케이션  
> **현재 버전**: `v1.2.1`  
> **최종 갱신일**: 2026-10-01  
> **문서 관리 규칙**: 본 문서는 `README.md` 변경 시 반드시 함께 동기화하여 프로젝트의 기술 결정, 문제 해결 내역, 아키텍처 변경점을 누적 기록합니다.

---

## 1. 프로젝트 비전 및 핵심 가치 (Vision & Goals)

영화 **"HER"**의 감성처럼, 하루를 마치고 지친 사용자에게 따뜻하고 친근한 AI 친구가 먼저 전화를 걸어와 위로와 대화를 건네는 실시간 음성 통화 서비스입니다.
- **핵심 무드**: 어둡고 따뜻한 앰버 & 차콜 (`Amber & Charcoal`, `#1A1210`, `#E8A87C`, `#F5EDE6`)
- **인터랙션**: 기계적인 챗봇이 아닌, 실시간 숨결처럼 맥동하는 **빛나는 오브(Glowing Orb)**를 바라보며 실제 친구와 통화하듯 자연스러운 반말로 대화.
- **초저지연**: 말과 말 사이의 끊김을 최소화하여 실제 전화 통화와 다름없는 반응 속도(~300ms) 지향.

---

## 2. 시스템 아키텍처 및 기술 스택 (System Architecture)

### 2.1 기술 스택
- **프론트엔드**: React 18, TypeScript, Tailwind CSS, Lucide Icons, Vite
- **풀스택 백엔드**: Node.js, Express, WebSocket (`ws`), `@google/genai` SDK
- **배포 및 런타임**: Google Cloud Run (Containerized SPA + API/WebSocket Bridge, Port 3000)

### 2.2 모델 인프라 구성 (Model Topology)
| 구분 | 모델 식별자 | 프로토콜 | 역할 및 특성 |
| :--- | :--- | :--- | :--- |
| **메인 실시간 통화** | `gemini-2.5-flash-native-audio-latest` | WebSocket (`/live`) | Google AI Studio Tier 1 Live API. 16kHz PCM 양방향 스트리밍, 모델 고유 네이티브 음성 출력 (지연시간 ~300ms) |
| **HTTP 대화 폴백** | `gemini-3.8-flash` | REST API (`/api/gemini/chat`) | Live 세션 장애 시 구동되는 초고속 텍스트 생성 모델 (200 OK 검증 완료) |
| **음성 합성 폴백** | `gemini-3.8-flash-lite-tts` | REST API (`/api/gemini/tts`) | HTTP 모드 전환 시 구어체 한국어 음성 생성 (24kHz WAV) |
| **음성 인식 폴백** | `gemini-3.5-transcribe` | REST API (`/api/gemini/transcribe`) | 브라우저 STT 불가 시 오디오 블롭 전사 백업 |

---

## 3. 오디오 엔지니어링 핵심 파이프라인 (Audio Engineering)

Grok 기획 검수와 실측 테스트를 거쳐 확립된 **견고한 단일 오디오 소스(Single Ear) 파이프라인**입니다.

```
[사용자 마이크]
      │ (getUserMedia, 48kHz / 44.1kHz)
      ▼
[BiquadFilterNode (7.5kHz Lowpass)] ──> 2차 필터(-12dB/oct)로 초고역 에일리어싱 완화
      │
      ▼
[ScriptProcessorNode (4096)] ─────────> [Zero-Gain Node (볼륨 0)] ──> [destination]
      │                                 (마이크 소리의 스피커 출력 루프백 완벽 차단)
      ├─> [2초 링 버퍼] ─────────────────> 화면 「16kHz WAV 검증 플레이어」에서 즉시 청취
      │
      ▼
[downsampleTo16kHz 선형 보간] ──────────> 기기 샘플레이트 무관 완벽한 16,000Hz PCM 변환
      │
      ▼
[fastUint8ToBase64 청킹 전송] ─────────> WebSocket (/live) ──> Gemini Live Session
                                                                      │
                                                (input/output transcription 수신)
                                                                      ▼
                                              화면 자막 & P4 관측 인스펙터에 직결
```

### 3.1 주요 기술적 해결 내역
1. **48kHz → 16kHz 미변환 슬로모션 버그 해결**:
   - 하드웨어 48kHz를 그대로 16kHz로 전송하여 목소리가 3배 느려지고 피치가 약 1.58옥타브(19반음) 떨어지던 현상을 `downsampleTo16kHz` 선형 보간 알고리즘으로 해결.
2. **단일 오디오 소스(Single Ear) 원칙 확립**:
   - WebSpeech API가 발생시킨 환청 자막("치과", "사랑해")이 Live 세션에 `text_prompt`로 주입되어 AI가 동문서답하던 구조적 결함 제거.
   - Live 통화 중에는 WebSpeech를 완전히 끄고, Gemini Live의 공식 `inputAudioTranscription` 결과만 자막으로 채택.
3. **스피커 루프백 차단**:
   - `ScriptProcessor`를 게인 0의 무음 싱크(`zeroGain`)로 연결하여 마이크 소리가 스피커로 나가지 않도록 하드웨어 에코 격리.
4. **스피커 버퍼 꼬리 잔류 동기화**:
   - AI 답변 종료 시 브라우저 스피커 큐가 모두 소진될 때까지(`getRemainingPlayTimeMs()`) 마이크 게이트를 닫아 스피커 소리 재유입 차단.
5. **실제 인터럽트(Barge-in)**:
   - 끼어들기 시 로컬 오디오 즉각 중단 + `liveSession.sendClientContent({ turnComplete: true })` 호출로 서버 세션 실시간 인터럽트.

---

## 4. 주요 파일 구성 및 역할 (File Map)

- `/server.ts`: Express + Vite 미들웨어 및 Gemini Live WebSocket 브리지 (`/live`), HTTP 엔드포인트
- `/src/voice/VoiceCallEngine.ts`: 음성 통화 총괄 오케스트레이터 (Web Audio, 리샘플러, P4 관측 인스펙터, 링 버퍼)
- `/src/voice/AudioSink.ts`: 24kHz PCM 스트리밍 오디오 수신 재생 및 큐 시간 추적기 (`PcmAudioSink`)
- `/src/voice/PersonaPrompt.ts`: "HER" 감성의 AI 캐릭터 페르소나 및 음성 대화 특화 프롬프트
- `/src/ui/call/CallScreen.tsx`: 통화 화면 (빛나는 오브, P4 관측 인스펙터, WAV 검증기, 이어폰 팁)
- `/src/ui/components/GlowingOrb.tsx`: Web Audio RMS 레벨과 감정 상태에 반응하는 빛나는 구체
- `/DIAGNOSIS_AND_SOLUTIONS.md`: 물리 음향학적 원인 분석 및 아키텍처 진단 보고서
- `/GROK_REVIEW_RESPONSE.md`: Grok 기획 검수에 대한 기술 답변 및 실증 합의서

---

## 5. 전체 버전 히스토리 (Version History)

### v1.2.1 (2026-10-01) — 실측 관측성 및 실증 도구 장착
- **P4 오디오 관측 인스펙터 공식 탑재**:
  - 통화 화면 상단에 접이식 관측 패널 추가: 샘플레이트(`48000Hz → 16000Hz`), 실시간 RMS, 송출 패킷 수, 에코 게이트 상태, Gemini Live 수신 전사문 실시간 노출.
- **16kHz 마이크 변환 2초 WAV 원음 검증기(`playWavProof`)**:
  - 클라이언트 리샘플링 버퍼 원본을 즉시 재생하여 음성 왜곡 여부를 귀로 직접 검증 가능.
- **하드코딩 제거 및 실측 레이턴시 연동**:
  - 발화 종료부터 첫 사운드 청크 도착까지의 실제 경과 시간(`measuredLatencyMs`) 측정.
- **Live 인터럽트 공식 SDK 메서드 연동**:
  - `liveSession.sendClientContent({ turnComplete: true })` 호출로 서버 세션 인터럽트 보장.
- **폴백 모델 생존성 실측 증명**:
  - `gemini-3.8-flash`, `gemini-3.5-transcribe`, `gemini-3.8-flash-lite-tts` API 200 OK 응답 검증 완료.

### v1.2.0 (2026-10-01) — Grok 기획 검수 수용 및 단일 오디오 소스 구축
- Live 통화 중 WebSpeech API 및 MediaRecorder 전면 비활성화 (귀를 하나로 일원화).
- Gemini Live 서버의 `inputAudioTranscription` 및 `outputAudioTranscription` 활성화로 정확한 음성 전사 자막 직결.
- `ScriptProcessor` 스피커 직결 버그 제거 (Zero-Gain 무음 노드로 격리).
- 7.5kHz 안티에일리어싱 저역 통과 필터(`BiquadFilterNode`) 탑재.
- `fastUint8ToBase64` 청킹 인코딩으로 CPU 오버헤드 해소.
- `PcmAudioSink` 실제 스피커 큐 소진 시간 계산 후 마이크 게이트 오픈.
- 통화 화면 상단에 `🎧 이어폰을 착용하시면 더 선명하게 대화할 수 있어요` 팁 배지 추가.
- Grok 기획 검수 합의서 `GROK_REVIEW_RESPONSE.md` 생성 및 진단서 `v1.2.0` 승격.

### v1.1.1 (2026-09-30) — 슬로모션 오디오 왜곡 및 텍스트 하이재킹 1차 차단
- `downsampleTo16kHz` 선형 보간 알고리즘 도입으로 48kHz/44.1kHz 기기 환경의 1.58옥타브 저하 버그 해결.
- WebSpeech 오인식 텍스트("치과", "사랑해" 등)가 Live WebSocket으로 `text_prompt`로 주입되던 경로 차단.
- AI 발화 중 마이크 오디오 전송을 일시 차단하는 에코 방지 마이크 게이트 도입.
- 상세 진단 보고서 `DIAGNOSIS_AND_SOLUTIONS.md` 생성.

### v1.1.0 (2026-09-30) — Gemini 2.5 Flash Native Audio 정식 연동
- Google AI Studio Tier 1 Live API 모델 식별자(`gemini-2.5-flash-native-audio-latest`) 연동.
- 하드웨어 마이크(`getUserMedia`) 16kHz PCM 양방향 스트리밍 활성화.
- 실시간 RMS 기반 Glowing Orb 발광 애니메이션 및 음성 파형 바 UI 추가.
- 다중 음성 인식 폴백 체계 및 추천 대화 칩(Quick Prompts) 추가.
- 서버 `/api/gemini/transcribe` 신설.

### v1.0.0 (2026-09-29) — 초기 릴리즈
- 「오늘도 한 통」 풀스택 웹 애플리케이션 초기 런칭.
- HTTP Chat + TTS/STT 기반 음성 통화 및 로컬 감성 페르소나 구축.

---

## 6. 향후 유지보수 지침 (Maintenance Guidelines)

1. **README.md와의 동기화 필수**:
   - 기능 추가, 버그 수정, 모델 ID 변경 시 `README.md`의 버전/체인지로그와 본 `Project_context.MD`를 반드시 함께 업데이트합니다.
2. **단일 오디오 소스 원칙 엄수**:
   - Gemini Live 통화 중에는 클라이언트 사이드 음성 인식(WebSpeech API)을 모델 인풋 파이프라인에 다시 연결하지 않습니다.
3. **P4 실시간 관측 인스펙터 유지**:
   - 음성 인식 이슈가 재발할 경우, 귀로만 추측하지 않고 화면의 P4 인스펙터(`Capture SampleRate`, `Mic RMS`, `Input Transcript`, `WAV 검증기`)를 통해 객관적 수치로 디버깅합니다.
