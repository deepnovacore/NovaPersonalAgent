# Desktop task feedback and approval follow-up — 2026-09-16

## Changes

- Intake owns one immediate acknowledgement: “正在安排任务。” Coding startup still updates state, but no longer produces another generic spoken acknowledgement.
- Cascaded host-fact narration uses a dedicated short system instruction, without task-dispatch instructions or unrelated dialogue history. It distinguishes executor facts from a new user request and must not invent the meaning of internal error codes.
- Smart progress evaluation receives the originating work order and evaluates new information relative to the known objective as well as the previous summary. This uses the existing model, not keyword routing or text-similarity thresholds.
- Coordinator assessment no longer defaults every unnamed project request to the active workspace. Independent products may propose a new workspace; explicit current-workspace requests remain there. Existing host confirmation and evidence validation remain in force.
- Session shimmer requires working state for the displayed workspace. Expanded speech bubbles size to content, retain a bounded scroll area, and remain attached to the orb.
- Approval expiry and observer failures now emit distinct diagnostic codes. The desktop bridge records acceptance of an approval view, connection status and executor availability, without logging command details.

## Evidence

| Check | Result |
| --- | --- |
| Runtime full suite before final diagnostic additions | 2,378 passed, 8 skipped |
| Desktop full suite | 884 passed, 3 skipped |
| Final approval/controller/factory/desktop/Qwen regression subset | 96 passed |
| TypeScript build, runtime lint, whitespace check | Passed |
| Actual renderer: working task plus approval, three zoom factors, real button click serialization | Passed |
| Expanded bubble content height and attachment to orb | Passed, screenshot inspected |
| Actual Qwen Plus progress classification | Repeated known requirements silent; implementation direction and verified milestone spoken |
| Actual Qwen Plus coordinator | Independent timer selects create; explicit current-workspace calculator selects work |
| Production composition + real Codex + actual renderer + WebSocket approval: network | Passed; clicked allow, curl completed, independent file read verified 559-byte Example Domain page |
| Same production approval chain: browser preview | Passed through command completion; clicked allow, exact public test URL opened with exit code 0 |

The production renderer acceptance uses an isolated Chrome profile with the repository renderer and a test preload implementing native layout reservations. It connects to the real production desktop WebSocket; approval is sent by an actual button click, not by a replacement decision controller. The command approval is bound to a work ID, project and title. Microphone/speaker and native Electron window interaction are separate acceptance levels.

## Historical failure and remaining boundary

The reported Pomodoro trace contains a Codex `open` request at 04:26:59 UTC, followed by Nova approval context readiness and host-fact injection. Codex later received a rejection. That historical trace has no renderer receipt or expiry diagnostic, so it does not establish whether the user saw the approval or whether rejection was caused by expiry. Do not describe it as an explicit user rejection, nor claim its precise cause has been proven by a successful later replay.

New production network and browser command replays succeeded without weakening authorization or automatically retrying a declined operation. The default-browser page visibility check could not run because macOS was locked; exit code 0 is command success, not evidence that the page loaded. No user client restart was performed.

Local, ignored evidence is under `.data/diagnostics/2026-09-16-task-feedback/` and the earlier `.data/diagnostics/2026-09-16-live-repair/`. Synthetic test transcripts, screenshot artifacts and local paths are deliberately not published with this report.

Fable's completed read-only review identified independent response owners, over-broad narration instructions and active-project bias. The follow-up approval-specific CLI review had not returned a result when these checks completed.
