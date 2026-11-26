# 작업지시서: AI Call 통화 비용 절감 아키텍처 심층 리서치 및 Live 실측·퀵윈 구현

- **문서 경로**: `docs/plan/work-order-live-cost-optimization.md`
- **작성일**: 2026-11-26
- **대상 프로젝트**: AI Call (One Call English)
- **작업 유형**: **2-트랙 병행 작업**
  - **Track 1 (리서치 & 의사결정 제안)**: 기존 대안 1·2·3의 최신 정보 재검증 + 추가 대안 탐색 + 최적 비용 절감 아키텍처 제안서 작성
  - **Track 2 (즉시 구현 — 계측 & 퀵윈)**: Gemini Live 실제 `usageMetadata` 토큰 계측·로깅 + 1분 임시 받아쓰기 기본값 OFF + 비용 계산식(`usageService.ts`) 갱신
- **핵심 규칙 (Phase Gate)**:
  > 본 작업지시서 단계에서는 **통화 엔진 자체를 임의로 교체하지 않는다.**
  > Track 1(최적 방법론 제안서)과 Track 2(실측 계측·퀵윈 코드)를 완료하고 실제 10분 통화 실측 데이터를 확보한 뒤, 프로덕트 오너의 최종 승인을 받아 다음 단계에서 통화 엔진 변경을 진행한다.

---

## 1. 배경 및 전체 논의 맥락

### 1-1. 문제 발단: 현재 앱의 일/월 API 원가 구조
사용자가 매일 **10분 AI 전화영어 통화 + 통화 후 복습 + 10문항 퀴즈 + 6분 아침 복습강의**를 모두 이용할 때(월 30일 기준), 현재 코드베이스(`src/config/models.ts`, `src/services/usage/usageService.ts`, `server/lecture.ts`, `src/services/review/reviewPipeline.ts`)와 **2026-11-25 공식 Gemini API 단가**로 산출한 원가는 아래와 같다.

#### 현재 사용 모델 및 단가 (2026-11-25 기준, `src/config/models.ts`)
| 구분 | 모델명 | 현재 단가 (USD / 1M tokens) | 비고 |
| --- | --- | --- | --- |
| 실시간 통화 | `gemini-3.8-live` | Text In `$0.75` / Audio In `$3.00` / Audio Out `$12.00` / Text Out·Thinking `$4.50` | 오디오 25 tok/s = 1,500 tok/분. 컨텍스트 캐싱 미지원, 턴마다 누적 오디오 재청구 |
| 받아쓰기(STT) | `gemini-3.5-transcribe` (`VERBATIM`) | Audio In `$2.00` (`$0.003/분`) / Text Out `$12.00` (~175 tok/분 → `$0.0021/분`) | 분당 약 `$0.0051`. 현재 기본값상 1분 임시 백업 + 최종 전사 **2회 수행** |
| 아침 강의 TTS | `gemini-3.8-flash-tts` | Text In `$0.50` / Audio Out `$9.00` (`$0.0135/분`) | **2027-01-01부터 2배 인상** (`$1.00` / `$18.00`) |
| 복습·퀴즈·강의 스크립트 | `gemini-3.8-flash` | Input `$0.75` / Output(Thinking 포함) `$3.75` | **2027-01-01부터 2배 인상** (`$1.50` / `$7.50`) |
| 단문 발음 재생 | `gemini-3.8-flash-lite-tts` | 극소량 | 복습 화면 "발음 듣기" 단문 재생 |
| 실수 군집 임베딩 | `Qwen/Qwen3-Embedding-4B` (Superlinked SIE) | `$0.06` / 1M tokens | 무시 가능한 수준 |

#### 일일 및 월간(30일) 토큰·비용 산출표 (앱 기본 가정치 기준)
앱의 `USAGE_ASSUMPTIONS` 기준: `audioTokensPerSec = 25`, `liveTurnsPerMin = 4` (10분 = 40턴), `liveModelTalkShare = 0.5`, `liveSystemPromptTokens = 1500`, `liveContextWindowTokens = 128_000`.

| 기능 / 모델 | 일일 토큰 사용량 (추정) | 일일 비용 (USD) | 월간 30일 비용 (USD) | 비중 |
| --- | --- | ---: | ---: | ---: |
| **10분 실시간 통화** (`gemini-3.8-live`) | 기본 Audio In `15,000` ($0.045) + 턴별 누적 재청구 Audio In `450,000` ($1.350) + 시스템 프롬프트 Text In `60,000` ($0.045) + Audio Out `7,500` ($0.090) | **$1.5300** | **$45.90** | **86.5%** |
| **받아쓰기 STT 20분** (`gemini-3.5-transcribe`, 1분 임시 10분 + 최종 10분) | Audio In `30,000` + Text Out `3,500` | **$0.1020** | **$3.06** | **5.8%** |
| **6분 아침 복습강의 TTS** (`gemini-3.8-flash-tts`, 총 365초 중 묵음 ~40초 제외 실음성 ~325초 ≈ 5.4분) | Text In `~2,000` + Audio Out `~8,125` | **$0.0741** | **$2.22** *(6분 상한 $2.46)* | **4.2%** |
| **복습·강의 보강·퀴즈 10문항·강의 대본·실수 묶기** (`gemini-3.8-flash`) | Input `~19,000` + Output(Thinking 포함) `~12,600` | **$0.0615** | **$1.85** | **3.5%** |
| **기타** (단문 발음 TTS + SIE 임베딩) | 극소량 | `< $0.0030` | `< $0.09` | `< 0.2%` |
| **합계 (2026-11-25 단가 기준)** | — | **$1.7676** | **$53.03** *(약 ₩74,200 @ ₩1,400/$)* | **100%** |

- **민감도(현실 구간)**: 대화 템포가 느린 편(2.5턴/분, 튜터 발화 비중 30%)이면 `gemini-3.8-live`가 일 ~$0.86(월 $25.75)까지 내려가 총 **월 $33~$53 (약 4.6만~7.4만 원)** 범위에 위치한다.
- **2027년 1월 1일 단가 인상 리스크**: `gemini-3.8-flash`와 `gemini-3.8-flash-tts`의 프로모션 단가가 종료되어 2배가 되면, 동일 사용량 기준 **월 +$4.07 추가 상승** → 총 **약 $57.10/월 (약 8만 원)**에 도달한다.

#### 비용 폭증의 근본 원인 (코드베이스 실사 결과)
1. **Live 누적 컨텍스트의 $T^2$ 재청구**: `gemini-3.8-live`는 컨텍스트 캐싱을 지원하지 않아 매 턴마다 지금까지 쌓인 오디오 대화 이력이 다시 Audio Input(`$3.00/1M`)으로 재청구된다. 전체 Live 비용($1.53/일)의 **88%($1.35/일)**가 이 재청구에서 발생한다.
2. **컨텍스트 압축이 사실상 꺼져 있음**:
   - 클라이언트 직연결(`src/services/providers/liveWire.ts:114-116`)과 서버 중계(`server/liveConfig.ts:56-58`) 모두 `contextWindowCompression: { slidingWindow: {} }`만 보내고 `triggerTokens`와 `targetTokens`를 지정하지 않았다.
   - 미지정 시 기본 임계치는 컨텍스트 윈도우(128k)의 80%(약 102.4k 토큰 ≈ 약 45분 분량)이므로 **10분 통화(누적 ~22.5k 토큰)에서는 압축이 단 한 번도 발동하지 않는다.**
3. **실측 토큰 블라인드 상태**: 서버 프록시(`server.ts`)와 클라이언트(`geminiLiveProvider.ts`) 모두 Gemini Live가 내려주는 `usageMetadata`를 파싱·로깅하지 않아, 실제 과금 토큰이 추정식과 얼마나 차이 나는지 앱에서 확인할 수 없다.
4. **STT 2중 과금**: `onecall_enable_partial_transcribe` 기본값이 ON(`!== "false"`)이라 통화 중 1분마다 `/api/gemini/transcribe-partial`을 호출하고, 통화 종료 후 `/api/gemini/transcribe-final`을 또 호출해 STT 비용이 2배 발생한다. 이미 10초 단위 오디오 청크 백업(IndexedDB + Firebase Storage)이 존재하므로 상시 1분 임시 전사는 과잉이다.

---

### 1-2. 국내 영어회화 경쟁 앱과의 가격 비교
| 서비스 | 유형 | 국내 월 구독가 (2026 기준) | 비고 |
| --- | --- | --- | --- |
| **말해보카** | AI 어휘·회화 앱 | ~₩8,250/월 (연 9.9만) / 월결제 ₩19,500 | 대중형 구독 |
| **스픽 (Speak)** | AI 영어회화 앱 | ~₩9,000~₩19,000/월 (연간) / 월결제 ₩29,000 | 국내 대표 AI 회화 |
| **듀오링고 슈퍼** | 어학 앱 | ~₩9,000~₩11,000/월 | 대중형 구독 |
| **링글 AI 튜터** | AI 스피킹 단독 | ₩20,000 미만/월 | 프리미엄 브랜드의 AI 단독 상품 |
| **ChatGPT Plus** | 범용 AI (음성 포함) | ₩29,000/월 ($20) | 다목적 AI |
| **민병철유폰 (사람 전화영어)** | 원어민 주 5회 10분 | ~₩78,000/월 (48주 기준) | 실제 사람 강사 |
| **링글 / 캠블리 (사람 화상)** | 1:1 원어민 화상 | ₩140,000~₩300,000+/월 | 프리미엄 1:1 |
| **현재 AI Call (순수 API 원가)** | AI 전화영어 + 복습 + 강의 | **원가만 ₩46,000~₩74,000/월 ($33~$53)** | **인프라·결제수수료·마진 0원 기준** |

- **결론**: AI 앱의 순수 API 원가만 월 5~7만 원대이면, 원어민 사람 전화영어(월 7.8만 원)와 가격 차이가 거의 없어져 **서비스 가격경쟁력이 성립하지 않는다.**
- **목표 원가 구간**: 전체 월 원가를 최소 **$20/월(₩28,000) 이하**, 이상적으로는 **$10~$15/월(₩14,000~₩21,000) 수준**까지 낮추는 것이 목표다.

---

### 1-3. 핵심 제품 원칙: "일문일답(무전기식)" 전환 불가 — 전화영어 체감 유지
비용 절감을 논의하는 과정에서 단순 턴제 `STT → Flash(텍스트) → TTS` 방식이 검토되었으나, 프로덕트 오너는 다음 이유로 **단순 무전기식(일문일답) 전환을 거부**했다.
- 프로젝트 이름 자체가 **"AI Call"**이며, 핵심 정체성은 **원어민과 실제 전화를 거는 듯한 실시간 통화 경험**이다.
- 단순 일문일답(발화 끝 감지 → 전체 STT 완료 대기 → LLM 전체 생성 대기 → TTS 완료 대기)은 턴당 1.5~3초 이상 공백이 생기고, AI가 말할 때 끼어들기(Barge-in)나 자연스러운 맞장구가 불가능해 전화영어 품질이 급격히 떨어진다.
- **비타협 UX 기준**:
  1. 발화 종료 후 첫 음성 응답까지 체감 지연 **1초 이내** (가능하면 0.5~0.8초대).
  2. 튜터 발화 중 사용자가 말을 끊고 끼어드는 **자연스러운 Barge-in** 유지.
  3. 한국어 질문 + 영어 답변이 섞이는 **한영 코드스위칭** 상황에서도 자연스러운 이해 및 코칭.
  4. 기존 **10초 오디오 청크 백업 + 통화 후 정확한 발화 전사(복습) + 아침 6분 복습강의** 파이프라인 품질 유지.

---

## 2. Track 1 — 아키텍처 대안 심층 리뷰·최신 재검증·추가 대안 탐색 및 최적 방법론 제안

> **목표**: 아래 기존 3가지 대안을 **작업 시점의 최신 공식 문서·가격표·벤치마크 기준으로 재검증**하고, 그 외 **더 나은 대안/하이브리드 조합이 없는지 추가로 깊이 탐색**한 뒤, AI Call에 가장 적합한 **최적 방법론과 실행 로드맵**을 제안서로 제출한다.

### 2-1. 기존 논의된 3가지 대안 (재검증 대상)

#### 대안 1. `gemini-3.8-live` 유지 + 공격적 `contextWindowCompression` + 임시 STT OFF
- **핵심 아이디어**: 모델과 네이티브 음성 품질(발음·억양 청취, 바지인, 초저지연)은 100% 유지하면서, 현재 사실상 미작동 중인 `contextWindowCompression`에 `triggerTokens: 5000~7000`, `targetTokens: 2500~3500` 수준을 명시해 누적 오디오 재청구($T^2$)를 선형($T$)에 가깝게 꺾는다.
- **사전 추정 비용**: Live 월 $45.9 → **~$14~$20/월**, 총 원가 **~$20~$25/월 (₩28,000~₩35,000)**.
- **워커가 반드시 재검증할 항목**:
  - 공식 Gemini Live API 최신 문서에서 `triggerTokens` / `targetTokens` 최소 허용치, `systemInstruction` 보존 여부, 압축 발동 시 실제 지연시간(latency spike) 발생 여부.
  - 압축으로 인해 2~3분 전 대화 세부 내용이 잘릴 때 10분 영어회화 레슨 품질이 어느 정도 저하되는지.
  - **중요**: Track 2의 `usageMetadata` 계측 구현 후, 실제 10분 통화에서 압축 전/후 실제 과금 토큰이 이론대로 줄어드는지 실측 검증할 수 있도록 실험 설계 포함.

#### 대안 2. 분당 정액(Flat Per-Minute) 실시간 Voice Agent API 전환
- **핵심 아이디어**: 턴마다 과거 오디오가 재청구되는 $T^2$ 과금 구조를 원천 제거하고, **통화 시간(분)에 정확히 비례하는 정액형 실시간 음성 에이전트 플랫폼**을 도입한다.
- **사전 검토 후보**:
  - **Cartesia Managed Agents**: ~$0.03/분 + LLM 별도 → 300분/월 기준 통화 ~$9~11/월, 총 **~$17/월**.
  - **Deepgram Voice Agent (BYO Gemini Flash)**: ~$0.05/분 + LLM 별도 → 통화 ~$15/월, 총 **~$21.5/월**.
  - **xAI Grok Voice Agent (`grok-voice-3.0`)**: ~$0.08/분 (네이티브 S2S) → 통화 ~$24/월, 총 **~$29.6/월**.
- **워커가 반드시 재검증할 항목**:
  - 각 플랫폼의 **최신 공식 가격·무료 티어·과금 단위(초당/분당, 묵음 포함 여부)** 재확인.
  - 한국어·영어 혼합 발화(한영 코드스위칭) 인식률 및 영어 튜터 억양/자연스러움.
  - 브라우저(모바일 Android PWA 포함) WebSocket/WebRTC 연동 안정성, 기존 `server.ts` Express 아키텍처 통합 난이도, 제3자 API 키/결제 운영 부담.

#### 대안 3. 풀듀플렉스 스트리밍 파이프라인 (Full-Duplex Streaming STT → Flash → TTS + VAD + Barge-in)
- **핵심 아이디어**: 답답한 무전기식 일문일답이 아니라 **문장/음절 단위 병렬 스트리밍**으로 전화 느낌을 구현한다. 사용자가 말하는 도중 실시간 스트리밍 STT가 텍스트를 뽑고, VAD(음성 활동 감지)가 발화 끝을 0.2~0.3초 만에 포착하면, `gemini-3.8-flash`(텍스트 스트리밍 + Context Caching)가 첫 절을 생성하자마자 스트리밍 TTS가 즉시 재생을 시작하며, 사용자가 끼어들면 즉시 오디오 버퍼를 비워 바지인한다. (LiveKit Agents, Pipecat, 또는 경량 자체 WebSocket 오케스트레이터 활용)
- **사전 추정 비용**: 스트리밍 STT(Deepgram Nova-3 등) + Flash 텍스트(캐싱) + 스트리밍 TTS(Cartesia Sonic / Deepgram Aura-2 등) 합산 통화 **~$3.5~$5/월**, 총 원가 **~$10~$12/월 (₩14,000~₩17,000)**.
- **사전 추정 체감 지연**: ~0.6~0.9초.
- **워커가 반드시 재검증할 항목**:
  - 각 컴포넌트(STT, LLM, TTS, 오케스트레이터)의 최신 가격·한국어/영어 동시 지원 품질·TTFB 실측치.
  - 원음 오디오가 아닌 텍스트만 LLM에 전달될 때 **발음·억양 교정 품질 저하**를 어떻게 보완할지(예: 통화 후 `gemini-3.5-transcribe` VERBATIM + 복습 파이프라인과의 역할 분담).
  - Android 모바일 브라우저(기존 에코 게이트·마이크 처리 제약 포함)에서의 안정성 및 서버 운영 비용(Cloud Run 등에서의 상시 WebSocket/WebRTC 유지 비용 포함).

---

### 2-2. 워커 필수 추가 탐색 항목 (더 나은 대안 / 하이브리드 방법론 고민)
기존 3가지 대안에 갇히지 말고, 아래 방향을 포함해 **더 적은 리스크로 더 큰 절감을 낼 수 있는 대안**을 적극적으로 발굴·검증하라.

1. **클라이언트/서버 VAD 침묵 구간 PCM 전송 차단 (Silence Gating on Gemini Live)**:
   - 현재 앱은 통화 중 침묵·숨 고르기·튜터 발화 대기 구간에도 16kHz PCM을 계속 `realtimeInput.audio`로 전송할 가능성이 크다(25 tok/s 소모).
   - 클라이언트 VAD(또는 기존 에코 게이트 로직 확장)로 무음 구간 PCM 송신을 차단하고 `audioStreamEnd` 또는 `activityStart`/`activityEnd`(수동 VAD 모드)를 쓰면 `gemini-3.8-live` 오디오 입력 토큰과 누적 컨텍스트를 얼마나 더 줄일 수 있는지, 바지인/응답 지연에 부작용이 없는지 조사하라.
2. **롤링 텍스트 요약 핸드오프 (Rolling Summary Session Handoff)**:
   - 공격적 압축 시 기억력 손실이 문제라면, 3~4분마다 비동기 `gemini-3.8-flash`로 핵심 대화 요약을 갱신하고 Live 세션을 자연스럽게 이어받거나 컨텍스트를 압축·치환하는 하이브리드 구조의 실효성 검토.
3. **최신 경량 Realtime / Native Audio 모델 및 타사 S2S 모델 비교**:
   - 작업 시점 기준 Gemini Live 계열 신규/경량 모델(예: Flash-Lite Live 등 존재 여부), OpenAI Realtime Mini 계열(`gpt-realtime-mini` 등), 기타 최신 네이티브 음성 모델의 실제 분당/토큰 단가 및 한영 품질 비교.
4. **시스템 프롬프트 및 비(非)통화 파이프라인 최적화 (2027-01-01 2배 인상 선제 대응)**:
   - `src/data/lessonPromptBuilder.ts`의 시스템 프롬프트(~4.3KB, 1,500 tok/turn → 매 턴 재청구)를 경량화했을 때의 절감 효과.
   - 2027-01-01 `gemini-3.8-flash` 및 `gemini-3.8-flash-tts` 단가 2배 인상(+월 $4.07)에 대비해 복습·퀴즈·6분 아침강의 비용을 줄일 수 있는 방법(예: `gemini-3.8-flash-lite` / `flash-lite-tts` 적용 가능 영역, thinking budget 제어, 프롬프트 캐싱 등).
5. **하이브리드 결합 시나리오**:
   - 예: `[대안 1 공격적 압축 + VAD 무음 전송 차단 + 프롬프트 경량화 + 임시 STT OFF]` 결합 시 월 원가가 $12~$15 이하로 내려가는지 계산하여, 엔진 전면 교체(대안 2·3) 대비 ROI를 비교하라.

---

### 2-3. Track 1 필수 산출물 형식
별도 리포트 문서(예: `docs/plan/live-cost-optimization-proposal.md`)에 아래 항목을 포함해 제출한다.
1. **최신 공식 단가 검증표** (조사 날짜 및 공식 출처 URL 명시, 2026 단가 vs 2027-01-01 단가 병기).
2. **전체 대안 비교 매트릭스** (대안 1, 대안 2 후보군, 대안 3, 신규 발굴 대안 4·5, 하이브리드안):
   - 월 30일 예상 원가 (2026 / 2027 기준, 인프라 비용 포함)
   - 체감 응답 지연(TTFB)
   - 바지인(끼어들기) 자연스러움
   - 한영 혼합 발화 인식 정확도
   - 발음·억양 직접 청취 가능 여부
   - 구현 공수 / 기존 오디오·복습·강의 파이프라인 호환성 / 운영 리스크
3. **최종 추천 방법론 (1순위 + 차선책)** 및 선택 근거.
4. **단계별 실행 로드맵 및 PoC 검증 기준** (프로덕트 오너가 바로 Go/No-Go 결정을 내릴 수 있는 형태).

---

## 3. Track 2 — 즉시 구현 가능한 계측 및 퀵윈 작업 명세

> Track 1 리서치와 병행하거나 선행하여 아래 3가지 안전하고 독립적인 개선 작업을 구현한다. 이 작업들은 통화 엔진을 교체하지 않으면서 **즉시 비용을 줄이고(임시 STT OFF), 앞으로 모든 최적화의 성패를 숫자로 검증할 계측 기반(실측 토큰 로깅 + 정확한 비용 계산식)**을 확보하기 위한 것이다.

---

### 작업 2-1. Gemini Live 실제 토큰(`usageMetadata`) 계측 및 로깅

#### 현재 코드베이스 문제점
- **서버 중계 경로** (`server.ts` `/api/gemini/live` WebSocket `onmessage` 핸들러): `serverContent`, `sessionResumptionUpdate`, `goAway` 등은 처리하지만, Gemini Live 서버가 반환하는 `usageMetadata`를 추출하거나 클라이언트로 전달하지 않는다.
- **클라이언트 직연결 경로** (`src/services/providers/geminiLiveProvider.ts`, `src/services/providers/liveMessage.ts`): 마찬가지로 수신 JSON의 `usageMetadata`를 파싱·집계하지 않는다.
- 결과적으로 현재 앱의 Live 비용은 100% 추정식(`USAGE_ASSUMPTIONS`)에 의존하며, 추후 압축(`triggerTokens`/`targetTokens`)이나 VAD 게이팅을 적용해도 실제 절감 효과를 앱 내에서 확인할 방법이 없다.

#### 구현 요구사항
1. **양쪽 전송 경로 일관 수집**:
   - **직연결(direct)**: `src/services/providers/liveMessage.ts` 및 `src/services/providers/geminiLiveProvider.ts`에서 수신 메시지의 `usageMetadata`를 파싱해 콜백/이벤트로 전달한다.
   - **서버 프록시(proxy)**: `server.ts`의 Live `onmessage`에서 `serverMsg.usageMetadata`가 존재할 때 클라이언트로 전용 메시지 타입(예: `{ type: "usage_metadata", usageMetadata: ... }`)을 포워딩한다. (단, 기존 `server/usageMeta.ts` 패턴과 조화롭게 구성하고, `tests/serverNodeImports.test.ts` 규칙 준수)
2. **누적(Cumulative) vs 증분(Delta) 정확한 판별 및 집계**:
   - Gemini Live API의 `usageMetadata` 필드가 세션 내 **누적값인지 턴별 증분값인지** 공식 문서 및 실제 세션 응답으로 반드시 검증한 뒤 집계 로직을 작성한다(이중 합산 금지).
   - 가능한 세부 모달리티 토큰을 구분 수집한다:
     - `promptTokenCount`, `responseTokenCount`, `totalTokenCount`, `thoughtsTokenCount`, `cachedContentTokenCount`
     - `promptTokensDetails` / `responseTokensDetails` 내 `AUDIO` vs `TEXT` 모달리티별 토큰 합계 (필드가 존재할 때)
   - 세션 재연결(`sessionResumption`)이 발생해 새 WS 세션이 열릴 경우, 이전 연결의 확정 누적치를 보존하고 새 연결의 토큰을 이어서 합산한다.
3. **세션 종료 시 기록 및 개발자 로그**:
   - 통화 종료 시(`NewCallScreen.tsx` 및 `recoveredUsage.ts` 경로 점검) `recordUsage`에 실제 Live 토큰 수치를 함께 저장한다.
   - 개발자 모드 또는 콘솔에 1줄 요약 로그(예: `[live-usage] turns=... inAudio=... inText=... outAudio=... outText=... thoughts=... actualUsd=... estUsd=...`)를 남겨 추정치와 실측치를 즉시 비교할 수 있게 한다.
   - **보안/프라이버시**: 로그에는 숫자·메타데이터만 남기며 대화 텍스트나 오디오 base64는 절대 출력하지 않는다.
4. **단위 테스트**:
   - `tests/liveMessage.test.ts` 및 신규/기존 테스트에 `usageMetadata` 파싱, 모달리티별 합산, 재연결 시 누적 보존, 누락/비정상 페이로드 방어 케이스를 추가한다.

---

### 작업 2-2. 1분 임시 받아쓰기(`onecall_enable_partial_transcribe`) 기본값 OFF 전환

#### 현재 코드베이스 위치 및 동작
- `src/App.tsx` (약 79행 부근): `localStorage.getItem("onecall_enable_partial_transcribe") !== "false"` → 미설정 시 기본값 **ON**.
- `src/ui/settings/SettingsModal.tsx` (약 74행 부근): 동일한 키로 토글 UI 제공.
- `src/services/recording/chunkRecorder.ts`: 해당 플래그가 ON이면 통화 중 1분마다 `/api/gemini/transcribe-partial`을 호출.
- **절감 효과**: 10분 통화 기준 일 $0.0510 → **월 $1.53 절감** (STT 비용 50% 즉시 감소). 이미 10초 단위 오디오 청크가 IndexedDB + Firebase Storage에 백업되고 통화 종료 시 `/api/gemini/transcribe-final`이 전사하므로 데이터 안전성이 유지된다.

#### 구현 요구사항
1. **기본값 OFF 전환**:
   - 미설정(`null`) 상태의 기본값을 **OFF**로 변경한다 (`localStorage.getItem("onecall_enable_partial_transcribe") === "true"` 등 단일 헬퍼 함수로 통합해 `App.tsx`와 `SettingsModal.tsx`가 중복 판별하지 않도록 정리 권장).
2. **설정 화면 안내 문구 개선** (`SettingsModal.tsx` / `settingsText.ts`):
   - 기본 OFF의 이유와 안전성을 사용자가 안심하고 이해할 수 있게 명시한다.
   - 예: *"기본값: 꺼짐. 꺼져 있어도 10초 단위 오디오 자동 백업과 통화 종료 후 최종 받아쓰기는 정상 동작합니다. 켜면 통화 중 1분마다 임시 텍스트를 추가 생성해 받아쓰기 비용이 약 2배 발생합니다."*
3. **기존 강제 복구/중단 세션 흐름 무결성 확인**:
   - `interruptedSession.ts`, `UnfinishedSessionModal.tsx`, `reviewPipeline.ts`가 `partialTranscript`가 비어 있을 때도 10초 오디오 청크 병합 → 최종 STT로 정상 복구되는지 확인하고, 필요 시 테스트를 보강한다.

---

### 작업 2-3. 비용 계산식(`usageService.ts`, `learningLog.ts`, `models.ts`, `UsagePanel.tsx`) 갱신

#### 현재 코드베이스 문제점
1. **임시 받아쓰기 무조건 가산 버그** (`src/services/usage/usageService.ts:151-152`, `214-218`):
   ```ts
   const sttMin = nonNeg(u?.sttMinutes);
   const stt = (sttMin + liveMin + qaMin) * geminiSttPerMinute();
   ```
   1분 임시 받아쓰기가 OFF여도 `liveMin + qaMin`을 STT 비용에 무조건 더하고 있어, 작업 2-2를 적용해도 앱 내 예상 비용이 줄어들지 않고 과다 청구로 표시된다.
2. **실측 Live 토큰 및 압축 상한 미반영**:
   - `liveCost(minutes, sq)`는 고정 `USAGE_ASSUMPTIONS`(`liveContextWindowTokens = 128_000`)만 사용한다.
   - 작업 2-1에서 실제 `usageMetadata` 토큰이 저장되더라도 `priceUsage()`와 `estimateCostUsd()`가 이를 반영하지 못한다.

#### 구현 요구사항
1. **임시 받아쓰기 과금의 실제 호출 기반 분리**:
   - `partialSttMinutes` 필드를 별도로 기록하거나, `transcribe-partial`이 실제로 성공 호출된 경우에만 `sttMinutes`(또는 `partialSttMinutes`)에 누적되도록 변경한다.
   - `priceUsage()`와 `estimateCostUsd()`에서 `liveMin + qaMin`을 STT에 무조건 더하는 로직을 제거한다. (단, 기존 Firestore에 저장된 과거 월간 문서와의 하위호환 동작을 코드 주석으로 명확히 문서화한다.)
2. **실측 Live 토큰 우선 계산 + 추정식 폴백**:
   - `UsageDelta` / `UsageDay` / `UsageMonth` / `UsageFields`에 Live 실측 토큰 필드(예: `liveInputAudioTokens`, `liveInputTextTokens`, `liveOutputAudioTokens`, `liveOutputTextTokens`, `liveThoughtTokens` — QA 세션 분리 여부는 기존 `live`/`qaLive` 구조에 맞춰 깔끔하게 설계)를 추가한다.
   - `PRICING_RATES` (`src/config/models.ts`)에 누락된 Live 텍스트 출력/사고 단가(`liveOutTextPer1M: 4.5`)가 필요하면 추가하되, **기존 모델명 상수는 절대 변경하지 않는다.**
   - `priceUsage()`에서 실측 Live 토큰이 기록된 세션/일/월은 `PRICING_RATES` 단가로 실측 비용을 산출하고, 실측 토큰이 없는 과거 데이터(또는 일부만 기록된 혼합 월)는 잔여 분량에 대해서만 기존 `liveCost()` 추정식을 적용하도록 정합성을 맞춘다(혼합 월에서 이중 계산이나 과소 계산이 나지 않도록 주의 — 예: 실측 기록된 `liveActualMinutes`를 별도 기록하거나 일별 `days` 합산 방식 검토).
3. **압축 상한 파라미터화 (`src/services/usage/learningLog.ts`)**:
   - `liveContextMinutesSq(minutes, windowTokens?)`가 기본 `USAGE_ASSUMPTIONS.liveContextWindowTokens` 외에 추후 `contextWindowCompression`의 `targetTokens`/`triggerTokens` 설정값을 받아 추정할 수 있도록 확장 가능하게 정리한다.
4. **UI 및 불변식 유지**:
   - `USAGE_COST_COMPONENTS`와 `sumUsageCostComponents()`의 합계 불변식을 반드시 유지한다.
   - `src/ui/settings/UsagePanel.tsx`에서 개발자 모드 비용 표에 실측 기반인지 추정 기반인지(또는 실측 토큰 요약) 간단히 확인할 수 있게 표시한다.
   - `tests/usageCost.test.ts`에 아래 테스트 케이스를 추가/갱신한다:
     - 1분 임시 받아쓰기 OFF 시 `liveMinutes`가 STT 비용에 이중 가산되지 않음.
     - 1분 임시 받아쓰기 ON 시 실제 호출된 분량만큼 STT 비용이 정확히 반영됨.
     - Live 실측 `usageMetadata` 토큰이 주어졌을 때 `priceUsage()` / `estimateCostUsd()`가 정확한 단가로 계산함.
     - 실측 토큰이 없는 레거시 문서에 대한 폴백 계산 정상 동작.
     - `USAGE_COST_COMPONENTS` 항목 합계 === `total` 불변식 통과.

---

## 4. 불변 제약 사항 및 주의점

1. **배포 서버 Node 타입 스트리핑 호환성**:
   - 프로덕션 서버는 `tsx` 없이 순수 `node server.ts`로 실행된다.
   - `server.ts`와 `server/*.ts`가 불러오는 모든 `src/` 모듈 및 그 하위 상대 경로에는 반드시 `.ts` 확장자를 명시해야 한다. (`tests/serverNodeImports.test.ts` 통과 필수)
2. **모델명 상수 동결 (Phase Gate 이전)**:
   - `src/config/models.ts`의 `LIVE_MODEL`, `TEXT_MODEL`, `GEMINI_STT_MODEL`, `GEMINI_TTS_MODEL` 등 모델명 상수는 Track 1 승인 전까지 변경하지 않는다.
3. **기존 핵심 파이프라인 회귀 금지**:
   - 16kHz PCM 오디오 캡처·재생 스케줄러(`audioPlaybackScheduler.ts`), 에코 게이트, 바지인.
   - 10초 오디오 청크 IndexedDB 저장 및 Firebase Storage 백업/재업로드(`chunkRecorder.ts`, `chunkIndexedDb.ts`, `storage.ts`).
   - 아침 6분 복습강의 생성 및 카드 로딩(`server/lecture.ts`, `MorningLectureCard.tsx`).
   - 최근 반영된 `[boot]` 부팅 타이밍 로깅(`src/services/perf/bootTiming.ts`, `src/App.tsx`).
4. **Firestore 보안 규칙 확인**:
   - `users/{uid}/usage/{yyyy-mm}` 문서에 새 실측 토큰 필드를 추가할 경우 `firestore.rules`에서 쓰기 검증에 막히지 않는지 반드시 확인한다.

---

## 5. 검증 명령어 및 완료 판정 체크리스트 (Acceptance Criteria)

### 필수 실행 검증 명령어
```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
node --test tests/serverNodeImports.test.ts tests/usageCost.test.ts tests/liveConfig.test.ts tests/liveWire.test.ts tests/liveMessage.test.ts
```

### 최종 산출물 체크리스트
- [ ] **Track 1 제안서 (`docs/plan/live-cost-optimization-proposal.md`)** 작성 완료:
  - [ ] 대안 1·2·3의 최신 공식 가격·스펙·한영 품질 재검증 완료 (출처·조사일 기재)
  - [ ] 추가 대안(VAD 무음 전송 차단, 롤링 요약 핸드오프, 경량 Realtime, 프롬프트 경량화, 2027 단가 대응, 하이브리드안) 심층 분석 포함
  - [ ] 2026 단가 & 2027-01-01 단가 기준 비교 매트릭스 및 **최종 추천 방법론(1순위 + 차선책)** 제시
- [ ] **Track 2-1**: 직연결 + 서버 프록시 양쪽에서 Gemini Live `usageMetadata` 실측 수집·누적·로깅 구현 및 단위 테스트 통과
- [ ] **Track 2-2**: `onecall_enable_partial_transcribe` 기본값 OFF 전환, 설정 UI 안내 문구 보강, 오디오 청크 기반 복구 무결성 확인
- [ ] **Track 2-3**: `usageService.ts` / `learningLog.ts` / `models.ts` / `UsagePanel.tsx` 갱신 (임시 STT 무조건 가산 제거 + 실측 토큰 우선 계산 + 압축 상한 확장성 + `usageCost.test.ts` 통과)
- [ ] **실측 검증 로그**: 실제 통화 세션 1회 이상 실행 후 `[live-usage]` 실측 토큰 vs 기존 추정치 비교 수치를 리포트에 첨부
- [ ] **Phase Gate 준수**: 프로덕트 오너 승인 전 통화 엔진 교체 미실행 확인 및 전체 테스트·린트·빌드 통과
