# Nova speech, long tasks, and conversation history

## Scope

This change shares Nova's first-person voice identity between conversation and fact-only narration. Narration still has no user-action tools or historical authorization. User-facing state projection excludes raw error codes; diagnostics retain protocol details. No intent keyword rules or text replacement fallback was added. The selected frontend model and its thinking configuration were not changed.

Codex `run` explicitly uses a nullable total deadline. The scheduler does not post a deadline event for this operation, and the adapter forwards an unbounded completion wait through both transport wrappers. Startup, individual control requests, cancellation cleanup, and each approval's 60-second window remain bounded. Other executors retain their existing deadlines. An established turn's connection failure is identified as execution-stage uncertainty, not startup failure.

The memory board initially requests 12 records and pages backward with `channel` and `before_seq`, at most 50 records per page and within the existing byte budget. It merges by sequence, preserves longer retained content and the visible scroll anchor, and rejects stale pages across backend generation, conversation epoch, or retention changes. Previously restored records remain a separate group. Legacy compact/full requests still work.

## Automated evidence

- Full runtime suite: 2,393 passed, 8 skipped, 0 failed (2,401 total).
- Final execution-stage refinement: 79 targeted tests passed, including project transport forwarding and the WebSocket approval chain.
- Desktop memory-board, scroll-state and request-client tests: 26 passed.
- Chrome smoke: 237 synthetic records loaded without duplicates or omissions; refresh preserved loaded history and the visible anchor; clear epoch discarded prior records.
- Additional contract checks: 51 passed. They cover a new approval at virtual second 599 remaining valid at second 620, explicit revocation diagnostics, and post-start connection loss.

Useful repeatable browser check (use an installed Playwright module):

```sh
NOVA_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
NOVA_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node clients/desktop/scripts/memory-board-smoke.mjs
```

## Live evidence

The first actual Codex test still timed out at 540 seconds. Claude Fable review identified two transport wrappers that dropped the explicit unbounded completion parameter. Both were fixed; a project-adapter fixture now checks forwarding at the inner transport.

The repeated real Codex task ran a foreground 610-second Python sleep, then requested native permission for one curl request to `https://example.com`. The production approval controller sent the request over the desktop WebSocket. The production renderer decision controller waited 20.002 seconds before accepting this explicitly authorized synthetic request. The task then completed and read back the 559-byte file containing `Example Domain`.

- Total duration: 679.391 seconds.
- Approval appeared at 644.342 seconds, with its full 60-second window.
- Final outcome: `ok`; artifact verified.
- This test exercised production transport, approval routing and decision code. It did not submit a new user goal through the microphone or render that long task's approval in the user's orb window.

Current Qwen 3.8 Max fact-only narration: 6 cases × 3 repetitions, manually reviewed 18/18. Cases include accepted, confirmation, started, progress, timeout uncertainty and connection loss. Earlier trial failures that introduced “system prompts” or collapsed started into arranging were retained in local diagnostics, then corrected in the narration instructions.

DeepSeek Flash V6 regression: 52/54. Two failures remain the previously known ambiguous-game premature dispatch case; clarification, confirmation, cancellation and other dispatch cases passed. This is not a claim that the existing ambiguous-game issue has been solved.

Four representative utterances were generated through the production TTS factory and played with the macOS audio output; all playback processes succeeded. The user confirmed physical audibility and accepted the confirmation, progress and connection-loss samples. They requested changing the accepted-task phrase to “马上安排”; the source fact was updated accordingly. The selected frontend model repeated “马上安排。” in all three follow-up probes; 41 intake tests passed.

## Client state and limits

The new desktop client was started with existing settings. Its real memory board loaded from 12 recent records to 71 retained records and showed the independent pre-restart history group. The final backend restart was confirmed in the settings UI. No old failed task was rerun, no generated user files were deleted, and no model settings were changed.

Raw local probe output, model responses and timing reports are under `.data/diagnostics/2026-09-17-interaction-fixes/`; they are local diagnostic artifacts, not public release assets. No commit or push was performed for this mixed working tree. The initial Claude Fable review found the missing wrapper forwarding and scroll issues; the follow-up review did not return after ten minutes and was stopped, so it is not counted as a passed review.
