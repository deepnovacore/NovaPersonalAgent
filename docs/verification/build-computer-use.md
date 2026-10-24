# Unified Computer Use acceptance checklist

This is a checklist, not a claim of device acceptance. Record each case as **PASS**, **FAIL**, **NOT RUN**, or **BLOCKED_HUMAN** with the exact missing permission/unlock/approval step. Keep confidential screenshots, application contents and credentials out of the repository.

## Record provenance

- Commit and dirty-tree status; runtime/native build hashes; packaged app version if applicable.
- OS and architecture, display, target application/PID/window, foreground identity before/after.
- Build model and voice planner: distinguish a real model from a local deterministic fixture. Record model requests/cost limits before any paid calls.
- Canonical external output/evidence directory, timestamps, commands, exits and screenshot/AX evidence references.
- Distinguish direct shared-session acceptance, Build runtime/tool integration, packaged UI, voice executor plumbing and actual microphone/model conversation. Never substitute one for another.

## Automated regression gates

- [ ] Full runtime typecheck and focused session/device/backend/workbench/executor/GUI-runner tests.
- [ ] Desktop UI contract and native malformed-target/compile tests.
- [ ] Old observation ID rejected after target change or replacement observation; no write occurs.
- [ ] Identity and geometry rechecked after approval; no environment target leaks into an unbound Build session.
- [ ] Cancellation during a sent action waits for its receipt; ambiguous receipt overrides cancellation and retains quarantine.
- [ ] Voice lifecycle plus shared session retains device/resource quarantine on uncertain writes or cleanup.
- [ ] Non-darwin observation has AX unavailable without invoking a native AX reader; Windows device testing remains separate.
- [ ] Source tools/prompts and docs contain no nested desktop-delegation tool; only the historical design note is excluded.

## Real macOS: harmless background window

Use a dedicated local fixture containing no real accounts, credentials, messages or personal documents. Do not publish, send messages or operate real accounts.

- [ ] Check screen is unlocked and Screen Recording / Accessibility are granted to the actual executable path. Otherwise record **BLOCKED_HUMAN** and the exact settings/unlock action needed.
- [ ] Keep a separate foreground application; record its identity. Bind via `computer_screenshot({application: exactNameOrBundleId})`, not an invented PID.
- [ ] Capture screenshot and AX with target, focus, foreground, space, ID and status. Confirm fixture content is visible and AX is `ok` (or honestly record timeout/truncation/unavailability).
- [ ] Click a known field, reobserve, type with `replace`, reobserve, then `append`; verify final text from the actual application. Readback must not depend only on a successful action receipt.
- [ ] Record `executionMode: background` and unchanged foreground identity after each operation. Unsupported background actions must refuse, never silently activate the app.
- [ ] Reuse an old observation ID and confirm rejection plus unchanged fixture state.
- [ ] Move/resize or change the target and confirm rejection of the old observation; obtain a new session/observation before continuing.
- [ ] Refuse Connect and an input; neither refusal sends an input. Verify remembered application consent stays application-scoped.
- [ ] Stop/Resume and input ambiguity retain ownership through cleanup; do not delete quarantine locks to force acceptance.

## Build integration and voice executor

- [ ] Enable only from the selected local Build conversation; Plan/remote clients cannot enable.
- [ ] Nonvision Build model gets no desktop tools and explicit `vision_model_required`; changing models after enabling remains fail-closed.
- [ ] Every input cites the newest observationId. `finish_build` refuses after input until a fresh screenshot exists; a successful receipt alone never establishes completion.
- [ ] Exercise the packaged UI separately: approvals, call journal, screenshot references, Stop, overlay visible to the user but absent from model screenshots.
- [ ] Run `ComputerExecutor` on the exact bound fixture window. Record the initial observation ID and prove bounded AX summary reaches the actual `aiAct` startup context with untrusted / may-be-stale labels.
- [ ] Verify voice adapter coordinate mapping, input and final actual fixture state. If using a deterministic local planner, label this **native executor plumbing**, not real-model or microphone acceptance.
- [ ] Separately, when authorized, complete real microphone/voice and real-model interaction; record model, bounded calls and costs. Static startup AX must not be described as per-step planner updates.
- [ ] Verify Build and voice cannot simultaneously own local input, and uncertain voice cleanup prevents another executor from taking the device.

## Windows and release boundary

- [ ] On real Windows, verify process guardian, coordinate mapping, approvals and Stop/Resume.
- [ ] Observe explicit AX unavailable; do not claim UIA support.
- [ ] Record platform cases not available as NOT RUN, not PASS.
- [ ] Report source/tests, native-session evidence, packaged UI, real voice/model and release status separately. No push or release is implied by this checklist.
