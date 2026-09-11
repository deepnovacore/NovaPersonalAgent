# v0.3.0 M5–M7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement and review these bounded work packages.

**Goal:** Deliver the existing M5–M7 specs in the isolated v0.3.0dev worktree; M8 onward moves to v0.4.0.

**Architecture:** Reuse the one runtime, one desktop transport, existing VoiceMem Worker, SuggestionPool/Floor and KnowledgeService. Add durable host-owned feed and source bookkeeping, versioned memory projections, and a desktop main view around the existing orb/audio owner. User actions retain host validation and normal executor authorization.

**Tech Stack:** Existing TypeScript/Node, zod, SQLite Workers, Electron and native HTML/CSS. No new dependency.

**Spec:** docs/specs/v0.3.0/00-overview.md and volumes 01–04.

## Global Constraints

- Current user request authorizes implementation of the existing approved layout and M5–M7 scope; M8/M9 are explicitly v0.4.0.
- Public branch: no internal services/data/configuration; no push or main merge.
- All work under .worktrees/v0.3.0dev; preserve main checkout's uncommitted edits.
- Test databases are temporary; set NOVA_AUDIO_AGENT_BLACKBOARD_PATH to a temporary file for production tests.
- Node >=22.13.0; no new runtime dependency or replacement parser/retrieval engine.
- Pure text must not initialize microphone. One backend connection and audio owner, including collapsed state.
- Explicit input is the only execution authorization; generated proposals/source contents never dispatch work.
- Memory correction/forgetting happens in existing VoiceMem storage and affects recall; no third memory database.
- Durable writes precede success receipts. Conflict, unsupported and unavailable are observable failures.
- UI uses textContent for untrusted content; bounded requests and host-selected user identity.
- Human/provider/installed-platform evidence remains pending until actually exercised.

## Implementation decisions

- Existing left conversation/right Dynamic, Tasks, Memory layout. Fixed responsive columns; use the user-provided pale-blue rounded-card and keyword-chip references. Main/orb view may share a renderer to preserve audio ownership.
- Discovery interval default 30 minutes, configurable and off switch; 24-hour proposal expiry; latest eight delivery summaries. Only questions qualify for passive collapsed notification; no automatic new-proposal speech.
- Summary-first memory view per user feedback: factual overview and keyword chips, grouped summaries, with raw entries/source/correction/forget controls in disclosures. Summaries stay grounded in the loaded entries and explicitly state coverage; directory names do not establish occupation or identity. Missing backend capabilities disabled with a reason.
- Local folders only, opt-in, polling plus startup/recovery reconciliation. Defaults 200 bodies/20 MiB per scan; exclusions visible and additive. Sensitive paths and out-of-root symlinks always rejected.

## Task 1: Versioned personal memory (M6-A backend)

**Files:** runtime/src/memory/personal-memory.ts; runtime/src/voicemem/store-client.ts, store-worker.ts; new runtime/src/memory/entry.ts; relevant runtime tests.
**Consumes:** existing VoiceMem records/evidence/store, existing Worker ownership.
**Produces:** exported MemoryEntry schema/type matching spec 03; optional list/get/correct/forgetEntry/capabilities on PersonalMemoryResource, implemented by local Worker. list({cursor?,limit?}) -> {entries,cursor}; get(id) -> MemoryEntry|null; correct(id,expectedVersion,content,userSource) -> {previous,entry}; forgetEntry(id,expectedVersion) -> MemoryEntry. Version conflicts reject; include optional forgetSource(ref) for source dependency removal, preserving other independent refs.

- [x] Prove pre-implementation failure for correction/forgetting plus recall, persistence, cross-user scope and stale-version conflicts using temporary actual storage.
- [x] Implement bounded Worker RPC and projection; preserve tombstones/suppression, no fake success for remote backends.
- [x] Verify reopen and correction suppress old recall; forgotten content never returns via reply adaptation.
- [x] Independent review then focused fixes.

Behavior check:
```ts
const before = await memory.get(id)
const {entry} = await memory.correct(id, before.version, 'Corrected preference', userSource)
assert.equal(entry.origin, 'stated')
await assert.rejects(memory.correct(id, before.version, 'stale', userSource))
assert(!(await memory.recall('preference')).hits.some(hit => hit.text === before.content))
```

## Task 2: Host feed, proposal discovery and client protocol (M5-A/M6-B)

**Files:** new runtime/src/personal-agent/{contracts,host,store}.ts and tests/fixtures; runtime desktop/service/assembly/protocol and Surrogate boundaries as required.
**Consumes:** Task 1 PersonalMemoryResource; existing runtime events, ModelGateway, SuggestionPool/Floor. Optional source service attached by coordinator.
**Produces:** `personal.command` control `{type,request_id,method,params}`; methods state/feed.action/memory.list/memory.correct/memory.forget/discovery.configure plus sources.* delegated to source service. Snapshot `personal.state` `{type,revision,feed,memory,sources,capabilities,settings}` and result `personal.result` `{type,request_id,ok,error?}`. Runtime zod validates all fields and existing client.command wraps remote requests. Host owns feed, ledger and sources; UI never writes authoritative snapshots.

- [x] Failing behavioral checks: no evidence rejected; memory-only allowed; stale memory rejected; same matter+date dedupe survives restart/dismissal and unrelated evidence.
- [x] Implement persistent feed and separate presented/notified/spoken receipts, invalidation, snooze, dismissal, task-result updates. Revalidate evidence before delivery; no new-proposal speech bypass.
- [x] Extend existing Surrogate optional proposal and dedicated bounded discovery opportunity; do not change coding progress semantics. Add persisted/configurable 30-minute tick and async memory snapshot; shut down timers and in-flight requests.
- [x] Wire actual desktop/headless production lifecycle and control handlers. Expose the existing opened personal memory resource, no second owner.
- [x] Add >=10 positive and >=10 silence cases; distinguish deterministic host checks from model-quality live evaluation.
- [x] Run targeted protocol/host tests, review, fix.

Behavior check:
```ts
await host.admit(validProposal, snapshot)
await host.action({action:'dismiss',id})
await host.close()
await host.open()
assert.equal(await host.admit(validProposal, snapshot), 'suppressed_duplicate')
assert.equal(host.snapshot().feed[0].lifecycle, 'active')
```

## Task 3: Desktop product view and input (M5-B/M6 UI)

**Files:** clients/desktop/src/{main,preload,renderer}; focused desktop tests.
**Consumes:** existing captions, EXECUTOR_TASKS, input.text/dictation/audio; Task 2 personal.state and personal.command/result.
**Produces:** main view left conversation, right Dynamic/Tasks/Memory, host-backed actions, collapse to existing orb and expand; configurable discovery and source controls.

- [x] Failing UI/controller check: opening text view never starts mic; switching full duplex to text stops continuous capture; dictation finish fills draft but does not send.
- [x] Implement host capability gating, request tracking, loss/error handling, no duplicate connection or audio owner. Preserve existing integrated preference; new desktop installs cascaded.
- [x] Render host feed with action/dismiss/snooze/evidence and ignored filter; memory correct/forget with expected version; task list/results/approvals reuse existing controls.
- [x] Source settings: native chosen directory, consent and visible coverage/exclusions/pause/disconnect/delete; consumed from sources state.
- [x] Test reconnect/stale snapshot, collapse/reopen, refused actions, XSS-safe content and accessible labels. Actual browser/Electron visual acceptance separately.
- [x] Review then fix.

Behavior check:
```js
controller.open()
assert.equal(microphoneStarts, 0)
controller.receiveTranscription({id: draftId,text:'draft'})
assert.equal(sent.some(frame => frame.type === 'input.text'), false)
```

## Task 4: Local directory sources (M7)

**Files:** new runtime/src/personal-agent/sources.ts; existing KnowledgeService used unchanged where possible; runtime tests.
**Consumes:** KnowledgeService.handle/listSources; host feed invalidation and memory source propagation.
**Produces:** source list with id/path/state/scanned/read/skipped/reasons/failures/last_sync, sources.add/pause/resume/disconnect/delete/sync commands, source-change hooks. Host-selected data path; durable authorization.

- [x] Failing real filesystem checks: exclusions/out-of-root symlink never read; 10,000 metadata entries but <=200 bodies; delete propagates; temporary failure does not imply deletion.
- [x] Persist directory grants/state and bounded file metadata; poll with single in-flight reconciliation and cancellation fences. Reuse existing ingest/reindex/remove.
- [x] Connect to production host with no scans absent explicit directory consent. Source deletion invalidates feed and forgets only dependent memory provenance.
- [x] Test restart, pause during scan, rename/delete, failure recovery and idempotence.

## Task 5: Integration and acceptance ledger

- [x] Run builds/check and suites serially because runtime/dist is shared.
- [x] Trace desktop text -> host -> real runtime; exercise synthetic production composition with isolated storage and fake providers where no credential is authorized.
- [x] Review complete diff for provenance, auth, stale actions, durable error handling and public boundary.
- [x] Record per-milestone implemented/automated/live/pending states, exact checks and known limitations. Human acceptance is not inferred.
- [x] Commit coherent work packages locally; no public push or main merge.

## Follow-up: content-based memory summaries

- [x] Prefer bounded, screened README descriptions over scan statistics; retain relative document context.
- [x] Generate optional host summaries through the existing model adapter, validate current entry/version citations, invalidate on source/edit/delete changes, and allow later retries after failure.
- [x] Render concise overview, up to four sections and keywords; preserve source/correct/forget access and show actual excerpts as fallback.
- [x] Cover source-version renewal and explicit forgetting with real isolated VoiceMem; verify narrow-window layout in the browser.
- [ ] Run actual external-model quality acceptance after authorization for the selected README excerpts and configured Qwen destination. Local curated preview is not model evidence.
