# macOS background GUI candidate — 2026-10-07

Status: production native action chain accepted on this Mac; complete real-model Nova task acceptance remains incomplete because model requests failed. Candidate is uncommitted; no merge, push or publication.

## Implementation and boundary

Midscene remains the screenshot planner. The existing owned computer worker, per-action approval, budgets, resource lock, cancellation/quarantine and visual TaskVerifier remain in use. Background mode is opt-in through `COMPUTER_MAC_WINDOW_PID` and `COMPUTER_MAC_WINDOW_ID`, with `COMPUTER_DISPLAY_ID=0`. Empty settings preserve display mode. No new dependency was added.

The signed/hash-checked `macos_gui` resource captures a window PNG in memory through ScreenCaptureKit and sends PID-routed native events. It does not use DOM selectors, AX control trees/actions/value writes, global event posting or pointer warp. AX reads native window identity metadata only. Each write validates process launch time, PID, window ID, geometry and Safari key-window identity. Text rechecks per scalar, with 30 ms event spacing and a 200 UTF-16-unit action limit.

A Tap briefly leases AppKit keyboard focus through private SkyLight focus records, sends the mouse activation primer and real click, then restores the current foreground application's key-window focus before returning its receipt. It does not raise the target window. This **does change keyboard focus temporarily**; it is not complete isolation from concurrent user keystrokes. Connect approval explicitly describes the lease. After the user explicitly authorized this mechanism, it was added to the candidate. Initial automatic-review rejection and approval timeouts are historical, not current blockers.

The host retains the focus snapshot and click-group identity outside the owned worker. If the worker dies during Tap, cleanup first confirms the writer group is gone, then sends a compensating mouse-up outside the target and restores foreground focus. Failure to establish cleanup/restoration keeps `cleanup_unknown` and ownership quarantine. Process termination cannot provide an unconditional guarantee if the host and every recovery process are killed together.

Scope: Safari only, an on-screen window on the current Space that remains Safari's key window. The user can use another application. Another Safari key window, minimize/close or geometry changes cause refusal. Build minimum is macOS 14. The tested Safari reports version 26.2 (20623.1.14.18.4). Private APIs require compatibility acceptance after OS changes; other applications, Spaces, packaged-app TCC permissions and other platforms remain unaccepted.

## Live evidence

Earlier disposable probes established feasibility but did not constitute product acceptance. A complete focus/primer mouse recipe subsequently focused the fixture reliably; comparisons of optimization, source lifetime or public/private delivery alone did not establish a root cause.

The latest setup diagnosed a concrete window mismatch: CUA was operating full-screen Safari window 100 while the production target was window 1029. Window 100 was exited from full screen and checked as on-screen and key; the production backend was then explicitly configured for that same window. Codex was restored to foreground before input. Production guards were retained.

The **production owned worker and built native helper**, with no disposable mouse probe, then performed:

1. Tap the local fixture input and enter `Nova 模拟前台验收`.
2. Tap confirmation; the page recorded exactly that text and `confirmed=true`.
3. Scroll down; the page recorded `scrollY=898` and a native screenshot showed the bottom button.
4. Tap completion; the page recorded `finished=true`, and the native screenshot visibly showed `验收完成：Nova 模拟前台验收`.

Every action returned through the owned worker; teardown returned `treeGone=true`. The final foreground metadata was Codex. These bounded observations do not prove uninterrupted foreground identity at every instant or safe simultaneous user typing. Temporary evidence: `/tmp/nova-focus-owned-integrated.log`, `/tmp/nova-focus-owned-finish.log`, `/tmp/nova-focus-integrated-confirm.png`, `/tmp/nova-focus-integrated-scroll.png`, `/tmp/nova-focus-integrated-complete.png` and `/tmp/nova-background-page-state.json`.

Real text frontend → task controller → computer executor → Midscene → TaskVerifier was also run with real Qwen models. The frontend dispatched a task, Connect was approved through HostApprovalController, and one model-driven Scroll returned. A later model request failed with TLS `ECONNRESET`; task phase remained `waiting`, with `model_failed` and `task_check_unavailable`. A minimal fetch and curl through the existing system proxy independently reproduced TLS failure. Thus **full real-model task completion is not accepted**. Earlier frontend runs either only replied with a plan or reported a provider failure; those are not completion evidence. Temporary records: `/tmp/nova-focus-production-qwen.json` and `.log`; the final retry `/tmp/nova-focus-production-preload.json` and `.log` dispatched a real task and executed two approved Scroll actions, then again failed with `ECONNRESET`, `model_failed` and `task_check_unavailable`. A temporary X25519/P-256 TLS compatibility setting produced one successful minimal model response (HTTP 200) but did not fix the whole chain, including when preloaded before SDK imports. No certificate validation was disabled, and no global network or production TLS configuration was changed.

The one-time fixture harness auto-accepted only the explicitly authorized local target, bounded page coordinates, the fixed test text, scrolls and supported shortcuts. It did not remove product approval guards. Credentials remained in private temporary files and were not sent to Claude or committed.

## Verification

- Latest runtime/desktop build and runtime lint passed.
- Scoped computer backend/device/guard/lifecycle tests: 28 passed, including changed binding rejection and host restoration after a killed worker.
- Native malformed-request test passed: invalid JSON, PID/window numeric bounds and oversized payload, with no application input.
- Latest full runtime run (four-way concurrency): **3,611 passed, 0 failed, 9 skipped** (3,620 total).
- Latest full desktop test run: **1,235 passed, 0 failed, 3 skipped** (1,238 total). These tests ran against the final build. Source startup smoke was skipped on macOS by its Windows-only platform guard. Typecheck and environment contract also passed.
- Real native cancellation: a production Tap with a 1,000 ms hold was interrupted after 300 ms by closing its owned backend. It returned `cleanup_unknown`; host cleanup returned `treeGone=true`, and the before/after foreground focus metadata matched Codex PID, launch time and window 119. This accepts the exercised interruption point, not every possible termination phase.
- Logs: `/tmp/nova-focus-runtime-full.log`, `/tmp/nova-focus-desktop-full.log`, `/tmp/nova-focus-scoped-final.log`, `/tmp/nova-focus-native-recheck.log`, `/tmp/nova-focus-lint-recheck.log`, `/tmp/nova-focus-live-front-build.log`, `/tmp/nova-focus-cancel-live.log`.
- Earlier full desktop run: 1,238 passed, 0 failed, 3 skipped. Earlier full runtime run: 3,608 passed, 1 failed, 9 skipped; sole Qwen composition startup timeout passed in isolation. These earlier runs predate the focus changes and are not final regression evidence.

Local Claude CLI reviews used the authorized `claude-sonnet-5-5`, with tools/MCP disabled. Concrete binding, defocus-window identity, negative-screen primer, cached foreground lookup and compensating mouse-up findings were addressed. The temporary Cua SDK process was identified and stopped; no SDK dependency was added. Both disposable loopback fixture servers were identified by command and listening port, stopped with SIGTERM, and their ports no longer had listeners. Evidence files remain in private temporary storage.

Next gate: restore model endpoint connectivity, rerun the complete real-model task to verified completion, and accept the signed packaged application separately. Do not replace these gates with model-finished or transport receipts.
