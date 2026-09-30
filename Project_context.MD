# 📖 프로젝트 컨텍스트 및 히스토리 (Project Context)

> **프로젝트**: 「오늘도 한 통」 (One Call Today) — AI 음성 통화 웹 애플리케이션  
> **현재 버전**: `v1.2.1` | **최종 갱신**: 2026-10-01  
> **관리 규칙**: `README.md` 변경 시 본 문서의 아키텍처 및 히스토리를 함께 최신화합니다.

---

## 1. 프로젝트 비전 및 디자인
- 영화 **"HER"** 감성의 어둡고 따뜻한 앰버 & 차콜 톤 (`#1A1210`, `#E8A87C`, `#F5EDE6`).
- 실시간 음성 반응형 **빛나는 오브(Glowing Orb)**를 보며 친구와 나누는 편안한 한국어 실시간 대화.
- 실제 전화 통화와 다름없는 초저지연(~300ms) 지향.

---

## 2. 모델 인프라 구성
- **실시간 통화 (Main)**: `gemini-2.5-flash-native-audio-latest` (Tier 1 WebSocket 양방향 16k in / 24k out, ~300ms)
- **대화 폴백 (Chat)**: `gemini-3.8-flash` (Live 장애 시 HTTP 자동 폴백, 200 OK 실측 검증 완료)
- **음성 합성 (TTS)**: `gemini-3.8-flash-lite-tts` (24kHz 고품질 한국어 WAV)
- **음성 인식 (STT)**: `gemini-3.5-transcribe` (오디오 블롭 백업 전사)

---

## 3. 오디오 엔지니어링 파이프라인 (Single Ear)
1. **단일 오디오 소스**: Live 통화 시 브라우저 WebSpeech API를 완전 OFF하고, Gemini Live의 공식 `inputAudioTranscription`/`outputAudioTranscription` 결과만 자막으로 직결 (WebSpeech 환각 자막 원천 차단).
2. **16kHz 다운샘플러**: 기기 하드웨어(48k/44.1k)를 `downsampleTo16kHz` 선형 보간하여 1.58옥타브 저하 슬로모션 버그 해결.
3. **하드웨어 에코 격리**: `ScriptProcessor`를 Zero-Gain(무음 노드)에 연결하여 마이크 소리의 스피커 루프백 차단, 7.5kHz Biquad 저역 필터 장착.
4. **스피커 버퍼 꼬리 잔류 동기화**: `PcmAudioSink`의 실제 큐 소진 시간(`getRemainingPlayTimeMs`) 이후 마이크 게이트 오픈.
5. **실제 인터럽트(Barge-in)**: 로컬 오디오 즉각 정지 + `liveSession.sendClientContent({ turnComplete: true })` 호출.
6. **P4 실시간 관측 인스펙터 & 16kHz WAV 검증 플레이어(`playWavProof`)**: 통화 화면에서 샘플레이트, RMS, 실측 레이턴시, 실제 전사문 확인 및 2초 WAV 원음 즉시 재생 검증.

---

## 4. 버전 히스토리
- **v1.2.1**: P4 오디오 관측 인스펙터 탑재, 2초 16kHz WAV 원음 검증기(`playWavProof`), 실측 레이턴시 동기화, 공식 SDK 인터럽트 연동, 폴백 모델 생존 실측.
- **v1.2.0**: Grok 검수 수용, 단일 오디오 소스(Single Ear) 아키텍처 개편, WebSpeech 완전 OFF, Live 전사 직결, Zero-Gain 스피커 분리, 이어폰 권장 안내.
- **v1.1.1**: 48k->16k 슬로모션 버그 진단, WebSpeech 환각 텍스트 하이재킹 차단, 에코 방지 마이크 게이트 1차 적용.
- **v1.1.0**: Gemini 2.5 Flash Native Audio 정식 연동, WebSocket 브리지, Glowing Orb 고도화.
- **v1.0.0**: 풀스택 음성 통화 웹앱 초기 릴리즈.

---

## 5. 📚 심층 기술 아카이브 문서 (`docs/`)
본 문서는 Cloud Run 배포 32KB 제한을 영구 준수하기 위해 핵심 요약으로 유지되며, 모든 상세 분석 및 원문 기록은 `docs/` 디렉토리에 용량 제한 없이 안전하게 누적 보존됩니다:
- **[오디오 파이프라인 상세 설계서 (`docs/architecture/audio-pipeline.md`)](./docs/architecture/audio-pipeline.md)**
- **[전체 변경 이력 상세 기록 (`docs/history/changelog.md`)](./docs/history/changelog.md)**
- **[Grok 기술 검수 피드백 및 실측 증명서 (`docs/reviews/grok-review-response.md`)](./docs/reviews/grok-review-response.md)**
- **[물리 음향학적 장애 진단서 (`docs/troubleshooting/audio-distortion-case-study.md`)](./docs/troubleshooting/audio-distortion-case-study.md)**

