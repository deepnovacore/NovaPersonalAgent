# Presence, proactive delivery and session ownership implementation plan

**Goal:** Deliver background/workbench/orb modes, proactive speech, convenient independent Nova/coding session selection, and background approvals without human-wait expiry.
**Architecture:** Reuse the personal host, approval broker, project adapter and existing playback. Desktop owns window appearance; host owns presentation policy, task routing and approval authority. UI selection never retargets running work.
**Tech Stack:** TypeScript Node runtime, Electron, vanilla JavaScript, existing node:test.
**Spec:** This document records the design approved in the conversation and the Claude review at /tmp/nova-mode-review/review-conclusions.md.

## Constraints
No new dependencies. Keep public code generic. Preserve all inherited WIP. No publish or release. No keyword-based semantic routing. Modified files stay below 4000 lines. Build runtime serially. Defaults preserve non-desktop clients.

## Contract
Background: menu-bar unread only; no speech or microphone, tasks continue; approvals/project proposals do not expire because of human absence. Workbench: full UI and silent proactive delivery. Orb: proactive speech, microphone independently controlled. Returning to foreground does not erase drafts or change voice/session owner. Closed native executor requests cannot be resurrected; cancellation and stale authority remain fail-closed.
Nova conversations own optional explicit coding target; tasks capture workspace/session at dispatch. Existing project execution exclusion stays intact. Session selection must use host-validated IDs. Notification speech must not impersonate a user turn or steal selected conversation.

## Review focus
Background timeout through parent text-turn cleanup; competing approval pause owners; queued head promotion; mode transition during speech and reconnect; selected conversation differing from voice and task owner.

## Tasks
- [x] 1 Approval lifecycle: add behavior checks to host-approval and project-confirmation; extend hold by reason, keep existing defaults, handle background proposals and queued promotions. Ensure text turn timeout cannot decline a still-live background approval. Verify existing expiry/cancel/single-use tests.
- [x] 2 Host presence: validated background/workbench/orb command and snapshot; observe presence in each runtime for approval/project holds and playback policy; reconnect defaults conservative, do not persist executable grants.
- [x] 3 Desktop modes: main/preload/renderer/tray controls with host acknowledgement, background hide without clearing conversations, preserve bounds/drafts. Test controller plus IPC authorization.
- [x] 4 Proactive speech: reuse existing suggestion delivery, route irrespective of proactive inbox selection in orb, suppress in background/workbench, preserve expiry/dedup and actual spoken acknowledgements; no competing playback runtime.
- [x] 5 Session selection: expose host-validated coding targets; persist per-Nova default target and project/session UI; fix dispatch to use explicit context and keep each work owner immutable. Add two-conversation routing checks.
- [x] 6 Verify: targeted then full runtime/desktop checks, external Claude code review, fix findings, native smoke with isolated data when available. Record real-device gates honestly; integrate only task changes without overwriting newer WIP.

## Execution ledger
Ruling: User explicitly authorized all implementation; proceed without another approval loop. Work in isolated snapshot of current WIP, no commits containing unrelated inherited changes. Native execution with independent final review. Spec/plan are concise because actual code contracts will be read before each step.


## Implementation outcome (2026-09-22)
Implemented and integrated into the original v0.3.0dev working directory without committing or publishing. Hash preconditions and three-way merges preserved concurrent workbench styling, memory-panel, native-language news and sampling changes.

- Background hides immediately, including while offline, stops microphone/wake capture and mutes native playback. Runtime disconnection also parks pending decisions after presentation policy has been enabled.
- Workbench and orb preserve conversation ownership and window bounds. Reconnect replay does not focus the window. Orb announcements use the existing voice pipeline without claiming microphone ownership; explicit voice and inbox text can take over safely.
- Live background approvals/project proposals wait without a human-wait deadline. Returning to foreground releases the global hold, while each previously hidden request waits for its own exact visible-card acknowledgement. Cancellation, native process loss, stale speech and spent grants remain fail-closed.
- Each Nova conversation retains its own coding target. Tasks retain immutable workspace/session binding; actual newly created sessions update only the still-current target. Exact validation does not depend on picker pagination. A missing target clears with a visible notice while ordinary chat remains available.
- Human decision waiting pauses the text-turn watchdog. A genuine timeout still fences the old provider epoch, so a late response cannot appear as successful output.

### External review
A local Claude CLI review used the explicitly requested `claude-fable-5-1` model, verified in model usage. Review findings were individually checked and addressed: native unmute ordering; offline hide; capture shutdown; reconnect focus and recovery; background pause leakage into new foreground decisions; parked announcement runtimes; stale/paginated coding targets; listener failure isolation; and late timeout responses. A follow-up independent source review also caught and fixed failed-mode retry backlog admission.

### Verification evidence
- Final merged runtime TypeScript build passed. The affected runtime/integration set passed **216/216**, including the two readiness/network cases that hit short deadlines during the heavily concurrent full scan.
- Desktop build and full suite passed **997/1000**, with **3 existing skips** and zero failures. Source-startup smoke is opt-in and reported skipped.
- Real source Electron with isolated userData passed **7 offline native checks**: initial workbench/tray, hide, workbench restore/bounds, compact orb, close without destruction, tray restore after close, and actual preload IPC replay without focus.
- Runtime full scans were performed. The pinned Qwen outbound-payload fixture failure also reproduces on the pre-change baseline. One full scan additionally hit a hanging Codex transport test and short-deadline readiness/network failures under load; those were isolated for bounded reruns rather than counted as passing. The complete Codex transport suite subsequently passed. That retry reported 115 passes and one 30-second cancellation in the unrelated 200-object connector test; this slow test had already passed in the full scan in 89.9 seconds (and the earlier full scan in 48.3 seconds), so the artificial 30-second cap is not treated as a product failure.
- Whole-runtime lint retains **6 inherited errors** in `feishu-connector.test.ts` and `memory-consolidation.test.ts`; none remain in this task's modified files.
- Real voice/model playback, actual WebSocket loss/reconnect with an active voice turn, and installed packaged-app acceptance were not performed. Offline native IPC replay is not claimed as real WebSocket reconnect acceptance. The final small orb-button CSS correction was not re-screenshotted.

Logs: `/tmp/nova-mode-review/merged-tests.log`, `final-desktop.log`, `final-runtime.log`, `final-runtime-hang-retry.log`, `final-lint.log`, `final-review.json`. Native report: `/var/folders/cv/hy5wszq951bfwkgt9t9v2zhm0000gn/T/nova-desktop-offline-yvosng2y/report.json`.
