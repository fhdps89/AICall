# 오늘도 한 통 — Stage 1 (Android)

**오늘도 한 통** Stage-1 Android app (Kotlin + Jetpack Compose).  
Warm dark “HER” tone home, glowing orb, immediate call screen, and an on-device realtime voice loop with barge-in using `SpeechRecognizer` + `TextToSpeech` (Korean).

Package: `com.onecall.aivoice` · Min SDK 26 · Target / Compile SDK 34

---

## 한국어

### 범위 (Stage-1)

1. **홈** (세로, 어두운 따뜻한 톤): 빛나는 오브, 「지금 목소리: 기본 한국어 음성」, 「통화하기」. 오브 탭 → 최소 설정 시트 (고정 음성 이름 + 호칭/닉네임, `SharedPreferences`).
2. **통화하기** → 즉시 통화 화면 (음성 선택 없음).
3. **통화 화면**: 오브 두 상태(듣는 중 / 말하는 중) 애니메이션, 타이머, 음소거, 끊기, 「AI 음성」 안내.
4. **실시간 루프 + barge-in**: AI가 호칭으로 인사 → 듣기 → partial/final 음성 시 TTS 중단 후 처리 → TTS 응답 → TTS 재생 중 인식/음량으로 barge-in.
5. **고정 단일 한국어 TTS** (기기 기본 한국어 TTS).
6. 갤러리/프롬프트/업로드, 오브 커스터마이즈, 감정색, 결제, 장기 기억, iOS는 **범위 밖**.

### Android Studio에서 열기

1. Android Studio Hedgehog / Iguana / Koala 이상 권장.
2. **File → Open** → 이 폴더(`AICall`) 선택.
3. `local.properties`가 없으면 Studio가 SDK 경로를 자동 생성합니다.  
   수동 예: `sdk.dir=/Users/YOU/Library/Android/Sdk`
4. Gradle Sync 완료 후 에뮬레이터 또는 실기기 선택 → **Run**.

### 에뮬레이터 / 실기기 실행

- **실기기 권장**: 마이크·한국어 STT/TTS 품질이 더 좋습니다.
- 에뮬레이터: Google APIs / Play 이미지 + 마이크 권한.  
  Extended Controls에서 가상 마이크를 연결하거나 호스트 마이크를 허용하세요.
- 첫 실행 시 **RECORD_AUDIO** 권한을 허용하세요.
- 기기에 **한국어 TTS 데이터**가 설치되어 있어야 합니다 (설정 → 접근성 → TTS / Google 음성 데이터).

### 검증 체크리스트

| 단계 | 기대 결과 |
|------|-----------|
| 앱 실행 | 어두운 홈, 오브, 「지금 목소리: 기본 한국어 음성」, 「통화하기」 |
| 오브 탭 | 설정 시트: 고정 음성명 + 호칭 입력 → 저장 후 SharedPreferences 반영 |
| 통화하기 | 즉시 통화 화면 (음성 피커 없음), 「AI 음성」 배지, 타이머 시작 |
| 인사 | 설정한 호칭으로 TTS 인사 후 Listening 상태 |
| 말하기 | 사용자 말 → AI TTS 응답, 오브 Speaking 애니메이션 |
| Barge-in | AI가 말하는 중 끼어들기 → TTS 중단 → Listening |
| 음소거 | 마이크/루프 일시 정지 |
| 끊기 | 엔진 정리 후 홈으로 복귀 |

### 알려진 제한

- 클라우드 LLM 없음 — 로컬 휴리스틱 응답만 사용.
- `SpeechRecognizer`는 네트워크/Google 서비스에 의존할 수 있음 (기기·ROM별 차이).
- TTS 자기 에코로 인한 오인식 가능 — barge-in은 짧은 arm delay + RMS/partial로 완화.
- 단일 고정 한국어 TTS만 지원 (음성 갤러리 없음).
- 세로(portrait) 전용.
- 이 빌드 머신에 Android SDK가 없을 수 있음 — 소스는 Studio에서 빌드하세요.

---

## English

### Scope (Stage-1)

1. **Home** (portrait, dark warm HER tone): glowing orb, “Current voice: …”, **Call**. Orb tap opens a minimal settings sheet (fixed voice name + nickname for how AI addresses the user; `SharedPreferences`).
2. **Call** → immediate Call screen (no voice picker).
3. **Call screen**: orb with listening / speaking animations, timer, mute, hang up, “AI voice” notice.
4. **Realtime loop + barge-in** via Android `SpeechRecognizer` + `TextToSpeech` (Korean).
5. **Fixed single Korean TTS** (device default Korean engine).
6. Out of scope: gallery/prompt/upload, orb customization, emotion colors, payments, long memory, iOS.

### Open in Android Studio

1. Android Studio Hedgehog+ recommended.
2. **File → Open** → select the `AICall` folder.
3. Let Studio create `local.properties`, or set `sdk.dir=...` yourself.
4. Sync Gradle → Run on emulator or device.

### Run

- Prefer a **physical device** for mic / Korean STT-TTS.
- Emulator: Google APIs image; enable host audio / mic.
- Grant **RECORD_AUDIO** on first launch.
- Ensure Korean TTS voice data is installed on the device.

### Verification checklist

1. Launch → home orb + voice label + Call button.  
2. Tap orb → settings; set nickname; save.  
3. Tap Call → Call screen immediately (no picker).  
4. Hear Korean greeting with nickname.  
5. Speak → hear reply; orb switches listening/speaking.  
6. Barge-in while AI speaks → TTS stops, listening resumes.  
7. Mute → loop pauses; unmute → resumes.  
8. Hang up → back to home.

### Known limits

- No cloud LLM — heuristic Korean replies only.
- `SpeechRecognizer` behavior varies by OEM / may need network.
- Possible TTS echo false triggers; mitigated with arm delay + RMS/partial barge-in.
- Single fixed Korean TTS only; portrait only.
- This environment may lack Android SDK — build with Android Studio on your machine.

---

## Project layout

```
AICall/
├── app/
│   ├── build.gradle.kts
│   ├── proguard-rules.pro
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/onecall/aivoice/
│       │   ├── MainActivity.kt
│       │   ├── data/UserPreferences.kt
│       │   ├── voice/
│       │   │   ├── CallPhase.kt
│       │   │   ├── ReplyGenerator.kt
│       │   │   └── VoiceCallEngine.kt
│       │   └── ui/
│       │       ├── theme/
│       │       ├── components/GlowingOrb.kt
│       │       ├── home/
│       │       └── call/
│       └── res/
├── build.gradle.kts
├── settings.gradle.kts
├── gradle.properties
├── gradle/wrapper/
└── README.md
```

## Build from CLI (when SDK + JDK 17 are installed)

```bash
cp local.properties.example local.properties   # edit sdk.dir
./gradlew :app:assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
```

## Zip

Companion archive: `/workspace/AICall-stage1.zip` (created alongside this tree).
