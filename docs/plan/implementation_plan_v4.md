# [One Call English] 기획안 v4 최종 (2026-10-13)

> **이 문서는 v3를 대체합니다. AI Studio에는 Part B만 붙여넣습니다.** (Part A는 상용화 전략, Part C는 로드맵이라 AI Studio에 넣지 않습니다.)
> 표시: [확인] 2026-10-13에 공식 문서 등에서 직접 본 것 / [추정] 근거를 적은 계산·판단 / [미확인] 확인 못 한 것 / [대기] 답을 기다리는 것.
> 오후 진행 순서는 별도 문서 [ai-studio-build-guide.md](ai-studio-build-guide.md)를 보세요.

## v3 대비 바뀐 점 (10줄)

1. 음성은 **대화용(Gemini 3.8 Live)과 기록용(별도 받아쓰기)으로 분리**. 실수 기록은 기록용 받아쓰기를 우선 사용.
2. 기록용 받아쓰기는 **통화 중 1분 단위로 임시 기록 + 통화 후 전체 녹음으로 최종 기록**(대화 속도에 영향 0, 중간에 끊겨도 그 시점까지 기록 보존).
3. **졸업 = 퀴즈 통과**(말하기/타이핑). 통화에서 맞게 쓰면 빠른 졸업, 졸업 후 같은 실수를 반복하면 다시 복습.
4. 통화 중 녹음을 **10초 조각으로 바로 저장**해서 끊겨도 복기 가능. 세션 재개는 그대로 필수.
5. 아침 강의 음성 기본값을 **Gemini TTS**로 변경. ElevenLabs는 설정으로 켜는 비교용.
6. **받아쓰기 품질 시험**(기존 실수 문장 녹음 → 3개 엔진 비교)을 1단계 완료 조건으로 당김.
7. 첫날부터 복습이 돌도록 **Keep 실수 목록 붙여넣기 가져오기** 추가.
8. 06:30 예약 서버 없이도 되도록, **그록봇이 피드 주소를 열면 강의가 없을 때 그 자리에서 생성**하는 방식 추가.
9. 코치가 먼저 말 거는 알림은 **주간 리뷰 + 이틀 연속 결석**만 기본.
10. 사용량·예상 비용은 1단계부터 표시. 기존 Keep·아침 강의 루틴은 찬식님이 바꾸라고 할 때까지 유지.

---

## Part A. 상용화 전략

### A-1. 제품 한 줄 정의
「내가 통화에서 틀린 말이, **틀린 그대로 기록되고** → 아침 강의·퀴즈로 복습되고 → 다음 통화에서 다시 쓰게 되는 AI 전화영어」

차별점 두 가지:
1. **AI 코치**: 목표를 대화로 듣고 계획을 짜고, 수시로 대화하며 고쳐 주는 학습 총괄.
2. **실수 루프**: 기록 → 아침 강의 → 퀴즈 / 통화 재사용 → 졸업.

| 역할 | 하는 일 | 사용자와 만나는 곳 |
|---|---|---|
| **코치** (계획 총괄) | 목표 설정, 일정 짜기·고치기, 진도 점검, 주간 리뷰 | 코치 탭(텍스트·음성), 아침 강의 끝 한마디, 푸시 |
| **튜터** (수업 담당) | 오늘 수업 통화, 즉석 교정 | 통화 화면 |

코치가 "오늘 수업 지시서(목표, 과, 복습할 표현)"를 튜터에게 넘기고, 통화 결과는 다시 코치에게 돌아옵니다.

### A-2. 트랙은 코치가 만드는 "목표"
고정 4개 트랙은 없습니다. 사용자마다 코치와 대화해 목표 1~4개를 만듭니다. 코치가 참고하는 기본 템플릿:

| 찬식님 목표 | 상용 템플릿 | 이유 |
|---|---|---|
| OPIc AL | **시험**: 시험 날짜로 일정 역산 | 마감이 있어 결제 동기가 강함 [추정] |
| 필리조선소 주재원 | **직무**: 회사·직무·국가 입력 → 상황극 생성, "조선·제조 현장" 기본 제공 | 회사명은 상품에 쓰지 않음 |
| 미국·호주 여행 | **여행**: 나라와 동행 선택 | 그대로 일반화 |
| Bluey 듣기 | **키즈 애니 듣기**: 자체 제작 가족 대화 오디오, 또는 사용자가 가진 대본 업로드 | Bluey 이름·대본은 제작사 저작물이라 상용 앱에 넣을 수 없음 |

테스트판은 찬식님 4개 목표를 같은 "목표" 구조로 미리 넣고, Bluey 대본은 개인 학습용으로 그대로 씁니다.

### A-3. 원가와 요금제 (모두 [추정], 단가는 구현 직전에 다시 확인)

매일 25분 통화 + 아침 강의 + 퀴즈를 하는 "열심 사용자" 1명의 월 원가:

| 항목 | 계산 | 월 원가 |
|---|---|---|
| 대화 (`gemini-3.8-live`) | 입력 25분×$0.005 + AI 말하기 10분×$0.018 = $0.31/일 [단가 확인] | 약 $9 |
| 기록용 받아쓰기 (`gemini-3.5-transcribe`) | 25분×약 $0.005 = $0.125/일 [단가 확인] | 약 $3.8 |
| 복기·강의 대본·퀴즈 채점 (`gemini-3.8-flash`) | 하루 몇 센트 | 약 $1 |
| 아침 강의 음성 (Gemini 3.8 Flash TTS) | 5분 = 30구간×$0.00225 = $0.07/일 [단가 확인] | 약 $2 (2027년부터 약 $4) |
| (선택) ElevenLabs v3 음성 | 2,504자×$0.08/1천자 = $0.20/일 [미확인: 플랜 포함량] | 약 $6 |
| 서버·DB | 사용자 적을 때 작음 | $1 미만 |
| **합계** | | **약 $17 (ElevenLabs 쓰면 약 $21)** |

비교: 스픽 프리미엄 앱 결제 월 29,000원(블로그 기준, 공식가 [미확인]). 앱스토어 수수료 15~30%.
→ 요금제는 **통화 분 단위**(예: 베이직 월 300분, 프리미엄 월 900분), ElevenLabs 목소리는 프리미엄 전용 후보, **베타 전에 1인당 원가 실측**을 통과 조건으로 둡니다. 녹음에서 침묵 구간을 잘라 받아쓰기에 보내면 기록용 비용을 줄일 수 있습니다 [추정].

### A-4. 법·약관

| 항목 | 내용 | 상태 |
|---|---|---|
| ElevenLabs 상업 이용 | 생성 음성 상업 이용은 유료 플랜 필요 | [확인] ElevenLabs 문서 |
| ElevenLabs 재판매·목소리 라이선스 | 앱 사용자마다 음성을 만들어 주는 구조가 허용되는지, SR·Lowy 목소리 상업 이용 가능 여부. 2026-10-13 11:41 문의 메일 발송 | [대기] **회신 전에는 유료 사용자에게 ElevenLabs 음성을 제공하지 않음** |
| Gemini API | 무료 등급 데이터는 Google 제품 개선에 사용 → 상용은 유료 등급만 | [확인] |
| AI 기본법 | 2026-01-22 시행. 생성형 AI 사용 **사전 고지** 의무(과태료 최대 3천만 원), 1년 이상 계도기간 | [확인] 법무법인 신앤김 |
| 개인정보 | 목소리 녹음은 개인정보. 해외 서버 전송 → 국외 이전 고지, 보관 기간, 삭제 기능 | [추정] 출시 전 전문가 검토 |
| 만 14세 미만 | 키즈 트랙은 녹음 꺼짐 기본, 보호자 동의 | [추정] |
| 아침 푸시 | 21~08시는 광고성 푸시 제한. 강의 알림에 광고 문구 섞지 않기 | [추정] KISA 원문 확인 필요 |
| 상표·콘텐츠 | 앱 이름·로고에 OPIc·Bluey 금지. 퀴즈는 말해보카 등 **화면 흐름만 참고**, 상표·문제 복제 금지 | [추정] |
| AI 레벨 | "공식 등급 아님, AI 예상치" 표시 | [추정] |

### A-5. 상용판 기술 구조
- 모든 데이터에 `userId`, Firestore 보안 규칙으로 본인 것만.
- **대화와 기록 분리**: 대화 상대는 `gemini-3.8-live`, 기록은 별도 받아쓰기. 나중에 대화 모델을 다른 회사(예: OpenAI 실시간 모델)로 바꿀 수 있게 **공급자 인터페이스**로 감싸고, 필요하면 LiveKit·Pipecat 같은 음성 중계 도구 도입 검토.
- 휴대폰이 Gemini에 직접 연결하고 서버는 **임시 토큰**만 발급 [확인: 이 기능은 아직 Preview]. 정식 전환 전까지는 서버 중계 방식을 대체 경로로 유지.
- LLM·TTS·STT(받아쓰기) 모두 인터페이스로 감싸고 모델 이름은 설정 파일 한 곳.
- 아침 강의는 사용자별 예약 작업 큐 → 끝나면 푸시. 최종 앱은 네이티브(Capacitor 등)로 푸시·백그라운드 재생·화면 꺼짐 중 녹음 보장.
- 사용량 계량(통화 분, 받아쓰기 분, TTS 글자, 토큰) → 요금제 한도, 원가 대시보드.
- **품질 측정 세트**를 계속 늘려서 모델을 바꿀 때마다 다시 잼(Part B 1단계에서 시작).

### A-6. AI 코치
**① 첫 실행 튜토리얼 (베타부터)**: 텍스트/음성 대화로 목표·마감·수준·가용 시간·선호 파악 → 3분 레벨 체크 통화 → 계획 카드 → 말로 수정 → 승인 버튼.
**② 코치 탭 (테스트판 3단계부터)**: "다음 주 출장이야", "시험이 11/29로 잡혔어" → 변경 전후 비교 → **승인해야 적용**. 승인 없이 계획 변경·기록 삭제 안 함. 변경 이력과 되돌리기.
**③ 먼저 말 걸기**: 기본값은 **일요일 주간 리뷰 + 이틀 연속 결석** 두 가지만. 마감 4주·2주 전 알림 등은 사용자가 켤 때만.
**④ 기억**: 목표, 마감, 가용 시간, 선호, 생활 사정, 반복 약점. 사용자가 보고 지울 수 있음.
**⑤ 구현**: `gemini-3.8-flash` + 함수 호출(`get_progress`, `get_mistake_stats`, `propose_plan_change`, `apply_plan_change`(승인 후만), `set_goal`, `pause_goal`, `set_exam_date`). 음성 코치는 `gemini-3.8-live` 함수 호출 [확인: 릴리스 노트], 승인은 화면 버튼.

### A-7. 성공 지표
| 지표 | 정의 |
|---|---|
| **실수 졸업률** | 기록된 실수 중 **퀴즈 통과 또는 통화에서 맞게 사용**한 비율 |
| 재발률 | 졸업한 실수 중 통화에서 다시 틀려 복습으로 돌아온 비율 |
| 받아쓰기 보존율 | 품질 세트에서 틀린 부분이 그대로 기록된 비율 |
| 아침 강의 완청률, 퀴즈 참여율 | 루프가 도는지 |
| 7일·30일 재방문율, 튜토리얼 완료율, 계획 승인율 | 습관·첫 경험 |
| 1인당 월 원가 | 가격 결정 근거 |

---

## Part B. 테스트판 스펙 (찬식님 1인, 웹) — AI Studio에 붙여넣을 부분

> 만들 범위: B-1 ~ B-12. 한 번에 다 만들지 말고 **B-12의 단계 순서대로** 하나씩 요청합니다.
> 2단계 이후의 서버 작업(오디오 이어 붙이기, 예약 생성)은 AI Studio만으로 불완전할 수 있습니다. 막히면 그 부분만 개발자에게 넘길 수 있도록 코드를 기능별 파일로 나눠 둡니다.

### B-1. 기본 설정
- 로그인: Firebase Authentication, 허용 계정 1개(찬식님 Google 계정)만. 다른 계정은 접속 거부.
- 저장: Firestore(데이터) + Cloud Storage(녹음·강의 오디오). 로컬스토리지는 임시 보관용으로만.
- 모델 설정 파일 `src/config/models.ts` 한 곳에서만 모델 이름 관리:
  - `LIVE_MODEL = "gemini-3.8-live"` (대화)
  - `TEXT_MODEL = "gemini-3.8-flash"` (복기·강의 대본·퀴즈 채점·코치)
  - `STT_ENGINE = "gemini"` → `gemini-3.5-transcribe`, 모드 VERBATIM (기록용 받아쓰기). 대안 `"assemblyai"` → Universal-3.5 Pro 비실시간(API 값이 공식 문서마다 `universal-3-5-pro` / `universal-3-pro`로 달라 구현 때 확인 [미확인]. 한국어 미지원이라 영어 발화 전용)
  - `TTS_ENGINE = "gemini"` → `gemini-3.8-flash-tts`. 대안 `"elevenlabs"`(설정에서 켬)
- 공급자 인터페이스: `LiveProvider`, `SttProvider`, `LlmProvider`, `TtsProvider`. 화면 코드는 공급자 이름을 직접 부르지 않음.
- 서버 비밀값: `GEMINI_API_KEY`(필수), `ASSEMBLYAI_API_KEY`(품질 시험용, 선택), `ELEVENLABS_API_KEY`·`ELEVENLABS_VOICE_NARRATOR`·`ELEVENLABS_VOICE_PARTNER`(선택), `FEED_SECRET`.

### B-2. 통화 (대화용 파이프)
- `gemini-3.8-live`로 실시간 대화. **세션 재개 + 컨텍스트 창 압축 필수** [확인: 연결 약 10분, 압축 없이 음성 15분 제한, 재개 토큰 2시간 유효]. GoAway 메시지를 받으면 자동 재연결하고 화면에는 "연결 유지 중"만 짧게 표시.
- 브라우저가 Gemini에 직접 연결하고 서버는 임시 토큰만 발급. (Preview 기능이라 실패하면 서버 중계로 전환할 수 있게)
- 통화 시작 시 "오늘 수업 지시서"를 시스템 프롬프트에 넣음: 목표, 과 내용, **복습 대상 실수 최대 3개**(대화 중 그 표현을 쓸 상황을 만들 것).
- 명령은 화면 버튼 기본: Done / Feedback / Model answer / Pause / Slow. 음성 명령은 보조.
- Live 자체 받아쓰기(입력 음성 받아쓰기)는 켜 두되 **보조 자료로만** 저장.

### B-3. 통화 중 녹음 (기록용 파이프의 재료, 끊김 대비)
- 마이크 소리를 **10초 조각**으로 녹음(MediaRecorder). 각 조각은 ① 브라우저 임시 저장소(IndexedDB)에 먼저 저장하고 ② 바로 Cloud Storage에 올림. 올라간 조각은 임시 저장소에서 삭제.
- Live 연결이 끊겨도 녹음은 계속. 통화 종료 버튼을 누르지 못하고 앱이 닫혀도, 다음 실행 때 "끝나지 않은 통화가 있어요. 복기할까요?"로 이어서 처리.
- **백업의 본체는 녹음 파일**입니다. 받아쓰기는 녹음만 있으면 언제든 다시 만들 수 있으므로, 끊긴 시점까지의 녹음은 10초 안에 서버에 안전하게 남습니다.
- **끊긴 직후 대화 이어가기**: Live 대화 로그(`liveTranscript`)도 통화 중 계속 저장. 세션 재개가 실패해 새 세션을 열어야 하면, 그때까지의 대화 로그 요약을 새 세션 시스템 프롬프트에 넣어 튜터가 앞 대화를 기억하게 함. (이 용도는 정확도보다 속도가 중요해서 Live 로그로 충분)
- **통화 중 1분 단위 받아쓰기(기본 켬)**: 녹음 조각이 1분 분량 쌓일 때마다 서버가 그 1분을 기록용 받아쓰기에 보내 `sttPartial[]`로 저장. 통화가 중간에 완전히 끝나 버려도 그 시점까지 기록이 이미 있고, 통화 후 복기도 더 빨리 끝남. 대화 속도에는 영향 없음(서버에서 따로 처리). 1분 경계에서 단어가 잘릴 수 있으므로 **최종 기록은 통화 후 전체 녹음으로 한 번 더 받아쓰기**해서 덮어씀. 비용은 같은 분량이 두 번 처리되어 기록용 비용이 약 2배(하루 약 $0.25 [추정]). 비용이 부담되면 설정에서 끌 수 있음.
- **한계 표시**: 웹앱은 화면이 꺼지거나 다른 앱으로 가면 녹음이 멈출 수 있음 [추정: 브라우저 동작]. 통화 화면에 "통화 중에는 화면을 켜 두세요" 안내 + 화면 꺼짐 방지(Wake Lock) 요청. 완전한 해결은 네이티브 앱(Part C).

### B-4. 통화 후 복기 (기록용 파이프)
1. 녹음 조각을 합쳐 `SttProvider`로 받아쓰기(기본 `gemini-3.5-transcribe`, VERBATIM). 통화 중 1분 단위 받아쓰기(B-3)는 임시본, 이 전체 받아쓰기가 최종본. 통화가 비정상 종료되면 다음 실행 때가 아니라 **서버가 마지막 조각 이후 2분 동안 새 조각이 없으면 자동으로 복기 시작**(서버가 잠들어 있어 못 했으면 다음 앱 실행 때 시작).
2. `gemini-3.8-flash`에 [기록용 받아쓰기 + Live 대화 로그 + 오늘 수업 지시서]를 넣어 JSON 생성:
   - `mistakes[]`: `myPhrase`(**기록용 받아쓰기의 문장 그대로**, 고쳐 쓰지 않음), `naturalPhrase`, `reason`, `sourceStt`(어느 엔진에서 왔는지)
   - `keyExpressions[]` 5개, `estimatedLevel`(화면에 "AI 예상치, 공식 등급 아님")
   - `usedCorrectly[]`: 복습 대상 중 통화에서 맞게 쓴 것 → 빠른 졸업
   - `repeatedMistakes[]`: 이미 졸업한 실수를 다시 틀린 것 → 복습 큐로 복귀
3. 결과 화면: 내가 한 말 → 자연스러운 표현 → 이유 표, 외울 표현 5개. 각 실수 옆에 "이건 내가 한 말이 아니에요" 버튼(받아쓰기 오류 신고, 품질 세트에 자동 추가).
4. Keep에 붙여넣을 텍스트 복사 버튼(백업용).

### B-5. 간격 반복과 졸업
| 상태 | 조건 |
|---|---|
| 복습 중 1일→3일→7일→14일 | 아침 강의를 들으면 다음 단계 |
| **졸업** | 그 실수의 **퀴즈 통과** |
| **빠른 졸업** | 통화에서 그 표현을 맞게 사용 (퀴즈 없이 졸업) |
| **다시 복습** | 졸업 후 통화에서 같은 실수 반복 → 1일 단계로 복귀 |
| 보류 | 14일 단계까지 갔는데 퀴즈를 안 함 → "보류" 표시, 퀴즈 목록 맨 앞에 노출 |
- 수동 "졸업" 버튼은 넣지 않음(필요하면 나중에 보조로).

### B-6. 퀴즈
- 대상: 오늘 복습 날짜가 된 실수 + 보류 실수. 하루 최대 10개.
- 방식(문항마다 선택): **말하기**(한국어 뜻 보고 영어로 말하기 → 녹음 → `SttProvider` 받아쓰기 → `gemini-3.8-flash` 채점) 또는 **타이핑**.
- 채점: 핵심 교정 포인트가 맞으면 통과(사소한 철자·관사 외 차이는 허용 범위를 채점 프롬프트에 명시). 틀리면 정답과 이유 바로 보여 주고 같은 날 한 번 더.
- 진입: 아침 강의 끝 "퀴즈 풀기" 버튼, 홈 화면 "오늘 퀴즈 N개".
- 화면 흐름만 말해보카식(카드 한 장씩, 즉시 피드백) 참고.

### B-7. 아침 강의
- 대본: `gemini-3.8-flash`. 새 실수 최대 6개 + 복습 날짜가 된 실수 최대 3개, 5분 이내.
- 대본 규칙:
  1. 영어는 영어 철자 그대로(한글 발음 표기 금지).
  2. 항목마다: 어젯밤 하신 말 → 자연스러운 표현 → 이유 1~2문장 → 짧은 2인 대화 → 한국어 뜻 → **3초 무음** → 정답 영어.
  3. 끝에 코치 한마디(일요일은 주간 리뷰).
- 음성: 기본 `gemini-3.8-flash-tts` 2인 화자(해설·대화 상대) [확인: 한 요청 최대 2명]. ElevenLabs를 켜면 Text to Dialogue 사용 [확인: 요청당 2,000자 이하라 나눠 생성].
- **두 엔진 모두 원음(PCM)으로 받아** 서버에서 항목별 조각을 이어 붙이고 3초 무음을 넣어 한 파일로 저장(MP3 변환은 가능하면, 안 되면 WAV). 오디오 파일은 Cloud Storage, DB에는 주소만.
- 강의 페이지: 재생, 10초 뒤로, 배속, 항목 목차, 끝에 퀴즈 버튼.
- **미리 받기**: 강의 페이지를 열면 오디오를 기기에 저장해 두고 지하철 등 오프라인에서도 재생(브라우저 캐시). 실패해도 스트리밍 재생.

### B-8. 그록봇용 피드
- 주소: `GET /feed/{FEED_SECRET}/today` (사람이 읽는 페이지) 와 `/feed/{FEED_SECRET}/today.json`
- 내용: 날짜, 상태(`ready` / `generating` / `nothing`), 제목, 항목 수, 코치 한마디, 강의 재생 링크(로그인 없이 재생되는 비밀 주소), 오늘 퀴즈 개수.
- **예약 서버 없이 동작**: 이 주소가 열렸을 때 오늘 강의가 없고 새 실수나 복습 대상이 있으면 그 자리에서 생성을 시작하고 `generating`을 돌려줌. 앱 홈에도 "오늘 강의 만들기" 버튼.
- 그록봇에 줄 말(예시):
  > 매일 오전 6시 40분에 `https://<앱주소>/feed/<비밀키>/today` 를 열어 줘. 7시에 다시 열어서 상태가 준비 완료면 제목, 코치 한마디, 강의 재생 링크를 나에게 알려줘. 아직 생성 중이면 7시 15분에 한 번 더 확인해줘. 할 게 없다고 나오면 "오늘은 강의 없음"이라고만 알려줘.
- 비밀키는 설정에서 새로 바꿀 수 있음. 텔레그램·웹훅 기능은 만들지 않음.

### B-9. 목표·스케줄·코치
- 4개 목표를 "목표" 데이터로 미리 입력: OPIc(AL), 필리조선소 주재원, 미국·호주 여행, Bluey 듣기. 기존 프롬프트(마스터 체크리스트)를 각 목표의 튜터 프롬프트로.
- 요일 루틴: 월·토 OPIc, 화·목 Philly, 수 Bluey, 금 여행, 일 주간 복기. 목표마다 "다음 과 번호".
- 첫 실행 때 목표별 실제 진도 입력(OPIc는 10/10 1과, 10/11 2과, 10/12 3과 순서로 진행).
- 하루 빠지면 그 목표의 다음 요일에 같은 과를 이어서. OPIc 시험 날짜 입력 시 모의고사를 1~2주 전에 배치.
- 코치 탭(텍스트): A-6 ②. 변경 전후 비교 → 승인 버튼 → 적용, 이력·되돌리기.
- 코치 먼저 말 걸기: 일요일 주간 리뷰(아침 강의 끝 한마디) + 이틀 연속 결석(앱 홈 배너)만.

### B-10. Keep 가져오기와 사용량
- **Keep 가져오기**: Keep "English mistake log" 목록을 복사해 붙여넣으면 `gemini-3.8-flash`가 [내가 한 말 / 자연스러운 표현 / 이유]로 나눠 미리보기 → 확인 후 저장. 가져온 실수는 1일 단계부터 시작. (Keep을 앱이 직접 읽는 연동은 하지 않음 [추정: 개인 계정용 공식 연동 경로가 마땅치 않음])
- **사용량**: 통화 분, 받아쓰기 분, 토큰, TTS 글자 수, 예상 비용을 1단계부터 기록하고 설정 화면에 "이번 달 사용량·예상 비용" 표시. 단가는 `models.ts` 옆 단가표 한 곳에서 관리.

### B-11. 데이터 모델
```
users/{userId}
  settings: { sttEngine, ttsEngine, lectureTime, feedSecret, coachNudges: ["weekly","absence2d"] }
  goals/{goalId}: { title, type, why, deadline?, priority, tutorPrompt, lessons[], nextLessonIndex,
                    status(active|paused|done) }
  plan: { weeklyPattern: { mon: [goalId], ... }, minutesPerDay, updatedAt }
  planChanges/{id}: { requestedText, before, after, status(proposed|approved|rejected|reverted), at }
  coachMemory: { constraints[], preferences[], weakPoints[] }
  coachMessages/{id}: { role, text, at }
  sessions/{sessionId}: {
      goalId, lessonIndex, startedAt, endedAt, minutes,
      status(live|interrupted|reviewing|done),
      recordingChunks: [ { idx, url, startedAt, durationSec } ],
      liveTranscript,                 // Live 자체 받아쓰기 (보조)
      sttPartial: [ { minute, text } ], // 통화 중 1분 단위 받아쓰기 (임시)
      sttTranscript, sttEngine,       // 통화 후 전체 받아쓰기 (최종, 우선)
      review }
  mistakes/{id}: {
      createdAt, source(call|keep_import), sessionId?, goalId, lessonTitle,
      myPhrase, naturalPhrase, reason, sourceStt?, audioClipUrl?,
      stage(1|3|7|14), nextReviewDate,
      status(reviewing|on_hold|graduated),
      quizPassedAt?, usedCorrectlyAt?, graduatedBy?(quiz|call),
      reopenedAt?, reopenCount, flaggedAsSttError? }
  quizAttempts/{id}: { mistakeId, at, mode(speak|type), answerText, answerAudioUrl?, passed, feedback }
  lectures/{date}: { status(generating|ready|failed), title, script, audioUrl, coachNote,
                     newMistakeIds, reviewMistakeIds, ttsEngine, chars, listenedAt? }
  sttBenchmark/{id}: { sentenceRef, audioUrl, engine(live|gemini_transcribe|assemblyai),
                       output, errorPreserved(boolean), at }
  usage/{yyyy-mm}: { liveMinutes, sttMinutes, textTokens, ttsChars, estCostUsd }
```

### B-12. 만드는 순서 (체크리스트)

**1단계: 통화 → 기록이 믿을 만한가** (AI Studio)
- [ ] 로그인(내 계정만), Firestore·Cloud Storage 연결, `models.ts`와 공급자 인터페이스
- [ ] 4개 목표·요일 루틴·진도 입력, 홈 화면(오늘 수업 카드)
- [ ] 통화: `gemini-3.8-live`, 세션 재개 + 압축, 임시 토큰, 수업 지시서 주입
- [ ] 10초 조각 녹음(임시 저장 + 업로드), 1분 단위 받아쓰기, 재개 실패 시 대화 로그로 새 세션 이어가기, 끊긴 통화 자동 복기, 화면 꺼짐 방지 안내
- [ ] 통화 후 기록용 받아쓰기(`gemini-3.5-transcribe` VERBATIM) → 복기 JSON → 실수 보관함
- [ ] Keep 붙여넣기 가져오기
- [ ] 사용량·예상 비용 화면
- [ ] **받아쓰기 품질 시험 페이지**: Keep 실수 문장(27개 이상)을 틀린 그대로 읽어 녹음 → ① Live 자체 받아쓰기(녹음 파일을 Live에 흘려 넣어 측정) ② `gemini-3.5-transcribe` VERBATIM ③ AssemblyAI Universal-3.5 Pro 비실시간(API 값 확인 필요) → 문장마다 "틀린 부분이 그대로 남았나" 표시 → 엔진별 보존율 표
- [ ] **완료 조건**: 25분 통화가 끊기지 않음 + 실수 카드 생성 + 품질 시험 결과로 `STT_ENGINE` 확정(보존율이 가장 높은 엔진, 제안 기준 90% 이상 [추정]). 이 시험 전에는 졸업률·복기 결과를 신뢰하지 않음.

**2단계: 복습 루프** (AI Studio, 막히면 오디오 처리만 개발자)
- [ ] 간격 반복·졸업·다시 복습·보류 상태
- [ ] 퀴즈(말하기·타이핑)
- [ ] 아침 강의 생성(Gemini TTS 기본, 3초 무음, 이어 붙이기), 강의 페이지, 오프라인 미리 받기
- [ ] 그록봇 피드(열면 생성), 홈 "오늘 강의 만들기" 버튼
- [ ] (선택) ElevenLabs 전환 설정 — 같은 대본으로 두 엔진 비교 듣기
- [ ] **완료 조건**: 다음 날 아침 그록봇이 링크를 전달하고, 강의에 3초 무음이 있고, 퀴즈로 졸업이 됨

**3단계: 코치와 자동화**
- [ ] 코치 탭(텍스트, 승인 후 적용, 이력·되돌리기)
- [ ] 다음 통화에 복습 표현 주입 확인, 빠른 졸업·다시 복습 동작 확인
- [ ] 주간 리뷰 한마디, 이틀 결석 배너
- [ ] 시험 날짜 역산
- [ ] **완료 조건**: "다음 주 출장이야"로 계획이 바뀌고 승인 전에는 안 바뀜

**기존 루틴과의 관계**
- 1단계가 안정될 때까지 지금의 Gemini 앱 + Keep + 그록봇 아침 강의를 **그대로 유지**.
- 1단계가 안정되면 주 저장소를 앱으로 옮기고 Keep은 백업 복사 버튼만 사용(찬식님이 결정).
- 2단계 피드가 준비되면 그록봇 일을 "강의 생성"에서 "피드 확인·링크 전달"로 전환.

---

## Part C. 로드맵

| 단계 | 대상 | 할 일 | 넘어가는 기준 |
|---|---|---|---|
| 1. 개인 테스트 | 찬식님 | Part B | 4주 연속 사용, 받아쓰기 보존율 확정, 실수 졸업률 상승 |
| 2. 비공개 베타 | 지인 10~30명 | 코치 튜토리얼, 음성 코치, 목표 템플릿, PWA 웹 푸시, 약관·개인정보·AI 고지, 녹음 삭제 | 7일 재방문 40% 이상 [추정 목표], 1인당 원가 실측 통과, ElevenLabs 회신 반영 |
| 3. 정식 출시 | 일반 | 네이티브 앱(푸시, 백그라운드 재생, 화면 꺼짐 중 녹음), 앱 내 결제, 분 단위 요금제, 원가 대시보드, 키즈 자체 콘텐츠 | — |

---

## 열린 항목

| 항목 | 상태 |
|---|---|
| ElevenLabs 재판매·상업 TTS·목소리 라이선스 | [대기] 10/13 문의 발송, 회신 대기 |
| `gemini-3.5-transcribe` VERBATIM이 **문법 오류**까지 그대로 적는지 | [미확인] 문서는 "단어 그대로, 군말·반복·말 끊김 유지"까지만 명시 → 1단계 품질 시험으로 확정 |
| ElevenLabs 플랜별 현재 포함 크레딧 | [미확인] 공식 가격 페이지에서 플랜과 글자 수 대응이 명확하지 않음, 로키가 10/3에 본 Starter 약 3만 크레딧과도 차이 |
| 모델 ID·단가 | 10/13 기준 [확인], 구현 직전 재확인 |
| 임시 토큰 | [확인] 아직 Preview, 정식 전 대체 경로 유지 |
| 웹앱 화면 꺼짐 시 녹음 | [추정] 멈출 수 있음 → 네이티브 이관 시점에 해결 |
| OPIc 시험 날짜 | 미정 |

## 출처 (2026-10-13 확인)
- Gemini 모델: https://ai.google.dev/gemini-api/docs/models
- Gemini 가격(3.8 Live·Flash·TTS, 3.5 Transcribe): https://ai.google.dev/gemini-api/docs/pricing
- Gemini 받아쓰기(VERBATIM/SMART, 최대 1시간): https://ai.google.dev/gemini-api/docs/generate-content/transcribe
- Live API 세션 관리: https://ai.google.dev/gemini-api/docs/live-session
- 임시 토큰: https://ai.google.dev/gemini-api/docs/ephemeral-tokens
- Gemini TTS: https://ai.google.dev/gemini-api/docs/speech-generation
- AI Studio Build: https://ai.google.dev/gemini-api/docs/aistudio-build-mode
- AssemblyAI 가격(2026-09-28 갱신, 비실시간 Universal-3.5 Pro $0.21/시간, 실시간 `universal-3-6-pro` $0.45/시간): https://www.assemblyai.com/llms/pricing.md , 모델 기능(비실시간 3.5 Pro 한국어 미지원): https://www.assemblyai.com/llms/models.md
- Live 내장 받아쓰기 오인식 사용자 보고(3.8 Live Stable 포함, 구글 답변 없음): https://discuss.ai.google.dev/t/gemini-live-api-input-audio-transcription-returns-incorrect-text-while-model-correctly-processes-audio/128300
- ElevenLabs API 가격: https://elevenlabs.io/pricing/api
- ElevenLabs Text to Dialogue: https://elevenlabs.io/docs/overview/capabilities/text-to-dialogue
- AI 기본법: https://www.shinkim.com/kor/media/newsletter/3114
- 야간 광고성 푸시: https://docs.hackle.io/crm-marketing/push-message-guide/promotion-push-guideline.md
- 스픽 가격(블로그): https://benefitshub.co.kr/speak-promo-code/
