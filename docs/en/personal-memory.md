# Personal memory

Proactive discovery, feeds, timeline, brief and profile are available only with the default Nova ledger; mem0 provides recall, evidence and Memory-page management.

Task-result feeds created while a non-product memory resource (mem0, remote or VoiceMem) is present carry a persisted `memory_origin: 'non_product'` marker. They remain visible locally, but cannot enter model-bound discovery, briefs, timeline, suggestion selection or voice delivery, even after restarting or switching to the ledger. With no memory resource, new task results remain unmarked and eligible, as do legacy unmarked task results regardless of the current backend. Memory-dependent feeds require that substrate; evidence-only dependencies must resolve independently through a non-memory source when no product substrate is active. App-record references (such as todos, goals and tasks) do not require a memory backend; scheduled-result access independently checks their versions and authorization. Disabling memory never makes unresolved memory evidence eligible.

Scheduled summaries persist the optional, bounded `memory_origin: 'non_product'` field before feed delivery and copy it to the feed and chat bubble. Publication retries preserve that production-time provenance across backend changes. This is an additive schema change: old summaries need no rewrite and remain unmarked.

Known limitation: app-only legacy reports are not re-validated against current app state on non-scheduled discovery, brief and conversation surfaces. No memory-derived text is involved. Scheduled-result access still validates app references.

The default local ledger supports explicit saves such as “Remember to call me kant.” Nova uses `memory__remember` and confirms only after a durable receipt. A new conversation can read the saved preference immediately, without waiting for extraction or vector indexing; it survives restart. A preferred form of address is not a legal name. Explicit changes and forgetting use the same versioned ledger.

Preferred names and reply style receive priority in conversation context. Use `memory__lookup` to enumerate or read exact saved facts, `memory__recall` to ask about other history naturally, and `memory__evidence` to inspect sources. Ordinary conversations still use background extraction. A turn with explicit saves uses the submitted entries and skips duplicate extraction of the full turn. Conflicts and failures must not be reported as successful saves. Explicit writes are currently unsupported by mem0 and remote backends. Forgetting hides the entry and its operation evidence. Distinct explicit saves remain independent even if they quote the same sentence. Surviving broad quotations may still mention a forgotten fact; forgetting does not delete chat history or guarantee semantic erasure of paraphrases.

Nova learns information from conversations so you can ask about it later. Personal memory is enabled by default and stored locally in the unified memory ledger. It supports conversation recall, source evidence, corrections and forgetting. mem0 remains available as an explicitly selected alternative.

## Use it

Tell Nova a fact, such as “My example project is Cedar, code C-731.” Later, in a new conversation, ask: “What is Cedar's project code?”

Learning takes time. A new fact may not be searchable immediately; check its learning state in the desktop memory panel.

## Memory in Plan / Build

Plan and Build text conversations can use the memory retrieval tools supported by the current backend. Backends supporting explicit saves also expose `memory__remember` and `memory__lookup`. Both modes **write only through `memory__remember` on an explicit user request**, with no automatic learning. A save requires a verbatim quote from the current typed user message and a committed receipt. Files, tool results and voice transcripts cannot authorize saves. These rules are part of the system instructions on every Workbench turn, including restored conversations. Resume retains the original user text; host context is not a new request.

Use `scope=general` for project, code and repository constraints, and `scope=user` only for stable facts about the user themself. General project memories remain readable through `memory__recall`, `memory__lookup` and the Memory page, but do not enter `USER.md`, the voice “Memory facts” list or reply preferences. This general-scope exclusion from voice facts and reply preferences applies only to the Nova ledger: remote and VoiceMem-adapter preferences carry no scope. This exclusion does not cover derived summaries.

At the start of a new text turn, shared authorized retrieval may inject a few relevant memories as untrusted reference context. Retrieval failures or a roughly 400 ms timeout are silently skipped. Pending retrieved context is discarded on retries and Resume, including after restart; Resume does not re-retrieve it. This does not require `MEMORY_PRERECALL_ENABLED` and never triggers automatic writes. Plan / Build voice remains a conversation and steering channel with no tools and no automatic memory capture; return to text to explicitly request a memory write. Chat voice capture is unchanged.

## View memories

[![Nova Profile in the main window](../../assets/features/profile-original.en.png)](../../assets/features/profile-original.en.png)

Use the main window’s memory view to inspect, correct or forget ledger entries. With mem0 selected, right-click the orb, open the memory panel, and select personal memory. You can search your original wording, view learned facts and their sources, and browse earlier records.

Search matches original text. Long entries show an excerpt. Inspection currently supports local mem0; the panel does not offer editing or deletion.

## Storage and privacy

The unified ledger defaults to `~/.nova-audio-agent/workspace-graph.sqlite`; use `MEMORY_LEDGER_PATH` to select another location. With mem0 selected, files are stored under `~/.nova-audio-agent/memory.sqlite.mem0/`, with separate data for each user.

The ledger's sibling `<MEMORY_LEDGER_PATH>.memory/` directory contains `USER.md` for stated user information, one file per goal/todo/idea, and a generated `MEMORY.md` directory. Profile summaries remain derived rather than a second fact store. You may edit marked record bodies; IDs, versions, sources, status and links are maintained by Nova. Corrections enter the same versioned merge path.

**Local storage is not offline processing.** Extraction and embeddings send relevant text to your configured model service.

Personal memory comes from conversation. Document knowledge comes from files you import. Neither grants permission to execute tasks.

## Change or disable memory

For source use, edit `.env` and restart Nova. No changes are needed for the defaults.

| Choice | Configuration |
|---|---|
| Unified local ledger (default) | `MEMORY_CONNECTION=local`; omit provider or select `voicemem` |
| Local mem0 | `MEMORY_CONNECTION=local` and `MEMORY_PROVIDER=mem0` |
| Disable memory | `MEMORY_CONNECTION=disabled`; remove provider |
| Remote service | `MEMORY_CONNECTION=remote`; configure the service URL and token below; remove provider |

Remote connections require `MEMORY_URL` and `MEMORY_TOKEN`. The service must implement Nova's memory interface; an arbitrary mem0 endpoint is not compatible. Connection failure reports unavailable rather than switching to local storage.

The unified ledger can import legacy VoiceMem records without changing the old database. Selecting mem0 does not migrate ledger records or enable ledger-backed source connectors. Disabling memory does not delete stored data. See [configuration](configuration.md) for common settings.

### Standalone mem0

mem0 supports recall with original user-turn evidence and local Memory-page listing, correction and forgetting. Explicit `remember`/`lookup` tools remain ledger-only. Model reads require both the destination grant saved when the source was admitted and the currently configured destination; missing grants fail closed. Sources admitted before this change remain visible in the Memory page, but are not offered to the model until the identical user turn is re-admitted with the same source ID. Only an empty grant snapshot is refreshed; existing nonempty grants and forgotten sources are never widened.

Corrections use durable local overrides under the SDK item ID; revision tokens hash the SDK update timestamp and canonical content, falling back to a content hash when no timestamp exists. The canonical text is bounded to 500 characters. Correcting or forgetting an item freezes re-extraction of its source to prevent new SDK IDs from resurrecting old facts. Raw evidence remains the original user turn, not the corrected or extracted text. Source forgetting tombstones that turn immediately and retries derived-item deletion after restart. Corrections change returned text, not the SDK embedding, so ranking still uses the original embedding.

mem0 listing scans the SDK store once per page (O(n) reads and O(n log n) sorting), batches local overrides, and hydrates only the requested page. No scan is cached across requests. `include_expired: true` is unsupported and returns an invalid-input error; forgotten entries are never listed.
