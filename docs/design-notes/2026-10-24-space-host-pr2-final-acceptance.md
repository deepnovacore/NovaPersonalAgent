# PR2 final review and acceptance — 2026-10-24

Scope: PR #2, public `v1.1.0dev` ancestry; starting head `3d377bc3`. Fixes are pushed only to the fork PR branch. No release or merge is implied. A local backup preserves the original head. Existing unrelated worktrees and installed application data were not changed.

## Fixes and one-round review

| Location | Reproduced behavior / evidence | Severity | Resolution |
|---|---|---|---|
| `push-gateway/src/store.ts` | Unreleased gateway carried a legacy importer and obsolete migration tables. User confirmed old state need not be retained. | Cleanup | `70fc9088`: delete importer and two migration-only tests; quota, lease and GC coverage retained. |
| `runtime/scripts/live/space-host.mjs` | Symlinked TMPDIR failed before the mock model request with a ledger storage error. | Medium | `70fc9088`: canonicalize the created directory; actual live-script regression reaches the mock provider. |
| `clients/flutter/lib/space/space_storage.dart` | A pending intent persisted the installation credential as plaintext. | Medium (P2) | `cd964581`: encrypt the state with AES-GCM and keep its key in platform secure storage; missing key fails closed. Regression verifies plaintext absence and round trip. |
| `clients/flutter/lib/space/client_state.dart` | Recovery changed request state to unknown but left its user message displaying sending. | Medium (P2) | `cd964581`: recover both states; regression covers persisted pending chat. |
| `clients/flutter/lib/space/client_controller.dart` | A 5,000-character Chinese chat exceeded the 64 KiB sealed transport limit and appeared as an unknown delivery. | Medium (P2) | `cd964581`: validate actual UTF-8 sealed envelope before durable admission; explicit UI error and regression. |
| `clients/flutter/ios/Runner/NovaSpaceTools.swift` | Fractional-second ISO dates emitted by Dart were rejected by the native calendar/reminder parser. | Medium (P2) | `cd964581`, project wiring `826db630`: shared fractional/whole-second parser, compiled Swift checks. |
| `runtime/src/model/personal-writer.ts` | Real Qwen returned valid JSON inside a complete Markdown fence; unnecessary retries exhausted the existing source-processing call budget. | Medium | `87b2e271`: reuse the existing complete-fence parsing rule; schema and reference validation remain; regression rejects extra prose and invalid schema. No processing budget increase. |
| Native interop harness / golden fixture | Windows Java argv mangled non-ASCII expected plaintext; settings golden still said Data sync after the existing Local data rename. | Test correctness | `87b2e271`: base64url expected bytes; visually inspected and updated one golden. |

One independent review round covered the remaining Space Client/Host boundary, iOS NSE and native tools, Android FCM/MiPush wiring, desktop/Hub removal references, projection boundaries and relevant documentation. Four concrete P2 findings above were reproduced and fixed. Earlier reviewed gateway/relay issues were rechecked through regression tests, not subjected to repeated speculative review.

Not exhaustively reviewed: every line in the full PR, unrelated native local-model/workspace internals, every packaging/documentation assertion, production push service configuration. **未经独立密码学评审**. Standard-library interoperability and tamper tests do not replace the independent review required by O7.

## Acceptance evidence

Every row states its evidence tier. All live model inputs were synthetic. Device behavior is not inferred from unit tests or unsigned builds.

| Tier | Check | Result / evidence |
|---|---|---|
| 1 | Space build and regression stack | macOS 122/122 plus real loopback Host integration PASS. Two removed legacy importer tests explain the change from 124. Windows Server 2022 / Node 24.20.0 also 122/122 plus Host integration PASS. |
| 1 | Native JWE and dates | Node JOSE to production Java AES-GCM, tampered tag/AAD and invalid IV checks PASS on macOS; Swift fractional/whole-second parser checks PASS. The same byte-based interop check is required by the Windows Space CI job. |
| 1 | Flutter | Pinned Flutter 3.47.7: analyze clean; Space 37/37 with actual Node relay/gateway; full suite 954 passed, 3 skipped, 0 failed after the reviewed golden correction. |
| 1 | macOS desktop | 1,474 passed, 14 skipped, 0 failed; actual Electron utility capability smoke PASS. Windows-only startup check is skipped locally. |
| 1 | Runtime | Initial full run: 4,398 passed, 11 skipped, five missing Node SQLite ABI failures; after native rebuild all nine focused mem0 tests passed. Final parser regression: 8/8. A later invocation from the Space-only output was stopped because full-runtime source fixtures require the normal worktree layout; no product failure is inferred from that harness mismatch. |
| 1 | Android FCM | Debug APK with actual bundled Linux runtime built locally; 65 native unit tests passed, no failures/skips. |
| 1 | Android MiPush | Local debug build and 65/65 native tests PASS; historical official 5.1.2-C SDK, SHA256 `05b3304e96beca6b890de202583e9de4d9e105fcd6bb3ac03a47c7f7006ad6fa`. This is not a latest-SDK or vendor-account acceptance claim. |
| 1 | iOS Runner + NSE | CI run `40082020865` on `826db630` PASS; complete iOS build not rerun locally. Local compiled date checks are separate evidence. |
| 1 | Linux installed server package | CI run `40082020854`, Linux Electron job PASS, including pack, npm install and installed CLI initialization verification. |
| 1 | CI | [PR checks](https://github.com/FishWoWater/NovaAudioAgent/pull/2/checks) are authoritative for the final head. Code follow-up `87b2e271` triggers run `40083578269`; this document does not pre-claim its result. Earlier run `40082020854` passed Linux/Windows Electron and macOS/Linux Space; its Windows Space job failed only at the Java expected-plaintext argv comparison corrected in `87b2e271`. |
| 2 | Real model chat | Qwen-plus: streaming preview, disconnect, durable full reply, repeated same op accepted once / one user turn PASS. Run `1fb34986-7c7a-4f64-84eb-61d0887a211b`, chat request `chatcmpl-bd733087-b094-9bce-b44d-1c5b9ea4c5db`; eight chat checks passed before a separate source-network failure. The combined report is correctly marked failed; only its chat phase is claimed here. |
| 2 | Real source processing | Qwen3-VL-plus run `8cfaa5bc-9a0a-4e39-93dd-e9db7dbb48be`: all eight checks PASS, 11 HTTP requests, seven internal composition calls, three tool calls. Durable processing status reached Client while original evidence and inferred Profile remained private; processing and upload revocation PASS. Prior attempts honestly failed: malformed tool JSON, direct-network timeout, then unnecessary fenced-JSON retries. Upload without consent rejected; upload-only generated no model calls. |
| 2 | Cost and data | 38 requests total, conservative cumulative reservation CNY 4.268955 (not a billed total). Shared persistent guard: at most 40 requests, conservative cumulative reservation below CNY 9.5; only Qwen-plus / Qwen3-VL-plus and synthetic paper-boat text. No private source data, real recipients or vendor push credentials. |
| 3 | iOS lockscreen / NSE on device | BLOCKED_HUMAN: iPhone, APNs credentials, App Group and signed app required; record locked/background/killed states and generic fallback. |
| 3 | Android FCM and MiPush arrival | BLOCKED_HUMAN: GMS and HyperOS devices plus vendor projects/credentials; record foreground, background, lockscreen, Doze, killed and force-stop separately. |
| 3 | Overnight / process-kill recovery | BLOCKED_HUMAN: physical devices and overnight observation; record complete reply and exactly-once Host model call after restart. |
| 3 | Release signing / current vendor SDK | BLOCKED_HUMAN: release certificates and publisher access; install and run signed packages. |
| 3 | Independent cryptographic review | BLOCKED_HUMAN: independent reviewer and written findings. |

## Decisions and limits

- Default gateway capacity remains 100 installations. Invitation distribution and capacity policy are a product/operations decision; no new admission mechanism was designed.
- No legacy gateway state must be preserved; user explicitly allowed reset. No deployed state was deleted during this work.
- O1 relay replacing Tailscale for the product path, O2 Host-driven native phone tools, and the public `fork/v1.1.0dev` document base are already recorded decisions; this work does not reopen them.
- Reverse-proxy deployment still requires explicit trusted-proxy configuration and blocking direct origin access.
- Builds/caches and private acceptance logs use the selected external disk. A brief disk disconnect interrupted new work; mounting and worktree state were verified before resuming. No fallback build on the system disk.
- Private logs are retained separately and are not published with credentials, private endpoints or model state. No new character assets are included; the golden is a generic settings screen.

Android artifact SHA256 (debug only):

- FCM: `14052b211a822ce7dc15e86c30f51465e1845e0224b02bb695d9946d393913f3`.
- MiPush: `69e556d0c0fc049489ed01d6d2896bce54fd47b7f2e6ba3ca07cf6a02e00058a`.

Reproduction: `npm run build:space -- --output-root <external-root> --run-id <chat-id>` then `npm run test:space` with the same arguments; `node push-gateway/test/native-crypto-checks.mjs` with the same arguments; `flutter analyze`, `flutter test`, Android `:app:testDebugUnitTest` and `:app:assembleDebug` for each provider. Model acceptance uses `runtime/scripts/live/space-host.mjs`, with a private bounded request wrapper and `--source-only` for the final source run. Use the matching external build and never publish credentials or raw private state.
