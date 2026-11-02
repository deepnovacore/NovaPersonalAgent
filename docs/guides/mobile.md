# Supervised mobile use

`mobile.run` is Nova's phone capability. The current engine uses the native TypeScript Midscene SDK (1.12.9), with `autoglm-phone` as the model. It adds no Python service. The legacy `autoglm` executor remains available independently.

Nova owns task admission, approvals, cancellation, device ownership and result trust. Midscene owns screenshot-based planning. Guarded Tap, Type, single Swipe and Home actions reach WDA or an explicitly selected Android device through fixed ADB commands. Android also supports Back and launching an installed app by exact package name. This small transport avoids the SDK iOS client's automatic fallback actions and incomplete timeout coverage. Model-generated shell commands, arbitrary intents or WDA requests, and automatic device selection are unavailable.

## Configuration

Select `mobile` in `EXECUTORS` and supply:

| Variable | Value |
| --- | --- |
| `MOBILE_ENGINE` | `midscene` (default; other engines rejected) |
| `MOBILE_DEVICE_TYPE` | `android` or `ios-simulator` |
| `MOBILE_DEVICE_ID` | Exact authorized ADB serial or booted simulator UUID |
| `MOBILE_WDA_URL` | Existing loopback WDA, e.g. `http://127.0.0.1:8710` |
| `EXECUTOR_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` |
| `EXECUTOR_MODEL` | `autoglm-phone` |
| `EXECUTOR_MODEL_FAMILY` | `auto-glm` |
| `EXECUTOR_API_KEY` | Secret supplied locally, never committed |
| `EXECUTOR_MAX_STEPS` | Default 30, maximum 100 |
| `EXECUTOR_TIMEOUT_SECONDS` | Default 600, maximum 1800 |
| `EXECUTOR_SETTLE_MS` | Default 4000, range 0–30000; wait for iOS animations before initial planning and after actions |

Provision a WDA session before dispatch. The runner borrows it without starting WDA, creating a session or changing its settings. It verifies the simulator UUID and local WDA listener process identity; physical iOS currently fails closed. WDA and the runtime need local `simctl`, `lsof` and `ps` access.

## Android preparation

Select `MOBILE_DEVICE_TYPE=android` and the serial shown as `device` by `adb devices -l`. Install and enable ADB Keyboard as described in [AutoGLM setup](autoglm.md#optional-android-setup). Input appends UTF-8 text to the focused field and restores the previous input method, including after cancellation. Keep USB debugging enabled; some OEM phones also require their separate USB debugging security permission for input injection. WDA is unused on Android.

Launch accepts only an exact installed package name; no application-name mapping or shell command is inferred. Every action passes through Nova's existing approval and device/window guard. Midscene plans from full device screenshots; coordinates use that same screen. Pixel changes alone do not invalidate an action. A changed foreground window or screen dimensions stops the run with `screen_changed`. An uncertain ADB write or keyboard restoration retains the device quarantine lock.

## Interaction with Nova

This follows the existing downstream-agent controller and event path used by coding agents. `mobile` is registered as an agent with a reserved `run_id`; the conversation cannot invoke an unreserved run directly.

| Midscene / host event | Nova channel |
| --- | --- |
| `aiAct.plan_thinking` | Existing executor progress, fixed planning summary |
| Guard about to request permission | Progress plus the shared host approval UI |
| Host accept / decline | Structured `HostApprovalController` decision, consumed once |
| Concrete WDA request returns | Progress and last returned action evidence; no claim about its effect |
| Model finishes | Untrusted handoff with `verified:false`, `effects:unknown` |
| Nova cancellation / deadline | Abort latch, approval invalidation and no subsequent device action |

The SDK exposes action/plan lifecycle events; this integration does not claim token-by-token model streaming. Raw thoughts, screenshots, parameters and provider errors are not copied into trusted progress summaries. Rejected actions abort the runner because the SDK otherwise catches action errors and may replan.

## Extending it

Model URL, name and family are independent of the `mobile` capability. This first implementation admits AutoGLM families only; enabling another family requires verifying its action mapping, cancellation and completion semantics. A different agent replaces `runMobileIos` behind `MobileExecutor`; the host controller, shared approvals and device lock remain intact. There is no general plugin protocol or Python bridge to maintain.

Both phone engines use the existing `autoglm-devices` lock directory during migration. A crash or uncertain write leaves a quarantine directory; remove it only after confirming the old owner and device writes have stopped. `cleanup_unknown` overrides a cancellation result when the write's completion cannot be established.

## Acceptance

Build serially, then run `node runtime/scripts/accept-mobile-simulator.mjs /absolute/path/evidence.json` with explicit simulator configuration. This exercises a local scripted model through real Midscene and WDA, including approval, decline and cancellation.

Run `node runtime/scripts/accept-mobile-actions-simulator.mjs /absolute/path/actions.json` to verify Tap, Type and Swipe on a local Safari fixture. The page records actual click/input/scroll events; model completion alone does not pass these checks. Keep evidence in a persistent private directory rather than temporary storage.

For a bounded live-model Home task, add `--live` and set `NOVA_MOBILE_MODEL_CONFIG` to a private JSON file with `baseUrl`, `model`, `modelFamily` and `apiKey`. The harness accepts only one exact Home action, and separately checks the foreground app through WDA. Never use this harness against a personal phone.

Nova checks device identity, foreground context and geometry before and after approval; it does not equate pixel equality with action validity. Midscene owns visual planning and observes again after each action. In-place changes inside the same window can still make a planned action stale: this is a supervised GUI agent, not an atomic UI transaction. Host approval authorizes the exact proposed action, and model completion remains unverified. The settling delay reduces planning during animations; it does not guarantee a stable screen. The simulator Home harness separately waits for its fixture to settle. A dispatched WDA write cannot be undone; cancellation waits for acknowledgment or a bounded timeout, retaining the lock on uncertainty. The SDK's post-action settling wait can also delay cancellation completion by up to `SETTLE_MS`; no subsequent write is permitted. SDK report and file logging are disabled; SDK warnings and explicitly enabled debug console output remain upstream behavior. The SDK is trusted local code, not an OS sandbox.

For Android with real models, run `node runtime/scripts/accept-mobile-android.mjs ENV_FILE PRIVATE_MODEL_JSON ADB_SERIAL INSTRUCTION OUTPUT_JSON`. This submits text through the production Nova frontend and `host.dispatch`, then uses the real mobile executor, host approval controller, Midscene and ADB. Enter `accept` for each reviewed action; other input declines a pending action. When no action is pending, input is sent to Nova as a follow-up. The private model JSON has `baseUrl`, `model`, `modelFamily` and `apiKey`. The report includes dispatch, approvals and terminal evidence; independently inspect the phone for the requested UI result. This does not test the desktop UI, physical microphone or speaker.

## 手机端模型与密钥配置

Standalone 模式的 Flutter Android/iOS 客户端在 **设置 → 配置密钥** 统一管理服务密钥：
选择服务商卡片、打开获取密钥链接、填写密钥，再列出模型并测试连接／工具调用能力。
测试成功只保存密钥，**不会自动切换当前对话模型或 ChatGPT 登录模式**；已保存的密钥不会回显。
不支持对话测试的语音接口使用同页的「语音专用密钥」，语音设置仍可直接编辑其服务密钥。

**设置 → 模型服务** 只负责对话模型、信息整理和语音服务的选择。
对话／信息整理从已配置的服务中选择模型；列不出模型时可以手填模型名。
模型选择页的「配置密钥」链接打开同一个密钥管理页，不再提供另一套密钥录入表单。
服务密钥仍保存在当前 Space 的本机安全存储中，无需迁移；Client/Host 配置流程不变。

## Android 原生虚拟屏（手机操作）

This is separate from `mobile.run` above. In the Android Flutter client's standalone Space, Nova can use apps on the phone itself, on a private virtual screen, while the user keeps using the main screen. No computer, root or Play distribution is involved: the APK is sideloaded, and Nova borrows Android's own Wireless debugging once to start a small helper. Hub/client mode and iOS are unchanged. The wire contract, security invariants and failure codes are in [`docs/specs/mobile-virtual-display.md`](../specs/mobile-virtual-display.md).

### Setup

Open **Settings → 手机操作 / Phone control**. The page lists accessibility, display over other apps, background running, notifications, wireless-debugging pairing, the helper state and the Android version. **设置向导 / Setup guide** walks through:

1. Turn on Developer options (only the switches the guide names; others can erase data).
2. Turn on Nova's accessibility service. A sideloaded APK may first need **App info → ⋮ → Allow restricted settings** on Android 13+; the guide links there.
3. Allow notifications, used for the pairing code, task progress and "needs you" alerts.
4. Turn on Wireless debugging, then **Pair device with pairing code**. Nova reads the code from the settings window through accessibility, or the user types it into the notification or the in-app field (with the port when asked).
5. Nova connects to its own adbd over TLS on `127.0.0.1` and starts the helper. The helper state turns **已连接 / Connected**.

**Display over other apps** is optional: without it the floating pet cannot appear; everything else works. **Keep running in background** keeps long tasks from being ended by the system. After pairing once, the helper reconnects by itself after Wi-Fi changes or a restart, as long as Wireless debugging is turned on again. **开始自检 / Start self-check** creates a temporary virtual screen and checks helper, display, app launch, tree reading, tap, typing, back and focus; each failed row says what to do, and **复制自检详情** copies only fixed codes for a report. **解除配对 / Unpair** deletes the pairing; Nova can also be removed under Wireless debugging → Paired devices.

### Tiers

| Device | What Nova does |
| --- | --- |
| Android 14+, accessibility on, helper running | **Virtual screen.** The app runs on Nova's own display; the main screen and keyboard focus stay with the user. |
| Android 12/13, same conditions | Virtual screen as **experimental**, only after the user confirms the warning on the Phone control page: launching on the virtual screen can briefly take main-screen focus (for example while typing). Until confirmed, runs use the main screen. |
| Below Android 12, not paired, helper down or accessibility off | **Main screen**, the existing accessibility path, unchanged. |

The tier is fixed when a run starts. A virtual run never falls back to the main screen mid-task: if the helper disappears the run stops (`helper_unavailable`). A virtual run may use only the app the user asked for (plus system permission/picker screens); any other foreground app hands the task to the user. Chat, workbench `device.run_task` and voice delegation all take this path. Budget: 15 minutes per virtual run (5 of them for the agent), 5 minutes on the main screen.

### What the user sees

- **In Nova**: a small live picture of the virtual screen floats over the chat (drag it to a corner, tap to enlarge, **Stop** ends the task). The chat timeline groups the run's steps, shows only the last five while it runs and collapses to one line ("N steps · duration") at the end. The realtime voice page shows the character and the virtual screen side by side, without interrupting the call.
- **Needs you**: login, payment, lock screens and `FLAG_SECURE` pages need the user. The border breathes orange; **我来 / Take over** moves the app to the main screen and pauses the agent, **处理好了 / Done** moves it back and the agent continues with a fresh look. A takeover longer than 10 minutes ends the run.
- **Outside Nova**: with overlay permission, the floating pet (the call overlay, with the selected pet portrait) shows a progress ring, breathes when Nova needs the user, and expands to the latest step, a small preview (up to 5 fps) and **Stop** / **Take over**. Tapping it returns to Nova. A task notification is shown while the pet carries a task. If overlay permission is missing, Nova shows one in-app hint per session; other overlay failures fall back silently to the in-app picture.

### Limits

- **OEM ROMs**: some (for example MIUI/HyperOS "USB debugging (Security settings)", and other vendors' similar switches on ColorOS and others) block shell input injection. Accessibility gestures still work; keys and fallbacks fail, which the self-check reports under tap/back. Some apps refuse secondary displays or relaunch onto the main screen; the run stops with `display_unavailable`. Not yet verified across vendors.
- **Wireless debugging** turns off after a Wi-Fi change or reboot, and adb authorizations can expire after about 7 days unused; the helper then reports `wireless_debugging_off`, `no_wifi` or `authorization_revoked` and the setup guide offers the fix.
- **FLAG_SECURE**: secure windows are black on the virtual screen and in frames; Nova only allows back or a handover there, never blind taps.
- **Android 12/13** are experimental (focus can be taken briefly); Android 14+ works best, and an untrusted display on 14+ is reported by the self-check focus row.
- **Sideload only**: the helper relies on an exported provider and an `app_process` launch from the installed APK; the build is not for Play distribution.

### Privacy

Frames of the virtual screen stay on the device. They are produced only while a preview is visible (the in-app picture, the voice page or the pet's expanded preview), never during a takeover or for secure frames, and are never logged. The pet window sets `FLAG_SECURE` whenever it carries a task, so screenshots, screen recording and casting do not capture its preview or card. The agent's observations of the target app (element list and a screenshot of the virtual screen) are sent to the model provider the user configured, as for any other model call; password fields are never named by their text, typed text never appears in step labels, and error codes carry no screen content. The ADB key is wrapped with Android Keystore and never exported or backed up.

### Acceptance

Automated: `flutter test` (phone channel, wire contract fixture, pet integration, picture, timeline, setup page) and, from `clients/flutter/android`, `./gradlew :phone-core:test :app:testDebugUnitTest :nova_audio:testDebugUnitTest`. A release build must keep `HelperMain`, `NovaShellService` and the `INovaShell` stub unobfuscated. Device acceptance is still required on Android 14+, Android 12/13, an Android 11 device (main-screen fallback) and at least one OEM ROM such as MIUI/HyperOS or ColorOS.
