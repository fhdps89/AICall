# 오늘도 한 통 (One Call Today) — AI 음성 통화 웹 앱

영화 "HER" 감성의 어둡고 따뜻한 무드(`Amber & Charcoal`) 속에서 빛나는 오브(Glowing Orb)와 함께 자연스러운 한국어 실시간 음성 통화를 나누는 풀스택 웹 애플리케이션입니다.

---

## 🚀 모델 스펙 (v1.2.1 · 2026-10-01 KST 기준)
- **실시간 음성 대화 (Live API)**: `gemini-2.5-flash-native-audio-latest` (16kHz PCM 스트리밍, ~300ms 초저지연)

- **텍스트 대화 엔진 (HTTP 폴백)**: `gemini-3.8-flash`
- **고품질 음성 합성 (TTS 폴백)**: `gemini-3.8-flash-lite-tts` (24kHz WAV)
- **음성 인식/전사 백업 (STT 폴백)**: `gemini-3.5-transcribe`

---

## 🌟 주요 기능
1. **홈 화면**: 따뜻한 앰버 톤 UI, 숨 쉬듯 맥동하는 Glowing Orb, 설정 시트 및 원클릭 통화 시작.
2. **통화 화면**:
   - **단일 오디오 소스(Single Ear)**: Gemini Live 공식 자막 직결 (`inputAudioTranscription`/`outputAudioTranscription`), WebSpeech 환각 차단.
   - **P4 오디오 관측 인스펙터**: 하드웨어 샘플레이트(`48kHz → 16kHz`), 실시간 RMS, 송출 패킷 수, 에코 게이트 상태, Gemini Live 수신 전사문 실시간 노출.
   - **16kHz 마이크 변환 2초 WAV 원음 검증기**: 원클릭으로 클라이언트 리샘플링 버퍼 원본 즉시 재생 검증.
   - **Barge-in (말 끊기 인터럽트)**: 사용자 발화 감지 시 로컬 즉각 중단 + `liveSession.sendClientContent` 서버 인터럽트.
   - **음성 반응형 이퀄라이저 파형 바 & 추천 대화 칩**.
3. **음성 페르소나**: 코레(Kore · 다정함), 레다(Zephyr · 생동감), 제피르(Zephyr · 차분함) 등 지원.

---

## 🛠 실행 및 빌드
```bash
# 개발 모드 실행
npm run dev

# 프로덕션 빌드 & 테스트
npm run build
npm run lint
npm start
```

---

## 📚 관련 문서
- **[`Project_context.MD`](./Project_context.MD)**: 시스템 아키텍처, 오디오 파이프라인, 상세 버전 히스토리 및 개발 컨텍스트 관리 총괄 문서 (README와 상시 동기화)
- **[`docs/`](./docs/)**: 무제한 심층 아키텍처 명세, Grok 검수 원문, 물리 음향학적 장애 분석서 보존 허브

