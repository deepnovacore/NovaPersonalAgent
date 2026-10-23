# Push gateway

This independent Node service owns APNs, FCM and MiPush device tokens. A Client registers its token directly here; only the returned random `handle` and scoped `credential` travel to its Host inside the paired E2E channel. A Host supplies a separately generated notification key to that Client in an encrypted `push.key` mailbox message. The mobile bridge stores this key in shared iOS Keychain or Android Keystore-wrapped storage.

Gateway metadata includes device tokens, provider, handle, send time and ciphertext size. It receives no Space ID, notification plaintext, or notification decryption key. Provider authentication and error bodies are never logged or returned. APNs and FCM receive a compact standard JWE with `alg=dir`, `enc=A256GCM`; MiPush receives only generic public-channel text and opaque click identifiers. An `accepted` result means provider acceptance, not delivery to a device.

## HTTP contract

All deployed traffic must use HTTPS, normally through a TLS reverse proxy. The CLI binds to loopback by default and refuses to start without an admission key and at least one configured provider.

| Request | Authorization | JSON / result |
| --- | --- | --- |
| `POST /v1/registrations` | `Bearer <admission key>` | `{provider:"apns"|"fcm"|"mipush",token,environment?:"sandbox"|"production"}` → `201 {handle,credential}` |
| `POST /v1/push` | `Bearer <handle credential>` | `{handle,notificationId,ciphertext}` → `{status,retryable:false}` |
| `PUT /v1/registrations/<handle>` | `Bearer <handle credential>` | `{provider,token,environment?}` → `{status:"updated",handle}`; preserves handle, credential and notification key on token rotation |
| `DELETE /v1/registrations/<handle>` | `Bearer <handle credential>` | `{status:"unregistered"}` |

Only the documented fields are accepted. `notificationId` is an opaque ASCII identifier (letters, numbers, underscore or dash; at most 128 characters). Ciphertext is at most 3000 bytes; JWE protected headers contain only `alg` and `enc`. Private content is a JSON `{title,body}` encrypted by the Host. Native title/body limits are 120/1024 characters. Oversized Host content becomes an encrypted generic notification.

Multiple Spaces in one installation keep separate live handles for the same token; their token-level quota is shared. Token rotation updates each saved Space's handle using authenticated PUT, preserving its Host key and handle; invalid-token feedback revokes all handles using that token. Credential hashes, tokens, quotas and delivery receipts persist in a private `0600` atomic/fsynced JSON state file. A single-process lock prevents two writers; after a process crash an operator must verify the old process is stopped before removing its `.lock` file. Reserve-before-send records `unknown` before external I/O. An ambiguous error, timeout or process crash does not trigger another send for that ID. Definitive APNs/FCM invalid-token feedback revokes the registration. Unknown MiPush rejection codes do not guess token invalidity.

Default send limits are 100 attempts per device per UTC day and 10,000 global attempts per UTC day; new handles do not reset a token's budget. MiPush additionally caps a token at five attempts per rolling 24 hours, conservatively covering vendor day boundaries. Unknown sends consume quota. At the durable receipt capacity (one million) new sends fail closed with `quota_exceeded`; operators rotate storage only after revoking the affected handles. App mailbox sync remains the source of truth.

Admission is a deployment-provisioned, at-least-32-character bearer secret, not anonymous public enrollment. Deliver it through trusted provisioning and do not compile a shared admission secret into a public mobile build. This package does not implement an identity/enrollment service. The gateway state directory and credential files must be private to its service account.

## Run and verify

Use the monorepo's isolated build command or the test harness with an existing selected build root:

```sh
node push-gateway/scripts/test.mjs --output-root /workspace --run-id your-chat-id
```

The harness prints no credentials and never sends a real vendor push. Compiled output is namespaced by worktree and run ID. Start its `src/cli.js` with deployment-supplied environment variables:

| Variable | Configuration |
| --- | --- |
| `NOVA_PUSH_STATE_FILE` | Private durable state file |
| `NOVA_PUSH_ADMISSION_KEY_FILE` | File containing the trusted-enrollment admission secret |
| `NOVA_PUSH_BIND`, `NOVA_PUSH_PORT` | Default `127.0.0.1:8788` |
| `NOVA_PUSH_DEVICE_DAILY_LIMIT`, `NOVA_PUSH_GLOBAL_DAILY_LIMIT` | Optional positive integer attempt caps |
| `NOVA_APNS_KEY_FILE` | Apple `.p8` file, used only by gateway |
| `NOVA_APNS_TEAM_ID`, `NOVA_APNS_KEY_ID`, `NOVA_APNS_TOPIC` | Apple team/key IDs and app bundle ID |
| `NOVA_FCM_SERVICE_ACCOUNT_FILE` | Google service-account JSON with FCM send permission; OAuth v1, no legacy server key |
| `NOVA_MIPUSH_SECRET_FILE` | MiPush server app-secret file |
| `NOVA_MIPUSH_PACKAGE`, `NOVA_MIPUSH_PUBLIC_CHANNEL` | Registered package and approved public-message channel |

Provider classes accept an injected HTTP boundary for offline contract tests. APNs uses Node HTTP/2 plus JOSE ES256 provider JWTs; FCM exchanges a JOSE RS256 service-account assertion for a cached OAuth token and sends data-only HTTP v1 messages. MiPush calls its registration-ID v3 endpoint using the approved public channel. Regional MiPush endpoint selection is available in its constructor and must match the publisher account.

The full real-loopback contract can be run against isolated compiled outputs:

```sh
node push-gateway/test/host-integration.mjs --gateway-output /absolute/gateway-output --runtime-output /absolute/runtime-output
```

It runs real Client registration HTTP, Host encryption, gateway authentication, duplicate suppression and revocation up to an injected provider boundary. It proves no device delivery.

The Android production AES-GCM core also compiles and runs independently of an Android SDK against a JOSE-generated JWE, including tampered tag/AAD and IV-bound rejection:

```sh
node push-gateway/test/native-crypto-checks.mjs --output-root /workspace --run-id your-chat-id
```

This checks the production Java cryptographic core on the JVM. Android app compilation additionally uses Android SDK 36, NDK 28.2 and JDK 21; iOS target compilation requires Xcode.

## Mobile publisher setup and unverified device matrix

`clients/flutter/ios/Runner.xcodeproj` includes an embedded `NovaNotificationService` target, APNs registration callbacks and shared Keychain/App Group entitlements. Configure the same Apple signing team for both targets, enable Push Notifications on the main App ID, provision the shared App Group/Keychain access group, and override `NOVA_PUSH_SHARED_IDENTIFIER` / `NOVA_PUSH_EXTENSION_IDENTIFIER` for the publisher. Debug defaults to APNs `development`; Release/Profile use `production`. Match gateway registration `environment` to the signed app. NSE decrypts a standard JWE locally; missing key, oversized payload, failure or timeout preserves a generic notification. No silent-push delivery dependency exists.

Android uses `NovaPushApplication`, a data-only `FirebaseMessagingService`, a notification-permission prompt and a notification tap bridge. Configure Gradle properties `novaFcmApplicationId`, `novaFcmApiKey`, `novaFcmProjectId`, `novaFcmSenderId` for a registered Firebase Android app. No service-account/private server credential belongs in the APK. `onDeletedMessages` records a full-sync signal; a notification is only a wake hint.

MiPush builds additionally set `novaPushProvider=mipush`, `novaMiPushSdk=/absolute/official-sdk.aar`, `novaMiPushAppId`, and `novaMiPushAppKey`. The optional receiver compiles only with that official SDK. Select a current official SDK compatible with the declared handlers/services and confirm its merged manifest/package/signature requirements. Its client app key is vendor-required client configuration; the server app secret remains gateway-only. No credentials or vendor binary are committed. The service requests public-channel messages only, with generic text; no private-channel/unlimited allowance is claimed.

Flutter channels are `nova/space_push` (`requestPermission`, `getToken`, `configureSpace`, `removeSpace`) and `nova/space_push/events` (`token`, `open`, `syncRequired`). `configureSpace` takes `{handle,notificationKey:<base64url 32 bytes>}`. iOS token registration is asynchronous; `getToken` can initially return null, followed by a token event. Logout/revocation must remove both gateway handle and native key. The Host gateway URL comes from Host configuration and is HTTPS-only; Client input cannot redirect it.

The managed Linux validation workspace has Android SDK 36, NDK 28.2 and a complete JDK 21. The complete default FCM Android debug APK build (`:app:assembleDebug`) passed against real Flutter/Firebase dependencies, including MainActivity, the FCM service, manifest merge, native packaging and debug signing. App unit tests (`:app:testDebugUnitTest`) passed 65/65 with no failures, errors or skipped tests, including the native Space role/isolation checks. A separate MiPush-configured APK also compiled and packaged against the historical official 5.1.2-C AAR, with the same 65/65 tests passing. Its APK contains the actual vendor SDK and `NovaMiPushReceiver`; manifest merging retains the vendor handler permission and push-service process. No publisher credentials were supplied and neither APK was launched.

The [official integration guide](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1544) links to the [official download page](https://admin.xmpush.xiaomi.com/zh_CN/mipush/downpage), whose public history provides the [5.1.2-C archive](https://land.xiaomi.net/res/e79af868/client-sdk/MiPush_Client_C_Android_20221107.zip) dated 2022-11-07. The AAR SHA-256 is `05b3304e96beca6b890de202583e9de4d9e105fcd6bb3ac03a47c7f7006ad6fa`. This validates that historical version only; D8 reports stack-map warnings in its vendor bytecode. The current SDK listing endpoint returned HTTP 401 without a publisher login, so a current SDK remains a publisher acceptance item. The workspace has no Xcode, Apple signing identity/device, Android device, Firebase publisher project/service account, or MiPush account/AppID/AppKey/AppSecret/approved public channel. iOS compilation and real lock-screen arrival remain external acceptance items. Test foreground/background, terminated process, iOS NSE timeout/key unavailable, Android notification denial/Doze/force-stop, token rotation/reinstall, MiPush public quota, and tap-to-mailbox refresh on signed real devices. No arrival claim can be made from compile or server contract tests.


## Native Space isolation

Before constructing a local engine, Flutter calls `nova/space_scope.setSpaceScope({spaceId,mode})`; foreground and scheduler engines both install this channel. Client/unselected mode refuses native local planner/workspace calls. Independent Spaces have separate Android model-key aliases, encrypted settings, task databases, Linux root filesystems and workspaces. iOS uses per-Space model Keychain accounts, task journals, model-transfer folders and workspace/root-filesystem directories; requests retain their originating Space during cancellation and cleanup.

The current iOS iSH kernel cannot change its booted root filesystem within one app process. After using a terminal in one Space, switching to another Space requires fully quitting and reopening the app before using that terminal. The native bridge fails closed with `space_runtime_restart_required` and the UI displays “切换空间后请完全退出并重新打开 App 以使用本地终端”. Ordinary model/chat functionality continues using the selected Space's credentials and stores. No old Space's terminal root is reused.

Validation snapshot (2026-10-23): the final source snapshot, including the Client `source_processing` summary UI, rebuilt successfully and was byte-compared with `clients/flutter/lib` and `android/app/src`. Debug APK SHA-256: `fbf9deba2079ed1e3239e397385ebc37c765a38231c9911392120ab1b86067f6`. The unchanged native test suite remained green at 65/65. This is compile/package evidence; no real push was sent.

MiPush 5.1.2-C validation snapshot (2026-10-23): the same source snapshot passed `:app:assembleDebug :app:testDebugUnitTest` with `-PnovaPushProvider=mipush -PnovaMiPushSdk=/absolute/MiPush_SDK_Client_5_1_2-C_3rd.aar`, leaving AppID/AppKey empty for compilation. APK SHA-256: `48372e832fd76dd34616108a090874a77fabb0682bc13dada369b362f17a03f5`. The default FCM APK was preserved separately. No default source change or vendor binary was needed in the repository.
