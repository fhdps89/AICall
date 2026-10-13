# 📖 프로젝트 컨텍스트 및 히스토리 (Project Context)

> **프로젝트**: 「오늘도 한 통」 (One Call English) — AI 1:1 전화영어 올인원 랩  
> **현재 버전**: `v2.3.0` | **공식 빌드 버전**: `20261013-multilingual-1529` | **최종 갱신**: 2026-10-13 (KST)  
> **관리 규칙**: `README.md` 변경 시 본 문서의 아키텍처 및 히스토리를 함께 최신화하며, 모든 일시는 한국 표준시(KST)를 기준으로 합니다.

---

## 1. 프로젝트 비전 및 디자인
- **정체성**: 4개 특화 트랙(OPIc AL, 한화 필리 조선소 비즈니스, 미국·호주 여행, Bluey 호주 리스닝)의 일자별 커리큘럼에 맞춰 AI와 실시간 음성 통화를 나누고, 통화 종료 후 즉시 정밀 복기 리포트와 실수 노트를 자동 추출하며, 아침 출근길용 1:1 맞춤형 복습 오디오 강의까지 제공하는 완성형 AI 전화영어 애플리케이션.
- **디자인 무드**: 심야 서재의 차분한 다크 슬레이트 캔버스(`bg-[#0F141C]`), 정갈한 카드 서피스(`bg-[#161D2A]`), 웜 골드/앰버 액센트(`text-amber-400`), 모바일 반응형 터치 인터페이스.

---

## 2. 모델 인프라 구성 (Part B-1 & B-2 & B-3 확정 사양)
- **실시간 통화 (Live)**: `LIVE_MODEL = "gemini-3.8-live"`
- **통화 복기 & 퀴즈·코치 (Text)**: `TEXT_MODEL = "gemini-3.8-flash"`
- **기록용 받아쓰기 & 1분 임시 전사 (STT)**: `STT_ENGINE = "gemini"` (`gemini-3.5-transcribe`, 모드 `VERBATIM`) / 비실시간 대안 `universal-3-5-pro` (AssemblyAI)
- **오디오 합성 (TTS)**: `TTS_ENGINE = "gemini"` (`gemini-3.8-flash-tts`) / 2인 대화 대안 ElevenLabs
- **공급자 추상화 레이어 (`src/services/providers/`)**: `LiveProvider`, `SttProvider`, `LlmProvider`, `TtsProvider` 인터페이스 분리.

---

## 3. 핵심 자동화 아키텍처 (Part B-12 뼈대 & B-2 통화 & B-3 통화 중 녹음)
1. **B-3 통화 중 녹음 & 끊김 대비 이중 안전망 (`chunkIndexedDb.ts`, `chunkRecorder.ts`, `NewCallScreen.tsx`)**:
   - **10초 마이크 청크 녹음**: `MediaRecorder`로 10초 조각 생성 -> IndexedDB(`OneCallRecordingsDB`)에 선저장 -> Cloud Storage 즉시 업로드 -> 성공 시 IndexedDB 삭제.
   - **연결 독립성 보장**: Live 연결이 끊기거나(GoAway, 소켓 재연결, 프록시 전환) 불안정해도 마이크 녹음은 중단 없이 독립 백그라운드 구동.
   - **1분 단위 임시 받아쓰기**: 약 1분(6조각)마다 비동기로 `gemini-3.5-transcribe` VERBATIM 전사 -> `sessions.sttPartial` 누적. 환경설정에서 토글 가능.
   - **Live 대화 로그 지속 저장 & 재개 실패 대비**: 통화 중 실시간으로 `sessions.liveTranscript`에 동기화. 세션 재개 실패 시 직전 대화 요약을 신규 세션 프롬프트에 자동 주입하여 문맥 보존.
   - **끊긴 통화 자동 처리**: 마지막 조각 이후 2분 이상 인입 없으면 `pending_review`("복기 대기")로 자동 전환. 앱 재오픈 시 **"끝나지 않은 통화가 있어요. 복기할까요?"** 모달 자동 노출.
   - **화면 꺼짐 방지 & 안내**: 통화 화면에 "통화 중에는 화면을 켜 두세요" 안내 배너 및 10초 녹음 카운터 표시, Screen Wake Lock API 자동 요청.
   - **스토리지 보관함 인스펙터**: 설정 모달 내 "녹음 보관함 (Storage Chunks)" 탭에서 실제 저장된 10초 오디오 파일 및 1분 전사본 목록 직접 확인.
2. **B-2 실시간 통화 엔진 (`geminiLiveProvider.ts`, `NewCallScreen.tsx`)**:
   - `gemini-3.8-live` 세션 재개(Session Resumption) 및 컨텍스트 창 압축(Sliding Window) 기본 탑재 (15분 이상 장시간 대화 유지).
   - GoAway 수신 및 네트워크 단절 시 자동 재연결(화면에 "연결 유지 중" 표시).
   - **브라우저 직접 연결 최적화 (수정 지시서 2-1)**:
     - `BidiGenerateContentConstrained?access_token=${token}` 정식 주소 규격 및 `@google/genai` v1alpha 임시 토큰 발급 (`uses: 1`, `expireTime: +30m`, `newSessionExpireTime: +1m`).
     - Gemini의 `setupComplete` 수신 시에만 연결됨 판정 (8초 타임아웃 및 조기 종료 시 서버 프록시로 투명 전환).
     - 재연결 시 신규 토큰 발급 및 `resumeHandle` 지속 유지.
     - 연결 경로 콘솔 로깅(`[Live] path=direct` / `[Live] path=proxy`) 및 Firestore `sessions` 문서에 `connectionPath`, `directFailCount` 저장.
   - 오늘 수업 지시서 주입 (`src/data/lessonPromptBuilder.ts`): 목표, 과 내용, 복습 대상 실수 최대 3개.
   - 5대 제어 버튼: Done / Feedback / Model answer / Pause / Slow.
   - Live 자체 받아쓰기 실시간 화면 롤링 표시 및 `sessions.liveTranscript`에 보조 저장.
2. **Firebase 1인 전용 보안 및 클라우드 동기화**:
   - `episode.kim@gmail.com` 단일 계정 엄격 화이트리스트 검증 (`src/services/firebase/auth.ts`).
   - Firestore 엔티티 블루프린트(`firebase-blueprint.json`) 및 ABAC 보안 규칙(`firestore.rules`).
   - Cloud Storage(`src/services/firebase/storage.ts`) 연동.
3. **4대 목표 데이터 & 부록 원문 프롬프트 보존 (`src/data/defaultGoals.ts`)**:
   - OPIc AL (14과), 필리조선소 주재원 (15과), 미국·호주 여행 (13과), Bluey 듣기 (12과).
   - 마스터 체크리스트 부록 튜터 프롬프트 원문 100% 무삭제 보존.
   - 요일별 집중 루틴: 월·토 OPIc, 화·목 Philly, 수 Bluey, 금 여행, 일 주간 복기.
4. **프롬프트 슬롯 커스터마이징 (`src/data/promptCustomizer.ts`)**:
   - `[직무]`, `[Survey topics I chose]`, `[My role in Philly]`, `[Recent weak points]`를 설정 모달에서 사용자가 직접 입력 및 저장.
5. **첫 실행 진도 설정 & 오늘 수업 카드 UI (`src/ui/onboarding/`, `src/ui/home/`)**:
   - 첫 실행 시 OPIc 10/10 1과, 10/11 2과, 10/12 3과 히스토리를 반영한 진도 설정 모달 제공.
   - 홈 화면 요일별 루틴 뱃지, 오늘 요일에 해당하는 수업 카드 및 즉시 통화 시작 버튼.

---

## 4. 버전 히스토리
- **v2.3.0 (2026-10-13 KST)**: [Phase 1: B-3 통화 중 녹음 (끊김 대비) 완성] 10초 단위 마이크 청크 녹음(IndexedDB 선저장 -> Cloud Storage 업로드), Live 연결 상태와 무관한 독립 녹음, 1분 단위 gemini-3.5-transcribe VERBATIM 비동기 전사(sessions.sttPartial), Live 세션 재개 실패 시 직전 대화 요약 프롬프트 자동 주입, 끊긴 통화 자동 처리(마지막 조각 2분 경과 시 pending_review 자동 전환) 및 "끝나지 않은 통화가 있어요. 복기할까요?" 복구 모달, 화면 꺼짐 방지(Screen Wake Lock & 안내 배너), 설정 모달 내 녹음 보관함(Storage Chunks) 인스펙터 탑재.
- **v2.2.1 (2026-10-13 KST)**: [수정 지시서 2-1: 브라우저 직접 연결 최적화] BidiGenerateContentConstrained?access_token=${token} 정식 규격, v1alpha 임시 토큰(uses:1, expire:30m, newSessionExpire:1m), setupComplete 수신 기반 엄격한 연결 판정, GoAway 신규 토큰 발급 및 handle 유지, connectionPath / directFailCount 텔레메트리.
- **v2.2.0 (2026-10-13 KST)**: [Phase 1: B-2 실시간 통화(대화용) 완성] gemini-3.8-live 세션 재개 & 컨텍스트 압축, GoAway 자동 재연결(연결 유지 중), 임시 토큰 직결 및 서버 프록시 2중화, 오늘 수업 지시서(목표·과·복습실수 3개) 주입, 5대 제어 버튼(Done/Feedback/Model/Pause/Slow), Live 자체 받아쓰기 sessions.liveTranscript 저장, NewCallScreen UI 탑재.
- **v2.1.0 (2026-10-13 KST)**: [Phase 1: 1단계 뼈대 구축 완료] Firebase 단일 계정(episode.kim@gmail.com) 인증, Firestore/Cloud Storage 연동, Part B-1 models.ts 및 Provider 인터페이스 뼈대, 4대 목표 부록 원문 프롬프트 영구 저장, 첫 실행 진도 입력 모달, 오늘 수업 카드 UI 완성.
- **v2.0.0 (2026-10-13 KST)**: AI 1:1 전화영어 올인원 랩 전면 개편. 4대 집중 트랙 및 10/10~1/9 일자별 스케줄러 엔진, 통화 종료 후 정밀 복기 리포트, Mistake Vault, 아침 7시 맞춤형 복습 팟캐스트 및 텔레그램 연동.
- **v2.0.0 (2026-10-13 KST)**: AI 1:1 전화영어 올인원 랩 전면 개편. 4대 집중 트랙 및 10/10~1/9 일자별 스케줄러 엔진, 통화 종료 후 정밀 복기 리포트, Mistake Vault, 아침 7시 맞춤형 복습 팟캐스트 및 텔레그램 연동.
- **v1.2.2**: 한국어 귀 고정 (Korean Ear Lock), 점진적 폴백 체계.
- **v1.2.1**: P4 오디오 관측 인스펙터 탑재, 2초 16kHz WAV 원음 검증기.
- **v1.2.0**: Grok 검수 수용, 단일 오디오 소스(Single Ear) 아키텍처 개편.
- **v1.1.0**: Gemini 2.5 Flash Native Audio 정식 연동.
- **v1.0.0**: 풀스택 음성 통화 웹앱 초기 릴리즈.
