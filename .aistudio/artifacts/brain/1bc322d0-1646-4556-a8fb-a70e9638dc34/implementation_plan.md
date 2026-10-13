# [One Call English] AI 1:1 전화영어 올인원 랩 (Master English Lab)

> 사용자가 기존에 여러 도구(Claude, Gemini Live, Google Keep, Grok, ElevenLabs, Telegram)를 오가며 수동으로 관리하던 7단계 실전 영어회화 파이프라인을 **단 하나의 통합 웹/모바일 앱에서 원클릭으로 완벽하게 자동화**하는 종합 AI 전화영어 플랫폼으로 전면 개편합니다.

---

### User Review & Critical Decisions

> [!IMPORTANT]
> **확인된 사용자 전용 워크플로우 및 핵심 요구사항**
> 1. **4대 집중 트랙 완벽 내장**: 🎯 OPIc 코치 (AL 등급 목표), 🏭 Philly 출근 (한화 필리 조선소 실전 업무), ✈️ 여행 (미국/호주 실전 상황극), 🦘 Bluey 리스닝 (호주 슬랭 & 리스닝).
> 2. **일자별 스케줄러 & 'Next Lesson' 엔진**: 10/10 시작 기준 7주+12월 전체 커리큘럼 및 요일별 루틴(월: OPIc, 화: Philly, 수: Bluey, 목: Philly, 금: 여행, 토: OPIc 실전, 일: 주간 복기) 자동 트래킹.
> 3. **실시간 통화 + 음성 명령 인터랙션**: "Next lesson", "Answer starts ... Done", "Feedback please", "Model answer", "Pause", "Exam mode" 등 실전 명령어 지원.
> 4. **통화 종료 후 자동 복기 (Mistake Log)**: 통화 종료 즉시 AI가 전체 대화를 분석하여 `[내가 한 말 -> 자연스러운 표현 -> 이유]` 표, 꼭 외울 표현 5개, 예상 레벨, Mistake Log 카드 자동 생성.
> 5. **아침 복습 오디오 팟캐스트 & 알림 루프**: 누적된 미완료 Mistake Log를 모아 아침 7시 출근길용 1:1 맞춤형 복습 오디오 강의(Gemini TTS / ElevenLabs 연동)를 생성 및 재생하고, 텔레그램으로 전송 가능.

---

## 1. Overview & Core Concept

- **What It Does**: 
  - 4개 맞춤형 트랙의 일자별 커리큘럼에 맞춰 AI와 실시간 음성 통화를 진행하고, 통화 종료 시 원클릭으로 정밀 복기 리포트와 실수 노트를 자동 추출하며, 미완료 실수를 엮은 아침 복습 오디오 강의까지 제공하는 완성형 AI 전화영어 애플리케이션입니다.
- **Target Audience / Persona**:
  - 오픽 AL 달성, 한화 필리 조선소 파견 근무 준비, 가족 미국/호주 여행, 아이와의 블루이 시청을 동시에 준비하며 매일 20~30분 규칙적인 영어 훈련을 실천하는 학습자.
- **Key Value**:
  - 프롬프트 복사-붙여넣기, Keep 목록 수동 관리, 별도 오디오 생성 툴 전환의 번거로움을 100% 제거하고, **"앱 실행 -> 오늘의 수업 통화하기 -> 자동 복기 리포트 확인 -> 다음 날 아침 복습 오디오 청취"**라는 끊김 없는 완벽한 학습 루프를 완성합니다.

---

## 2. User Experience & Visual Design

### Key User Flows

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. 홈 대시보드 (Today's Lesson)                                              │
│  - 오늘 요일/날짜 기준 추천 수업 카드 (예: 화요일 → 🏭 Philly 출근 1과)        │
│  - 4개 트랙 탭 전환 (🎯 OPIc / 🏭 Philly / ✈️ 여행 / 🦘 Bluey)              │
│  - 대형 전화 걸기 CTA: [오늘의 Lesson N 시작하기 ("Next Lesson")]            │
│  - 상단: 복습 대기 중인 실수 (예: 3개 미완료) & [아침 복습 오디오 듣기] 버튼  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. 실시간 전화영어 화면 (Call Screen)                                        │
│  - 원어민 튜터 인터랙션 (미국 표준 / 필라델피아 동료 / 호주 로컬 악센트)     │
│  - 실시간 오디오 파형/오브 & 빠른 음성 제어 툴바                            │
│    ("Next lesson", "Answer starts/Done", "Feedback", "Pause", "Slow")        │
│  - 실시간 자막 (선택적 켜기/끄기) & 통화 타이머 (20~30분 목표 표시)          │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. 통화 종료 후 즉시 복기 화면 (Post-Call Review & Mistake Log)              │
│  - 1줄 총평 & 예상 레벨 (IM2 / IH / AL)                                      │
│  - 정밀 교정 표: [내가 한 말] → [원어민 자연스러운 표현] (이유 & 발음 팁)    │
│  - 오늘의 필수 암기 표현 5선 & 원클릭 발음 듣기                              │
│  - Mistake Log 자동 저장 (Google Keep 스타일 카드 뷰)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. 아침 복습 오디오 & 실수 보관함 (Morning Review & Mistake Vault)          │
│  - 미완료 실수들을 묶어 3~5분짜리 1:1 맞춤형 복습 팟캐스트 스크립트 생성     │
│  - Gemini 3.8 TTS로 생성된 오디오 플레이어 (재생, 10초 되감기, 배속)        │
│  - 텔레그램 Webhook/봇 설정으로 매일 아침 오디오 전송 지원                   │
│  - 복습 완료 체크박스로 완벽한 망각 방지                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Visual Identity & Theme
- **Aesthetic Direction**: 신뢰감 있는 프리미엄 에듀테크 & 아늑한 개인 코칭 스튜디오 감성.
- **Color Palette**:
  - Background Canvas: 심야 서재의 차분한 다크 슬레이트 베이스 (`#0F141C` ~ `#161D2A`).
  - Card Surfaces: 정갈한 표면 톤 (`#1C2433`, hairline border `border-slate-800`).
  - Primary Accent: 세련된 웜 골드/앰버 (`#F59E0B` / `#FBBF24`) 및 오픽 AL 에메랄드 (`#10B981`).
  - 4대 트랙별 시그니처 틴트:
    - 🎯 OPIc: 에메랄드 그린 (`#10B981`)
    - 🏭 Philly: 인더스트리얼 스틸 블루 (`#38BDF8`)
    - ✈️ 여행: 선셋 코랄 앰버 (`#FB923C`)
    - 🦘 Bluey: 오스트레일리안 스카이 (`#60A5FA` / `#818CF8`)
- **Typography & Hierarchy**:
  - Display Font: `Plus Jakarta Sans` (세련된 서구권 모바일 앱 감성).
  - Body Font: 가독성 높은 `Pretendard / DM Sans`.
  - Tabular Numbers: `font-mono tabular-nums` (통화 시간, 레벨 지표, 날짜).
- **Anti-Slop Discipline**:
  - 메타데이터에 유치한 캔디 알약(Pill)을 씌우지 않고 깔끔한 `·` 구분 기호와 서체 크기로 계층 표현.
  - 상단 바는 단일 헤더 규격 준수, 모든 버튼은 44px 이상의 터치 타깃과 명확한 피드백 제공.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: 4대 트랙의 프롬프트 & 커리큘럼 하드코딩 + 사용자 커스텀 허용**
  - *Chosen Approach*: 사용자가 공유한 마스터 체크리스트의 시스템 프롬프트(규칙, 피드백 형식, 페르소나)와 일자별 커리큘럼(10/10 시작 날짜 테이블)을 완벽한 기본 데이터셋으로 내장하되, 직무나 서베이 주제를 수정할 수 있는 커스텀 에디터 제공.
  - *Why*: 앱을 설치하자마자 별도 프롬프트 입력 없이 즉시 오늘 날짜(10/12 등)에 맞는 수업으로 바로 통화할 수 있습니다.
- **Decision 2: 통합 음성 통화 엔진 (Gemini Live Native Audio & Fallback HTTP+TTS)**
  - *Chosen Approach*: 기존 `server.ts`의 WebSocket 기반 Gemini Live 오디오 파이프라인을 그대로 계승하여 초저지연 양방향 음성 통화를 유지하고, 통화 종료 시 `gemini-3.8-flash`를 통해 Mistake Log와 복기 리포트를 1회 정밀 구조화(JSON Schema)로 생성.
  - *Why*: 음성 통화는 실시간 대화에 집중하고, 복기 분석은 정밀한 텍스트 모델이 맡아 오인식 교정 및 체계적인 표 생성을 완벽히 수행합니다.
- **Decision 3: Keep 연동 대체 및 보강 — 앱 내 자체 Mistake Vault + 원클릭 복사/웹훅**
  - *Chosen Approach*: 구글 킵 API의 인증 복잡도와 권한 제한에 구애받지 않도록, 앱 내부에 Keep과 똑같은 직관적인 카드형 실수 보관함(Mistake Vault)을 로컬스토리지/서버에 영구 보관하고, 원할 경우 "Keep에 붙여넣기" 원클릭 복사 기능 및 텔레그램 봇 전송 기능을 제공.
  - *Why*: 연결 실패 위험 없이 항상 안정적으로 작동하며 오프라인에서도 모든 복습 내역이 보존됩니다.
- **Decision 4: 아침 복습 오디오 팟캐스트 생성기 (Grok + ElevenLabs 파이프라인 내장)**
  - *Chosen Approach*: 서버의 Gemini 3.8 모델이 전날 미완료 Mistake Log를 바탕으로 "1:1 출근길 3분 복습 팟캐스트 스크립트"를 생성하고, 고품질 Gemini TTS로 음성 강의 MP3/WAV를 즉시 합성하여 앱 내 오디오 플레이어에서 바로 청취할 수 있도록 구현.

---

## 4. Technical Architecture & Data Strategy

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Client (React + Vite SPA)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│  [Top Bar]  Track Switcher (OPIc / Philly / Travel / Bluey)                 │
│  [Main View] Today's Schedule Card  │  Next Lesson CTA  │  Mistake Vault    │
│  [Call Screen] Audio Visualizer Orb │  Voice Controls   │  Live Transcript  │
│  [Review Modal] Error Table         │  Key Expressions  │  Level IM2/IH/AL  │
│  [Morning Podcast] Audio Player     │  Daily Script     │  Telegram Send    │
└───────────────────────┬─────────────────────────────────▲───────────────────┘
                        │ HTTP / WebSocket                │
┌───────────────────────▼─────────────────────────────────┴───────────────────┐
│                           Server (Express + tsx)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│  WS /live                → Gemini Live Native Audio (Real-time Speech)      │
│  POST /api/review        → Gemini 3.8 Flash (Generate Mistake Log Table)    │
│  POST /api/podcast       → Gemini 3.8 Flash (Morning Review Script)         │
│  POST /api/tts           → Gemini 3.8 TTS (Audio Lecture Synthesis)        │
│  POST /api/telegram/send → Telegram Bot API (Send Audio to User)           │
│  GET/POST /api/storage   → Curriculums, Progress, Mistake Records           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core Data Models

1. **LessonTrack**:
   - `id`: `'opic'` | `'philly'` | `'travel'` | `'bluey'`
   - `name`: 트랙명 (예: "🎯 OPIc 코치", "🏭 Philly 출근")
   - `systemPrompt`: 마스터 체크리스트에 정의된 전문 프롬프트
   - `lessons`: 각 레슨 번호, 타이틀, 상세 상황, 목표 표현
2. **ScheduleEntry**:
   - `date`: 날짜 (예: `2026-10-12`)
   - `dayOfWeek`: 요일 (월, 화, 수...)
   - `trackId`: 연결된 트랙 ID
   - `lessonIndex`: 해당 과 번호
   - `status`: `'pending'` | `'completed'` | `'skipped'`
3. **MistakeLogItem**:
   - `id`: 고유 ID
   - `date`: 생성일시
   - `trackId`: 트랙
   - `lessonTitle`: 레슨명
   - `myPhrase`: 내가 한 말
   - `naturalPhrase`: 원어민 자연스러운 표현
   - `reason`: 이유 및 문법/문화 팁
   - `reviewed`: 복습 완료 여부 (boolean)
4. **MorningPodcast**:
   - `id`: 고유 ID
   - `date`: 날짜
   - `title`: 팟캐스트 제목
   - `script`: 복습 강의 스크립트
   - `audioBase64`: 합성된 음성 오디오 데이터
   - `sourceMistakeIds`: 포함된 실수 목록

---

## 5. Step-by-Step Implementation Sequence

1. **커리큘럼 & 스케줄 데이터 파일 구축 (`src/data/curriculums.ts`, `src/data/schedule.ts`)**:
   - 제공된 마스터 체크리스트의 4개 트랙 프롬프트 및 10/10~1/9 전체 일자별 스케줄 테이블 완전 이식.
2. **서버 API 엔드포인트 확장 (`server.ts`)**:
   - `/api/review`: 대화 트랜스크립트 기반 Mistake Log & 예상 레벨 JSON 추출.
   - `/api/podcast`: 미완료 Mistake Log 기반 아침 복습 라디오 스크립트 및 TTS 음성 생성.
   - `/api/telegram/send`: 텔레그램 봇 토큰 및 Chat ID 연동 오디오 전송.
3. **홈 대시보드 개편 (`src/ui/home/HomeScreen.tsx`)**:
   - 오늘 날짜 스케줄 카드, 4대 트랙 선택 탭, "Next Lesson" 원터치 시작 버튼.
   - 미완료 실수 카운터 및 아침 복습 오디오 퀵 플레이어.
4. **전화 통화 화면 고도화 (`src/ui/call/CallScreen.tsx`)**:
   - 현재 진행 중인 과(Lesson) 정보 상단 표시.
   - 음성 명령어 단축키 버튼 ("Done", "Feedback", "Model answer", "Pause").
   - 통화 종료 시 즉시 Post-Call Review 화면으로 부드럽게 전환.
5. **복기 및 실수 보관함 컴포넌트 신설 (`src/ui/review/ReviewModal.tsx`, `src/ui/review/MistakeVault.tsx`)**:
   - 교정 표(내가 한 말 vs 원어민 표현), 필수 암기 표현 5선, 발음 오디오 청취.
   - Google Keep 연동용 원클릭 복사 블록 제공.
6. **아침 복습 오디오 팟캐스트 룸 신설 (`src/ui/podcast/MorningPodcastView.tsx`)**:
   - 전날 실수 기반 3분 맞춤형 음성 강의 생성 및 플레이어.
7. **컴파일 검증 & 최종 점검 (`compile_applet`)**:
   - 빌드 및 실행 안정성 최종 확인.
