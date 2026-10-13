# 오늘도 한 통 (One Call English) — AI 1:1 전화영어 올인원 랩

> **버전**: `v2.2.1` | **빌드**: `20261013-multilingual-1502` | **최종 갱신**: 2026-10-13 (KST)

여러 도구(Claude, Gemini Live, Google Keep, Grok, ElevenLabs, Telegram)로 분산되어 있던 실전 영어회화 학습 파이프라인을 **단 하나의 통합 웹/모바일 앱에서 원클릭으로 완벽하게 자동화**한 AI 1:1 전화영어 플랫폼입니다.

### 📌 [Phase 1: B-2 실시간 통화 및 2-1 브라우저 직접 연결 최적화 완료]
- **브라우저 직접 연결 최적화 (수정 지시서 2-1)**:
  - `BidiGenerateContentConstrained?access_token=${token}` 정식 주소 규격 적용 및 `@google/genai` v1alpha 임시 토큰 발급 (`uses: 1`, `expireTime: +30m`, `newSessionExpireTime: +1m`).
  - `setupComplete` 수신 시에만 연결됨 판정 (8초 타임아웃 및 에러 시 서버 프록시로 투명 폴백).
  - GoAway 및 재연결 시 신규 토큰 발급 + `resumeHandle` 지속 유지.
  - 연결 경로 콘솔 로깅(`[Live] path=direct` / `[Live] path=proxy`) 및 세션 종료 시 `connectionPath`, `directFailCount` Firestore 자동 저장.
- **B-2 실시간 음성 통화 (`gemini-3.8-live`)**:
  - **세션 재개(Session Resumption) & 컨텍스트 창 압축(Sliding Window Compression) 기본 적용**: 15분 이상 장시간 대화 지속 지원.
  - **GoAway 자동 재연결**: 서버의 GoAway 신호 및 일시적 연결 해제 감지 시 대화 문맥을 유지한 채 자동 재연결하며, 화면에는 "연결 유지 중" 상태를 직관적으로 표시.
  - **직접 연결 및 서버 중계 이중 파이프**: 브라우저 임시 토큰(`POST /api/gemini/token`)을 통한 직결 시도 및 실패 시 투명한 서버 프록시(`/api/gemini/live`) 자동 폴백.
  - **오늘 수업 지시서 주입**: 목표, 진행 과, 복습 대상 실수 최대 3개가 주입된 전문 프롬프트 빌더 탑재 (`src/data/lessonPromptBuilder.ts`).
  - **5대 핵심 제어 버튼**: `Done` (답변 종료 및 핵심 피드백), `Feedback` (즉시 피드백), `Model answer` (60초 AL 모범 답안), `Pause` (일시 정지), `Slow` (천천히 말하기).
  - **Live 자체 받아쓰기 보조 기록**: 실시간 발화 내역을 화면에 롤링 표시하고 통화 종료 시 `sessions.liveTranscript`에 보조 데이터로 저장.
  - **순수 공급자 인터페이스 격리**: 화면 UI(`NewCallScreen.tsx`)는 `LiveProvider` 인터페이스만을 호출하여 특정 벤더에 종속되지 않음.
- **Firebase 단일 계정 접근 제어 (B-1)**: `episode.kim@gmail.com` 1인 전용 Google 로그인, 비인가 계정 즉시 차단 및 자동 로그아웃, Firestore 및 Cloud Storage 연결.
- **4대 목표 데이터 & 요일 루틴 (B-9)**: OPIc AL (14과), 필리조선소 주재원 (15과), 미국·호주 여행 (13과), Bluey 듣기 (12과), 부록 원문 프롬프트 100% 무삭제 보존 및 변수 커스텀.

---

## 🚀 4대 집중 트랙 및 커리큘럼

1. **🎯 OPIc 코치 (AL 등급 목표)**:
   - 1~14과 체계적 커리큘럼: 자기소개, 집/동네 묘사, 설문 주제(영화·공원·여행), 롤플레이 A/B/C, 돌발 주제, 사회 이슈 비교, 15문항 실전 모의고사.
   - 답변 종료 시 즉시 예상 등급(IM2/IH/AL) 산출, 실수 2개 교정, AL 격상 표현 및 모범답안 제시.
2. **🏭 Philly 출근 (한화 필리 조선소 실전 업무)**:
   - 1~15과 현장 비즈니스: 첫 출근 인사, 아침 생산 회의, 지연 보고 및 만회 계획, 안전 Toolbox Talk, 용접/블록 결함 설명, 정중한 반대, 납기 독촉 전화, 필라델피아 로컬 스몰토크(Eagles/치즈스테이크), 본사 결정 전달 등.
   - 미국 현지 동료 특유의 빠른 구어체, 이디엄, 자연스러운 핑퐁 대화.
3. **✈️ 여행 (미국 · 호주 가족 여행)**:
   - 1~13과 실전 롤플레이: 미국 입국심사, 렌터카 누락 문제, 호텔 컴플레인, 레스토랑 주문 및 팁 계산, 아이 해열제 약국 구입, 호주 생물보안 검역, 로컬 카페(Flat white, babycino), 본다이 해변 안전, 놀이터 BBQ 스몰토크.
   - 미국 표준 억양 및 호주 로컬 슬랭(arvo, no worries, reckon, mate).
4. **🦘 Bluey 리스닝 (호주 애니메이션 90% 청취)**:
   - S1E01 ~ S1E13 전편 에피소드 기반: 3줄 줄거리 예습, 호주 슬랭/어휘 10개, 호주 모음 발음 포인트, 5편 단위 누적 퀴즈 및 섀도잉 악센트 드릴.

---

## 🌟 핵심 자동화 파이프라인

- **일자별 스케줄러 & 'Next Lesson' 엔진**: 10/10 시작 기준 7주+12월 전체 일자별 진도표 및 요일별 루틴(월: OPIc, 화: Philly, 수: Bluey, 목: Philly, 금: 여행, 토: OPIc, 일: 주간 복기) 자동 추적.
- **실시간 전화 통화 (Gemini Live Native Audio)**: 초저지연(~300ms) 양방향 16kHz PCM 스트리밍, 원터치 음성 명령어("Next lesson", "Answer starts/Done", "Feedback", "Pause", "Model answer", "Slower").
- **통화 종료 후 자동 복기 (Mistake Log)**: 대화 종료 즉시 전체 트랜스크립트를 정밀 분석하여 `[내가 한 말 -> 자연스러운 표현 -> 이유]` 표, 오늘 꼭 외울 표현 5선, Google Keep 양식 자동 생성.
- **실수 보관함 (Mistake Vault)**: Google Keep 스타일 카드 뷰로 실수 내역 영구 보존, 원클릭 복사, 복습 완료 체크.
- **아침 7시 맞춤형 복습 팟캐스트**: 미완료 실수를 엮어 Grok 스타일의 3분 출근길 오디오 강의 스크립트 작성 및 고품질 Gemini TTS 음성 생성.
- **텔레그램 봇 자동 발송**: 생성된 복습 오디오를 내 텔레그램으로 전송하여 출근길에 간편 청취.

---

## 🛠 실행 및 빌드

```bash
# 개발 모드 실행 (포트 3000)
npm run dev

# 프로덕션 빌드 & 테스트
npm run build
npm run lint
npm start
```
