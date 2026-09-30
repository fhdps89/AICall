# 오늘도 한 통 (One Call Today) — AI 음성 통화 웹 앱

영화 "HER" 감성의 어둡고 따뜻한 무드(`Amber & Charcoal`) 속에서 빛나는 오브(Glowing Orb)와 함께 자연스러운 한국어 실시간 음성 통화를 나누는 풀스택 웹 애플리케이션입니다.

---

## 🚀 현재 빌드 버전 및 모델 스펙 (v1.1.0)

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
- **하이브리드 음성 인식 (Hybrid STT & VAD)**:
  - **1순위**: Gemini 2.5 Flash Native Audio 양방향 16kHz PCM 다이렉트 스트리밍 (STT 변환 지연 없이 모델이 음성을 직접 이해)
  - **2순위**: Web Speech API (`ko-KR`) 실시간 한글 자막 피드백
  - **3순위**: 음성 활동 감지(VAD) + `MediaRecorder` 음성 버퍼링 → Web Speech 미지원 브라우저(Safari, Firefox, 인앱 웹뷰 등) 환경에서도 `gemini-3.5-transcribe`를 통해 100% 자동 전사
- **Barge-in (말 끊기)**:
  - AI가 말하는 도중 사용자가 말을 시작하면 400ms 내 음성 출력을 즉시 중단하고 다시 경청 모드로 전환
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
