# 원콜 구글 스트리밍 시험 모드 세부 기획안

<div class="callout-box">
<p>■ 순영향: 10분 통화 1회 예상 비용을 기존 약 <strong>$1.50</strong>에서 약 <strong>$0.19</strong>(2027년 약 <strong>$0.23</strong>)로 낮추는 선택형 시험 모드를 추가합니다. 기본 통화 엔진은 건드리지 않아 평소 통화에는 영향이 없습니다.</p>
<p>■ 즉시 할 일: 기획안 승인 즉시 구현과 검증을 마치고, PR #62와 함께 배포해 오늘 <strong>23:00</strong> 밤 연습 통화에서 직접 시험합니다.</p>
<p>■ 결정 필요: 구현 착수 승인 여부와 <strong>23:00</strong>까지 일정이 빠듯할 때의 배포 방식(권장: #62 먼저 배포, 시험 모드는 다음 날)을 선택해 주세요.</p>
</div>

## 1. 오늘 밤 시험의 목표와 합격선

오늘 밤 시험은 PR #61 제안서의 「구글 단일 스트리밍」 방식을 선택형 시험 모드로 먼저 써 보고, 비용 절감과 통화 품질을 실측하는 것이 목표입니다. 기본 통화 엔진은 그대로 두고, PR #62(실측 계측·비용식 수정·1분 임시 받아쓰기 기본 꺼짐) 위에 시험 모드를 얹습니다.

<div class="card-box" style="display:flex;gap:6pt">
<div class="card" style="flex:1"><div class="card-h">지금 통화(Live) 10분</div><p class="kpi-v">약 $1.50</p><p class="kpi-l">제안서 통화 월 $45.12 ÷ 30통</p></div>
<div class="card" style="flex:1"><div class="card-h">시험 모드 10분(추정)</div><p class="kpi-v">약 $0.19</p><p class="kpi-l">2027년 약 $0.23(음성 단가 2배)</p></div>
<div class="card" style="flex:1"><div class="card-h">오늘 밤 비용 합격선</div><p class="kpi-v">$0.30 이하</p><p class="kpi-l">10분 통화 1회 실측 기준(잠정)</p></div>
</div>

○ 제안서 기준 원콜 전체 월 원가는 현재 **$52.34**에서 구글 스트리밍 적용 시 2026년 **$10.49**로 추정됩니다.
  - 제안서 월 원가는 하루 10분, 월 30일 사용을 가정한 수치입니다(출처는 부록 D 각주 8).
○ 오늘 밤 성공 기준은 「잠정」 기준이며, 최종 합격 여부는 찬식님의 실제 통화 체감으로 판단합니다.
  - 측정 값은 사용량 화면의 「시험 통화 비용」, 브라우저·서버 콘솔 로그(`[poc-turn]`, `[poc-summary]`), 통화 기록에서 확인합니다.


| 항목 | 잠정 합격 기준 | 확인 경로 |
| --- | --- | --- |
| 통화 비용 | 10분 통화 1회 실측 **$0.30** 이하 | 사용량 화면 「시험 통화 비용」 |
| 첫 응답 시간 | 통화 연결 → 튜터 첫 음성 **3초** 이내 | 브라우저 지연 로그 |
| 턴 지연 | 확정 → 첫 음성 중앙값 **1.8초** 이내, 상위 10% **3초** 이내 | 서버 `[poc-summary]` 로그 |
| 끼어들기 | 말 시작 **1초** 안에 멈춤, 오작동 통화당 **1회** 이하 | 서버 로그 및 찬식님 체감 |
| 받아쓰기 품질 | 한영 섞인 말이 대화 기록에 알아볼 수 있게 남음 | 통화 화면 및 통화 기록 |
| 복기·체감 | 통화 뒤 복기 정상 생성, 끝난 뒤 5점 척도 한 줄 평가 | 복기 화면 및 찬식님 보고 |

## 2. 통화가 흘러가는 길 — 무엇이 어디서 도는가

브라우저는 마이크 입력과 소리 재생, 화면 표시만 맡고, 받아쓰기(STT)·답변 생성(LLM)·음성 합성(TTS) 세 단계는 모두 원콜 서버에서 순서대로 처리합니다. API 키를 서버에만 두고 세 모델의 사용량을 한곳에서 정확히 집계하기 위한 구조입니다.

<div class="process-flow" style="flex-wrap:nowrap;gap:3px">
<div class="step" style="flex:1 1 0;padding:5pt 4pt">마이크 입력<br><code>16kHz PCM</code></div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">서버 중계<br><code>/api/gemini/cascade</code></div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">받아쓰기(STT)<br><code>transcribe-live</code></div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">답변 생성<br><code>3.1-flash-lite</code></div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">문장별 음성(TTS)<br><code>flash-lite-tts</code></div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">브라우저 재생<br><code>24kHz PCM</code></div>
</div>

○ 서버 중계 경로를 새로 열어 기존 통화와 같은 보안을 적용합니다.
  - 기존 웹소켓(WebSocket, 실시간 양방향 통신 통로)인 `/api/gemini/live`와 똑같이 Firebase 토큰 인증과 세션 시작 횟수 제한을 거칩니다.
  - 브라우저 코드나 로그에는 API 키를 절대 넣지 않습니다.
  - 서버가 일회용 토큰을 발급해 브라우저가 직접 붙는 방식도 있으나, 이번 시험은 키 보호와 통합 계측을 위해 서버 중계를 선택합니다.
○ 세 모델은 각자 가장 빠른 설정으로 이어집니다.
  - 받아쓰기(STT): 마이크의 16kHz 16비트 음성을 받아 한국어·영어가 섞인 말도 자동 언어 감지로 받아 적습니다. 말한 구간을 그대로 확정하는 기본 모드(VERBATIM)를 씁니다.
  - 답변 생성(LLM): 튜터 지시문과 해당 통화의 대화 기록 전체를 넣어 스트리밍으로 답변을 만듭니다. 사고(thinking) 수준은 지연이 가장 낮은 최소(minimal) 기본값을 씁니다.
  - 음성 합성(TTS): 답변을 문장 단위로 끊어 문장마다 24kHz 음성으로 합성하고, 앞 문장이 재생되는 동안 다음 문장을 미리 합성해 대기 시간을 줄입니다.
○ 응답 속도를 정확히 재기 위해 구간별 지연 로그를 남깁니다.
  - 서버는 턴마다 「마지막 임시 결과 → 확정」, 「확정 → 첫 답변 글자」, 「첫 글자 → 첫 음성」, 「확정 → 첫 음성」을 ms 단위로 기록합니다.
  - 통화가 끝나면 중앙값, 상위 10% 값, 끼어들기 횟수를 요약 로그로 남기고, 브라우저는 「통화 연결 → 튜터 첫 음성」 시간을 기록합니다.

## 3. 말 차례·끼어들기·10분 제한

세 모델을 직렬로 연결하면 말 차례 판정, 끼어들기(말 끊기), 받아쓰기 시간 제한을 서버가 직접 관리해야 합니다. 오늘 밤 통화가 자연스럽게 이어지도록 세 가지 장치를 넣습니다.

<div class="card-box" style="display:flex;gap:6pt">
<div class="card" style="flex:1"><div class="card-h">말 차례 판정</div><p class="kpi-v">0.4초 대기</p><p class="kpi-l">확정 결과 뒤 이어지는 말이 없으면 턴 종료</p></div>
<div class="card" style="flex:1"><div class="card-h">끼어들기 기준</div><p class="kpi-v">2단어 이상</p><p class="kpi-l">튜터 문장과 다를 때 즉시 답변·재생 중단</p></div>
<div class="card" style="flex:1"><div class="card-h">세션 자동 교체</div><p class="kpi-v">9분 경과 시</p><p class="kpi-l">최대 10분 제한 도달 전 무중단 교체</p></div>
</div>

○ 말 차례 판정은 자동 음성 감지(VAD)와 짧은 대기 시간을 함께 씁니다.
  - 받아쓰기 모델의 자동 음성 감지가 말이 끝났다고 판단해 확정 결과를 보내면, 서버는 **0.4초** 동안 이어지는 말이 있는지 기다린 뒤 답변 생성을 시작합니다.
○ 끼어들기는 스피커 소리 재인식(에코)을 걸러낸 뒤 즉시 멈춥니다.
  - 튜터가 말하는 동안 임시 받아쓰기에 **2단어** 이상이 잡히고, 그 내용이 지금 튜터가 읽고 있는 문장과 거의 같지 않으면 사용자가 말을 끊은 것으로 판단합니다.
  - 서버는 답변과 음성 합성을 즉시 멈추고 브라우저에 중단 신호를 보내며, 브라우저는 기존 재생 스케줄러로 소리를 바로 끕니다.
  - 대화 기록에는 실제로 소리 나간 문장까지만 남겨, 듣지 못한 말을 튜터가 기억하는 문제를 막습니다.
  - ※ 오늘 밤 시험에서는 스피커 소리가 마이크로 다시 들어가는 일을 줄이기 위해 이어폰 사용을 권장합니다.
○ 받아쓰기 **10분** 제한은 **9분** 시점의 자동 교체로 넘깁니다.
  - 받아쓰기 모델은 한 세션당 연속 스트리밍이 최대 **10분**으로 제한됩니다.
  - **9분**을 넘기면 튜터가 말하기 시작하는 순간 서버가 새 받아쓰기 세션을 열어 갈아탑니다.
  - 교체하는 짧은 순간 들어온 마이크 소리는 잠시 모았다가 새 세션으로 보내며, 대화 기록은 서버 통화 세션에 그대로 유지되므로 대화가 끊기지 않습니다.

## 4. 튜터 지시문·실수 기록·대화 기록 이어받기

시험 모드는 통화 화면과 복기 흐름을 새로 만들지 않고 기존 구조를 그대로 이어받습니다. 통화 화면이 공통 통화 공급자 규격을 통해 엔진을 연결하도록 이미 분리돼 있기 때문입니다.

<div class="callout-box">
<p>■ 기존 자산 재사용: 오늘 학습 목표, 복습할 실수 최대 <strong>3개</strong>, 버튼 명령, 통화 뒤 녹음 기반 복기·실수 저장이 시험 모드에서도 그대로 동작합니다.</p>
</div>

○ 튜터 지시문 본문은 바꾸지 않습니다.
  - 오늘 학습 목표와 복습할 실수 최대 **3개**로 만든 기존 튜터 지시문을 그대로 넘깁니다.
  - 다만 답변 모델이 화면용 글이 아니라 음성으로 읽힐 문장을 쓰도록, 서버에서 「음성으로 읽히니 1~3문장 짧게, 마크다운·이모지 금지」라는 짧은 지시만 덧붙입니다.
○ 첫 인사와 통화 중 버튼 명령도 그대로 동작합니다.
  - 통화 시작 시 첫 인사를 유도하는 기존 문구와 화면 버튼(Done·Feedback·Model answer·Pause·Slow) 명령을 텍스트 턴으로 그대로 보냅니다.
○ 통화 뒤 복기와 발음 지도의 차이를 미리 확인합니다.
  - 시험 모드도 통화 중 마이크 녹음 스트림과 받아쓰기 결과를 기존과 동일하게 넘기므로, 통화 뒤 복기와 실수 기록은 평소처럼 생성됩니다.
  - 다만 답변 모델이 음성이 아닌 글자만 받으므로, 통화 중 실시간 발음·억양 지도는 구조적으로 불가능합니다. 녹음 파일을 바탕으로 한 사후 복기 지적은 그대로 유지됩니다.

## 5. 켜고 끄기, 실패하면 기본 엔진으로

시험 모드는 찬식님만 켜는 선택형 기능이며 기본값은 꺼짐입니다. 연결에 문제가 생기면 자동으로 기본 엔진으로 넘어가 통화가 막히지 않게 보호합니다.

<div class="process-flow" style="flex-wrap:nowrap;gap:3px">
<div class="step" style="flex:1 1 0;padding:5pt 4pt">개발자 메뉴<br>스위치 켬</div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">통화 화면<br>「시험 모드」 표시</div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">연결 대기<br>최대 8초</div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">실패 시 자동 대체<br>기본 엔진 연결</div>
</div>

○ 스위치는 설정 > 개발자 메뉴(모델 탭)에 둡니다.
  - 항목 이름은 「시험 통화 엔진: 구글 스트리밍(PoC)」이며, 기본값은 꺼짐이고 현재 기기 브라우저에만 저장됩니다.
  - 주소창 뒤에 붙이는 방식(`?engine=` 등)은 휴대폰에서 매번 고치기 번거롭고 링크로 퍼질 수 있어 쓰지 않습니다.
  - 스위치가 켜진 상태에서 통화를 걸면 통화 화면에 「시험 모드」가 표시됩니다.
○ 연결 실패와 통화 중 끊김을 단계별로 방어합니다.
  - 연결 단계에서 **8초** 안에 준비되지 않거나 오류가 나면, 그 통화는 자동으로 기본 엔진(`gemini-3.8-live`)으로 연결하고 「시험 모드 연결 실패, 기본 엔진으로 연결」 안내와 로그를 남깁니다.
  - 통화 중 받아쓰기 세션에 오류가 나면 서버가 **1회** 다시 엽니다.
  - 브라우저와 서버 사이 연결이 끊기면 최대 **3회** 재연결하며 대화 기록을 다시 보냅니다. 그래도 안 되면 기존 오류·다시 걸기 화면을 표시합니다.

## 6. 비용 계산과 사용량 기록

10분 통화 1회 예상 비용은 2026년 약 **$0.19**, 2027년 약 **$0.23**입니다. 기존 기본 통화 추정치(약 **$1.50**)의 약 8분의 1 수준이며, 제안서의 구글 스트리밍 추정치(통화당 약 **$0.16**)와도 비슷합니다.

<div class="card-box" style="display:flex;gap:6pt">
<div class="card" style="flex:1"><div class="card-h">10분 통화 예상(2026)</div><p class="kpi-v">약 $0.19</p><p class="kpi-l">기존 약 $1.50 대비 약 8분의 1</p></div>
<div class="card" style="flex:1"><div class="card-h">10분 통화 예상(2027)</div><p class="kpi-v">약 $0.23</p><p class="kpi-l">음성 합성 단가 2배 인상 반영</p></div>
<div class="card" style="flex:1"><div class="card-h">사용량 분리 기록</div><p class="kpi-v">전용 필드</p><p class="kpi-l">기존 Live 추정 비용 오염 방지</p></div>
</div>

○ 서버가 턴마다 6개 사용량 누적값을 계산해 브라우저로 보냅니다.
  - 받아쓰기 입력은 보낸 오디오 초로 계산합니다. 받아쓰기 출력은 모델이 사용량을 돌려주면 실측값을 쓰고, 돌려주지 않으면 글자 수로 추정해 「추정」 표시를 붙입니다(응답 여부는 배포 뒤 첫 시험 통화에서 확인).
  - 답변 입력·출력(사고 토큰 포함)과 음성 입력은 모델 응답의 실측 토큰을 씁니다.
  - 음성 출력은 생성된 음성 데이터 바이트로 오디오 초를 정확히 계산합니다.
○ 시험 통화 비용은 아래 산식으로 계산하며, 상세 가정과 항목별 계산은 부록 A에 정리했습니다.

[산식] 시험 통화 비용 = 받아쓰기 입력(보낸 오디오 초 × 25 × $3.50 ÷ 100만) + 받아쓰기 출력(토큰 × $21.00 ÷ 100만) + 답변 입력(토큰 × $0.25 ÷ 100만) + 답변 출력(토큰 × $1.50 ÷ 100만) + 음성 입력(토큰 × $0.50 ÷ 100만, 2027-01-01부터 $1.00) + 음성 출력(오디오 초 × 25 × $6.00 ÷ 100만, 2027-01-01부터 $12.00)

○ 사용량과 학습 기록이 꼬이지 않게 저장 경로를 분리합니다.
  - PR #62 이후 기존 통화 분(`liveMinutes`)은 실측 토큰이 없을 때 기본 Live 비용 추정식에 쓰입니다. 시험 통화를 여기에 섞으면 비용이 부풀려집니다.
  - 따라서 Firestore 월별 사용량 문서에 시험 전용 필드(`pocMinutes`, `pocCalls` 및 6개 세부 지표)로 기록하고, 사용량 화면에 「시험 통화 비용」 줄을 추가합니다.
  - 학습 분 합계는 기존 통화 분과 시험 통화 분을 더해 계산하므로, 시험 모드로 통화해도 학습 기록은 줄지 않습니다.

## 7. 고치는 파일과 건드리지 않는 파일

이번 작업은 기본 통화 엔진과 핵심 설정을 보호하는 단계 제약(Phase gate)을 엄격히 지킵니다. 시험 모델명과 단가는 새 파일에만 따로 두고, 기존 기본 모델 설정 파일은 한 글자도 바꾸지 않습니다.

<div class="callout-box">
<p>■ 변경 금지 원칙: 기본 통화 엔진(<code>gemini-3.8-live</code>), 모델 상수 파일(<code>src/config/models.ts</code>), 기존 오디오 재생 스케줄러, 아침 강의, 부팅 표시(<code>[boot]</code>), 보안 비밀값(Secrets)은 전혀 건드리지 않습니다.</p>
</div>

○ 변경 범위는 새 파일 추가와 최소한의 연결 지점 수정으로 한정합니다(전체 파일 목록은 부록 B 참고).
  - Gemini API 외에 새로운 유료 서비스는 추가하지 않습니다.
  - 아침 강의 일일 생성 제한(`LECTURE_DAILY_GEN_CAP=3`)과 Firestore 보안 규칙(사용자 문서 하위 쓰기는 이미 허용됨)도 그대로 둡니다.


| 구분 | 대상 요약 | 핵심 역할 |
| --- | --- | --- |
| 새로 만듦 | 설정·스위치·공급자·서버 세션·문자 처리 5개, 테스트 4~5개 | 시험 모드 전체 로직과 단가 분리 |
| 일부 수정 | 서버 경로, 공급자 선택, 설정 화면, 통화 화면, 사용량·학습 기록, 문서 | 스위치 연결, 전용 비용·학습 분 반영 |
| 변경 금지 | 모델 상수, 기본 공급자, Live 설정, 재생 스케줄러, 강의·부팅·규칙 | 기존 통화·강의 회귀 원천 차단 |

## 8. 검증 계획

작업 환경(박스)에는 Gemini API 키가 없으므로, 코드 수준 검증과 가짜 Gemini 연기 시험을 끝낸 뒤 배포 후 라이브 앱에서 짧은 통화 **1회**로만 실제 API를 확인합니다.

<div class="process-flow" style="flex-wrap:nowrap;gap:3px">
<div class="step" style="flex:1 1 0;padding:5pt 4pt">단위 테스트<br>핵심 경로 검증</div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">전체 회귀<br>656개+신규·빌드</div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">박스 연기 시험<br>API 호출 0회</div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">라이브 확인<br>짧은 통화 1회</div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">교차 검증<br>Neon·Grok·Opus</div>
</div>

○ 자동 테스트와 회귀 확인을 먼저 마칩니다.
  - 단위 테스트(핵심 경로마다 작성): 문장 자르기(영어·한국어·약어·숫자), WAV 헤더 제거, 에코 거르기, 끼어들기 후 대화 기록 자르기, **9분** 교체 시점(가짜 시계), **0.4초** 이어 말하기 병합, 비용 산식과 2027년 단가 전환, 스위치 기본 꺼짐·이상값 방어, 기본 상태에서 기존 공급자 반환, 연결 실패 시 기본 엔진 대체, 사용량·학습 분 합계.
  - 전체 회귀: 기존 단위 테스트 **656개**와 새 테스트 전체 통과, 문법 검사(lint), 빌드를 확인하고, 변경 금지 파일의 변경 줄 수가 **0줄**인지 검사합니다.
○ 배포 전 박스 연기 시험과 배포 후 라이브 확인을 분리합니다.
  - 박스 연기 시험(실제 Gemini 호출 **0회**): 박스에서 서버를 띄우고 가짜 Gemini로 웹소켓 끝까지(녹음 파일 입력 → 받아쓰기·답변·음성 흉내 → 재생) 돌려 연결·끼어들기·대체·사용량 기록을 확인합니다.
  - 라이브 짧은 시험 통화 **1회**(찬식님 규칙): 배포 뒤 `?qa=1` 경로로 **1분** 이내 짧은 통화를 딱 **1회**만 걸어 세 모델 접속, 받아쓰기 사용량 응답 여부, 첫 음성·턴 지연, 실패 시 기본 엔진 자동 연결을 확인합니다.
○ 검증은 다단계로 교차 확인합니다.
  - 1차는 agy Neon medium, 2차는 Grok Bot이 직접 검증합니다(agy Claude 한도 12/3 09:24 KST 리셋 전). 한도가 리셋되면 agy Opus로 재검증합니다.

## 9. 일정·배포·되돌리기

기획안 승인 후 구현부터 라이브 확인까지 약 **3시간**이 걸릴 것으로 예상합니다. 승인이 **20:00** 무렵이면 **23:00** 직전에 맞춰지는 빠듯한 일정입니다.

<div class="process-flow" style="flex-wrap:nowrap;gap:3px">
<div class="step" style="flex:1 1 0;padding:5pt 4pt">구현<br>약 2시간</div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">검증<br>약 40분</div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">머지·배포<br>약 20분</div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt">라이브 확인<br>약 10분</div>
</div>

○ 배포는 PR #62를 먼저 올린 뒤 시험 모드를 이어서 반영합니다.
  - PR #62 머지 → 시험 모드 PR 머지 → AI Studio Pull 및 Republish(대기열이 비었을 때) → `?qa=1` 라이브 확인 및 짧은 시험 통화 **1회** → QA봇 인계 → 찬식님께 스위치 켜는 방법 안내 순으로 진행합니다.
○ 문제가 생겨도 두 단계로 안전하게 되돌릴 수 있습니다.
  - 1단계(즉시): 설정에서 시험 모드 스위치를 끄면 배포 없이 바로 평소 기본 엔진으로 돌아갑니다.
  - 2단계(문제가 클 때): 찬식님 승인 후 시험 모드 PR만 되돌리는 revert PR을 반영합니다. 기본 엔진을 바꾸지 않았으므로 평소 통화는 영향이 없습니다.

## 10. 오늘 밤 범위 밖

오늘 밤은 10분 통화 실측에 꼭 필요한 최소 기능만 넣습니다. 아래 항목은 오늘 실측 결과를 본 뒤 다음 단계로 넘깁니다.

<div class="callout-box">
<p>■ 범위 통제 원칙: 기본 통화 엔진 교체와 모델 상수 변경은 실제 <strong>10분</strong> 통화 실측과 찬식님 승인 뒤에만 진행합니다.</p>
</div>

○ 엔진 교체와 공개 범위
  - 기본 통화 엔진 교체, `src/config/models.ts` 상수 변경, 시험 모드를 다른 사용자에게 공개하는 작업.
○ 음성 인식·합성 고도화
  - 하이브리드 음성 감지(브라우저 말 끝 감지), 받아쓰기 끝 감지 민감도 조정, 전문 용어 사전.
  - 스트리밍 음성 합성(Interactions API)을 적용해 첫 음성 지연을 더 당기는 최적화.
○ 예외 처리와 후속 리포트
  - 통화 도중 기본 엔진으로 자동 전환하는 기능, 실시간 발음 평가.
  - 비정상 종료된 시험 통화의 복구 사용량을 시험 비용으로 따로 매기는 처리(알려진 한계: 복구 경로는 기존처럼 Live 추정으로 잡힘).
  - 10분 실통화 **2회** 비교 리포트(EL-17 후속)와 agy Opus 재검증(12/3 한도 리셋 후).

## 11. 위험과 찬식님 결정 사항

3단 직렬 구조에서 나올 수 있는 지연·에코·일정 위험을 미리 정리하고 대응책을 넣었습니다. 아래 세 가지 결정 사항을 확인해 주시면 바로 움직이겠습니다.

<div class="callout-box">
<p>■ 착수 대기: 찬식님이 아래 1·2번을 결정해 주시면 즉시 구현을 시작합니다.</p>
</div>


| 위험 항목 | 우려 내용 | 대응 방안 |
| --- | --- | --- |
| 응답 지연 | 3단 직렬 구조라 기본 Live보다 느릴 수 있음 | 문장 단위 미리 합성, 구간별 지연 로그로 실측 |
| 오작동 끼어들기 | 스피커 소리를 사용자 말로 잘못 인식 | 에코 제거, 튜터 문장 비교 거르기, 이어폰 권장 |
| 사용량 미응답 | 받아쓰기 사용량 응답 여부가 문서에 없음 | 응답 없으면 글자 수 추정·표시, 첫 통화에서 확인 |
| 배포 전 실호출 | 작업 박스에 API 키가 없어 배포 뒤 첫 확인 | 가짜 Gemini 연기 시험, 실패 시 기본 엔진 전환 |
| 실시간 발음 | 답변 모델이 글자만 받아 실시간 발음 지도 불가 | 통화 뒤 녹음 기반 복기 지적은 그대로 유지 |
| 빠듯한 일정 | 승인 후 약 **3시간** 소요로 23:00 임박 | 23:00 초과 시 대응 방식을 사전 합의 |

○ 찬식님 결정 사항

1. 이 기획안 범위로 구현에 바로 착수할지 승인해 주세요(승인 시 즉시 시작).
2. 오늘 **23:00**까지 완료가 어려울 때: (가) PR #62만 먼저 배포하고 시험 모드는 다음 날 배포(권장) / (나) 둘 다 준비되는 대로 **23:30** 이후 배포
3. (선택) 오늘 밤 시험 통화 길이는 **10분** 그대로 진행할 것을 권장합니다(받아쓰기 **10분** 제한과 **9분** 자동 교체까지 한 번에 확인할 수 있습니다).

## 12. 다음 액션

기획안이 승인되면 구현·검증·배포·실측을 아래 순서로 진행합니다.

<div class="process-flow" style="flex-wrap:nowrap;gap:3px">
<div class="step" style="flex:1 1 0;padding:5pt 4pt"><strong>찬식님</strong><br>기획안 승인·결정<br>지금</div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt"><strong>Engineering Lead</strong><br>코드 작성·테스트<br>승인 후 약 2시간</div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt"><strong>Engineering Lead</strong><br>Neon 1차·Grok Bot 2차 검증<br>약 40분</div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt"><strong>Engineering Lead·QA봇</strong><br>머지·배포·짧은 통화 1회<br>찬식님 머지 승인 후 약 30분</div>
<div class="arrow">→</div>
<div class="step" style="flex:1 1 0;padding:5pt 4pt"><strong>찬식님</strong><br>23:00 밤 통화 실측<br>오늘 23:00</div>
</div>

<div class="pb"></div>

## [부록 A] 10분 통화 비용 산식과 가정

본문 6절의 10분 통화 예상 비용(2026년 약 **$0.19**, 2027년 약 **$0.23**)은 아래 앱 가정값으로 계산한 추정치이며, 오늘 밤 실제 통화에서 실측값으로 검증합니다.

<div class="callout-box">
<p>■ 계산 기준: <strong>10분</strong> 통화, 분당 <strong>4턴</strong>(총 40턴), 튜터 발화 비율 <strong>50%</strong>(300초)를 가정했습니다.</p>
</div>

○ 상세 가정
  - 튜터 지시문은 약 **1,500토큰**, 턴마다 대화 기록이 약 **150토큰**씩 늘어나 40턴 평균 입력은 약 **4,500토큰**으로 잡습니다.
  - 튜터 답변은 턴당 약 **100토큰**으로 가정합니다.
  - 받아쓰기 오디오는 초당 **25토큰**, 받아쓰기 출력은 분당 **175토큰** 기준의 분당 단가(입력 약 **$0.005**, 출력 약 **$0.004**)를 적용했습니다.

[산식] 받아쓰기 입력 = 10분 × 분당 약 $0.005 = 약 $0.05

[산식] 받아쓰기 출력 = 최대 10분 × 분당 약 $0.004 = 약 $0.04 (보수적 상한)

[산식] 답변 입력 = 40턴 × 평균 약 4,500토큰(약 18만 토큰) × $0.25 ÷ 100만 = 약 $0.045

[산식] 답변 출력 = 40턴 × 100토큰(4,000토큰) × $1.50 ÷ 100만 = 약 $0.006 (답변 합 약 $0.05)

[산식] 음성 출력 = 튜터 5분(300초) × 25토큰(7,500토큰) × $6.00 ÷ 100만 = 약 $0.045 (2027년 $12.00 적용 시 약 $0.09)


| 항목 | 2026년 추정 | 2027년 추정 | 비고 |
| --- | --- | --- | --- |
| 받아쓰기 입력 | 약 **$0.05** | 약 **$0.05** | 10분 전체 전송 기준 |
| 받아쓰기 출력 | 약 **$0.04** | 약 **$0.04** | 10분 전체 보수적 추정 |
| 답변 입력·출력 | 약 **$0.05** | 약 **$0.05** | 입력 약 $0.045 + 출력 약 $0.006 |
| 음성 출력 | 약 **$0.045** | 약 **$0.09** | 2027-01-01부터 단가 2배 |
| 합계(10분 1회) | 약 **$0.19** | 약 **$0.23** | 오늘 밤 실측으로 확인 |
| 비교(기존 Live) | 약 **$1.50** | 약 **$1.50** | 제안서 월 $45.12 ÷ 30통 |

## [부록 B] 파일별 변경 상세

시험 모드 구현 시 새로 만드는 파일, 수정하는 파일, 그리고 변경을 금지하는 파일의 전체 목록입니다.

<div class="callout-box">
<p>■ 변경 규모: 새 기능 파일 <strong>5개</strong>와 테스트 <strong>4~5개</strong>를 추가하고, 기존 파일은 연결·화면·집계에 필요한 지점만 최소 수정합니다.</p>
</div>


| 구분 | 파일 경로 | 변경 내용 |
| --- | --- | --- |
| 새 파일 | `src/config/cascadePoc.ts` | 시험 모델명 3개와 단가(2027년 단가 전환 포함) |
| 새 파일 | `src/services/settings/callEngineSetting.ts` | 시험 엔진 스위치 상태 관리(기본 꺼짐) |
| 새 파일 | `src/services/providers/cascadePocProvider.ts` | 시험 공급자(마이크·서버 연결·재생·끼어들기·지연·자동 대체) |
| 새 파일 | `server/cascadeSession.ts` | 서버 세션(받아쓰기·턴 판정·답변·합성·끼어들기·9분 교체·계측) |
| 새 파일 | `server/cascadeText.ts` | 순수 함수(문장 자르기·WAV 헤더 제거·에코 거르기·기록 자르기·비용) |
| 새 파일 | 테스트 4~5개 | 문자 처리, 서버 세션(가짜 Gemini), 스위치, 시험 비용, 공급자 선택·대체 |


| 구분 | 파일 경로 | 변경 내용 |
| --- | --- | --- |
| 수정 | `server.ts` | 웹소켓 경로 `/api/gemini/cascade` 추가(같은 인증·횟수 제한, 약 15줄) |
| 수정 | `src/services/providers/index.ts` | 스위치가 켜졌을 때만 시험 공급자 반환 |
| 수정 | `src/ui/settings/SettingsModal.tsx`, `settingsText.ts` | 개발자 메뉴 스위치와 설명 문구 추가 |
| 수정 | `src/ui/call/NewCallScreen.tsx` | 「시험 모드」 표시 및 시험 사용량 기록 분기 |
| 수정 | `src/services/usage/usageService.ts` | 시험 전용 필드와 「시험 통화 비용」 항목 추가 |
| 수정 | `src/services/usage/learningLog.ts` | 시험 통화 분 기록, 학습 분 합계에 `pocMinutes` 포함 |
| 문서 | `PROJECT_CONTEXT.md`, `docs/history/changelog.md`, `README.md`, `docs/plan/google-streaming-poc-plan.md` | 시험 모드 구조·변경 이력·기획안 반영 |


| 변경 금지 대상 | 사유 |
| --- | --- |
| `src/config/models.ts` | 기본 모델명 상수 보호(실측 후 승인 전 변경 금지) |
| `geminiLiveProvider.ts`, `server/liveConfig.ts` | 기존 기본 통화 엔진 회귀 방지 |
| `audioPlaybackScheduler.ts` | 기존 재생 스케줄러는 수정 없이 가져다 쓰기만 함 |
| 아침 강의·`[boot]` 관련 파일 | 기존 기능 및 `LECTURE_DAILY_GEN_CAP=3` 보호 |
| `firestore.rules` | 사용자 문서 하위 쓰기는 이미 허용돼 있어 수정 불필요 |

## [부록 C] 공식 문서 확인표(모델 코드·단가·제약)

2026-11-26 KST 기준 공식 문서와 저장소 코드를 확인한 모델별 규격입니다. 저장소 SDK `@google/genai` 2.24.0은 임시 받아쓰기(interim), `audioStreamEnd`, Interactions를 지원합니다.

<div class="callout-box">
<p>■ 문서 확인 기준: 단가는 유료 등급 <strong>100만(1M) 토큰당</strong> 기준입니다. <code>transcribe-live</code>의 사용량 응답(<code>usageMetadata</code>) 포함 여부는 문서에 적혀 있지 않아 배포 뒤 첫 시험 통화에서 확인합니다.</p>
</div>


| 항목 | 받아쓰기(STT) | 답변 생성(LLM) | 음성 합성(TTS) |
| --- | --- | --- | --- |
| 모델 코드 | `gemini-3.5-transcribe-live`[^2][^3] | `gemini-3.1-flash-lite`[^4] | `gemini-3.8-flash-lite-tts`[^6][^7] |
| 호출 방식 | Live API 웹소켓 | 일반 텍스트 스트리밍 | 단건 생성(WAV 24kHz) |
| 입력 단가 | 오디오 **$3.50** (분당 약 $0.005)[^1] | 텍스트 **$0.25**[^1] | 텍스트 **$0.50** (2027년 **$1.00**)[^1] |
| 출력 단가 | 텍스트 **$21.00** (분당 약 $0.004)[^1] | 텍스트 **$1.50** (사고 포함)[^1] | 오디오 **$6.00** (2027년 **$12.00**)[^1] |
| 주요 규격 | 16kHz 16비트 PCM, 한국어·한영 자동 감지, 자동 VAD | 안정판(Stable), 사고 기본값 `minimal`[^5] | 한국어 지원, 입력 한도 **8,192토큰**, 24kHz 모노 16비트 |
| 제약 사항 | 세션당 최대 **10분**, 단어별 타임스탬프·화자 구분 미지원 | Live API 미지원 | Live API 미지원, 10초당 **$0.0015**(2027년 **$0.003**) |

## [부록 D] 출처(각주)

<div class="callout-box">
<p>■ 근거 안내: 본 기획안의 모든 모델 규격·단가·제약과 비교 원가는 아래 공식 문서 및 내부 제안서를 근거로 작성했습니다.</p>
</div>

[^1]: Google AI for Developers, Gemini API Pricing, https://ai.google.dev/gemini-api/docs/pricing
[^2]: Google AI for Developers, Live API — Live Transcribe, https://ai.google.dev/gemini-api/docs/live-api/live-transcribe
[^3]: Google AI for Developers, Gemini 3.5 Transcribe Model, https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe
[^4]: Google AI for Developers, Gemini 3.1 Flash-Lite Model, https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite
[^5]: Google AI for Developers, Gemini API Thinking, https://ai.google.dev/gemini-api/docs/thinking
[^6]: Google AI for Developers, Gemini API Speech Generation, https://ai.google.dev/gemini-api/docs/speech-generation
[^7]: Google AI for Developers, Gemini 3.8 Flash-Lite TTS Model, https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-lite-tts
[^8]: 원콜 내부 제안서(PR #61), `docs/plan/live-cost-optimization-proposal.md`

<style>.pb{break-before:page;page-break-before:always;height:0} .card p{margin:2pt 0} .kpi-v{font-size:13pt;font-weight:700} .card{padding:5pt 7pt} .card-h{font-weight:700;font-size:9pt} p:has(+ table){break-after:avoid;page-break-after:avoid} .lv1{break-after:avoid;page-break-after:avoid} .process-flow code{white-space:nowrap;font-size:7.5pt} .lv1 .hb,.lv2 .hb,.lv3 .hb,.lv4 .hb{display:inline-block;text-indent:0}</style>
