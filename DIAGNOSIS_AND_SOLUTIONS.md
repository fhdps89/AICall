# 음성 인식 오류 및 동문서답 문제 심층 진단 보고서 (Diagnosis & Solutions)

> **문서 버전**: v1.1.1  
> **대상 시스템**: 「오늘도 한 통」 실시간 AI 음성 통화 웹 애플리케이션  
> **연동 모델**: `gemini-2.5-flash-native-audio-latest` (Gemini 2.5 Flash Native Audio Dialog)

---

## 1. 사용자가 겪은 핵심 문제 현상 (Reported Symptoms)

- **현상 A (음성 왜곡 및 오인식)**: "왜 이렇게 시차가 나지?"라고 말했는데, 텍스트에 "치과"로 인식되고 AI가 "스케일링 받았냐"고 답변함.
- **현상 B (환청 텍스트 주입)**: "이젠 잘 되려나"라고 말했는데, 텍스트 영역에 "사랑해"라고 뜨며 AI가 "예쁜 말 해줘서 고마워"라고 답변함.
- **현상 C (전반적 대화 불능)**: 사용자의 의도를 전혀 반영하지 못하고 엉뚱한 대답이 반복되는 0점 수준의 소통 단절 발생.

---

## 2. 심층 기술적 원인 분석 (Root Causes)

코드베이스와 브라우저 Web Audio API, Gemini Live API 아키텍처를 종합 분석한 결과, **단순한 AI 성능 부족이 아닌 3가지 치명적인 오디오/아키텍처 결함**이 복합적으로 작용했습니다.

```
[사용자 마이크 (48kHz)]
      │
      ├─── (1) 하드웨어 48kHz 오디오를 16kHz로 미변환 전송 ──> Gemini Live (3배속 슬로모션 괴성 수신, 이해 불가)
      │
      └─── (2) 브라우저 WebSpeech API 병렬 가동 ───────────> 부정확한 환청 자막 발생 ("치과", "사랑해")
                                                                    │
                                                            (3) 왜곡된 텍스트가 text_prompt로 주입됨
                                                                    │
                                                                    ▼
                                                            Gemini Live가 "치과", "사랑해"를 
                                                            진짜 명령으로 오인하고 답변
```

### [원인 1] 샘플레이트 불일치로 인한 1/3배속 슬로모션 음성 왜곡 (Critical Audio Glitch)
- **메커니즘**:
  - 사용자 PC/스마트폰의 하드웨어 마이크(`getUserMedia`)는 기본적으로 **44,100Hz** 또는 **48,000Hz**로 작동합니다.
  - 기존 코드에서는 `new AudioContext({ sampleRate: 16000 })`를 선언했으나, 대부분의 브라우저(특히 크롬/사파리)에서 `ScriptProcessorNode`와 `MediaStreamSource`는 하드웨어 네이티브 샘플레이트(48kHz)로 버퍼(`inputBuffer.getChannelData(0)`)를 채웁니다.
  - 이 48kHz 데이터를 리샘플링 없이 그대로 16-bit PCM으로 변환한 뒤, WebSocket 헤더에는 `audio/pcm;rate=16000`이라고 전송했습니다.
- **결과**:
  - `48,000 / 16,000 = 3배`. Gemini Live 서버 입장에서는 **사용자의 목소리가 3배 느리고, 피치가 3옥타브 낮아진 슬로모션 웅얼거림**으로 재생되었습니다.
  - AI는 사람의 정상적인 말소리가 아니라 괴기스러운 저주파 노이즈로 들었기 때문에 사용자의 말을 전혀 알아들을 수 없었습니다.

### [원인 2] WebSpeech 환청 텍스트가 음성 스트림을 강제 덮어씀 (Input Hijacking)
- **메커니즘**:
  - 마이크 음성이 스트리밍되는 동시에, 브라우저 내장 `webkitSpeechRecognition`(Web Speech API)이 백그라운드에서 같이 돌아가고 있었습니다.
  - Web Speech API는 문맥 없는 짧은 소음이나 불완전한 오디오에서 엉뚱한 한국어 단어로 오인식(환각)하는 경향이 큽니다.
    - *"왜 이렇게 시차가 나지"* → **"치과"**
    - *"이젠 잘 되려나"* → **"사랑해"**
  - 치명적인 점은 `VoiceCallEngine`의 무음 타이머(`checkTurnWindow`)가 완료되면, Web Speech가 잘못 적어낸 텍스트("치과", "사랑해")를 Gemini Live 세션에 `{ type: 'text_prompt', text: cleaned }` 형태로 직접 쏴버렸습니다.
- **결과**:
  - Gemini Live는 마이크로부터는 슬로모션 웅얼거림을 듣고 있다가, 갑자기 텍스트 프롬프트로 "치과"라는 단어가 도착하자 이를 진짜 질문으로 인식하여 *"스케일링 받았어?"*라고 대답한 것입니다.

### [원인 3] 스피커 음성의 마이크 피드백 (Acoustic Echo Loop)
- AI가 답변 음성을 재생할 때 마이크 스트리밍이 차단되지 않아, 기기 스피커에서 나오는 AI 자신의 음성 끝부분이나 방 안의 잔향이 마이크를 타고 다시 Gemini Live로 흘러들어가는 피드백 루프가 형성되었습니다.

---

## 3. 적용된 해결책 (Implemented Solutions in v1.1.1)

### 1) 수학적 선형 보간 16kHz 다운샘플러 도입 (`downsampleTo16kHz`)
- 브라우저의 실제 캡처 샘플레이트(`e.inputBuffer.sampleRate`, 통상 48,000Hz)를 매 프레임 정확하게 읽어들입니다.
- 선형 보간법(Linear Interpolation)을 적용하여 기기 하드웨어 스펙에 상관없이 **완벽한 16,000Hz 정밀 16-bit PCM**으로 변환하여 전송합니다.
- 사용자의 실제 목소리 톤, 속도, 억양이 왜곡 없이 원음 그대로 Gemini Live에 도달합니다.

```typescript
function downsampleTo16kHz(inputBuffer: Float32Array, inputSampleRate: number): Int16Array {
  if (inputSampleRate === 16000) {
    // 16kHz인 경우 다이렉트 변환
    const pcm16 = new Int16Array(inputBuffer.length);
    for (let i = 0; i < inputBuffer.length; i++) {
      const s = Math.max(-1, Math.min(1, inputBuffer[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm16;
  }
  const ratio = inputSampleRate / 16000;
  const newLength = Math.round(inputBuffer.length / ratio);
  const pcm16 = new Int16Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const lower = Math.floor(srcIndex);
    const upper = Math.min(lower + 1, inputBuffer.length - 1);
    const weight = srcIndex - lower;
    const interpolated = inputBuffer[lower] * (1 - weight) + inputBuffer[upper] * weight;
    const s = Math.max(-1, Math.min(1, interpolated));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm16;
}
```

### 2) Live Native Audio 단일 파이프라인 원칙 확립 (텍스트 프롬프트 하이재킹 차단)
- Gemini Live 통화 중에는 **오직 마이크 음성 스트림(PCM)만을 AI의 청각 인풋으로 사용**합니다.
- WebSpeech API는 화면의 자막 표시용으로만 남겨두고, **Live 세션으로 `text_prompt`를 전송하지 못하도록 차단**했습니다.
- 이제 브라우저 음성 인식이 "치과"나 "사랑해"로 엉뚱하게 오작동하더라도, Gemini Live는 사용자의 실제 마이크 소리만을 듣고 판단하므로 동문서답이 발생하지 않습니다.
- 텍스트 주입은 사용자가 추천 칩을 누르거나 직접 텍스트 입력창에서 전송 버튼을 눌렀을 때만 명시적으로 허용됩니다.

### 3) 에코 방지 마이크 게이트 (Echo Suppression Gate)
- AI가 답변을 소리 내어 말하고 있는 도중(`this.isSpeaking`)에는 마이크 PCM 스트리밍을 음소거 게이트 처리하여, 스피커 소리가 다시 입력되어 발생하는 오작동을 원천 차단했습니다.

### 4) 실시간 한국어 음성 전용 시스템 인스트럭션 강화
- Gemini 2.5 Flash Native Audio 모델에게 사용자가 한국어로 실시간 마이크 발화를 하고 있음을 명시하고, 오타나 왜곡 추측 없이 들린 음성을 기준으로 자연스러운 구어체로 답하도록 지침을 수정했습니다.

---

## 4. 추가 권장 사항 및 테스트 가이드

1. **이어폰/헤드셋 권장**:
   - 스피커폰 환경보다는 이어폰(AirPods, 유선 헤드셋 등)을 사용할 때 에코 캔슬레이션 품질이 비약적으로 상승합니다.
2. **권장 브라우저**:
   - Google Chrome 최신 버전 (Web Audio 및 저지연 WebSocket 오디오 스트리밍에 가장 최적화되어 있음).
3. **외부 자문/개발팀 공유 시 활용**:
   - 본 문서(`DIAGNOSIS_AND_SOLUTIONS.md`)를 외부 오디오 엔지니어링이나 AI Studio 개발자 커뮤니티에 그대로 공유하시면 추가 기술 지원 및 코드 리뷰에 신속히 활용하실 수 있습니다.
