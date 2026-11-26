# 원콜 실시간 통화 비용 절감 제안서

<div class="callout-box">
<p>■ 순영향: 통화 엔진과 모델을 그대로 둔 채 설정만 조정해도 월 원가가 약 42% 줄어듦. 실측 후 압축 기준을 한 단계 더 조이면 절감 폭은 약 58%까지 커짐</p>
<p>■ 즉시 조치: 실측 PR(Track 2) 머지·배포를 승인하면 실제 토큰·무음·지연부터 측정함. 검증을 통과하면 압축·무음 차단·임시 받아쓰기 비활성화를 1순위 설정 변경으로 묶어 반영함</p>
<p>■ 결정 필요: 월 $10~15 목표가 필수라면 구글 단일 스트리밍 PoC를 별도로 추진할지 정해야 함. 다만 이 안은 발음을 직접 듣지 못하는 한계가 있음</p>
</div>

## 1. 비용 구조 — 통화가 길어질수록 같은 대화를 반복 과금함

현재 월 원가는 2026년 단가 기준 $52.34이며 이 중 실시간 통화가 $45.12로 대부분을 차지함.[^1] Gemini Live가 매 턴 대화 오디오를 누적한 뒤 전체를 입력으로 재처리해 과금하기 때문임.[^2]

<div class="card-box" style="display:flex;gap:6pt">
<div class="card" style="flex:1"><div class="card-h">현재 월 원가</div><p class="kpi-v">$52.34</p><p class="kpi-l">2026년 기준, 2027년 $56.41</p></div>
<div class="card" style="flex:1"><div class="card-h">그중 통화 비용</div><p class="kpi-v">$45.12</p><p class="kpi-l">나머지는 받아쓰기·강의 TTS·텍스트</p></div>
<div class="card" style="flex:1"><div class="card-h">10분 통화 중 압축</div><p class="kpi-v">0회</p><p class="kpi-l">10분 누적량이 기본 압축 기준에 미달함</p></div>
</div>

<div class="process-flow">
<div class="step">매 턴 발생<br>(분당 4턴 가정)</div>
<div class="arrow">→</div>
<div class="step">누적 대화 오디오<br><b>전체 재청구</b></div>
<div class="arrow">→</div>
<div class="step">압축 기준 미설정<br>10분 내 압축 없음</div>
<div class="arrow">→</div>
<div class="step">통화 시간의 제곱에<br>비례해 비용 증가</div>
</div>

○ 원인 ① 매 턴 누적 대화를 재청구하는 과금 구조
  - 대화 기록이 원시 오디오 토큰으로 쌓여 매 턴 누적분 전체에 오디오 입력 단가가 다시 부과됨
  - 앱 내 비용 계산식도 같은 구조(통화 시간의 제곱에 비례하는 재청구)를 반영함

○ 원인 ② 압축 설정이 비어 있어 10분 통화 동안 압축이 전혀 작동하지 않음
  - 압축 기준을 정하지 않으면 모델 한도의 80%가 기본값으로 잡힘. 10분 통화 누적량은 이 기준에 크게 못 미침

○ 원인 ③ 발화 없는 무음 구간도 그대로 전송함
  - 앱이 짧은 음성 조각을 조건 없이 전송함. 다만 서버가 이미 무음을 제외하고 있을 가능성이 있어 절감 폭은 실측해 정함(5절)

○ 원인 ④ 통화 중 받아쓰기 추가 과금이 앱 비용 산정에서 누락됨
  - 받아쓰기를 활성화하면 텍스트 출력 단가로 추가 청구되지만 앱 단가표에는 이 항목이 빠져 있음

○ 원인 ⑤ 임시 받아쓰기의 이중 과금과 집계 오류
  - 임시 받아쓰기가 기본으로 켜져 있어 최종 받아쓰기와 별도로 비용이 중복 청구됨
  - 비활성화해도 비용이 계속 합산되는 집계 오류가 있어 실측 단계에서 함께 수정함

※ 파일·함수 단위 근거와 현재 모델 설정은 [부록 A], 원인별 세부 금액은 [부록 D] 참조

## 2. 대안 비교 — 엔진을 유지하는 하이브리드가 비용과 품질의 균형이 가장 우수함

17개 안을 같은 가정(하루 10분, 월 30일)으로 비교한 결과, 엔진을 그대로 쓰는 하이브리드 H1과 목표가에 맞는 구글 단일 스트리밍이 최종 후보로 남음. 안별 산출 근거는 [부록 B]·[부록 D]에 정리함.

<div class="card-box" style="display:flex;gap:6pt">
<div class="card" style="flex:1"><div class="card-h">① 하이브리드 H1 (1순위)</div><p class="kpi-v">$21.73~30.25</p><p class="kpi-l">엔진은 그대로 두고 설정만 바꿔 씀. 발음·억양 직접 청취도 살림</p></div>
<div class="card" style="flex:1"><div class="card-h">② 구글 단일 스트리밍 (차선)</div><p class="kpi-v">$10.49</p><p class="kpi-l">월 $10~15 목표에 맞는 유일한 안. 발음 직접 청취 불가, 지연 미검증</p></div>
<div class="card" style="flex:1"><div class="card-h">③ GPT-Live (참고)</div><p class="kpi-v">$20.69</p><p class="kpi-l">H1과 원가는 비슷하나 엔진 교체 공수가 큼</p></div>
</div>

※ 카드 금액은 2026년 단가 기준 총 월 원가

표 1. 주요 안의 총 월 원가와 판단 (단위: USD/월, 환율 ₩1,400/$)


| 안 | 2026년 | 2027년 | 엔진 교체 | 판단 |
|---|---|---|---|---|
| 현재 | $52.34 | $56.41 | — | 기준선(임시 받아쓰기 활성) |
| H1-보수(12k/6k) | $30.25 | $33.21 | 없음 | 1순위 1단계 |
| H1(6k/3k) | $21.73 | $24.69 | 없음 | 1순위 2단계 |
| 구글 스트리밍 | $10.49 | $15.91 | 있음 | 차선책, PoC 선행 |
| GPT-Live | $20.69 | $24.76 | 있음 | 참고안 |
| Cartesia | $15.44 | $19.51 | 있음 | 발음 직접 청취 불가 |
| Deepgram | $28.19 | $32.26 | 있음 | H1 대비 고비용 |
| xAI | $29.69 | $33.76 | 있음 | H1 대비 고비용 |

※ Cartesia는 3.1 Flash-Lite 결합, Deepgram은 Voice Agent Standard 기준. 전체 17개 안의 통화·총 원가(USD·원)와 일 원가는 [부록 B], 품질 비교는 [부록 C] 참조

## 3. 1순위 하이브리드 H1 — 엔진을 유지한 채 월 원가를 42~58% 절감함

H1은 통화 엔진(`gemini-3.8-live`)을 그대로 두고 다섯 가지 설정을 함께 바꿈. 이 엔진은 사용자 음성을 오디오 그대로 받고, 99개 언어(한국어 포함) 사이를 대화 중에 자연스럽게 전환함.[^3] 보수안으로 먼저 배포해 실측과 품질 검증을 통과하면 압축 기준을 한 단계 더 조임.

<div class="process-flow">
<div class="step">① 보수안 적용<br>압축 12k/6k<br>월 <b>$30.25</b></div>
<div class="arrow">→</div>
<div class="step">② 실측 검증<br>지연·맥락 유지 확인</div>
<div class="arrow">→</div>
<div class="step">③ 압축 6k/3k 전환<br>월 <b>$21.73</b></div>
</div>

○ 구성 다섯 가지
  - 압축 기준 명시: 대화 기록이 1만 2천 토큰에 도달하면 6천 토큰만 남김(보수안 12k/6k). 검증 뒤 기준을 6k/3k로 조임
  - 무음 차단: 발화가 없는 무음 구간은 전송하지 않음
  - 프롬프트 경량화: 매 턴 포함되는 시스템 지시문을 1,500토큰에서 800토큰으로 줄임
  - 임시 받아쓰기 비활성화: 최종 받아쓰기와 겹치는 중간 받아쓰기는 기본값에서 끔
  - 강의 TTS Flex(할인 등급) 전환: 실시간 처리가 불필요한 강의 음성에만 씀

○ 선정 사유
  - 엔진·모델명을 바꾸지 않는 원칙을 지키는 대안 가운데 절감 폭이 가장 큼
  - 영어 회화 앱의 핵심 기능인 발음·억양 직접 청취, 자연스러운 한영 전환, 말 끊기(바지인)를 그대로 살림
  - 통화 모델은 2027년 단가 인상 예고가 없음. 강의 TTS를 Flex로 바꾸면 2027년 인상분을 상쇄함

<div class="callout-box">
<p>■ 무음 차단 효과는 서버의 기본 무음 제외 설정 때문에 예상보다 작을 수 있음 → 실측해 정함</p>
<p>■ 6k/3k는 10분 통화당 압축이 5회 일어나 일시적 지연·맥락 손실 위험이 있음 → 단계적 전환으로 대응함</p>
<p>■ Flex는 미리보기 단계로 지연 편차가 큼 → 비실시간 강의 TTS에만 씀</p>
</div>

## 4. 차선책 구글 단일 스트리밍 — 월 $10~15 목표에 닿는 유일한 안, PoC로 먼저 검증

받아쓰기·답변 생성·음성 합성을 분리해 연결함. 2026년 총 월 원가가 $10.49까지 내려가고 대화가 텍스트로 전달돼 오디오 재청구가 원천적으로 사라짐.[^4] 원가 산식은 [부록 D] 참조.

<div class="process-flow">
<div class="step">실시간 받아쓰기<br><code>gemini-3.5-transcribe-live</code></div>
<div class="arrow">→</div>
<div class="step">답변 생성<br><code>gemini-3.1-flash-lite</code></div>
<div class="arrow">→</div>
<div class="step">음성 합성<br><code>gemini-3.8-flash-lite-tts</code></div>
</div>

○ 장점
  - 구글 단일 벤더를 쓰면서 목표 원가 구간을 충족하는 유일한 방식임(2026년 기준)
  - 2027년 단가로는 총 월 원가가 $15.91로 목표 상단을 소폭 넘어섬

○ 한계
  - AI가 텍스트 변환 결과만 받으므로 사용자 발음·억양을 직접 들을 수 없음
  - 3단 직렬 연결, 말 끊기 처리, 문장 단위 스트리밍을 자체 구현·운영해야 함
  - 음성 합성 단가가 2027년 2배로 오를 예정임

○ PoC 검증 항목
  - 첫 응답 지연, 턴 전환 지연, 말 끊기 오작동 유무
  - 한영 혼합 발화 인식률, 영어 튜터 교정 품질

※ 받아쓰기를 Deepgram으로 대체한 변형안은 프로모션 단가 기준 최저가지만 정가로 바뀌면 비용 이점이 사라짐([부록 B]·[부록 F])

## 5. 실측 계획(Track 2) — 엔진을 교체하기 전에 8가지를 먼저 확인

같은 10분 영어·한국어 혼합 대본으로 현재 설정 1회와 압축 12k/6k 1회를 비교함. 실측에 앞서 앱 단가표 누락과 임시 받아쓰기 집계 오류부터 바로잡음.[^5]

<div class="process-flow">
<div class="step">① 계측 보완<br>단가 누락·집계 오류 수정<br>턴별 사용량 기록</div>
<div class="arrow">→</div>
<div class="step">② 10분 통화 2회<br>현재 설정 vs 12k/6k</div>
<div class="arrow">→</div>
<div class="step">③ 8개 항목 판정</div>
<div class="arrow">→</div>
<div class="step">④ 1순위 설정 변경<br>착수 여부 결정</div>
</div>

표 2. 실측 확인 항목 8가지


| 번호 | 확인 항목 | 확인 목적 |
|---|---|---|
| 1 | 사용량 값의 턴별·누적 구분 | 턴별 재청구 산정 기준 확정 |
| 2 | 턴당 입력 토큰에 대화 기록 포함 유무 | 재청구 과금 구조의 실측치 반영 점검 |
| 3 | 실제 분당 턴 수 | 가정(분당 4턴)과의 차이 비교 |
| 4 | 무음 구간에 오디오 토큰이 계상되는지 | 무음 차단 절감 폭 산정 |
| 5 | 받아쓰기 텍스트 토큰 수 | 받아쓰기 추가 과금 규모 파악 |
| 6 | 사고(thinking) 토큰 비중 | 출력 단가에 포함된 숨은 비용 확인 |
| 7 | 압축 후 입력 토큰 상한이 지켜지는지 | 압축 설정의 정상 작동 검증 |
| 8 | 압축 전후 첫 음성 지연 | 압축이 대화 흐름을 저해하는지 검토 |

※ 항목별 수집 필드와 수집 경로는 [부록 A] 참조

## 6. 단계별 로드맵 — 4단계로 나눠 단계마다 진행·중단을 판정

<div class="process-flow">
<div class="step">1단계<br>실측·계측 수정</div>
<div class="arrow">→</div>
<div class="step">2단계<br>H1-보수 설정 적용</div>
<div class="arrow">→</div>
<div class="step">3단계<br>6k/3k 확대</div>
<div class="arrow">→</div>
<div class="step">4단계(조건부)<br>구글 스트리밍 PoC</div>
</div>

표 3. 단계별 작업과 진행·중단 기준


| 단계 | 작업 | 진행 기준 | 중단·보류 시 |
|---|---|---|---|
| 1 | 턴별 사용량 기록, 집계 오류·단가 누락 수정, 10분 통화 2회 실측 | 8개 항목 실측 완료, 12k/6k에서 턴당 입력 12,000토큰 이하 유지 | 원인 파악 후 재측정 |
| 2 | 임시 받아쓰기 비활성화, 12k/6k 압축, 프롬프트 경량화, 강의 TTS Flex 전환, 무음 과금 확인 시 무음 차단 적용 | 지연이 허용 범위 이내이고 맥락 손실 없음 | 압축 기준 상향 또는 재검토 |
| 3 | 6k/3k 시험 적용 후 점진 확대 | 월 원가 $25 이하, 10분 통화 품질 유지 | 12k/6k 그대로 둠 |
| 4 | 월 $10~15 목표가 확정될 때만 구글 스트리밍 시제품 측정 | 목표 원가 충족, 지연·말 끊기·한영 인식 수용 가능 | H1 유지 |

※ 진행 기준의 수치와 지연 허용 범위는 1단계 실측 결과로 확정함

## 7. 다음 액션 — 실측 결과 확보 후 1순위 설정 변경에 착수

<div class="process-flow" style="flex-wrap:nowrap;gap:3px">
<div class="step" style="flex:1 1 0;padding:5pt 4pt">① 찬식님<br>실측 PR 머지·배포 승인<br><b>즉시</b></div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">② Engineering Lead<br>10분 실통화 2회 측정·리포트<br><b>배포 직후</b></div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">③ 찬식님<br>H1-보수 착수 승인<br><b>리포트 검토 후</b></div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">④ Engineering Lead<br>H1-보수 설정 초안 PR(엔진 유지)<br><b>승인 직후</b></div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">⑤ 찬식님<br>월 $10~15 목표·PoC 결정<br><b>3단계 결과 후</b></div>
</div>

<div class="pb"></div>

## [부록 A] 원인별 코드 근거와 측정 필드

기준 코드는 `origin/main (4128a84)`임.

표 A-1. 원인별 코드 근거


| 원인 | 위치 | 내용 |
|---|---|---|
| 누적 재청구 | `src/services/usage/usageService.ts` `liveCost()` | `baseIn + baseOut + promptRebill + contextRebill` 구조로 통화 시간의 제곱에 비례하는 재청구 반영 |
| 압축 미설정 | `server/liveConfig.ts`, `src/services/providers/liveWire.ts` `buildDirectSetup` | `contextWindowCompression: { slidingWindow: {} }`만 전송, `triggerTokens`·`targetTokens` 미지정 |
| 무음 전송 | `src/services/providers/geminiLiveProvider.ts` `onaudioprocess` | `ScriptProcessor` 2048샘플(약 128ms) 청크를 `conn.ready`이면 무조건 `sendAudioChunk`로 전송. `automaticActivityDetection` 명시 설정 없음 |
| 받아쓰기 과금 누락 | `server/liveConfig.ts`, `liveWire.ts`, `src/config/models.ts` | `inputAudioTranscription`·`outputAudioTranscription` 활성, `PRICING_RATES`에 `liveOutTextPer1M`($4.50) 없음 |
| 임시 받아쓰기 | `src/App.tsx` 79행, `chunkRecorder.ts` | `onecall_enable_partial_transcribe !== "false"`로 기본 켬, 1분마다 `/api/gemini/transcribe-partial` 호출 |
| 집계 오류 | `usageService.ts` `priceUsage()` 152행 | `stt = (sttMin + liveMin + qaMin) × 분당 STT`로 임시 받아쓰기를 꺼도 비용이 더해짐 |

○ 현재 모델 설정(`src/config/models.ts`)
  - `LIVE_MODEL` `gemini-3.8-live`, `TEXT_MODEL` `gemini-3.8-flash`, `GEMINI_STT_MODEL` `gemini-3.5-transcribe`(VERBATIM)
  - `GEMINI_TTS_MODEL` `gemini-3.8-flash-tts`, LITE TTS `gemini-3.8-flash-lite-tts`
  - `src/data/lessonPromptBuilder.ts`는 4,341바이트

표 A-2. 실측 수집 필드와 경로


| 측정 항목 | 수집 경로 | 확인 목적 |
|---|---|---|
| 턴 번호·타임스탬프 | Live WebSocket 이벤트 로그 | 실제 분당 턴 수와 통화 템포 |
| `promptTokenCount`, `responseTokenCount`, `totalTokenCount` | `usageMetadata` | 누적·증분 판별, 턴별 재청구 검증 |
| `promptTokensDetails[]`, `responseTokensDetails[]` | `usageMetadata` | 오디오 입출력 토큰, 무음 포함 여부, 받아쓰기 텍스트 토큰 분리 |
| `thoughtsTokenCount` | `usageMetadata` | 사고 토큰 비용 비중 |
| 압축 전후 `promptTokenCount` | `usageMetadata` | `promptTokenCount <= triggerTokens` 준수와 톱니 패턴 |
| 발화 종료 → 첫 튜터 오디오 지연 | 클라이언트 타임스탬프 로그 | 압축 전후 체감 지연 증가량 |
| 받아쓰기 결과·맥락 유지 | 통화 녹취·받아쓰기 수동 점검 | 압축 후 맥락 단절 여부 |

## [부록 B] 전체 비용 비교

17개 안의 통화·총 원가를 월·일 단위로 정리함. 모두 추정치임.

표 B-1. 안별 통화·총 월 원가 (공통 비통화 기준: 임시 받아쓰기 끔 $5.69/$9.76, 현재 행만 켬. H1 두 행은 강의 TTS Flex 포함)


| 안 | 통화 월<br>(2026) | 통화 월<br>(2027) | 총 월 USD<br>(2026) | 총 월 USD<br>(2027) | 총 월 원<br>(2026) | 총 월 원<br>(2027) |
|---|---|---|---|---|---|---|
| 현재(임시 받아쓰기 켬) | $45.12 | $45.12 | $52.34 | $56.41 | ₩73,280 | ₩78,976 |
| 임시 받아쓰기 끄기만 | $45.12 | $45.12 | $50.81 | $54.88 | ₩71,138 | ₩76,834 |
| 대안1-a 압축 12k/6k | $30.90 | $30.90 | $36.59 | $40.66 | ₩51,222 | ₩56,918 |
| 대안1-b 압축 6k/3k | $19.79 | $19.79 | $25.48 | $29.55 | ₩35,676 | ₩41,373 |
| 무음 차단만(발화 40% 가정) | $28.52 | $28.52 | $34.21 | $38.28 | ₩47,890 | ₩53,587 |
| 롤링 요약(3분 20초마다 새 세션) | $17.71 | $17.71 | $23.40 | $27.47 | ₩32,761 | ₩38,457 |
| H1(6k/3k+무음 차단+프롬프트 800+강의 TTS Flex) | $17.15 | $17.15 | $21.73 | $24.69 | ₩30,422 | ₩34,561 |
| H1-보수(12k/6k+무음 차단+프롬프트 800+강의 TTS Flex) | $25.67 | $25.67 | $30.25 | $33.21 | ₩42,352 | ₩46,492 |
| GPT-Live(`gpt-live-1.1`, 활성 $0.05/분) | $15.00 | $15.00 | $20.69 | $24.76 | ₩28,964 | ₩34,660 |
| Cartesia($0.03/분)+3.1 Flash-Lite | $9.75 | $9.75 | $15.44 | $19.51 | ₩21,617 | ₩27,313 |
| Cartesia+3.8 Flash | $11.24 | $13.47 | $16.92 | $23.23 | ₩23,695 | ₩32,521 |
| Deepgram Voice Agent Standard($0.075/분) | $22.50 | $22.50 | $28.19 | $32.26 | ₩39,464 | ₩45,160 |
| Deepgram BYO LLM($0.065/분)+3.1 Flash-Lite | $20.25 | $20.25 | $25.94 | $30.01 | ₩36,317 | ₩42,013 |
| xAI `grok-voice-3.0`($0.08/분) | $24.00 | $24.00 | $29.69 | $33.76 | ₩41,564 | ₩47,260 |
| 구글 스트리밍(Transcribe Live+3.1 Flash-Lite+3.8 Flash-Lite TTS) | $4.80 | $6.15 | $10.49 | $15.91 | ₩14,687 | ₩22,273 |
| 구글 스트리밍+LiveKit 세션($0.01/분) | $7.80 | $9.15 | $13.49 | $18.91 | ₩18,887 | ₩26,473 |
| 구글 스트리밍 변형(Deepgram Nova-3 Multi+3.1 Flash-Lite+3.8 Flash-Lite TTS) | $3.84 | $5.19 | $9.53 | $14.95 | ₩13,343 | ₩20,929 |

표 B-2. 안별 총 일 원가 (총 일 = 총 월 ÷ 30)


| 안 | 2026년 | 2027년 |
|---|---|---|
| 현재(임시 받아쓰기 켬) | $1.745 (₩2,443) | $1.880 (₩2,632) |
| 임시 받아쓰기 끄기만 | $1.694 (₩2,371) | $1.829 (₩2,561) |
| 대안1-a 압축 12k/6k | $1.220 (₩1,708) | $1.355 (₩1,897) |
| 대안1-b 압축 6k/3k | $0.849 (₩1,189) | $0.985 (₩1,379) |
| 무음 차단만 | $1.140 (₩1,596) | $1.276 (₩1,786) |
| 롤링 요약 | $0.780 (₩1,092) | $0.916 (₩1,282) |
| H1(6k/3k) | $0.724 (₩1,014) | $0.823 (₩1,152) |
| H1-보수(12k/6k) | $1.008 (₩1,412) | $1.107 (₩1,550) |
| GPT-Live | $0.690 (₩966) | $0.825 (₩1,155) |
| Cartesia+3.1 Flash-Lite | $0.515 (₩721) | $0.650 (₩910) |
| Cartesia+3.8 Flash | $0.564 (₩790) | $0.774 (₩1,084) |
| Deepgram Standard | $0.940 (₩1,316) | $1.075 (₩1,505) |
| Deepgram BYO LLM | $0.865 (₩1,211) | $1.000 (₩1,400) |
| xAI `grok-voice-3.0` | $0.990 (₩1,386) | $1.125 (₩1,575) |
| 구글 스트리밍 | $0.350 (₩490) | $0.530 (₩742) |
| 구글 스트리밍+LiveKit | $0.450 (₩630) | $0.630 (₩882) |
| 구글 스트리밍 변형(Deepgram) | $0.318 (₩445) | $0.498 (₩698) |

## [부록 C] 품질 비교

공식 문서·코드 근거가 있는 항목만 적음. 「PoC」는 시제품 측정으로 정할 항목임.

표 C-1. 지연·말 끊기·한영 혼합 인식


| 안 | 체감 지연 | 말 끊기(바지인) | 한영 혼합 인식 |
|---|---|---|---|
| H1(12k/6k → 6k/3k) | PoC(압축 시 일시적 지연 증가 경고) | 지원(`interrupted:true`) | 지원(99개 언어·한국어, 대화 중 자연 전환), 정확도 PoC |
| GPT-Live | PoC | PoC | 한국어 음성(`Noeul`) 지원, 혼합 인식 PoC |
| Cartesia+LLM | PoC | PoC | 44개 언어(한국어 페이지 있음), 혼합 인식 PoC |
| Deepgram Voice Agent | PoC | PoC | Nova-3 한국어·코드스위칭 지원, 정확도 PoC |
| xAI `grok-voice-3.0` | PoC(xAI 문서에 1초 미만 지연 표기) | PoC | PoC |
| 구글 스트리밍 | PoC(3단 직렬 지연) | PoC(직접 구현 필요) | 한국어 TTS 지원, 받아쓰기 혼합 인식 PoC |
| 구글 스트리밍 변형(Deepgram) | PoC(endpointing 100ms 권장) | PoC(직접 구현 필요) | Nova-3 한국어·코드스위칭 지원, 정확도 PoC |

표 C-2. 발음 청취·구현 공수·운영 리스크


| 안 | 발음·억양 직접 청취 | 구현 공수 | 기존 파이프라인 호환 | 운영 리스크 |
|---|---|---|---|---|
| H1 | 가능(네이티브 오디오) | 낮음(설정·클라이언트 보완) | 높음(같은 엔진·프로토콜) | 낮음(압축 지연·Flex 가변 지연 확인 필요) |
| GPT-Live | 가능(S2S) | 높음(WebRTC 권장, 세션 모델 전환) | 낮음(엔진 교체) | 중간(백엔드 위임 과금, 음소거도 활성 과금) |
| Cartesia+LLM | 불가(텍스트 경유) | 높음(에이전트 통합) | 낮음(외부 에이전트) | 중간(플랜·크레딧·초과 과금 관리) |
| Deepgram Voice Agent | 불가(텍스트 경유) | 중간~높음(WebSocket 전환) | 낮음(엔진 교체) | 중간(연결 시간 전체 과금) |
| xAI `grok-voice-3.0` | 가능(S2S) | 높음(`/v1/realtime` 전환) | 낮음(엔진 교체) | 중간(단가 높음) |
| 구글 스트리밍 | 불가(받아쓰기 텍스트 경유) | 높음(풀듀플렉스 오케스트레이션 신규 개발) | 낮음(아키텍처 전면 변경) | 높음(바지인·스트리밍 안정성, 2027 TTS 인상) |
| 구글 스트리밍 변형(Deepgram) | 불가(받아쓰기 텍스트 경유) | 높음(멀티 벤더 스트리밍) | 낮음(아키텍처 전면 변경) | 높음(멀티 벤더, 프로모 종료 시 정가 $0.0092/분) |

○ 대안별 공식 확인 사실(보충)
  - GPT-Live: 활성 시간에 발화, idle timeout 전 무음, 백엔드 대기가 포함됨. 대기 요율은 WebRTC standby(`idle_timeout_s` 5~60초)에서만 적용되고 마이크 음소거는 활성으로 과금됨. WebRTC 권장(WebSocket 지원), LiveKit·Twilio·Daily/Pipecat 연동 지원
  - Cartesia: 플랜 초과 사용은 기본 꺼짐 상태
  - Deepgram Nova-3 Multilingual: `language=multi`(+`language_hint`)와 한국어 지원, 권장 endpointing 100ms. Flux Multilingual($0.0078/분)은 코드스위칭을 네이티브 지원
  - xAI `grok-voice-3.0`: 엔드포인트 `/v1/realtime`에서 "sub-second latency"를 표기
  - `gemini-3.8-flash-lite-tts`: `stream:true`로 헤더 없는 24kHz PCM 스트리밍 합성과 한국어 지원

## [부록 D] 비용 산식과 가정

○ 공통 가정(작업지시서와 앱 `USAGE_ASSUMPTIONS` 기준, 모든 월 원가는 추정치)
  - 통화량: 하루 10분, 월 30일(월 300분), 분당 4턴(통화당 40턴)
  - 튜터 발화 비중 50%(월 150분), 시스템 프롬프트 1,500 tok/턴
  - 오디오 토큰율 25 audio tok/s = 1,500 tok/분, 환율 ₩1,400/$

○ Gemini Live 일 비용 산식
  - `[산식] Live 일 비용 = 기본입력 + 기본출력 + 프롬프트 재청구 + 히스토리 재청구 + 받아쓰기 추가`
  - 기본입력: 10분 × 1,500 tok/분 × $3.00 ÷ 1,000,000 = $0.045
  - 기본출력: 10분 × 0.5 × 1,500 tok/분 × $12.00 ÷ 1,000,000 = $0.090
  - 프롬프트 재청구: 40턴 × 1,500 tok/턴 × $0.75 ÷ 1,000,000 = $0.045
  - 히스토리 재청구: (턴마다 직전까지 쌓인 오디오 토큰의 합계) × $3.00 ÷ 1,000,000
  - 받아쓰기 추가: 10분 × 175 tok/분 × $4.50 ÷ 1,000,000 ≈ $0.0079

○ 히스토리 누적과 압축
  - 분당 2,250 tok(사용자 1,500 + 튜터 750)이 쌓임(추정). 턴 단위 합산(첫 턴 누적 0) 결과 히스토리 재청구는 하루 $1.316
  - 앱 `usageService.ts`의 연속식(4 × 1,500 × 1.5 × (분² ÷ 2) × $3/1M)은 하루 $1.35(작업지시서 값)로, 두 방식 차이는 약 2.5%
  - 압축 기준 미지정 시 기본값은 모델 한도의 80%. `gemini-3.8-live` 입력 한도 131,072 tok × 80% ≈ 104,858 tok이고, 10분 통화 누적은 약 22,500 tok(추정)이라 압축 0회
  - `triggerTokens`·`targetTokens`를 지정하면 누적 기록이 그 사이에서 톱니 모양으로 유지됨

○ Live 통화 월 원가(월 30일, 추정)
  - 현재(압축 미설정) $45.12, 문서 예시 압축 25k/8k도 $45.12(10분 누적 22.5k < 25k라 압축 0회)
  - 압축 12k/6k $30.90(통화당 2회), 6k/3k $19.79(통화당 5회)
  - 무음 차단만(사용자 입력 중 실제 발화 40% 가정) $28.52
  - 12k/6k + 무음 차단 + 프롬프트 800 tok $25.67, 6k/3k + 같은 조합 $17.15
  - 롤링 요약(3분 20초마다 새 세션, 요약 300 tok 추가) $17.71
  - 참고: 느린 템포(분당 2.5턴, 튜터 발화 30%)에서는 현재 구조도 $25.11

○ 비통화 월 원가(2026년 / 2027년)
  - `[산식] 비통화 월 합계 = 최종 받아쓰기 + 강의 TTS + 텍스트(gemini-3.8-flash, 입력 19,000·출력 12,600 tok/일) + 기타`
  - 최종 받아쓰기(하루 10분) $1.53 / $1.53, 임시 받아쓰기(켤 때만 추가) $1.53 / $1.53
  - 강의 TTS(Standard) $2.22 / $4.45, 텍스트(3.8 Flash Standard) $1.85 / $3.69, 기타 $0.09 / $0.09
  - 합계: 임시 받아쓰기 끔 $5.69 / $9.76, 켬 $7.22 / $11.29
  - 강의 TTS Flex 전환 시 절감 -$1.11 / -$2.22

○ 구글 스트리밍 통화 월 원가
  - 받아쓰기(월 300분): `gemini-3.5-transcribe-live` $0.009/분 × 300분 = $2.70, Deepgram Nova-3 Multilingual(프로모) $0.0058/분 × 300분 = $1.74
  - 답변 생성: 턴당 입력 = 1,500 + (175 tok/분 × 경과 분), 40턴 합계 95,000 tok/일, 출력 875 tok/일
  - 답변 모델: `gemini-3.8-flash` $2.24(2026) → $4.47(2027), `gemini-3.1-flash-lite` $0.75(두 해 같음)
  - 음성 합성(튜터 발화 월 150분): `gemini-3.8-flash-lite-tts` 150분 × 1,500 tok/분 × $6.00/1M = $1.35(2026) → $2.70(2027)

○ 보조 항목
  - 프롬프트 경량화(1,500 → 800 tok): 40턴 × 700 tok × $0.75/1M = 하루 $0.021, 월 약 $0.63(추정). 단독 효과는 작지만 압축 공간을 넓히는 부수 효과가 있어 H1에 포함
  - 롤링 요약: Live API는 오디오 전용 세션 15분 제한, 연결 수명 약 10분(`sessionResumption` 토큰 2시간 유효, `GoAway` 메시지)을 이미 관리해야 함. 3분 20초마다 강제 재연결을 얹으면 대화 단절·재연결 지연이 커지고, H1 6k/3k($17.15)보다 비용 이점도 없어 우선순위가 낮음
  - 경량 모델: `gemini-3.8-live`, `gemini-3.1-flash-live-preview`, `gemini-2.5-flash-native-audio-preview-12-2025` 모두 오디오 입력 $3.00/1M·출력 $12.00/1M로 더 싼 오디오 단가 모델이 없음. OpenAI `gpt-realtime-2.1-mini`는 초당 오디오 토큰 수가 공개되지 않아 계산에서 뺌

※ 세션 제한은 Live API 세션 관리 문서 기준[^6]

## [부록 E] 가정과 한계

모든 월 원가는 아래 가정에 따른 추정치이며, 실제 사용 분포에 따라 절감 폭이 달라짐.

○ 사용량 가정
  - 하루 10분, 30일, 분당 4턴, 튜터 발화 50%, 시스템 프롬프트 1,500 tok/턴, 환율 ₩1,400/$
○ 무음 차단 효과
  - 기대 효과($45.12 → $28.52)는 Gemini 3.1 이후 `TurnCoverage` 기본값(`TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO`)이 자동 VAD에서 무음을 빼도록 되어 있어 실제로는 훨씬 작을 수 있음. 1단계 실측의 확인 항목 4번으로 확정함
  - 반대로 `Proactive Audio Mode`를 켜면 듣는 내내 입력 토큰이 청구됨
○ 압축 파라미터
  - `triggerTokens`·`targetTokens`의 최소 허용값과 압축 때 늘어나는 지연(ms)은 1단계 실측에서 확인함
  - 6k/3k가 API에서 거부되거나 지연이 예상보다 클 수 있음
○ 받아쓰기·사고 토큰
  - 받아쓰기 추가 과금(하루 약 $0.0079)은 175 tok/분 가정에 기반함
  - `thoughtsTokenCount`는 현재 계산식에 포함되지 않았음
○ 외부 벤더 수치
  - GPT-Live 원가는 백엔드 위임 비용을, xAI 원가는 $0.004/text input 추가분을 뺀 값임
  - Deepgram Nova-3 Multi $0.0058/분은 프로모션 단가(정가 $0.0092/분)
  - LiveKit 계산기 예시는 Gemini 3.8 Live를 $0.0182/분 정액으로 표기함. 이 문서의 턴별 재청구 산식([부록 D])과 계산 방식이 다름
○ Flex 적용 범위
  - Google Flex는 50% 할인이지만 preview 상태로 가변 지연·best-effort 가용성 조건이 붙음
  - 실시간 통화가 아닌 강의 TTS 같은 비실시간 경로에만 적용함

※ LiveKit 단가와 계산기 예시는 LiveKit 가격표 기준[^7]

<div class="pb"></div>

## [부록 F] 공식 단가 검증표

2026-11-26 KST에 각 벤더 공식 가격 페이지를 직접 확인한 값임.

표 F-1. Google Gemini API 단가 (Standard, 2027-01-01 인상, Flex)[^8]


| 모델 | 항목 | 2026년 | 2027-01-01 | 비고 |
|---|---|---|---|---|
| `gemini-3.8-live` / `gemini-3.8-live-extended-thinking` / `gemini-3.1-flash-live-preview` | Input(text / audio / image·video) | $0.75/1M / $3.00/1M($0.005/분) / $1.00/1M | 인상 표기 없음 | Context caching, Batch·Flex·Priority 미지원 |
| `gemini-3.8-live` 계열 | Output(text / audio, thinking 포함) | $4.50/1M / $12.00/1M($0.018/분) | 인상 표기 없음 | 입력 한도 131,072 / 출력 65,536 |
| `gemini-2.5-flash-native-audio-preview-12-2025` | Input(text / audio) / Output(text / audio) | $0.50 / $3.00 / $2.00 / $12.00 (/1M) | 인상 표기 없음 | 오디오 단가는 3.8 Live와 같음 |
| `gemini-3.8-flash` (Standard) | Input / Output(thinking 포함) | $0.75/1M / $3.75/1M | $1.50/1M / $7.50/1M | Context caching $0.075→$0.15/1M, 저장 $0.50→$1.00/1M/시간; Priority $1.35→$2.70 / $6.75→$13.50 |
| `gemini-3.8-flash` (Batch·Flex) | Input / Output | $0.375/1M / $1.875/1M | $0.75/1M / $3.75/1M | 2027 Flex 단가 = 2026 Standard 단가; Flex는 50% 할인·가변 지연·preview |
| `gemini-3.6-flash` (Standard) | Input / Output | $0.75/1M / $3.75/1M | $1.50/1M / $7.50/1M | 3.8 Flash와 같음 |
| `gemini-3.5-flash-lite` | Input / Output | $0.30/1M / $2.50/1M | 인상 표기 없음 | - |
| `gemini-3.1-flash-lite` | Input(text·img·vid / audio) / Output | $0.25/1M / $0.50/1M / $1.50/1M | 인상 표기 없음 | Flex 지원, Live API 미지원 |
| `gemini-3.5-transcribe` | Input audio / Output text | $2.00/1M($0.003/분) / $12.00/1M($0.002/분) | 인상 표기 없음 | 25 audio tok/s, 175 text tok/분 기준 약 $0.005/분; Flex 미지원 |
| `gemini-3.5-transcribe-live` | Input audio / Output text | $3.50/1M($0.005/분) / $21.00/1M($0.004/분) | 인상 표기 없음 | WebSocket 실시간 STT, 약 $0.009/분 |
| `gemini-3.8-flash-tts` (Standard) | Input text / Output audio | $0.50/1M / $9.00/1M (10초당 $0.00225) | $1.00/1M / $18.00/1M (10초당 $0.0045) | 오디오 25 tok/s; Priority $0.90→$1.80 / $16.20→$32.40; Live API 미지원 |
| `gemini-3.8-flash-tts` (Batch·Flex) | Input text / Output audio | $0.25/1M / $4.50/1M | $0.50/1M / $9.00/1M | 2027 Flex = 2026 Standard |
| `gemini-3.8-flash-lite-tts` (Standard) | Input text / Output audio | $0.50/1M / $6.00/1M (10초당 $0.0015) | $1.00/1M / $12.00/1M (10초당 $0.003) | Flex 지원, Live API 미지원(입력 8,192 tok) |
| `gemini-3.8-flash-lite-tts` (Batch·Flex) | Output audio | $3.00/1M | $6.00/1M | - |

표 F-2. 타사 음성·실시간 API와 인프라 단가[^9]


| 벤더·제품 | 모델·티어 | 공식 단가 | 비고 |
|---|---|---|---|
| OpenAI GPT-Live | `gpt-live-1.1` / `gpt-live-1` | 활성 $0.05/분, 대기(standby) $0.02/분 | 초 단위 과금, 세션 생성 시 15초 선청구(이후 상계), 백엔드 모델 비용 별도 |
| OpenAI Realtime | `gpt-realtime-2.1` | Audio in $32/1M, out $64/1M, cached $0.40/1M; Text in $4/1M, out $24/1M | 초당 오디오 토큰 수 미공개 |
| OpenAI Realtime Mini | `gpt-realtime-2.1-mini` | Audio in $10/1M, out $20/1M, cached $0.30/1M; Text in $0.60/1M, out $2.40/1M, cached $0.06/1M | 초당 오디오 토큰 수 미공개 → 월 원가 계산 제외 |
| OpenAI Transcribe | `gpt-live-transcribe` | $0.017/분 | - |
| Cartesia | Managed Agents(표준) | $0.03/분 | telephony·LLM 사용료 별도; 플랜 Free $0(에이전트 $1), Pro $5/월(에이전트 $5, 100K 크레딧), Startup $49, Scale $299 |
| Cartesia | Sonic TTS / Ink STT | Sonic 1 credit/글자(분당 약 750~800 크레딧), Ink 3 credit/초 | 44개 언어 음성(한국어 페이지 있음) |
| Deepgram Voice Agent | Standard / BYO TTS / BYO LLM / BYO LLM+TTS / Advanced | $0.075/분 / $0.056/분 / $0.065/분 / $0.050/분 / $0.163/분 | WebSocket 연결 시간 기준, Pay as you go |
| Deepgram STT·TTS | Nova-3 Multi / Flux Multi / Aura-2 / Flux TTS | Nova-3 Multi $0.0058/분(프로모, 정가 $0.0092/분), Flux Multi $0.0078/분; Aura-2 $0.030/1k자, Flux TTS $0.045/1k자 | Nova-3 다국어 목록에 Korean 포함, 권장 endpointing 100ms |
| xAI | `grok-voice-3.0`(Speech to Speech) | $0.08/분($4.80/시간) + $0.004/text input | `grok-voice-2.0` Deprecated, 별칭 `grok-voice-latest`, `/v1/realtime` |
| xAI STT | STT 스트리밍 | $0.20/시간 | 38개+ 언어 |
| LiveKit Cloud | Build / Ship / Scale + Agent session | 기본 $0/월 / $50/월부터 / $500/월부터; Agent session $0.0100/분(Build/Ship) | - |

○ 작업지시서 사전 값과 달라진 점
  - xAI: 과금 모델명은 `grok-voice-3.0`, 단가는 $0.08/분 + $0.004/text input(`grok-voice-2.0`은 Deprecated, 별칭 `grok-voice-latest`)
  - Deepgram Voice Agent: Pay as you go 기준 Standard $0.075/분, BYO LLM $0.065/분(BYO TTS $0.056/분, BYO LLM+TTS $0.050/분, Advanced $0.163/분)
  - OpenAI GPT-Live: 분당 정액 음성 대화 제품(`gpt-live-1.1` / `gpt-live-1`, 활성 $0.05/분, 대기 $0.02/분)을 새로 확인해 대안 2에 반영

<div class="pb"></div>

## [부록 G] 출처

모든 출처는 2026-11-26 KST에 확인함. 각주 번호는 본문에서 처음 쓰인 순서임.

[^1]: Google, Gemini API 가격표, https://ai.google.dev/gemini-api/docs/pricing
[^2]: Google, Gemini Live API 모범 사례(Pricing and billing), https://ai.google.dev/gemini-api/docs/live-api/best-practices
[^3]: Google, Gemini 3.8 Live 모델 카드·Live API 기능, https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live , https://ai.google.dev/gemini-api/docs/live-api/capabilities
[^4]: Google, Flex Inference·음성 생성 문서, https://ai.google.dev/gemini-api/docs/flex-inference , https://ai.google.dev/gemini-api/docs/speech-generation
[^5]: Google, Gemini Live API 레퍼런스, https://ai.google.dev/api/live
[^6]: Google, Gemini Live API 세션 관리, https://ai.google.dev/gemini-api/docs/live-api/session-management
[^7]: LiveKit 가격표, https://livekit.io/pricing
[^8]: Google 가격표(각주 1)와 모델 카드(각주 3), Flex·음성 생성 문서(각주 4) 기준
[^9]: OpenAI 가격표 https://developers.openai.com/api/docs/pricing ; OpenAI GPT-Live 가이드 https://developers.openai.com/api/docs/guides/voice-latency-cost , https://developers.openai.com/api/docs/guides/live , https://developers.openai.com/api/docs/guides/live-conversations ; Cartesia 가격표 https://cartesia.ai/pricing ; Deepgram 가격표·다국어 코드스위칭 문서 https://deepgram.com/pricing , https://developers.deepgram.com/docs/multilingual-code-switching , https://developers.deepgram.com/docs/models-languages-overview ; xAI 가격표·Voice 가이드 https://docs.x.ai/docs/pricing , https://docs.x.ai/docs/guides/voice

<style>.pb{break-before:page;page-break-before:always;height:0} .card p{margin:2pt 0} .kpi-v{font-size:13pt;font-weight:700} .card{padding:5pt 7pt} .card-h{font-weight:700;font-size:9pt} p:has(+ table){break-after:avoid;page-break-after:avoid} .lv1{break-after:avoid;page-break-after:avoid} .process-flow code{white-space:nowrap;font-size:7.5pt} .lv1 .hb,.lv2 .hb,.lv3 .hb,.lv4 .hb{display:inline-block;text-indent:0}</style>
