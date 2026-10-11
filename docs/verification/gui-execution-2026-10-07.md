# GUI implementation and live acceptance — 2026-10-07

Branch: `feature/gui-execution`, baseline `c0abf248` (`v0.4.0dev`). No merge, push or publish.

## Scope and implementation

Midscene 1.12.9 is the common screenshot planner. AutoGLM is a model protocol retained for mobile; Qwen3-VL now works through the same runner. Browser, computer and mobile have distinct public controllers/hidden channels and reuse TaskService, approvals, budgets, resource ownership and verification. No DOM selectors or AX/UIA control tree.

Browser uses a dedicated Playwright page and owned browser process. WebKit is Playwright's browser build; it does not attach to installed Safari. Installed Safari was the fixture for the Mac OS input test. Desktop is single display; window/display metadata is checked before/after screenshots and approvals. Input only appends at existing focus; keys omit locate. Tap uses public libnut with a configurable 100ms hold because the instant click did not fire Safari's button event reliably.

Native input runs in an isolated process. POSIX process owner and the existing verified Windows Job Object guardian own the full process tree. Windows needs the packaged guardian, or the existing `CODEX_RESOURCES_PATH`; missing resources refuse startup. Screenshot temporary files use a private directory deleted only after confirmed tree exit. An orphaned Windows driver lock never relies on a negative-PID probe for automatic reclamation.

WDA real iOS support requires the configured hardware UDID to appear over USB and a matching `iproxy --udid` loopback USB bridge to port 8100. Simulator identity checks remain separate. No phone ID, organization identifier or credential is stored in these changes.

## Evidence and task completion

Actual PNG/JPEG pixels are held transiently, never put in task JSON or handoffs. Evidence references bind work/session/target. The first four and last four frames of each work are retained, with a global ceiling of 16 frames and 15 minutes; longer/restarted verification needs fresh observation. This is an explicit RAM limit, not durable evidence.

The existing GatewayTaskVerifier sees the real images. Only actual bound image references may alias their owning work evidence. Model Finished is an execution result (`verified=false`), never task completion. Empty acceptance lists have explicit repair guidance; unknown refs or invalid indexes still fail closed. Terminal lifecycle notification survives a subsequent response delivery failure and is delivered once per event. GUI dispatch/approval/cancel rules are independent of coding capability. Whole-task cancellation is scoped to the current conversation, generation and executor; no owned task never falls through to the shared controller. Approval-carrier cancellation retains current user-origin fences and refuses completed/failed/fenced responses.

## Live evidence

- Browser production text frontend → TaskService/controller → shared approval → real Qwen3-VL/Midscene → Playwright WebKit coordinates → screenshot verifier: **passed**, durable task `completed`. Local fixture input `Nova 实机验收`, confirmation, bounded scroll and finish button all succeeded. Evidence: `/tmp/nova-gui-browser-final.json`, final screenshot `/tmp/nova-gui-browser-final.json.png`. First verifier reply used invalid criterion indexes for an empty acceptance list; its repair returned the valid owning work ref and empty criteria, then completion was persisted.
- Final browser rerun after cancellation/frontend fixes: **passed**, durable `completed`, 8 actions including select-all shortcut, Chinese input, confirmation, three scrolls and finish; final screenshot was manually inspected. `/tmp/nova-gui-browser-complete-final.json` and `.json.png`. The fixture auto-approval run logged response delivery races; task verification still completed. One earlier attempt only acknowledged the goal without dispatch and was stopped, not counted as a pass.
- Mac actual Safari, real Qwen3-VL/Midscene: native Tap/Input/Tap completed in 3 actions and the page showed `已确认：Nova 实机验收`. Evidence `/tmp/nova-gui-mac-quick.log`, screenshot `/tmp/nova-gui-mac-quick.png` (contains the user's browser chrome; not committed).
- Mac production text frontend/controller/approval/screenshot verification: **passed** for the separate read-only goal of confirming that visible state, durable task `completed`, zero page writes. `/tmp/nova-gui-mac-task-final.json`. This proves the readback task, not the full write/scroll/voice acceptance list.
- Earlier failed live attempts are retained in `/tmp/nova-gui-browser-production*.json/log` and `/tmp/nova-gui-live-*`. Blank middle-page content caused a planner to stop early; the repeatable fixture now includes a visible continuation instruction. Screenshot-reference/index protocol failures stayed waiting. They were not signed off as passes.
- Browser pending-navigation cancellation through the real text frontend: **passed**, persisted `cancelled`, no page navigation/input approval granted, no observations or writes executed. `/tmp/nova-gui-browser-cancel-green.json`. The harness intentionally exits nonzero for a cancelled goal. Earlier cancellation attempts failed and are not passes.
- Previous desktop quarantine was released only after both recorded host and process group were absent and the controlled page readback was inspected; recovery record `/tmp/nova-gui-quarantine-recovery.json`.

## Remaining physical gates

Android ADB currently lists no connected device. iPhone/WDA USB unavailable; no installed usable simulator runtime. No Windows test host was supplied. These live acceptance gates are **not passed**. Microphone/ASR voice cancellation is not covered by the text frontend harness. GUI settings remain opt-in.

## Repeatable checks

`npm run build --workspace runtime`, `npm run lint --workspace runtime`, `node --test --test-concurrency=4 runtime/dist/test/*.test.js`, `node runtime/scripts/check-env-contract.mjs --check`, and desktop build. Run runtime tests only after desktop build: the desktop script internally rebuilds and cleans runtime dist.

Local fixture: `node runtime/scripts/serve-gui-acceptance.mjs`; driver: `node runtime/scripts/accept-gui.mjs env-file browser|computer model-json target instruction output-json`. The optional `--fixture-auto` accepts individual browser proposals only for this exact loopback fixture, allowed action/parameter bounds and exact input. Production approvals are unchanged. Model JSON is a private temporary credential file, never committed.

Final desktop build validation passed. Desktop tests: **1,234 passed, 3 skipped (1,237 total)**. Lint and generated environment contract passed. The first complete runtime run after cancellation changes had 3 prompt contract failures (English map and outdated Qwen assertions/golden); those were repaired and the focused 15 tests passed. Final complete runtime rerun: **3,606 passed, 9 skipped, 0 failed (3,615 total)**, concurrency 4, 256.90 seconds. Log `/tmp/nova-gui-green-runtime-tests.log`. Desktop log `/tmp/nova-gui-complete-desktop-tests.log`; build `/tmp/nova-gui-release-candidate-build.log`; lint `/tmp/nova-gui-prompt-lint.log`. Source review passed, including current-generation cancellation and late completed-response refusal.

Mac full-write rerun was not started: the current foreground was Baidu Netdisk, and Safari window Raise/title-bar preparation did not change the system foreground identity. The driver does not approve native Connect or send input to that unrelated app. User foreground readiness is still required for the remaining Mac write/scroll gate.
