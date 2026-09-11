# 9. Roadmap

Updated 2026-09-10. The version scope below follows the product roadmap; implementation,
automated checks, live acceptance and release are separate states. A roadmap item is not a
claim that the feature has shipped. Package versions change only in an explicit release chore.

## v0.2.0 — a reliable, modular, cross-device agent foundation

| Workstream | Planned outcome | Acceptance boundary / specification |
|---|---|---|
| Cross-platform approvals | Forward sandbox-blocked network requests, command execution and permission upgrades to the active frontend through the host approval broker. Show the operation, workspace and requested scope; return approval or denial to the originating executor. | macOS and Windows host behavior; Desktop, WebUI and iOS approval presentation. Reject stale, expired and duplicate answers; never widen permission on disconnect. Ordinary operations already permitted by the sandbox remain unprompted. [01](../specs/v0.2.0/01-codex-approvals.md), [09](../specs/v0.2.0/09-ios-remote-client.md) |
| Thin FrontBrain | Reduce native tools; move workspace/session selection, routing and scheduling into the coding executor. The frontend expresses intent and consumes facts; the host owns authorization and work identity. | The existing six-tool baseline and `dispatch / cancel / confirm`; no model-visible workspace/session state machine. [07](../specs/v0.2.0/07-executor-boundary.md), [08](../specs/v0.2.0/08-project-and-work.md) |
| Replaceable voice pipeline | Support configurable ASR / LLM / TTS stages alongside integrated voice. Keep the runtime and client contract independent of QwenAudioRealtime; provider-specific events stay in adapters. | Test interruption, cancellation, final transcripts, reconnect and error semantics across adapters, plus real microphone/speaker acceptance. [Implementation ledger](../specs/v0.2.0/IMPLEMENTATION.md), [provider contract](../handoffs/2026-09-05-provider-contract-acceptance.md) |
| MCP and wake word | Frontend configuration for external MCP; MCP search and local RAG; local Chinese wake phrase **你好星核**. | Configuration recovery, bounded tool projection, grounded citations, permissions, noisy-room and installed-platform wake tests. [03](../specs/v0.2.0/03-capability-registry-and-mcp.md), [04](../specs/v0.2.0/04-knowledge-base.md), [11](../specs/v0.2.0/11-local-wake-word.md) |
| Two memory purposes | VoiceMem serves the person across conversations; Workspace Graph serves project/workspace continuity. Keep scope, evidence and deletion semantics explicit. | No cross-user/workspace leakage; restart persistence; retrieval and deletion checks. Personal preferences are not inferred from arbitrary workspace content. [Memory architecture](02-memory.md), [implementation ledger](../specs/v0.2.0/IMPLEMENTATION.md) |
| iOS with a PC runtime | A native iOS thin client connects to the user's PC-hosted runtime through Tailscale. Pairing, connection diagnosis and recovery reduce setup friction; the PC retains execution authority. | Real phone: pair → talk → approve → execute → receive result; reconnect, credential revocation and PC sleep. Tailscale connectivity does not replace application authentication. [09](../specs/v0.2.0/09-ios-remote-client.md), [iOS ledger](../specs/v0.2.0/IOS-IMPLEMENTATION.md) |

These workstreams have substantial code in `v0.2.0dev`; use the
[implementation ledger](../specs/v0.2.0/IMPLEMENTATION.md),
[iOS ledger](../specs/v0.2.0/IOS-IMPLEMENTATION.md) and
[release gate](../specs/v0.2.0/RELEASE-GATE.md) for exact evidence and remaining gaps.
This update does not close existing human-voice, installed-Windows or wake-word gates.

The retained engineering order is **M1.5b → M1.5c → 03a**. M1.5c covers the six-tool
baseline, native conversation vision and independent monitoring, hidden Vision watch/guard and policy-driven monitoring.
The candidate realtime MCP budget `B=24` still requires provider validation; it is not a proven
universal limit. External MCP implementation is not equivalent to release acceptance.
`FASTBRAIN_SYSTEM` remains deferred legacy code, not an additional active model.

## v0.3.0 — more executors, memory-grounded initiative

Three explicit release workstreams build on that foundation:

1. **Coding backends: Kimi Code and pi agent.** Add adapters to the existing coding executor;
   reuse workspace/session coordination, approvals, progress, cancellation and result delivery.
   Validate each backend separately rather than implying Codex feature parity.
2. **GUI executor: AutoGLM as the first example.** Delegate device interaction through an
   agent executor with explicit device ownership, permissions, interruption and observable results.
   Demonstrate **agent2agent** with a reproducible Nova → specialist agent → result loop.
   This describes collaboration, not a claim of compatibility with a named A2A wire standard.
3. **Proactive + Memory: extend Surrogate.** In addition to deciding what to say and when,
   detect evidence-backed needs and opportunities for considerate follow-up from personal memory,
   workspace state and authorized sources. Reuse Suggestion Pool, host admission and Floor;
   inferred needs never authorize execution. See [02](../specs/v0.3.0/02-need-discovery-and-feed.md).

The existing personal-agent plan remains: a desktop main window with text/voice entry, feed,
tasks and correctable memory, followed by user-selected folders and one mail/calendar provider.
These are the interaction and source workstreams supporting the three goals, not prerequisites
for every executor integration. Home Assistant and the earlier MyContext integration idea remain later candidates, not v0.3
release gates; any memory-backend evaluation must preserve the personal/workspace separation.
See the [v0.3 overview](../specs/v0.3.0/00-overview.md),
[milestones](../specs/v0.3.0/STATUS.zh-CN.md) and
[executor plan](../specs/v0.3.0/05-coding-and-gui-executors.md).

## Integration and evidence

- Dev integration requires automated checks; `main` and publication require the applicable
  feature and supported-platform acceptance ledger. Linux release artifacts remain deferred;
  Ubuntu source checks remain useful.
- New executors must not add provider-specific native tools to FrontBrain. MCP projections keep
  explicit allowlists and budgets; the host owns authorization, task identity and delivery.
- Every release demonstration records backend version, platform, scenario, authorization,
  observed result and known limitations. A replay, simulated fixture or successful API call alone
  does not prove a real device workflow.
- Public examples use synthetic data. Organization-specific services, employee data and pilot
  workflows stay on `internal` and never flow into public branches.
- Favor existing ports and measured improvements over speculative core abstractions.
