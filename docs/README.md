# 📚 「오늘도 한 통」 심층 기술 및 아카이브 문서 (Documentation Hub)

> **일시 표기 기준**: 모든 아카이브 문서의 작성 및 변경 일시는 **한국 표준시 (KST, UTC+9)** 기준으로 기록됩니다.  
> 본 디렉토리(`docs/`)는 **Cloud Run 배포 환경 변수 크기 제한(32KB)과 무관하게**, 프로젝트의 모든 아키텍처 결정, 문제 해결 과정, 외부 기술 검수 합의, 상세 버전 히스토리를 100% 온전하게 보존하는 영구 아카이브 허브입니다.


---

## 🗂 문서 인덱스 (Document Index)

### 1. [아키텍처 상세 설계 (`docs/architecture/`)](./architecture/)
- **[`audio-pipeline.md`](./architecture/audio-pipeline.md)**:
  - 단일 오디오 소스(Single Ear) 원칙
  - 하드웨어 48kHz/44.1kHz ➔ 16kHz 정밀 선형 보간 다운샘플러 (`downsampleTo16kHz`)
  - Zero-gain 무음 싱크를 통한 마이크 스피커 루프백 차단
  - 7.5kHz Biquad 2차 저역 통과 필터(-12dB/oct) 감쇄 명세
  - `PcmAudioSink` 스피커 큐 소진 시간(`getRemainingPlayTimeMs`) 기반 에코 게이트
  - 실시간 Barge-in 인터럽트 SDK 공식 프로토콜 (`sendClientContent`)

### 2. [상세 릴리즈 및 변경 히스토리 (`docs/history/`)](./history/)
- **[`changelog.md`](./history/changelog.md)**:
  - v1.0.0부터 v1.2.1까지 모든 기능 추가, 버그 패치, 구조 변경점의 상세 무삭제 기록

### 3. [외부 기술 검수 및 실증 보고서 (`docs/reviews/`)](./reviews/)
- **[`grok-review-response.md`](./reviews/grok-review-response.md)**:
  - Grok의 5대 비판 지적에 대한 기술적 수용 및 실측 데이터
  - 가짜 하드코딩 레이턴시 제거 및 `measuredLatencyMs` 실측 로직
  - 2초 16kHz WAV 원음 검증기(`playWavProof`) 기술 명세
  - `@google/genai` Node.js SDK 프로토타입 디컴파일 및 WebSocket 인터럽트 프레임 전송 검증
  - `gemini-3.8-flash` 계열 폴백 모델 생존 200 OK 실서버 호출 로그

### 4. [장애 진단 및 음향학적 분석서 (`docs/troubleshooting/`)](./troubleshooting/)
- **[`audio-distortion-case-study.md`](./troubleshooting/audio-distortion-case-study.md)**:
  - 48kHz PCM 스트림을 16kHz로 직결했을 때 발생하는 3배 슬로모션 및 1.58옥타브(19반음) 저하 현상의 물리 음향학적 원인 분석
  - 브라우저 WebSpeech API가 유발한 환청 자막("치과", "사랑해")이 모델을 하이재킹하던 결함 및 해결책

---

## 🛡 문서 관리 및 배포 격리 정책
1. **루트 문서 경량화**: `README.md`와 `Project_context.MD`는 핵심 인덱스 및 요약본(Executive Summary)으로 10KB 미만으로 유지하여 Cloud Run 배포 에러를 영구 방지합니다.
2. **무제한 기록**: 모든 상세 내용, 코드 스니펫, 디버깅 로그는 `docs/` 하위 문서에 제한 없이 자유롭게 기록합니다.
3. **배포 제외**: `.dockerignore` 및 `.gcloudignore`를 통해 `docs/` 디렉토리가 Cloud Run 컨테이너 메타데이터/환경 변수로 주입되지 않도록 격리합니다.
