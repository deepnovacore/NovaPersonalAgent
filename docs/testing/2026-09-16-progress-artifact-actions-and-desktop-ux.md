# Progress, artifact actions and desktop UX — 2026-09-16

## Findings

The inspected desktop run used the eager proactivity preset. Codex emitted three working updates, but the surrogate classified each as routine_delta and stayed silent. The policy prohibited all routine updates even in eager mode; the runtime separately rejected a model decision to speak about routine progress. Terminal delivery used a different path and therefore still worked.

Two subsequent requests to run/open the completed game produced no dispatch or executor approval request. The frontend invented a general inability to operate the computer and offered HTML/manual instructions. These refusals happened before Codex or the command approval bridge was involved. Existing sandbox restrictions are real, but they were not evidence for these two responses.

The frontend also produced Markdown and escaped newlines for a voice channel. Host-fact guidance covered some summaries, but ordinary conversation did not consistently declare the direct-to-speech output contract.

## Changes

- Eager permits concrete new work direction, implementation decisions and findings. Counter-only changes and repeated plans remain silent by model policy. The runtime validates structured output and correlation rather than imposing a second semantic veto on routine_delta. Existing cooldown, deduplication, interruption and terminal delivery remain in place.
- Include the actual trigger kind in surrogate input while preserving the full original context. Do not reuse the speech projection flag: it also removes executor fields. Remove the inherited policy sentence that conflicted with eager progress feedback.
- Describe artifact execution/opening as delegated work, and require actual failure facts before asserting lack of permission. Permissions still go through the existing structured approval protocol.
- Apply a plain spoken-language contract to both user responses and host facts; no new keyword classifier or Markdown stripping engine.
- Add CSS shimmer to the session banner, disabled for reduced motion. Replace open/stop text with SVG buttons retaining accessible names and existing actions.
- Give assistant conversation messages a distinct card and Nova label. JSON details open on right-click or Shift+F10 and close with Escape; hovering or focusing no longer exposes them.

## Verification and limits

The real Qwen Plus frontend replay dispatched an artifact-opening request without ordinary refusal text. Its natural-language outputs were plain speech. This probe uses synthetic TTS and does not prove speaker playback or that a real browser launch has completed.

Surrogate live probes include an initial work plan, a counter-only change and a verified milestone. Earlier attempts failed and were retained. Default Flash remains inconsistent across identical final-input replays; one successful replay is not evidence that this is resolved. Plus passed three consecutive complete comparisons, including a run using the new default without an environment override. The user selected reliability over latency/cost, so the shared surrogate/coordinator default is now Qwen Plus. Explicit model overrides remain respected; the running client has not been restarted.

The isolated renderer smoke passed message styling, no details on hover, right-click details, Escape close, icon open/cancel actions, and shimmer/reduced-motion checks. Screenshots are local build artifacts. No running desktop process was restarted.

Claude Fable reviewed the policy, capability boundary and context projection. Its projection concern was addressed by preserving raw context and adding only the trigger line. No periodic narration timer or additional classification field was introduced.

Private probe logs, including failed attempts, are retained in `.data/diagnostics/2026-09-16-progress-ux/`. Frontend replay passed twice after the instruction change; the first attempt failed clarification dispatch and is retained. Renderer smoke passed with zero page errors. Desktop build and 35 focused desktop tests passed.

Final validation: desktop build and runtime lint passed; full runtime regression passed (2,374 passed, 8 skipped, 0 failures; 2,382 total). Live-runner contracts passed 11 tests. Existing fake app-server integration exercised correlated command/file approval forwarding; real browser launch remains unverified.
