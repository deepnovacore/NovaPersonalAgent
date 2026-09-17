# Workspace routing and connection prewarm acceptance

The project executor now uses `CODEX_PREWARM` to retain one initialized app-server connection for the first eligible task. Prewarming does not create or resume a thread. The confirmed workspace, session identity and work-scoped approval port are bound later, with target-directory preflight and effective configuration validation before thread creation/resumption. A different executor home uses a separate transport.

This is a single startup connection, not a process pool. Existing task cleanup remains authoritative. Mandatory preflight failures still fail startup; optional connection warming failures close that transport and leave subsequent tasks on the existing cold path. Dead warmed processes are discarded before opening the approved thread.

Progress extraction and narration policy were not changed. Both the early `e883b08b` implementation and the original `57c2ffcc` implementation consumed completed items, not text deltas.

## Reproduce the live test

From the repository root, after building `runtime`:

```sh
NOVA_LIVE_PROJECT_EXECUTE=1 \
NOVA_LIVE_PROJECT_SCENARIO=workspaces \
NOVA_AUDIO_AGENT_CODEX_PREWARM=true \
NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL=qwen-plus \
NOVA_AUDIO_AGENT_SURROGATE_MODEL=qwen-plus \
node runtime/scripts/live-smoke.mjs --target=project --env-file=.env \
  --output=.data/diagnostics/workspace-prewarm/report.json
```

`runtime/scripts/live/workspace-scenarios.mjs` seeds synthetic Snake and Notes workspaces. It submits real frontend turns and confirmation turns; it does not inject dispatch decisions or fake executor outcomes. Login/provider configuration is temporarily copied into an isolated Codex home, without copying the user's session catalog, and removed during cleanup. Reports contain only the test's synthetic conversation and must remain private.

| Scenario | Required evidence |
| --- | --- |
| Switch to Notes without executing | Confirmed active workspace change; zero sessions |
| Execute in current Notes workspace | Real Codex success; independently read `note.txt`; no copies in other workspaces |
| Independent Pomodoro topic | New-workspace proposal and matching accepted confirmation; `timer.txt` in the new directory |
| Switch back and continue Notes | Matching confirmation, same Codex thread as the Notes task, independently read `followup.txt` |

The first complete live run passed all four cases and emitted `project_prewarm_reused`. Private evidence: `.data/diagnostics/2026-09-16-workspaces/warm-complete.json.project-1.json`. A later repeat (`final.json.project-1.json`) exposed an invalid idle-workspace steer decision; the final available-action revision passed all four cases in `available-actions.json.project-1.json`, again with `project_prewarm_reused`.

Initial failures remain in the private reports. Pure switching originally produced a verbal promise without a function call. Clarifying the tool's workspace-management capability plus the frontend's operation contract fixed the observed case; changing the tool description alone did not. No keyword routing or forced tool selection was added. A subsequent test timeout was a harness bug: the 128-entry diagnostic ring had stopped growing. The test now uses event sequence numbers and retains its complete sanitized diagnostic stream.

The repeat also exposed an assessor selecting `steer` when the host running list was empty. The assessor schema now advertises only available actions in that state, and the host independently rejects a steer without a running task in the chosen project. It does not reinterpret the request or substitute another operation.

Local checks cover connection-only warming, exact late thread binding, reuse without another spawn, rejection without a binding, dead-child replacement, optional warming failure cleanup, the existing approval protocol, and frontend/session routing contracts. Live text/real-model/real-executor acceptance does not establish microphone, speaker or desktop GUI acceptance, nor a measured latency improvement.

Final targeted checks: 4 prewarm lifecycle/approval tests passed; 61 intake/factory/approval tests passed with 1 platform skip. The complete transport suite passed 101 tests before the additional work-scoped approval test, which also passed. Frontend/session routing regressions passed (83 + 158 tests); build, lint and diff checks passed. The running desktop client was not restarted.
## Clarification follow-up and model selection

The later desktop failure was reproduced through the production cascaded assembly with Qwen Plus: after “我要记录我们公司所有人的周报。” and “网页版就行。”, it emitted a creation promise without any dispatch. The four workspace cases above do not cover this path. `NOVA_LIVE_PROJECT_SCENARIO=clarification` now covers it; the text-tools fixture is `weekly-report-after-clarification`.

Consolidating the frontend prompt did not reliably resolve the failure (one of three replays still omitted dispatch). That experimental production prompt change was reverted. The model-only harness now includes the production coding approval instructions and orders response guidance like the actual adapter. The new fixture checks dispatch and source refs, not the model-supplied origin ref: the production host binds origin from the actual user response, independently of that argument.

Under the retained production instructions, Qwen3.8 Max passed three clarification replays, unresolved clarification, discussion-only, and confirmation-question cases; three further confirmation-question repeats also passed. Qwen3.8 Flash passed the three clarification replays and the first two negative cases, but called confirm in the first confirmation-question case; three repeats of that case subsequently passed. These are bounded observations, not a reliability guarantee. Private evidence is under `.data/diagnostics/2026-09-16-clarification/` (original raw reports plus `original-rescored.json`).

The desktop model picker now exposes exact Qwen3.8 Max/Flash and legacy Plus/Flash IDs, with custom IDs retained per provider. Settings/backend unit checks passed 186 tests; browser smoke covers all four choices, custom ID persistence across provider switches, and saved model values. No running desktop model configuration was changed as part of these UI checks.

The unconstrained Qwen3.8 Max production replay created a new workspace and `index.html`, but the runner timed out before collecting a successful terminal; it is not accepted. The bounded follow-up adds an explicit one-file scope to the platform answer. It passed the production chain: initial clarification without dispatch, subsequent dispatch, a new workspace proposal, natural confirmation, real Codex execution, terminal `ok`, and independent readback of `acceptance.html` as `<h1>WEEKLY_OK</h1>`. Evidence: `production-max-bounded.json` and its project report. Temporary credential copies were removed and checked absent. This does not establish completion of an unrestricted weekly-report application or physical microphone/speaker acceptance.

The user selected Qwen3.8 Max for the current frontend after the comparison. Only the persisted Qwen frontend model was changed; other settings, encrypted credentials, and downstream coordinator model configuration were preserved. The renderer smoke passed with zero page errors; the desktop build passed. Experimental prompt rewrites were not retained.
