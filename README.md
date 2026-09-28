# 오늘도 한 통 (One Call Today) — React Web App

따뜻하고 어두운 영화 "HER" 감성의 빛나는 오브(Glowing Orb)와 실시간 한국어 AI 음성 통화 루프를 제공하는 웹 애플리케이션입니다.

## 기능 개요

1. **홈 화면 (Home Screen)**
   - 세로 모바일 뷰포트에 최적화된 어둡고 따뜻한 톤 (`#1A1210`, `#E8A87C`)
   - 유기적으로 맥동하는 빛나는 오브 (Glowing Orb)
   - 「지금 목소리」 상태 표시
   - 「통화하기」 버튼으로 즉시 통화 연결
   - 오브를 누르면 설정 시트(Settings Sheet) 표시

2. **설정 시트 (Settings Sheet)**
   - **호칭 설정**: AI가 사용자를 부를 이름(기본값: "친구") 설정 및 즉시 로컬 저장
   - **OpenRouter 키 설정**: 키 입력, 마스크 표시, 연결 테스트 및 저장
   - **목소리 선택**:
     - 2번 Puck (Gemini Flash-Lite TTS · 남 · 기본)
     - 1번 Leda (Gemini Flash TTS · 여)
     - 7번 longanhuan_v3.6 (Qwen TTS Flash · 여)
   - **예비 Gemini API 키 설정**: 키 입력, 마스크 표시, 연결 테스트 및 저장

3. **통화 화면 (Call Screen)**
   - **실시간 음성 인식(STT)**: Web Speech API (`ko-KR`) 연동 및 1.5초 발화 종료 침묵 윈도우(`UtteranceWindow`)
   - **실시간 음성 합성(TTS)**:
     - OpenRouter PCM 음성 스트리밍 (Web Audio API)
     - 브라우저 기본 한국어 TTS (`window.speechSynthesis`) 폴백 지원
   - **Barge-in (말 끊기)**: AI가 말하는 도중 사용자가 말을 시작하면 즉시 음성 재생을 중단하고 다시 듣기 모드로 전환
   - **상태 애니메이션**: 오브의 3가지 상태 (Idle / Listening / Speaking) 애니메이션
   - **통화 통계 표시**: 통화 타이머, 응답 소스, 응답 지연 시간(첫 소리, 모델, 음성 지연) 표시
   - **컨트롤**: 음소거(Mute) 토글 및 통화 종료(끊기)
   - **테스트용 직접 발화 입력창**: 마이크 사용이 제한된 브라우저 환경에서도 완벽한 대화 테스트 가능

4. **대화 뇌 (Brain) 및 응답 우선순위**
   - 1순위: OpenRouter SSE 스트리밍 완성 문장 단위 즉시 합성
   - 2순위: Gemini REST API (`gemini-2.5-flash-lite`)
   - 3순위: 로컬 규칙 기반 한국어 응답기 (`ReplyGenerator`) — API 키 없이도 대화 가능

## 개발 및 빌드

```bash
# 개발 서버 실행 (포트 3000)
npm run dev

# 프로덕션 빌드
npm run build
```
