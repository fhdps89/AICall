# 📖 프로젝트 컨텍스트 및 히스토리 (Project Context)

> **프로젝트**: 「오늘도 한 통」 (One Call English) — AI 1:1 전화영어 올인원 랩  
> **현재 버전**: `v2.1.0` | **공식 빌드 버전**: `20261013-multilingual-1410` | **최종 갱신**: 2026-10-13 (KST)  
> **관리 규칙**: `README.md` 변경 시 본 문서의 아키텍처 및 히스토리를 함께 최신화하며, 모든 일시는 한국 표준시(KST)를 기준으로 합니다.

---

## 1. 프로젝트 비전 및 디자인
- **정체성**: 4개 특화 트랙(OPIc AL, 한화 필리 조선소 비즈니스, 미국·호주 여행, Bluey 호주 리스닝)의 일자별 커리큘럼에 맞춰 AI와 실시간 음성 통화를 나누고, 통화 종료 후 즉시 정밀 복기 리포트와 실수 노트를 자동 추출하며, 아침 출근길용 1:1 맞춤형 복습 오디오 강의까지 제공하는 완성형 AI 전화영어 애플리케이션.
- **디자인 무드**: 심야 서재의 차분한 다크 슬레이트 캔버스(`bg-[#0F141C]`), 정갈한 카드 서피스(`bg-[#161D2A]`), 웜 골드/앰버 액센트(`text-amber-400`), 모바일 반응형 터치 인터페이스.

---

## 2. 모델 인프라 구성 (Part B-1 확정 사양)
- **실시간 통화 (Live)**: `LIVE_MODEL = "gemini-3.8-live"`
- **통화 복기 & 퀴즈·코치 (Text)**: `TEXT_MODEL = "gemini-3.8-flash"`
- **기록용 받아쓰기 (STT)**: `STT_ENGINE = "gemini"` (`gemini-3.5-transcribe`, 모드 `VERBATIM`) / 비실시간 대안 `universal-3-5-pro` (AssemblyAI)
- **오디오 합성 (TTS)**: `TTS_ENGINE = "gemini"` (`gemini-3.8-flash-tts`) / 2인 대화 대안 ElevenLabs
- **공급자 추상화 레이어 (`src/services/providers/`)**: `LiveProvider`, `SttProvider`, `LlmProvider`, `TtsProvider` 인터페이스 분리.

---

## 3. 핵심 자동화 아키텍처 (Part B-12 1단계 뼈대 완료)
1. **Firebase 1인 전용 보안 및 클라우드 동기화**:
   - `episode.kim@gmail.com` 단일 계정 엄격 화이트리스트 검증 (`src/services/firebase/auth.ts`).
   - Firestore 엔티티 블루프린트(`firebase-blueprint.json`) 및 ABAC 보안 규칙(`firestore.rules`).
   - Cloud Storage(`src/services/firebase/storage.ts`) 연동.
2. **4대 목표 데이터 & 부록 원문 프롬프트 보존 (`src/data/defaultGoals.ts`)**:
   - OPIc AL (14과), 필리조선소 주재원 (15과), 미국·호주 여행 (13과), Bluey 듣기 (12과).
   - 마스터 체크리스트 부록 튜터 프롬프트 원문 100% 무삭제 보존.
   - 요일별 집중 루틴: 월·토 OPIc, 화·목 Philly, 수 Bluey, 금 여행, 일 주간 복기.
3. **프롬프트 슬롯 커스터마이징 (`src/data/promptCustomizer.ts`)**:
   - `[직무]`, `[Survey topics I chose]`, `[My role in Philly]`, `[Recent weak points]`를 설정 모달에서 사용자가 직접 입력 및 저장.
4. **첫 실행 진도 설정 & 오늘 수업 카드 UI (`src/ui/onboarding/`, `src/ui/home/`)**:
   - 첫 실행 시 OPIc 10/10 1과, 10/11 2과, 10/12 3과 히스토리를 반영한 진도 설정 모달 제공.
   - 홈 화면 요일별 루틴 뱃지 및 오늘 요일에 해당하는 수업 카드 실시간 렌더링.

---

## 4. 버전 히스토리
- **v2.1.0 (2026-10-13 KST)**: [Phase 1: 1단계 뼈대 구축 완료] Firebase 단일 계정(episode.kim@gmail.com) 인증, Firestore/Cloud Storage 연동, Part B-1 models.ts 및 Provider 인터페이스 뼈대, 4대 목표 부록 원문 프롬프트 영구 저장, 첫 실행 진도 입력 모달, 오늘 수업 카드 UI 완성.
- **v2.0.0 (2026-10-13 KST)**: AI 1:1 전화영어 올인원 랩 전면 개편. 4대 집중 트랙 및 10/10~1/9 일자별 스케줄러 엔진, 통화 종료 후 정밀 복기 리포트, Mistake Vault, 아침 7시 맞춤형 복습 팟캐스트 및 텔레그램 연동.
- **v1.2.2**: 한국어 귀 고정 (Korean Ear Lock), 점진적 폴백 체계.
- **v1.2.1**: P4 오디오 관측 인스펙터 탑재, 2초 16kHz WAV 원음 검증기.
- **v1.2.0**: Grok 검수 수용, 단일 오디오 소스(Single Ear) 아키텍처 개편.
- **v1.1.0**: Gemini 2.5 Flash Native Audio 정식 연동.
- **v1.0.0**: 풀스택 음성 통화 웹앱 초기 릴리즈.
