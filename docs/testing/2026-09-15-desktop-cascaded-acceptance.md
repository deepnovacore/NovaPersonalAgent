# Desktop cascaded acceptance — 2026-09-15

Status: implementation, regression checks and the final production three-task live suite pass. Physical desktop audio acceptance remains separate.

## Root fixes

- Intake completion no longer revokes an admitted delegate. Frontend structured dispatch/confirm/cancel remains the action authority; transcripts alone do not amend or cancel work.
- Pending cancellation follows the same work identity through admission and launch.
- A valid provider text-plus-tool response delivers the structured call without speaking its preamble. With tools enabled, text-only speech waits for the response kind; this increases first-audio latency by the remaining LLM generation time.
- Host narration reads the current fact and its matching tool receipt, not old conversational questions. Full history remains available to subsequent user turns.
- Assessment chooses latest/new/named session variants; latest/new cannot contain a title.
- Same-instance project transactions serialize before acquiring the cross-process lock. No task retry was added.
- The next response waits for the prior terminal response to release ownership.
- Structured Codex usageLimitExceeded becomes a safe quota message; raw provider errors are not exposed.

## Evidence

- Runtime: 2362 passed, 8 skipped, 0 failed before the final quota-only change.
- Desktop: 882 passed, 3 skipped, 0 failed.
- Quota/transport/projection/evidence regression after the final change: 128 passed.
- Desktop build, runtime lint, environment/capability contracts and 11 live-runner contract checks passed.
- Real Qwen cascaded clarification/dispatch/receipt/question/failure narration passed. Failure narration did not request confirmation or invent a reason. This used synthetic TTS, not physical audio devices.
- One earlier three-task live run passed artifact checks and exact Codex thread identity checks; later fixes still required a fresh full run.
- Latest session-contract live: create workspace and first file passed; continuing reused the same thread and wrote/read the second file. Explicit new-session selected a different thread, then Codex returned usage_limit_exceeded before creating its file. This run failed acceptance.
- After the user restored quota, the first Codex task succeeded, but DashScope ECONNRESET and a TTS receive failure interrupted the next turn. Subsequent attempts also hit DashScope ECONNRESET. These are failed runs, not passing acceptance.
- Claude CLI with claude-fable-5-1 reviewed the root fixes and proposed the structural session contract and narration context boundary. Its final focused review found no explicit blocker; actual tests were run separately.

## Final rerun

After network recovery, the unchanged final build passed the entire production cascaded suite: workspace creation and natural confirmation, continuing in the existing session, and explicitly creating a new session. All three outcomes were `ok`; direct disk readback matched `NOVA_E2E_OK`, `CONTINUE_OK`, and `NEW_SESSION_OK` exactly. Continuation retained the original Codex thread; new-session execution created a different thread. No provider error was recorded in this run.

Frontend clarification and failure narration were separately validated with real Qwen and synthetic TTS. The physical desktop/microphone/speaker acceptance remains separate. Changes are committed locally to `v0.2.0dev`; no remote push is part of this acceptance.

Raw local reports contain shared session context and remain outside the repository.
