# 🎙️ 오디오 엔지니어링 아키텍처 및 파이프라인 명세 (Audio Engineering Architecture)

> **최종 갱신**: 2026-10-01 (KST)  
> 본 문서는 「오늘도 한 통」 v1.2.1에 적용된 실시간 양방향 오디오 스트리밍 파이프라인의 물리 음향학적 원리와 소프트웨어 구현 명세를 상세히 기록합니다.


---

## 1. 단일 오디오 소스 (Single Ear) 원칙

### 1.1 배경 및 문제점
초기 버전(v1.0 ~ v1.1.0)에서는 사용자 편의를 위해 브라우저 내장 `webkitSpeechRecognition` (WebSpeech API)을 백그라운드에서 실행하고, 인식된 텍스트를 통화 세션에 텍스트 프롬프트로 주입했습니다.
그러나 이는 치명적인 부작용을 일으켰습니다:
- 사용자가 "여보세요"라고만 말하거나 침묵 상태일 때, 주변 소음이나 잡음으로 인해 WebSpeech가 "치과", "사랑해", "안녕하세요" 등의 환각 텍스트(Phantom Transcript)를 생성.
- 이 텍스트가 WebSocket을 통해 Gemini Live 세션에 `text_prompt`로 주입되어 모델이 사용자의 실제 음성을 무시하고 엉뚱한 텍스트에 응답하는 하이재킹 현상 발생.

### 1.2 해결책
- **Gemini Live 통화 중 WebSpeech 완전 비활성화 (Single Ear)**:
  - 통화 중에는 오직 마이크 PCM 오디오 스트림(`audio/pcm;rate=16000`) 하나만을 모델의 청각으로 사용합니다.
  - 화면의 실시간 사용자 발화 자막은 Gemini Live 세션의 공식 파라미터 `inputAudioTranscription: {}`이 구글 음성 인식 엔진을 통해 실시간으로 반환하는 `msg.type === 'input_transcript'` 이벤트 데이터만을 직결합니다.

---

## 2. 16kHz 정밀 선형 보간 다운샘플러 (`downsampleTo16kHz`)

### 2.1 물리 음향학적 왜곡 원인
- 최신 스마트폰, 맥북, PC의 오디오 하드웨어는 기본 48,000Hz (또는 44,100Hz)로 오디오를 캡처합니다.
- Gemini Live WebSocket은 16,000Hz 16-bit Mono PCM을 요구합니다.
- 변환 없이 48kHz PCM을 16kHz 스트림으로 송출하면, 1초 분량의 소리가 모델에는 3초 동안 재생되는 효과를 냅니다.
  - 시간 지연: 3배 느려짐 (슬로모션)
  - 피치 왜곡: $f_{perceived} = f_{original} \times \frac{16000}{48000} = \frac{1}{3} f_{original}$
  - 반음 저하: $12 \times \log_2(1/3) \approx -19.02$ 반음 (약 1.58옥타브 저하). 남성 목소리는 알아들을 수 없는 괴물 저음으로, 여성 목소리는 저음 남성 목소리로 왜곡됨.

### 2.2 구현 알고리즘 (`VoiceCallEngine.ts`)
```typescript
export function downsampleTo16kHz(inputData: Float32Array, inputSampleRate: number): Int16Array {
  if (inputSampleRate === 16000) {
    const output = new Int16Array(inputData.length);
    for (let i = 0; i < inputData.length; i++) {
      const s = Math.max(-1, Math.min(1, inputData[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return output;
  }

  const ratio = inputSampleRate / 16000;
  const newLength = Math.round(inputData.length / ratio);
  const result = new Int16Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const indexFloor = Math.floor(srcIndex);
    const indexCeil = Math.min(inputData.length - 1, indexFloor + 1);
    const fraction = srcIndex - indexFloor;

    const s = inputData[indexFloor] * (1 - fraction) + inputData[indexCeil] * fraction;
    const clamped = Math.max(-1, Math.min(1, s));
    result[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return result;
}
```

---

## 3. 하드웨어 에코 격리 및 안티에일리어싱 필터

### 3.1 Zero-Gain 노드를 통한 스피커 격리
Web Audio API의 `ScriptProcessorNode`는 브라우저 명세상 `destination`에 연결되어야만 `onaudioprocess` 이벤트가 클록(clock)되어 실행됩니다.
그러나 `processor.connect(ctx.destination)`을 바로 실행하면 마이크에서 수음된 소리가 즉시 사용자의 스피커로 루프백되어 심각한 하울링과 에코를 발생시킵니다.
이를 해결하기 위해 게인이 0인 무음 게인 노드를 사이에 배치합니다:
```typescript
const zeroGain = pcmCtx.createGain();
zeroGain.gain.value = 0;
processor.connect(zeroGain);
zeroGain.connect(pcmCtx.destination);
```

### 3.2 7.5kHz Biquad 저역 통과 필터 (2차 필터 감쇄)
나이퀴스트-섀넌 표본화 정리에 따라 16kHz 샘플링의 나이퀴스트 주파수는 8,000Hz입니다.
8kHz 이상의 초고역 주파수 성분이 선형 보간 다운샘플링 과정에서 가청 대역으로 반사(Folding)되어 발생하는 에일리어싱 잡음을 억제하기 위해, 캡처 소스 직후에 7.5kHz 2차 저역 통과 필터(`-12dB/octave`)를 배치합니다:
```typescript
const lowpass = pcmCtx.createBiquadFilter();
lowpass.type = 'lowpass';
lowpass.frequency.value = 7500;
source.connect(lowpass);
lowpass.connect(processor);
```

---

## 4. 스피커 버퍼 잔류 꼬리 동기화 (`PcmAudioSink`)

AI의 음성 스트리밍 청크 수신이 끝난(`turnComplete`) 직후 즉시 마이크를 열면, 아직 브라우저의 오디오 하드웨어 버퍼에서 재생 중인 AI의 마지막 음성이 마이크로 다시 수음되어 자기 자신의 목소리에 답변하는 에코 루프가 발생합니다.
이를 차단하기 위해 `PcmAudioSink`는 하드웨어 큐에 대기 중인 오디오의 잔여 재생 시간(`getRemainingPlayTimeMs()`)을 정확히 추적합니다:
```typescript
public getRemainingPlayTimeMs(): number {
  if (!this.audioCtx) return 0;
  const remainingSec = Math.max(0, this.scheduledTime - this.audioCtx.currentTime);
  return Math.round(remainingSec * 1000);
}
```
통화 엔진은 이 잔여 시간이 완전히 0이 될 때까지 마이크 에코 게이트(`echoGateOpen`)를 닫힌 상태로 유지합니다.

---

## 5. 실시간 말 끊기 (Barge-in) 프로토콜

사용자가 AI 발화 도중 말을 시작하면:
1. **로컬 오디오 즉각 중단**: `pcmSink.stop()`을 호출하여 스피커에서 흘러나오던 AI 음성을 즉시 소거.
2. **서버 세션 인터럽트 송출**:
   - 클라이언트 ➔ 서버 브리지: `{ type: 'interrupt' }` 전송
   - 서버 브리지 ➔ `@google/genai` Live Session:
     ```typescript
     liveSession.sendClientContent({ turnComplete: true });
     ```
   - 구글 서버의 발화 생성 파이프라인이 즉각 중단되고, 새로운 턴 청취 상태로 리셋됩니다.
