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

## (c) Storage 보안 규칙 예시

Firebase 콘솔 → Storage → **규칙(Rules)** 탭에 아래 규칙을 참고하여 적용한다. (`firestore.rules`와 동일하게 단일 허용 계정 `episode.kim@gmail.com` 및 이메일 인증 완료 상태만 `users/{uid}/recordings/**` 읽기·쓰기를 허용하고 나머지는 거부한다.)

> 참고: 아래 예시는 문서 내 코드블록이며, 저장소 루트에 `storage.rules` 파일을 별도로 생성하지 않는다.
>
> AI Studio Republish(코드 Pull + 게시)는 앱 서버 컨테이너만 새로 올린다. Storage 규칙은 이 저장소에 규칙 파일(`storage.rules`·`firebase.json`)이 없으므로 게시로 바뀌지 않고, Firebase 콘솔 → Storage → 규칙 탭에서 직접 게시해야 한다. Firestore 규칙도 v2.8.1 기록상 「AI Studio에서 규칙 배포가 필요함」이라 별도 단계다.

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
        && file.matches('[0-9]{4}-[0-9]{2}-[0-9]{2}[.]wav')
        && request.resource.size < 60 * 1024 * 1024
        && request.resource.contentType == 'audio/wav';
    }

    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

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
