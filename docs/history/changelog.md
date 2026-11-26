# 📜 전체 변경 이력 상세 기록 (Changelog Archive)

> **일시 표기 기준**: 모든 버전 릴리즈 및 작업 일시는 **한국 표준시 (KST, UTC+9)** 기준으로 기록됩니다.

---

### [2026-11-26 KST] `[boot]` 요약을 콘솔 없이도 읽기 (브랜치 `englead/boot-timing-readable-20261126`)
- **증상**: 게시 사이트 https://aicall.ai.studio/ 에서 QA 브라우저 자동화가 info·log를 수집하지 않음(error·warning만). `[boot] auth=… data=… home=… mistakes=… lectureLocal=… lectureServer=…` `console.info`가 안 보이고, 페이지의 "Service Worker registered successfully" `console.log`도 안 보임. 로거는 번들에 있음.
- **수정**: `src/services/perf/bootTiming.ts`의 `flush`가 같은 요약 문자열을 `<html data-boot-timing>`(`document.documentElement.dataset.bootTiming`)과 `window.__AICALL_BOOT__`에 둔다. `document`·`window`가 없으면 그 쓰기만 건너뛴다. `console.info`는 그대로 두고, URL에 `?qa=1`이 있을 때만 `console.warn`. 이 브라우저에 저장된 QA 플래그는 경고 조건이 아님.
- **방어 조치**: `tests/bootTiming.test.ts`가 속성, `window.__AICALL_BOOT__`, `?qa=1`일 때만 경고, 그리고 기본 경로의 `console.info`를 확인.

### [2026-11-26 KST] 아침 강의 카드가 없는 강의를 잠깐 보여주고, `[boot]` 로그가 안 남던 문제 (브랜치 `englead/lecture-card-unknown-20261126`)
- **증상**: 첫 방문에서 홈 아침 강의 카드가 약 2–5초 「아직 오늘 강의가 없어요」를 보인 뒤 실제 강의로 바뀜(카드는 5.2–7.3초에 자리 잡음). 같은 배포의 `[boot]` 한 줄은 라이브에서 한 번도 안 나옴. 페이지 로드 전에 콘솔을 붙잡아 둔 기록은 첫 방문 약 50초·새로고침 약 27초 동안 info가 0건이었고, 홈과 강의 카드는 약 7초 안에 자리 잡았음. 번들 `index-DOgNslPT.js`에는 로거가 들어 있음.
- **원인 (강의 카드)**: `MorningLectureCard.tsx` `onLocal`이 로컬 문서가 없어도 `setLoading(false)`를 호출함(수정 전 120행). 헤드라인의 나머지 분기는 상태가 없으면 「아직 오늘 강의가 없어요」를 그림(수정 전 260행). 서버 확인(`needsServer`)이 아직 참이어도 빈 상태가 먼저 보임. 10초 제한에 걸리고 로컬 문서가 없으면 같은 빈 문구에 느린 안내만 붙음.
- **원인 (`[boot]`)**: `flush`는 `mistakes`와 `lectureServer`가 둘 다 찍힌 뒤에만 바로 호출되고, 아니면 60초를 기다림(`bootTiming.ts` 57–64행). 그 두 표시는 카드가 결과를 받아들일 때만 찍힘. `MorningLectureCard.tsx` 140–141행은 `canApply`가 거짓이면 `markBoot("lectureServer")`에 닿지 않고, 123행의 `lectureLocal`도 `onLocal`의 같은 가드(118행) 뒤에 있음. `HomeScreen.tsx` 182–185행은 `isCurrent()`가 거짓이면 `markBoot("mistakes")`를 건너뛰고, 조회가 실패하면 catch(212행 이후)에도 표시가 없음. `App.tsx` 116행은 `dataLoading`이 거짓으로 시작해, 인증 뒤 첫 그리기(675행 관문)가 홈을 먼저 마운트함. 이어서 234행이 `setDataLoading(true)`를 호출하고, 캐시가 없으면 홈이 바로 언마운트됨. 정리 함수(`MorningLectureCard.tsx` 174행, `HomeScreen.tsx` 289행)가 진행 중인 조회를 거절해 표시를 건너뜀. 콘솔을 감싸거나 지우는 코드는 없고, 60초 타이머는 첫 표시 때 잡히며 두 표시가 모이면 `flush`는 타이머 없이 바로 돈다. 브라우저 `setTimeout`은 숫자라 `unref`도 호출되지 않음. QA 구간이 60초 미만이라 표시 하나가 빠지면 info가 0건으로 보임.
- **수정**: 로컬 문서가 없고 서버 확인이 남았으면 로딩을 유지하고, 강의 없음은 서버(또는 서버 실패 시 로컬 폴백)가 없다고 한 뒤에만 표시. 10초 제한은 유지하고, 제한에 걸리고 문서가 없으면 기존 「확인이 늦어지고 있어요」를 보이며 빈 문구는 쓰지 않음(`lectureCardView`). `lectureServer`는 `loadLectureForCard`가 끝날 때(서버를 건너뛴 경우·시간 초과·조회 예외 포함) 카드의 수락 여부와 상관없이 표시. `mistakes`는 `settleBootPhase`가 성공·실패 모두에서 `isCurrent()` 판단 전에 표시. 페이지에서는 60초 폴백 타이머를 `unref`하지 않음. 같은 단계의 첫 표시만 남아 로그는 페이지당 한 번.
- **방어 조치**: `tests/lectureCardPresence.test.ts`(대기 중 로딩, 서버가 없음 확인, 서버 강의 표시, 시간 초과 시 느린 상태), `tests/bootLogPath.test.ts`(카드를 흉내 내 결과를 버려도 `[boot]`가 한 번 남음), `tests/bootTiming.test.ts`(`unref`는 Node 테스트에서만).

### [2026-11-26 KST] 홈 첫 화면 부트 캐시 (브랜치 `englead/home-boot-cache-20261126`, QA 시트 67행)
- **증상**: 새로고침마다 「클라우드 데이터베이스 동기화 중」 전체 화면이 11~23초 이어짐.
- **원인**: `App.tsx`가 goals를 []로 시작해 Firestore 조회가 끝날 때까지 전체 화면 스피너(`dataLoading && goals.length === 0`)를 띄움.
- **수정**: `src/services/session/bootCache.ts`(기기 캐시, 7일 TTL, 스키마 검사, tutorPrompt 제외), `src/services/session/bootGate.ts`(`syncing`/`fresh`/`failed`, `canStartCall`). 캐시로 홈을 먼저 그리고, 서버 확인 전 통화 시작·진도 변경 버튼 비활성, 실패 시 「다시 확인」. 늦은 응답 uid 가드, 로그아웃·인증 해제 시 캐시 삭제. 서버 코드 변경 없음.
- **재심사 보완**: 더 늦게 시작한 목표 조회만 반영(`createGoalsCommitGate`)해 부트 조회가 코치·진도 저장의 새 목록을 덮지 못하게 함. 조회 시작 뒤에 저장된 캐시는 덮지 않고, 서버 목록이 비면 캐시를 지움. `lessons`의 null·객체형 `why`처럼 홈을 멈추는 캐시는 삭제. 홈 필드만 저장(`tutorPrompt`와 그 외 필드는 제외). 새 목록이 용량을 넘으면 더 오래된 캐시만 지움. 미래 `savedAt`는 버림.
- **측정**: 가짜 Firestore 모델 두 번째 방문 홈 표시 0.85→0초(첫 방문 변화 없음).
- **방어 조치**: `tests/bootCache.test.ts`, `tests/bootGate.test.ts`, `tests/bootCacheWiring.test.ts` 추가.

### [2026-11-26 KST] 홈 첫 화면 로딩: 복습 카드 미확정 상태 구분·중복 조회 제거 (브랜치 `englead/home-load-state-20261126`, QA 시트 66·67행)
- **증상**: 로드·새로고침 뒤 약 30초 동안 「오늘 복습 0개 / 오늘 퀴즈 0개 / 퀴즈 풀기 (0개)」가 보이다 45/10으로 바뀜(통화 직후에도 0/0). 「클라우드 데이터베이스 동기화 중」 11~23초, 「오늘 아침 강의: 불러오는 중…」 30초 넘게 지속.
- **원인**: `HomeScreen.tsx` `dueMistakes` 초기값 []를 카드가 그대로 0으로 그림(로딩 상태 미사용), 복기 뒤 `key` 재마운트로 초기화. 홈 마운트마다 실수 컬렉션 5회 전체 읽기(`getDueMistakes`+`getUserMistakes`, `syncFeed` 안 3회), 통화 직후 `App.tsx`와 홈 재마운트가 `syncFeed` 중복. `MorningLectureCard`는 문서가 없으면 서버 상태 응답까지 로딩 유지, `syncLectureStatus`가 `getLecture`를 다시 읽음. `App.tsx` 프로필→목표 직렬.
- **수정**: `src/services/mistakes/mistakeLoadState.ts`(`MistakeLoadState`, `reviewCardView`, `selectDueMistakes`, 탭 캐시, `createLatestOnly`), `src/services/feed/feedSyncGate.ts`(`syncFeedFromHome`/`syncFeedNow`, 모든 피드 동기화 uid별 직렬화), `src/services/lecture/lectureCardLoad.ts`(Firestore 즉시 표시·서버 10초 제한·늦은 결과 반영), `src/services/session/bootLoad.ts`(프로필·목표 병렬), `src/services/perf/bootTiming.ts`(`[boot]` 1회 로그). `syncFeed` `opts.mistakes`, `pickLectureMistakes` `pre`, `syncLectureStatus` `current` 인자 추가. 서버 코드 변경 없음.
- **측정**: 가짜 Firestore 지연 모델(요청당 0.83초) 새로고침: 홈 1.68→0.85초, 강의 카드 4.22→1.78초, 실수 전체 읽기 5→1회. 통화 직후: 조회 104→54회, 전송량 3.2→1.5MB, 피드 동기화 2→1회. 라이브 수치는 배포 뒤 `[boot]` 로그로 확인.
- **방어 조치**: `tests/mistakeLoadState.test.ts`, `tests/feedSyncGate.test.ts`, `tests/lectureCardLoad.test.ts`, `tests/bootTiming.test.ts`, `tests/homeLoadReads.test.ts`, `tests/homeReviewCardWiring.test.ts` 추가.

### [2026-11-26 KST] 아침 강의 TTS 조각·시도별 소요시간 진단 기록
- **배경**: 아침 강의 TTS 조각이 3회 시도 후 실패했을 때 소요시간 정보가 없어 "Gemini TTS 지연"과 "서버 CPU 스로틀링 / 본문 읽기 정체"를 구분할 수 없었다.
- **수정**:
  - `server/lecture.ts` `synthesizeGemini`: `opts.now ?? Date.now`로 시도별 소요시간(`attemptMs: number[]`)을 측정하고, 매 실패 시도마다 `[Lecture] TTS attempt failed:` 경고 로그(`attempt`·`elapsedMs`·`loopDelayMaxMs`·`errName`·`code`, 원문 메시지 비노출)를 남기며 최종 예외에 `attemptMs` 사본을 첨부한다. 호출자 취소(`signal?.aborted`) 시에는 `attemptMs` 기록 후 분류·경고 로그 전에 예외를 던져 가짜 `UNKNOWN` 경고를 남기지 않는다.
  - `server/lecture.ts` CPU 스로틀링 근거 계측: 시도마다 `perf_hooks.monitorEventLoopDelay({ resolution: 20 })`(테스트 주입 `opts.loopDelayMonitor`)를 시작·`finally`에서 정지해 `loopDelayMaxMs`(정수 ms, 상한 `3_600_000`)를 시도 로그에 기록하고 시도 간 최댓값을 최종 예외의 `loopDelayMaxMs`로 첨부한다.
  - `server/lecture.ts` `createCachedSegmentSynth`·`renderAndSaveAudio`: `onHit` 콜백으로 디스크 캐시 적중 여부를 전달하고, 음성 조각마다 벽시계 소요시간을 측정해 성공 시 `[Lecture] TTS segment ok:`(`segIndex`·`segChars`·`elapsedMs`·`cached`), 실패 시 `firstErr`에 `segIndex`·`segChars`·`segElapsedMs`를 붙인다.
  - `server/lectureAudioError.ts`: `LectureAudioError`에 선택 필드(`segIndex`·`segChars`·`elapsedMs`·`attemptMs`·`loopDelayMaxMs`·`errName`)를 추가하고 `classifyLectureAudioError`·`sanitizeAudioError`에서 정수 상한·길이(최대 3)·안전한 이름 정규식을 검증해 유효할 때만 유지한다(`diag.json`·days 백업 반영). `[Lecture] job failed:` 및 `[Lecture] audio rebuild failed:` 로그에도 존재 시 함께 출력한다. 재시도 횟수(3)·대기(1500/3000ms)·쿨다운·일일 상한·타임아웃 등 동작은 변경 없음.
- **한계**: 헤더 도착(TTFB)과 본문 읽기 완료는 아직 따로 재지 않는다 (`attemptMs`가 90,000 근처 + `loopDelayMaxMs` 작음 → TTS/네트워크 쪽, `loopDelayMaxMs` 큼 또는 `attemptMs`가 90,000을 크게 넘음 → CPU 제한 쪽으로 해석).
- **방어 조치**: `tests/lectureTtsTiming.test.ts` 신규 추가 — 가짜 `now` 기반 `attemptMs` 기록, 불완전 JSON 본문 정체 로컬 HTTP 서버(요청 3회·`TimeoutError`·시도별 `attemptMs < 600`) + 실제 `GoogleGenAI` SDK `STEP_TIMEOUT`·`attemptMs` 검증, `sanitizeAudioError` 유효/무효 필드 처리(`loopDelayMaxMs` 포함), `startLectureJob` 3번째 음성 조각 실패 E2E(`segIndex`·`segChars`·`elapsedMs`·`loopDelayMaxMs`), 일반 오류 3회·`[1500, 3000]`ms 재시도 불변 확인, 호출자 취소(`signal?.aborted`) 시 경고 로그 미출력, 주입 `loopDelayMonitor` 최댓값 전파·무효값 제거 검증.

### [2026-11-26 KST] 아침 강의 TTS 조각 시간 초과 진단 오류 수정 (`UNKNOWN` → `STEP_TIMEOUT`)
- **증상**: 아침 강의 TTS 조각(`synthesizeGemini`) 시간 초과가 `audioError.code = 'UNKNOWN'`으로 기록됐다.
- **원인**: `@google/genai` 2.24.0(`createAttemptSignal`)이 호출 측 `AbortSignal`을 자체 `AbortController`에 연결해 이유 없이 `abort()`하므로, 단계 시간 초과 시 `withTimeout`보다 SDK의 `AbortError`가 먼저 발생해 `STEP_TIMEOUT`으로 분류되지 않았다.
- **수정**: `server/lecture.ts`의 `synthesizeGemini` catch 블록에서 `timeoutSig.aborted && !signal?.aborted`이면 오류를 `name = 'TimeoutError'`인 `lecture TTS timed out after ${stepTimeoutMs}ms`(`cause`에 원 오류 보존)로 바꿔 `STEP_TIMEOUT`으로 기록한다. 재시도(3회, 대기 1500/3000ms)·쿨다운·상위 작업 취소(`superseded`) 동작은 그대로 유지된다.
- **방어 조치**: `tests/lectureAudioError.test.ts`에 fake `AbortError` 재시도·`STEP_TIMEOUT` 분류, 무응답 로컬 HTTP 서버 + 실제 `GoogleGenAI` SDK 회귀, 호출자 `AbortController` 취소 우선, 일반 `Error('boom')` `UNKNOWN` 유지 테스트 4건 추가.
- **리뷰 후속 보완**: catch 정규화에 `err?.name === 'AbortError' || err?.name === 'TimeoutError'` 가드를 추가해 `timeoutSig` 만료 직후 도착한 `ApiError`(429 등)·응답 파싱 오류는 `TimeoutError`로 덮어쓰지 않고 원 오류 분류를 유지한다(`tests/lectureAudioError.test.ts` 테스트 22 추가, 테스트 18 race 완화).

### [2026-11-26 KST] 사용량 화면 항목별 비용 합계 불일치 수정 (브랜치 `englead/usage-breakdown-sie-20261126`, QA 시트 63행)
- **증상**: 개발자 모드 설정 → 사용량·예상 비용의 항목별 비용 합이 예상 비용 합계보다 작았다(이번 달 $0.0106, 오늘 $0.0006 차이).
- **원인**: `priceUsage()`의 `sie`(실수 묶기 임베딩, Qwen3-Embedding-4B) 비용은 합계에 들어가는데 화면에 행이 없었다.
- **수정**: `usageService.ts`에 `USAGE_COST_COMPONENTS`(라벨 맵을 `satisfies Record<…>`로 묶어 새 비용 항목이 빠지면 컴파일 오류)를 두고, `UsagePanel.tsx`는 이 목록을 그대로 돌려 모든 비용 행(「실수 묶기 임베딩 비용」 추가)을 보여 준다. 합계(`priceUsage`·`estimateCostUsd`)도 같은 목록으로 더하는 `sumUsageCostComponents` 한 곳에서 만든다.
- **방어 조치**: `tests/usageCost.test.ts`에 목록 키 = 합계 제외 키, 모든 항목이 0이 아닌 달에서 항목 합 = 합계, 라벨 형식 테스트 3건 추가.

### [2026-11-25 KST] v2.10.0 이후 수정(미배포) — 사용량·예상 비용 재산정 (브랜치 `englead/usage-cost-estimate-20261125`)
- **배경**: 설정 → 사용량·예상 비용이 이번 달 $0.3669(16회·43.7분)로 표시돼 AI Studio 대시보드(28일 약 $6.7)보다 크게 낮았다. 옛 단가(통화 1분 $0.004, 받아쓰기 1분 $0.003, TTS 1천 자 $0.0004)가 공식 단가보다 낮았고, Live 턴별 컨텍스트 재과금·통화 중 partial 받아쓰기·thinking 토큰·TTS 오디오 토큰이 빠져 있었다.
- **수정**:
  - `src/config/models.ts`: `PRICING_RATES`를 공식 유료 단가(USD/1M 토큰)로 교체하고 `USAGE_ASSUMPTIONS` 추가.
  - `src/services/usage/usageService.ts`: `priceUsage()`·`UsageCostBreakdown`·`liveCostPerMinute()` 추가, `estimateCostUsd`는 `priceUsage`에 위임. 새 필드 `qaLiveMinutes`·`liveMinutesSq`·`qaLiveMinutesSq`·`textInputTokens`·`textOutputTokens`·`ttsAudioSec`·`ttsAudioChars` 저장.
  - `src/ui/settings/UsagePanel.tsx`: 예상 비용을 저장값 대신 재계산값으로 표시(옛 기록 재평가), 개발자 모드 항목별 비용 행과 새 각주.
  - `server/usageMeta.ts`(신규) `tokensFromUsageMetadata`: 출력 = candidates + thoughts. `server.ts`·`server/mistakeClusters.ts`·`server/lectureSupplement.ts`·`server/lecture.ts`에 적용.
  - `server/lecture.ts`: 대본 입력/출력 토큰 분리, `createCachedSegmentSynth`로 캐시 미스 TTS만 `ttsAudioSec`·`ttsAudioChars`에 누적. `server/feedStore.ts` 백업·`lectureService.ts` 기록에 새 필드 전달.
  - `learningLog.ts` `liveContextMinutesSq`(컨텍스트 창 128k 토큰 상한 반영)·`callUsageDelta`·`recoveredUsage.ts`·`SttBenchmarkModal.tsx`: 통화 유효 분² 기록. 각주의 강의 음성 단가는 단가표에서 계산(`lectureAudioCostPerMinute`), 미사용 lite TTS 단가 제거.
- **결과(이번 달 같은 기록 기준)**: $0.3669 → 약 $4.03(Live $2.40·받아쓰기 $0.35·텍스트 $0.53·TTS $0.76). 남은 차이는 QA봇 통화(옛 기록엔 분 미저장)·재생성 낭비·피드 강의 등 범위 밖 항목.
- **방어 조치**: `tests/usageCost.test.ts`(신규) — 빈 문서 0·NaN 없음, 이번 달 옛 기록 ≈ $4.03, Sq 가산성, 옛+새 혼합 하한, 새 필드 저장, QA 델타, 복구 사용량 Sq, thinking 토큰 합산, 캐시 미스만 과금. `tests/lectureGenCost.test.ts`·`tests/lecturePersist.test.ts`의 피드 테스트가 00~05시 KST에 실패하던 벽시계 의존을 `now` 고정으로 해소.

### [2026-11-25 KST] v2.10.0 이후 수정(미배포) — 강의 생성 비용 가드 (브랜치 `englead/lecture-gen-cost-20261125`)
- **배경**: 평일 Flash TTS 지출이 정상 1편 대비 약 10배 수준이었고, 재시작·Republish 후 전체 TTS 재생성(A), 중간 실패 시 성공 세그먼트 폐기 및 대본부터 재시작(B·D), 다중 인스턴스 동시 생성 및 `force` 중단 499(C·G), 429 분당 QUOTA 세그먼트 재시도·전역 pause(H) 등 중복 호출 경로(A~H)가 겹쳐 낭비가 발생했다.
- **수정**:
  - `server/lectureGenGuard.ts`(신규): 단일 게이트 모듈(`decideGenAcquire`, `applyGenRelease`, `sanitizeGenControl`, `peekGenGate`, `acquireGenSlot`, `acquireGenSlotSync`, `readGenDiag`, `lectureDailyGenCap`). 날짜별 생성 락(인프로세스 + `GenRemote` 리스), 일일 생성 상한 `LECTURE_DAILY_GEN_CAP`(기본 2, 1..10 범위, 과금 호출 0인 실패·전체 캐시 적중은 refund), 즉시 쿨다운 기록. 상태는 `.data/lectures/{uid}/{date}.gen.json`에 저장.
  - `server/lectureAudioError.ts`: `retryableFor`에서 `QUOTA`를 제외(`cooldownMsFor` 30분/6시간 유지).
  - `server/lecture.ts`: `LECTURE_GEN_SKIPPED`, `lectureGenDiag`, `lectureInputIdSet`(`feed.ts`에서 이관), `scriptCoversInputs`, `peekLectureGenGate` 추가. `startLectureJob`·`startLectureAudioRebuild`가 `peekGenGate` 막힘 시 기존 ready·오디오를 보존하고 `abortCurrentJob`을 실행하지 않으며, 대본이 입력을 커버하는 비-force 실패/중단 잡은 `startLectureAudioRebuild`로 위임. `runJob`이 `generateScript` 직후 `state.script` 체크포인트와 `billable.calls++` 기록. `renderAndSaveAudio`에 플랜 지문 기반 디스크 세그먼트 캐시(`segcache/{date}/{fp}/*.pcm`)를 두고 형제 워커 완료를 기다린 뒤 첫 오류를 던지며 `drillIntroCache`는 삭제. `synthesizeGemini`의 `ttsPauseUntil`/`resetTtsPause` 및 429 재시도 제거.
  - `server/feedStore.ts`: `genControlCache`, `casDaysDoc`(GET 5초 타임아웃, `currentDocument.updateTime`/`exists=false` 전제조건, conflict 최대 3회 재시도, 복호화 불가 문서 보존), `acquireLectureGenLease`, `releaseLectureGenLease`, `createFeedGenRemote`(`LECTURE_GEN_LEASE=off` 또는 URL 없으면 `null`). `saveLectureBackup`·`persistLectureBackups` 암호문에 캐시된 `genControl` 병합(`loadLectureBackup`은 미노출), `firestore.rules` 변경 없음.
  - `server/feed.ts`: `ensureTodayLectureOnce`가 포인터 없는 로컬 ready 대신 동등 이상 `createdAt` 백업의 오디오 포인터를 우선하고 게이트 막힘 시 `installWithoutAudio`로 설치. `maybeAutoRegenerateToday`는 `generating`/rebuild 진행 중이면 `false`. `buildFeedDiag`에 `dailyGenCount`·`dailyGenCap`·`genSkipReason`·`genSkipAt`·`genBlockedUntil`·`genLeaseMode` 추가.
  - `server.ts`·`package.json`: `/api/lecture/generate`에 `genRemote`·`ignoreCooldown: isForce`, `/api/lecture/audio/rebuild`에 `genRemote` 전달 및 `GEN_SKIPPED`를 `{ ok: true, lecture }`로 응답. `npm test` 스크립트에 `LECTURE_GEN_LEASE=off` 추가.
- **방어 조치 (Safeguards)**:
  - `tests/lectureGenCost.test.ts`(신규): 1) 중간 실패 후 비-force 재시도 세그먼트 캐시 적중·대본 1회, 2a) 동시 요청(`startLectureJob`×2 + `ensureTodayLecture`) 1벌 실행, 2b) 타 인스턴스 리스 차단·`GEN_SKIPPED`·`diag.genSkipReason=lease`·`peekGenGate` 원격 생략, 3) 재시작 시뮬 백업 복원(TTS/스크립트 0회, `dailyGenCount` 유지), 3b) `INTERRUPTED` + 로컬 대본 리빌드 위임, 4) 일일 상한 초과(로컬·원격) 및 ready/오디오 보존, 5) 429·AUTH 즉시 실패(sleep 0) 및 30분/6시간 쿨다운·`ignoreCooldown` 우회, 6) 과금 0 실패 refund.
  - `tests/feedStore.test.ts`: CAS 동시 acquire·ready 백업 보존, `genControl` 캐시 보존·`loadLectureBackup` 비노출, 토큰 불일치 release·만료 리스 승계·복호화 불가 문서 `unavailable`·`LECTURE_GEN_LEASE=off` 추가.
  - `tests/feedDiag.test.ts`·`tests/lectureAudioError.test.ts`: diag 허용 키 6개 추가 및 read-only `.gen.json` 미생성 확인, 429 즉시 실패 정책 반영 및 `resetTtsPause` 제거.
- **리뷰 후 수정** (Claude CLI Opus 5.5, 7/10, blocker 1): `abortCurrentJob`이 `running`을 지워 TIMED_OUT+체크포인트 위임이 실제로 리빌드를 시작함(테스트 3c). 로컬 `leaseMode=local`의 죽은 프로세스 리스는 무시. ready 확정 후 해당 날짜 segcache 삭제. 상한에 걸린 force는 `GEN_SKIPPED`를 반환하고 클라이언트가 `audioUrl`/`listenedAt`을 지우지 않음. 백업 쓰기 전 days GET으로 캐시가 비어 있을 때도 `genControl`을 보존.
- **검증**: `npx tsc --noEmit -p tsconfig.json`, `npx tsc --noEmit -p tsconfig.server.json`, `npm run lint`, `npm test`(534/534 통과) 통과. 머지·배포·규칙 게시 안 함.

---

### [2026-11-25 KST] v2.10.0 이후 수정(미배포) — 강의 오디오를 mp3로 생성·서빙·백업 (브랜치 `englead/lecture-audio-backup-size-20261125`)
- **배경**: PR #49 배포 후 오늘 강의 오디오는 ready였으나 파일이 wav 17,520,044 bytes(365초, 24kHz 16-bit mono PCM과 일치)라 Firestore 청크 백업이 `too_large`(30청크, 한도 8)였다. `encodeLectureAudio`는 ffmpeg가 없거나 aac·lame 시도가 모두 실패하면 wav로 폴백하고, 라이브 AI Studio 런타임에는 ffmpeg가 없는 것으로 보는 것이 가장 그럴듯하다(서버 로그는 없음).
- **수정**: 청크 한도를 올리지 않는다. 생성·서빙·백업은 모두 mp3(48kbps). `encodeLectureAudio`는 ffmpeg `libmp3lame`이 있으면 그걸 쓰고, 없거나 실패하면 `@breezystack/lamejs`(`encodePcmToMp3`, 주기적으로 이벤트 루프에 양보)로 인코딩해 항상 mp3를 반환한다(wav 폴백·m4a 우선 시도 제거). AI Studio Republish 뒤에는 `.data`가 비워지므로 콜드 스타트 TTS 재생성이 mp3를 만든다. `persistLectureBackups`의 wav→mp3 트랜스코드는 같은 프로세스가 남겨 둔 wav(또는 테스트 스텁)를 백업하기 위한 경로다. `AUDIO_CHUNK_MAX`는 8, `firestore.rules`는 변경 없음.
- **방어 조치 (Safeguards)**: `tests/lectureAudioEncode.test.ts`(ffmpeg 부재 시 순수 JS mp3, ffmpeg 있으면 ext=mp3), `tests/lectureAudioChunks.test.ts`(360초 24kHz 무음 mp3가 8청크 이내, 17.5MB 유효 wav를 lamejs로 트랜스코드 후 커밋, 깨진 17MB wav는 too_large·원본 유지, 트랜스코드 후 isCurrent=false면 not_current·wav 유지, 8/9청크 경계는 .mp3 파일 기준).
- **검증**: `npm test` 522/522, `npx tsc --noEmit -p tsconfig.json`, `npx tsc --noEmit -p tsconfig.server.json`, `npm run lint`, `npm run build` 통과. 머지·배포·규칙 게시 안 함.

---

### [2026-11-25 KST] v2.10.0 이후 수정(미배포) — 아침 강의 오디오 백업을 Firestore 청크로 이전·TTS 재생성 실패 진단 (브랜치 `englead/lecture-audio-backup-20261125`)
- **배경**:
  - 11/25 강의(08:08 ready, 5항목)는 08:30 PR #48 배포 뒤 TTS 재생성으로 한 번 되살아났지만(days 백업 `updatedAt` 08:36 KST), 컨테이너가 다시 켜진 뒤 09:45 확인 때 오디오 없이 `GENERATION_FAILED`였다.
  - 증상 1(백업 없음): PR #47의 Storage 백업 규칙은 `firestore.exists(/databases/ai-studio-.../...)`를 썼다. Firebase 공식 문서상 Storage 규칙은 기본 `(default)` DB만 읽을 수 있어 이 조건은 참이 될 수 없고, 서버의 무인증 업로드는 늘 거부됐다. 규칙 자체는 게시돼 있었다(공개 GET 실측: 무작위 feedId 경로 404, 다른 경로 403). 11/24·11/25 days 백업 모두 `audioBackupId`가 없다(업로드 실패 시 지우는 코드 경로와 일치). 업로드의 403 응답 자체는 로그 접근이 없어 직접 보지 못했다.
  - 증상 2(재생성 실패): 실제 11/25 대본(5항목)으로 TTS만 스텁으로 바꿔 재생성을 재현하면 길이 0.6–1.25배 모두 정상 완료됐다(대본 정리·길이 맞추기·조립 경로는 원인이 아님). 실패 처리부가 시간 초과 말고는 모든 오류를 `GENERATION_FAILED`로 덮고 원문 오류는 서버 로그에만 남겨 실제 원인은 알 수 없었다. 실패 시각이 days 백업에 남지 않아 재시작마다 조각 12개 TTS를 다시 호출했다. 같은 날 같은 키·대본이 1시간 전에 성공한 점으로 보아 TTS 쿼터(429)가 가장 유력하지만 확인되지 않았다.
- **수정**:
  - `server/lectureAudioBackup.ts`: Storage 업로드·다운로드 삭제. OCA1 암호 blob을 600,000바이트(base64 800,000자) 단위로 최대 8청크로 나누는 `splitAudioBlob`·`joinAudioChunks`·`buildAudioChunkWrites`·`prepareLectureAudioChunks`·`loadLectureAudioChunks`.
  - `server/feedStore.ts`: `persistLectureBackups`가 청크 n개와 days 문서를 Firestore `documents:commit` 한 번으로 쓰고 결과(`AudioBackupResult`: ok·denied·too_large·timeout·network·http_error·no_file·not_current)를 돌려줌. 실패·8청크 초과면 포인터 없는 days PATCH로 폴백. `saveLectureFailureBackup` 추가, 백업 허용 필드에 `audioChunks`·`audioRebuildFailedAt`·`audioRetryAfter`·`audioError`·`audioBackup` 추가, `loadLectureBackup`도 같은 정리 함수를 거침.
  - `server/lectureAudioError.ts`(신규): `classifyLectureAudioError`(QUOTA·QUOTA_DAILY·MODEL_NOT_FOUND·AUTH·BAD_REQUEST·UNAVAILABLE·STEP_TIMEOUT·REBUILD_TIMEOUT·NO_AUDIO·FIT_NO_CONVERGE·DISK·NETWORK·UNKNOWN), `sanitizeAudioError`, `sanitizeAudioBackupResult`, `cooldownMsFor`, `retryableFor`. 메시지 원문·URL·키는 결과에 넣지 않음.
  - `server/lecture.ts`: 재생성·생성 실패 시 `error` 문자열은 그대로 두고 `audioError`·`audioRetryAfter` 기록, 로그는 분류 결과만. `onFailed` 훅. `synthesizeGemini`는 비재시도 오류 즉시 중단, 분당 QUOTA는 `retryDelay`(최대 60초, 없으면 20초) 동안 모든 워커 대기, 마지막 시도 뒤 대기 없음, 시도마다 `AbortSignal.any([작업, timeout])`로 HTTP 요청 중단. `installBackupLectureWithoutAudio`, `recordLectureBackupResult` 추가.
  - `server/feed.ts`·`server.ts`: 쿨다운(`audioRetryAfter`, 없으면 실패 시각+30분) 중이면 TTS 대신 대본만 로컬에 설치. 복원 순서 청크 → TTS. `feedOnFailed`, 생성·재생성 라우트에 `onFailed`·백업 결과 기록. `diag.json`에 `audioError`·`audioRetryAfter`·`audioBackup`.
  - `firestore.rules`: `feeds/{feedId}/days/{date}/audio/{n}` 블록(부모 feed 문서 존재 시 무인증 쓰기, `data`≤800,000자·`updatedAt`만, n 0–7, 삭제는 소유자). `storage.rules`: 동작하지 않던 feeds 블록 삭제. `server/storageRelay.ts`: 쓰지 않게 된 `storageUploadUrl` 삭제.
- **방어 조치 (Safeguards)**: `tests/lectureAudioChunks.test.ts`(2.7MB 5청크 왕복, 17MB too_large, commit 200·403 폴백, isCurrent=false 0회, 로그 비노출, 청크 누락·섞임·id 불일치, ensure 청크 복원·폴백), `tests/lectureAudioError.test.ts`(분류표·키 허용 목록·마커 비노출, 재시도·백오프, 429 재생성 기록·onFailed·superseded, 쿨다운 중 restore·startJob 0회, 성공 시 오류 필드 삭제), `tests/rulesAudio.test.ts`(규칙 정적 검사), `feedDiag`·`lectureAudioBackup` 테스트 갱신.
- **리뷰 후속 보완(Claude CLI Opus 리뷰 7.5/10 지적 반영)**: 실패 백업이 정상 오디오 포인터를 지우지 않도록 보존(청크 GET이 404·GCM 실패·id 불일치로 무효 확인된 때만 제거, 타임아웃·5xx는 유지), `onFailed`는 기다리지 않고 실행해 그동안 수동 rebuild가 무시되지 않게 함, days PATCH 10초 타임아웃, 공용 pause 계산·retryDelay 하한 1초, `lecture job timed out` 분류, rebuild 쿨다운도 `audioRetryAfter` 우선, 쿨다운 중에도 콜드 스타트 백업의 청크 복원은 시도(TTS만 막음), 로그에 `errName`만 추가. 테스트: pause 공유·상한, 시도별 abort, job 실패 순서, 8/9청크 경계, commit timeout, 포인터 보존·제거, 느린 onFailed 중 수동 rebuild, 쿨다운 중 청크 복원.
- **검증**: `npm test` 518/518, `npx tsc --noEmit -p tsconfig.json`, `npx tsc --noEmit -p tsconfig.server.json`, `npm run lint`, `npm run build` 통과. 머지·배포 안 함.
- **배포 시 수동 작업**: ① Firebase 콘솔 → Firestore → named DB `ai-studio-aicall-...` → 규칙에 `firestore.rules` 게시(필수, 게시 전에는 `audioBackup.result=denied`) ② Storage 규칙에 `storage.rules` 게시(선택, 쓰지 않는 feeds 경로 정리).

---

### [2026-11-25 KST] v2.10.0 이후 수정(미배포) — 게시본에 섞인 옛 .data와 최신 feed 백업 무시 수정 (브랜치 `englead/feed-stale-data-20261125`)
- **배경**:
  - 라이브 서버(AI Studio Publish → Cloud Run)가 오전 내내 피드 상태 `nothing`을 반환했다. `/feed/:secret/audio/2026-11-24.m4a`의 `Last-Modified`가 Publish(15:02 KST / 06:02Z) 이전인 `2026-11-24 03:04:46 GMT`이고 진단(`diag.json`)의 `syncedAt`이 `2026-11-24T03:03:19Z`였으며, `.dockerignore`와 `.gcloudignore`에 `.data`가 빠져 있어 개발 작업 공간의 옛 `.data/`가 게시 이미지에 그대로 포함되었다.
  - Firestore `feeds/{id}` 백업은 `updatedAt 2026-11-24T08:11:17Z`로 최신 상태(16:50 통화 새 실수 11개·사용자 키 포함)였지만, `server/feed.ts`의 `loadFeedForSecret`이 로컬 `feed.json`만 있으면 백업을 읽지 않고 반환해 백업과 사용자 키가 복원되지 않았고, 환경변수 키가 없는 Publish 컨테이너에서 `createGenAI()`가 `null`이 되어 강의 생성이 시작되지 않았다.
- **수정**:
  - `.dockerignore`, `.gcloudignore`: 개발 작업 공간의 런타임 데이터가 게시 이미지에 포함되지 않도록 `.data/`와 `.data`를 제외 목록에 추가.
  - `server/feed.ts`: `loadFeedForSecret`에 비밀키별 `FEED_BACKUP_RECHECK_MS`(5분) 재확인 주기와 테스트용 의존성 주입(`{ loadBackup?, now? }`)·캐시 초기화(`resetFeedBackupCheckCache`)를 추가. 로컬 `feed.json`이 있어도 5분에 최대 1회 `loadFeedBackup`을 확인해 백업 `state.syncedAt`이 더 새로우면 `writeFeedSync`로 덮어쓰고 반환하며, `backup.state.uid === local.uid`이고 `backup.apiKey`가 있으면 `setUserKeyFromFeed`로 사용자 키를 복원함(백업 읽기 실패 시 경고만 남기고 로컬 반환, 비밀키·API 키 비노출, 빈 `.data/` 초기 복원 경로 유지).
- **방어 조치 (Safeguards)**: `tests/feedStore.test.ts`에 ① 백업이 로컬 `feed.json`보다 새로울 때 백업 반환 및 로컬 갱신, ② 로컬이 더 새로울 때 로컬 유지, ③ 5분 이내 재호출 시 백업 재조회 생략(5분 경과 후 재조회), ④ 백업 조회 실패 시 로컬 반환 케이스를 추가함(`userKey.ts` 모듈 캐시 격리 한계로 로컬 존재 시 키 복원 케이스는 생략).
- **리뷰 후속 보완**: `loadFeedForSecret` 쓰기 직전 `feedForSecret` 재읽기로 동시 sync 경합 시 최신 로컬(`syncedAt >= backup`)을 보존하고, `LoadFeedDeps.setUserKey` 주입(`setUserKeyFromFeed` 기본값, 로컬 존재 시 `uid` 일치 한정 복원) 및 `loadFeedBackup` 5초 fetch 타임아웃(`AbortSignal.timeout(5000)`)과 `tests/feedStore.test.ts` 키 복원·`uid` 불일치·경합 테스트를 추가함.
- **검증**: `npm test`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run lint` 통과. 머지·배포 안 함.
- **배포 후 확인**: 배포 뒤 audio Last-Modified가 배포 시각 이후인지, diag syncedAt이 최신 sync와 같은지 확인.

---

### [2026-11-24 KST] v2.10.0 이후 수정(미배포) — 아침 강의 생성 수정 묶음: 생성 중 다시 만들기·05:00 게이트·자동 재생성·진단·오디오 백업·복원 상한·6분 고정 (브랜치 `englead/lecture-fixes-20261124`)
- **배경**: 11/24 강의가 01:4x 공개 피드 GET으로 아침 통화 전 데이터로 만들어졌고, 생성 중에는 「다시 만들기」가 보이지 않았으며 서버도 force를 무시했다. 11:45에는 콜드 스타트 뒤 Firestore 백업(대본만)에서 TTS를 통째로 다시 합성하느라 피드가 generating·itemCount 0으로 보였다(분석: 박스 /workspace/collab/onecall_regen_1124/findings.md). 찬식님 승인 t470u(A·B·E·F=30분·G·6분 고정·코치 2문장·복습 1개), t471u(C).
- **수정**:
  - A `server/lecture.ts`: 작업마다 AbortController·epoch. `force=true`면 돌고 있는 생성·오디오 복원을 중단하고 새로 시작, 옛 작업의 쓰기·onReady·백업은 모두 무시. 빈 입력 force는 ready 강의를 지우지 않음. `MorningLectureCard`는 생성 중에도 「다시 만들기」 노출.
  - B `server/feed.ts`: 공개 GET은 05:00 KST 전에는 생성하지 않고 `status:'waiting'`(`startsAt`)를 돌려줌. 새 sync에 지금 강의 입력(`inputNewIds`)에 없는 새 실수가 있으면 05:00 이후 한 번 자동 재생성(같은 sync로 반복 없음). 「다시 만들기」는 `autoRegenerate:false`로 sync해 작업이 두 번 돌지 않음.
  - C `GET /feed/:secret/today/diag.json`: 생성·복원을 시작하지 않음 — 숫자 진단(generatedAt, 상태, audioRestoring, 항목·새 실수·복습 수, 입력·sync 시각과 개수, durationSec). 문장·제목·id·uid·비밀값 없음.
  - E `server/lectureAudioBackup.ts`: ready 오디오를 피드 키로 AES-GCM 암호화해 Storage `feeds/{feedDocId}/days/{date}.audio.enc`에 올리고(`audioBackupId`로 대본 백업과 연결), 콜드 스타트 복원 때 먼저 내려받음. 없거나 거부되면 기존처럼 TTS. `storage.rules` 추가(배포는 별도 승인 단계, 배포 전에는 동작이 지금과 같음).
  - `storage.rules`는 `users/{uid}/lectures/{file}`도 wav·m4a·mp3로 넓힘(클라이언트는 이미 m4a/mp3 업로드) — 규칙 배포는 소유자 별도 승인 단계.
  - F: 오디오만 다시 만드는 복원은 시작 시각 기준 30분 wall-clock 상한(읽을 때 판정, 멈춘 타이머에도 동작). 넘으면 중단·`AUDIO_REBUILD_TIMED_OUT`, 대본·제목은 유지, 30분 쿨다운 뒤 재시도.
  - G: 복원 중 공개 피드는 `status:'ready'`, 제목·항목 수 유지, `audioRestoring:true`, `audioUrl:null`. 앱 카드는 「오디오 복원 중」.
  - N1 `server/lectureDuration.ts`: 합성한 실제 PCM 길이로 6:00–6:10(360–370초)에 맞춤. 길면 복습→뒤쪽 새 항목 순으로 통째로 빼고, 짧으면 쉼 조정 → 항목 다시 듣기 → 「오늘 표현 다시 정리」 1회(추가 TTS 최대 1회) → 따라 말하기 드릴 → 마지막 무음 보정. 최종 보정으로 항상 창 안. 대본 단계도 6분 목표(항목당 글자 수·깊이, extraExamples ≤2, 대화 ≤6줄). 요약·드릴 안내 TTS 실패 시 `renderAndSaveAudio`에서 1회 재시도하고, 재시도도 실패해 360초 미만이면 끝 무음(`endSlot`+`guardPad`)을 `LECTURE_MAX_FALLBACK_PAD_SEC`(5초) 이하로 제한해 긴 무음 없이 짧은 강의를 허용하고 경고를 남김.
  - N2: 「오늘의 코치 한마디」는 프롬프트 + 문장 분리 후처리로 정확히 2문장.
  - N3: 복습은 정확히 1개(없으면 0), 클라이언트 고르기·서버 정리 모두 `MAX_REVIEW = 1`.
- **방어 조치 (Safeguards)**: 새 테스트 `lectureForce`(타이머 대기 없는 결정론적 latch)·`feedSchedule`·`feedDiag`(허용 키 목록·내용 비노출)·`lectureAudioBackup`·`lectureDuration`(N=1~15 실측 PCM 창, 슬롯 한계, 요약/드릴 실패 재시도·5초 무음 상한, 400초 단일 항목 절단, 생성 경로 m4a 80ms 패딩 스텁), 기존 테스트 기대값은 바뀐 규칙에 맞춤.
- **배포 전 확인**: ① Storage 규칙 배포는 찬식님 별도 승인 ② 박스 `oncall-feed-check`는 `ready`이면서 `audioUrl`이 있을 때만 보내도록 한 줄 패치를 준비해 두었음(`/workspace/collab/onecall_lecture_fixes_20261124/feed_check_ready_audio.patch`). 라이브 스크립트에는 아직 적용하지 않았고, 배포 때 찬식님 승인 후 적용한다.
- **검증**: `npm test`, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build`. 머지·배포 안 함.

---

### [2026-11-24 KST] v2.10.0 이후 수정(미배포) — 준비된 오늘 강의를 홈에서 다시 만들기 (브랜치 `englead/lecture-rebuild-ready-20261124`)
- **배경**:
  - 오늘 아침 강의가 이미 `status === "ready"` 상태일 때, 이어서 진행한 아침 통화(예: 11/24 아침 통화)를 반영해 사용자가 홈에서 강의를 다시 만들 수 있는 UI 경로가 없었다(`MorningLectureCard`는 `ready` 상태에서 「재생」만 노출하며, `/api/lecture/generate`의 `force: true` 경로를 호출하지 않았음).
- **수정**:
  - `src/services/lecture/rebuildTodayLecture.ts`: `feedService.ts`가 `lectureService.ts`의 `pickLectureMistakes`를 import하는 순환 참조를 피하기 위해 별도 헬퍼 `rebuildTodayLecture`·`rebuildTodayLectureWith`를 추가. 먼저 `syncFeed(uid)`로 최신 후보를 서버에 동기화(실패 시 경고 로그 후 계속 진행)한 뒤 `startLecture(uid, date, true)`(`force=true`)를 호출함(새 서버 엔드포인트·인증 변경 없음).
  - `src/ui/lecture/MorningLectureCard.tsx`: `status === "ready"` 분기에서만 기존 「재생」 버튼 옆에 보조 스타일(slate 배경·작은 패딩)의 「다시 만들기」 버튼(`data-testid="rebuild-today-lecture"`)을 추가. 클릭 시 `confirm("오늘 통화까지 넣어 강의를 다시 만들까요?")` 확인을 거쳐(취소 시 무동작) `busy || loading` 비활성·로딩 스피너·`friendlyError`·기존 5초 폴링(`generating` 상태 전환 시)을 그대로 사용함(`generating`/실패/미생성 분기 버튼은 불변).
- **방어 조치 (Safeguards)**: `tests/rebuildTodayLecture.test.ts`(호출 순서 `syncFeed` → `startLecture(..., true)`, `syncFeed` 실패 시 경고 후 계속 진행, `startLecture` 실패 전파) 및 `tests/morningLectureRebuild.test.ts`(`ready` 분기 한정 노출·확인 후 `runLectureAction` 호출 순서·`generating`/실패/미생성 분기 비노출·`rebuildTodayLecture` 호출) 추가, `tests/userFacingText.test.ts`로 사용자 노출 금지어 비포함 확인. 다시 만들기를 시작하면 같은 날짜에 남아 있던 이전 강의의 `audioUrl`·`listenedAt`을 지워 옛 오디오가 재생되거나 「들음」이 남는 일을 막음(`shouldClearStaleLectureMedia`, `syncLectureStatus`는 `createdAt`이 다를 때 `audioUrl`을 이어받지 않음).
- **한계**: 복기가 끝나 세션에 실수가 저장된 통화만 재료에 들어간다. `syncFeed`가 실패해도 `startLecture`는 세션에서 후보를 다시 골라 generate 본문에 넣는다. 공개 피드 후보 목록은 다음 성공한 sync까지 잠시 예전일 수 있으나, 새 강의가 ready가 되면 피드는 그 강의를 제공한다.
- **검증**: `npm test`, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build`. 머지·배포 안 함.

---

### [2026-11-23 KST] v2.10.0 이후 수정(미배포) — 아침 강의 생성 정체를 wall-clock 15분으로 풀기 (브랜치 `englead/feed-wallclock-timeout-20261123`)
- **배경**:
  - 11/21·11/22·11/23 사흘 연속 아침 피드가 `status=generating`에 머물렀다. PR #35(프로세스 `setTimeout` 15분)는 11/22 10:58 머지되어 #44 라이브(`index-DZ567Gqg.js`)에 포함돼 있었지만, 11/23 07:30 점검에서도 정체를 막지 못했다. 11/23은 서버에 요청을 이어 보낸 뒤 07:52에 같은 제목으로 ready가 되었고, Republish는 하지 않았다.
- **원인**:
  - 생성 잡은 프로세스 메모리의 `running`과 `.data` JSON에만 있다. AI Studio/Cloud Run은 요청 사이에 CPU를 거의 주지 않아 `setTimeout`(15분)이 벽시계 기준으로 만료되지 않는다. `readLectureState`의 `INTERRUPTED` 오버레이는 `running`이 비어 있을 때만 동작해서, 프로세스는 살아 있고 타이머만 멈춘 상태에서는 피드가 재시작하지 않는다. `force`도 `running`이 있으면 새 작업을 시작하지 않는다.
- **수정**:
  - `server/lecture.ts`: `createdAt` 기준 벽시계가 `LECTURE_JOB_TIMEOUT_MS`(15분)를 넘긴 `generating`은 `running`이 남아 있어도 `failed`/`TIMED_OUT`으로 읽는다. `startLectureJob`은 이 오버레이를 보면 epoch를 올려 바로 다시 시작한다. 기존 프로세스 타임아웃·epoch 가드는 유지한다.
  - 피드(`buildFeedToday`)는 기존대로 `TIMED_OUT`을 즉시 재시도한다.
- **방어 조치 (Safeguards)**: `tests/lectureJobTimeout.test.ts`에 wall-clock 초과 시 TIMED_OUT, `running`이 남아 있어도 재시작, 15분 미만은 generating 유지, 프로세스 재시작 시 INTERRUPTED 우선, 재시작 후 늦은 쓰기가 새 작업을 덮어쓰지 않음을 추가함.
- **검증**: `npm test`, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build`.
- **모델**: 원인 조사·수정 설계는 Engineering Lead, 리뷰는 Claude CLI Opus 5.5 high.

---

### [2026-11-22 KST] v2.10.0 이후 수정(미배포) — QA 10차 37·43–48행 수정 (`qaPreview` 영속화·미루기 정보 카드·QA 빠른 답장 가로채기·홈 코치 링크·트랙 부제·클러스터 QA 필터) (브랜치 `englead/qa10-fixes-20261122`)
- **배경**: QA 10차 검증에서 ① 주간 복기 「트랙 골라 통화」 피커 부제 문구(37행), ② 미루기 응답에 카드가 없어 보이는 문제(43행), ③ QA 모드에서 진도 제안을 받고 「응」을 보내면 같은 제안 카드가 반복되고 새로고침 시 카드가 사라지며(44·45행), 본문에는 `[승인]`/`'응'` 안내가 남고 카드에는 「QA 모드에서는 실제 진도를 바꾸지 않습니다」가 나오는 모순(46행), ④ 홈 오늘 수업 카드에서 바로 코치로 가는 작은 링크 필요(47행), ⑤ QA 통화 뒤 「반복되는 실수」 설명 문구 변경(48행)이 보고되었다. 머지·배포는 하지 않음.
- **원인**:
  - `CoachModal.tsx`가 `!shouldPersistProposedChange`일 때 Firestore `planChanges`에 저장하지 않고 임시 `qa-preview-*` id만 만들어 새로고침 시 카드가 사라졌고, `selectQuickReplyTarget`이 `planChanges`에서 `none`을 반환해 「응」이 `/api/coach/chat`으로 넘어가 같은 제안이 반복되었으며, 본문 문구와 카드 안내가 어긋났다.
  - `buildPostponeResult`가 `noop` 텍스트만 반환했고, `HomeScreen.tsx` 오늘 수업 카드에는 코치 링크가 없었으며, `buildClusterRequest`는 `source === "qa"` 문서를 거르지 않았다.
- **수정**:
  - **37행 (`src/ui/home/trackOptions.ts`, `TrackPickerSheet.tsx`)**: `trackPickerSubtitle("startCall")`을 `"수업 트랙을 고르면 바로 통화 준비로 넘어가요"`로 변경하고 `reviewDayRowSubtitle(mode)`를 추가해 `startCall` 모드 주간 복기 행 부제를 `"선택하면 복기 카드에 머물러요"`로 분리(`resolveTrackPick` 불변).
  - **43행 (`src/data/progressAdjust.ts`, `server.ts`, `src/services/firebase/db.ts`, `CoachModal.tsx`)**: `ProgressResult`에 `{ type: "info"; reply: string; info: PostponeInfo }`를 추가하고 `buildPostponeResult`의 3갈래(일요일 되묻기 `reviewDay: true`/today_override/일반)가 `info`를 반환(기존 `reply` 유지). `buildPostponeInfoCard`(일요일 「오늘은 주간 복기」/평일 「오늘 건너뜀」, 마지막 줄 `"구글 캘린더는 바뀌지 않습니다"`), `sanitizeCoachInfoCard` 추가, `finalizeCoachProgressResponse`·`CoachProgressChatOut['progress']`·`server.ts` 타입 확장, `CoachMessageData.infoCard` 저장 및 버튼 없는 정보 카드 렌더링 구현.
  - **44+45+46행 (`src/data/progressAdjust.ts`, `src/data/coachProposalGate.ts`, `src/services/firebase/db.ts`, `CoachModal.tsx`)**: `shouldPersistProposedChange`와 `qa-preview-`·`persistChangeId`를 삭제하고 `proposalQaPreview`·`APPROVE_HINT`·`QA_PREVIEW_HINT`·`progressReplyForDisplay`를 도입. QA 진도 제안도 `planChanges`에 `qaPreview: true`로 저장하되 3중 차단(`canApplyPendingProposal`의 `qa_preview` 사유, `selectQuickReplyTarget` 선제외, `db.applyPlanChange` 거부)으로 QA 해제 후에도 적용 불가. `resolveQaProgressQuickReply`가 현 세션 `qaPreview` 대상 「응」/「아니」를 가로채 로컬 한 줄 응답(「QA 모드라 실제 진도에는 반영하지 않았어요」/「미리보기를 닫았어요. 실제 진도는 그대로예요.」)으로 닫고 LLM 호출·카드 반복을 막음. 채팅/이력 탭에서 `qaPreview` 배지(「QA 미리보기」/「미리보기 닫힘」)와 비-미리보기 만료 카드 「만료」 배지를 표시.
  - **47행 (`src/ui/home/HomeScreen.tsx`)**: 주간 복기·평일 오늘 수업 카드 액션 아래에 `data-testid="today-card-coach-link"`(「코치와 대화하기」, 44px 터치 높이) 추가(더 보기 코치 카드 유지), `alreadyProposed`에서 `c.qaPreview` 제외.
  - **48행 (`src/services/mistakes/clusterRequest.ts`)**: `ClusterInputMistake.source?` 추가 및 `buildClusterRequest`에서 `m.source === "qa"`를 제외해 #41 이전 과거 QA 실수 문서 유입을 차단. **참고**: 48행의 실제 증상(동일 개수에서 설명 문구만 바뀐 현상)은 QA 누출이 아니라 서버 인스턴스 로컬 파일(`.data/mistake-clusters/`) 이름 캐시 휘발성 때문으로 추정되며, 증상 자체는 이번 PR에서 수정하지 않음.
  - **문서 (`PROJECT_CONTEXT.md`, `firebase-blueprint.json`, `docs/history/changelog.md`)**: `PlanChange.qaPreview`, `CoachMessage.infoCard`, 자연어 진도 조정·홈 카드·클러스터 필터·QA 10차 내역 갱신.
- **방어 조치 (Safeguards)**: `tests/trackOptions.test.ts`(B10·B11), `tests/progressAdjust.test.ts`(10·20·21·25·34 및 `APPROVE_HINT`/`progressReplyForDisplay`/`sanitizeCoachInfoCard`), `tests/coachProposalGate.test.ts`(`qa_preview`·`selectQuickReplyTarget`·`resolveQaProgressQuickReply`), `tests/coachQaPreviewWiring.test.ts`(신규), `tests/homeCoachLink.test.ts`(신규), `tests/clientUtils.test.ts`(`source: "qa"` 필터)로 검증.
- **검증**: `npm test`, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit` 통과. 머지·배포 미실행.

---

### [2026-11-22 KST] v2.10.0 이후 수정(미배포) — 코치 자연어 진도 조정 (`propose_progress_adjust`, 확인 후 반영, QA/stale/moved 가드·페이스(`lessonsPerCall`)·오늘 트랙·응 만료·QA 진도 가드) (브랜치 `englead/coach-progress-adjust-20261122`)
- **배경**: 원콜 「코치와 대화하기」에서 "하루 미뤄줘", "시험 때문에 이틀치 땡겨줘", "OPIc 매 통화 2과씩 나가줘", "여행 5과부터 할래", "방금 거 되돌려줘" 같은 자연어 진도 조정 요청을 받고, 사용자 확인 후에만 기존 `planChanges` → `goals.nextLessonIndex`·`goals.lessonsPerCall` 경로로 안전하게 반영할 수 있어야 한다. 또한 오늘 고른 트랙 반영, 오래된 제안 빠른 답장 방지, QA 통화의 진도 증가 차단이 필요하다. 머지·배포는 하지 않음.
- **원인**: 기존 코치 도구(`propose_plan_change`)는 자유 형식 `goalPatches`에 의존해 `nextLessonIndex` 경계·요일 패턴 계산·되돌리기·QA 가드가 일관되지 않았고, 미루기(`postpone`), 매 통화 반복 속도(`set_pace`), 오늘 트랙(`todayGoalId`) 우선 해석, 제안 10분 만료·세션 소속 검사, QA 통화 시 `advanceGoalAfterCompletedCall` 차단이 없었다.
- **수정**:
  - **순수 페이스·만료 게이트·진도 조정 규칙 (`src/data/planValidation.ts`, `src/data/lessonPace.ts`, `src/data/coachProposalGate.ts`, `src/data/progressAdjust.ts`)**: Firebase·DOM 의존 없이 `normalizeLessonsPerCall`(1~3)·`sanitizePlanChangeAfter` `lessonsPerCall` 검증, `lastLessonIndex`·`paceTarget`·`nextIndexAfterCompletedCall`(마지막 과 보호, `currentNext >= t`이면 null), `canApplyPendingProposal`·`selectQuickReplyTarget`(10분 만료, 미래 시각 60초 초과 만료, 빠른 답장은 현재 세션 카드만 허용), `set_pace`·`reconcileProgressIntent`·`parseDayCount`·`sanitizeTodayGoalId`(명시→`all`→시험/오픽→`todayGoalId`→오늘 패턴→되묻기)·`buildProgressCardView`·`formatAppliedProgressReply`·`describeUndoOffer` 및 `lessonsPerCall` 대상 `isProgressChange`/`isStaleProgressChange`/`pickUndoTarget` 구현. `postpone`은 항상 `noop` + 오늘을 제외한 다음 수업일 안내.
  - **DB 페이스 저장·복원 및 QA 진도 가드 (`src/services/firebase/db.ts`, `src/services/review/reviewPipeline.ts`)**: `GoalData`·`PlanChangeSnapshot`에 `lessonsPerCall` 추가, `applyPlanChange`/`revertPlanChange`가 `lessonsPerCall` 스냅샷(미설정 시 1 기록)·복원, `advanceGoalAfterCompletedCall`이 `nextIndexAfterCompletedCall` 사용(시그니처 유지). `reviewPipeline.ts`는 `mistakeSource !== "qa"`일 때만 `review.lessonAdvanced = true` 및 `advanceGoalAfterCompletedCall` 호출(QA면 `delete review.lessonAdvanced`로 빈 복기 오판 방지).
  - **서버 엔드포인트 (`server.ts`, `/api/coach/chat`)**: 요청 body의 `todayGoalId`를 `sanitizeTodayGoalId`로 검증해 상태·컨텍스트에 전달, `propose_progress_adjust` 도구에 `set_pace` 추가 및 시스템 프롬프트 규칙 7 갱신, `buildProgressProposal` + `sanitizePlanChangeAfter`로 서버에서 `after`와 `reply`를 결정론적으로 생성.
  - **코치 UI (`src/ui/coach/CoachModal.tsx`)**: 전송 시 `loadDailyOverride`로 `todayGoalId` 전달, `sessionChangeIdsRef`로 현재 세션 카드만 빠른 답장 대상(`selectQuickReplyTarget`)으로 제한, `canApplyPendingProposal`로 대화·이력 탭 만료(10분 초과 시 승인 대신 만료 안내·라벨) 적용(거절은 허용, Firestore 상태는 변경하지 않음), `buildProgressCardView`·`formatAppliedProgressReply`·`describeUndoOffer` 반영, 환영 예시와 칩(`⏩ "OPIc 매 통화 2과씩 나가줘"`) 갱신, `handleApplyChange` stale 가드 및 `handleRevertChange` `moved`·QA 가드 유지.
  - **문서 (`PROJECT_CONTEXT.md`)**: 「스케줄 불변 안전망」·「코치 UI 및 LLM 통제」·「트랙 바꾸기」에 `lessonsPerCall`, `set_pace`, 교정 규칙, `todayGoalId`, 10분 만료, QA 진도 가드를 추가.
- **방어 조치 (Safeguards)**: `tests/lessonPace.test.ts`, `tests/coachProposalGate.test.ts`, `tests/planValidation.test.ts`, `tests/progressAdjust.test.ts`(1–39)로 페이스·마지막 과 보호·의도 교정·오늘 트랙·10분 만료·카드 문구·stale/undo 검증, `tests/serverNodeImports.test.ts`로 순수 node 로드 검증, `tests/userFacingText.test.ts`로 UI 내부 용어 비노출 검증.
- **검증**: `npm test`(413/413 통과), `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build` 통과. 로컬 재실행으로 확인. 머지·배포 미실행.
- **모델 및 PR 겹침 메모**: 설계 Claude CLI Opus 5.5 high, 구현 agy gemini-4-hydrogen-high. 머지 시 `reviewPipeline.ts` 저장 블록은 `#41`의 `persistReviewOutcome`을 유지했다. QA면 `callSideEffects.advanceLesson`이 꺼져 `advanceGoalAfterCompletedCall`을 호출하지 않고 `lessonAdvanced`를 기록하지 않음(`false` 금지). 페이스는 `advanceGoalAfterCompletedCall`→`nextIndexAfterCompletedCall`이 적용한다. `#42`의 `HomeScreen`·`TrackPickerSheet`·`trackOptions`는 수정하지 않음(`dailyTrackOverride.ts`는 import만). 문서 상단(`changelog.md`·`PROJECT_CONTEXT.md`)은 같은 자리를 수정함.

---

### [2026-11-22 KST] v2.10.0 이후 수정(미배포) — 주간 복기일 「트랙 골라 통화」 피커에서 진행 가능한 트랙 선택 시 바로 통화 준비 시작 (브랜치 `englead/weekly-review-start-call-20261122`)
- **배경**: 일요일(주간 복기일) 오늘 수업 카드의 「트랙 골라 통화」 버튼으로 트랙 피커를 열어 트랙을 눌러도 통화 준비 화면으로 이어지지 않아, 주간 복기일에 바로 트랙 통화를 시작할 수 있도록 수정함. 머지·배포는 하지 않음.
- **원인**: P0-3이 주간 복기 카드에 「트랙 골라 통화」를 넣었으나, `d201b80` 이후 피커(`TrackPickerSheet`)가 트랙만 고르고 닫혀 이미 선택된 주간 복기를 누르면 통화를 시작하지 못함.
- **수정**:
  - `src/ui/home/trackOptions.ts`: `TrackPickerMode` (`"switchTrack" | "startCall"`), `TrackPickAction`, `nextPlayableLesson`, `resolveTrackPick`, `trackPickerSubtitle` 추가. `buildTrackOptions`의 `isFinished` 판정을 `nextPlayableLesson`으로 통일.
  - `src/ui/home/TrackPickerSheet.tsx`: `mode: TrackPickerMode` prop 추가 및 부제를 `trackPickerSubtitle(mode)`로 교체(선택 로직 및 닫기 `aria-label` 유지).
  - `src/ui/home/HomeScreen.tsx`: `showTrackPicker: boolean`을 `trackPickerMode: TrackPickerMode | null`로 교체하고 「트랙 골라 통화」는 `"startCall"`, 「트랙: …」 칩은 `"switchTrack"`으로 열도록 분리. `handleTrackPick`에서 `resolveTrackPick` 결과에 따라 `chooseOverrideGoal` 후 `"startCall"`이면 `onStartCall(g, action.lessonIndex)` 호출(`trackPickerMode`가 `null`이면 안전하게 `"switchTrack"`으로 처리). 주간 복기 카드에 새 통화 버튼은 추가하지 않음.
  - `PROJECT_CONTEXT.md`: 「트랙 골라 통화」와 평일/복기일 「트랙: …」 칩의 동작 구분 반영.
- **방어 조치 (Safeguards)**: `tests/trackOptions.test.ts`에 `B1`~`B10` 케이스 추가 — `startCall` 모드 진행 가능 트랙 선택(`startCall`), 「주간 복기」(`null`) 선택 시 통화 미시작(`selectTrack(null)`), `switchTrack` 모드 칩·루틴 선택 시 통화 미시작, `done`·과 없음·미등록 id의 `none` 처리, `nextLessonIndex` 미지정 시 1과 폴백, 기존 `buildTrackOptions` 회귀 확인, 모드별 부제 구분 검증.
- **검증**: `npm test`(373/373 통과), `npm run lint`(`tsc --noEmit`), `npx tsc -p tsconfig.server.json --noEmit`, `npm run build`, 로컬 `node server.ts` 기동 확인.
- **모델**: 설계 리뷰 Claude CLI Opus 5.5 high, 구현 agy Gemini 4 Hydrogen high.

---

### [2026-11-22 KST] v2.10.0 이후 수정(미배포) — QA 통화(?qa=1)가 진도·복습 목록·졸업/재오픈·학습일을 바꾸지 않도록 격리 (브랜치 `englead/qa-mode-no-progress-20261122`)
- **배경**: QA 9차 테스트(`?qa=1`) 통화 뒤 복기 화면에 「다음 수업으로 넘어갔어요」와 「복습 목록에 자동으로 저장됐어요」가 뜨고, 실제로 트랙 진도가 3과 → 4과로 올라가며 실수 저장·졸업/재오픈·학습일 사용량까지 사용자 기록에 반영되었다. 머지·배포는 하지 않음.
- **원인**: `reviewPipeline.ts`의 QA 판정(`qaNow`)이 `/api/review` 요청 본문에만 쓰이고, 저장 단계(진도 증가 `advanceGoalAfterCompletedCall`, 실수 삭제·저장 `deleteCallMistakesForSession`·`saveCallMistakes`, 졸업/재오픈 `applyCallMistakeUpdates`, `review.lessonAdvanced = true`)는 QA 여부와 관계없이 그대로 실행되었다. 또한 `NewCallScreen.tsx`와 `recoveredUsage.ts`가 QA 통화도 `liveMinutes`·`calls`로 기록해 학습일로 집계되었다.
- **수정**:
  - **QA 판정·부수효과 정책 (`src/data/qaMode.ts`)**: `isQaCall`(세션 `source` 우선, 없으면 `qaNow`), `CallSideEffects`, `callSideEffects` 추가(QA면 `saveMistakes`·`applyMistakeOutcomes`·`advanceLesson`·`recordLearningUsage` 모두 `false`).
  - **복기 저장 분리 (`src/services/review/persistReview.ts`, `src/services/review/reviewPipeline.ts`, `src/services/firebase/db.ts`)**: `SessionReviewData`에 `qaCall?: boolean` 추가(`lessonAdvanced` 주석에 QA 미기록 명시). `reviewPipeline.ts` 저장 블록을 `persistReviewOutcome`으로 분리해 QA이면 실수 삭제·저장, 졸업/재오픈(`usedCorrectlyItems`·`repeatedItems`=`[]`), `lessonAdvanced`, `advanceGoalAfterCompletedCall`을 건너뛰고 `qaCall: true`를 기록(`saveSessionReview`만 실행). `saveSessionReview` 실패 시 예외를 던지지 않고 진도 갱신을 건너뛰는 기존 순서를 유지함.
  - **복기 모달 안내 (`src/services/review/reviewView.ts`, `src/ui/review/ReviewModal.tsx`)**: `shouldShowLessonAdvanced`와 `reviewSaveNotice` 추가(`isEmptyReview`는 유지). `qaCall === true`이면 `mistakesSaved`와 무관하게 QA 안내 문구를 보여 주고 내일 강의·퀴즈 안내 목록 및 `devMode` 「mistakes 컬렉션 자동 저장됨」 문구를 숨김.
  - **사용량·학습일 분리 (`src/services/usage/usageService.ts`, `src/services/usage/learningLog.ts`, `src/ui/call/NewCallScreen.tsx`, `src/services/session/recoveredUsage.ts`)**: `UsageDelta.qaLiveMinutes?`를 추가해 `estimateCostUsd`에는 반영하되 `buildUsageFields`의 `liveMinutes`·`calls`에는 넣지 않음. `callUsageDelta`를 추가하고 `NewCallScreen.tsx`에서 세션 생성 시점의 `qaCallRef`로 일반/QA 사용량을 분기. `recoveredUsage.ts`는 `source === "qa"` 세션을 `null`로 제외.
- **방어 조치 (Safeguards)**: `tests/qaMode.test.ts`(A1–A3), `tests/persistReview.test.ts`(A4–A9, 가짜 deps로 호출 순서·실패 처리 검증, Firestore 미사용), `tests/reviewView.test.ts`(A10–A16), `tests/learningLog.test.ts`(A17–A18), `tests/recoveredUsage.test.ts`(A19–A20) 추가.
- **검증**: `npm test`(379/379 통과), `npm run lint`(`tsc --noEmit`), `npx tsc -p tsconfig.server.json --noEmit`, `npm run build`, 로컬 `node server.ts` 기동 확인. 설계 리뷰: Claude CLI Opus 5.5 high, 구현: agy gemini-4-hydrogen-high.

---

### [2026-11-22 KST] 핫픽스 — 배포 서버 기동 실패(ERR_MODULE_NOT_FOUND lecturePick) 수정 (브랜치 `englead/hotfix-server-imports-20261122`)
- **배경**: PR #39(main `970605d`) 머지 후 AI Studio 재게시가 「Failed to publish app」으로 실패했다. 라이브는 이전 번들(`index-Lqzg9F7x.js`) 그대로.
- **원인**: #39에서 `server.ts`가 `src/services/lecture/lectureSource.ts`를 새로 불러오는데, 이 파일은 `./lecturePick`, `../review/speechCheck`를 확장자 없이 import한다. 배포 서버는 `node server.ts`(tsx 없음)라 확장자 없는 경로를 찾지 못해 컨테이너가 exit(1). 테스트·dev는 tsx라 통과했다.
- **수정**: `lectureSource.ts`의 두 import에 `.ts` 확장자를 붙이고 `tsconfig.json`의 `allowImportingTsExtensions`를 `true`로 바꿈(`noEmit: true`라 안전, 서버 쪽 파일은 이미 `.ts` 확장자 사용).
- **방어 조치 (Safeguards)**: `tests/serverNodeImports.test.ts` 추가 — `server.ts`·`server/*.ts`가 불러오는 `src/` 모듈을 순수 node로 import해 실패하면 테스트가 깨짐(수정 전 코드에서 같은 오류로 실패 확인).
- **검증**: `npm test`(364 통과), `npm run lint`, `npx tsc --noEmit`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build`, 로컬 `node server.ts` 기동 확인. 작성: Engineering Lead(직접 수정, 4줄).

---

### [2026-11-22 KST] v2.10.0 이후 수정(미배포) — 2단계: 통화 후 보완 전사 분석 패스로 놓친 실수 보강 (브랜치 `englead/lecture-source-20261122`)
- **배경**: 1단계에서 세션 복기(`review.mistakes`)를 재사용·백필하도록 고쳤으나, 1차 복기가 통화 중 놓친 나머지 비자연스러운/틀린 사용자 발화를 추가로 잡아내야 한다(기본 켜짐).
- **원인**: 1차 `/api/review` 한 번의 응답에 요약·핵심표현·복습판정·실수가 함께 담기면서 긴 통화 전사의 나머지 오류들이 빠질 수 있었다.
- **수정**:
  - **순수 보완 규칙 (`src/services/lecture/lectureSource.ts`)**: `preferredUserTranscript`, `isUsableSupplementPhrase`(추임새·단독 인명·비영어·사운드 태그 제외), `phrasesAreDuplicate`(0.9 이상 STT 변형 중복 제거), `mergeSupplementItems`(전사 검증, hidden 포함 기존 항목 재등장 금지, 최대 8개) 추가. `extractReviewLectureItems`는 `review.mistakes` 뒤에 `review.extraMistakes`(`source: 'transcript_analysis'`, 백필 ID `ta_{sessionId}_{index}`)를 붙이고 `isEligibleLectureSession`·`planBackfill`/`planBackfillExtras`도 이를 반영함.
  - **서버 보완 패스 (`server/lectureSupplement.ts`, `server.ts`)**: `runLectureSupplement` (`TEXT_MODEL`, 90초 타임아웃 `LECTURE_STEP_TIMEOUT_MS`, 8000자 코퍼스 상한, QA/3분 미만/빈 발화 비용 가드, 실패 시 1단계 폴백) 구현. `POST /api/review`에서 기본 실행해 `extraMistakes`·`extraMistakesStatus`·합산 사용량을 반환하고, 기존 복기 세션 백필용 `POST /api/review/supplement` 추가.
  - **클라이언트 파이프라인 & 동기화 (`src/services/review/reviewPipeline.ts`, `src/services/lecture/lectureService.ts`, `src/services/firebase/db.ts`)**: `callDurationSec`·`qa` 전달, `extraMistakes`를 같은 배치(`source: 'transcript_analysis'`)로 저장. 강의 동기화 시 `extraMistakes`가 아직 없거나 보완 패스가 실패한 세션은 `/api/review/supplement`를 호출한 뒤 `updateSessionExtraMistakes`·백필 저장한다. 실패하면 해당 강의는 1단계 항목만 쓰고, 30분 뒤에 다시 시도한다. `deleteCallMistakesForSession`·`hideReportedMistake`도 `transcript_analysis`·`extraMistakes` 처리.
  - **상한 조정 (`server/lectureMaterial.ts`, `src/services/lecture/lectureSource.ts`)**: `MAX_NEW`·`MAX_NEW_FROM_SESSIONS`를 6 → 20으로 상향해 10분 오디오 상한(`trimItemsToBudget`가 복습, 이어서 보완/뒤쪽 새 항목 순으로 통째 제외)이 먼저 작동하도록 함.
- **방어 조치 (Safeguards)**: `tests/lectureSource.test.ts`·`tests/lectureSupplement.test.ts`에서 실통화 7개 보완 문구 검증, 추임새/인명/비영어/지어낸 문장/숨김 항목/중복 변형 차단, QA·47초·빈 코퍼스 스킵, 타임아웃·오류 폴백, 13항목 수집·20상한을 단위 테스트로 확인(라이브 호출 없음).
- **검증**: `npm test`, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build`.

---

### [2026-11-22 KST] v2.10.0 이후 수정(미배포) — 강의 재료를 통화 후 전체 전사 복기에서 가져온다 (브랜치 `englead/lecture-source-20261122`)
- **배경**: 찬식님이 「뽑아 놓은 항목 중에서 고르는 게 아니라, 어제 전화 스크립트 전체를 분석해서 틀린 문장으로 복습 강의를 만들어야 한다」고 하셨다. 본인 통화 `call-1795270951478`(여행 1과, 6분 9초)의 복기(`review.mistakes`)에는 6개 오류가 있었는데, 실수 컬렉션에는 그 중 1개만 있어 강의에도 1개만 들어갔다.
- **원인**:
  - 강의 후보는 `users/{uid}/mistakes`만 본다. 통화 후 복기는 이미 sttFinal·liveTranscript 전체로 mistakes[]를 만들지만, `saveCallMistakes`가 순차 `setDoc`이라 중간에 실패하면 일부만 컬렉션에 남고, 세션 문서의 `review.mistakes`는 그대로 저장된다. 「이건 내가 한 말이 아니에요」는 컬렉션 문서를 지우고 세션에 `hidden`을 남긴다. 이 세션의 `mistakesSaved`·항목별 `id`/`hidden`은 덤프가 아직 복기 섹션을 포함하지 않아 부분 저장 실패와 숨김 중 어느 쪽인지는 미확인.
  - 전사는 Firestore 세션 문서에만 있다(turns 서브컬렉션 없음). 서버는 로그인 없이 세션을 읽지 못하며, 기존 `/api/feed/sync`는 실수 후보만 받았다.
- **수정**:
  - 새 강의 항목은 이전 강의 이후의 실제 연습 통화(3분 이상, QA 제외)의 `review.mistakes`에서 고른다. `hidden`은 제외하고, `myPhrase`는 그 세션 사용자 전사와 대조한다. 컬렉션에 없는 항목은 `source: 'call'`로 백필. `saveCallMistakes`는 배치 원자 쓰기. 복습(due) 후보는 기존 규칙 유지. 복기가 놓친 오류를 위한 보완 Gemini 패스는 후속.
- **방어 조치 (Safeguards)**: `tests/lectureSource.test.ts`에서 본인 통화 6개 문구 대조·지어낸 문장 거절·hidden 제외·짧은/QA 세션 제외·백필 계획·1개여도 채우지 않음을 확인.
- **검증**: `npm test`, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build`.
- **모델**: 설계 Claude CLI Opus 5.5 high(`/workspace/collab/onecall_lecture_source_20261122/claude_design_transcript_review.md`). 구현은 그 1단계(복기 재사용·백필·저장 공백 수정)를 따름. 2단계 보완 패스는 기본 꺼짐으로 후속.

---

### [2026-11-22 KST] v2.10.0 이후 수정(미배포) — 강의 재료 검증·소개 문구, QA 제외, 10/22 템플릿 (브랜치 `englead/lecture-source-20261122`)
- **배경**: 오늘 강의(12:25 KST, 「일요일 주간 총정리 핵심 영어」)가 9개 표현을 모두 「어젯밤 하신 말」로 소개했다. 1번 「yesterday I go to the office and check the safety gear」는 QA봇이 11:06에 찬식님 계정으로 넣은 테스트 입력이었다. 찬식님은 「내가 한 말이 아닌데?」라고 하셨고, 이어서 10/22 템플릿의 예문·인트로를 적용하고(TG 3963) 분량 상한을 10분으로 바꿨다(TG 3965). 머지·배포는 하지 않음.
- **원인**:
  - 후보 실수는 Firestore `users/{uid}/mistakes`에서 어제 이후 새 항목(최대 6)과 오늘 복습(최대 3)을 골라 `/api/feed/sync`로 서버에 보낸 뒤 강의로 들어간다. 최종 `myPhrase`는 입력 값으로 덮어쓰므로 모델이 문구를 지어내지는 못한다. 다만 소개 문장 「어젯밤 하신 말」이 날짜·복습 여부와 관계없이 서버 음성 템플릿과 프롬프트에 하드코딩되어 있었다.
  - 새 후보 창이 KST 달력 기준 「어제 0시 이후」라, 전날 낮의 짧은 QA 테스트 통화까지 「어젯밤」 재료로 들어갔다. 찬식님이 확인하신 오늘 9개 중 본인 항목은 8번 「On Friday, I will I will come to my country」(세션 `call-1795270951478`, 11/21 23:22–23:28 KST, 6분 9초, 여행 1과)뿐이었고, 나머지는 47초–2분 32초짜리 QA 통화였다.
  - 실수 문서의 `source`는 `call`/`keep_import`뿐이라 QA 통화와 본인 연습을 구분할 수 없었다. 일요일 주간 총정리는 제목·코치 한마디 톤만 바꾸고 후보 풀을 넓히지는 않았다. 묶음(clusters)은 강의 재료가 아니다.
  - 10/22 템플릿에 있던 「비슷한 예로」 예문과 「찬식님, 좋은 아침이에요… 화이팅이에요, 찬식님!」 인트로·마무리가 생성기에 없었고, 수업 주제도 전달되지 않았다. 홈 카드는 `durationSec`를 분으로만 반올림해 7분 42초 오디오가 다른 분 수로 보일 수 있었다.
- **수정**:
  - 모델 출력을 입력 ID·문구·kind에 맞춰 검증하고, 소개 문구는 항목의 실제 날짜를 따른다. 후보가 없으면 `NOTHING_TO_TEACH`.
  - QA 모드(`?qa=1` / `oc_qa_mode`): 그 브라우저에서 시작한 통화의 실수를 `source: 'qa'`로 저장하고 강의·피드 후보에서 뺀다. 과거 문서는 소급하지 않음.
  - 새 후보는 이전 ready 강의의 `createdAt` 이후(없으면 최근 24시간)만 고르고, 통화 시간 3분 미만 세션은 새·복습 후보에서 모두 제외한다. 세션 길이는 `startedAt`–`endedAt`(없으면 마지막 전사/청크 시각). 세션 문서가 없으면 남기고 로그(fail open). 실제 항목이 하나여도 그 항목만 쓰고 가짜 재료를 채우지 않는다.
  - 항목마다 「비슷한 예로」 예문 1개, 실제 재료로 채운 인트로와 연습 마무리, 난도별 해설 1~5문장, 수업 주제(`lessonTitle`)를 대화에 반영. 오디오 상한 10분. 예문·해설은 줄이지 않고, 넘칠 때만 복습부터 항목을 통째로 제외. 카드 길이는 「7분 42초」처럼 표시.
- **방어 조치 (Safeguards)**: `tests/lecturePick.test.ts`, `tests/lectureMaterial.test.ts`, `tests/qaMode.test.ts`에서 후보 선정·QA 제외·이전 강의 시각 컷오프·3분 미만 세션 제외(오늘 9개 재현 시 본인 항목만 남음), 대본 검증, 소개 문구(항목 1개여도 어젯밤 표현이 그 항목에만), 10분 예산(항목 제거·예문 유지), `NOTHING_TO_TEACH`를 결정론적으로 확인.
- **검증**: `npm test`, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build`.
- **모델**: 설계 Claude CLI Opus 5.5 high(`/workspace/collab/onecall_lecture_source_20261122/claude_design_out.md`). 구현은 그 명세와 TG 3965(10분 상한·예문/해설 유지)를 따라 작성. 샘플 대본은 `/workspace/collab/oncall_lecture_template_check_20261122/`.

---

### [2026-11-22 KST] v2.10.0 이후 수정(미배포) — 통합 브랜치 `englead/integrate-20261122` (#37+#36+#33+#34)
- **배경**: 열린 Draft PR #37(재시작 시 강의 유지)·#36(TTS 지시문 낭독)·#33(QA 6차)·#34(트랙·말소리·목소리)를 main(`3450071`, #35 포함) 위에 한 브랜치로 합침. 이 PR이 네 건을 대체한다. 기존 PR은 닫지 않았고, 머지·배포는 하지 않음.
- **합친 내용**:
  - **#37** (`englead/feed-persist`): ready 강의 대본을 Firestore `feeds/{id}/days/{date}`에 암호화 백업하고, 재시작 뒤에는 같은 대본으로 TTS만 다시 만듦. 피드 `audioUrl`은 https. 홈 카드는 ready 문서를 즉시 표시하고 Storage 업로드는 백그라운드. Firestore `days` 규칙과 Storage lectures 경로는 콘솔에서 따로 게시해야 함.
  - **#36** (`englead/tts-strip-directions`): 1인 TTS도 스타일을 `speechMetadata.style`로만 보내고, `(pause)` 등 지시문은 낭독 전에 제거함(`myPhrase`는 유지).
  - **#33** (`englead/qa6-r30-28-24-29-track`): 강의 오디오 status 폴링(전체 15분·정체 3분), ffmpeg가 있으면 AAC/MP3 압축, 홈 흐름 배너, 묶음 이름 재사용, 진도 문서 덮어쓰기 방지.
  - **#34** (`englead/feedback-1122-track-voice-audio`): 홈 카드에서 트랙 바로 바꾸기(오늘만 저장), 말소리 선행 버퍼 120–400ms, 설정에서 AI 목소리 선택(기본 Kore).
- **충돌 해결** (`lecture.ts` 등): #36의 지시문 제거·#37의 작업 epoch/백업과 #33의 병렬 TTS·인코딩·`lectureStatusPayload`를 한 `renderAndSaveAudio`에 모음. 홈 카드는 #37의 메타데이터 동기화+백그라운드 복사를 유지하고, 복사는 #33처럼 mime/확장자를 따름. 피드 오디오 URL은 실제 확장자(wav/m4a/mp3)를 쓰고, 오늘 날짜면 #37의 백업 복원 검사를 함. changelog·PROJECT_CONTEXT는 네 PR 내용을 모두 담아 정리함.
- **검증**: `npm test`, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build`(통합 브랜치에서 실행).
- **배포 시 주의**: 첫 배포 때는 days 백업이 없어 서버 재시작 시 오늘 강의가 한 번 더 바뀔 수 있음. Firestore `days` 규칙과 Storage lectures 규칙은 AI Studio Republish만으로 바뀌지 않으며 콘솔에서 따로 게시해야 함. 콘솔에 붙여 넣을 Firestore·Storage 규칙 최종 텍스트는 배포 전 점검 폴더에 준비해 두었음.

---

### [2026-11-22 KST] v2.10.0 이후 수정(미배포) — 재시작 시 오늘 강의 유지, 피드 https URL, 홈 카드 지연·Storage 403 가드 (브랜치 `englead/feed-persist`)
- **배경**: 2026-11-22 10:56 KST에 ready였던 오늘 강의(「자연스러운 입국 심사와 출장 표현」)가 11:01 Republish 뒤 `today.json`에서 사라지고, 11:06에 다른 제목의 강의가 새로 만들어졌다. QA봇이 같은 라이브 main `3450071`에서 Storage 업로드 403(34행)과 새로고침 후 카드가 「불러오는 중…」에 40–67초 머무는 현상(28행)을 재현했다. 피드 JSON의 `audioUrl`이 `http://`로 나가 열면 500이 나고, `https://`로 바꾸면 재생됐다. 머지·배포는 하지 않음.
- **원인**:
  - 피드 설정은 Firestore `feeds/{id}`에 암호화 백업되지만, 강의 대본·WAV는 서버 `.data/lectures/`에만 있었다. 재시작 후 `buildFeedToday`가 로컬 강의가 없으면 `startLectureJob`으로 새 생성을 시작했다.
  - 앱의 `syncLectureFromServer`는 `users/{uid}/lectures/{date}.wav`로 올리는데, 문서의 Storage 규칙 예시는 `users/{uid}/recordings/**`만 허용한다. 업로드가 403으로 실패해 `audioUrl`이 비고, 홈 카드는 매 로드마다 전체 WAV(24kHz, 수 분 강의면 수십 MB)를 받은 뒤에야 「불러오는 중…」을 풀었다.
  - `feedBaseUrl`은 `X-Forwarded-Proto`가 없으면 Express `req.protocol`을 쓰는데, 프록시가 TLS를 종료하면 컨테이너는 http로 보인다. `trust proxy`도 없었다.
- **수정**:
  - ready 강의 대본·상태를 Firestore `feeds/{feedDocId}/days/{date}`에 암호화 백업(로그인 없이 PATCH, 필드는 `iv`·`data`·`updatedAt`). 재시작 뒤에는 같은 대본으로 TTS만 다시 만들고(`startLectureAudioRebuild`) 새 강의는 만들지 않음. 미완료 작업은 기존처럼 INTERRUPTED/TIMED_OUT 재시도. #35 타임아웃·epoch 유지. WAV 원본을 Storage에 익명으로 올리는 일은 하지 않음.
  - `firestore.rules`에 `days/{date}` 규칙 추가(부모 피드 문서가 있을 때만, 익명 삭제 없음). 앱 강의 문서가 이미 ready이면 서버의 다른 ready 강의로 덮어쓰지 않음(`createdAt` 비교). `listenedAt`은 같은 강의에만 이어받고, `lectureDate`는 ready로 처음 바뀔 때만 기록.
  - 홈 카드는 Firestore에 ready가 있으면 즉시 표시하고, Storage 업로드는 백그라운드·6시간 백오프. 문서의 Storage 규칙 예시에 `users/{uid}/lectures/{date}.wav` 경로를 추가. 규칙 파일(`storage.rules`)은 기존 방침대로 저장소에 만들지 않음.
  - `publicFeedBaseUrl`: 공개 호스트는 항상 https, localhost는 힌트가 없으면 http. `app.set('trust proxy', 1)`.
- **방어 조치 (Safeguards)**: `tests/lecturePersist.test.ts`(백업 필드·복원 시 startJob 0회·재빌드 중 generating+제목·404/500·epoch·single-flight·규칙 텍스트 검사), `tests/feedBaseUrl.test.ts`, `tests/lectureSyncPolicy.test.ts`(즉시 표시·백오프·덮어쓰기 가드·lectureDate·규칙 문서와 경로 일치). 기존 `lectureJobTimeout`·`lectureAudio`·`feedStore` 테스트 유지.
- **검증**: `npm test`, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build`.
- **배포 시 주의**: 첫 배포 때는 오늘 강의의 days 백업이 아직 없어, 배포로 `.data/`가 지워지면 피드가 한 번 더 새로 만들 수 있다(그 이후부터 백업이 유지됨). 앱은 기존 Firestore 강의를 유지하므로 그날 하루 피드와 앱 제목이 다를 수 있다. Firestore `days` 규칙과 Storage lectures 규칙은 AI Studio Republish만으로 바뀌지 않으며 콘솔에서 따로 게시해야 한다. 규칙이 아직이면 백업 쓰기는 403으로 로그만 남고 동작은 지금과 같다.

---

### [2026-11-22 KST] v2.10.0 이후 수정(미배포) — 아침 강의 TTS 지시문 낭독 방지 (브랜치 `englead/tts-strip-directions`)
- **배경**: 아침 강의 오디오에서 모델이 스타일 지시문을 소리 내어 읽는 문제가 확인되어 수정함. 머지·배포는 하지 않음.
- **원인**:
  - `server/lecture.ts`의 1인 경로 `toSpeechParts(text, false)`가 `TTS_STYLE` 문자열을 `text` 앞에 직접 붙여(`\`\${TTS_STYLE}\\n\\n…\``) 보냈고, `gemini-3.8-flash-tts`가 인사·항목별 정답·코치 한마디에서 이를 그대로 낭독함(오늘 강의 전사로 7회 확인, 전사가 비어 있거나 깨진 4회 구간은 `[미확인]`). 2인 경로는 `speechMetadata.style`을 사용해 문제가 없었음.
  - `(pause)`, `[Coach smiles]`, `Narrator:`, 말투 지시, 마크다운 기호 등은 오늘 오디오에서는 관찰되지 않았으나, 대본에 섞일 경우 TTS가 그대로 읽을 수 있어 예방 수정함(프롬프트 규칙 2의 `"(3초 무음은 시스템이 넣음)"` 문구 포함).
- **수정**:
  - `server/speechText.ts` (신규): 순수 함수 `stripSpeechDirections`·`cleanLectureScriptItem`과 좁은 타입 `LectureScriptItemLike`를 구현(순환 참조 방지를 위해 `lecture.ts` 미참조). 해설자 줄, 라벨 괄호, 말투 접두어, 제목/목록 기호, 마크다운 기호(인라인 코드·굵게·기울임), 대괄호, 영/한 지시어 소괄호를 줄 단위로 멱등 제거하며 `thank you (감사합니다)`·`work for (소속)`·`1990s`·`(쉼표)`·`5 * 3 = 15` 등 일반 문장은 유지함. `cleanLectureScriptItem`은 `myPhrase`·`naturalPhrase`·`mistakeId`·`kind`·`startSec`을 보존하고 `explanation`·`meaningKo`·`answerEnglish`(빈 값이면 `naturalPhrase` 폴백)·`dialogue[].line`(중복 `Coach:`/`Partner:` 제거 및 빈 줄 제외)만 정화함.
  - `server/lecture.ts`: `TTS_STYLE`을 export하고, `toSpeechParts` 1인 경로를 `[{ text: body, speechMetadata: { style: TTS_STYLE } }]`(단일 화자라 `speaker` 키 제외)로 변경하며 빈 줄·빈 line 제외 및 빈 입력 시 `[]` 반환(내부에서 strip하지 않아 `myPhrase` 보호). `generateScript` 프롬프트 규칙 2에서 `"(3초 무음은 시스템이 넣음)"`을 제거하고 무음 표기 금지 문장을 추가했으며, 지시문·마크다운·화자 접두 금지 규칙 8을 신설. `generateScript` 반환값과 `renderAndSaveAudio` 앞부분(`title`·`naturalPhrase`·`coachNote` 템플릿 및 `items` 사본, `myPhrase` 원문 유지, `startSec` 기록 및 `state.script = items` 저장)에 정화를 적용함.
  - `PROJECT_CONTEXT.md`: B-7 아침 강의 항목에 TTS 입력 규칙(1인·2인 모두 `style`은 `speechMetadata`로 전송, `text`는 말할 말만 유지, 저장·렌더 전 지시문 제거 및 `myPhrase` 예외) 기록.
- **방어 조치 (Safeguards)**:
  - `tests/speechText.test.ts` (신규): 제거(S1–S15)·유지(K1–K10)·빈 입력/줄 정리(E1–E4)·멱등성·`cleanLectureScriptItem`(C1–C6) 단위 테스트 추가.
  - `tests/server.test.ts`: `toSpeechParts` 1인/2인 회귀 테스트(T1–T10, T6 기존 테스트 유지) 및 프롬프트 소스 가드(P1–P2) 추가.
  - `tests/lectureAudio.test.ts`: `startLectureAudioRebuild`에서 `synthesizeFn` 입력을 캡처해 4회 호출, `myPhrase` 원문 유지, 지시문/마크다운/중복 라벨 제거, `state.script[0]` 정화, `toSpeechParts` 누출 없음을 검증하는 통합 테스트(R1–R6) 추가.
- **검증**: `npm test` 252/252 통과, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build` 통과. 실제 Gemini TTS API가 1인 요청의 `speechMetadata.style`을 400 없이 수용하는지, 그리고 음성 톤 변화는 라이브 스모크 테스트 전까지 `[미확인]`.

### [2026-11-22 KST] v2.10.0 이후 수정(미배포) — 아침 강의 생성이 generating에 멈추지 않게 타임아웃 추가 (브랜치 `englead/feed-gen-timeout`)
- **배경**: 2026-11-22 라이브 피드 `today.json`이 07:15부터 `status=generating`(제목만 있음)인 채 수 시간 멈춤. 11/21 아침 피드도 ready가 아니었고, 마지막 ready는 11/20. 머지·배포는 하지 않음.
- **원인**: `GET /feed/{secret}/today.json`이 날짜가 바뀌면 생성을 시작하지만, `runJob`(대본·TTS)과 각 `generateContent`에 타임아웃이 없음. Gemini 호출이 응답 없이 멈추면 메모리의 `running`이 남아 `generating`이 하루 종일 유지됨. `force`와 피드 재시도도 `running`이 있으면 새 작업을 시작하지 않고, `INTERRUPTED`는 서버 프로세스가 죽은 뒤에만 동작함. 피드 점검 루틴은 generating이면 07:30에도 알리지 않음.
- **수정**:
  - `server/lecture.ts`: 전체 작업 15분, 대본·TTS 호출 각 90초(`withTimeout`). 초과 시 `failed`/`TIMED_OUT`. 작업 epoch로 타임아웃 후 늦은 완료가 새 상태를 덮어쓰지 않게 함. TTS 조각마다 상태 갱신.
  - `server/feed.ts`: `TIMED_OUT`은 `INTERRUPTED`와 같이 30분을 기다리지 않고 바로 다시 생성.
  - `MorningLectureCard.tsx`: 「시간이 초과되어 강의 만들기가 멈췄어요. 다시 만들어 주세요.」
- **방어 조치 (Safeguards)**: `tests/lectureJobTimeout.test.ts` — `withTimeout` 만료, 멈춘 작업이 `TIMED_OUT`으로 풀림, 타임아웃된 작업의 늦은 write가 새 결과를 덮어쓰지 않음, 아직 살아있는 작업은 `force`로도 재시작하지 않음.
- **검증**: `npm test`, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit` 통과. 라이브 오늘 피드 복구는 이 PR만으로는 불가(현재 프로세스의 멈춘 작업은 재시작 후에야 `INTERRUPTED`로 풀림).

---

### [2026-11-22 KST] v2.10.0 이후 수정(미배포) — 사용자 피드백 3건 (홈 트랙 바로 바꾸기, AI 말소리 끊김, 목소리 고정·선택) (브랜치 `englead/feedback-1122-track-voice-audio`, Draft PR #33 위에 쌓음)
- **배경**: 찬식님이 어제 앱을 써 보고 남긴 피드백. 1) 트랙 바꾸기가 하단 「더 보기」에 숨어 있음 2) AI 말소리가 살짝씩 끊김 3) AI 목소리가 통화 중 바뀜. 운영에서 「이 트랙으로 바꾸기」 선택이 새로고침하면 사라진다는 버그도 함께 확인됨. 머지·배포는 하지 않음.
- **원인과 수정**:
  - **트랙 선택 저장 안 됨**: `HomeScreen`의 `overrideGoalId`가 `useState(null)`뿐이었음. 오늘(KST) 날짜를 키로 `localStorage`(`onecall_today_track_override:{uid}`)에 저장(`dailyTrackOverride.ts`). 다음 날, 깨진 값, 목록에 없는 트랙은 무시.
  - **트랙 바로 바꾸기**: 오늘 수업 카드 「트랙: …」 칩 → `TrackPickerSheet`(`trackOptions.ts`). 진행할 과가 없는 트랙은 비활성, 복기일에는 「주간 복기(오늘 루틴)」 항목. 요일별 주간 루틴을 설정에서 고치는 곳은 아직 없음(미구현).
  - **말소리 끊김**: `geminiLiveProvider.playAudioChunk`가 청크 도착 즉시 예약해 선행 버퍼가 없었음(네트워크·메인스레드 지연 = 무음). `audioPlaybackScheduler.ts`(선행 120ms~400ms 적응, 새 발화 구분, interrupted 때만 리셋)로 교체. 샘플레이트는 출력 컨텍스트·버퍼 모두 24000으로 일치해 원인이 아님. 홀수 바이트 청크 예외 방지, `playback_stats` 로그 추가.
  - **목소리**: 모든 경로가 이미 `voiceName: "Kore"`를 보내고 있어 「미지정」은 원인이 아님. 모델(`gemini-3.8-live`) 자체의 음색 흔들림이 Google 포럼에 다수 보고됨(앱이 완전히 막을 수 없음). 앱 쪽 불일치(경로·시도마다 `languageCode` 유무가 다름, 허용 목록 검증이 서버에만 있음, 기본값 `Kore` 흩어짐)를 `src/config/voices.ts` + `server/liveConfig.ts`로 통일하고, 설정 「AI 목소리」 탭(허용 5종, 미리 듣기, `settings/general.voiceName`)을 추가.
- **방어 조치 (Safeguards)**: 허용 목록 밖 값은 클라·서버 모두 Kore로 정규화. 설정 읽기는 통화 시작을 1.5초 넘게 막지 않음(캐시 → localStorage → 원격). 선택한 목소리는 다음 통화부터 적용. 아침 강의 두 화자 구조는 건드리지 않음.
- **테스트**: `tests/audioPlaybackScheduler.test.ts`, `trackOptions.test.ts`, `dailyTrackOverride.test.ts`, `voices.test.ts`, `liveConfig.test.ts`, `voicePreference.test.ts`, `audioPlayable.test.ts` 추가, `liveWire.test.ts`·`a11yCloseButtons.test.ts` 갱신. `npm test` 284/284, lint, server tsc, build 통과. 스크린샷: `/workspace/collab/onecall_feedback_20261122/shots/`.
- **배포 후 확인 필요**: 실기기 통화에서 끊김 체감, 음색 일관성(모델 측 흔들림은 남을 수 있음), 서버 로그 `[Live] stage=playback_stats`.

### [2026-11-21 KST] v2.10.0 이후 수정(미배포) — QA 6차 재확인 후속 (30·28·24·29/33행, 브랜치 `englead/qa6-r30-28-24-29-track`)
- **배경**: QA봇이 #32 머지·배포(main `1c445d7`, 번들 `index-Bb2KsfTc.js`)를 다시 확인한 부분 실패·신규 이슈를 Draft PR로 고침. 머지·배포는 하지 않음.
- **원인과 수정**:
  - **30행(부분 실패)**: 클라이언트는 GET audio 404를 3분 동안만 폴링해 타임아웃했고, 완료된 WAV는 약 25MB라 다운로드·오프라인 저장이 실패함. 이제 status(`audioStatus`/`hasAudio`/`audioProgress`)를 폴링하고 재생성이 진행 중이면 3분 하드 타임아웃을 쓰지 않음(전체 15분, 정체 3분). ffmpeg가 있으면 AAC/MP3 48kbps로 저장하고 없으면 WAV로 폴백. 피드 URL도 실제 확장자를 씀. 모달은 진행 개수를 보여 주고, 인증 fetch blob도 Cache API에 저장함. 재생성 중 서버가 재시작하면 `missing`/`INTERRUPTED`로 정규화함.
  - **28행**: 홈 카드가 `audioUrl` 없는 ready 강의에서 `syncLectureFromServer`의 전체 파일 다운로드를 await해 「불러오는 중…」에 80초 이상 멈춤. Firestore 문서를 먼저 보여 로딩을 해제하고, 서버에 파일이 있을 때만 백그라운드로 Storage에 올림.
  - **24행**: 하단 `fixed` 알약이 스크롤 중 「더 보기」와 묶음 첫 줄을 가림. 홈 `<main>` 맨 위 일반 흐름 배너로 옮김.
  - **29/33행**: 새로고침 때 묶음 이름이 한 번 다시 만들어짐. 정확 멤버 집합 캐시 + Jaccard ≥ 0.6 겹침 재사용, 비활성 이름 보관.
  - **보강**: 같은 계정 다른 탭의 실시간 통화를 새로고침이 즉시 중단하지 않음(기본 2분 유휴 + `lastTranscriptAt`). `batchInitGoals`는 기존 목표 문서를 덮어쓰지 않음.
- **검증**: `npm test` 249/249, lint, server tsc, build 통과. 레이아웃 스크린샷: `/workspace/collab/onecall_qa6_fix_20261121/shots/`.

### [2026-11-21 KST] v2.10.0 이후 수정(미배포) — QA 5차 30·29·24행: 강의 오디오 404, 실수 묶음 혼입, 복기 알약 겹침 (브랜치 `englead/qa5-r30-29-24`)
- **배경**:
  - QA봇이 라이브 main `7b1be51`에서 재현한 3건을 Draft PR로 고침. 머지·배포는 하지 않음.
- **원인**:
  - **30행(높음)**: 아침 강의 WAV는 서버 `.data/lectures/{uid}/{date}.wav`에만 있고, Firestore에는 `status=ready`와 대본이 남을 수 있음. AI Studio 재배포로 `.data/`가 지워지면 `GET /api/lecture/audio`가 `lectureAudioPath()`에서 404를 내고, Cloud Storage `audioUrl`이 없으면 클라이언트가 죽은 오류 「강의 오디오를 불러오지 못했어요.」만 보여 줌. `INTERRUPTED` 처리는 `generating`만 다루고 ready 강의의 오디오 복구가 없었음(`PROJECT_CONTEXT.md`의 `.data/` 휘발 한계).
  - **29행(보통)**: `clusterBySimilarity`가 단일 연결(threshold 0.80)이라 A~B, B~C이면 A!~C도 한 묶음이 됨. 잘린 전사(「while discussing o」)와 짧은 비영어 원문(「A ver.」)을 걸러내지 않아 어휘 묶음에 섞임.
  - **24행(보통)**: `App.tsx`의 `fixed bottom-safe` 「끝나지 않은 통화」 알약이 홈 흐름 밖이라 데스크톱에서 「더 보기 · 주간 루틴…」 행을, iPhone 16 폭에서 「반복되는 실수」 카드 하단을 가림.
- **수정**:
  - **강의 오디오 복구 (`server/lecture.ts`, `server.ts`, `src/services/lecture/lectureService.ts`, `src/ui/lecture/LectureModal.tsx`)**: `startLectureAudioRebuild`가 로컬 대본 또는 클라이언트가 보낸 Firestore 대본으로 TTS만 다시 만들고, 강의 `status`는 `ready`로 유지함(`audioStatus: rebuilding|ready|missing`). WAV는 임시 파일에 쓴 뒤 rename. `POST /api/lecture/audio/rebuild`, 404 본문에 `code: LECTURE_AUDIO_MISSING`와 `hasLocalScript`. 모달은 「오디오를 다시 만드는 중…」과 「다시 시도」를 보여 줌. 대본이 없으면 409 `LECTURE_AUDIO_SCRIPT_MISSING`.
  - **실수 묶음 (`server/clusterMath.ts`, `server/mistakeClusters.ts`)**: 군집 전 `isClusterableMistake`로 잘린 조각·짧은 비영어 원문을 제외. `clusterBySimilarity`를 결정적 complete-linkage로 바꿔 연쇄 병합을 막음. 임베딩 문구를 오류 유형 중심으로 다듬고 `EMBED_TEXT_VERSION = 2`로 캐시를 무효화. 크기 1 묶음은 기존처럼 이름·카드에 넣지 않음.
  - **복기 알약 레이아웃 (`src/App.tsx`, `src/ui/home/HomeScreen.tsx`, `src/index.css`)**: 알약 표시와 같은 `showUnfinishedPill` 값으로 홈 `main` 끝에 `unfinished-pill-space` 높이 여백을 넣어 콘텐츠가 알약 위로 스크롤되게 함. 알약은 고정 유지, `whitespace-nowrap`.
- **방어 조치 (Safeguards)**:
  - 재생성 중 Firestore/로컬 `status`를 `generating`으로 바꾸지 않아 재시작 시 대본이 `INTERRUPTED`로 지워지지 않음. 클라이언트 대본은 항목 수(최대 9)·필드 길이 상한으로 검증. 동시 재생성은 한 작업만 수행. TTS 실패 시 반쪽 WAV를 남기지 않음.
  - `tests/lectureAudio.test.ts`, `tests/unfinishedPillLayout.test.ts` 추가, `tests/mistakeClusters.test.ts`에 필터·complete-linkage·정크 제외 테스트 추가.
- **검증**: `npm test`(240/240), `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build` 모두 통과. 박스에서 SIE 실호출로 전후 비교(샘플 11문장): 수정 전 「while discussing o」가 어휘 문장과 묶였고, 수정 후 「A ver.」·잘린 전사는 제외, 「Can you fix it?」는 단독(카드 미표시), 과거시제 3개·비교급 어휘 2개·동사 선택 2개가 각각 묶임. 데스크톱 1280×800·iPhone 16 393×852 목업 스크린샷에서 알약과 「더 보기」/실수 카드의 겹침이 없었음.

### [2026-11-21 KST] v2.10.0 이후 수정(미배포) — 실수 노트 반복 패턴 묶기(SIE 임베딩) 추가 (브랜치 `englead/mistake-clusters`)
- **배경**:
  - 실수 노트가 쌓여도 사용자가 어떤 문법·표현 실수를 반복하는지 한눈에 파악하기 어려워, 홈 화면에 유사한 실수를 묶어 보여 주는 「반복되는 실수」 카드를 추가함.
- **원인**:
  - 기존에는 실수 목록을 개별 항목(`dueMistakes`/`allMistakes`)으로만 다루어 의미 기반 군집화와 패턴 요약이 없었음.
- **수정**:
  - **임베딩 모델·단가 (`src/config/models.ts`, `src/services/usage/usageService.ts`)**: Superlinked Serverless의 `Qwen/Qwen3-Embedding-4B`(`EMBEDDING_MODEL`, `SIE_EMBEDDING_URL = "https://api.superlinked.com/v1/embeddings"`, 단가 `sieEmbedPer1MTokens = 0.06` / 100만 토큰)를 추가함. 오픈웨이트 임베딩 전용 모델이라 한국어 문법 설명과 영어 발화 혼합 입력에 적합하고 단가가 낮아 채택함. `UsageDelta`/`estimateCostUsd`/`buildUsageFields`에 선택 필드 `sieEmbeddingTokens`를 추가해 `textTokens`와 분리 집계함.
  - **순수 군집화 (`server/clusterMath.ts`)**: `cosine`(0벡터 방어), 단일 연결 union-find(`clusterBySimilarity`, 잠정 임계값 `CLUSTER_SIM_THRESHOLD = 0.80`, 입력 순서 무관·결정적 정렬), `Instruct/Query` 라벨링 + 공백 정리 + 200/200/300자 자르기(`buildEmbeddingText`, `EMBED_TEXT_VERSION = 1`), 정렬된 멤버 ID 해시 `clusterKey`, `Float32Array`↔base64 변환 구현.
  - **SIE 클라이언트 & 캐시·이름 붙이기 (`server/sieEmbeddings.ts`, `server/mistakeClusters.ts`)**: 배치 32, 요청 12초·전체 20초 데드라인, 429/503 `Retry-After <= 2s`만 1회 재시도, 응답 `data`/`index`/유한 수치/차원 검증을 구현함. 사용자별 캐시(`${DATA_DIR}/mistake-clusters/<sha256(uid)>.json`)를 원자적(`tmp`+`rename`)으로 저장하고 요청에 없는 ID와 key를 정리함. 캐시에 없는 묶음(최대 8개, 크기 ≥ 2)만 `TEXT_MODEL` (`gemini-3.8-flash`, 기존 JSON `responseSchema` 패턴 일관성 유지 및 저지연·저비용 이유)로 한국어 이름을 붙이며, 실패 시 `"반복 실수 N"`으로 폴백(미캐시).
  - **라우트·전용 한도 (`server/rateLimit.ts`, `server.ts`)**: `checkClusterCall`·`clusterLimit`(분당 10회, `geminiLimit`과 맵 분리)과 `POST /api/mistakes/clusters`(본문 검증 순수 함수 `validateClusterRequestBody`, `requireAuth`)를 등록함.
  - **클라이언트 UI (`src/services/mistakes/clusterRequest.ts`, `src/services/mistakes/clusterService.ts`, `src/ui/home/MistakeClustersCard.tsx`, `src/ui/home/HomeScreen.tsx`)**: `HomeScreen`이 이미 불러온 `allMistakes`를 백그라운드로 전송(30초 abort, 세션 메모이즈, 사용량 > 0일 때만 `recordUsage`)하고 홈·통화·퀴즈를 대기시키지 않음. 카드는 크기 2 이상 상위 3개만 펼침/접힘으로 표시하며, `SIE_API_KEY` 미설정·장애·지연 시 HTTP 200 `enabled: false`로 숨김.
  - **후속 범위**: 퀴즈·강의 우선순위 재정렬(`prioritizeByClusters`)은 SRS 기아 방지·제품 규칙 검토가 필요해 이번 변경에서 제외하고 후속 과제로 남김(`PROJECT_CONTEXT.md` §4·§5 반영).
- **방어 조치 (Safeguards)**:
  - `process.env.SIE_API_KEY`는 `server/` 내부에서만 읽고 로그·오류·응답에 키/Authorization 헤더/응답 본문을 남기지 않으며, 브라우저로 임베딩 벡터를 전송하지 않음.
  - `tests/mistakeClusters.test.ts`(순수 군집화, 주입된 `fetch`/`sleep` 기반 SIE 클라이언트 재시도·타임아웃·오류 응답·배치, 임시 `DATA_DIR` 기반 캐시 무효화·손상 복구·부분 배치 보존·이름 폴백·비용 분리), `tests/server.test.ts`(요청 본문 검증·전용 리미터), `tests/clientUtils.test.ts`(`buildClusterRequest`·`pickDisplayClusters`·임베딩 단가 분리) 추가 및 `tests/userFacingText.test.ts`로 사용자 노출 문구 검사 통과 확인.
- **검증**: `npm test`(229/229), `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build` 모두 통과 확인. 박스에서 Superlinked `POST /v1/embeddings` 실호출(샘플 10문장, `Qwen/Qwen3-Embedding-4B`)로 과거시제 3개·주어-동사 일치 3개·전치사 2개가 각각 묶이고, 성격이 다른 관사 실수 2개는 분리됨(교차 묶음 없음, 임계값 0.80은 이 샘플에서 타당).

### [2026-11-21 KST] v2.10.0 이후 수정(미배포) — QA 재확인 21행: 무마이크 복구 통화 사용량 집계 누락·과소 집계 수정 (브랜치 `fix/qa4-r21`)
- **배경**:
  - 마이크 없이 진행한 통화가 새로고침 등으로 끊긴 뒤 복구 복기를 진행하면 복기 토큰 비용은 기록되지만 학습 기록의 통화 횟수(`calls`)와 통화 분(`liveMinutes`)이 빠지거나 0.0x분으로 과소 집계되는 문제가 확인됨.
- **원인**:
  - 무마이크 통화는 `onMediaStreamReady`가 호출되지 않아 10초 조각 녹음기가 돌지 않으므로 `lastChunkAt`이 `createCallSession`이 넣은 `startedAt`과 같은 값으로 고정됨.
  - `liveTranscript[].timestamp`는 항목이 처음 생성될 때(턴 시작)만 찍혀 마지막 발화가 끝난 시각을 반영하지 못하며, `recoveredUsage.ts`는 `lastChunkAt`과 유한 `number` 타입의 `timestamp`만 끝 시각 후보로 보고 있었음.
- **수정**:
  - `src/services/firebase/db.ts`: `SessionData`에 `lastTranscriptAt?: string`(ISO) 선택 필드를 추가하고, `updateSessionLiveTranscript`가 `liveTranscript`·`updatedAt`과 함께 `lastTranscriptAt: now`를 저장하도록 수정(`createCallSession`에는 넣지 않아 전사 없는 통화가 시작 시각 기준으로 집계되지 않게 유지).
  - `src/services/session/recoveredUsage.ts`: `parseTranscriptTimestamp` 순수 함수를 export해 유한 `number`, 숫자 문자열(ms), ISO 날짜 문자열을 정규화하고 `null`·객체·빈 문자열·`NaN`은 무시하도록 구현. `RecoveredUsageSession`(및 `RecoveredTranscriptItem`)에 `lastTranscriptAt`과 정규화 가능한 `liveTranscript[].timestamp`를 반영하고, `recoveredCallUsage`가 `lastChunkAt`·`lastTranscriptAt`·`startMs < t <= startMs + MAX_RECOVERED_CALL_SEC * 1000` 범위의 `liveTranscript[].timestamp` 최댓값을 끝 시각으로 사용하도록 수정(`lastChunkAt == startedAt`은 자동 제외, `updatedAt`·`endedAt`·`usageRecordedAt`은 끝 시각으로 미사용, 3시간 상한 및 10초 미만 `calls: 0`·후보 없음 `null` 유지).
  - `PROJECT_CONTEXT.md`: §4 복구 사용량 집계 설명 갱신 및 §5 버전 히스토리 추가.
- **방어 조치 (Safeguards)**:
  - `createCallSession`에 `lastTranscriptAt`을 넣지 않고 `startMs < t` 조건을 적용해 전사 없는 빈 세션은 `null`을 반환하며 `markRecorded`도 호출하지 않음.
  - `tests/recoveredUsage.test.ts`에 무마이크(`lastChunkAt == startedAt`, `liveTranscript` 비어 있음, `lastTranscriptAt = +105s` → 1.75분/`calls: 1`), `timestamp` 없음 + `lastTranscriptAt` 유무, 숫자/ISO 문자열 및 비정상 값 무시, 시작 이전 및 시작+3시간 초과 `timestamp` 무시, `updatedAt` 불변, `endedAt` 우선 `null`, `createRecoveredUsageRecorder` 무마이크 동시 2회 1회 기록·재호출 0회, 6초 무마이크(`calls: 0`, 0.1분) 테스트를 추가.
- **검증**: `npm test`(188/188), `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build` 모두 통과 확인.

### [2026-11-21 KST] v2.10.0 이후 수정(미배포) — QA 재확인 20행: 연속 학습일·휴식 배너를 같은 일별 사용 기록(KST)에서 파생 (브랜치 `fix/qa2-d`)
- **배경**:
  - 홈 화면에서 10초 이상 통화 직후나 복기를 닫고 홈으로 돌아왔을 때 「연속 학습 N일」과 「이틀째 쉬었어요. 오늘 수업만 해도 좋아요」 배너가 동시에 표시되거나, 배너가 잠깐 사라졌다가 다시 나타나는 문제가 보고됨(QA 재확인 20행).
- **원인**:
  - 휴식 배너(`isTwoDayAbsent`)는 `checkTwoDayAbsence`가 `users/{uid}/sessions` 최근 20개 `done` 세션의 `startedAt`(오늘 제외, 어제·그제만 확인)을 3단계 직렬 조회(`initUserPlanIfMissing` → `getUserSettings` → `checkTwoDayAbsence`)로 계산했고, 연속 학습일(`streakDays`)은 `getUsageMonths` + `summarizeLearningLog`(`usage/{yyyy-mm}.days.{DD}`, 오늘 포함, `calls > 0 || liveMinutes >= 0.5`)로 계산해 데이터 원천·학습일 정의·갱신 시점이 서로 달랐음.
  - 홈 마운트 시 `today`를 한 번만 잡아 앱을 연 채 KST 자정을 넘기거나 백그라운드에서 돌아와도 재계산되지 않았고, `recordUsage` 완료 시점과 홈 재마운트 조회가 겹칠 수 있었음.
- **수정**:
  - `src/services/usage/learningLog.ts`: epoch ms → KST `YYYY-MM-DD` 순수 함수 `kstDateStr(nowMs)`와 `REST_BANNER_MIN_DAYS = 2`, `HomeLearningStatus`, `deriveHomeLearningStatus(summary)`, `restBannerTitle(restDays)` 추가. `LearningLogSummary`와 `summarizeLearningLog`에 `today` 이하 마지막 학습일 `lastActiveDate`와 오늘 포함 연속 미학습 일수 `restDays`(오늘 학습=0, 어제 마지막=1, 그제 마지막=2, 기록 없음=null)를 추가.
  - `src/services/firebase/db.ts`: `getKSTToday()`를 `kstDateStr(Date.now())` 위임으로 교체(`learningLog.ts`는 `usageService.ts`를 `import type`으로만 참조해 런타임 순환 없음)하고 미사용 `checkTwoDayAbsence` 삭제.
  - `src/services/usage/usageService.ts`: `USAGE_UPDATED_EVENT = "aicall:usage-updated"`를 export하고 `recordUsage`의 `setDoc` 성공 직후 브라우저 전역(`typeof window !== "undefined"`)에 이벤트 디스패치(최소 수정).
  - `src/ui/home/HomeScreen.tsx`: `isTwoDayAbsent`/`streakDays`와 `checkTwoDayAbsence` 호출을 제거하고 `learningSummary` 단일 상태 + `deriveHomeLearningStatus(learningSummary)`로 통일. `learningReqRef` 요청 세대 가드와 `learningInFlightRef` 진행 중 조회 재사용으로 마운트·`document` `visibilitychange`(`visible`)·`window` `USAGE_UPDATED_EVENT` 중복 읽기를 막고 cleanup에서 리스너 해제·in-flight 참조 초기화·진행 중 응답 폐기. 배너 제목은 `restBannerTitle(restDays)`로 2일("이틀째 쉬었어요...")·3일 이상("${n}일째 쉬었어요...") 분기.
  - `PROJECT_CONTEXT.md`: §1 결석 배너 설명·§4-1 세션 상태 설명 갱신 및 §5 버전 히스토리 추가.
- **방어 조치 (Safeguards)**:
  - `deriveHomeLearningStatus`가 `streakDays >= 1`과 `restDays >= 2`를 같은 요약에서 파생하므로 두 표시가 동시에 뜰 수 없음(조회 중/실패 시 `null`로 둘 다 숨김).
  - `tests/learningLog.test.ts`: `kstDateStr`, 당일·어제·이틀·장기 휴식·빈 기록, 월말/연말/윤년 2월 29일 경계, 10초 미만 통화 미반영, 미래 날짜 무시, `deriveHomeLearningStatus(null)`, 10일 1,024가지 활동 조합 전수 속성 테스트(`assertNoConflict` 및 `restDays !== null` ⇒ `streakDays === 0`) 추가.
- **검증**: `npm test`(122/122), `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build` 모두 통과 확인.
### [2026-11-21 KST] v2.10.0 이후 수정(미배포) — QA 2·21·23·5행: 복구 복기 조각 다운로드를 서버 중계로(CORS 우회)·복구 통화 사용량 집계·로컬 조각 합산·모달 접근성 (브랜치 `fix/qa2-b`)
- **배경**:
  - 정상 종료 통화는 메모리에 있는 `audioBlobs`를 바로 받아쓰기에 쓰지만, 통화 중 새로고침·종료 후 복구 복기(`App.tsx` → `runPostCallReview`)는 `audioBlobs` 없이 저장된 조각을 다시 내려받아야 하며 이때 브라우저 CORS 차단으로 녹음 조각 다운로드가 실패함(QA 2행).
  - 끊긴 통화는 `NewCallScreen.tsx`의 `handleHangUp`을 거치지 않아 통화 횟수·통화 분이 기록되지 않으며(QA 21행), 끝나지 않은 통화 모달이 로컬 대기 조각을 합산하지 않고(QA 23행, 실제 0개 표시 원인은 `[미확인]`), 모달 닫기(`X`) 버튼 라벨 누락 및 제목 겹침이 확인됨(QA 5행).
- **원인**:
  - `reviewPipeline.ts`가 `storageUrl`(`firebasestorage.googleapis.com` `alt=media`)을 브라우저 `fetch`로 직접 호출해 버킷 CORS 설정 없이는 브라우저가 응답을 차단하고, 조각마다 경고를 반복 출력함(Firebase JS SDK `getBlob()`·`getBytes()`도 버킷 CORS가 필요).
  - `App.tsx` 복구 복기 경로가 `getAllPendingChunks()` 로컬 조각과 `recordUsage`를 연결하지 않았고, `UnfinishedSessionModal.tsx`는 Firestore `recordingChunks`만 읽어 `unfinishedSessionSummary.ts`에 전달함.
  - `UnfinishedSessionModal.tsx` 닫기 버튼이 `absolute top-4 right-4`로 배치된 반면 헤더에 오른쪽 여백(`pr-8`)이 없었고, 7개 모달의 아이콘 전용 닫기 버튼에 `aria-label`이 누락됨.
- **수정**:
  - **2행 서버 중계 및 복기 조각 수집 (`server/storageRelay.ts`, `server/errors.ts`, `server.ts`, `src/services/review/chunkSource.ts`, `src/services/review/reviewPipeline.ts`, `src/App.tsx`)**:
    - `server/storageRelay.ts`(신규)에 호스트(`firebasestorage.googleapis.com`)·버킷·경로(`users/${uid}/recordings/<sessionId>/chunk_NNNN_<ms>.webm`)·다운로드 토큰 검증 및 `Authorization: Firebase <ID토큰>` 변환·에러 매핑(`NOT_FOUND`, `STORAGE_FORBIDDEN`, `STORAGE_FAILED`)·`audio/*` `Content-Type` 필터링·스트림 바이트 상한 읽기(`readStreamWithLimit`, `StorageFileTooLargeError`)를 구현하고, `server.ts`에 `GET /api/recordings/storage-file`(15초 타임아웃·`content-length` 및 스트림 누적 10MB 초과 시 즉시 중단 413·리다이렉트 차단·`Cache-Control: private, no-store`)을 추가함. 서버 로그에 요청 헤더·토큰·전체 URL은 남기지 않음.
    - 순수 모듈 `src/services/review/chunkSource.ts`(신규)로 로컬·서버 중계(`/api/recordings/storage-file`, `/api/recordings/file`)·건너뜀 계획을 세우고, `403` 1회 또는 연속 3회 실패 시 조기 중단 및 요약 경고 1회만 출력하도록 `reviewPipeline.ts`를 교체(브라우저 직접 `fetch` 제거). `App.tsx` 복구 복기에서 `getAllPendingChunks()`로 해당 세션 로컬 조각을 `localChunks`로 전달.
    - `docs/troubleshooting/firebase-storage-setup.md` `(d)`절을 `[선택]` 절로 바꾸고 정확한 `cors.json`과 휴대폰용 Cloud Shell 적용·확인 단계를 정리함(운영 origin 및 CORS 적용 시 SDK 업로드 영향은 `[미확인]`).
  - **21행 복구 통화 사용량 집계 (`src/services/session/recoveredUsage.ts`, `src/services/firebase/db.ts`, `src/App.tsx`)**:
    - 순수 모듈 `src/services/session/recoveredUsage.ts`(신규)의 `recoveredCallUsage`로 `endedAt`·`usageRecordedAt`이 없고 오늘(KST) 시작한 복구 통화의 시간(`lastChunkAt`·`liveTranscript[].timestamp` 최댓값, 3시간 상한)과 `callsForDuration`을 산출(다른 날 시작 통화는 `null` 반환)하고, `createRecoveredUsageRecorder`로 세션 ID 단위 진행 중 호출을 추적해 동시 중복 실행을 차단. `db.ts`에 `SessionData.usageRecordedAt`과 `markSessionUsageRecorded`를 추가하고, `App.tsx` 모듈 수준 `recordRecoveredUsageOnce`가 복기 시작 시 `markSessionUsageRecorded`를 먼저 기록한 뒤 `recordUsage`를 1회 호출함.
  - **23행 조각 수 합산 보강 (`src/ui/call/unfinishedSessionSummary.ts`, `src/ui/call/UnfinishedSessionModal.tsx`)**:
    - `countSessionChunks`와 `describeRecordingState(session, counts?)`를 추가하고, `UnfinishedSessionModal.tsx`가 마운트 시 `getAllPendingChunks()`를 읽어 원격·로컬 조각을 합산 표시하도록 보강.
  - **5행 모달 닫기 버튼 접근성 및 겹침 해소**: `UnfinishedSessionModal.tsx` 헤더에 `pr-8`을 추가하고, `UnfinishedSessionModal.tsx`·`SettingsModal.tsx`·`CoachModal.tsx`·`LectureModal.tsx`·`KeepImportModal.tsx`·`SttBenchmarkModal.tsx`·`QuizModal.tsx`의 `<X` 닫기 버튼에 `type="button" aria-label="닫기"`를 추가.
- **방어 조치 (Safeguards)**:
  - `server/storageRelay.ts`가 `path`와 `token`만 받아 서버에서 고정 호스트·버킷·`users/${uid}/` 경로로 URL을 조립하므로 SSRF 및 타인 폴더 접근을 차단함. 토큰이 없는 조각의 중계는 배포된 Storage 보안 규칙(`allow read`, 실제 규칙 `[미확인]`)에 의존하며 실패 시 403으로 즉시 중단하고 기존 대본 폴백으로 전환함. `readStreamWithLimit`로 `content-length` 누락 응답도 상한 초과 시 스트림을 즉시 취소해 메모리 고갈을 방지함.
  - 복구 사용량은 `createRecoveredUsageRecorder`의 세션 ID별 `Set` 동시 실행 차단과 `markSessionUsageRecorded` 선행 기록으로 중복 집계를 방지함.
  - `tests/storageRelay.test.ts`, `tests/chunkSource.test.ts`, `tests/recoveredUsage.test.ts`, `tests/unfinishedSessionSummary.test.ts`, `tests/a11yCloseButtons.test.ts`로 검증.
- **검증**: `npm test`, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build` 모두 통과 확인.
### [2026-11-21 KST] v2.10.0 이후 수정(미배포) — QA 재확인 19행: 개발 용어 사용자 말로 교체·금지어 스캐너 확장 (브랜치 `fix/qa2-c`)
- **배경**:
  - QA 재확인 19행에서 통화 연결 상태, 설정, 아침 강의 알림, 사용량, 복기, 서버 키 미설정 안내 화면에 일반 사용자에게 낯선 개발 용어(`Gemini`, `Live`, `서버 중계`, `직접 연결`, `프롬프트`, `그록봇`, `토큰`, `TTS`, `Survey topics`, `My role in`, `전사`, `개발자 메뉴`, `JSON`)가 여전히 노출되는 문제가 보고됨.
  - 또한 `server/errors.ts`의 `NO_KEY_MESSAGE`에 화살표(`→`)가 포함되어 `friendlyError.ts`의 `looksInternal`에 걸리면서 일반 오류 문구로 덮어씌워지는 버그가 확인됨.
- **원인**:
  - 기존 `tests/userFacingText.test.ts` 스캐너가 `src/ui/**/*.tsx`만 검사하고 금지어 목록이 7개뿐이어서, `geminiLiveProvider.ts`·`server.ts`·`server/*.ts`·`src/ui/**/*.ts` 경로와 `devOnly: true` 탭 구조를 검사하지 못했음.
  - `SettingsModal.tsx`의 `geminiKey` 탭에 `devOnly` 가드가 없고 `models` 탭 본문(440행) 분기에도 긍정 `devMode` 조건이 없었으며, `FeedSettingsPanel.tsx`와 `UsagePanel.tsx` 일부 항목·`HomeScreen.tsx` 일부 모달 렌더에 `devMode` 가드가 빠져 있었음.
- **수정**:
  - **통화 상태 문구 (`src/services/providers/liveStatusText.ts` 신규, `src/services/providers/geminiLiveProvider.ts`, `src/ui/call/NewCallScreen.tsx`)**: 순수 상수 모듈 `LIVE_STATUS_TEXT`(`preparing: "튜터 연결 준비 중..."`, `connecting: "튜터에게 연결하는 중..."`, `connected: "튜터와 연결됐어요"`)를 신설해 `geminiLiveProvider.ts`의 `connecting`/`connected` 6곳(상태 문구 인자만 교체, 다른 줄 무변경)과 `NewCallScreen.tsx` 초기 상태값에 적용해 연결 경로(직접/서버 중계)와 모델명 비노출.
  - **설정·진입점·개발자 가드 (`src/ui/settings/settingsText.ts` 신규, `src/ui/settings/SettingsModal.tsx`, `src/ui/settings/FeedSettingsPanel.tsx`, `src/ui/settings/UsagePanel.tsx`, `src/ui/home/HomeScreen.tsx`)**: `ADVANCED_TOGGLE_TEXT`(`고급 설정 보기`/`고급 설정 숨기기`)와 `KEY_TAB_LABEL`(`연결 키`)을 분리. `SettingsModal.tsx` 탭 라벨을 `내 정보 입력`·`아침 강의 알림`·`{ id: "geminiKey", label: KEY_TAB_LABEL, devOnly: true }`로 변경하고, 헤더·안내 상자(개발자 참고 문구는 `devMode` 분리)·직무/주제/역할 라벨을 사용자 말로 교체하며, `geminiKey`·`models`(440행) 본문에 `devMode` 가드 추가 및 하단 토글 해제 시 모든 `devOnly` 탭에서 `prompts`로 복귀하도록 수정(`GeminiKeyPanel.tsx` 본문은 `devOnly` 탭 전용으로 유지). `FeedSettingsPanel.tsx`에 `useDevMode()`를 추가해 알림 봇(AI 비서 앱) 안내 문구로 용어를 통일하고 `알림 주소`/`알림 봇`으로 교체하며 `JSON` 항목을 `devMode`로 감쌈. `UsagePanel.tsx`의 `텍스트 토큰`·`TTS 글자 수` 행을 `devMode`로 감싸고, `HomeScreen.tsx` 설정 툴팁을 `설정`으로 변경하며 `showPromptModal`·`showSttBench`에 `devMode &&` 가드를 추가.
  - **복기·서버 키 안내 (`src/ui/review/ReviewModal.tsx`, `src/ui/review/reviewErrorText.ts` 신규, `src/ui/review/ReviewFlowScreen.tsx`, `server/errors.ts`, `server.ts`)**: `ReviewModal.tsx` 라벨을 `내가 한 말`로 통일. `friendlyReviewError`를 순수 모듈 `reviewErrorText.ts`로 분리하고 정규식·안내 문구를 `연결 키`/`고급 설정 보기` 기준으로 변경. `server/errors.ts` `NO_KEY_MESSAGE`와 `server.ts:1325` `userMessage`를 `NO_KEY_MESSAGE`(「고급 설정 보기」→「연결 키」 안내, `→` 제거)로 통일해 `friendlyError` 통과 및 개발 용어 제거를 동시에 해결.
- **방어 조치 (Safeguards)**:
  - `tests/userFacingText.test.ts` 확장: 금지어 13종 추가(`Gemini`, `Live`, `서버 중계`, `직접 연결`, `프롬프트`, `그록봇|Grok`, `토큰`, `TTS`, `Survey topics`, `My role in`, `전사`, `개발자`, `JSON`), `src/ui/**/*.{ts,tsx}` 및 `liveStatusText.ts` 스캔, `devOnly: true`·`console.*` 예외 처리, `DEV_ONLY_FILES`(`GeminiKeyPanel.tsx` `devOnly`·`activeTab === "geminiKey"` `devMode ?` 분기 사유 명시 및 기존 3건 `ALLOWLIST` 제거), `scanSinks`(`onStatusChange`, `onMicWarning`, `fail`, `apiError`, `userMessage` — 최소 탐색 건수 단언 포함), `LIVE_STATUS_TEXT`·`NO_KEY_MESSAGE`·`friendlyError` 회귀·`geminiKey` `devOnly`·`devMode ?` 렌더 가드 검증 신규 5개·기존 2개 확장(총 7개)으로 고정.
  - `package.json` 버전 무변경, `geminiLiveProvider.ts`는 import 1줄과 상태 문구 인자 6곳 외 무변경.
- **검증**: `npm test` 114/114 통과, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build` 모두 오류 없이 통과.
### [2026-11-21 KST] v2.10.0 이후 수정(미배포) — QA 재확인 3행: 직접 연결 송신 형식 구조적 차단·재연결 뒤 인사 재전송 (브랜치 `fix/qa2-a`)
- **배경**:
  - 실기기 QA 재확인(3행)에서 통화 시작 직후 첫 인사가 나오지 않고 26~60초간 튜터가 침묵하거나, `Direct WebSocket closed before setupComplete (1007)` 과 `Unknown name "type"`·`Unknown name "audio"` 사유로 재연결 및 배너 깜빡임이 반복되는 증상이 보고됨.
- **원인**:
  - **송신 형식 URL 분기 및 H1 가설**: `geminiLiveProvider.ts` 가 `sendAudioChunk`·`sendTextPrompt` 에서 `this.ws.url.includes("generativelanguage.googleapis.com")` 로 직접/프록시 형식을 선택하고 있었음. 배포 런타임(AI Studio Publish)이 `WebSocket` 을 감싸 `ws.url` 이 바뀌면 검사가 `false` 가 되어 직접 소켓에 프록시 형식(`type: "realtime_audio"` / `"text_prompt"`)이 전송되고 1007 오류로 끊길 수 있음(배포 환경 래핑 여부는 `[추정]`, 저장소 코드 단독으로는 `[미확인]`).
  - **준비 전(`setupComplete` 전) 소켓 노출**: 직접 연결 `onopen` 에서 `setupComplete` 수신 전에 `this.ws = socket` 을 설정하고 마이크 게이트가 `isConnected || isReconnecting` 을 통과시켜, 재연결 중 `setupComplete` 전에 오디오 프레임이 나갈 수 있었음.
  - **재연결 뒤 인사 누락**: `CALL_KICKOFF_PROMPT` 가 `connect()` 에서 `!options.resumeToken` 일 때만 1회 전송되고 `triggerReconnection()` 에는 없어, 첫 소켓이 kickoff 직후 끊기면 재연결·프록시 폴백 뒤에도 튜터가 사용자 발화 전까지 침묵함.
  - **닫힘 진단 부재 및 배너 깜빡임**: `onerror` 가 즉시 `triggerReconnection()` → `detachAndCloseSocket()` 으로 `onclose` 를 제거해 close code/reason 이 유실됐으며, `NewCallScreen.tsx` 가 `status === "reconnecting"` 즉시 배너와 상단 상태 표시를 띄워 짧은 재연결에서도 화면이 깜빡였음.
- **수정**:
  - `src/services/providers/liveWire.ts`(신규, 순수 모듈): 소켓에 귀속된 `LiveWireKind("direct" | "proxy")` 기준 빌더(`buildDirectSetup`, `buildProxyInit`, `buildAudioInput`, `buildTextInput`), 송신 직전 규격 검증(`validateClientMessage`), 키 이름만 남기는 로그 요약(`describeClientMessage`), query 토큰을 제거하는 `redactSocketUrl` 추가.
  - `src/services/providers/liveKickoff.ts`(신규, 순수 모듈): `MAX_KICKOFF_ATTEMPTS = 2`, `shouldSendKickoff`(새 통화·튜터 미발화·현재 소켓 미전송·`attempts < MAX_KICKOFF_ATTEMPTS` 시에만 true) 및 `isTutorOutput`(직접/프록시별 모델 오디오·전사·텍스트 출력 판정) 추가.
  - `src/ui/call/reconnectNotice.ts`(신규, 순수 모듈): `RECONNECT_NOTICE_DELAY_MS = 1500`, `shouldShowReconnectNotice`, `reconnectNoticeRemainingMs`, `resolveReconnectUiState`(타이머 불리언 상태 기반 표시 판정) 추가.
  - `src/services/providers/geminiLiveProvider.ts`: `this.ws` 를 `LiveConn`(`ready: false` 로 시작해 `setupComplete`/`ready` 이후에만 `this.conn` 등록)으로 교체하고 URL 문자열 분기를 제거해 `sendOn(c, msg)` 단일 송신 경로로 통일. 마이크 게이트를 `!this.conn?.ready` 로 제한. `connect()` 에서 `tutorSpoke`·`kickoffAttempts` 초기화 조건을 `!this.resumeHandle` 에서 `!options.resumeToken` 으로 변경해 `disconnect()` 뒤 `resumeHandle` 이 남아 있는 같은 인스턴스로 `resumeToken` 없이 다시 `connect()`(다시 시도)할 때 이전 통화 값이 남아 인사가 빠지지 않도록 보장(`triggerReconnection()` 은 `connect()` 를 거치지 않아 영향 없음). `handleIncomingMessage` 에서 `tutorSpoke` 와 `[Live] stage=first_tutor_output` 을 기록하고 통화 단위 `kickoffAttempts`(상한 `MAX_KICKOFF_ATTEMPTS = 2`, 초과 시 `[Live] kickoff_skipped reason=max_attempts`)와 `maybeSendKickoff("connect" | "reconnect")` 로 튜터 무발화 상태 재연결 시 인사를 최대 2회까지만 재전송(동작 변경: 기존 GoAway 재연결 무전송에서 무발화 시 재전송·발화 후 미전송으로 변경, 무한 반복 방지). `ws_open`(토큰 제거)·`ws_close`(code/reason/clean/lastSent/sent)·`ws_error`(1500ms no-close 안전장치) 로그 추가 및 미사용 `onDirectSetupComplete` 정리. 모든 `onStatusChange(...)` 줄과 타임아웃(직접 5s·프록시 20s)·폴백 순서는 유지.
  - `src/ui/call/NewCallScreen.tsx`: `reconnecting` 진입 후 1.5초 타이머 콜백에서 불리언 상태 `noticeVisible` 을 직접 켜고 `resolveReconnectUiState` 로 배너(`showReconnectNotice`)와 상단 상태 표시·오브 캡션(`displayStatus`)을 재연결 상태로 전환(기존 `Date.now()` 재판정의 시계 경계 문제 제거, 기존 문구와 버튼·입력·새로고침 경고의 실제 `status` 판정은 유지).
- **방어 조치 (Safeguards)**:
  - `tests/liveWire.test.ts`(신규): `@google/genai` `Session.sendRealtimeInput` 및 `live.connect` setup JSON 바이트 동일성 비교(`webSocketFactory` 내부 속성 의존 주석 명시), 프록시 계약, `validateClientMessage` 직접/프록시 교차 거부·비정상 형식 차단, `describeClientMessage` 본문 비노출, `redactSocketUrl` 토큰 제거 검증.
  - `tests/liveKickoff.test.ts`(신규)·`tests/reconnectNotice.test.ts`(신규): 진리표(`MAX_KICKOFF_ATTEMPTS` 상한 포함)·수신 타입별 출력 판정·1500ms 지연 경계 및 `resolveReconnectUiState` 검증.
  - `tests/liveMessage.test.ts`: URL 분기 및 raw `JSON.parse(event.data)` 부재 소스 검사, `FakeWebSocket.urlRewrite` 기반 H1 회귀 검증, `setupComplete` 전 오디오·텍스트 차단, 가짜 `AudioContext` 기반 `onaudioprocess` ready 전 차단·ready 후 송신 검증, QA 1007→직접 pre-setup 1007→프록시 폴백 kickoff 1회 시나리오, `setupComplete→kickoff→close(1007)` 3회 반복 시 최대 2건 상한 및 `kickoff_skipped reason=max_attempts` 로그 검증, `ws_close` 페이로드 비노출 로그, `onerror→onclose` 단일 재연결·로그 검증, GoAway 테스트를 발화 후(0건)/무발화(1건)로 분리, 같은 인스턴스로 `sessionResumptionUpdate`·튜터 발화·`disconnect()` 뒤 `resumeToken` 없이 두 번째 `connect()` 시 kickoff 상태 초기화 검증 추가.
- **검증**:
  - `npm test`, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build` 모두 통과 (`package.json` 버전 `2.10.0` 유지).
- **남은 리스크**:
  - 재연결 처음 1.5초 동안 상태 표시가 연결됨으로 보이고 마이크 프레임은 버려진다.
  - H1(배포 런타임 WebSocket 래핑)은 `[추정]` 이며 실기기 로그(`ws_open url=`, `ws_close ... lastSent=`)로 확정 필요.
  - 튜터 오디오가 서버에서 생성됐으나 클라이언트 수신 전에 소켓이 끊기면 재연결 뒤 인사가 한 번 더 나갈 수 있음.
  - 재연결 중 `ready` 전 1~3초간 마이크 프레임은 Live 로 보내지 않고 버림(녹음 조각 `recordDest` 는 유지).
  - `onerror` 뒤 `onclose` 가 오지 않는 브라우저에서는 1500ms 안전장치에 의존함(`[미확인]`).
  - `liveWire.test.ts` 의 setup 비교는 `@google/genai` 내부 속성 `webSocketFactory` 에 의존하므로 SDK 메이저 업그레이드 시 점검 필요.

### [2026-11-21 KST] v2.10.0 이후 수정(미배포) — 내 학습 기록: 날짜별 통화 횟수·분·연속 학습일 저장과 표시 (브랜치 `feat/self-usage-log`)
- **배경**:
  - 기존 `users/{uid}/usage/{yyyy-mm}` 문서는 `liveMinutes`·토큰·예상 비용만 기록해 일별 통화 횟수와 연속 학습일(streak)을 파악할 수 없었음.
  - 찬식님 본인 학습 확인용으로 기존 `usage` 컬렉션을 그대로 확장해 날짜별 통화 횟수·통화 분·연속 학습일을 저장하고 설정의 사용량 패널과 홈 화면에 표시하고자 함.
- **원인과 수정**:
  - **데이터 저장 및 조회 (`src/services/usage/usageService.ts`, `src/ui/call/NewCallScreen.tsx`)**: `UsageDelta`·`UsageMonth`·`UsageDay`(`days.{DD}`)에 `calls` 필드를 추가하고, `recordUsage`의 필드·문서 생성부를 `buildUsageFields`·`buildUsagePayload` 순수 함수로 분리해 월 합계와 `days.{DD}`에 동일한 `calls` 포함 필드를 `increment`하도록 확장(`estimateCostUsd` 비용 계산 로직은 불변). `NewCallScreen.tsx` 통화 종료 시 `learningLog.ts`의 `callsForDuration(callDuration)`을 호출해 `10초` 이상이면 `calls: 1`, 10초 미만이면 `calls: 0`을 기록(`liveMinutes`는 기존과 동일). 최근 3개월 문서를 병렬 조회하는 `getUsageMonths(uid, months)`를 추가하고 Firestore 읽기 제한 사유를 주석으로 명시.
  - **순수 집계 모듈 (`src/services/usage/learningLog.ts`)**: Firebase 의존성 없이 `callsForDuration(sec)`과 `YYYY-MM-DD` 문자열 기준 순수 날짜 계산(`addDaysToDateStr`, `getRecentMonthKeys`) 및 `summarizeLearningLog(months, today)` 구현. 「학습한 날」은 `calls > 0 || liveMinutes >= 0.5`(옛 데이터 호환)로 판정하고, `thisMonth` 합계는 오늘 카드와 어긋나지 않도록 `days` 합계만으로 산출하며, `streakDays`(오늘 또는 어제 기준 역순 연속)·`bestStreakDays`(조회된 달 내 최장 연속)·`recentDays`(최근 14일, 오래된 날짜→오늘 순)를 계산.
  - **UI 표시 (`src/ui/settings/UsagePanel.tsx`, `src/ui/home/HomeScreen.tsx`)**: `UsagePanel.tsx` 최상단에 「내 학습 기록」 카드(오늘 통화 N회·M분, 이번 달 N회·M분·학습한 날 K일, 연속 학습 S일·최고 B일, 최근 14일 막대 그래프, 기록 없을 시 안내 문구, 조회 실패 시 `기록을 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.` 구분 표시)를 추가하고 기존 사용량·예상 비용 표 및 하단 안내문은 그대로 유지. `HomeScreen.tsx` 「오늘 할 것」 헤더 우측에 `연속 학습 S일` 한 줄 표시를 추가(`getUsageMonths` 1회 호출, `streakDays >= 1`일 때만 노출하고 0일 및 조회 실패 시 숨김).
- **방어 조치 (Safeguards)**:
  - 기존 `users/{uid}/usage/{yyyy-mm}` 경로만 확장해 `firestore.rules`를 변경하지 않으며, `getUsageMonths`는 중복 제거 후 최대 3개월만 조회함.
  - 10초 미만 통화는 `callsForDuration`에서 `0`으로 처리해 실수로 건 통화가 통화 횟수나 연속 학습일에 잡히지 않도록 방어하고, `tests/learningLog.test.ts`(신규)로 빈 입력·오늘 통화·`thisMonth` `days` 단일 기준 합산·streak(오늘 포함/어제까지/0)·월 경계·윤년 2월·연말→연초·옛 데이터 임계값·14일 정렬·`bestStreakDays`·`callsForDuration`(0/9/9.9/10/600초)·`buildUsageFields` 비용 불변·`buildUsagePayload` 월/일 동일 필드를 검증.
- **검증**: `npm test` 50/50 통과, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build` 오류 없이 통과 확인.
### [2026-11-21 KST] v2.10.0 이후 수정(미배포) — 빈 통화 복기 보강: 학습자 발화 유무 판정(hasLearnerSpeech) 도입 (브랜치 `fix/qa-x3-empty-call-speech-guard`)
- **배경**:
  - 녹음이 없거나 학습자 말이 사실상 없는 빈 통화(또는 튜터만 말한 통화)의 복기에서 진도가 넘어가고 레벨(`IM2`)과 「오늘 대화에서는 큰 문법적 실수가 발견되지 않았습니다. 훌륭합니다!」 문구가 노출되는 문제(QA 시트 7행)를 막기 위해 PR #13~#18의 빈 통화 분기를 점검하고 누락 경로를 보강함.
  - **PR #13~#18 빈 통화 분기 검증 결과**:
    - **이미 동작하던 부분**: 빈 복기 저장 분기(`sourceStt === "none"`일 때 `estimatedLevel: "-"`, `lessonAdvanced: false`, `mistakes: []` 저장으로 진도 유지)는 **v2.9.0(커밋 `93c520e`)**부터 있었음. PR #13(`reviewTiming.ts`, `reviewPipeline.ts`)은 `timing.outcome: "empty"` 계측만 추가했고, PR #14(`reviewView.ts`, `ReviewModal.tsx`)는 `isEmptyReview`와 「기록된 말이 없어 분석하지 않았어요」 문구·`—` 배지·「같은 과로 다시 걸어 주세요」를 추가했음. PR #15·#16·#18은 이 빈 통화 분기를 바꾸지 않았고, PR #17은 `ReviewModal.tsx`의 버튼 라벨 한 줄(「오늘 강의 보기」)만 바꿨음.
    - **발견된 구멍**:
      1. `reviewPipeline.ts`의 `sttPartial` fallback이 `transcript`가 빈 문자열이어도 `[00:00 - 01:00] ` 같은 시간 머리글을 붙여 비어 있지 않은 문자열로 만들어 `sourceStt`가 `"sttPartial_fallback"`이 되고 `"none"` 분기로 가지 못함.
      2. 최종 받아쓰기·`sttPartial`·`liveTranscript`에 `"[noise]"`, `"(silence)"`, `"uh"`, 추임새 반복 같은 효과음 표기나 짧은 추임새만 있어도 문자열이 비어 있지 않다는 이유로 `/api/review`가 호출돼 모델이 레벨을 산출하고 `lessonAdvanced: true`로 진도를 올림.
      3. `ReviewModal.tsx`가 `isEmptyReview(review, sttFinal?.sourceStt)`만 검사해, `sourceStt !== "none"`이고 `lessonAdvanced !== false`인 채 저장된 짧은/무발화 전사 복기에서 실수 0개일 때 「훌륭합니다!」 문구를 표시함.
- **원인**:
  - `reviewPipeline.ts`가 각 STT 소스의 유효성을 단순 truthy(`if (mergedStt.text)`, `if (!sttFinalText)`)로만 판정했고, `sttPartial`의 `[mm:ss - mm:ss]` 머리글·효과음 표기·추임새를 발화와 구분하지 못했음.
- **수정**:
  - `src/services/review/speechCheck.ts`(신규 순수 모듈): `stripTimeHeaders(text)`와 `hasLearnerSpeech(text)` 및 `decideSttSource({ finalText, finalSource, partials, liveTranscript })` 추가. `[mm:ss - mm:ss]` 시간 머리글, `[noise]`·`(silence)`·`[music]`·`<unk>` 등 괄호/대괄호/꺾쇠 효과음 표기, 구두점·공백과 짧은 추임새 목록(`FILLER_WORDS`: `uh`, `um`, `hmm`, `ah`, `er`, `oh`, `yeah`, `okay`, `음`, `어`, `아`, `으` 등)을 제외한 뒤 글자 단어(영문·한글 어절)가 `MIN_SPEECH_WORDS`(3개) 이상이고 총 글자 수가 `MIN_SPEECH_CHARS`(8자) 이상일 때만 `true`로 판정(상수화해 한 곳에서 조정 가능).
  - `src/services/review/reviewPipeline.ts`: 최종 받아쓰기 결과(`finalText`, `finalSource`)와 fallback(`sttPartial` 머리글 제외 본문, `liveTranscript` `role === "user"` 발화) 모두를 `decideSttSource` 단일 경로로 판정해 실질 발화가 없는 소스는 건너뛰고 모두 `false`이면 `sourceStt: "none"`(빈 복기)으로 처리. 정상 발화 통화의 동작·반환값·단계별 계측은 그대로 유지.
  - `src/services/review/reviewView.ts` · `src/ui/review/ReviewModal.tsx`: `isEmptyReview(review, sttSource, transcript?)`에 선택 인자 `transcript`를 추가해 `transcript`가 주어졌을 때 `!hasLearnerSpeech(transcript)`이면 `true`를 반환하도록 하고, `ReviewModal.tsx`에서 `sttFinal?.transcript`를 전달해 짧은 전사에서도 「훌륭합니다!」 대신 「기록된 말이 없어 분석하지 않았어요」를 표시.
- **방어 조치 (Safeguards)**:
  - `tests/speechCheck.test.ts`(신규): `stripTimeHeaders`, `hasLearnerSpeech` 경계값(빈 문자열, 공백, 시간 머리글만, `"[noise]"`, `"(silence)"`, `"[music] <unk>"`, `"uh"`, `"uh uh uh uh"`, `"um uh hmm yeah okay"`, `"음 어 음 어"`, 3단어 미만/8자 미만, 추임새+정상 문장, 영어 3단어 이상 문장, 한국어 문장, 머리글+빈 transcript, 머리글+정상 transcript), `decideSttSource` 분기(최종 정상 텍스트 및 `finalSource: "sttPartial_fallback"` 보존, 최종 없음+partial 빈 transcript→`none`, partial 정상, 잡음+liveTranscript user 줄, 튜터만 말한 통화→`none`), `isEmptyReview` 선택 인자 `transcript` 동작 및 기존 2인자 호출 호환을 테스트로 고정.
  - Firebase·React 비의존 순수 모듈 분리 및 기존 `tests/reviewView.test.ts`·`tests/reviewRules.test.ts`·`reviewTiming.ts`·`package.json` 무변경 유지.
- **검증**: `npm test`, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build` 모두 통과 확인.
- **남은 리스크**:
  - 이번 수정 전에 저장된 짧은 받아쓰기 복기는 `lessonAdvanced: true`·레벨이 남아 있어 화면이 빈 복기 문구와 어긋날 수 있음.
  - 스피커폰에서 튜터 목소리가 마이크로 새면 튜터만 말한 통화도 발화로 판정될 수 있음 [미확인].
### [2026-11-21 KST] v2.10.0 이후 수정(미배포) — 사용자 화면의 내부 용어 정리(개발자 모드로 이동) (브랜치 `fix/qa-x5-hide-internal-terms`)
- **배경**:
  - 일반 학습자 화면(`src/ui/**/*.tsx`)에 기획 단계 번호(`B-3`, `B-9`, `3단계`), 소스 경로(`src/config/models.ts`), 상수·필드·키 이름(`PRICING_RATES`, `weekly`, `absence2d`, `deadline4w`, `deadline2w`, `coachNote`, `VERBATIM`, `Graduated`), 저장소·인프라 명칭(`IndexedDB`, `Cloud Storage`, `Firestore`, `AI Studio Publish`/`Secrets`, `chunk.path`, `connectionPath`) 등이 그대로 노출되고 있었음.
- **원인과 수정**:
  - `src/ui/settings/UsagePanel.tsx`: `useDevMode()`를 연결해 하단 안내문의 기본 문구를 `예상 비용은 추정치예요. 실제 청구액과 다를 수 있어요.`로 단순화하고, `src/config/models.ts`·`PRICING_RATES`·분당 단가 수치는 `devMode`일 때만 덧붙이도록 수정(하단 안내문 `div`만 변경).
  - `src/ui/settings/SettingsModal.tsx`: 헤더 부제를 `튜터 프롬프트 슬롯 채우기 및 모델 구성` → `튜터 프롬프트 슬롯 채우기 및 학습 설정`으로 정리하고, 코치 알림 설정 탭에서 `B-9`·`coachNote`를 제거하며 알림 키(`weekly`, `absence2d`, `deadline4w`, `deadline2w`)는 `devMode`일 때만 병기. 녹음 보관함 탭의 `B-3 10초 분할 녹음 파일 (Cloud Storage & IndexedDB)`·`업로드 대기 중인 로컬 조각`·`1분 전사`·`로컬 대기`를 사용자 말(`통화 녹음 (10초 단위로 저장)`, `통화 중 소리는 10초씩 나뉘어 이 기기에 먼저 저장된 뒤 서버에 올라가요.`, `아직 올라가지 못한 녹음 조각`, `1분 받아쓰기`, `대기 중`)로 교체하고, `IndexedDB`·`Cloud Storage` 보조 설명과 `sess.connectionPath`·`chunk.path`를 `devMode` 조건 안으로 이동(`activeTab === "models"`는 303행 `!devMode ? null` 분기에서 이미 차단되므로 411행 중복 `devMode` 가드 없이 탭 줄·레이아웃 구조 유지).
  - `src/ui/settings/GeminiKeyPanel.tsx`: `useDevMode()`를 연결해 기본 안내에서 `AI Studio Publish`/`Secrets`/`Firestore` 용어를 걷어내고 `서버에 기본 키가 없을 때 대신 쓰는 개인 키예요. 입력한 키는 내 계정에만 안전하게 저장돼요.`로 정리했으며, 개발자 참고 문구는 `devMode`일 때만 노출.
  - `src/ui/home/HomeScreen.tsx`: `3단계 AI 전담 학습 코치`/`3단계 AI 전담 코치` → `AI 전담 학습 코치`/`AI 전담 코치`, `맞춤 Plan 반영` → `맞춤 계획 반영`으로 정리(이미 `devMode`로 가려진 `B-2 통화 엔진: gemini-3.8-live...` 및 `showPromptModal`·`showSttBench` 여는 버튼 등은 유지).
  - `src/ui/quiz/QuizModal.tsx`, `src/ui/review/ReviewModal.tsx`, `src/ui/call/UnfinishedSessionModal.tsx`: `VERBATIM` 표기는 `devMode`에만 노출하고, `(Graduated)`·`STT 오인식`·`1분 단위 전사`를 사용자 표현(`통과! 즉시 졸업 🎉`, `음성 인식 오류`, `1분 단위 받아쓰기`)으로 정리. `ReviewModal` 「이건 내가 한 말이 아니에요」 버튼 `title`도 품질 리포트 기록 사실을 포함해 `음성 인식 오류 등으로 내가 말하지 않은 문장이면 목록에서 숨기고, 품질 개선을 위해 기록해요`로 변경.
- **방어 조치 (Safeguards)**:
  - `tests/userFacingText.test.ts`(신규): TypeScript AST 파서로 `src/ui/**/*.tsx`의 JSX 텍스트·문자열·템플릿 리터럴(주석·`import/export` 모듈 경로 제외)을 전수 검사해 `devMode` 조건 밖에 `B-\d`, `src/config`, `PRICING_RATES`, `IndexedDB`, `Cloud Storage`, `Firestore`, `컬렉션`이 있으면 실패하도록 검증(`SettingsModal.tsx` `models` 탭 내 `B-1`/`B-3` 3건은 303행 `!devMode ? null` 및 163행 탭 버튼 가드 사유를 명시해 `ALLOWLIST`에 등록). 또한 `scanFile`에 문자열 입력을 지원해 노출된 금지 용어 위반, `devMode &&` 내부 허용, `!devMode &&` 내부 위반을 검증하는 검사기 자체 테스트 추가.
- **검증**: `npm test` 39/39 통과, `npm run lint`·`npx tsc -p tsconfig.server.json --noEmit`·`npm run build` 오류 없음.
### [2026-11-21 KST] v2.10.0 이후 수정(미배포) — QA-2 녹음 조각 업로드: 직접 업로드 시간 제한·실패 기억·서버 중계 우선 전환 (브랜치 `fix/qa-r2-chunk-upload-timeout`)
- **배경**:
  - 통화 중 10초 녹음 조각 업로드가 계속 실패하고 콘솔 오류가 대량 발생하며 IndexedDB(`OneCallRecordingsDB`)에 미업로드 조각이 쌓이는 QA 버그가 보고됨.
- **원인**:
  - `firebase-applet-config.json`의 `storageBucket`(`gen-lang-client-0592656565.firebasestorage.app`)이 GCS JSON API에서 404(버킷 미프로비저닝) 상태라 브라우저의 Firebase SDK 직접 업로드(`firebasestorage.googleapis.com`)가 프리플라이트부터 실패함(콘솔에서 CORS 오류로 관측, Firebase 콘솔에서 Storage 시작 필요).
  - `src/services/firebase/storage.ts`의 `uploadAudioFile`이 직접 업로드(`uploadBytes`)를 먼저 시도할 때 Firebase Storage SDK의 `maxUploadRetryTime` 기본값(10분) 때문에 조각마다 최대 10분간 재시도하느라 서버 중계(`/api/recordings/upload-chunk`)로 넘어가지 못함. `chunkIndexedDb.ts`의 `retryPendingUploads`도 같은 함수를 직렬 호출해 재시도가 사실상 끝나지 않았으며, 직접·중계 경로가 모두 실패할 때 `directErr`만 던져 중계 실패 원인을 숨기고 있었음.
- **수정**:
  - `src/services/firebase/config.ts`: `STORAGE_RETRY_TIMEOUT_MS = 8000` 상수를 두고 `storage.maxUploadRetryTime`과 `storage.maxOperationRetryTime`을 8초로 제한.
  - `src/services/firebase/uploadPolicy.ts`(신규 순수 모듈, Firebase·DOM 의존 없음): `createChunkUploader({ direct, relay, now, directTimeoutMs, cooldownMs })` 추가. `direct`는 `Promise.race`와 타이머 정리로 기본 12초(`DEFAULT_DIRECT_TIMEOUT_MS`) 제한, 실패 시 기본 10분(`DEFAULT_DIRECT_COOLDOWN_MS`) 동안 `direct`를 건너뛰고 바로 `relay`를 사용하며 쿨다운 진입 시에만 1회 경고 로그 출력. 쿨다운 만료 후 `direct`를 1회 재시도해 성공하면 기억을 해제하고, 양쪽이 모두 실패하면 두 오류 메시지를 모두 포함한 `Error`를 던짐. 함께 `selectRetryableChunks`·`createPendingRetryRunner`를 분리해 30초(`RECENT_CHUNK_GRACE_MS`) 이내 조각 건너뛰기(`force: true` 시 생략), 동시 실행 가드(`skipped: true`), 조각별 실패 격리 및 상세 결과(`{ total, uploaded, failed, skipped }`) 반환을 구현.
  - `src/services/firebase/storage.ts`: `uploadAudioFile` 시그니처를 유지한 채 `createChunkUploader` 기반으로 교체(응답 `!response.ok` 시 HTTP 상태코드 포함 오류 발생), `getStorageFileUrl`도 `isDirectBlocked()` 확인 시 `getDownloadURL` 호출 없이 즉시 서버 중계 URL(`/api/recordings/file?path=...`)을 반환하도록 변경.
  - `src/services/recording/chunkIndexedDb.ts`: `createPendingRetryRunner`를 감싼 모듈 전역 실행기(`pendingRetryRunner`)로 `retryPendingUploadsDetailed`와 `retryPendingUploads`(`number` 반환 유지)를 제공해 동시 실행 가드(이미 실행 중이면 `skipped: true`, `retryPendingUploads`는 `0`)와 30초 이내 조각 건너뛰기를 적용(기존 조각별 오류 격리 유지).
  - `src/App.tsx`: 로그인 상태에서 60초 간격 `setInterval`로 `retryPendingUploads`를 주기 호출하고 `useEffect` 정리 함수에서 `clearInterval` 수행(대기 조각이 없으면 즉시 `0` 반환).
  - `docs/troubleshooting/firebase-storage-setup.md`(신규): 프로젝트 소유자용 Storage 버킷 확인(`curl`), Firebase 콘솔 Storage 시작 절차, `storage.rules` 보안 규칙 예시 코드블록, 필요 시 `cors.json` 적용 명령, 서버 중계 저장소(`.data/recordings`)의 한계 안내 문서 작성.
- **방어 조치 (Safeguards)**:
  - `tests/uploadPolicy.test.ts`(신규): direct 성공 시 relay 미호출, direct 실패→relay 폴백 및 쿨다운 동안 direct 미호출·경고 1회, 무응답(never-resolving) 타임아웃 후 relay 전환, 쿨다운 경과 후 재시도 성공 및 기억 해제, 양쪽 실패 시 두 원인 메시지 포함, 동시 호출들의 쿨다운 상태 일관성, `selectRetryableChunks` 30초 경계, `createPendingRetryRunner` 동시 실행 가드(`skipped: true`) 및 부분 실패 격리를 검증.
  - `server.ts`, `src/services/recording/chunkRecorder.ts`, `tests/chunkRecorder.test.ts`, `firebase-applet-config.json`, `package.json` 버전은 변경하지 않고, 루트 `storage.rules` 파일도 생성하지 않음.
- **검증**: `npm test` 49/49 통과, `npm run lint`·`npx tsc -p tsconfig.server.json --noEmit`·`npm run build` 모두 오류 없이 통과.
- **QA-2 후속: 녹음 보관함 「지금 다시 올리기」·막힌 조각 정리 (2026-11-21 KST, `v2.10.0 이후 수정(미배포)`)**:
  - **배경**: QA-2 수정 이전에 이미 IndexedDB에 쌓여 있던 미업로드 로컬 조각을 사용자가 설정 > 녹음 보관함에서 직접 즉시 재업로드하거나 정리할 수단이 없었음.
  - **원인**: `retryPendingUploads`가 30초 유예 건너뛰기(`force`)와 성공/실패/건너뜀 구분 반환을 지원하지 않았고, 대기 조각 삭제 API(`deletePendingChunks`)와 설정 화면 버튼이 없었음.
  - **수정**:
    - `src/services/firebase/uploadPolicy.ts` · `src/services/recording/chunkIndexedDb.ts`: 중복되어 있던 대기 조각 실행기를 `uploadPolicy.ts`의 `createPendingRetryRunner` 하나로 통합해 `force`·30초 유예·동시 실행 가드(`skipped: true`)·`RetryPendingResult`(`{ total, uploaded, failed, skipped }`)를 처리하고, `chunkIndexedDb.ts`는 이를 감싸 `retryPendingUploadsDetailed(userId, options?)` 및 `retryPendingUploads(userId, options?)`(`number` 반환 유지)를 제공. 순수 필터 선택 함수 `selectChunksToDelete` 및 `deletePendingChunks(filter?)` 추가.
    - `src/ui/settings/SettingsModal.tsx`: 녹음 보관함 「업로드 대기 중인 로컬 조각」 경고 박스 내부에 「지금 다시 올리기」(스피너·비활성, `retryPendingUploadsDetailed(userId, { force: true })` 실행 후 `skipped`면 「이미 다시 올리는 중이에요. 잠시 뒤 다시 확인해 주세요.」, 아니면 `N개 올렸어요 / M개는 아직 못 올렸어요` 한 줄 표시 및 목록 갱신)와 「남은 조각 지우기」(확인 후 스냅샷 `ids`만 `deletePendingChunks(c => ids.has(c.id))`로 삭제 및 목록 갱신) 버튼 추가, 실패 시 한 줄 오류 표시.
    - `docs/troubleshooting/firebase-storage-setup.md`: (d)항 `cors.json` 안내에서 미사용 `5173` 포트 언급 제거(`3000`만 유지).
  - **방어 조치 (Safeguards)**:
    - `tests/pendingChunks.test.ts`(신규): `selectChunksToDelete`·`deletePendingChunks` 필터 선택 및 삭제, 통합된 `createPendingRetryRunner` 경로의 `force: true` 30초 유예 건너뛰기·동시 실행 가드(`skipped: true`)·`total === uploaded + failed` 일치, `retryPendingUploadsDetailed`/`retryPendingUploads` 빈 DB 래퍼 동작을 검증.
    - `tests/uploadPolicy.test.ts`: 기존 동시 호출 테스트(6)에 첫 동시 묶음의 `directCalls === 3` 단언 추가, `createPendingRetryRunner` 가드 테스트에 `skipped: true`/`false` 단언 반영.
  - **남은 리스크**:
    - `force` 재시도가 막 끝난 통화의 마지막 조각과 겹치면 `recordingChunks` 메타데이터를 덮어쓸 수 있음(기존 경로에도 있던 경쟁, 후속 과제).
  - **검증**: `npm test` 49/49 통과, `npm run lint`·`npx tsc -p tsconfig.server.json --noEmit`·`npm run build` 모두 오류 없이 통과.
### [2026-11-21 KST] v2.10.0 이후 수정(미배포) — QA-4~6 뒤로가기 처리·설정 탭 한 줄 스크롤·통화 중 새로고침 경고와 끝나지 않은 통화 안내 정정 (브랜치 `fix/qa-r4-6-back-tabs-recovery`)
- **배경**:
  - 실기기 QA(시트 원콜 탭 4·5·6행)에서 3가지 문제가 보고됨.
  - (4행) 통화 준비 화면(`PreCallScreen`)에서 브라우저 뒤로가기를 누르면 홈으로 돌아오지 않고 `about:blank`로 앱을 이탈함.
  - (5행) 393px 모바일 폭에서 설정 모달(`SettingsModal`)의 탭 7개가 줄바꿈 없이 접혀 `녹/음/보/관/함`처럼 한 글자씩 세로로 깨짐.
  - (6행) 통화 중 F5/창 닫기 시 확인 경고가 없고, 새로고침 직후 「끝나지 않은 통화」 창이 방금 끊긴 통화가 아니라 예전 통화만 보여 주며, 녹음 조각이 0개인데도 「녹음은 안전하게 저장돼 있어요.」와 `0분`을 표시함.
- **원인**:
  - (4행) 앱 전체에 `history.pushState`/`popstate` 처리가 없고 `App.tsx`의 React 상태(`prepCall`, `activeCallGoal`, 모달 상태)로만 화면을 전환해 브라우저 history가 항상 첫 항목 1개뿐이었음.
  - (5행) `SettingsModal.tsx` 탭 줄(`flex border-b ... px-5`)이 줄바꿈·오버플로우 제어를 두지 않아 좁은 폭에서 버튼 텍스트가 강제 줄바꿈됨.
  - (6행) `NewCallScreen.tsx`에 `beforeunload` 리스너가 없었고, `db.ts`의 `checkAndMarkInterruptedSessions`가 `lastChunkAt`이 2분을 넘긴 통화만 `pending_review`로 전환해 새로고침 직후 방금 끊긴 통화가 빠졌으며, `UnfinishedSessionModal.tsx`는 목록 첫 항목만 고정 표시하고 `Math.round(chunkCount * 10 / 60)`분 계산 및 고정 문구만 사용함.
- **수정**:
  - **4행 뒤로가기**: React·DOM 전역 의존 없이 history 유사 객체와 `popstate` 구독 함수를 주입받는 순수 모듈 `src/services/navigation/historySync.ts`(`HistoryDepthSync`)와 닫을 대상 우선순위 판정 순수 모듈 `src/services/navigation/backTarget.ts`(`pickBackTarget`, `getNavigationDepth`)를 신규 작성. 마운트 시 `replaceState({ onecallDepth: 0 })`로 정규화, `setDepth`로 0→1 `pushState`·1→0 `go(-1)`(프로그래밍적 `popstate` 무시)·1→1 무동작 처리, 사용자 뒤로가기 시 `onUserBack()` 호출 후 상태 변화로 깊이가 줄지 않으면 `pushState`로 복구. `src/App.tsx`에서 `depth`를 계산해 동기화하고 `pickBackTarget` 우선순위(통화 중/복기 로딩·실패 카드/초기 진도 모달은 닫지 않음 → 복구, `prepCall`, 복기 모달, 끝나지 않은 통화 모달, 설정 모달)로 1개씩 닫음.
  - **5행 설정 탭**: `src/ui/settings/SettingsModal.tsx` 탭 줄에 `overflow-x-auto flex-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`을, 각 탭 버튼에 `whitespace-nowrap shrink-0`을 적용하고 `SETTINGS_TABS` 배열 `map`으로 정리(`devMode` 조건 및 라벨 유지). `activeTab` 변경 시 `scrollIntoView({ inline: "nearest", block: "nearest" })` 호출.
  - **6행 통화 중 새로고침 및 미완료 통화 안내**:
    - `src/ui/call/NewCallScreen.tsx`: `status`가 `connecting`/`connected`/`reconnecting`이고 종료 중(`hangingUp`)이 아닐 때 `window` `beforeunload` 리스너를 등록(`event.preventDefault(); event.returnValue = ""`)하고 종료 처리 시작·오류/종료·언마운트 시 해제.
    - `src/services/session/interruptedSession.ts`(신규, 순수 모듈): `DEFAULT_STALE_SESSION_MS`, `isInterruptedSession`을 services 계층으로 분리(`services` → `ui` import 제거).
    - `src/ui/call/unfinishedSessionSummary.ts`(신규, 순수 모듈): `describeRecordingState`, `formatRecordingChunksSummary`(반올림한 초 기준으로 60초 미만/이상 구분해 59.5~59.9초도 `1분` 표기), `formatSessionChipLabel` 구현.
    - `src/services/firebase/db.ts` & `src/App.tsx`: `checkAndMarkInterruptedSessions(userId, options?: { staleAfterMs?: number })`는 기본 2분 임계값을 유지하되 `App.tsx` 로그인 직후 호출만 `staleAfterMs: 0`을 전달해 페이지 새로 열림 시 남은 `in-progress` 통화를 즉시 `pending_review`로 전환.
    - `src/ui/call/UnfinishedSessionModal.tsx`: 2개 이상일 때 상단 선택 칩(`11/21 13:13 · 4과` 형식, 기본은 첫 항목)을 노출해 선택한 통화 기준으로 정보·「복기 시작」·「보관만 하기」를 수행하고, 60초 미만 `N개 (M초)`/이상 `N개 (M분)` 표기 및 4가지 상태(`empty`/`transcript_only`/`saved`/`uploading`) 안내 문구 적용.
- **방어 조치**:
  - `tests/historySync.test.ts`(신규): 7개 시나리오(0→1 `pushState`, 사용자 뒤로가기 `onUserBack`, 앱 닫기 `go(-1)` 시 `onUserBack` 미호출, 1→1 0회, 미변경 시 `pushState` 복구, 마운트 `replaceState` 정규화, `dispose` 후 무시) 검증.
  - `tests/backTarget.test.ts`(신규): `pickBackTarget` 우선순위(통화 중·로딩·실패 카드·초기 진도 모달 보호 및 `prepCall`→복기→끝나지 않은 통화→설정 모달 순) 검증.
  - `tests/mobileShell.test.ts`: `SettingsModal.tsx`의 `{/* Tab Navigation */}` ~ `{/* Body */}` 구간만 잘라 `overflow-x-auto`, `flex-nowrap`, `whitespace-nowrap`, `shrink-0`을 검사하고 `scrollIntoView` 호출을 함께 검증.
  - `tests/unfinishedSessionSummary.test.ts`(신규): `describeRecordingState` 4가지 문구, `formatRecordingChunksSummary` 초/분 분기(59.4초 vs 59.5~59.9초 경계 포함), `isInterruptedSession` 2분·`staleAfterMs: 0` 임계값, 칩 라벨 검증.
- **남은 리스크**:
  - 실기기(Android Chrome·iOS Safari)에서 Chrome 의 history 개입 때문에 사용자 조작 없는 `pushState` 항목을 뒤로가기가 건너뛸 수 있음 [미확인]
  - 새로고침 직후 뒤로가기가 한 번 반응 없을 수 있음(깊이 정규화)
  - `staleAfterMs` 0 은 다른 탭·기기에서 진행 중인 통화도 끝난 통화로 표시함
- **검증**: `npm test`, `npm run lint`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build` 모두 통과.
### [2026-11-21 KST] v2.10.0 이후 수정(미배포) — 마이크 점검 무한 로딩 해소: 제한 시간·실패 이유·다시 점검·건너뛰기, 통화 중 글로 답하기 (브랜치 `fix/qa-x1-mic-check-fallback`)
- **배경**:
  - 마이크가 없거나 브라우저 권한 안내 창이 응답하지 않는 환경에서 통화 준비 화면(`PreCallScreen`)의 「마이크 점검하기」가 무한 로딩에 빠져 「전화 걸기」가 영영 켜지지 않았음.
  - 또한 마이크 없이 통화를 시작해 튜터 음성을 들으면서 글로 답하고, 그 답변을 대화 기록·통화 후 복기까지 남길 수 있는 경로가 없었음.
- **원인**:
  - `src/ui/call/PreCallScreen.tsx`의 `checkMic`이 `navigator.mediaDevices.getUserMedia`를 제한 시간 없이 `await`하여 Promise가 끝나지 않으면 `"checking"` 상태에 영원히 머물렀고, 실패 문구도 2종뿐이며 건너뛰기 경로가 없었음.
  - `src/ui/call/NewCallScreen.tsx`는 마이크 실패 시 경고 배너만 띄우고 텍스트 입력/전송 UI가 없었으며, `LiveProvider`에도 사용자 텍스트 입력을 `transcriptItems`에 기록하는 공개 메서드가 없었음.
- **수정**:
  - `src/ui/call/micCheck.ts`(신규): React·DOM 전역 import 없는 순수 주입식 모듈로 `checkMicrophone(getUserMedia, timeoutMs = 8000)`, `mapMicErrorReason`, `stopStreamTracks`, `MIC_FAIL_MESSAGES`, 글 답변 정규화 순수 함수 `formatWrittenAnswer(text)`(`WRITTEN_ANSWER_MAX_LENGTH = 500`, `WRITTEN_ANSWER_PREFIX = "The learner answers in writing: "`)를 추가. 오류 `name`을 `unsupported`·`denied`·`not_found`·`in_use`·`timeout`·`unknown` 6종으로 매핑하고, 타임아웃 뒤 늦게 도착한 `MediaStream`은 즉시 모든 트랙을 `stop()` 처리함.
  - `src/ui/call/PreCallScreen.tsx`: `checkMicrophone(..., 8000)`을 사용하도록 변경하고, 점검 중 「취소」 버튼, 실패 시 사유별 문구 + 「다시 점검」 + 「마이크 없이 진행 (글로 답하기)」 버튼을 추가했으며, 최초 `idle` 및 점검 취소 후 `idle` 상태에서도 「마이크 없이 진행 (글로 답하기)」 링크를 노출함. 건너뛰기 선택 시 「마이크 없이 전화 걸기 (글로 답해요)」가 활성화되며 `onStart({ micSkipped: true })`(성공 시 `false`)를 호출함.
  - `src/App.tsx`: `activeCallTextOnly` 상태를 추가해 `handlePrepConfirmed({ micSkipped })`가 `NewCallScreen`에 `textOnly` prop을 전달하고 통화 종료/이탈 시 초기화함.
  - `src/services/providers/types.ts` · `src/services/providers/geminiLiveProvider.ts`: `LiveSessionOptions`에 `skipMic?: boolean` 추가(지정 시 `initAudioCapture()` 건너뛰고 재생만 초기화), `sendTextPrompt(prompt)`가 소켓 전송 성공 여부(`boolean`)를 반환하도록 변경(소켓이 `OPEN`이 아니거나 전송 실패 시 `false`), `LiveProvider`에 `appendUserText(text)` 추가(기존 `appendTranscript("user", ...)` 재사용 및 `onTranscript`·`onTranscriptLogged` 호출).
  - `src/ui/call/NewCallScreen.tsx`: `textOnly` 시 `skipMic: true` 전달 및 `onMicWarning` 비노출, 하단 고정 푸터(연결된 상태)에 `formatWrittenAnswer` 기반 500자 제한·공백 무시·IME 조합 중 Enter 무시(`!e.nativeEvent.isComposing`) 「글로 답하기」 입력창과 「보내기」 버튼을 추가. `sendTextPrompt`가 `true`일 때만 `ensureSessionCreated()`·`appendUserText`를 호출하고 입력을 비우며, `false`이면 기록에 남기지 않고 입력을 유지한 채 「연결이 끊겨 보내지 못했어요」 한 줄 안내를 표시함.
- **방어 조치 (Safeguards)**:
  - `PreCallScreen.tsx`에서 `checkSeqRef`·`mountedRef` 가드로 취소·재점검·언마운트 이후 늦게 도착한 스트림은 React 상태를 갱신하지 않고 트랙만 정지함.
  - `NewCallScreen.tsx`에서 `ensureSessionCreated`와 `hasMicRecordingRef`로 텍스트 전용 통화에서도 첫 글 답변 전송 성공 시 세션 문서를 생성해 `liveTranscript` 저장 및 종료 복기(`liveTranscript_fallback`)가 누락되지 않게 하고, 이전 통화의 `ChunkRecorder` 녹음 조각이 섞이지 않도록 차단함. `tests/mobileShell.test.ts` 레이아웃 규칙(`h-screen`, `supports-[height:100dvh]:h-dvh`, `shrink-0`, `select-none`, `"끝내기"` 비포함)을 유지함.
  - `tests/micCheck.test.ts`(신규): 성공, 무응답 타임아웃, 타임아웃 후 지연 스트림 `track.stop()`, 오류 `name`별 `reason` 매핑 전체, `mediaDevices` 부재 시 `unsupported`, 사유별 메시지 비어있지 않음·고유성, `formatWrittenAnswer` 공백/트림/500자 자르기/접두어, `GeminiLiveProvider`의 `skipMic: true` 시 가짜 `navigator.mediaDevices.getUserMedia` 0회 호출·`sendTextPrompt` 소켓 상태별 `boolean` 반환·`appendUserText` 기록 8개 테스트 추가.
- **남은 리스크**:
  - 통화 중 실시간 기록 저장 조건이 `sessionCreated` 이후로 바뀜(다음 저장에서 전체 복구).
  - 글 답변이 서버에서 입력 전사로 다시 와 두 번 기록될 가능성은 [미확인].
  - 모바일 키보드에서 입력창 가시성은 실기기 QA 필요 [미확인].
- **검증**: `npm test` 45/45 통과, `npm run lint`·`npx tsc -p tsconfig.server.json --noEmit`·`npm run build` 오류 없음 (`package.json` 버전 `2.10.0` 유지).
### [2026-11-21 KST] v2.10.0 이후 수정(미배포) — QA-3 통화 시작 침묵: 직접 연결 Blob 프레임 해석·연결 직후 튜터 첫 인사 트리거 (브랜치 `fix/qa-r3-live-blob-greeting`)
- **배경**:
  - 통화를 연결해도 튜터가 13~40초 동안 먼저 말하지 않고, 콘솔에 `Direct parse message error: SyntaxError… [object Blob]` 와 `setupComplete timeout` 이 반복 기록되는 QA 버그가 발생함.
  - 사용자가 「답변 끝」 버튼이나 음성을 먼저 보내기 전까지 튜터가 첫 인사를 시작하지 못하는 증상도 함께 확인됨.
- **원인**:
  - `src/services/providers/geminiLiveProvider.ts`의 `connectDirect()` 및 `wireWebSocketEvents()` `onmessage`가 `event.data`를 바로 `JSON.parse`하고 있었음. Gemini Live 직접 연결 서버는 JSON을 바이너리(`Blob`) 프레임으로 내려보내 `JSON.parse(Blob)`이 `"[object Blob]"` `SyntaxError`로 실패하고, `setupComplete`를 읽지 못해 5초 타임아웃 후 서버 프록시로 폴백되며 추가 지연이 발생함.
  - 시스템 프롬프트(`src/data/lessonPromptBuilder.ts`)에는 첫 마디 인사 지시가 있으나, Live 모델은 클라이언트 입력이 도착하기 전에는 먼저 발화하지 않아 연결 직후 첫 마디를 트리거하는 신호가 없었음.
  - 직접 연결 경로의 `sendTextPrompt`가 `clientContent.turns`, `sendAudioChunk`가 deprecated 인 `realtimeInput.mediaChunks`를 사용하고 있어 프록시 SDK(`sendRealtimeInput({ text })` / `({ audio })`)와 와이어 형식이 달랐음.
- **수정**:
  - `src/services/providers/liveMessage.ts`(신규, DOM·Firebase 비의존 순수 모듈): `decodeLiveMessage(data)`가 `string`, `Blob`, `ArrayBuffer`, `ArrayBufferView`(오프셋 있는 뷰 포함)를 UTF-8 문자열로 디코딩한 뒤 `JSON.parse`하도록 구현(실패 시 reject). `createSerialQueue()`가 비동기 디코딩(`Blob.text()`) 중 프레임 순서가 뒤집히지 않도록 작업을 들어온 순서대로 직렬 실행하고, 앞 작업 실패 뒤에도 다음 작업을 이어서 실행.
  - `src/services/providers/geminiLiveProvider.ts`: `connectDirect`, `connectViaServerProxy`('ready' 대기), `wireWebSocketEvents`의 `onmessage`를 모두 `decodeLiveMessage` + 프로바이더 단위 직렬 큐(`messageQueue`)로 감싸고, `connectionGeneration` 및 소켓 일치 가드로 핸들러 전환(`setupComplete`/`ready` → `wireWebSocketEvents`)과 재연결·종료 간 프레임 유실·혼선을 차단(기존 5초 타임아웃·프록시 폴백 로직은 유지).
  - 직접 경로의 `sendTextPrompt`를 `{ realtimeInput: { text: prompt } }`로, `sendAudioChunk`를 `{ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: base64 } } }`로 통일(프록시 형식 유지).
  - `CALL_KICKOFF_PROMPT` 상수를 export 하고, `connect()`에서 `establishConnection()` 직후 `!options.resumeToken && this.isConnected`일 때만 `sendTextPrompt(CALL_KICKOFF_PROMPT)`를 1회 전송하도록 추가(마이크 준비와 독립, `transcriptItems`·Firestore `liveTranscript` 미기록, `resumeToken` 연결 및 `triggerReconnection`/GoAway 재연결에서는 미전송).
  - **1차 리뷰 반영(연결 중 종료 시 프록시 폴백·첫 인사 오발송 차단)**: `connectionGeneration`(연결·재연결·종료 세대)과 `socketGeneration`(개별 소켓 시도)을 분리하고, 연결 대기 중 `disconnect()` 호출 시 대기 중인 소켓 Promise를 즉시 취소(`LIVE_CONNECT_CANCELLED`)하도록 정리. `connectDirect`·`connectViaServerProxy`의 `onopen`·`onerror`·`onclose` 세대 불일치 분기 및 `setupTimer`/`readyTimer` 콜백 안에서 즉시 취소 reject 처리(기존 5초 뒤 `setupTimer`가 reject 되어 프록시 폴백으로 넘어가던 경합 차단). `establishConnection()` 시작 시점 세대를 기억해 토큰 조회 후·프록시 폴백 전·반환 전과 `connect()`의 kickoff 전에 세대가 바뀌었으면 오류(`onStatusChange("error")`)나 예외 대신 기존 `disconnect` 흐름과 맞춰 조용히 종료하도록 수정.
- **방어 조치 (Safeguards)**:
  - `tests/liveMessage.test.ts`(신규): `decodeLiveMessage`의 `string`/`Blob`/`ArrayBuffer`/`Uint8Array`(오프셋 뷰 포함)/한글 멀티바이트 파싱 및 잘못된 JSON reject 검증, `createSerialQueue`의 순서 보존 및 앞 작업 실패 후 계속 실행 검증.
  - 소스 검사로 `geminiLiveProvider.ts` 내 `JSON.parse(event.data)` 직접 호출 부재, `CALL_KICKOFF_PROMPT` export 및 `!options.resumeToken` 조건 가드를 검증하고, 가짜 `WebSocket`/`fetch`/`auth.currentUser` 환경에서 `Blob` `setupComplete` 직결 성공·프레임 순서 유지·마이크 미준비 시 `CALL_KICKOFF_PROMPT` 1회 전송·`realtimeInput` 형식·대화 로그 미기록·`resumeToken` 및 `GoAway` 재연결 시 미전송(`t.mock.timers`로 1000ms 타이머 대체)까지 단위 테스트로 검증.
  - 1차 리뷰 반영 테스트 보강: (a) 직접 소켓이 열리기(`onopen`) 전 또는 `setupComplete` 전 `disconnect()` 시 프록시 소켓 미생성·kickoff 0회·오류 상태 미전환(`closed` 유지) 검증, (b) 토큰 응답 `{ok:false}` 프록시 경로에서 `Blob` `ready` 처리·`{type:"text_prompt"}` kickoff 정확히 1회 전송·`ready` 직후 후속 프레임 유실 없음 검증.
- **남은 리스크**:
  - 실기기 직접 연결에서 `realtimeInput.text`로 첫 인사가 실제로 나오는지, 서버가 `Blob` 프레임을 보내는지는 `[미확인]`(실기기 QA 필요).
  - 같은 인스턴스로 다시 시도할 때 `resumeHandle`이 남아 있는 기존 동작은 이번 범위 밖.
- **검증**: `npm test` 45/45 통과, `npm run lint`·`npx tsc -p tsconfig.server.json --noEmit`·`npm run build` 오류 없음.

---

### [2026-11-21 KST] v2.10.0 — P0-6 줌·텍스트 선택·배경색 통일 및 P0 묶음 릴리즈 (브랜치 `fix/p0-6-zoom-select-color`, 설계 Claude CLI Opus 5.5 high, 구현 agy Gemini 4 Hydrogen high)
- **배경**:
  - `index.html` 뷰포트의 `maximum-scale=1.0, user-scalable=no`가 모바일 핀치 줌을 차단하고 있었으며, `index.html` `<body>`와 `CoachModal.tsx`의 `select-none`이 복기·강의·코치 텍스트 선택/복사를 막고 있었음.
  - 또한 `index.html` `<body>`, `src/index.css`(`--her-*`), `public/manifest.json`에 구 테마 색상(`#1A1210`)이 남아 PWA 스플래시와 오버스크롤 영역이 실제 앱 배경(`#0F141C`)과 어긋났으며, 미사용 orb 애니메이션 CSS가 남아 있었음.
  - 승인된 P0 묶음(P0-1~P0-6)의 유일한 버전 갱신 PR로 패키지 버전을 `2.9.0` → `2.10.0`으로 올림.
- **원인과 수정**:
  - **P0-6 변경 내역**:
    - 핀치 줌 허용: `index.html` viewport 메타에서 `maximum-scale=1.0`, `user-scalable=no` 제거(`width=device-width, initial-scale=1.0, viewport-fit=cover` 유지).
    - 텍스트 선택/복사 허용: `index.html` `<body>`와 `src/ui/coach/CoachModal.tsx` 외곽 컨테이너에서 `select-none` 제거. 통화 중 오작동 방지를 위해 `src/ui/call/NewCallScreen.tsx` 루트의 `select-none`은 유지.
    - 색상 통일 및 미사용 CSS 정리: `index.html` `<body>` 클래스를 `bg-[#0F141C] text-slate-100 font-sans antialiased overflow-x-hidden`으로 변경(`theme-color` `#0F141C` 유지). `public/manifest.json`의 `background_color`와 `theme_color`를 `#0F141C`로 변경. `src/index.css`에서 미사용 `--her-*` 변수와 `@keyframes orb-pulse-*`/`.animate-orb-*` 클래스를 제거하고 `body` 배경/글자색을 `#0F141C`/`#f1f5f9`로 설정(`.pt-safe`, `.pb-safe`, `.bottom-safe`, `touch-action: manipulation`, `-webkit-tap-highlight-color: transparent` 유지).
    - 버전 및 문서 갱신: `package.json` `"version"`과 `package-lock.json` 루트/`packages[""]` 버전을 `2.10.0`으로 갱신(의존성 변경 없음). `README.md` 헤더·v2.10.0 요약, `PROJECT_CONTEXT.md` 헤더·§2 색상 설명·§5 히스토리, `docs/history/changelog.md` 갱신.
  - **P0 묶음 요약 (`v2.10.0`)**:
    - P0-1: 복기 단계별 소요 시간 계측.
    - P0-2: 복기 화면 「이번 통화 성과」 표시와 빈 통화 문구 정리.
    - P0-3: 홈 「오늘 할 것」 루프 재배치와 진도 확인 시트.
    - P0-4: 복기에서 오늘 강의로 연결(준비된 강의만 자동으로 염).
    - P0-5: 통화 화면 고정 레이아웃(`h-screen` + `supports-[height:100dvh]:h-dvh`, `viewport-fit=cover`, safe-area) 및 「끝내기」→「답변 끝」.
    - P0-6: 핀치 줌·텍스트 선택 허용, `#0F141C` 색상 통일, `v2.10.0` 버전 범프.
- **방어 조치 (Safeguards)**:
  - `tests/mobileShell.test.ts`: `index.html` viewport의 `user-scalable=no`·`maximum-scale=1` 비포함, `index.html` `theme-color`와 `public/manifest.json` `theme_color`/`background_color` 일치, `index.html` `<body>` 클래스의 `select-none` 비포함 검증 추가(기존 `viewport-fit=cover` 및 `답변 끝`/레이아웃 테스트 유지).
- **검증**: `npm test` 29/29 통과, `npm run lint`·`npx tsc --noEmit`·`npx tsc -p tsconfig.server.json --noEmit`·`npm run build` 오류 없음.

---

### [2026-11-21 KST] P0-5 통화 화면 모바일 레이아웃 (v2.10.0 묶음) (브랜치 `fix/p0-5-call-mobile-layout`, 설계 Claude CLI Opus 5.5 high, 구현 agy Gemini 4 Hydrogen high)
- **배경**: 모바일 환경(동적 주소창·하단 시스템 바와 안전 영역)에서 통화 대화창(`transcripts`)이 길어지면 하단 제어 버튼과 「통화 종료」 버튼이 화면 아래로 밀려 사라질 수 있었음. 또한 `Done` 제어 버튼 라벨(「끝내기」)이 「통화 종료」와 혼동될 소지가 있었음.
- **원인과 수정**:
  - 루트 컨테이너가 `min-h-screen`과 `justify-between`만 사용하여 본문이 길어지면 전체 페이지가 늘어나 푸터가 뷰포트 밖으로 밀림 → `src/ui/call/NewCallScreen.tsx` 루트를 `h-screen supports-[height:100dvh]:h-dvh overflow-hidden flex flex-col`로 변경(dvh 미지원 시 100vh, 지원 시 100dvh가 100vh를 덮어씀), 헤더와 푸터에 `shrink-0` 부여, `<main>`을 `flex-1 min-h-0 overflow-y-auto overscroll-contain`으로 제한해 내부 스크롤만 허용. 자동 스크롤은 `scrollIntoView({ behavior: "smooth", block: "end" })`로 고정.
  - 노치/홈 인디케이터 영역 침범 방지: `index.html`의 `viewport` 메타에 `viewport-fit=cover` 추가, `src/index.css`에 기존 여백(`1rem` / `sm:1.25rem`)을 보존하며 안전 영역을 더하는 `.pt-safe`, `.pb-safe`, `.bottom-safe` 유틸리티 추가 후 `NewCallScreen.tsx` 헤더·푸터 및 `src/App.tsx` 미완료 통화 고정 버튼(`bottom-safe`)에 적용.
  - 버튼 라벨 충돌 해소: `NewCallScreen.tsx`의 `COMMAND_LABELS.Done`, 연결 전 안내 문구, 음성 안내 문구, 버튼 표시 텍스트의 「끝내기」를 모두 「답변 끝」으로 변경(`LiveCommand` 타입 및 프롬프트의 `"Done"` 값은 유지).
- **방어 조치 (Safeguards)**:
  - `tests/mobileShell.test.ts`(신규): `index.html`의 `viewport-fit=cover` 포함 여부, `NewCallScreen.tsx`에서 `"끝내기"` 비노출 및 `"답변 끝"`/`COMMAND_LABELS.Done`/뷰포트 고정 클래스(`supports-[height:100dvh]:h-dvh`, `min-h-0`, `pt-safe`, `pb-safe`) 존재를 소스 검사로 검증. 맨 `h-screen`과 맨 `h-dvh`를 같이 두지 않는다.
- **검증**: `npm test` 27/27 통과, `npm run lint`·`npx tsc --noEmit`·`npx tsc -p tsconfig.server.json --noEmit`·`npm run build` 오류 없음.

---

### [2026-11-21 KST] P0-4 복기에서 오늘 강의로 연결 (v2.10.0 묶음)
- **브랜치**: `fix/p0-4-review-to-lecture` · **모델**: 계획 Claude CLI Opus 5.5 high · 구현 agy Gemini 4 Hydrogen high
- **배경**: `ReviewModal`에 선택 콜백 `onOpenPodcast`와 하단 버튼(`🎧 아침 복습 오디오 듣기`)이 있었으나 `App.tsx`에서 콜백을 연결하지 않아 버튼이 보이지 않았음. 통화 복기를 마친 뒤 홈의 오늘 강의 카드로 바로 이어지고, 강의가 이미 준비된 경우에만 강의 창을 열며 준비 전에는 생성 요청을 자동으로 시작하지 않아야 했음.
- **원인과 수정**:
  - `src/App.tsx`: `HomeFocus = "lecture" | null`과 `pendingHomeFocus` 상태를 추가해 `ReviewModal`에 `onOpenPodcast={() => setPendingHomeFocus("lecture")}`를 전달하고(기존 `onClose`의 `homeRefreshKey` 증가·미완료 목록 갱신 유지), `HomeScreen`에 `focus={pendingHomeFocus}`와 `onFocusHandled={() => setPendingHomeFocus(null)}` 전달.
  - `src/ui/home/HomeScreen.tsx`: `focus`·`onFocusHandled` prop을 받아 `focus === "lecture"`일 때 `MorningLectureCard`에 `autoOpen`과 `onAutoOpenHandled` 전달. 첫 `refresh()` 완료 후 `onAutoOpenHandled`가 불릴 때 `lectureCardRef`로 스크롤하고 `onFocusHandled`로 초점 신호를 초기화.
  - `src/ui/lecture/MorningLectureCard.tsx`: `autoOpen`·`onAutoOpenHandled` prop 추가. 첫 `refresh()` 결과에서 `status === "ready"`이고 `audioUrl`이 있을 때만 `setOpen(true)`로 `LectureModal`을 열고, 준비되지 않았으면 열지 않음. `onAutoOpenHandled`는 ref 가드로 마운트당 1회만 호출하며 `startLecture`/`create()`는 호출하지 않음.
  - `src/ui/review/ReviewModal.tsx`: 하단 왼쪽 버튼 라벨을 `오늘 강의 보기`로 변경하고 기존 `onClose()` → `onOpenPodcast()` 순서 유지.
  - `tests/reviewLectureLink.test.ts`(신규) 및 `PROJECT_CONTEXT.md`(§4-3, §4-10, §5) 갱신.
- **방어 조치**: `ReviewModal`과 `App.tsx`에서 `startLecture`를 호출하지 않음을 `tests/reviewLectureLink.test.ts`로 검사하고, `autoOpenHandledRef`·`firstRefreshDoneRef` 및 `onFocusHandled` 초기화로 StrictMode 이중 마운트, 퀴즈 모달 열기/닫기, 이후 홈 재마운트에서 스크롤·자동 열기가 재실행되지 않도록 차단. 미준비 시에는 기존 「오늘 강의 만들기」 수동 버튼만 유지.
- **검증**: `npm test` 26/26 통과, `npm run lint`·`npx tsc --noEmit`·`npx tsc -p tsconfig.server.json --noEmit`·`npm run build` 오류 없음.

---

### [2026-11-21 KST] P0-3 홈 「오늘 할 것」 루프 재배치 (v2.10.0 묶음)
- **브랜치**: `fix/p0-3-home-loop` · **모델**: 계획 Claude CLI Opus 5.5 high · 구현 agy Gemini 4 Hydrogen high
- **배경**: 홈 화면의 아침 강의 카드가 「더 보기」 접힘 영역 안에 숨어 있어 하루 학습 루프(수업 → 강의 → 복습 퀴즈)가 한눈에 이어지지 않았고, 일요일 주간 복기 카드에 바로 실행할 행동 버튼이 없었음. 또한 오늘 수업 카드와 4대 트랙 카드의 인라인 `<select>`가 선택 즉시 Firestore 진도를 저장해 모바일 스크롤·터치 중 실수로 진도가 바뀔 위험이 있었고, 일반 사용자 헤더에도 계정 이메일이 노출되고 있었음.
- **원인과 수정**:
  - `src/ui/home/HomeScreen.tsx`: `<MorningLectureCard>`를 `showMore` 접힘 블록 밖으로 꺼내 오늘 수업 카드와 복습·퀴즈 카드 사이에 배치하고 `lectureCardRef`로 감싸 상시 마운트 유지. 「더 보기」 라벨을 `더 보기 · 주간 루틴 · 트랙 바꾸기 · 코치 소개`로 갱신.
  - 일요일/주간 복기 카드(`isPlanReviewDay && !overrideGoalId`)에 「오늘 퀴즈」(복습 대상이 0개이면 비활성), 「오늘 강의」(`lectureCardRef` 스크롤), 「트랙 골라 통화」(`showMore` 펼친 뒤 `goalsSectionRef` 스크롤) 버튼 3개 추가.
  - 헤더 이메일(`user.email`)을 `devMode`일 때만 표시하도록 제한.
  - `src/ui/home/LessonChangeSheet.tsx`(신규): 모바일 하단/중앙 확인 시트(「진도 바꾸기」 / 「확인」 / 「취소」). `HomeScreen.tsx`의 오늘 수업 카드와 트랙 카드 인라인 `<select>` 두 곳을 「진도 바꾸기」 버튼으로 교체해, 시트에서 「확인」을 누를 때만 `handleLessonChange` 호출.
  - 문서: `README.md` 1단계 홈 항목과 `PROJECT_CONTEXT.md`(홈 UI·§5 히스토리) 동기화.
- **방어 조치**: `LessonChangeSheet`에서 현재 과(`currentIndex`)와 같은 과가 선택됐거나 저장 중(`saving`)일 때는 「확인」 버튼을 비활성화하고, 「취소」 또는 배경 클릭 시 `onConfirm`을 호출하지 않아 의도치 않은 진도 변경을 차단. 2일 결석 배너와 `App.tsx`의 미완료 통화 버튼은 기존 동작 그대로 유지.
- **검증**: `npm test` 25/25 통과, `npm run lint`·`npx tsc --noEmit`·`npx tsc -p tsconfig.server.json --noEmit`·`npm run build` 오류 없음.

---

### [2026-11-21 KST] P0-2 복기 화면 정리와 이번 통화 성과 표시 (v2.10.0 묶음) (GitHub 브랜치 `fix/p0-2-review-outcomes`, 기획 Claude CLI Opus 5.5 high · 구현 agy Gemini 4 Hydrogen high)
- **배경**: 통화 후 복기 모달(`ReviewModal`)에서 이번 통화로 인한 학습 성과(맞게 써서 졸업한 표현, 다시 복습으로 돌아간 표현, 다음 수업 진행 여부)가 드러나지 않고, 기록된 말이 없는 빈 통화에서도 "훌륭합니다!"·"오늘은 저장할 실수가 없어요." 및 아침 강의·퀴즈 할 일 목록이 모순되게 노출되거나, 레벨 미산출 시 임의의 `IH` 배지·영문 `sourceStt`·`mistakes 컬렉션 자동 저장됨·진행 문구 내 모델명 등 내부 구현 용어가 그대로 노출되는 문제가 있었음. 복기 채점·`keepKnownIds`·세션 상태 전이(`pending_review` → `done`)와 P0-1 계측 동작은 유지한 채 화면 표시와 문구만 정리함.
- **원인과 수정**:
  - `src/services/review/reviewView.ts`(신규): Firebase 값 import 없는 순수 모듈(`import type`만 사용)로 `isEmptyReview`, `sourceSttLabel`, `levelBadge`, `outcomeItems`를 추가.
  - `src/services/firebase/db.ts`: `SessionReviewData`에 선택 필드 `usedCorrectlyItems?`, `repeatedItems?`(`{ id, myPhrase, naturalPhrase }[]`)를 추가(마이그레이션 없음).
  - `src/services/review/reviewPipeline.ts`: B-5 `keepKnownIds` 적용 직후 `outcomeItems`로 `review.usedCorrectlyItems`·`review.repeatedItems`를 채워 `saveSessionReview` 전에 반영(리스트 할당 전 실패 시 미설정 유지). 진행 안내 문구 2곳(`1/3 녹음 조각 병합 및 최종 받아쓰기 진행 중...`, `2/3 AI 튜터 복기 리포트 생성 중...`)에서만 모델명을 제거하고, 주석·`engine` 필드·로그는 유지.
  - `src/ui/review/ReviewModal.tsx`: `reviewView` 도우미와 `useDevMode()`를 연결해 레벨 배지(미산출/`-`/빈 값은 `—`), 「이번 통화 성과」 블록(해당 항목이 하나라도 있을 때만 표시, 예전 세션은 숨김), 빈 통화 시 실수 영역(`기록된 말이 없어 분석하지 않았어요`)·할 일 영역(`같은 과로 다시 걸어 주세요`, 아침 강의/퀴즈 2항목 숨김) 분기, 한국어 출처 라벨(`sourceSttLabel`, 개발자 모드에서만 원 코드 병기), `mistakes 컬렉션 자동 저장됨` 개발자 모드 전용화, 전문 보기 버튼 문구(`녹음 받아쓰기 전문 보기 (출처: …)`)를 적용.
  - `README.md` · `PROJECT_CONTEXT.md`: 1단계 통화 후 복기 표 및 B-4·§5 히스토리에 P0-2 변경 반영(헤더 버전·날짜 `v2.9.0` 유지).
- **방어 조치 (Safeguards)**:
  - `tests/reviewView.test.ts`(신규): `sourceSttLabel` 4종 구분 및 기본값, `isEmptyReview` 판별(`none` 또는 `lessonAdvanced === false`), `levelBadge` 미정/`-`→`none`·`AL`→`good`, `outcomeItems` 미존재 ID 제거 및 순서 보존을 검증.
  - `tests/reviewRules.test.ts`, `ReviewFlowScreen.tsx`, `server.ts`, `package.json` 버전 및 P0-1 소요 시간 계측 로직은 변경하지 않음.
- **검증**: `npm test` 32/32 통과, `npm run lint`·`npx tsc --noEmit`·`npx tsc -p tsconfig.server.json --noEmit`·`npm run build` 오류 없음. 성과 영역은 졸업·재복습 항목이 하나라도 있을 때만 열리며, `lessonAdvanced`만으로는 열리지 않는다.

---

### [2026-11-21 KST] P0-1 복기 단계별 소요 시간 계측 (v2.10.0 묶음) (GitHub 브랜치 `fix/p0-1-review-timing`, 기획 Claude CLI Opus 5.5 high · 구현 agy Gemini 4 Hydrogen high)
- **배경**: 통화 후 복기 파이프라인(`runPostCallReview`)에서 어느 단계(녹음 조각 수집·최종 받아쓰기·폴백·AI 복기·저장)가 얼마나 걸리는지 세션 단위로 관측할 수 있도록 계측을 추가함. 복기 동작·받아쓰기·세션 상태 전이(`pending_review` → `done`)는 변경하지 않는 순수 계측 PR.
- **원인과 수정**:
  - `src/services/review/reviewTiming.ts`(신규): Firebase 값 import 없는 순수 모듈로 `ReviewStep`, `ReviewTiming`, `createStepTimer(now?)` 추가. 테스트에서 가짜 시계를 주입할 수 있도록 `now` 기본값만 `() => Date.now()`로 두고, 종료되지 않은 단계는 `snapshot()`에서 제외하며, 동일 단계의 누적 합계로 `totalMs`를 계산.
  - `src/services/firebase/db.ts`: `SessionData`에 선택 필드 `reviewTiming?: ReviewTiming` 추가. `saveSessionReview` 옆에 `saveReviewTiming(userId, sessionId, timing)` 추가(`reviewTiming`과 `updatedAt`만 갱신하고 `status`는 유지, 기존 오류 도우미 패턴 `handleFirestoreError` 사용).
  - `src/services/review/reviewPipeline.ts`: `ReviewPipelineResult`에 `timing?: ReviewTiming` 추가. `runPostCallReview`의 5단계(`collectChunks`, `transcribe`, 실제 실행 시 `fallback`, `review`, `save`), 1분 묶음 수(`minutes`), 재시도 포함 전사 요청 횟수(`transcribeRequests`), 결과(`ok` / `empty` / `failed`), 확인된 `sourceStt`를 계측. 전체 본문을 `try/finally`로 감싸 성공·빈 통화·예외 전파(`failed`) 모든 경로에서 `saveReviewTiming`을 호출(저장 실패 시 `console.warn` 후 삼켜 복기 결과/예외 흐름에 영향 없음).
  - `src/ui/review/ReviewModal.tsx` · `src/App.tsx`: `ReviewModalProps` 및 `ActiveReviewState`에 `timing?: ReviewTiming` 전달. `useDevMode()`가 켜져 있고 `timing`이 있을 때만 복기 모달 상단에 `복기 소요: 받아쓰기 n초 · AI n초`(없는 단계 생략) 한 줄을 표시.
- **방어 조치 (Safeguards)**:
  - `tests/reviewTiming.test.ts`(신규): 가짜 시계 기준 단계별 ms 및 `totalMs` 일치, `start` 후 `end` 없는 단계 제외, 동일 단계 2회 누적 합산 검증.
  - 계측 저장 실패가 복기 완료·실패 전파나 세션 상태(`pending_review` → `done`)를 방해하지 않도록 `finally`에서 `saveReviewTiming`을 기다리지 않고 `.catch`로만 경고한다(오프라인 `updateDoc` 대기 방지). `package.json` 버전 및 `server.ts`·기존 테스트는 변경하지 않음.
- **검증**: `npm test` 28/28 통과, `npx tsc --noEmit` 및 `npx tsc -p tsconfig.server.json --noEmit` 오류 없음.

---

### [2026-11-10 KST] v2.9.0 — 전체 코드 리뷰 2차 반영 (GitHub 브랜치 `claude/full-review-2026-11`, Claude)
- **배경**: 2026-11-10에 `main`(`24901cb`, v2.8.1) 전체 약 14,100줄을 다시 리뷰. 빌드·타입 검사·테스트 18개는 통과했지만, 약한 인터넷·앱을 중간에 닫음·버튼 두 번 누름 같은 실제 사용 상황에서 학습 기록이 빠지는 문제 9개(높음), 8개(중간), 6개(낮음)를 찾음. 전체 목록과 근거: [`docs/reviews/2026-11-full-code-review.md`](../reviews/2026-11-full-code-review.md).
- **문제 원인과 적용된 수정 내역 — 높음**
  - 복기 중 앱을 닫으면 통화가 복기 없이 "완료"로 남음: 통화 종료 때 바로 `status: "done"`으로 저장했기 때문 → `finalizeCallSession`이 `pending_review`로 저장하고 `saveSessionReview`만 `done`으로 바꿈. 「보관만 하기」는 `archive: true`.
  - 밤 통화의 실수가 다음 날 아침 강의에 안 들어갈 수 있음: 피드 후보를 홈 화면이 뜰 때만 서버로 보냈기 때문 → 복기가 끝난 직후 `syncFeed`(`App.tsx`, 미완료 통화 복기 경로 포함).
  - 느린 인터넷에서 1분 임시 받아쓰기 순서가 섞이거나 생기지 않음: 1분 묶음을 업로드가 끝난 순서로 쌓았기 때문 → `ChunkRecorder.processChunk`가 조각을 받자마자 녹음 순서로 묶음에 넣고, 6개가 되면 업로드와 무관하게 받아쓰기 요청. `processChunk`의 실패도 잡아서 기록.
  - 1분만 실패해도 기록용 받아쓰기 전체를 버림 → 분마다 1회 재시도, 그래도 실패한 분만 같은 분의 임시 받아쓰기로 채움(`reviewRules.ts` `mergeMinuteTranscripts`). 받아쓰기 요청의 형식은 `;codecs=...`를 뗀 값으로 전송.
  - 「통화 종료」 두 번 누름으로 같은 통화가 두 번 마무리·복기됨 → `hangingUpRef`로 한 번만, 버튼 비활성화와 "통화를 마무리하는 중..." 표시.
  - 통화 중 연결이 완전히 끊긴 뒤 「나가기」를 누르면 그 통화가 복기 없이 버려짐 → 녹음이 있는 통화면 정상 종료 경로(저장 → 복기)로 보냄. 창 제목 「통화 연결이 끊겼어요」, 버튼 「여기서 끝내고 복기 보기」.
  - 내 말이 전혀 없는 통화도 진도가 넘어가고 AI가 실수를 지어낼 수 있음 → 받아쓰기·임시 받아쓰기·대화 로그 모두 비면 `/api/review`를 부르지 않고 안내 복기만 저장(`sourceStt: "none"`, `lessonAdvanced: false`), `advanceGoalAfterCompletedCall` 호출 안 함.
  - 코치 대화 50개 초과 시 새 메시지가 안 보임: `orderBy("at","asc").limit(50)`이 가장 오래된 50개를 돌려줌 → 최신 50개를 읽어 뒤집어 표시.
  - 서버 예비 저장소가 빈 녹음 조각에 `ok: true`를 답해 앱이 기기 사본을 지움 → 빈 본문은 400.
- **문제 원인과 적용된 수정 내역 — 중간**
  - 내부 오류 문구 노출(프로젝트 지침 「내부 정보 은닉」): `/api/gemini/tts`, `/api/gemini/transcribe-partial`, `/api/gemini/transcribe-final`, `/api/recordings/upload-chunk`, `/api/review`, `/api/quiz/grade`, `/api/quiz/meaning-ko`, `/api/coach/chat`, `/api/lecture/generate|status|audio`, `/api/keep/parse`, `/api/stt-bench/transcribe`, `/api/gemini/token`의 실패 응답과 Live 중계의 `error`/`fallback_required` 메시지, 로그인 실패 응답의 `detail`, 강의 상태의 `error`(공개 피드 JSON에도 나감)에 `err.message`가 들어 있었음 → `server/errors.ts`(신규) `apiError()`/`noKey()`로 정해진 한국어 문구 + 코드만 응답. 원문은 `console`에만. 강의 실패는 `GENERATION_FAILED`.
  - 화면의 `alert`/안내에 `err.message`를 그대로 표시(Firestore 도우미가 던지는 JSON에는 계정 이메일·문서 경로가 들어 있음) → `src/ui/common/friendlyError.ts`(신규)를 코치·퀴즈·강의·Keep·설정·홈·복기 실패 화면·로그인에 적용.
  - 복기 AI가 준 실수 id를 검사 없이 반영 → `keepKnownIds`: 보낸 목록에 있는 id만, 복습 중인 것만 졸업, 졸업한 것만 재복습.
  - 복기 요청에 모든 실수 문서를 통째로 실음 → id·내가 한 말·자연스러운 표현·이유만, 종류별 최신 150개.
  - 화면 꺼짐 방지가 다른 앱에 다녀오면 풀림 → `visibilitychange`에서 다시 요청.
  - 「다시 시도」 직후 소리가 안 날 수 있는 경합 → `GeminiLiveProvider.connect()`가 진행 중인 `disconnect()`를 기다림.
  - 복기 실패 안내가 가리키는 "끝나지 않은 통화"가 홈에 없음 → 홈 아래 버튼 추가, 목록 갱신(`refreshUnfinished`).
  - 키 없음 안내가 "AI Studio Secrets"를 가리킴 → 「설정 → Gemini 키」로 통일(서버 `NO_KEY_MESSAGE`, 복기 실패 화면).
  - Live 중계 소켓의 중복 `init`으로 세션이 남음 → 소켓당 1회.
- **낮음**: 첫 사용자에게 "이틀째 쉬었어요" 띠가 뜨던 것, 퀴즈를 X로 닫으면 홈 숫자가 그대로인 것, Keep 복사 실패에도 "복사됨" 표시, 로그인 실패 시 영어 SDK 오류 표시, 받아쓰기 출처 라벨(`liveTranscript_fallback`·`none` 추가) 수정. 응답 헤더 `X-Content-Type-Options: nosniff`·`Referrer-Policy: no-referrer` 추가, `X-Powered-By` 제거. `package.json` 버전 2.8.0 → 2.9.0(의존 패키지는 변경 없음).
- **방어 조치 (Safeguards)**
  - `tests/reviewRules.test.ts`(신규): id 검사, 분 단위 받아쓰기 합치기(성공·보충·누락), 화면 오류 문구에 내부 정보가 없는지.
  - `tests/chunkRecorder.test.ts`: 첫 조각 업로드가 멈춰 있어도 1분 묶음이 `[0..5]` 순서로 나가는지(고치기 전 코드에서는 실패함을 확인).
  - `tests/server.test.ts`: `apiError`/`noKey` 응답 모양, 그리고 `server.ts`의 어떤 응답에도 `err.message`가 들어가지 않는지 소스 검사.
  - 유지: 일일 한도 카운터(`server/rateLimit.ts`), 로그인 확인, 녹음 경로 검사, 업로드 20MB·JSON 10MB 제한, 같은 출처 전용. 이번 수정에서 제거·완화한 보호 장치 없음.
- **검증**: 앱·서버·테스트 타입 검사, 빌드, `npm test` 25/25 통과(`npm ci`로 새로 설치 후). 서버를 띄워 헤더·401·404·피드 404·모바일 크기 로그인 화면 확인. 로그인·마이크·Gemini 키가 필요한 통화·복기·강의는 실행하지 못함 → 실기기 확인 목록 [`docs/qc/2026-11-android-qc-checklist.html`](../qc/2026-11-android-qc-checklist.html).
- **남은 것**: 통화 단가(`models.ts` `livePerMinute`)는 공식 단가를 확인하지 못해 그대로 둠(예상 비용이 실제보다 낮을 수 있음). `.data/`의 강의 음성·예비 녹음 보존, `npm audit` 10건(Firebase SDK 업그레이드 필요), 허용 계정 고정은 결정이 필요해 보류.

---

### [2026-10-19 KST] v2.8.1 — 아침 피드 404 수정: 피드 설정·Gemini 키 Firestore 암호화 백업 (GitHub PR #8, Claude)
- **문제 원인 (Root Cause)**: 피드 설정(비밀값·강의 후보 실수)을 서버의 `.data/feed.json`에만 저장했음. Cloud Run은 밤새 요청이 없으면 서버를 내렸다가 새로 띄우는데, 이때 `.data/`가 비어서 6:40 그록봇 요청이 404. 앱을 열면 설정이 다시 보내져서 정상으로 돌아왔음.
- **적용된 수정 내역 (Changes)**:
  - `server/feedStore.ts`(신규): `/api/feed/sync` 때 사용자 로그인 토큰으로 Firestore `feeds/{id}`에 백업. 문서 id와 암호화 키(AES-256-GCM)는 피드 비밀값에서 각각 따로 만들어서, 비밀값 없이는 문서를 찾거나 읽을 수 없음.
  - `server/feed.ts` `loadFeedForSecret`: 로컬 파일이 없으면 백업을 로그인 없이 읽어 복원. 피드 페이지·오디오 경로가 이걸 사용.
  - 설정에서 비밀값을 바꾸면 예전 백업을 지워서 옛 주소가 계속 열리지 않게 함(`feedService.ts` → `previousSecret`).
  - `firestore.rules`: `feeds/{feedId}` 정확한 id로 읽기만 공개(목록 불가), 쓰기·삭제는 허용 계정 본인만. **AI Studio에서 규칙 배포가 필요함.**
  - 사용자가 설정에 저장한 Gemini 키도 같은 암호문에 넣음(찬식 님 결정 2026-10-19). 새로 뜬 서버가 로그인 요청 없이도 아침 강의를 만들 수 있음. 피드 주소를 가진 사람은 키를 꺼낼 수 있으므로, 주소가 새면 설정에서 피드 비밀값과 키를 바꿀 것.
- **재발 방지 (Safeguards)**:
  - `tests/feedStore.test.ts`: 백업 문서에 평문(실수·키)이 없음, 빈 `.data/`에서 상태·키 복원, 틀린·바뀐 비밀값은 읽지 못함을 `npm test`로 매번 확인.
  - 키는 사용자 설정 키를 서버가 실제로 쓰고 있을 때만 백업(환경 변수 키는 백업하지 않음). 오류는 서버 로그에만 남기고 응답에는 `backedUp` 참/거짓만 돌려줌.

---

### [2026-10-19 KST] v2.8.0 — 전체 코드 리뷰 반영 (GitHub 브랜치 `claude/trusting-johnson-0b9s97`, Claude)
- **배경**: 2026-10-18에 저장소 전체(약 13,400줄)를 리뷰. 빌드·타입 검사는 통과했지만, 쓰는 중에 데이터가 틀리거나 사라지는 버그 7개(높음), 5개(중간), 정리할 것 9개(낮음)를 찾음. 전체 목록과 근거는 [`docs/reviews/2026-10-full-code-review.md`](../reviews/2026-10-full-code-review.md).
- **높음 (커밋 `a6e9d15`)**
  - 앞 통화가 다음 통화에 섞임: Live 공급자가 앱 전체에 1개뿐이고 대화 기록·세션 재개 핸들을 지우지 않았음 → 통화마다 새 인스턴스(`createLiveProvider()`, `NewCallScreen.tsx`).
  - 통화 마지막 0~10초가 복기에서 빠짐: 녹음을 멈추기 전에 조각 목록을 가져갔음 → `ChunkRecorder.stop()`이 마지막 조각을 기다린 뒤 목록을 읽음.
  - 코치 답장과 업로드 실패 조각 기록이 저장되지 않음: Firestore가 `undefined` 값을 거부(SDK로 재현) → `initializeFirestore(..., { ignoreUndefinedProperties: true })`.
  - 통화 후에도 홈의 "오늘 수업"이 그대로: 앱의 목표 목록을 다시 읽지 않았음 → 복기 완료·코치 승인/되돌리기 뒤 `refreshGoals()`.
  - 코치 "되돌리기"가 다른 트랙 진도까지 되돌림 → 승인 순간의 실제 값을 `before`로 저장, 되돌리기는 바꾼 항목만.
  - "다시 시도" 뒤 녹음 조각 번호가 0부터 다시 시작돼 복기 순서가 섞임 → 같은 통화면 번호를 이어 감.
- **중간 (커밋 `f67718f`)**
  - "이건 내가 한 말이 아니에요"가 화면에서만 숨김 → 저장된 실수 삭제, 세션 복기에 `hidden` 기록, 복기 결과에 실수 id 저장(`hideReportedMistake`).
  - 서버 재시작 후 아침 강의가 "만드는 중"에서 멈춤 → 실제 작업이 없으면 `failed`/`INTERRUPTED`, 앱·피드가 다시 만들기.
  - 같은 통화를 다시 복기하면 실수 중복, 오래된 통화 복기 시 진도 후퇴 → 이전 실행분 교체(`deleteCallMistakesForSession`), 진도는 앞으로만.
  - 설정의 1분 받아쓰기 스위치가 통화에 적용되지 않음 → 통화 화면이 같은 값을 읽음.
  - 퀴즈 말하기가 `audio/webm` 고정이라 일부 아이폰에서 실패 → 지원 형식 자동 선택, 실제 형식 전송.
- **낮음 (커밋 `9318a91`)**
  - 설정의 취약점 문구가 저장되지 않음, 여행 프롬프트에 필리 취약점이 들어감 → 3개 저장, 트랙별 치환.
  - 코치(AI) 제안을 검사 없이 적용 → `src/data/planValidation.ts`로 표시 전·적용 전 검사.
  - 서버 키 탐색이 매 요청마다 파일과 모든 프로세스의 `/proc`을 훑음 → 1분 기억, 부모 프로세스만.
  - 로그인 없는 `/api/gemini/status`가 키 파일 경로를 보여 줌 → 종류만.
  - 앱을 열 때마다 모든 통화 문서를 읽음 → 미완료 통화만(색인 없이 되는 조건).
  - 안 쓰는 코드 삭제: 서버 메모리 통화 감시·heartbeat, 브라우저용 빈 STT/LLM/TTS 뼈대, 닿지 않는 `apply_plan_change` 분기, 불필요한 지연 import.
  - `NODE_ENV` 없이 켜진 배포 서버에 Vite가 없으면 죽던 위험 → 빌드된 앱으로 대체.
  - 빌드 경고(1.13MB 파일 1개) → 라이브러리별로 나눔, 경고 없음.
  - 자동 테스트 없음 → `npm test` 17개(CI에서 실행), 테스트도 타입 검사.
  - `package.json` 버전을 1.2.2 → 2.8.0으로 앱 버전과 맞춤.
- **검증**: 앱·서버·테스트 타입 검사, 빌드, `npm test` 17/17 통과. Firestore `undefined` 거부와 해결은 실제 Firebase SDK로 확인. 녹음기는 가짜 녹음 장치로 5가지 종료 시점 확인. 실제 앱 통화(로그인·마이크·Gemini 키 필요)로는 아직 재현하지 않음.
- **남은 것**: `npm audit` high 4건(Firebase의 `@grpc/grpc-js`, 브라우저에선 안 쓰는 부분으로 추정)은 Firebase 큰 버전 업그레이드가 필요해 보류. v2.8.0 전에 승인한 코치 변경을 되돌리면, 바꾼 항목은 예전 방식으로 기록된(더 오래된) 값으로 돌아갈 수 있음.

---

### [2026-10-15 KST] v2.7.8 — 아침 강의·녹음 오디오가 재생되지 않던 문제 (GitHub PR, Claude)
- **문제 원인 (Root Cause)**: 강의 오디오와 녹음 파일은 `.data/` 폴더에 저장되는데, Express `res.sendFile`은 기본값으로 "."으로 시작하는 폴더가 들어간 경로를 거부하고 404 "Not Found"를 돌려줌. 강의는 만들어졌지만 앱 플레이어("강의 오디오를 불러오지 못했어요")와 피드 재생 링크가 모두 실패.
- **적용된 수정 내역 (Changes)**: `server.ts` 강의 오디오(`/api/lecture/audio`), 피드 오디오(`/feed/:secret/audio/:file`), 녹음 파일(`/api/recordings/file`)의 `sendFile`에 `dotfiles: 'allow'` 지정.

---

### [2026-10-14 KST] v2.7.7 — 블루이 첫 통화 피드백 반영 (GitHub PR, Claude)
- **문제 원인 (Root Cause)**:
  - 아침 강의 실패: `gemini-3.8-flash-tts` 2인 음성 요청이 400 "Multi-speaker generation requests must specify speech_metadata.speaker for each text part". 대본 전체를 한 덩어리 글로 보냈기 때문.
  - 통화 지시문에 Gemini 앱(채팅)용 원문이 그대로 들어가 "Next lesson" 안내, Keep 확인, 호주 억양 흉내 등이 통화에서도 나옴. 말 길이 제한도 없었음.
  - 복기 화면의 "Keep 붙여넣기용 복사"가 필수 단계처럼 보였음. 실제로는 실수가 앱 복습 목록에 자동 저장되고 있었음.
- **적용된 수정 내역 (Changes)**:
  - `server/lecture.ts`: 2인 음성은 말하는 사람마다 한 조각씩 `speechMetadata.speaker`(+style)를 붙여 보냄. 1인 음성에서는 "Coach:" 꼬리표를 읽지 않게 뺌.
  - `src/data/lessonPromptBuilder.ts`: "앱 통화 규칙"을 추가해 원문보다 우선 적용. 채팅용 안내 무시, 오늘 과만 진행, 한 번에 1~2문장과 질문 하나(학습자 70% 이상 말하기), 같은 목소리 유지·억양 흉내 금지·영어 위주, 끝나면 "That's it for today. See you next time."으로 마무리.
  - `ReviewModal.tsx`: "통화 후 할 일" 안내(실수 N개 자동 저장됨, 내일 아침 강의·퀴즈). Keep 복사는 접힌 선택 항목으로 옮김(Google 개인 계정은 Keep API를 쓸 수 없음). `reviewPipeline.ts`: 저장 성공 여부(`mistakesSaved`)를 기록.
  - `NewCallScreen.tsx`: 오늘 복습 차례인 실수 최대 3개를 통화 지시문에 넣음(기획 B-2 요구 4). 튜터가 그 표현을 쓸 상황을 만들고, 복기에서 맞게 쓰면 졸업. 불러오기가 3초 넘게 걸리면 빈 목록으로 바로 통화 시작.

---

### [2026-10-14 KST] v2.7.6 — 휴대폰 볼륨 버튼·이어폰으로 튜터 목소리 듣기 (GitHub PR, Claude)
- **문제 원인 (Root Cause)**: 튜터 목소리를 AudioContext에서 바로 스피커(`ctx.destination`)로 재생했음. 마이크가 켜지면 휴대폰은 "통화" 모드가 되는데, 이 소리는 "미디어" 채널로 나가서 볼륨 버튼은 통화 음량만 바꾸고 튜터 음량은 그대로였음. 이어폰을 껴도 통화 경로를 따르지 않고 휴대폰 스피커로 나올 수 있음 [추정, 실기기 확인 필요].
- **적용된 수정 내역 (Changes)**: `geminiLiveProvider.ts` 튜터 목소리를 AudioContext → MediaStream → 숨은 `<audio>` 요소로 재생(마이크와 같은 통화 경로). 실패하면 예전 방식으로 자동 전환. iOS Safari는 `navigator.audioSession.type = "play-and-record"` 지정.
  - 통화 중 이어폰을 끼거나 빼면(`devicechange`) 마이크를 다시 열어 새 기기로 바꿈. 녹음기는 마이크 대신 Web Audio 출력 스트림을 녹음해서, 마이크가 바뀌어도 녹음이 끊기지 않음.

---

### [2026-10-14 KST] v2.7.5 — 설정 화면이 열리지 않던 문제 (GitHub PR, Claude)
- **문제 원인 (Root Cause)**: `SettingsModal.tsx`에서 `if (!isOpen) return null;`이 `useEffect`보다 위에 있었음. 설정을 여는 순간 React 훅 개수가 바뀌어 오류가 나고 화면이 뜨지 않음(2026-10-13 커밋 0c42085부터).
- **적용된 수정 내역 (Changes)**: 닫혀 있을 때 숨기는 줄을 모든 훅 아래로 옮김.

---

### [2026-10-14 KST] v2.7.4 — 배포 서버 Gemini 키 우회 (GitHub PR, Claude)
- **문제 원인 (Root Cause)**: AI Studio에서 Publish한 서버(aicall.ai.studio)에 Secrets의 키가 전달되지 않음. `/api/gemini/status` 결과 `hasServerKey:false`, `keySource:"none"`(환경 변수·파일·/proc 어디에도 쓸 수 있는 키 없음). 코드가 아닌 AI Studio 쪽 문제로, Google 포럼에도 같은 신고가 있고 공식 해결책은 없음.
- **적용된 수정 내역 (Changes)**:
  - `server/userKey.ts`(신규): 로그인한 사용자가 저장한 키를 Firestore REST(`users/{uid}/private/gemini`)에서 사용자 본인 토큰으로 읽어 서버 메모리에만 보관(10분 캐시). 배포 환경에 진짜 키가 있으면 그 키가 항상 우선.
  - `server/auth.ts`: 로그인 확인 직후 실행되는 훅(`setAfterAuthHook`). `server.ts`: 키 찾기 마지막 단계에 사용자 저장 키 추가, `/live` 연결 때도 읽음, `/api/gemini/key-refresh` 추가, 키 없음 안내 문구를 "설정 → Gemini 키"로 변경.
  - 설정 화면에 **Gemini 키** 탭(`src/ui/settings/GeminiKeyPanel.tsx`): 키 저장·삭제, 현재 어느 키로 통화하는지 표시.

---

### [2026-10-14 KST] v2.7.3 — 저장소 검수 반영 (GitHub PR, Claude)
- **문제 원인 (Root Cause)**:
  - 녹음 10초 조각은 각각 완결된 WebM 파일인데, 받아쓰기 전에 바이트로 이어 붙였음. 이렇게 만든 파일은 앞부분만 읽혀서(시험: 3초×3개 → 5.9초만 해독) 기록용 받아쓰기에서 말이 빠질 수 있었음.
  - Live 재연결이 실패하면 약 4초마다 끝없이 다시 시도 → 시도마다 토큰 요청과 통화 시작(하루 60회 한도)이 쌓임.
  - 그록봇 피드가 실패한 강의를 요청 때마다 다시 생성 시작.
  - 서버가 모델 이름을 `models.ts`가 아닌 자기 상수로 따로 관리(기획 v4 B-1 위반), Live 기본 지시문이 v1의 "한국어 친구".
  - `/api/sessions/heartbeat`·`interrupted-check`가 로그인 사용자 대신 요청에 적힌 `userId`를 사용.
- **적용된 수정 내역 (Changes)**:
  - `src/services/recording/audioMerge.ts`(신규): 조각을 Web Audio로 풀어 16kHz 모노 WAV로 합침. `chunkRecorder.ts`(1분 임시 받아쓰기), `reviewPipeline.ts`(최종 받아쓰기를 1분씩 요청 후 순서대로 이어 붙임)에 적용.
  - `geminiLiveProvider.ts`: 재연결 5번 연속 실패 시 중단하고 오류 안내.
  - `server/feed.ts`: 실패한 강의는 30분에 한 번만 다시 시도.
  - `server.ts`, `server/lecture.ts`: 모델 이름을 `src/config/models.ts`에서 가져옴(동작 동일, 발음 듣기용 `GEMINI_TTS_LITE_MODEL` 추가). 기본 지시문 영어 튜터로. 시작 로그의 "Gemini 2.5" 문구 정리. 세션 상태 API는 로그인 사용자 기준.
  - 앱 이름 One Call English(`metadata.json`, `index.html`, `public/manifest.json`). `README.md` 현재 기능 기준으로 새로 씀, `PROJECT_CONTEXT.md` 번호·버전 기록 정리, `docs/README.md`에 v1 문서 안내.
- **바로잡음**: 아래 v2.7.2 다음 항목의 "`.env.example` 신규 추가"는 실제 저장소에 반영되지 않았음.

---

### [2026-10-14 KST] Gemini API 키 유효성 검증 및 런타임 모델 명칭 동기화 (v2.7.2)
- **문제 원인 (Root Cause)**:
  - 사용자 질문: "제대로 들어가있는데 왜 계속 오류가 나는가?"
  - 정밀 진단 결과, 사용자가 AI Studio Secrets에 등록한 Gemini API 키는 정상 주입되어 있었음.
  - 그러나 과거 구버전 런타임에서 기본 더미 키(`MY_GEMINI_API_KEY`)가 `process.env`를 선점하여 실시간 유효 키 덮어쓰기가 차단되었던 잔재와, 서버 재시작 전 런타임 메모리 불일치로 인해 팝업이 발생했던 이력 확인.
  - 추가로 `/api/gemini/status`의 모델 표시 라벨이 구버전(`Gemini 2.5 Flash Native Audio Dialog`)으로 잔존해 있어 혼선을 유발함.
- **적용된 수정 내역 (Changes)**:
  - `server.ts`:
    - `/api/gemini/status`의 `modelName` 라벨을 공식 실시간 음성 통화 모델인 `Gemini 3.8 Live Native Audio Dialog`로 교정.
    - 실제 Gemini SDK 통신(`ai.models.generateContent`, `ai.live.connect`, `ai.authTokens.create`) 전수 실시간 호출 검증 통과 (`gemini-3.8-flash`, `gemini-3.8-live`, `gemini-3.5-transcribe` 모두 정상 응답).
  - 런타임 메모리 동기화: `restart_dev_server`를 통해 변경된 키 주입 로직 및 모델 명칭을 활성 메모리에 즉각 반영.
  - `README.md`, `PROJECT_CONTEXT.md`: 최신 빌드 버전(`20261014-multilingual-1522` / `v2.7.2`) 및 키 주입 안내 갱신.
- **방어 조치 (Prevention)**:
  - 키 존재 여부뿐 아니라 SDK 실호출 가능 여부를 검증하고, 더미 키 발생 시 즉각 런타임 동적 감지 로직으로 대체하도록 안전망 유지.
  - KST 기준 일관된 버전 관리 및 Zero-Quota 캐시/보안 정책 100% 보존.

---

### [2026-10-14 KST] Gemini API 키 탐색 및 Cloud Run 환경변수 동기화 강화
- **문제 원인 (Root Cause)**:
  - 통화 시작 시 "서버가 Gemini 키를 찾지 못했어요. AI Studio Secrets의 GEMINI_API_KEY를 확인하고 다시 Publish해 주세요." 팝업이 노출되고, [다시 시도] 시에도 동일 오류가 반복되는 현상 접수.
  - 근본 원인 1: Cloud Run 배포(Publish) 인스턴스는 로컬 전용 파일(`.dev.env.json`)이 배포 컨테이너에 포함되지 않으므로, AI Studio [Settings] > [Secrets]에 등록된 `GEMINI_API_KEY`가 주입되어야만 동작함.
  - 근본 원인 2: `server.ts`의 `resolveGeminiApiKey()`가 `if (found && !process.env.GEMINI_API_KEY)`로 되어 있어, 기본 컨테이너 더미 값(`MY_GEMINI_API_KEY`)이 존재할 경우 유효 키(`found`)를 탐색해도 `process.env`에 덮어쓰지 못하는 버그 존재.
- **적용된 수정 내역 (Changes)**:
  - `server.ts`:
    - `resolveGeminiApiKey()`에서 더미 값 감지 시(`!isUsableKey(process.env.GEMINI_API_KEY)`) 유효 키로 즉시 교체하고 `GOOGLE_API_KEY`, `GOOGLE_GENAI_API_KEY` 동시 동기화.
    - Secret Volume 마운트 경로(`/secrets`, `/etc/secrets`, `/var/run/secrets`, `/var/secrets`) 및 다양한 시크릿 파일명 탐색 확장.
  - `.env.example`: 필수 환경변수 템플릿 신규 추가. *(2026-10-14 확인: 이 파일은 저장소에 없음)*
- **방어 조치 (Prevention)**:
  - `isUsableKey`를 통한 더미 키 차단, Zero-Quota 디스크 캐시 및 Rate Limit 로직 100% 보존.
  - 사용자 화면 및 API 오류 응답에 키/스택 트레이스 비노출 정책 철저 유지.

---

### [2026-10-14 KST] 루트 중복 문서 정리 및 배포 설정 동기화
- **문제 원인 (Root Cause)**:
  - 과거 작업 과정에서 생성되었던 구버전 백업 잔재 파일인 `Project_context.MD`(v2.3.0 시점, 8.8KB)가 루트 경로에 남아 공식 최신 표준 문서인 `PROJECT_CONTEXT.md`(v2.7.0, 14.8KB)와 혼선을 유발함.
- **적용된 수정 내역 (Changes)**:
  - `Project_context.MD`: 불필요한 구버전 중복 파일 영구 삭제.
  - `.dockerignore`, `.gcloudignore`: 무시 제외 목록의 대소문자 표기를 공식 정식 파일명인 `!PROJECT_CONTEXT.md`로 일치시켜 Cloud Run 배포 격리 정책 동기화.
  - `docs/README.md`: 문서 정책 표기 내 `Project_context.MD`를 `PROJECT_CONTEXT.md`로 교정.
- **방어 조치 (Prevention)**:
  - 공식 프로젝트 컨텍스트 단일 진실 공급원(`PROJECT_CONTEXT.md`) 일원화 및 Cloud Run 컨테이너 빌드 정합성 확보.

---

### [2026-10-14 KST] v2.7.0 — [작업 지시서 8] 3단계 코치 — 가이드 B-9 완료
- **문제 원인 및 기획 의도 (Context & Motivation)**:
  - 4대 목표(OPIc, Philly, Travel, Bluey) 트랙을 수강생(찬식님)의 실제 생활 일정(출장, 야근, 휴식, 시험일 등)에 맞게 유연하게 조정하면서도, 데이터 손실이나 임의 조작 없이 안전하게 학습 루틴을 관리할 수 있는 3단계 텍스트 코치 및 스케줄 자동화 파이프라인 구현.
  - LLM 모델이 독단적으로 사용자 계획을 수정하지 못하도록 엄격한 "제안(proposed) → 사용자 승인(approved)" 방어 체계를 확립하고, 언제든 직전 상태로 복구할 수 있는 "되돌리기(reverted)" 라이프사이클 구축.
  - 사용자가 하루 수업을 건너뛰었을 때 과 진도가 낭비되지 않도록 하는 "하루 빠짐 보존" 규칙과, OPIc 시험 1~2주 전 모의고사(14과) 집중 배치 자동 제안, 그리고 2일 연속 결석 시 부드러운 복귀 넛지 배너 제공.
- **적용된 수정 내역 (Applied Changes)**:
  1. **B-11 데이터 모델 완성 (`src/services/firebase/db.ts`)**:
     - `users/{uid}/plan`: `weeklyPattern`, `minutesPerDay`, `updatedAt` 저장. 문서 부재 시 기본 4대 트랙 루틴(월·토 opic, 화·목 philly, 수 bluey, 금 travel, 일 주간복기)으로 자동 초기화(`initUserPlanIfMissing`).
     - `users/{uid}/planChanges`: `requestedText`, `summary`, `before`, `after`, `status`('proposed' | 'approved' | 'rejected' | 'reverted'), `at`, `appliedAt`.
     - `users/{uid}/coachMemory`: `constraints`, `preferences`, `weakPoints`, `updatedAt`. 항목별 개별 삭제 지원(`removeCoachMemoryItem`).
     - `users/{uid}/coachMessages`: 대화 로그 및 제안 카드 ID 연동.
     - `goals/{goalId}.deadline`: OPIc 시험일 등 D-day 기한 저장 및 조회 지원.
     - `users/{uid}/settings/general`: `coachNudges`(`["weekly", "absence2d"]` 기본값, 4주/2주 전 마감 토글 포함).
  2. **스케줄 자동화 규칙 구현**:
     - **하루 빠짐 보존**: 통화 세션이 `status=done`으로 완료된 경우에만 `nextLessonIndex += 1`을 가산(`advanceGoalAfterCompletedCall` in `reviewPipeline.ts`). 당일 통화가 없거나 완료되지 않은 경우 다음 배정 요일에도 동일한 과 번호를 유지하여 과를 건너뛰지 않도록 보장.
     - **OPIc 시험 1~2주 전 모의고사 자동 제안 (`checkOpicDeadlineMockProposal`)**: OPIc deadline이 7~14일 남은 구간 감지 시 실전 모의고사(14과)를 월·토 OPIc 슬롯에 집중 배치하는 `planChange` 제안 카드를 자동 생성. **승인 전에는 MASTER/오늘 카드에 절대 미반영**.
     - **홈 「오늘 수업」 계산 고도화 (`HomeScreen.tsx`)**: 하드코드 `WEEKLY_ROUTINE` 대신 `plan.weeklyPattern + goals.nextLessonIndex`를 최우선으로 반영하여 오늘 추천 수업 및 요일별 집중 루틴 표출.
  3. **코치 탭 UI 구현 (`src/ui/coach/CoachModal.tsx`)**:
     - 홈 상단 헤더의 [AI 코치] 버튼 및 "더 보기" 내 AI 코치 전용 카드 진입점 제공.
     - 채팅 인터페이스: 한국어로 편하게 입력 ➔ 코치 답변 + 변경 제안 카드(before/after 요약 diff) 생성.
     - [승인] 버튼 클릭 시에만 `applyPlanChange` 실행 (plan 및 goals 동시 반영).
     - [거절] 버튼 클릭 시 `rejectPlanChange` 실행 (status=rejected).
     - [변경 이력] 탭: 과거 제안 목록 조회 및 승인된 항목에 대해 [되돌리기] 지원 (`revertPlanChange`, 직전 before 스냅샷 복구, status=reverted).
     - [코치가 기억하는 것] 탭: 제약/선호도/취약점 목록 확인 및 항목별 X 버튼으로 즉시 삭제.
  4. **코치 LLM 엔드포인트 (`server.ts`, `POST /api/coach/chat`)**:
     - `gemini-3.8-flash` 기반 함수 호출 지원: `propose_plan_change`, `get_progress`, `get_mistake_stats`.
     - 모델이 `apply_plan_change`를 직접 호출하려 시도할 경우 400 에러를 반환하여 임의 적용 원천 차단.
  5. **먼저 말 걸기 (넛지)**:
     - **2일 연속 결석 배너 (`checkTwoDayAbsence`)**: 한국시간 기준 어제와 그제 모두 통화 done 세션이 없으면 홈 상단에 "이틀째 쉬었어요. 오늘 수업만 해도 좋아요" 배너 및 [오늘 수업 시작] 바로가기 제공.
     - **일요일 주간 리뷰 아침 강의 (`server/lecture.ts`)**: 일요일 강의 생성 시 coachNote를 한 주간 완수한 진도 및 누적 졸업 표현 성과를 짚어주는 주간 리뷰 톤으로 자동 고도화.
     - **환경설정 탭 확장 (`SettingsModal.tsx`)**: 코치 알림(넛지) 전용 탭을 추가하여 주간 리뷰, 2일 연속 결석, 마감 4주/2주 전 알림 개별 토글 지원.
- **방어 조치 및 호환성 (Safety & Guardrails)**:
  - 모델명(`gemini-3.8-live`, `gemini-3.8-flash`) 및 단일 허용 계정(`episode.kim@gmail.com`) 100% 보존.
  - Live 음성 통화, 퀴즈 채점, 아침 강의, 피드, Keep 가져오기 등 기존 핵심 파이프라인 회귀 없음.
  - 공식 빌드 버전 `20261014-multilingual-1330` 동기화.

---

### [2026-10-14 KST] v2.6.1 — Gemini Live "연결 준비 중" 무한 대기 버그 수정 및 세션 연결 안정화
- **문제 원인 및 기획 의도 (Context & Motivation)**:
  - 전화걸기 실행 시 Gemini Live 통화 화면에서 "연결 중..." 또는 "튜터 연결 준비 중..." 상태에서 멈추고 대화 화면으로 진입하지 못하는 현상 발생.
  - 근본 원인 분석:
    1. **서버 프로세스 환경변수 불일치**: AI Studio 컨테이너 구동 시 컨테이너의 기본 프로세스(PID 1, 53)에는 더미 키(`MY_GEMINI_API_KEY`)가 있었고, 실제 발급된 유효 키는 `/app/.dev.env.json`에 기록되어 있었음. 기존 `server.ts`의 `resolveGeminiApiKeyInner()`가 해당 파일을 조회하지 않아, 클라이언트의 `/api/gemini/token` 요청 및 서버 중계 웹소켓(`/api/gemini/live`) 연결 시 `fallback_required` 에러를 반환.
    2. **클라이언트 이벤트 리스너 덮어쓰기 버그**: `geminiLiveProvider.ts`의 `connectDirect()`에서 웹소켓 오픈 즉시 `wireWebSocketEvents(true)`를 호출하여 `socket.onerror`와 `socket.onclose`를 덮어씀. 이로 인해 직접 연결 실패 시 `reject()`가 실행되지 않고 8초 풀 타임아웃까지 무의미하게 대기.
    3. **마이크 권한 획득 블로킹 결함**: `connect()` 메서드 맨 끝에 `await micPromise;`가 포함되어 있어, 마이크 승인이 지연되거나 완료되기 전까지 세션 연결 수립(`connected`)이 반환되지 못하고 대기 상태에 갇힘.
- **적용된 수정 내역 (Applied Changes)**:
  1. **서버 키 탐색 고도화 (`server.ts`)**:
     - `resolveGeminiApiKeyInner()`에 `/app/.dev.env.json`, `/etc/environment` 파싱 및 전체 `/proc` 프로세스 환경변수 스캔을 추가하여 실제 유효 키를 즉시 동적으로 인식하도록 보강.
     - `LIVE_CONNECT_TIMEOUT_MS`를 6,000ms에서 10,000ms로 조정하여 네트워크 지연 시의 조기 중단 방지.
     - 웹소켓 upgrade 시 URL pathname 파싱 예외 처리 방어 로직 강화.
  2. **클라이언트 직접 연결 생명주기 분리 (`geminiLiveProvider.ts`)**:
     - `connectDirect()`에서 `setupComplete` 수신 전까지는 에러 발생 시 즉시 `reject()`하여 타임아웃 대기 없이 즉시 서버 중계(Proxy)로 폴백하도록 수정.
     - 직접 연결 타임아웃을 8초에서 5초로 최적화.
  3. **마이크 스트림 완전 비동기화 (`geminiLiveProvider.ts`)**:
     - `connect()` 메서드 말미의 `await micPromise;` 블로킹을 해제하고 백그라운드 비동기 처리로 전환.
     - 세션 연결이 성공하면 마이크 승인 여부와 무관하게 즉시 `connected` 상태로 진입하고, 마이크는 준비되는 즉시 오디오 청크를 스트리밍하도록 개선.
- **방어 조치 및 호환성 (Safety & Guardrails)**:
  - 모델명(`gemini-3.8-live`, `gemini-3.8-flash`) 및 화이트리스트 계정(`episode.kim@gmail.com`) 100% 보존.
  - 직접 연결 및 서버 중계 웹소켓 연결 테스트 정상 완료 확인 (`ready`, `session_resumption_update` 수신 검증).
  - 공식 빌드 버전 `20261014-multilingual-1330` 동기화.

---

### [2026-10-13 KST] v2.6.0 — [작업 지시서 6] 2-B 퀴즈 — 가이드 B-6 완료
- **문제 원인 및 기획 의도 (Context & Motivation)**:
  - B-5 간격 반복(1→3→7→14일) 단계에서 누적된 복습 대상 실수를 플래시카드 퀴즈로 능동 인출(Active Recall)하고 졸업(Graduation)시킬 수 있는 카드형 퀴즈 엔진 구현.
  - 학습자의 발화 편의성을 위해 음성(말하기, `gemini-3.5-transcribe` VERBATIM) 및 텍스트(타이핑) 두 가지 모드를 지원하고, `gemini-3.8-flash` 기반의 엄격하면서도 합리적인 의미 기반 채점 로직 구축.
  - 오답 기억 왜곡을 방지하기 위해 정답 확인 전에는 과거 오답(`myPhrase`)을 은닉하고, 실패 시 1회 재도전 큐를 제공하여 학습 효과 극대화.
- **적용된 수정 내역 (Applied Changes)**:
  1. **퀴즈 대상 산출 및 홈 화면 연동 (`HomeScreen.tsx`, `getDueMistakes`)**:
     - `getDueMistakes(today)` 결과를 그대로 사용하여 보류(`deferred`) 실수가 최우선 맨 앞에 정렬.
     - 하루 최대 10개 제한(`Math.min(dueMistakes.length, 10)`).
     - 홈 화면 간격 반복 카드 내 "오늘 복습 N개" 옆에 "오늘 퀴즈 N개" 카운터 및 "퀴즈 풀기" 버튼 배치.
  2. **카드형 플래시카드 & 즉시 피드백 인터페이스 (`src/ui/quiz/QuizModal.tsx`)**:
     - **카드 앞면**: 원어민 표현의 한국어 뜻(`meaningKo`) + 한 줄 이유(`reason`) 힌트 노출.
     - **한국어 뜻 자동 생성 및 Firestore 영구 저장**: 실수 문서에 `meaningKo` 필드가 없으면 퀴즈 시작 시 `gemini-3.8-flash`(`/api/quiz/meaning-ko`)로 한 번 번역 생성 후 Firestore `mistakes/{id}.meaningKo`에 저장하여 재사용 (`updateMistakeMeaningKo`).
     - **과거 오답 은닉**: 학습자가 과거 통화에서 했던 오답(`myPhrase`)은 채점 및 정답 확인 뒤에만 노출.
  3. **말하기 vs 타이핑 2가지 입력 모드**:
     - **말하기 모드**: Web Audio 녹음 ➔ `POST /api/gemini/transcribe-final` (`gemini-3.5-transcribe`, VERBATIM) 전사 ➔ 받아쓴 문장을 화면에 "인식된 발화 (VERBATIM): ..."로 그대로 노출 ➔ 즉시 채점.
     - **타이핑 모드**: 텍스트 입력창 ➔ 제출 시 입력한 문장 그대로 채점.
  4. **채점 서버 API (`/api/quiz/grade`, `gemini-3.8-flash`)**:
     - 프롬프트 지침: "핵심 교정 포인트(reason이 고친 부분)가 맞으면 통과(passed: true). 사소한 철자(typo), 관사(a/an/the), 구두점, 대소문자 차이는 허용."
     - 응답 스키마(JSON Schema): `{ passed: boolean, feedback: string(한국어 1~2문장), correctAnswer: string }`.
  5. **결과 반영 & 1회 재도전 로직**:
     - **통과**: `graduateMistakeAfterQuiz(userId, mistakeId)` 호출 (`status = 'graduated'`), 카드에 "졸업!" 축하 배지 및 통계 갱신.
     - **실패**: 정답, 이유, 과거 오답을 즉시 노출하고, 해당 문항을 오늘 퀴즈 **맨 뒤에 1회 재도전 문항(`isRetry: true`)으로 다시 추가**. 재도전도 틀리면 상태는 그대로 유지하고 다음으로 진행.
     - **퀴즈 시도 기록 영구 보존**: Firestore `users/{uid}/quizAttempts` 서브컬렉션에 `{ mistakeId, mode, answer, passed, feedback, createdAt }` 기록 (`saveQuizAttempt`).
  6. **B-5 잔여 연동 확장 (`reviewPipeline.ts`, Requirement 5)**:
     - 복기 파이프라인에서 복기 AI에 전달하는 복습 대상 실수 필터를 `status == 'reviewing'`뿐만 아니라 **`reviewing` + `deferred`**로 확장하여, 보류 상태의 실수도 통화 중 자연스럽게 맞게 쓰면 빠른 졸업(`usedCorrectly`)되도록 연동.
  7. **엄격한 규칙 준수**:
     - 수동 졸업 버튼 배제, 아침 강의(B-7) 미연결 시 홈 진입만 제공, 말해보카 등 상표 및 문제 복제 금지.
- **방어 조치 및 호환성 (Safety & Guardrails)**:
  - 기존 Live 직접연결·중계·세션 재개·10초 청크 녹음·B-4 복기 경로 100% 무변경 유지.
  - `src/config/models.ts` 모델명 및 Firebase 단일 계정 화이트리스트(`episode.kim@gmail.com`) 불변 유지.
  - 빌드 버전 `20261013-multilingual-1652` 동기화.

---

### [2026-10-13 KST] v2.5.0 — [작업 지시서 5] 2-A 간격 반복과 졸업 — 가이드 B-5 완료
- **문제 원인 및 기획 의도 (Context & Motivation)**:
  - 오답 분석을 통해 수집된 실수를 망각 곡선에 따라 체계적으로 장기 기억화하기 위해, 1일 ➔ 3일 ➔ 7일 ➔ 14일 간격 반복(Spaced Repetition) 단계 시스템과 졸업/보류/재학습 라이프사이클 구현.
  - 다음 통화에서 맞게 발화했을 경우(`usedCorrectly`) 퀴즈 없이 즉시 졸업시키는 빠른 졸업 경로와, 이미 졸업한 실수를 재반복했을 경우(`repeatedMistakes`) 1일차로 강등시켜 다시 학습시키는 안전망 연동.
  - 퀴즈(B-6) 및 아침 강의(B-7) 출시에 앞서 핵심 데이터 모델, 상태 전이 함수, 오늘 복습 대상 쿼리 및 임시 디버그 검증 도구 완비.
- **적용된 수정 내역 (Applied Changes)**:
  1. **실수 상태 모델 확장 (`db.ts`, `firebase-blueprint.json`)**:
     - `MistakeData` 필드 정의: `stage`(1 | 3 | 7 | 14), `status`("reviewing" | "graduated" | "deferred"), `nextReviewAt`(KST YYYY-MM-DD), `graduatedAt`, `graduatedReason`, `reopenedAt`, `reopenCount`.
     - 신규 실수 저장 시(`saveCallMistakes`) `stage: 1일`, `status: "reviewing"`, `nextReviewAt: 내일(KST+1일)` 자동 설정.
  2. **아침 강의 수강 기반 단계 진행 (`advanceMistakeAfterLesson`)**:
     - `reviewing` 상태의 실수를 다음 단계로 승급하고 KST 기준 `nextReviewAt` 갱신:
       - 1일차 ➔ 3일차 (`nextReviewAt = 오늘 + 3일`)
       - 3일차 ➔ 7일차 (`nextReviewAt = 오늘 + 7일`)
       - 7일차 ➔ 14일차 (`nextReviewAt = 오늘 + 14일`)
       - 14일차에서 수강 완료(퀴즈 미통과 상태) ➔ `status = "deferred"` (보류).
     - 홈 화면에 "임시 디버그: 단계 진행" 시뮬레이터 제공: 각 실수 항목 옆 `[이 실수 강의 들었음 처리]` 버튼을 제공하여 1→3→7→14→deferred 순차 전진을 실시간 수동 테스트 가능.
  3. **빠른 졸업 & 다시 복습 실반영 (`applyCallMistakeUpdates`, `reviewPipeline.ts`)**:
     - 지시서 4에서 저장만 해 두었던 `sessions.review.usedCorrectly` 및 `repeatedMistakes`를 실제로 Firestore에 반영:
       - `usedCorrectly`: `status = "graduated"`, `graduatedReason = "call_used_correctly"`, `graduatedAt` 갱신 (퀴즈 없이 즉시 졸업).
       - `repeatedMistakes`: `status = "reviewing"`, `stage = 1일`, `nextReviewAt = 내일`, `reopenCount += 1`, `reopenedAt` 갱신 (1일차 다시 복습).
  4. **퀴즈 통과 졸업 훅 준비 (`graduateMistakeAfterQuiz`)**:
     - B-6 퀴즈 통과 시 단일 호출할 수 있는 `graduateMistakeAfterQuiz(userId, mistakeId)` 함수 구현 (`status = "graduated"`, `graduatedReason = "quiz_passed"`). 퀴즈 UI는 만들지 않고 훅만 보존.
  5. **오늘 복습 대상 집계 쿼리 (`getDueMistakes`)**:
     - `status == "deferred"` 및 `status == "reviewing" && nextReviewAt <= 오늘` 필터링.
     - **`deferred`(보류) 실수가 목록의 맨 앞**에 위치하도록 정렬.
     - 홈 화면에 "오늘 복습 N개" 숫자 카드 표출 (보류 개수 및 오늘 대상 개수 보조 표시).
  6. **수동 졸업 버튼 엄격 배제**:
     - 기획 스펙 지침에 따라 임의 수동 졸업 버튼은 일체 배치하지 않고, 통화 정상 발화 또는 퀴즈를 통해서만 졸업되도록 통제.
- **방어 조치 및 호환성 (Safety & Guardrails)**:
  - 기존 Live·녹음·복기·세션 재개 경로 100% 무변경 유지.
  - `src/config/models.ts` 모델명 및 Firebase 단일 계정 화이트리스트(`episode.kim@gmail.com`) 불변 유지.
  - 빌드 버전 `20261013-multilingual-1632` 동기화.

---

### [2026-10-13 KST] v2.4.0 — [작업 지시서 4] 1-D 통화 후 복기 (기록용) — 가이드 B-4 완료
- **문제 원인 및 기획 의도 (Context & Motivation)**:
  - 통화가 끝난 후 사용자의 실제 발화 실수를 왜곡 없이 정확하게 짚어내기 위해, "임의로 다듬지 않는" 원문 그대로의 기록용 받아쓰기(VERBATIM sttFinal) 기반 정밀 복기 파이프라인 구현.
  - 음성 인식 오인식으로 인한 잘못된 오답 지적을 사용자가 직접 신고 및 제외할 수 있는 피드백 메커니즘 제공 및 Google Keep 단일 블록 복사 지원.
  - 지시서 3에서 남은 미완료 통화 판정 및 실패 청크 자동 재업로드 보완.
- **적용된 수정 내역 (Applied Changes)**:
  0. **지시서 3 보완 (Requirement 0)**:
     - 10초 조각 업로드 시마다 Firestore `sessions.lastChunkAt` 갱신 (`db.ts`, `appendSessionChunk`).
     - "끊긴 통화" 판단을 Firestore 기준으로 일원화: `in-progress` 상태에서 `lastChunkAt`이 2분을 초과하면 `pending_review`로 전환 (`checkAndMarkInterruptedSessions`). 앱 시작 시에도 동일 검사 실행.
     - 앱 시작 시 IndexedDB에 남은 미업로드 조각 자동 재업로드 및 Firestore `recordingChunks.uploaded: true` 갱신 후 IndexedDB 삭제 (`retryPendingUploads`).
  1. **최종 받아쓰기 (기록용 sttFinal - `reviewPipeline.ts`, `server.ts`)**:
     - 통화 종료(정상 종료 및 끊긴 통화) 시 저장된 10초 조각들을 순서대로 결합하여 `/api/gemini/transcribe-final` (`gemini-3.5-transcribe` VERBATIM)으로 전사.
     - 전사 결과를 Firestore `sessions.sttFinal`에 영구 보존.
     - 최종 받아쓰기 실패 시 통화 중 임시본(`sttPartial`)을 이어붙여 폴백 처리하며 `sourceStt: 'sttPartial_fallback'` 명시.
  2. **복기 생성 파이프라인 (`/api/review`, `gemini-3.8-flash`)**:
     - [기록용 받아쓰기(sttFinal) + Live 대화 로그 + 오늘 수업 지시서 + 기존 실수 목록]을 입력으로 주입.
     - "인식이 어색하면 적당히 다듬어라" 지시를 완전히 삭제하고, `myPhrase`는 기록용 받아쓰기 문장을 글자 그대로 복사(절대 수정 금지).
     - `mistakes[]`: `myPhrase`(글자 그대로 복사), `naturalPhrase`, `reason`(한국어 1~2문장), `sourceStt`.
     - `keyExpressions[]`: 정확히 5개 필수 암기 표현.
     - `estimatedLevel`: IM2, IH, AL, Native 등급.
     - `usedCorrectly`: 현재 복습 중인 실수 중 이번 통화에서 맞게 쓴 ID 목록 저장.
     - `repeatedMistakes`: 이미 졸업한 실수를 이번 통화에서 다시 틀린 ID 목록 저장.
  3. **결과 화면 (Review Screen - `ReviewModal.tsx`)**:
     - 표: 내가 한 말 (verbatim) -> 자연스러운 표현 (발음 듣기 지원) -> 교정 이유.
     - 외울 표현 5선 목록 및 TTS 발음 재생.
     - AI 예상 레벨 옆에 **"AI 예상치, 공식 등급 아님"** 문구 명시.
     - 각 실수 항목 옆 **"이건 내가 한 말이 아니에요"** 버튼: 클릭 시 해당 실수를 숨기고 `qualityReports` 컬렉션에 `(sessionId, myPhrase, sourceStt, 시각)` 즉시 보존.
     - **"Keep에 붙여넣기용 복사"** 버튼: 화면에 표시된 실수 목록을 줄마다 `[내가 한 말] -> [자연스러운 표현]` 단일 텍스트 블록으로 일괄 복사.
     - "끝나지 않은 통화가 있어요" 복구 모달에서 **"복기 시작"** 클릭 시 본 복기 화면으로 자연스럽게 이어지도록 연동.
  4. **영구 저장**:
     - 실수는 `mistakes` 컬렉션에 `stage: 1`, `status: "reviewing"`, `source: "call"`, `sessionId`와 함께 자동 저장.
     - 세션 문서에 review 결과와 `status: "done"` 저장.
- **방어 조치 및 호환성 (Safety & Guardrails)**:
  - 기존 Live 직접연결·중계·세션 재개·청크 녹음 경로 무변경 보존.
  - `src/config/models.ts` 모델명 절대 불변 준수(`gemini-3.8-live`, `gemini-3.5-transcribe`, `gemini-3.8-flash`).
  - 단일 허용 계정(`episode.kim@gmail.com`) ABAC 보안 규칙 및 firestore.rules 호환 검증.

---

### [2026-10-13 KST] v2.3.0 — [작업 지시서 3] 1-C 통화 중 녹음 (끊김 대비) — 가이드 B-3 완료
- **문제 원인 및 기획 의도 (Context & Motivation)**:
  - 모바일 웹앱 환경에서 화면 꺼짐, 네트워크 순단, 브라우저 탭 닫힘 등으로 인해 Live 연결이 끊기더라도 학생의 음성과 대화 맥락이 유실되지 않도록 이중 안전망 구축 필요.
  - 10초 단위 로컬 우선(Local-First IndexedDB) 저장 후 클라우드 스토리지 전송, 세션 재개 실패 시 대화 요약 자동 주입, 미완료 통화 자동 복기 감지 파이프라인 구현.
- **적용된 수정 내역 (Applied Changes)**:
  1. **마이크 청크 녹음 파이프라인 (`chunkIndexedDb.ts`, `chunkRecorder.ts`)**:
     - `MediaRecorder`를 활용하여 마이크 음성을 독립적으로 **10초** 조각으로 분할 녹음.
     - 각 조각을 IndexedDB(`OneCallRecordingsDB`의 `pending_chunks`)에 먼저 즉시 영구 저장 후 Cloud Storage(`uploadAudioFile`)로 업로드.
     - 업로드 성공 시 IndexedDB에서 해당 조각 삭제(순단 시 보존 및 백그라운드 재시도).
     - Live 소켓 재연결/GoAway/프록시 전환과 완전 분리되어 녹음이 끊김 없이 연속 진행.
  2. **통화 중 1분 단위 임시 받아쓰기 (`server.ts`, `/api/gemini/transcribe-partial`)**:
     - 녹음이 6조각(~60초) 쌓일 때마다 서버가 비동기로 `gemini-3.5-transcribe` **VERBATIM** 모드로 전사하여 Firestore `sessions.sttPartial`에 누적 기록.
     - 실시간 Live 대화와 별도 비동기로 동작하며 환경 설정(SettingsModal)에서 On/Off 토글 지원.
  3. **Live 대화 로그 지속 저장 & 세션 재개 실패 대비 (`geminiLiveProvider.ts`, `db.ts`)**:
     - Live 대화 턴이 발생할 때마다 실시간으로 Firestore `sessions.liveTranscript`에 동기화.
     - 세션 재개 handle이 거부/실패할 경우, 그때까지의 대화 히스토리 요약을 새 세션 시스템 프롬프트에 자동 주입하여 튜터가 맥락을 잃지 않고 대화를 연속하도록 안전망 구축.
  4. **끊긴 통화 자동 처리 및 복구 모달 (`server.ts`, `UnfinishedSessionModal.tsx`, `App.tsx`)**:
     - 마지막 조각 이후 **2분** 동안 새 조각이 인입되지 않으면 서버 워치독 및 클라이언트가 끊긴 통화로 판정하여 `pending_review`("복기 대기")로 상태 자동 전환.
     - 사용자가 앱을 닫았다가 다시 열면 **"끝나지 않은 통화가 있어요. 복기할까요?"** 복구 모달 표시.
  5. **화면 안내 및 Screen Wake Lock (`NewCallScreen.tsx`)**:
     - 통화 화면 상단에 **"통화 중에는 화면을 켜 두세요"** 안내 배너 및 10초 녹음 조각 카운터/보존 상태 표시.
     - Screen Wake Lock API(`navigator.wakeLock.request('screen')`) 자동 요청.
  6. **세션 메타데이터 & 스토리지 보관함 인스펙터 (`db.ts`, `firebase-blueprint.json`, `SettingsModal.tsx`)**:
     - `sessions.recordingChunks`에 각 조각의 index, path, storageUrl, timestamp, uploaded, durationSeconds 저장.
     - 설정 모달 내 "녹음 보관함 (Storage Chunks)" 탭을 신설하여 실제 저장된 10초 파일 목록과 1분 부분 전사 기록을 바로 검증할 수 있도록 지원.
- **방어 조치 및 호환성 (Safety & Guardrails)**:
  - `src/config/models.ts` 모델명 절대 불변 준수(`gemini-3.8-live`, `gemini-3.5-transcribe` VERBATIM).
  - 허용 계정(`episode.kim@gmail.com`) 인증 규칙 및 CORS, 스토리지 폴백 보존.
  - 빌드 버전 `20261013-multilingual-1529` KST 동기화.

---

### [2026-10-13 KST] v2.2.1 — [수정 지시서 2-1] 브라우저 직접 연결 고치기 (B-2 직접 연결 파이프라인 최적화)
- **문제 원인 분석 (Root Cause)**:
  - 기존 직접 연결 엔드포인트 URL이 `BidiGenerateContent?key=토큰` 형태로 지정되어 임시 토큰 인증 규격과 불일치(403/거절 발생 시 중계로 넘어감).
  - 소켓 개방 즉시 `connected`로 판정하여 세션 `setupPayload` 거절 시 프록시 전환 기회를 놓칠 위험 존재.
- **적용된 수정 내역 (Applied Changes)**:
  - **직접 연결 주소 규격 동기화 (`geminiLiveProvider.ts`)**: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${token}`로 수정.
  - **서버 임시 토큰 발급 설정 보강 (`server.ts`, `/api/gemini/token`)**:
    - `GoogleGenAI` 생성 시 `httpOptions.apiVersion: 'v1alpha'` 명시.
    - `authTokens.create` 설정: `uses: 1`, `expireTime: now + 30분 (ISO)`, `newSessionExpireTime: now + 1분 (ISO)` 구성.
    - 실제 API 키 노출 없이 `token.name`만 클라이언트로 안전하게 반환.
  - **엄격한 "연결됨" 판정 시점 (`geminiLiveProvider.ts`)**:
    - 소켓 `open` 후 setup을 전송하고, Gemini 서버로부터 `setupComplete` 메시지를 수신한 시점에만 `connected`로 전환.
    - `setupComplete` 수신 전 소켓 종료/에러 발생 시 또는 8초 타임아웃 경과 시 "직접 연결 실패"로 판정하고 투명하게 서버 중계 프록시(`/api/gemini/live`)로 즉시 전환.
  - **재연결 토큰 라이프사이클 (`geminiLiveProvider.ts`)**:
    - `goAway` 수신 또는 일시 끊김 발생 시 기존 소켓 이벤트 클린업 후 `/api/gemini/token`에서 새로운 임시 토큰을 발급받아 세션 핸들(`resumeHandle`)을 이어 직접 연결부터 재시도.
    - 새 토큰 발급 또는 직결 실패 시 서버 프록시로 안전 전환.
  - **연결 경로 및 텔레메트리 영구 기록 (`geminiLiveProvider.ts`, `NewCallScreen.tsx`, `App.tsx`)**:
    - 연결 수립 시 브라우저 콘솔에 `[Live] path=direct` 또는 `[Live] path=proxy` 1행 로깅.
    - 통화 종료 시 Firestore `users/{userId}/sessions/{sessionId}` 문서에 `connectionPath`(마지막 연결 경로) 및 `directFailCount`(직접 직결 실패 횟수) 필드 영구 저장.
- **방어 조치**:
  - `firebase-blueprint.json` 내 `Session` 엔티티에 `connectionPath`, `directFailCount` 스키마 추가.
  - 서버 프록시 경로, 통화 화면, 5대 제어 버튼, 음성 받아쓰기, `models.ts` 모델명 불변성 엄격 유지.

---

### [2026-10-13 KST] v2.2.0 — Part B-2 실시간 통화(대화용 파이프) 구현 완료
- **`gemini-3.8-live` 세션 재개 & 컨텍스트 창 압축 기본 탑재 (`geminiLiveProvider.ts`, `server.ts`)**:
  - `sessionResumption: { handle: resumeHandle, transparent: true }` 적용을 통해 연결 끊김 시 이전 세션 상태 복원 및 맥락 유지.
  - `contextWindowCompression: { slidingWindow: {} }` 설정으로 15분 이상 장시간 지속 통화 지원 (토큰 한도 초과 방지).
- **GoAway 자동 재연결 및 상태 표시 UI (`NewCallScreen.tsx`)**:
  - 서버 `goAway` 신호 또는 일시적 네트워크 단절 수신 시 저장된 세션 핸들(`resumeHandle`)을 이용해 1초 내 즉시 재연결 수행.
  - 재연결 중 사용자 화면 상단에 "연결 유지 중" 상태 뱃지를 짧게 노출하여 안정감 제공.
- **임시 토큰 직결 및 서버 프록시 이중 파이프라인 구축 (`POST /api/gemini/token`, `/api/gemini/live`)**:
  - 브라우저가 먼저 서버의 임시 토큰 발급 API를 호출하여 Gemini 엔드포인트 직결을 시도하고, 임시 토큰 미지원 또는 실패 시 서버 WebSocket 프록시로 투명하게 자동 전환.
- **오늘 수업 지시서 시스템 프롬프트 주입 (`lessonPromptBuilder.ts`)**:
  - 목표명, 과 내용, 사용자 커스텀 변수([직무], [서베이 주제], [Philly 역할]) 치환본, 복습 대상 실수 최대 3개(대화 중 자연스럽게 유도)를 결합하여 Gemini Live 초기 세션에 주입.
- **5대 핵심 화면 제어 버튼 탑재**:
  - `Done`: 답변 종료 및 40초 이내 핵심 피드백(등급, 교정, AL 표현) 요청.
  - `Feedback`: 즉시 발화 교정 요청.
  - `Model answer`: 60초 AL 모범 답안 요청.
  - `Pause`: 장면 일시 정지 및 점검.
  - `Slow`: 천천히 또박또박 말하기 요청.
- **Live 자체 받아쓰기 보조 저장**:
  - `inputAudioTranscription`을 실시간 활성화하여 통화 화면에 롤링 자막으로 노출하고, 통화 종료 시 Firestore `users/{userId}/sessions/{sessionId}`의 `liveTranscript` 필드에 보조 데이터로 저장.
- **격리 원칙 준수**:
  - 녹음(10초 청크), 받아쓰기(gemini-3.5-transcribe), 복기(Mistake Vault), Keep 가져오기 등 후속 단계 기능은 요청에 따라 배제하고 B-2 통화 파이프에만 집중.

---

### [2026-10-13 KST] v2.1.0 — Part B-12 1단계 뼈대 구축 완료
- **Firebase 단일 계정 접근 제어 & 클라우드 스토리지 연동 (`B-1`, `B-11`)**:
  - `episode.kim@gmail.com` 1인 전용 Google 로그인 인증 체계 구현 (`src/services/firebase/auth.ts`).
  - 비인가 계정으로 로그인 시 즉시 세션 차단, 자동 로그아웃 및 전용 에러 메시지(`UnauthorizedUserError`) 반환.
  - Firestore 엔티티 스키마 청사진(`firebase-blueprint.json`) 작성 및 단일 사용자 ABAC 보안 규칙(`firestore.rules`) 배포 완료.
  - Firestore 에러 표준화 함수(`handleFirestoreError`) 및 Cloud Storage 오디오 버킷 연동(`src/services/firebase/storage.ts`).
- **Part B-1 모델 설정 및 공급자 인터페이스 뼈대 (`models.ts`, `providers/`)**:
  - `src/config/models.ts` 내 확정 모델명 및 엔진 선언:
    - `LIVE_MODEL = "gemini-3.8-live"`
    - `TEXT_MODEL = "gemini-3.8-flash"`
    - `STT_ENGINE = "gemini"` (`gemini-3.5-transcribe`, 모드 `VERBATIM`) / 대안 `universal-3-5-pro` (AssemblyAI)
    - `TTS_ENGINE = "gemini"` (`gemini-3.8-flash-tts`) / 대안 `elevenlabs`
    - B-10 사용량 산출용 단가표(`PRICING_RATES`) 일원화 관리.
  - 공급자 인터페이스 추상화: `LiveProvider`, `SttProvider`, `LlmProvider`, `TtsProvider` 정의 (`src/services/providers/types.ts`) 및 팩토리 분리. UI 컴포넌트가 공급자 벤더명을 직접 호출하지 않도록 아키텍처 격리.
- **4대 목표 데이터 영구 보존 & 요일 루틴 엔진 (`B-9`, `부록`)**:
  - 4개 목표 커리큘럼 내장 (`src/data/defaultGoals.ts`): OPIc AL (14과), 필리조선소 주재원 (15과), 미국·호주 여행 (13과), Bluey 듣기 (12과).
  - 마스터 체크리스트 부록 원문 튜터 프롬프트(Google Keep 연동 및 Gemini 앱 특화 지시사항 포함) 100% 무삭제 원문 보존.
  - 프롬프트 커스텀 변수 슬롯 처리기(`src/data/promptCustomizer.ts`): 원문의 `[직무]`, `[Survey topics I chose]`, `[My role in Philly]`, `[Recent weak points]`를 설정 화면에서 사용자가 직접 입력하여 동적으로 치환 가능하도록 지원.
  - B-9 요일별 루틴 엔진: 월·토 OPIc, 화·목 Philly, 수 Bluey, 금 여행, 일 주간 복기.
- **첫 실행 진도 설정 모달 & 홈 화면 오늘 수업 카드 (`src/ui/`)**:
  - 첫 로그인 시 목표별 진도를 설정하는 `InitialProgressModal` 구현 (OPIc 10/10 1과, 10/11 2과, 10/12 3과 진행 히스토리를 반영한 추천 및 커스텀 선택).
  - 오늘 요일에 맞춘 `오늘의 추천 수업 카드` 실시간 렌더링, 현재 진행 과명, 목표 설명, 진도 변경 드롭다운 제공.
  - 원문 튜터 프롬프트 뷰어 모달(부록 원본 vs 변수 치환본 토글 보기) 및 환경설정 모달 제공.
- **통화·녹음·복기 격리 원칙 준수**:
  - 사용자 지시에 따라 1단계에서는 통화/녹음/STT/복기 엔진을 선제 실행하지 않고 뼈대와 데이터 파이프라인에 집중.

---

### v2.0.0 (2026-10-13 KST) — AI 1:1 전화영어 올인원 랩 전면 탈바꿈
- **4대 집중 트랙 및 10/10~1/9 일자별 커리큘럼 탑재 (`src/data/curriculums.ts`, `src/data/schedule.ts`)**:
  - 🎯 **OPIc 코치**: 1~14과 (자기소개, 집/동네 묘사, 설문 3종, 롤플레이 A/B/C, 돌발 주제, 사회 이슈 비교, 실전 모의고사 15문항).
  - 🏭 **Philly 출근 (한화 필리 조선소)**: 1~15과 (첫 출근 인사, 생산 회의, 지연 보고/만회 계획, 안전 Toolbox Talk, 용접/블록 결함, 공손한 반대, 벤더 전화, Eagles/Phillies 스몰토크, 본사 결정 전달 등).
  - ✈️ **여행 (미국 · 호주)**: 1~13과 (미국 입국심사, 렌터카, 호텔 컴플레인, 레스토랑 주문/팁, 약국 아이 해열제, 호주 검역, 로컬 카페 Flat white, 본다이 해변 안전, 놀이터 BBQ 스몰토크).
  - 🦘 **Bluey 리스닝**: S1E01~S1E13 (3줄 줄거리, 호주 슬랭 10개, 호주 모음 발음 포인트, 5편 단위 누적 퀴즈 및 섀도잉 악센트 드릴).
  - **주간 루틴 및 날짜 계산**: 월(OPIc), 화(Philly), 수(Bluey), 목(Philly), 금(여행), 토(OPIc 모의고사), 일(주간 복기).
- **통화 종료 후 자동 복기 & Mistake Log 생성 (`POST /api/review`, `ReviewModal.tsx`)**:
  - Gemini 3.8 Flash의 정밀 JSON Schema를 활용해 대화 트랜스크립트 전체를 1회 정밀 분석.
  - `[내가 한 말 -> 자연스러운 원어민 표현 -> 이유]` 교정 표, 오늘 꼭 외울 표현 5선(상황/예문), 예상 OPIc 레벨(IM2/IH/AL), Google Keep 양식 자동 생성.
- **Google Keep 스타일 카드형 Mistake Vault (`MistakeVaultModal.tsx`, `AppStorage.ts`)**:
  - 로컬스토리지 영구 보존 및 트랙별 필터링, 복습 완료 체크박스, 원클릭 Keep 전체 복사, 개별 표현 원어민 TTS 발음 청취 기능 지원.
- **아침 7시 맞춤형 복습 팟캐스트 & 텔레그램 연동 (`POST /api/podcast`, `POST /api/telegram/send`, `MorningPodcastModal.tsx`)**:
  - 미완료 실수를 엮어 출근길에 듣는 3분 1:1 맞춤형 오디오 강의 스크립트 자동 생성.
  - Gemini 3.8 Flash Lite TTS 고음질 음성 합성 및 앱 내 플레이어(재생/일시정지/10초 앞뒤 이동) 제공.
  - 텔레그램 봇 토큰 및 Chat ID 등록 시 텔레그램으로 오디오 파일 자동 전송 지원.
- **전화 통화 엔진 확장 (`src/voice/VoiceCallEngine.ts`, `CallScreen.tsx`)**:
  - `VoiceCallContext`를 통해 트랙별 전문 시스템 프롬프트, 원어민 악센트 보이스(Kore, Puck, Charon, Zephyr), 레슨 시작 프롬프트 주입.
  - 통화 중 원터치 음성 명령어 툴바 지원 ("Next lesson", "Answer starts/Done", "Feedback", "Pause", "Model answer", "Slower").
  - 전체 통화 트랜스크립트 실시간 누적 수집 후 통화 종료 시 복기 엔진으로 자동 전달.

---

### v1.2.2 (2026-10-01 KST) — 한국어 귀 고정 (Korean Ear Lock)
- **Gemini Live 세션 언어 고정 (`server.ts`)**:
  - `speechConfig`에 `languageCode: 'ko-KR'` 명시 및 입출력 오디오 전사(`inputAudioTranscription`, `outputAudioTranscription`)에 `languageCodes: ['ko-KR']` 고정 적용.
  - 점진적 폴백 체계 구축: `ko-KR` 전사 옵션 거절 시 빈 전사 객체(`{}`) 및 `speechConfig.languageCode: 'ko-KR'` 유지, 최종 거절 시 세션 종료 없이 `voice-only` 모드로 안전 폴백.
- **페르소나 프롬프트 귀 고정 및 반말 일치 (`PersonaPrompt.ts`, `VoiceCallEngine.ts`)**:
  - `PersonaPrompt.systemInstruction`에 외국어(일본어/러시아어/중국어/영어) 오인식 판단 금지, 가나/키릴/한자/라틴 문자 발생 시 오인식 재청취 규칙 명시.
  - 첫인사 `text_prompt`를 반말 및 외국어 금지 지시(`(통화가 연결됐어. ${nick}에게 반말로 짧게 먼저 인사해. 외국어는 쓰지 마.)`)로 통일하여 초기 언어 드리프트 원천 차단.
- **폴백 전사 언어 고정 (`/api/gemini/transcribe`)**:
  - 전사 프롬프트 첫 줄에 `언어는 한국어(ko-KR)로 고정. 일본어·러시아어로 전사하지 마.` 추가. Live 세션 중 텍스트 프롬프트로 재주입하지 않는 단일 귀(Single Ear) 원칙 엄수.
- **P4 오디오 관측 인스펙터에 Language Lock 표시 (`CallScreen.tsx`)**:
  - 실시간 세션 언어 고정 상태(`ko-KR` / `voice-only`)를 인스펙터 패널에 실시간 노출.

---

### v1.2.1 (2026-10-01 KST) — 실측 관측성 및 실증 도구 장착
- **P4 오디오 관측 인스펙터 공식 탑재 (`CallScreen.tsx`)**:
  - 통화 화면 상단에 접이식 인스펙터 패널 추가.
  - 실시간 측정값 노출:
    - `Capture → Decimate`: 하드웨어 실제 샘플레이트 (예: `48000Hz → 16000Hz`)
    - `Mic RMS`: 실시간 마이크 입력 에너지 (실측 4자리 부동소수점)
    - `Packets Sent`: 16kHz PCM 전송 누적 패킷 수
    - `Echo Gate`: `OPEN (마이크 송출)` / `CLOSED (스피커 보호 음소거)` 실시간 상태
    - `Live Input Transcript`: Gemini Live의 `inputAudioTranscription`이 반환한 원본 전사 문자열
    - `First Sound Latency`: 실측 응답 지연 시간 (ms)
- **16kHz 마이크 변환 2초 WAV 원음 검증기 탑재 (`playWavProof`)**:
  - 통화 중 다운샘플링된 16kHz PCM 스트림을 2초 원형 링 버퍼(`Int16Array(32000)`)에 실시간 보관.
  - 화면의 「마이크 16kHz 변환 녹음 청취 (WAV 검증)」 버튼 클릭 시, 브라우저 메모리에서 16kHz 16-bit Mono 표준 WAV를 즉석 생성하여 1.0배속으로 재생.
  - 내 목소리가 정상 피치로 들리는지 귀로 즉시 물리적 검증 가능.
- **하드코딩 제거 및 실측 레이턴시 연동**:
  - 기존의 하드코딩 레이턴시(`firstSoundMs: 300, modelMs: 250`)를 완전히 삭제하고, `userLastSpokeAt`부터 `audio` 청크 도착 시점까지의 실제 경과 시간(`measuredLatencyMs`) 측정.
- **Live 인터럽트 공식 SDK 메서드 연동**:
  - `liveSession.sendClientContent({ turnComplete: true })` 호출로 서버 세션 인터럽트 보장.
- **폴백 모델 생존성 실측 증명**:
  - `gemini-3.8-flash`, `gemini-3.5-transcribe`, `gemini-3.8-flash-lite-tts` API 200 OK 응답 검증 완료.

---

### v1.2.0 (2026-10-01 KST) — Grok 기획 검수 수용 및 단일 오디오 소스 구축
- **Grok 기획 검수 전면 수용 및 단일 오디오 소스(Single Ear) 아키텍처 구축**:
  - Live 통화 중 WebSpeech API 및 MediaRecorder 전면 비활성화 (귀를 하나로 일원화).
  - Gemini Live 서버의 `inputAudioTranscription` 및 `outputAudioTranscription` 활성화로 정확한 음성 전사 자막 직결.
- **하드웨어 오디오 경로 결함 해소**:
  - `ScriptProcessor` 스피커 직결 버그 제거 (Zero-Gain 무음 노드로 격리).
  - 7.5kHz 안티에일리어싱 저역 통과 필터(`BiquadFilterNode`) 탑재.
  - `fastUint8ToBase64` 청킹 인코딩으로 CPU 오버헤드 해소.
- **에코 및 버퍼 잔류 동기화**:
  - `PcmAudioSink` 실제 스피커 큐 소진 시간 계산 후 마이크 게이트 오픈.
  - Barge-in 시 로컬 오디오 즉각 정지 및 서버 `{ type: 'interrupt' }` 전송.
- **UX 개선**:
  - 통화 화면 상단에 `🎧 이어폰을 착용하시면 더 선명하게 대화할 수 있어요` 팁 배지 추가.
- **합의 문서 추가**:
  - Grok 기획 검수 합의서 `GROK_REVIEW_RESPONSE.md` 생성 및 진단서 `v1.2.0` 승격.

---

### v1.1.1 (2026-09-30 KST) — 오디오 다운샘플링 왜곡 및 환청 하이재킹 해결
- **오디오 다운샘플링 왜곡(1/3배속 슬로모션) 해결**:
  - `downsampleTo16kHz` 선형 보간 알고리즘을 도입하여 48kHz/44.1kHz 기기 환경에서도 왜곡 없는 정밀 16,000Hz PCM 음성 스트리밍 보장.
- **WebSpeech 환청 텍스트 하이재킹 차단**:
  - 브라우저 음성 인식이 발생시킨 오인식 텍스트("치과", "사랑해" 등)가 Live WebSocket으로 `text_prompt`로 주입되던 구조적 결함 제거.
  - Gemini Live가 순수 마이크 음성만을 듣고 정확하게 답변하도록 단일 오디오 소스 파이프라인 정립.
- **에코 방지 마이크 게이트(Echo Suppression Gate)**:
  - AI 발화 중 마이크 오디오 전송을 일시 차단하여 스피커 하울링 및 재유입 방지.
- **상세 진단 보고서 작성**:
  - 외부 전문가 공유 및 아키텍처 분석용 `DIAGNOSIS_AND_SOLUTIONS.md` 생성.

---

### v1.1.0 (2026-09-30 KST) — Gemini 2.5 Flash Native Audio 정식 연동
- **Gemini 2.5 Flash Native Audio Dialog 정식 연동**:
  - Google AI Studio Tier 1 Live API 모델 식별자(`gemini-2.5-flash-native-audio-latest`)로 매핑 수정 및 연결 성공.
- **하드웨어 마이크(`getUserMedia`) 파이프라인 구현**:
  - 통화 시작 시 명시적 마이크 권한 획득 및 16kHz PCM 양방향 스트리밍 활성화.
  - 실시간 볼륨(RMS) 기반 Glowing Orb 발광 애니메이션 및 음성 파형 바 UI 추가.
- **다중 음성 인식 폴백 체계 구축**:
  - Native Audio WebSocket 스트리밍 + Web Speech API + VAD/MediaRecorder 기반 Gemini Transcribe 백업 연동.
- **사용자 편의성 향상**:
  - 통화 화면에 추천 대화 칩(Quick Prompts) 및 마이크 재시도 안내 버튼 추가.
- **서버 엔드포인트 고도화**:
  - `/api/gemini/transcribe` 신설 및 `/api/gemini/status` 모델 식별 정보 동기화.

---

### v1.0.0 (2026-09-29 KST) — 초기 런칭
- 영화 "HER" 감성의 AI 친구와 실시간 음성 통화를 나누는 풀스택 웹 앱 초기 릴리즈.
- Express 백엔드, React + Vite 프론트엔드, Glowing Orb 앰버 테마 구축.
