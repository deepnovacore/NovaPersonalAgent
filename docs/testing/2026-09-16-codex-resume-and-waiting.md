# Codex resume failure and preparation feedback — 2026-09-16

## Observed failure

The desktop selected the active project and its latest session for an independent game request. This followed an overly broad coordinator instruction: use the active project unless named otherwise, and use `latest` unless a new session was explicitly requested.

A read-only reproduction against the actual Codex app-server returned JSON-RPC `-32600` from `thread/resume`: `no rollout found for thread id …`. The Codex database still had that thread's index, but its referenced rollout file was absent. The file was also not found in the inspected active/archived session directories. This establishes that the indexed session was not resumable; it does not establish who removed the file.

The original pipeline discarded the RPC message, converted the specific transport code into `worker_refused`, and displayed generic execution failure. No coding turn had started, so there was no game execution log to retrieve. The discarded resume error was the useful evidence.

The original timing was about 23 seconds between the user's clarification and executor admission, followed by about 1.8 seconds to failure. A later real replay measured roughly 3 seconds of intake assessment and 13 seconds of plan compilation. These model calls remain asynchronous; the change provides truthful waiting feedback rather than claiming they became instantaneous.

## Changes

- Keep bounded, redacted RPC method, numeric code and error text through transport, handoff and the existing desktop task-details dialog. Preserve specific failure codes. Server prose is untrusted evidence; spoken failure wording does not follow instructions in that prose.
- Exclude known missing rollout files from the local session catalog, and verify a selected session's indexed rollout before resuming. Mark a known missing session unavailable. Catalog I/O uncertainty is not treated as proof of loss; the app-server remains authoritative. Do not reconstruct history, search alternate identities, or automatically retry a failed execution.
- Let the coordinator choose `new` for an independent objective and `latest` for actual continuation, using structured output and context rather than keywords. Explicitly requested unavailable sessions are refused rather than silently substituted.
- Publish one preparation fact after six seconds of continued preparation. Suppress it when the matching intake/revision is no longer preparing or user input is pending. Internal acceptance receipts remain silent.
- Replace the frontend's overbroad “any choice that changes the result requires clarification” criterion with “missing information prevents determining the requested artifact or required boundaries.” Legitimate implementation choices remain executor-owned; no mandatory four-slot questionnaire or per-feature exceptions were added.

## Acceptance evidence

The first real run completed workspace creation, same-session continuation and explicit new-session work, with exact file readback and thread identity checks. It also produced one preparation utterance per delayed request. The independent game request then failed acceptance because the frontend unnecessarily asked about starting behavior. That failed report is retained.

After the clarification instruction change, the same complete game request directly dispatched. The coordinator selected a different Codex thread, which created and read back a 4,459-character `snake.html` in the isolated test workspace. The run completed successfully. No user project files were modified by these probes.

The real missing thread was separately verified as unavailable and absent from the corrected local catalog. Regression tests exercise a stale index and verify it is not selected for automatic resume, plus the actual transport's `thread/resume` rejection path, diagnostic propagation, and cancellation of delayed feedback. Local Claude CLI `claude-fable-5-1` reviewed the error chain and lifecycle twice and discussed the clarification failure separately; its concrete findings were addressed.

The opt-in production runner supports `NOVA_LIVE_PROJECT_SNAKE=1` for the independent game scenario. The clarification live runner now covers delayed feedback, superseded requests and resume failures. Its final Qwen Plus run passed: waiting feedback was “好的，任务已收到，正在准备中，还没开始执行。”; resume failure correctly said the task had not started and pointed to details without asking for reconfirmation or requirement changes. This runner uses synthetic TTS and host facts; it does not prove physical audio playback.

Browser gameplay is **not accepted**: the browser tool refused the local `file://` URL under its security policy and prohibited alternate-entry workarounds. The earlier Playwright CLI attempt separately failed to download because its configured registry DNS was unavailable. No browser-policy bypass was attempted. Physical microphone/speaker acceptance and the separately reported speech segmentation defect are also outside this result.

Raw reproduction, failed and successful live reports, model reviews, and test logs remain private under ignored `.data/diagnostics/2026-09-16-codex-failure/`.

## Final verification

- Runtime regression: 2,372 passed, 8 skipped, 0 failed (2,380 total).
- Desktop result tests: 8 passed; live-runner contract tests: 9 passed.
- Runtime lint, runtime build, desktop build and diff whitespace checks passed.
- Final Claude Fable review found no blocker or keyword-based semantic fallback. Its remaining catalog exception question was checked: the sole caller already catches catalog failures and marks the catalog unhealthy, preserving the existing execution boundary. No additional fallback was added.
- The running desktop client was not restarted; the new build must be loaded before testing these changes in that process.
