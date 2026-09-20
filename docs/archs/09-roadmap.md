# 9. Roadmap

Updated 2026-09-10. The version scope below follows the product roadmap; implementation,
automated checks, live acceptance and release are separate states. A roadmap item is not a
claim that the feature has shipped. Package versions change only in an explicit release chore.

## Core capabilities

| Workstream | Planned outcome | Acceptance boundary / specification |
|---|---|---|
| Cross-platform approvals | Forward sandbox-blocked network requests, command execution and permission upgrades to the active frontend through the host approval broker. Show the operation, workspace and requested scope; return approval or denial to the originating executor. | macOS and Windows host behavior; Desktop and iOS approval presentation. Reject stale, expired and duplicate answers; never widen permission on disconnect. Ordinary operations already permitted by the sandbox remain unprompted. [01](../specs/v0.2.0/01-codex-approvals.md), [09](../specs/v0.2.0/09-ios-remote-client.md) |
| Thin FrontBrain | Reduce native tools; move workspace/session selection, routing and scheduling into the coding executor. The frontend expresses intent and consumes facts; the host owns authorization and work identity. | The existing five host/native tool baseline and `dispatch / cancel / confirm`; no model-visible workspace/session state machine. [07](../specs/v0.2.0/07-executor-boundary.md), [08](../specs/v0.2.0/08-project-and-work.md) |
| Replaceable voice pipeline | Support configurable ASR / LLM / TTS stages alongside integrated voice. Keep the runtime and client contract independent of QwenAudioRealtime; provider-specific events stay in adapters. | Test interruption, cancellation, final transcripts, reconnect and error semantics across adapters, plus real microphone/speaker acceptance. [Implementation ledger](../specs/v0.2.0/IMPLEMENTATION.md), [provider contract](../handoffs/2026-09-05-provider-contract-acceptance.md) |
| MCP and wake word | Frontend configuration for external MCP; MCP search and local RAG; local Chinese wake phrase **你好星核**. | Configuration recovery, bounded tool projection, grounded citations, permissions, noisy-room and installed-platform wake tests. [03](../specs/v0.2.0/03-capability-registry-and-mcp.md), [04](../specs/v0.2.0/04-knowledge-base.md), [11](../specs/v0.2.0/11-local-wake-word.md) |
| Two memory purposes | Local mem0 (or explicitly selected VoiceMem/remote memory) serves the person across conversations; host-owned project/session records preserve work continuity. Keep scope, evidence and deletion semantics explicit. | No cross-user/workspace leakage; restart persistence; retrieval and deletion checks. Personal preferences are not inferred from arbitrary workspace content. [Memory architecture](02-memory.md), [implementation ledger](../specs/v0.2.0/IMPLEMENTATION.md) |
| iOS with a PC runtime | A native iOS thin client connects to the user's PC-hosted runtime through Tailscale. Pairing, connection diagnosis and recovery reduce setup friction; the PC retains execution authority. | Real phone: pair → talk → approve → execute → receive result; reconnect, credential revocation and PC sleep. Tailscale connectivity does not replace application authentication. [09](../specs/v0.2.0/09-ios-remote-client.md), [iOS ledger](../specs/v0.2.0/IOS-IMPLEMENTATION.md) |

These workstreams have substantial code in the runtime; use the
[implementation ledger](../specs/v0.2.0/IMPLEMENTATION.md),
[iOS ledger](../specs/v0.2.0/IOS-IMPLEMENTATION.md) and
[release gate](../specs/v0.2.0/RELEASE-GATE.md) for exact evidence and remaining gaps.
This update does not close existing human-voice, installed-Windows or wake-word gates.

The retained engineering order is **M1.5b → M1.5c → 03a**. M1.5c covers the five host/native tool
baseline, native conversation vision and independent monitoring, hidden Vision watch/guard and policy-driven monitoring.
The candidate realtime MCP budget `B=24` still requires provider validation; it is not a proven
universal limit. External MCP implementation is not equivalent to release acceptance.
Historical `FASTBRAIN_SYSTEM` references are not a current production entry point.

## v0.3.0 — personal-agent loop (M5–M8)

Text/voice entry and an Electron main window; evidence-grounded Surrogate proposals;
persistent feed; correctable/forgettable personal memory; user-authorized local folder
synchronization (M5–M7, implemented on `v0.3.0dev`). Then a unified memory substrate
(append-only evidence ledger storing raw text, revision-log entries, read-only views;
spec 06), one mail/calendar provider (M8-Mail) and a Feishu connector that is both a
source and a delivery channel (M8-IM). Mail and IM were moved to v0.4.0 on 2026-09-11
and pulled back on 2026-09-12. Reuse the existing runtime, Suggestion Pool, Floor and
knowledge import. See [specs](../specs/v0.3.0/00-overview.md) and
[milestones](../specs/v0.3.0/STATUS.zh-CN.md).

## v0.4.0 — specialist executors (M9)

M9-C Kimi Code and pi agent; M9-G GUI/AutoGLM; M9-Demo real agent2agent workflows.
Executors do not wait for mail/calendar or IM. Home Assistant and MyContext remain later candidates.
See [specs](../specs/v0.4.0/00-overview.md) and [milestones](../specs/v0.4.0/STATUS.zh-CN.md).

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
