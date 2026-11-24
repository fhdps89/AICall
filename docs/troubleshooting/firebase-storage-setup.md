# Firebase Storage 미설정(404) 점검 및 설정 안내

> **대상**: 프로젝트 소유자(찬식님)  
> **최종 갱신**: 2026-11-21 (KST)

---

## (a) 증상과 확인 방법

### 증상
- 통화 중 10초 녹음 조각 업로드 시 브라우저 콘솔에 `firebasestorage.googleapis.com` 대상 CORS 오류 또는 네트워크 오류가 반복 출력된다.
- 수정 전 코드에서는 Firebase Storage SDK 기본 재시도 시간(10분) 때문에 조각마다 최대 10분간 재시도하느라 서버 중계로 넘어가지 못하고 IndexedDB에 대기 조각이 쌓였다.

### 원인 확인 방법
`firebase-applet-config.json`에 설정된 버킷 이름은 `gen-lang-client-0592656565.firebasestorage.app`이다.  
아래 명령으로 버킷 존재 여부를 확인할 수 있다.

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://storage.googleapis.com/storage/v1/b/gen-lang-client-0592656565.firebasestorage.app/o?maxResults=1"
```

- **`404`**: 버킷이 아직 생성(프로비저닝)되지 않은 상태이다. Firebase 콘솔에서 Storage를 시작해야 한다.
- **`401` 또는 `403`**: 버킷은 존재하며, 인증/권한에 의해 차단된 정상 응답이다.

---

## (b) 조치 방법 (Firebase 콘솔에서 Storage 시작)

1. [Firebase 콘솔](https://console.firebase.google.com/)에서 프로젝트 **`gen-lang-client-0592656565`** 를 연다.
2. 왼쪽 메뉴 **빌드(Build)** → **Storage** → **시작하기(Get started)** 를 클릭한다.
3. 기본 버킷 위치를 선택하고 안내에 따라 버킷 생성을 완료한다. (결제/요금제 전환 안내가 표시되면 화면 안내를 따른다 `[미확인]`)
4. 생성이 끝난 뒤 Storage 상단에 표시되는 버킷 이름(`gs://...`)이 `firebase-applet-config.json`의 `storageBucket`(`gen-lang-client-0592656565.firebasestorage.app`)과 일치하는지 확인한다.
   - 만약 생성된 버킷 이름이 다르다면 `firebase-applet-config.json`의 `storageBucket` 값을 새 버킷 이름으로 변경하는 PR이 필요하다.

---

## (c) Storage 보안 규칙 (`storage.rules`) 및 배포 방법

저장소 루트의 [`storage.rules`](../../storage.rules) 파일 내용을 Firebase 콘솔 → Storage → **규칙(Rules)** 탭에 복사해 게시한다. (`firestore.rules`와 동일하게 단일 허용 계정 `episode.kim@gmail.com` 및 이메일 인증 완료 상태만 `users/{uid}/recordings/**` 및 `users/{uid}/lectures/**` 읽기·쓰기를 허용하고, 피드 오디오 백업 `feeds/{feedId}/days/{file}`는 암호화된 24MB 이하 `application/octet-stream`만 허용한다.)

> 참고: AI Studio Republish(코드 Pull + 게시)는 앱 서버 컨테이너만 새로 올린다. Storage 규칙은 `firebase.json` 자동 배포가 없으므로 게시로 바뀌지 않고, Firebase 콘솔 → Storage → 규칙 탭에서 직접 게시해야 한다. 규칙을 게시하기 전까지는 피드 오디오 백업 업로드·다운로드가 403으로 폴백되어 기존처럼 서버 TTS 복원으로 동작한다.

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function isSingleAllowedUser(userId) {
      return request.auth != null
        && request.auth.uid == userId
        && request.auth.token.email == 'episode.kim@gmail.com'
        && request.auth.token.email_verified == true;
    }

    match /users/{uid}/recordings/{allPaths=**} {
      allow read, write: if isSingleAllowedUser(uid);
    }

    match /users/{uid}/lectures/{file} {
      allow read: if isSingleAllowedUser(uid);
      allow write: if isSingleAllowedUser(uid)
        && file.matches('[0-9]{4}-[0-9]{2}-[0-9]{2}[.](wav|m4a|mp3)')
        && request.resource.size < 60 * 1024 * 1024
        && (request.resource.contentType == 'audio/wav'
            || request.resource.contentType == 'audio/mp4'
            || request.resource.contentType == 'audio/mpeg');
    }

    match /feeds/{feedId}/days/{file} {
      allow get: if feedId.matches('^[0-9a-f]{64}$') && file.matches('^[0-9]{4}-[0-9]{2}-[0-9]{2}[.]audio[.]enc$');
      allow create, update: if feedId.matches('^[0-9a-f]{64}$')
        && file.matches('^[0-9]{4}-[0-9]{2}-[0-9]{2}[.]audio[.]enc$')
        && firestore.exists(/databases/ai-studio-aicall-1bc322d0-1646-4556-a8fb-a70e9638dc34/documents/feeds/$(feedId))
        && request.resource.size <= 24 * 1024 * 1024
        && request.resource.contentType == 'application/octet-stream';
      allow list, delete: if false;
    }

    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

### 규칙 게시 단계

1. [Firebase 콘솔](https://console.firebase.google.com/)에서 프로젝트 **`gen-lang-client-0592656565`** → **Storage** → **규칙(Rules)** 탭을 연다.
2. 저장소 루트 [`storage.rules`](../../storage.rules)의 전체 내용을 붙여넣고 **게시(Publish)** 를 누른다.
3. 처음 `firestore.exists(...)` 교차 서비스 규칙을 게시할 때 Storage 서비스 계정의 Firestore 읽기 권한(IAM) 부여 확인 창이 뜨면 승인한다.
4. 만약 named database(`ai-studio-...`) 경로에서 `firestore.exists(...)`가 지원되지 않아 오류가 나면, `&& firestore.exists(...)` 한 줄만 빼고 경로 형식·24MB·`application/octet-stream` 제한은 유지해 게시한다. (피드 오디오는 `feedDocId`와 피드 비밀키로 AES-256-GCM 인증 암호화되어 있어 비밀키 없이는 복호화할 수 없으며, 변조 시에도 자동으로 TTS 복원으로 폴백된다.)

---

## (d) [선택] 버킷 CORS 설정 — 복기 다운로드는 서버 중계(/api/recordings/storage-file)로 CORS 없이 동작

브라우저가 Storage에서 직접 내려받을 때만 필요합니다. 공식 문서: *"To download data directly in the browser, you must configure your Cloud Storage bucket for cross-origin access (CORS)."*

현재 복기 조각 다운로드는 서버 중계(`/api/recordings/storage-file`)를 사용하므로 이 설정 없이도 동작합니다. 브라우저 직접 다운로드를 허용하려는 경우에만 아래 절차를 실행하세요.

`cors.json`:

```json
[{"origin":["https://aicall.ai.studio"],"method":["GET","HEAD"],"responseHeader":["Content-Type"],"maxAgeSeconds":3600}]
```

- 운영 origin은 브라우저 콘솔 CORS 오류의 `from origin '…'` 값으로 확인해 맞추세요 (현재 `[미확인]`).
- 버킷 이름은 `firebase-applet-config.json`의 `storageBucket`(`gen-lang-client-0592656565.firebasestorage.app`)을 기준으로 하며, 실제 생성된 버킷 이름이 다르면 `gs://<버킷>` 부분을 실제 이름으로 바꿉니다.

### 휴대폰(브라우저)만으로 Cloud Shell에서 적용하는 단계

1. `console.cloud.google.com` 로그인
2. 오른쪽 위 Cloud Shell 활성화(`>_`)
3. `cors.json` 생성:
   ```bash
   cat > cors.json <<'EOF'
   [{"origin":["https://aicall.ai.studio"],"method":["GET","HEAD"],"responseHeader":["Content-Type"],"maxAgeSeconds":3600}]
   EOF
   ```
4. 버킷 CORS 정책 적용:
   ```bash
   gcloud storage buckets update gs://gen-lang-client-0592656565.firebasestorage.app --cors-file=cors.json
   ```
5. 적용 결과 확인:
   ```bash
   gcloud storage buckets describe gs://gen-lang-client-0592656565.firebasestorage.app --format="default(cors_config)"
   ```

- 명령 출처: https://docs.cloud.google.com/storage/docs/using-cors
- **적용 후 확인**: 버킷에 CORS를 걸면 SDK 업로드 응답에도 영향이 있는지 `[미확인]`입니다. 적용 뒤 통화 1회를 걸어 녹음 조각 업로드가 정상 동작하는지 확인하세요.

---

## (e) 지금 당장 급하지 않은 이유와 서버 중계 저장소의 한계

- **급하지 않은 이유**: 코드 수정(`QA-2`) 이후 직접 업로드가 실패하거나 12초를 넘기면 즉시 10분간 서버 중계(`/api/recordings/upload-chunk`)를 우선 사용하도록 전환되므로, Firebase Storage를 켜기 전에도 통화 중 녹음 조각은 서버로 정상 저장된다.
- **서버 중계 저장소의 한계**: 서버 중계 경로는 서버 로컬 디스크의 `.data/recordings` 디렉터리에 파일을 저장한다. 따라서 Cloud Run 등 배포 환경의 컨테이너가 재시작되거나 재배포·초기화되면 `[미확인]` 서버 디스크에 저장된 녹음 파일이 사라질 수 있다. 녹음 파일을 영구 보관하려면 위 절차에 따라 Firebase Storage를 활성화하는 것을 권장한다.
