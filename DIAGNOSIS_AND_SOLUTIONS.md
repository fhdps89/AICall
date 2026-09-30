# 음성 인식 오류 및 동문서답 문제 심층 진단 보고서 (Diagnosis & Solutions)

> **문서 버전**: v1.2.0  
> **대상 시스템**: 「오늘도 한 통」 실시간 AI 음성 통화 웹 애플리케이션  
> **연동 모델**: `gemini-2.5-flash-native-audio-latest` (Gemini 2.5 Flash Native Audio Dialog)  
> **최신 개정**: Grok 기획 검수 피드백 수용 및 단일 오디오 소스(Single Ear) 아키텍처 구축

---

## 1. 사용자가 겪은 핵심 문제 현상 (Reported Symptoms)

- **현상 A (음성 왜곡 및 오인식)**: "왜 이렇게 시차가 나지?"라고 말했는데, 텍스트에 "치과"로 인식되고 AI가 "스케일링 받았냐"고 답변함.
- **현상 B (환청 텍스트 주입)**: "이젠 잘 되려나"라고 말했는데, 텍스트 영역에 "사랑해"라고 뜨며 AI가 "예쁜 말 해줘서 고마워"라고 답변함.
- **현상 C (전반적 대화 불능)**: 사용자의 의도를 전혀 반영하지 못하고 엉뚱한 대답이 반복되는 소통 단절 발생.

---

## 2. 심층 기술적 원인 분석 (Root Causes)

코드베이스와 브라우저 Web Audio API, Gemini Live API 아키텍처를 종합 분석한 결과, **3가지 치명적인 오디오/아키텍처 결함**이 복합 작용했습니다.

```
[사용자 마이크 (48kHz)]
      │
      ├─ (1) 하드웨어 48kHz를 리샘플 없이 16kHz 태깅 전송
      │      └─> Gemini Live가 3배 느린 저역(약 1.58옥타브/19반음 저하) 괴성으로 청취
      │
      ├─ (2) ScriptProcessor가 destination(스피커)에 직결
      │      └─> 마이크 소리가 스피커로 루프백되어 하드웨어 에코 발생
      │
      └─ (3) 브라우저 WebSpeech API 병렬 가동
             └─> 환청 자막 발생 ("치과", "사랑해")
             └─> 왜곡된 텍스트가 text_prompt로 주입되어 모델이 글을 진짜 말로 믿음
```

### [원인 1] 샘플레이트 불일치로 인한 3배 감속 음성 왜곡
- 사용자 PC/스마트폰의 하드웨어 마이크(`getUserMedia`)는 기본적으로 **44,100Hz** 또는 **48,000Hz**로 작동합니다.
- 기존 코드에서 48kHz 데이터를 리샘플링 없이 그대로 `audio/pcm;rate=16000`으로 전송했습니다.
- `48,000 / 16,000 = 3배`. Gemini Live 서버 입장에서는 **사용자의 목소리가 3배 느리고, 피치가 약 1.58옥타브(19반음) 낮아진 슬로모션 웅얼거림**으로 전달되어 음성을 판별할 수 없었습니다.

### [원인 2] ScriptProcessor의 스피커 직결로 인한 하드웨어 에코 루프
- `ScriptProcessorNode`를 구동시키기 위해 `processor.connect(pcmCtx.destination)`로 연결해 두어, 마이크로 들어온 소리가 스피커로 그대로 재출력되는 디지털 피드백 루프가 형성되었습니다.

### [원인 3] WebSpeech 환청 텍스트의 입력 하이재킹 (Dual-Input Conflict)
- 마이크 음성이 스트리밍되는 동시에 브라우저 WebSpeech API가 병렬 작동하면서, 짧은 소음이나 뭉개진 발음을 한국어 단어로 오인식(환각)했습니다 ("치과", "사랑해").
- 이 왜곡된 텍스트가 `text_prompt`로 주입되어, Gemini Live가 마이크 소리 대신 텍스트 명령을 우선 처리하여 동문서답이 발생했습니다.

---

## 3. 최종 해결 및 구현 내역 (v1.2.0)

### 1) 단일 오디오 소스 원칙 (Single Ear Principle)
- Gemini Live 연결 시 **브라우저 WebSpeech API 및 MediaRecorder를 완전히 비활성화(OFF)**했습니다.
- 서버 `ai.live.connect` 설정에 **`inputAudioTranscription: {}` 및 `outputAudioTranscription: {}`**을 활성화하여, Gemini Live가 실제로 들은 정확한 음성 전사(`input_transcript`)만을 화면 자막으로 직결 표시합니다.

### 2) Zero-Gain 노드 격리 및 7.5kHz 안티에일리어싱 필터
- `ScriptProcessor`를 볼륨 0인 **무음 게인 노드(`zeroGain`)**에만 연결하여 스피커 피드백 루프를 완전히 격리했습니다.
- 마이크 소스 뒤에 Web Audio 네이티브 **7.5kHz 저역 통과 필터(`BiquadFilterNode`)**를 장착하여 다운샘플링 시 발생하는 고역 에일리어싱 왜곡을 방지했습니다.

### 3) 선형 보간 16kHz 정밀 다운샘플러 및 고속 Base64
- 기기 하드웨어 샘플레이트(48kHz/44.1kHz)를 정밀 측정하여 16,000Hz 16-bit PCM으로 변환합니다.
- `fastUint8ToBase64` 청킹 인코딩을 적용하여 메인 스레드 부하를 최소화했습니다.

### 4) 하드웨어 큐 비움 시점 동기화 및 Barge-in 인터럽트
- `turnComplete` 수신 시 `PcmAudioSink`의 실제 잔여 재생 시간(`getRemainingPlayTimeMs()`)을 계산하여, 스피커 소리가 완전히 끝난 후에 마이크 게이트가 열리도록 동기화했습니다.
- 사용자 발화 감지 시 로컬 재생 정지와 함께 Live 세션에 `{ type: 'interrupt' }`를 전달합니다.

### 5) 사용자 안내 UI
- 통화 화면 상단에 `🎧 이어폰을 착용하시면 더 선명하게 대화할 수 있어요` 팁 배지를 추가했습니다.
