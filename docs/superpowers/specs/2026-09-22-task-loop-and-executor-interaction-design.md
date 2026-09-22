# Task completion and executor interaction

Status: Design for user review. Interaction outline approved; implementation is not authorized by this document.

## Intent and agreed behavior

Nova owns the outcome of explicitly delegated work, whether it uses conversation, coding, or computer-use capabilities. It continues within the user's authorization through execution, verification, and correction, until the requested outcome is achieved or a concrete decision is needed.

Recording a Todo or Idea does not authorize execution. An explicit request to complete work does; do not add a routine second confirmation. Ordinary questions do not require task creation. Tasks may originate in a conversation or reference a Todo. Ideas remain ideas until the user delegates concrete work.

The user approved these interaction choices:

- A Nova conversation can contain several collapsible task cards, with expandable executor details.
- The main composer and orb voice always address Nova.
- Users can explicitly take over a task and communicate directly with its executors in the workbench.
- During takeover, Nova stops issuing instructions and automatic acceptance decisions for that task. Other eligible tasks continue.
- Leaving workbench mode automatically returns controlled tasks to Nova. Returning to the workbench does not take them over again.

## Current implementation and intended delta

The reviewed v0.3.0dev working tree already has persistent Life objects, conversation ownership of work, result delivery into conversations, coding target selection, Codex steering and persistent session identities. The Todo assistance action currently prepares text without a durable Todo-to-work binding. Task UI exposes summaries and open/cancel actions, rather than a replayable executor conversation.

Add a thin persistent task record and task-scoped controls around those existing capabilities. Reuse existing work IDs for execution attempts, executor adapters, session recovery, approval ownership, and presentation handling. Do not replace the scheduler, rebuild executor session storage, or change Todo into an executor state machine.

The working tree contains concurrent unrelated edits. This specification does not freeze their implementation; implementation planning must reconcile the current host and workbench context interfaces.

## Product model

| Object | Responsibility |
| --- | --- |
| Conversation | Discussion, delegation, and presentation of task references |
| Task | Requested outcome, accepted scope, completion criteria, controller, progress, and evidence |
| Work attempt | An execution attempt identified by an existing work ID; multiple attempts may serve one task |
| Executor session | Persistent executor context reused across turns and attempts; not synonymous with an attempt |
| Todo | User's personal commitment, optionally linked to a task |

A task retains its origin even when the user changes the selected conversation. A task may use several sessions. A session's completion event is evidence for a task, not automatic proof that the task is done. Nova-only work has the same outcome contract without a fabricated executor session.

An active executor session accepts instructions for only one task at a time. Reusing its context for another task requires the prior binding to be idle and an explicit new binding; do not route by whichever conversation is currently selected. Clearing a conversation does not silently cancel delegated work or erase its task record.

Task lifecycle: queued, running, verifying, waiting, completed, cancelled. Waiting includes a structured reason such as user decision, resource contention, unavailable service, uncertain recovery, or exhausted correction budget. Controller is independent: Nova or a specific workbench client. Waiting and takeover are not success states.

## Workbench and orb experience

Task cards show title, concise progress, controller, and the next relevant action. Expanding a card is read-only browsing and does not acquire control. Details show public executor messages, tool activity, approval requests, artifacts, and verification results. Do not claim access to private reasoning.

The expanded view can occupy the main workbench content area for long interactions while preserving access to the Nova conversation. Avoid placing a long independently scrolling executor chat inside a narrow scrolling message bubble. Multiple executor sessions are selected within task details, with explicit target labels.

`Take over and reply` acquires control before enabling direct input. The executor composer names the recipient; the main composer remains addressed to Nova. Nova can answer questions about a user-controlled task but does not resume autonomous instructions merely because it was mentioned. Explicit return or mode exit returns control.

Drafts belong to the local client and the exact task/session. Preserve them across panel collapse and mode changes; never send them on handback. A draft from an earlier control period remains visibly a draft and requires renewed control to send.

Switching workbench to orb or background returns all tasks controlled by that workbench client. Blur, task selection, conversation selection, panel collapse, and ordinary navigation within workbench do not. Show a lightweight handback receipt; do not announce success until the host acknowledges it. Reopening details shows changes since the user last viewed them, current results, and outstanding decisions.

Orb presents aggregate progress and prioritizes decisions or meaningful results rather than narrating every tool call. Voice stays with Nova. Opening a task from orb enters workbench focused on that task without taking control. Background mode uses the existing delivery policy and does not start voice capture to announce a handback.

## Ownership and handback

The host is the single authority. Persist task controller identity and a monotonically increasing control revision. Takeover, return, and task-directed commands carry an expected revision and request identity. The host serializes admission, rejects stale commands, and deduplicates retries. Validate again at the final instruction-dispatch boundary so a previously planned Nova action cannot cross a takeover.

Acquisition stops future Nova instructions and acceptance decisions for every session serving the task. Already admitted executor operations are not implicitly cancelled. Direct user instructions use the adapter's supported steer/continuation behavior; stop remains a separate explicit action. The UI does not claim that taking control pauses the executor or transfers physical mouse control.

On acknowledged mode exit, the host records handback and invalidates old direct-input authority. Nova reads the accepted user messages and events since takeover, incorporates explicit changes to the goal, and reconciles observed execution state. It resumes at the next appropriate execution boundary rather than automatically steering an active turn. If the user explicitly changes direction after handback, normal authorized control still applies.

Approved actions, pending approvals, control ownership, and task completion are separate facts. Handback never grants approval, revokes an existing approval by itself, submits a draft, or grants additional scope. Existing approval identity and expiry rules remain authoritative.

If mode synchronization fails, display handback as pending. A disconnected renderer cannot grant control locally. Connection loss alone is not an explicit mode change: retain durable ownership until the owning client reconnects or the user explicitly returns the task from an authenticated surface. On host restart, reconcile control and session state before admitting further work; stale client revisions cannot regain control.

## Completion loop and persistence

Persist the task goal, acceptance criteria, origin conversation, optional Todo reference/version, controller/revision, work/session references, lifecycle and waiting reason, and evidence references. Persist accepted commands and control transitions sufficiently to recover their order. UI snapshots and replay cursors derive from this state, not from renderer card state or transient banners.

Explicit delegation starts the loop. Execution results schedule verification against the latest accepted goal. Verification records evidence and either completes the task, requests a bounded corrective attempt, or enters waiting with a specific explanation. User control fences automatic verification outcomes as well as dispatch: an obsolete verifier cannot complete a changed task.

Proposed initial default for review: allow at most three consecutive automatic corrective attempts after a failed acceptance check, then explain the remaining problem and wait. A user instruction to continue starts a new correction allowance. Preserve existing per-run timeouts and cancellation. This is not an unlimited retry service or a new user-facing settings subsystem.

Examples of sufficient evidence depend on the requested outcome:

- Coding: relevant checks and observed results tied to the current changes, plus the requested artifact or behavior. Do not equate an executor's success summary with verified success.
- Computer use: a read-back receipt or observed destination state for the requested operation. Unknown effects require reconciliation before retrying, not blind repetition.
- Conversational deliverable: the delivered content checked against the requested constraints. Writing a plan completes a request to write a plan; it does not complete a request to implement it.

Evidence can be gathered through existing capabilities; a separate verifier agent is not required. Be explicit about automated checks versus real-device or external-effect checks. Authority to publish, send, or perform another consequential action follows the user's actual scope and existing approval mechanisms, not a new blanket confirmation rule.

After verified completion, update an associated Todo through the existing versioned Life mutation path with an idempotent receipt. Only the delegated Todo version/scope may be completed automatically. Concurrent edits, cancellation, or incompatible state produce a visible reconciliation requirement instead of overwriting user changes. Task completion and pending Todo synchronization remain distinguishable; a failed projection must not rerun the work. An unrelated manually completed Todo does not silently cancel active execution.

## Concurrency, recovery, and interfaces

Keep the existing single active run per coding workspace and existing global limits. Display the actual wait reason. Separate worktrees are separate workspaces only when the existing executor supports and resolves them; this feature does not create worktrees speculatively.

Computer-use execution targeting the same desktop or device must be serialized at the adapter admission boundary. Different task cards do not imply parallel access to one physical surface. Reuse existing resource ownership where available; do not build a general resource scheduling service. Explicit pause/stop is required when a user needs to operate a surface the executor is using.

Recover existing executor sessions by their original identities. Inspect actual state and accepted operation receipts before resuming; do not assume that restart erased sessions or that a missing response means an operation never happened. Preserve unknown results as unknown. Reconnect resumes public events from a cursor and deduplicates delivered results.

Extend the existing host command and snapshot surface with task listing/detail, explicit delegation with optional Todo identity, takeover/return, targeted executor input, and existing cancellation routed through the task. Commands include task identity, request identity, expected control revision, and an explicit session target where needed. Host resolves opaque IDs and verifies membership; renderer-supplied paths or arbitrary executor identities are not authoritative.

Extend the executor projection with supported public messages, tool events, and artifact references. Existing summary-only adapters remain usable and visibly offer fewer detail capabilities; do not fabricate a transcript. Keep work-owner mappings compatible and add task associations rather than changing existing ownership semantics in place. Existing data loads with no new tasks; do not infer historical delegation from Todo text.

## Acceptance scenarios

1. Capture Todo/Idea without execution; explicitly delegate with its identity; replay the same request without creating duplicate work.
2. Delegate two tasks in one conversation; navigate elsewhere; results remain bound to their original tasks and conversation.
3. Run Nova-only work without an executor session and complete against its delivery criteria.
4. Browse details without takeover; acquire control; reject a racing stale Nova instruction and stale verifier result.
5. Route user messages to the selected session while excluding Nova instructions across the entire task; preserve other eligible tasks.
6. Leave workbench during execution, with a draft, and with pending approval: acknowledge handback, preserve draft, retain approval, avoid duplicate steering.
7. Remain user-controlled on blur/collapse/conversation switch; remain Nova-controlled when returning to workbench.
8. Disconnect during handback or after sending a command; recover authoritative ownership and receipts without duplicate messages or false success.
9. Serialize same-workspace and same-device work with honest status; allow independent resources within existing limits.
10. Fail verification, correct within the allowance, and stop with evidence when the allowance is exhausted; do not mark an executor turn as task completion.
11. Complete a linked Todo once; handle concurrent Todo edits and failed projection without losing edits or rerunning execution.
12. Restart with an existing session and uncertain external effects; reconcile before continuing or repeating a write.
13. Validate real workbench/orb transitions, keyboard navigation, focus, long transcripts, preserved scroll position, and readable control/recipient labels. Test real Codex and device behavior separately from simulated protocol tests.

## Review and delivery boundary

This document consolidates user-approved interaction decisions and proposed architecture defaults. It was informed by two rounds of discussion through local Claude CLI using claude-fable-5-1; that review was based on supplied implementation summaries, not an independent repository audit.

Next gate: user review of this written specification. Only after approval should a detailed implementation plan be produced. No product code changes, dependency installation, deployment, or publication are part of this design step.
