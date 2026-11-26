# AI 원콜(One Call English) 실시간 음성 통화 비용 아키텍처 제안서

- **작성일**: 2026-11-26
- **작성**: Engineering Lead
- **상태**: 제안(승인 전, Phase Gate: 엔진·모델명 변경 없음)

---

## 1. 요약

- **1순위 추천(즉시 적용·엔진 유지)**: **하이브리드 H1** (`gemini-3.8-live` 유지 + 명시 압축 + 무음 차단 + 프롬프트 경량화 + 임시 STT OFF + 강의 TTS Flex). 보수안 `12k/6k`로 시작해 월 원가 **2026 $30.25(₩42,352) / 2027 $33.21(₩46,492)**(추정)로 낮추고, 실측 후 `6k/3k`로 전환해 **2026 $21.73(₩30,422) / 2027 $24.69(₩34,561)**(추정)을 목표로 한다.
- **차선책(목표 $10~15/월 달성 시 PoC)**: **대안 3 구글 단일 스트리밍** (`gemini-3.5-transcribe-live` + `gemini-3.1-flash-lite` + `gemini-3.8-flash-lite-tts`). 월 원가 **2026 $10.49(₩14,687) / 2027 $15.91(₩22,273)**(추정)으로 목표 구간에 닿는 유일한 안이나, 발음·억양 직접 청취 불가 및 지연·바지인 미검증 상태다.
- **현재 기준선**: 임시 STT ON 기준 월 **2026 $52.34(₩73,280) / 2027 $56.41(₩78,976)**(추정)으로, 통화 비용($45.12/월)이 전체의 대부분을 차지한다.
- **바로 할 일**: ① **Track 2 실측**(엔진 변경 전 실제 토큰·무음·전사·지연 측정 및 `priceUsage()` 과금 버그 수정) → ② **1순위 설정 PR**(임시 STT OFF, 압축 `12k/6k` 명시, 무음 차단, 프롬프트 경량화, 강의 TTS Flex) → ③ **Go/No-Go 판정**(압축 `6k/3k` 확대 또는 대안 3 PoC 착수 결정).

---

## 2. 현재 구조와 비용 원인

`origin/main (4128a84)` 코드베이스 실사 결과, 현재 월 $52.34(2026, 추정)의 핵심 원인은 다음 다섯 가지다.

1. **턴별 누적 컨텍스트 재청구 구조 (공식 사실)**
   - Gemini Live API는 매 턴(사용자 입력 1회 + 모델 응답)마다 세션 컨텍스트 윈도우에 남아 있는 모든 토큰을 재처리하여 과금한다 [S2].
   - 대화 히스토리는 원시 오디오 토큰(raw audio tokens)으로 유지되며, 매 턴마다 누적된 네이티브 오디오 토큰 전체에 표준 오디오 입력 단가 `$3.00/1M` [S1]이 반복 청구된다 [S2].
   - 앱의 `src/services/usage/usageService.ts` `liveCost()` 역시 `baseIn + baseOut + promptRebill + contextRebill` 구조로 통화 시간의 제곱에 비례하는 재청구를 반영하고 있다.

2. **압축 미설정으로 인한 사실상 압축 0회 (공식 사실 + 코드 실사)**
   - 서버 중계(`server/liveConfig.ts`)와 직연결(`src/services/providers/liveWire.ts`의 `buildDirectSetup`) 모두 `contextWindowCompression: { slidingWindow: {} }`만 전송하며 `triggerTokens`와 `targetTokens`를 지정하지 않는다.
   - `triggerTokens` 미설정 시 기본값은 모델 컨텍스트 한도의 80%다 [S3]. `gemini-3.8-live`의 입력 한도는 `131,072 tok`이므로 기본 trigger는 `131,072 × 80% ≈ 104,858 tok`이다 [S3][S5].
   - 10분 통화의 누적 오디오 토큰은 약 `22,500 tok`(22.5k, 추정)에 불과해 기본 trigger에 도달하지 못하므로 **10분 통화 동안 압축이 0회 발생**한다(추정).

3. **클라이언트 무음 전송 (코드 실사)**
   - `src/services/providers/geminiLiveProvider.ts`의 `onaudioprocess`는 `ScriptProcessor` 2048 샘플(약 128ms) 청크를 `conn.ready` 상태이면 무조건 `sendAudioChunk`로 전송하며 클라이언트 측 무음 차단이 없다.
   - `automaticActivityDetection`도 명시 설정이 없어 기본 자동 VAD에 의존한다. (단, 서버 측 `TurnCoverage` 기본값의 영향은 6절에서 반론으로 검토한다.)

4. **전사 추가 과금 및 앱 비용 계산식 누락 (공식 사실 + 코드 실사)**
   - `server/liveConfig.ts`와 `liveWire.ts` 모두 `inputAudioTranscription: {}` 및 `outputAudioTranscription: {}`를 활성화하고 있다.
   - 공식 문서상 전사 옵션을 켜면 전사 텍스트 토큰이 텍스트 출력 단가(`$4.50/1M` [S1])로 추가 청구된다 [S2].
   - 그러나 `src/config/models.ts`의 `PRICING_RATES`에 `liveOutTextPer1M`($4.50) 항목 자체가 없어 앱 내부 비용 계산식에서 전사 추가 과금이 누락되어 있다.

5. **임시 STT 이중 과금 및 집계 버그 (코드 실사)**
   - `src/App.tsx` 79행에서 `onecall_enable_partial_transcribe !== "false"` 조건으로 임시 STT가 기본 ON이며, `chunkRecorder.ts`가 1분마다 `/api/gemini/transcribe-partial`(`gemini-3.5-transcribe` [S1])을 호출한다. 최종 STT(10분/일, `$1.53/월`, 추정)와 별도로 임시 STT `$1.53/월`(추정)이 이중 과금된다.
   - 또한 `src/services/usage/usageService.ts`의 `priceUsage()` 152행은 `stt = (sttMin + liveMin + qaMin) × 분당 STT`로 계산해 임시 STT를 OFF하더라도 비용이 계속 가산되는 버그가 있어 Track 2에서 수정이 필요하다.

- **참고(현재 코드 모델 설정)**: `src/config/models.ts` 기준 `LIVE_MODEL`은 `gemini-3.8-live`, `TEXT_MODEL`은 `gemini-3.8-flash`, `GEMINI_STT_MODEL`은 `gemini-3.5-transcribe`(VERBATIM), `GEMINI_TTS_MODEL`은 `gemini-3.8-flash-tts`, LITE TTS는 `gemini-3.8-flash-lite-tts`이며, `src/data/lessonPromptBuilder.ts`는 4,341바이트다.

---

## 3. 최신 공식 단가 검증표

2026-11-26 KST 기준 각 벤더 공식 가격 페이지를 직접 확인한 결과다.

### 3.1 Google Gemini API (Standard vs 2027-01-01 인상 및 Flex)

| 모델명 | 항목 | 2026 단가 | 2027-01-01 단가 | 비고 / Flex·Batch | 출처 |
|---|---|---|---|---|---|
| `gemini-3.8-live` / `gemini-3.8-live-extended-thinking` / `gemini-3.1-flash-live-preview` | Input (text / audio / image·video) | `$0.75/1M` / `$3.00/1M`(`$0.005/분`) / `$1.00/1M` [S1] | 인상 표기 없음 [S1] | Context caching, Batch·Flex·Priority 미지원 [S5] | [S1][S5] |
| `gemini-3.8-live` 계열 | Output (text / audio, thinking 포함) | `$4.50/1M` / `$12.00/1M`(`$0.018/분`) [S1] | 인상 표기 없음 [S1] | 입력 한도 131,072 / 출력 65,536 [S5] | [S1][S5] |
| `gemini-2.5-flash-native-audio-preview-12-2025` | Input (text / audio) / Output (text / audio) | `$0.50` / `$3.00` / `$2.00` / `$12.00` (/1M) [S1] | 인상 표기 없음 [S1] | 오디오 단가는 3.8 Live와 동일 | [S1] |
| `gemini-3.8-flash` (Standard) | Input / Output(thinking 포함) | `$0.75/1M` / `$3.75/1M` [S1] | `$1.50/1M` / `$7.50/1M` [S1] | Context caching `$0.075→$0.15/1M`, 저장 `$0.50→$1.00/1M/시간` [S1]; Priority `$1.35→$2.70` / `$6.75→$13.50` [S1] | [S1] |
| `gemini-3.8-flash` (Batch·Flex) | Input / Output | `$0.375/1M` / `$1.875/1M` [S1] | `$0.75/1M` / `$3.75/1M` [S1] | **2027 Flex 단가 = 2026 Standard 단가** [S1]; Flex는 50% 할인·가변 지연·preview [S6] | [S1][S6] |
| `gemini-3.6-flash` (Standard) | Input / Output | `$0.75/1M` / `$3.75/1M` [S1] | `$1.50/1M` / `$7.50/1M` [S1] | 3.8 Flash와 동일 | [S1] |
| `gemini-3.5-flash-lite` | Input / Output | `$0.30/1M` / `$2.50/1M` [S1] | 인상 표기 없음 [S1] | - | [S1] |
| `gemini-3.1-flash-lite` | Input (text·img·vid / audio) / Output | `$0.25/1M` / `$0.50/1M` / `$1.50/1M` [S1] | 인상 표기 없음 [S1] | Flex 지원, Live API 미지원 [S6] | [S1][S6] |
| `gemini-3.5-transcribe` | Input audio / Output text | `$2.00/1M`(`$0.003/분`) / `$12.00/1M`(`$0.002/분`) [S1] | 인상 표기 없음 [S1] | 각주: 25 audio tok/s, 175 text tok/분 기준 약 `$0.005/분` [S1]; Flex 미지원 [S6] | [S1][S6] |
| `gemini-3.5-transcribe-live` | Input audio / Output text | `$3.50/1M`(`$0.005/분`) / `$21.00/1M`(`$0.004/분`) [S1] | 인상 표기 없음 [S1] | WebSocket 실시간 STT, 각주: 약 `$0.009/분` [S1] | [S1] |
| `gemini-3.8-flash-tts` (Standard) | Input text / Output audio | `$0.50/1M` / `$9.00/1M` (10초당 `$0.00225`) [S1] | `$1.00/1M` / `$18.00/1M` (10초당 `$0.0045`) [S1] | 오디오 25 tok/s [S1]; Priority `$0.90→$1.80` / `$16.20→$32.40` [S1]; Live API 미지원 [S6] | [S1][S6] |
| `gemini-3.8-flash-tts` (Batch·Flex) | Input text / Output audio | `$0.25/1M` / `$4.50/1M` [S1] | `$0.50/1M` / `$9.00/1M` [S1] | 2027 Flex = 2026 Standard [S1] | [S1] |
| `gemini-3.8-flash-lite-tts` (Standard) | Input text / Output audio | `$0.50/1M` / `$6.00/1M` (10초당 `$0.0015`) [S1] | `$1.00/1M` / `$12.00/1M` (10초당 `$0.003`) [S1] | Flex 지원, Live API 미지원(입력 8,192 tok) [S6] | [S1][S6] |
| `gemini-3.8-flash-lite-tts` (Batch·Flex) | Output audio | `$3.00/1M` [S1] | `$6.00/1M` [S1] | - | [S1] |

### 3.2 타사 음성·실시간 API 및 인프라

| 벤더 / 제품 | 모델·티어 | 공식 단가 | 비고 | 출처 |
|---|---|---|---|---|
| OpenAI GPT-Live | `gpt-live-1.1` / `gpt-live-1` | 활성 `$0.05/분`, 대기(standby) `$0.02/분` [S7] | 초 단위 과금, 세션 생성 시 15초 선청구(이후 상계), 백엔드 모델 비용 별도 [S7][S8] | [S7][S8] |
| OpenAI Realtime | `gpt-realtime-2.1` | Audio in `$32/1M`, out `$64/1M`, cached `$0.40/1M`; Text in `$4/1M`, out `$24/1M` [S7] | 초당 오디오 토큰 수 미공개 [S7] | [S7] |
| OpenAI Realtime Mini | `gpt-realtime-2.1-mini` | Audio in `$10/1M`, out `$20/1M`, cached `$0.30/1M`; Text in `$0.60/1M`, out `$2.40/1M`, cached `$0.06/1M` [S7] | 초당 오디오 토큰 수 미공개 → 월 원가 계산 제외 [S7] | [S7] |
| OpenAI Transcribe | `gpt-live-transcribe` | `$0.017/분` [S7] | - | [S7] |
| Cartesia | Managed Agents (표준) | `$0.03/분` [S9] | telephony·LLM 사용료 별도; 플랜 Free `$0`(에이전트 `$1`), Pro `$5/월`(에이전트 `$5`, 100K 크레딧), Startup `$49`, Scale `$299` [S9] | [S9] |
| Cartesia | Sonic TTS / Ink STT | Sonic 1 credit/글자(분당 약 750~800 크레딧), Ink 3 credit/초 [S9] | 44개 언어 음성(한국어 페이지 존재) [S9] | [S9] |
| Deepgram Voice Agent | Standard / BYO TTS / BYO LLM / BYO LLM+TTS / Advanced | `$0.075/분` / `$0.056/분` / `$0.065/분` / `$0.050/분` / `$0.163/분` [S10] | WebSocket 연결 시간 기준, Pay as you go [S10] | [S10] |
| Deepgram STT / TTS | Nova-3 Multi / Flux Multi / Aura-2 / Flux TTS | Nova-3 Multi `$0.0058/분`(프로모, 정가 `$0.0092/분`), Flux Multi `$0.0078/분`; Aura-2 `$0.030/1k자`, Flux TTS `$0.045/1k자` [S10] | Nova-3 다국어 목록에 Korean 포함 [S10] | [S10] |
| xAI | `grok-voice-3.0` (Speech to Speech) | `$0.08/분` (`$4.80/시간`) + `$0.004/text input` [S11] | `grok-voice-2.0` Deprecated, 별칭 `grok-voice-latest`, `/v1/realtime` [S11] | [S11] |
| xAI STT | STT 스트리밍 | `$0.20/시간` [S11] | 38개+ 언어 [S11] | [S11] |
| LiveKit Cloud | Build / Ship / Scale + Agent session | 기본 `$0/월` / `$50/월부터` / `$500/월부터`; Agent session `$0.0100/분`(Build/Ship) [S12] | - | [S12] |

### 3.3 작업지시서 사전 값과 달라진 점

- **xAI**: 과금 대상 모델명이 `grok-voice-3.0`이며 단가는 `$0.08/분` + `$0.004/text input` [S11]으로 확인됐다(`grok-voice-2.0`은 Deprecated, 별칭 `grok-voice-latest`) [S11].
- **Deepgram Voice Agent**: Pay as you go 기준 Standard는 `$0.075/분` [S10], BYO LLM은 `$0.065/분` [S10]으로 확인됐다(BYO TTS `$0.056/분`, BYO LLM+TTS `$0.050/분`, Advanced `$0.163/분` [S10]).
- **OpenAI GPT-Live**: 분당 정액형 음성 대화 제품(`gpt-live-1.1` / `gpt-live-1`, 활성 `$0.05/분`, 대기 `$0.02/분` [S7])이 신규 확인되어 대안 2에 반영했다.

---

## 4. 비용 산식

모든 월 원가 계산은 아래 공통 가정(작업지시서 및 앱 `USAGE_ASSUMPTIONS`)을 바탕으로 산출한 **추정치**다.

### 4.1 공통 가정 (추정 전제)

- 통화량: 하루 10분, 월 30일(월 300분), 4턴/분(통화당 40턴)
- 튜터 발화 비중: 50%(월 150분)
- 시스템 프롬프트: 1,500 tok/턴
- 오디오 토큰율: 25 audio tok/s = 1,500 tok/분 [S1]
- 환율: ₩1,400/$

### 4.2 Gemini Live 일 비용 산식 (추정)

```text
Live 일 비용 = 기본입력 + 기본출력 + 프롬프트 재청구 + 히스토리 재청구 + 전사 추가(추정)

1) 기본입력       = 10분 × 1,500 tok/분 × $3.00 / 1,000,000 = $0.045 [S1]
2) 기본출력       = 10분 × 0.5 × 1,500 tok/분 × $12.00 / 1,000,000 = $0.090 [S1]
3) 프롬프트 재청구 = 40턴 × 1,500 tok/턴 × $0.75 / 1,000,000 = $0.045 [S1]
4) 히스토리 재청구 = 합계(턴 k 직전 누적 오디오 토큰) × $3.00 / 1,000,000 [S1][S2]
5) 전사 추가(추정) = 10분 × 175 tok/분 × $4.50 / 1,000,000 ≈ $0.0079 [S1][S2]
```

- **히스토리 누적**: 분당 `2,250 tok`(사용자 1,500 + 튜터 750)가 누적된다(추정). 턴 단위 합산(첫 턴 누적 0) 결과 히스토리 재청구는 하루 `$1.316`이다. 앱 `usageService.ts`의 연속식(`4 × 1,500 × 1.5 × (분² / 2) × $3/1M`)은 `$1.35/일`(작업지시서 값)로 두 방식의 차이는 약 2.5%다.
- **압축 적용 시**: `triggerTokens` / `targetTokens`를 지정하면 누적 히스토리가 `targetTokens ~ triggerTokens` 사이의 톱니 모양으로 유지된다 [S2][S3].
- **Live 통화 월 30일 계산 결과 (추정)**:
  - 현재(압축 미설정): **$45.12/월**
  - 문서 예시 압축 `25k/8k`: **$45.12/월** (10분 통화 누적 22.5k < 25k이므로 압축 0회)
  - 압축 `12k/6k`: **$30.90/월** (압축 2회/통화)
  - 압축 `6k/3k`: **$19.79/월** (압축 5회/통화)
  - 무음 차단만(사용자 입력 중 실제 발화 40% 가정): **$28.52/월**
  - `12k/6k` + 무음 차단 + 프롬프트 800 tok: **$25.67/월**
  - `6k/3k` + 무음 차단 + 프롬프트 800 tok: **$17.15/월**
  - 롤링 요약(3분 20초마다 새 세션, 요약 300 tok 추가): **$17.71/월**
  - 참고(느린 템포: 2.5턴/분, 튜터 발화 30%): **$25.11/월**

### 4.3 비통화 월 비용 산식 (추정)

```text
비통화 월 합계(임시 STT OFF 기준)
= 최종 STT(10분/일) + 강의 TTS + 텍스트(gemini-3.8-flash, 입력 19,000 · 출력 12,600 tok/일) + 기타

- 최종 STT: $1.53 (2026) / $1.53 (2027) [S1]
- 임시 STT(ON일 때만 추가): $1.53 (2026) / $1.53 (2027) [S1]
- 강의 TTS(Standard): $2.22 (2026) → $4.45 (2027) [S1]
- 텍스트(3.8 Flash Standard): $1.85 (2026) → $3.69 (2027) [S1]
- 기타: $0.09 (2026) / $0.09 (2027)

=> 임시 STT OFF 기준 비통화 합계: $5.69 (2026) / $9.76 (2027)
=> 임시 STT ON 기준 비통화 합계: $7.22 (2026) / $11.29 (2027)
=> 강의 TTS를 Flex로 전환 시 절감: -$1.11 (2026) / -$2.22 (2027) [S1][S6]
```

### 4.4 대안 3(스트리밍 파이프라인) 통화 월 비용 산식 (추정)

```text
- STT (월 300분):
  · gemini-3.5-transcribe-live: $0.009/분 × 300분 = $2.70/월 [S1]
  · Deepgram Nova-3 Multilingual(프로모): $0.0058/분 × 300분 = $1.74/월 [S10]
- LLM (추정): 턴당 입력 = 1,500 + (175 tok/분 × 경과분), 40턴 합계 95,000 tok/일, 출력 875 tok/일
  · gemini-3.8-flash: $2.24/월 (2026) → $4.47/월 (2027) [S1]
  · gemini-3.1-flash-lite: $0.75/월 (2026·2027 동일) [S1]
- TTS (튜터 발화 월 150분):
  · gemini-3.8-flash-lite-tts: 150분 × 1,500 tok/분 × $6.00/1M = $1.35/월 (2026) → $2.70/월 (2027) [S1]
```

---

## 5. 대안 재검증

### 5.1 대안 1: Gemini Live 컨텍스트 윈도우 명시 압축 (`12k/6k`, `6k/3k`)

- **공식 확인 사실**: `ContextWindowCompressionConfig.triggerTokens`를 넘으면 압축이 실행되고 `SlidingWindow.targetTokens`(기본값 `trigger_tokens/2`)만큼 최근 히스토리를 남긴다 [S3]. 시스템 프롬프트와 `prefixTurns`는 항상 맨 앞에 유지되며 결과는 USER 턴 시작에서 잘린다 [S3]. 다만 압축 실행 시 일시적 지연 증가가 발생하므로 빈번한 트리거를 피하라고 명시되어 있고, `triggerTokens`/`targetTokens`의 최소 허용값은 문서에 없다 [S3].
- **비용 (추정)**: 통화 월 원가가 현재 `$45.12`에서 `12k/6k`는 `$30.90`(총 2026 `$36.59` / 2027 `$40.66`), `6k/3k`는 `$19.79`(총 2026 `$25.48` / 2027 `$29.55`)으로 감소한다. 문서 예시 `25k/8k` [S2]는 10분 통화(누적 22.5k)에서 압축 0회로 절감 효과가 없다.
- **장점**: 엔진·모델·클라이언트 파이프라인을 바꾸지 않고 설정 파라미터 추가만으로 즉시 적용 가능하며, 네이티브 오디오 기반 발음·억양 직접 청취와 한영 자연 전환(99개 언어, 한국어 포함 [S5])을 그대로 유지한다.
- **한계·반론**: 단독으로는 목표 `$10~15/월`에 못 미친다. `6k/3k`는 10분 통화당 압축 5회(추정)로 일시적 지연 증가 [S3] 및 대화 맥락 손실 위험이 있다.
- **PoC에서 확인할 것**: `12k/6k` 및 `6k/3k` 값의 API 수용 여부(최소 허용값 미확인 [S3]), 압축 발생 시 첫 음성 지연 증가량(공식 수치 없음, PoC 측정), 10분 통화 중 맥락 유지 품질(공식 수치 없음, PoC 측정).

### 5.2 대안 2: 분당 정액형 음성 API

#### (a) OpenAI GPT-Live (`gpt-live-1.1`)
- **공식 확인 사실**: 활성 `$0.05/분`, 대기(standby) `$0.02/분`, 초 단위 과금이며 세션 생성 시 15초 선청구 후 상계한다 [S7][S8]. 활성 시간은 발화 + idle timeout 전 무음 + 백엔드 대기를 포함하며, 대기 요율은 WebRTC standby(`idle_timeout_s` 5~60초)에서만 적용되고 마이크 음소거는 활성으로 과금된다 [S8]. 백엔드 모델 비용은 별도다 [S8]. WebRTC 권장(WebSocket 지원), LiveKit·Twilio·Daily/Pipecat 연동 지원, 한국어 음성(`Noeul`)을 제공한다 [S8].
- **비용 (추정)**: 300분 전 구간 활성 가정 시 통화 `$15.00/월`, 총 **2026 `$20.69` / 2027 `$24.76`**(백엔드 위임 모델 비용 미포함).
- **장점**: 분당 정액이라 턴별 누적 재청구가 없어 장시간 통화 비용 예측이 쉽다.
- **한계·반론**: 총 원가가 하이브리드 H1 `6k/3k`(2026 `$21.73` / 2027 `$24.69`)과 거의 같아, WebRTC 전환·SDK 교체·프롬프트 재작성 공수를 들일 실익이 작다. 백엔드 위임 사용 시 추가 비용이 발생한다 [S8].
- **PoC에서 확인할 것**: 한국어·영어 혼합 인식률(공식 수치 없음, PoC 측정), 발음·억양 피드백 품질 및 체감 지연(공식 수치 없음, PoC 측정), 실제 활성/대기 비율.

#### (b) Cartesia Managed Agents (`$0.03/분` + 외부 LLM)
- **공식 확인 사실**: Managed Agents 표준 요율은 `$0.03/분`이나 **telephony와 LLM 사용료는 미포함**이다 [S9]. 플랜은 Free `$0`(에이전트 `$1`), Pro `$5/월`(에이전트 `$5`, 100K 크레딧), Startup `$49`, Scale `$299`이며 초과 사용은 기본 꺼짐 상태다 [S9]. 44개 언어 음성(한국어 페이지 존재)을 지원한다 [S9].
- **비용 (추정)**: `3.1 Flash-Lite` 결합 시 통화 `$9.75/월`(총 2026 `$15.44` / 2027 `$19.51`), `3.8 Flash` 결합 시 통화 `$11.24/월`→`$13.47/월`(총 2026 `$16.92` / 2027 `$23.23`). 플랜 기본료는 별도 고려 필요.
- **장점**: 분당 정액 대안 중 원가가 가장 낮다.
- **한계·반론**: 에이전트 레이어 외부 종속과 플랜/크레딧 운영 부담이 생기며, STT→LLM→TTS 구조상 사용자 발음·억양을 LLM이 직접 듣지 못한다(추론).
- **PoC에서 확인할 것**: 한영 코드스위칭 인식률(공식 수치 없음, PoC 측정), 바지인 및 TTFB(공식 수치 없음, PoC 측정), 플랜 초과 과금 동작.

#### (c) Deepgram Voice Agent (`Standard $0.075/분`, `BYO LLM $0.065/분`)
- **공식 확인 사실**: WebSocket 연결 시간 기준 Pay as you go 요금은 Standard `$0.075/분`(STT+관리형 LLM+TTS), BYO LLM `$0.065/분`, BYO TTS `$0.056/분`, BYO LLM+TTS `$0.050/분`, Advanced `$0.163/분`이다 [S10].
- **비용 (추정)**: Standard 통화 `$22.50/월`(총 2026 `$28.19` / 2027 `$32.26`), BYO LLM + `3.1 Flash-Lite` 통화 `$20.25/월`(총 2026 `$25.94` / 2027 `$30.01`).
- **장점**: 단일 WebSocket 연결로 오케스트레이션을 단순화할 수 있다.
- **한계·반론**: 하이브리드 H1 `6k/3k`보다 비싸고, WebSocket 연결 시간 전체가 과금되어 무음 절감 여지가 없다 [S10].
- **PoC에서 확인할 것**: 한영 혼합 대화 품질 및 체감 지연(공식 수치 없음, PoC 측정).

#### (d) xAI `grok-voice-3.0` (`$0.08/분`)
- **공식 확인 사실**: Speech to Speech `grok-voice-3.0`은 `$0.08/분`(`$4.80/시간`) + `$0.004/text input`이며, 엔드포인트 `/v1/realtime`에서 "sub-second latency"(자사 주장)를 표기하고 있다 [S11]. `grok-voice-2.0`은 Deprecated다 [S11].
- **비용 (추정)**: 통화 `$24.00/월`, 총 **2026 `$29.69` / 2027 `$33.76`**(`$0.004/text input` 추가분 미포함).
- **장점**: S2S 방식이라 사용자 음성을 모델이 직접 듣는다. 엔드포인트는 `/v1/realtime`이다 [S11].
- **한계·반론**: H1 `6k/3k`와 GPT-Live보다 비싸 비용 절감 명분이 부족하다.
- **PoC에서 확인할 것**: 실제 지연시간(자사 주장 외 공식 벤치마크 없음, PoC 측정), 한국어·영어 혼합 발화 품질(공식 수치 없음, PoC 측정).

### 5.3 대안 3: 풀듀플렉스 스트리밍 파이프라인 (STT → LLM → TTS)

#### (a) 구글 단일 조합 (`gemini-3.5-transcribe-live` + `gemini-3.1-flash-lite` + `gemini-3.8-flash-lite-tts`)
- **공식 확인 사실**: `gemini-3.5-transcribe-live`는 WebSocket 실시간 STT(약 `$0.009/분`) [S1], `gemini-3.1-flash-lite`는 텍스트 입력 `$0.25/1M`·출력 `$1.50/1M`(2027 인상 표기 없음) [S1], `gemini-3.8-flash-lite-tts`는 Standard 오디오 출력 `$6.00/1M` → 2027 `$12.00/1M` [S1]이며 `stream:true`로 헤더 없는 24kHz PCM 스트리밍 합성과 한국어를 지원한다 [S6].
- **비용 (추정)**: 통화 **2026 `$4.80` / 2027 `$6.15`**, 총 **2026 `$10.49`(₩14,687) / 2027 `$15.91`(₩22,273)**. LiveKit Cloud Agent session(`$0.0100/분` [S12])을 추가하면 통화 `+$3.00/월`(총 2026 `$13.49` / 2027 `$18.91`).
- **장점**: Google 단일 벤더를 유지하면서 목표 원가 `$10~15/월`에 도달하는 유일한 구조다(2026 기준). 텍스트 기반 컨텍스트라 오디오 토큰 재청구가 원천 제거된다.
- **한계·반론**: LLM이 텍스트 전사본만 받으므로 사용자 발음·억양을 직접 청취할 수 없다(추론). STT→LLM→TTS 3단 직렬 연결, 바지인 처리, 문장 단위 스트리밍 청킹을 직접 구현·운영해야 한다. `gemini-3.8-flash-lite-tts`는 2027년 2배 인상이 예고되어 있고 Live API 미지원(입력 8,192 tok)이다 [S1][S6].
- **PoC에서 확인할 것**: 종단간 TTFB 및 턴 전환 지연(공식 수치 없음, PoC 측정), 바지인 끊김·오작동 여부(공식 수치 없음, PoC 측정), `gemini-3.5-transcribe-live`의 한영 혼합 인식률(공식 수치 없음, PoC 측정), `gemini-3.1-flash-lite`의 영어 튜터 교정 품질(공식 수치 없음, PoC 측정).

#### (b) Deepgram 변형 (`Deepgram Nova-3 Multi` + `gemini-3.1-flash-lite` + `gemini-3.8-flash-lite-tts`)
- **공식 확인 사실**: Nova-3 Multilingual 스트리밍 STT는 프로모 `$0.0058/분`(정가 `$0.0092/분`)이며 [S10], `language=multi`(+`language_hint`)와 한국어(Korean)를 지원하고 권장 endpointing은 100ms다 [S10]. (참고: Flux Multilingual `$0.0078/분`은 코드스위칭을 네이티브 지원 [S10].)
- **비용 (추정)**: 프로모 단가 기준 통화 **2026 `$3.84` / 2027 `$5.19`**, 총 **2026 `$9.53`(₩13,343) / 2027 `$14.95`(₩20,929)**. 단, 정가(`$0.0092/분` [S10]) 환원 시 구글 Transcribe Live(`$0.009/분` [S1])와 비슷해진다.
- **장점**: 프로모 기간 중 전 대안 중 최저가이며, 코드스위칭 설정 문서와 권장 endpointing(100ms)이 명시되어 있다 [S10].
- **한계·반론**: 멀티 벤더 운영(키·장애·결제 분리)과 프로모 종료 시 단가 상승 리스크가 있으며, 발음 직접 청취 불가는 구글 조합과 동일하다.
- **PoC에서 확인할 것**: Nova-3 Multi vs Transcribe Live 한영 코드스위칭 정확도 및 지연 비교(공식 수치 없음, PoC 측정).

---

## 6. 추가 대안 심층 검토

### 6.1 클라이언트 무음 전송 차단 (및 서버 TurnCoverage 반론)
- **기대 효과 (추정)**: 현재 `geminiLiveProvider.ts`는 128ms 청크를 무조건 전송한다. 사용자 입력 중 실제 발화 비중을 40%로 가정해 무음 전송을 차단하면 Live 통화 월 원가가 `$45.12 → $28.52`로 감소한다(추정).
- **핵심 반론 (공식 사실 기반)**: Gemini 3.1 이후 Live API의 `TurnCoverage` 기본값은 `TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO`이며, 공식 레퍼런스는 자동 VAD 사용 시 "audio activity means speech and excludes silence"라고 명시하고 있다 [S3]. 즉 **서버가 이미 자동 VAD로 무음을 턴 컨텍스트에서 제외하고 있을 가능성**이 있으며, 그 경우 클라이언트 무음 차단의 실제 절감 폭은 가정(`$45.12 → $28.52`)보다 훨씬 작을 수 있다(추론). (반면 `Proactive Audio Mode`를 켜면 듣는 내내 입력 토큰이 청구된다 [S2].)
- **검증 방법**: 클라이언트 VAD + `audioStreamEnd` [S3] 적용 전, Track 2 실측에서 무음 구간이 실제 `AUDIO` 입력 토큰(`promptTokensDetails[]`)에 잡히는지 반드시 확인해야 한다.

### 6.2 롤링 요약 핸드오프 (Rolling Summary Handoff)
- **구조 및 비용 (추정)**: 3분 20초마다 새 세션을 열고 직전 대화 요약 300 tok을 주입하면 히스토리 재청구가 리셋되어 통화 월 원가 `$17.71`, 총 **2026 `$23.40` / 2027 `$27.47`**이 된다.
- **한계·반론**: Live API는 압축 없이 오디오 전용 세션 15분 제한, 연결 수명 약 10분(`sessionResumption` 토큰 2시간 유효, `GoAway` 메시지) [S4]을 이미 관리해야 하는데, 여기에 3분 20초마다 강제 재연결·요약 생성을 얹으면 대화 흐름 단절, 재연결 지연, 클라이언트 상태 복잡도가 크게 증가한다(추론). `6k/3k` 압축 + H1(`$17.15/월`)보다 비용 이점이 없으므로 채택 우선순위가 낮다.

### 6.3 경량 Realtime · S2S 모델
- **Gemini Live 계열**: `gemini-3.8-live`, `gemini-3.1-flash-live-preview`, `gemini-2.5-flash-native-audio-preview-12-2025` 모두 오디오 입력 `$3.00/1M` [S1], 오디오 출력 `$12.00/1M` [S1]으로 **더 저렴한 오디오 단가 모델이 존재하지 않는다**. (`2.5-flash-native-audio`는 텍스트 단가만 `$0.50/$2.00` [S1]으로 소폭 낮을 뿐 핵심인 오디오 재청구 단가는 동일하다.)
- **OpenAI `gpt-realtime-2.1-mini`**: Audio in `$10/1M`, out `$20/1M`, cached `$0.30/1M` [S7]이나 공식 가격표에 초당 오디오 토큰 수가 공개되어 있지 않아 [S7] 월 원가 계산에서 제외했다.

### 6.4 프롬프트 경량화
- **효과 (추정)**: 시스템 프롬프트(`src/data/lessonPromptBuilder.ts` 4,341바이트)를 `1,500 tok → 800 tok`으로 줄이면, 하루 절감액은 `40턴 × 700 tok × $0.75/1M = $0.021/일`, 월 약 `$0.63`(추정)에 그친다.
- **판단**: 단독 비용 절감 효과는 작지만, 구현 위험이 낮고 압축 윈도우(`targetTokens`) 내 여유 공간을 확보하는 부수 효과가 있으므로 하이브리드 패키지에 보조 항목으로 포함한다(추론).

### 6.5 2027-01-01 단가 인상 대응
- **영향 범위 (공식 사실)**: `gemini-3.8-live`와 `gemini-3.5-transcribe` / `transcribe-live`, `gemini-3.1-flash-lite`는 2027 인상 표기가 없다 [S1]. 반면 비통화 영역의 `gemini-3.8-flash`와 `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`는 2027-01-01부로 Standard 단가가 2배 인상된다 [S1].
- **대응 수단**:
  1. **Flex·Batch 전환**: `service_tier: "flex"`는 표준 대비 50% 할인(지연 가변·best-effort·preview) [S6]이며, **2027 Flex 단가는 2026 Standard 단가와 동일**하다(`3.8-flash` `$0.75/$3.75`, `3.8-flash-tts` `$0.50/$9.00`) [S1]. 실시간성이 낮거나 사전 생성 가능한 강의 TTS에 Flex를 적용하면 월 `$1.11`(2026) / `$2.22`(2027)을 절감한다(추정). 단, `gemini-3.8-live` [S5]와 `gemini-3.5-transcribe` [S6]는 Flex 미지원이다.
  2. **Flash-Lite TTS 전환**: 강의 TTS를 `gemini-3.8-flash-lite-tts`(Standard `$6.00→$12.00`, Flex `$3.00→$6.00` [S1])로 내리는 방안을 음질 검증 후 검토할 수 있다(Live API 미지원, 입력 8,192 tok [S6]).
  3. **Thinking 토큰 제어**: `gemini-3.8-live`와 `gemini-3.8-flash`의 출력 단가는 thinking 토큰을 포함한다 [S1]. Track 2에서 `thoughtsTokenCount` [S3] 비중을 실측해 불필요한 사고 토큰을 제어할 근거를 확보한다.

### 6.6 하이브리드 (H1 / H1-보수)
- **구성**: `gemini-3.8-live` 유지 + 명시 압축(`12k/6k` 보수안 → 실측 후 `6k/3k`) + 클라이언트 무음 차단 + 프롬프트 800 tok 경량화 + 임시 STT OFF + 강의 TTS Flex.
- **비용 (추정)**:
  - **H1-보수 (`12k/6k`)**: 통화 `$25.67/월`, 총 **2026 `$30.25`(₩42,352) / 2027 `$33.21`(₩46,492)**.
  - **H1 (`6k/3k`)**: 통화 `$17.15/월`, 총 **2026 `$21.73`(₩30,422) / 2027 `$24.69`(₩34,561)**.
- **의의**: 엔진·모델 교체 없이 `6k/3k` 기준 현재 대비 월 원가를 절반 이하로 낮추면서(추정, 보수안은 약 42% 절감), 네이티브 오디오 학습 품질과 기존 파이프라인 호환성을 유지한다.

---

## 7. 전체 비교 매트릭스

### (a) 비용 비교 표 (추정, 총 일 = 총 월 ÷ 30, 비통화 기준선: 임시 STT OFF `$5.69`/`$9.76`, 현재 행만 임시 STT ON. H1 두 행은 강의 TTS Flex 포함)

| 안 | 통화 월(2026) | 통화 월(2027) | 총 일 2026 USD | 총 일 2027 USD | 총 월 2026 USD | 총 월 2027 USD | 총 월 2026 KRW | 총 월 2027 KRW |
|---|---|---|---|---|---|---|---|---|
| 현재(임시 STT ON) | $45.12 | $45.12 | $1.745 (₩2,443) | $1.880 (₩2,632) | $52.34 | $56.41 | ₩73,280 | ₩78,976 |
| 퀵윈: 임시 STT OFF만 | $45.12 | $45.12 | $1.694 (₩2,371) | $1.829 (₩2,561) | $50.81 | $54.88 | ₩71,138 | ₩76,834 |
| 대안1-a 압축 12k/6k | $30.90 | $30.90 | $1.220 (₩1,708) | $1.355 (₩1,897) | $36.59 | $40.66 | ₩51,222 | ₩56,918 |
| 대안1-b 압축 6k/3k | $19.79 | $19.79 | $0.849 (₩1,189) | $0.985 (₩1,379) | $25.48 | $29.55 | ₩35,676 | ₩41,373 |
| 신규4 VAD 무음 차단만(발화비중 40% 가정) | $28.52 | $28.52 | $1.140 (₩1,596) | $1.276 (₩1,786) | $34.21 | $38.28 | ₩47,890 | ₩53,587 |
| 신규5 롤링 요약 3분20초마다 새 세션 | $17.71 | $17.71 | $0.780 (₩1,092) | $0.916 (₩1,282) | $23.40 | $27.47 | ₩32,761 | ₩38,457 |
| 하이브리드H1 6k/3k+VAD+프롬프트800+강의TTS Flex | $17.15 | $17.15 | $0.724 (₩1,014) | $0.823 (₩1,152) | $21.73 | $24.69 | ₩30,422 | ₩34,561 |
| 하이브리드H1-보수 12k/6k+VAD+프롬프트800+강의TTS Flex | $25.67 | $25.67 | $1.008 (₩1,412) | $1.107 (₩1,550) | $30.25 | $33.21 | ₩42,352 | ₩46,492 |
| 대안2 GPT-Live(gpt-live-1.1, 활성 $0.05/분) | $15.00 | $15.00 | $0.690 (₩966) | $0.825 (₩1,155) | $20.69 | $24.76 | ₩28,964 | ₩34,660 |
| 대안2 Cartesia Managed Agents $0.03/분 + 3.1 Flash-Lite | $9.75 | $9.75 | $0.515 (₩721) | $0.650 (₩910) | $15.44 | $19.51 | ₩21,617 | ₩27,313 |
| 대안2 Cartesia + 3.8 Flash | $11.24 | $13.47 | $0.564 (₩790) | $0.774 (₩1,084) | $16.92 | $23.23 | ₩23,695 | ₩32,521 |
| 대안2 Deepgram Voice Agent Standard $0.075/분 | $22.50 | $22.50 | $0.940 (₩1,316) | $1.075 (₩1,505) | $28.19 | $32.26 | ₩39,464 | ₩45,160 |
| 대안2 Deepgram BYO LLM $0.065/분 + 3.1 Flash-Lite | $20.25 | $20.25 | $0.865 (₩1,211) | $1.000 (₩1,400) | $25.94 | $30.01 | ₩36,317 | ₩42,013 |
| 대안2 xAI grok-voice-3.0 $0.08/분 | $24.00 | $24.00 | $0.990 (₩1,386) | $1.125 (₩1,575) | $29.69 | $33.76 | ₩41,564 | ₩47,260 |
| 대안3 구글 스트리밍(Transcribe Live+3.1 Flash-Lite+3.8 Flash-Lite TTS) | $4.80 | $6.15 | $0.350 (₩490) | $0.530 (₩742) | $10.49 | $15.91 | ₩14,687 | ₩22,273 |
| 대안3 + LiveKit Cloud 세션 $0.01/분 | $7.80 | $9.15 | $0.450 (₩630) | $0.630 (₩882) | $13.49 | $18.91 | ₩18,887 | ₩26,473 |
| 대안3 변형(Deepgram Nova-3 Multi+3.1 Flash-Lite+3.8 Flash-Lite TTS) | $3.84 | $5.19 | $0.318 (₩445) | $0.498 (₩698) | $9.53 | $14.95 | ₩13,343 | ₩20,929 |

### (b) 정성 비교 표

공식 문서·코드 실사 근거가 있는 항목만 단정하고, 실측이 필요한 항목은 `PoC`로 표기했다.

| 안 | 체감 지연 | 바지인 | 한영 혼합 인식 | 발음·억양 직접 청취 | 구현 공수 | 기존 파이프라인 호환 | 운영 리스크 |
|---|---|---|---|---|---|---|---|
| 하이브리드 H1 (12k/6k → 6k/3k) | PoC (압축 시 일시적 지연 증가 경고 [S3]) | 지원 (`interrupted:true` [S2]) | 지원(99개 언어·ko, 대화 중 자연 전환 [S5]), 정확도 PoC | 가능 (네이티브 오디오 [S2]) | 낮음 (설정·클라이언트 보완) | 높음 (동일 엔진·프로토콜) | 낮음 (단, 압축 지연·Flex 가변 지연 [S6] 확인 필요) |
| 대안 2 GPT-Live | PoC | PoC | 한국어 음성(`Noeul`) 지원 [S8], 혼합 인식 PoC | 가능 (S2S [S8]) | 높음 (WebRTC 권장·세션 모델 전환 [S8]) | 낮음 (엔진 교체) | 중간 (백엔드 위임 과금·음소거 활성 과금 [S8]) |
| 대안 2 Cartesia + LLM | PoC | PoC | 44개 언어(한국어 페이지 존재 [S9]), 혼합 인식 PoC | 불가 (텍스트 경유, 추론) | 높음 (에이전트 통합) | 낮음 (외부 에이전트) | 중간 (플랜/크레딧·초과 과금 관리 [S9]) |
| 대안 2 Deepgram Voice Agent | PoC | PoC | Nova-3 ko·코드스위칭 지원 [S10], 정확도 PoC | 불가 (텍스트 경유, 추론) | 중간~높음 (WebSocket 전환) | 낮음 (엔진 교체) | 중간 (연결 시간 전체 과금 [S10]) |
| 대안 2 xAI `grok-voice-3.0` | PoC (자사 주장 sub-second [S11]) | PoC | PoC | 가능 (S2S [S11]) | 높음 (`/v1/realtime` 전환 [S11]) | 낮음 (엔진 교체) | 중간 (단가 높음·실측 미검증) |
| 대안 3 구글 단일 스트리밍 | PoC (3단 직렬 지연) | PoC (직접 구현 필요) | 한국어 TTS 지원 [S6], STT 혼합 인식 PoC | 불가 (STT 텍스트 경유, 추론) | 높음 (풀듀플렉스 오케스트레이션 신규 개발) | 낮음 (아키텍처 전면 변경) | 높음 (바지인·스트리밍 안정성·2027 TTS 인상 [S1]) |
| 대안 3 변형 (Deepgram Nova-3 Multi) | PoC (endpointing 100ms 권장 [S10]) | PoC (직접 구현 필요) | Nova-3 ko·코드스위칭 지원 [S10], 정확도 PoC | 불가 (STT 텍스트 경유, 추론) | 높음 (멀티 벤더 스트리밍) | 낮음 (아키텍처 전면 변경) | 높음 (멀티 벤더·프로모 종료 시 정가 `$0.0092/분` [S10]) |

---

## 8. 최종 추천

### 8.1 1순위: 하이브리드 H1 (`gemini-3.8-live` 유지)
- **적용 순서**: 보수안 `12k/6k` + 무음 차단 + 프롬프트 800 tok + 임시 STT OFF + 강의 TTS Flex(월 2026 `$30.25` / 2027 `$33.21`, 추정)로 먼저 배포하고, Track 2 실측 및 지연·품질 검증을 통과하면 `6k/3k`(월 2026 `$21.73` / 2027 `$24.69`, 추정)로 단계 전환한다.
- **선택 근거**:
  1. Phase Gate 원칙(엔진·모델명 변경 없음)을 지키면서 현재 `$52.34/월` 대비 보수안은 약 42%, `6k/3k`까지 가면 약 58% 줄일 수 있다(추정).
  2. 영어 회화 앱의 핵심 가치인 네이티브 오디오 발음·억양 직접 청취 [S2]와 한영 자연 전환 [S5], 바지인(`interrupted:true` [S2])을 그대로 보존한다.
  3. 2027년에도 `gemini-3.8-live`는 인상 표기가 없고 [S1], 강의 TTS를 Flex로 전환하면 2027년 인상 폭을 상쇄할 수 있다 [S1][S6].

### 8.2 차선책: 대안 3 구글 단일 스트리밍 PoC
- **구성**: `gemini-3.5-transcribe-live` + `gemini-3.1-flash-lite` + `gemini-3.8-flash-lite-tts` (월 2026 `$10.49` / 2027 `$15.91`, 추정).
- **선택 근거 및 유보 사유**: 사업 목표가 반드시 **월 `$10~15` 이하**여야 한다면 도달 가능한 유일한 안이다. 그러나 발음·억양 직접 청취가 불가능하고(추론), 3단 직렬 파이프라인의 체감 지연·바지인·한영 혼합 인식률이 검증되지 않았으므로 즉시 본선 채택이 아니라 별도 PoC 트랙으로 검증한다.

### 8.3 S2S 대체 참고: OpenAI GPT-Live
- `gpt-live-1.1`(활성 `$0.05/분` [S7])은 월 2026 `$20.69` / 2027 `$24.76`(추정)으로 하이브리드 H1 `6k/3k`(2026 `$21.73` / 2027 `$24.69`)과 원가가 거의 같다. 백엔드 위임 비용 별도 [S8] 및 WebRTC 전환 공수를 고려하면 엔진 교체 이득이 작아 참고안으로 유지한다.

### 8.4 이전 리스크
- **H1 리스크**: `TurnCoverage` 기본값으로 인해 무음 차단 절감 폭이 예상보다 작을 수 있음 [S3]; `6k/3k` 압축 시 일시적 지연 증가 [S3] 및 대화 맥락 손실 가능성; Flex의 가변 지연·preview 상태 [S6].
- **대안 3 이전 리스크**: 발음 교정 품질 저하, 바지인·턴 종료 판정 오작동, 오케스트레이션 개발·유지보수 비용 증가.

---

## 9. Track 2 실측 계획 (엔진 변경 전 필수 검증)

### 9.1 확인해야 할 8가지 항목

1. **`usageMetadata` 누적/증분 여부**: 레퍼런스에 명시되지 않은 `promptTokenCount`, `totalTokenCount` 등이 턴별 증분인지 세션 누적값인지 확인 [S3].
2. **턴당 `promptTokenCount`의 히스토리 포함 여부**: 실제 과금 산식(매 턴 누적 히스토리 재청구 [S2])이 `promptTokenCount`에 그대로 찍히는지 검증.
3. **실제 턴/분**: 현재 가정(4턴/분)과 실제 영어 회화 통화의 분당 턴 수 차이 확인.
4. **무음 구간의 AUDIO 입력 토큰 계상 여부**: `TurnCoverage` 기본값(`TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO` [S3]) 하에서 무음 청크가 `promptTokensDetails[]`의 AUDIO 토큰에 포함되는지 확인.
5. **전사 텍스트 토큰 수**: `inputAudioTranscription` / `outputAudioTranscription` 활성화 시 실제 추가 청구되는 텍스트 출력 토큰량 확인 [S2].
6. **`thoughtsTokenCount` 비중**: `gemini-3.8-live` 출력 단가에 포함되는 thinking 토큰 [S1][S3]이 실제 통화에서 얼마나 발생하는지 확인.
7. **압축 동작 검증**: `triggerTokens` / `targetTokens` 설정 후 매 턴 `promptTokenCount <= triggerTokens`로 상한이 유지되는지 확인 [S3].
8. **압축 전후 첫 음성 지연**: 압축이 발생하는 턴과 미발생 턴 간의 첫 오디오 청크 수신 지연 차이 확인 [S3].

### 9.2 실험 설계

- **비교 조건**: 동일한 10분 영어·한국어 혼합 대본으로 **기준 세션 1회(현재 설정: 압축 미설정)** vs **압축 세션 1회(`triggerTokens=12000`, `targetTokens=6000`)** 실행.
- **선행 코드 보완**: `usageService.ts` `priceUsage()` 152행의 임시 STT OFF 시에도 가산되는 버그 수정 및 `PRICING_RATES`에 `liveOutTextPer1M`($4.50 [S1]) 반영, 턴별 `usageMetadata` 로깅 추가.

| 측정 항목 | 수집 소스 | 확인 목적 |
|---|---|---|
| 턴 번호 및 타임스탬프 | Live WebSocket 이벤트 로그 | 실제 턴/분 및 통화 템포 산출 |
| `promptTokenCount`, `responseTokenCount`, `totalTokenCount` | `usageMetadata` [S3] | 누적/증분 판별 및 턴별 히스토리 재청구 검증 |
| `promptTokensDetails[]`, `responseTokensDetails[]` | `usageMetadata` [S3] | AUDIO 입력·출력 토큰, 무음 구간 포함 여부, 전사 텍스트 토큰 분리 |
| `thoughtsTokenCount` | `usageMetadata` [S3] | Thinking 토큰 비용 비중 확인 |
| 압축 발생 시점 전후 `promptTokenCount` | `usageMetadata` [S3] | `promptTokenCount <= triggerTokens` 준수 및 톱니 패턴 확인 |
| 사용자 발화 종료 → 첫 튜터 오디오 수신 지연 | 클라이언트 타임스탬프 로그 | 압축 전후 체감 지연 증가량 측정 (공식 수치 없음, PoC 측정) |
| 전사 결과 및 대화 맥락 유지 품질 | 통화 녹취·전사본 수동 점검 | 압축 후 맥락 단절 여부 확인 (공식 수치 없음, PoC 측정) |

---

## 10. 단계별 로드맵과 Go/No-Go 기준

> 아래 단계별 수치 기준은 실측 전 수립한 **제안**이며, Track 2 기준선 측정 결과에 따라 확정한다.

| 단계 | 작업 내용 | 산출물 | Go / No-Go 기준 (제안) |
|---|---|---|---|
| **Phase 1: Track 2 실측 및 계측 수정** | `usageMetadata` 로깅 추가, `priceUsage()` 버그 수정, `liveOutTextPer1M` 반영, 10분 동일 대본 기준 1회 vs `12k/6k` 1회 실측 | 실측 리포트 및 실비용 대조표 | **Go**: 8개 항목 실측 완료, `12k/6k`에서 턴당 `promptTokenCount <= 12,000` 확인 (제안) |
| **Phase 2: 1순위 설정 PR (H1-보수)** | 임시 STT 기본 OFF, `12k/6k` 명시 압축, 프롬프트 800 tok 경량화, 강의 TTS Flex 전환, (실측상 무음이 토큰에 잡히는 경우) 클라이언트 VAD 적용 | 프로덕션 설정 PR | **Go**: 기준 세션 대비 체감 지연 허용 범위 내(임계치는 Track 2 기준선 실측 후 확정, 제안) 및 맥락 손실 이슈 없음 / **No-Go**: 압축 지연이 대화 방해 수준이면 `triggerTokens` 상향 또는 재검토 |
| **Phase 3: H1 강화 (`6k/3k` 확대)** | `6k/3k` 설정 테스트 및 점진 적용 | `6k/3k` 실측 비교표 | **Go**: 월 추정 원가 `$25` 이하 달성(제안) 및 10분 통화 품질 유지 / **No-Go**: 압축 5회/통화 지연·맥락 손실이 크면 `12k/6k` 유지 |
| **Phase 4: 차선책 PoC (조건부)** | 사업 목표가 월 `$10~15` 이하로 확정될 경우에만 대안 3 구글 단일 스트리밍 프로토타입 구현·측정 | 대안 3 PoC 리포트 (TTFB·바지인·한영 인식률) | **Go**: 월 추정 원가 `$10~15` 구간 충족(제안) 및 체감 지연·바지인·한영 인식률 수용 가능 / **No-Go**: 발음 직접 청취 부재 또는 지연·바지인 품질 미달 시 H1 유지 |

---

## 11. 한계와 반론

1. **가정 의존성 (추정 한계)**: 본 제안서의 모든 월 원가는 하루 10분, 30일, 4턴/분, 튜터 발화 50%, 시스템 프롬프트 1,500 tok/턴, 환율 ₩1,400/$ 가정에 따른 추정치다. 예를 들어 느린 템포(2.5턴/분, 튜터 30%)에서는 현재 구조에서도 Live 통화 원가가 `$25.11/월`로 달라진다. 실제 사용자 분포에 따라 절감 폭이 변동한다.
2. **무음 차단 효과 과대 추정 가능성**: Gemini 3.1 이후 `TurnCoverage` 기본값이 자동 VAD에서 무음을 제외한다고 명시되어 있어 [S3], 클라이언트 무음 차단으로 기대한 절감(`$45.12 → $28.52`)이 실제로는 훨씬 작을 수 있다(추론). Track 2 실측 없이는 확정할 수 없다.
3. **압축 파라미터 최소값 및 지연 미확인**: `triggerTokens`/`targetTokens`의 최소 허용값과 압축 시 지연 증가량(ms)은 공식 문서에 없다 [S3]. `6k/3k`가 API에서 거부되거나 지연이 예상보다 클 위험이 있다.
4. **전사 과금 및 Thinking 토큰 불확실성**: 전사 추가 과금(`≈$0.0079/일`, 추정)은 175 tok/분 가정에 기반하며, `thoughtsTokenCount` [S3]는 현재 계산식에 포함되지 않았다.
5. **외부 벤더 비공개·변동 항목**: OpenAI `gpt-realtime-2.1-mini`는 초당 오디오 토큰 미공개로 비교에서 제외했고 [S7], GPT-Live는 백엔드 위임 비용을 제외한 수치다 [S8]. Deepgram Nova-3 Multi `$0.0058/분`은 프로모션 단가이며 정가는 `$0.0092/분`이다 [S10]. LiveKit 계산기 예시의 Gemini 3.8 Live `$0.0182/분` 표기는 턴별 재청구를 반영하지 않은 값으로 보인다(추론) [S12].
6. **Flex 미리보기 리스크**: Google Flex는 50% 할인을 제공하지만 preview 상태이며 가변 지연과 best-effort 가용성 조건이 붙는다 [S6]. 실시간 통화가 아닌 강의 TTS 등 비실시간 경로에 한정해 적용해야 한다.

---

## 12. 출처

| 출처 번호 | 문서 / 페이지 | URL | 접속일 |
|---|---|---|---|
| [S1] | Google Gemini API 가격표 | https://ai.google.dev/gemini-api/docs/pricing | 2026-11-26 |
| [S2] | Gemini Live API 모범 사례 (Pricing and billing) | https://ai.google.dev/gemini-api/docs/live-api/best-practices | 2026-11-26 |
| [S3] | Gemini Live API 레퍼런스 | https://ai.google.dev/api/live | 2026-11-26 |
| [S4] | Gemini Live API 세션 관리 | https://ai.google.dev/gemini-api/docs/live-api/session-management | 2026-11-26 |
| [S5] | Gemini 3.8 Live 모델 카드 및 Live API 기능 | https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live / https://ai.google.dev/gemini-api/docs/live-api/capabilities | 2026-11-26 |
| [S6] | Google Flex Inference 및 음성 생성 문서 | https://ai.google.dev/gemini-api/docs/flex-inference / https://ai.google.dev/gemini-api/docs/speech-generation | 2026-11-26 |
| [S7] | OpenAI API 가격표 | https://developers.openai.com/api/docs/pricing | 2026-11-26 |
| [S8] | OpenAI GPT-Live 비용 및 가이드 | https://developers.openai.com/api/docs/guides/voice-latency-cost / https://developers.openai.com/api/docs/guides/live / https://developers.openai.com/api/docs/guides/live-conversations | 2026-11-26 |
| [S9] | Cartesia 가격표 | https://cartesia.ai/pricing | 2026-11-26 |
| [S10] | Deepgram 가격표 및 다국어 코드스위칭 문서 | https://deepgram.com/pricing / https://developers.deepgram.com/docs/multilingual-code-switching / https://developers.deepgram.com/docs/models-languages-overview | 2026-11-26 |
| [S11] | xAI 가격표 및 Voice 가이드 | https://docs.x.ai/docs/pricing / https://docs.x.ai/docs/guides/voice | 2026-11-26 |
| [S12] | LiveKit 가격표 | https://livekit.io/pricing | 2026-11-26 |
