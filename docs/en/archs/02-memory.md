# 2. Memory

Nova uses several memory layers with deliberately different authority. They are not one global bag
of prompt text.

## Layers

- **L0 — causal runtime blackboard.** `Memory` channels, active delegates, accepted handoffs, and
  revision-bound intake slots are the live session truth. Host authorization and project-confirmation
  FSMs are separate host state, never model-writable planning state. Entries carry time, trust,
  priority, outcome, and evidence references. Applying an event precedes any response derived from
  it. Only the causal runtime owns current task/executor state.
- **Personal memory.** The unified local ledger is enabled by default; mem0, a host-managed remote
  connection, or disabled memory can be selected explicitly. Durable source admission and
  asynchronous extraction retain facts across conversations. Recall, host deletion and optional
  inspection are independent of live task state. See [personal memory](../personal-memory.md)
  for configuration, model data flow and the limits of the current desktop view.

## Session recovery store

The L0 blackboard persists through a dedicated SQLite Worker
(`runtime/src/memory/blackboard-session.ts`, `blackboard-store.ts`, `blackboard-worker.ts`) so a
conversation survives a restart. Retention is bounded by three independent limits — a 7-day entry
lifetime, 1000 items and 8MB — and the oldest entries are dropped first. The database path is
`BLACKBOARD_PATH` (default `~/.nova-audio-agent/blackboard.sqlite`), scoped by
`BLACKBOARD_OWNER_ID`. This store recovers session history; it is not a queryable
long-term memory, and unrestricted long-term memory search remains deferred
([design constraints](07-decision-record.md)).

## Personal memory engines

Personal memory uses one port (`runtime/src/memory/personal-memory.ts`). `MEMORY_CONNECTION`
selects local, remote or disabled. For explicit local composition use `MEMORY_RECALL_ENGINE=ledger`
and `MEMORY_EXTRACTORS=ledger`. Leaving both unset preserves the default ledger and legacy migration.
`MEMORY_PROVIDER` is deprecated: `voicemem` retains that migration and `mem0` retains standalone mode;
do not combine it with the new variables. Both `mem0` and `voicemem` are production recall choices
over the same ledger authority. Disabled memory allocates no personal store.

**mem0 (explicit alternative)** admits sources to its own ledger before any model sees them. Each source moves
through `pending → learned`, or `forgotten` when deleted, and `recall()` returns only `learned`
sources — re-checking state after its asynchronous extraction call so a concurrent `forget()` is
never raced. Extraction drains in the background under a single-drainer lock
(`learning-lock.db`, `PRAGMA busy_timeout=0`), so a second process fails fast rather than
duplicating work. Admission is idempotent by source identity. Storage is per user:
`memory.sqlite.mem0/<sha256(userId)>/`, holding `ledger.db` alongside the mem0 SDK's own vector
databases.

**Unified local ledger (default)** is wired by production composition through `runtime/src/memory-substrate/`. It preserves source evidence, revision history, processing consent and unified retrieval. Legacy VoiceMem data can be imported read-only while retaining the original database. The `voicemem` provider name remains for configuration compatibility; the compatibility shim retains injected legacy local factories. **Remote personal memory** (`remote-personal-memory.ts`) is a host-managed HTTP client
over `/v1/remember`, `/v1/forget`, `/v1/recall` and `/v1/preferences`; the URL must be HTTPS or
loopback, and responses are size-capped.

Legacy standalone mem0 and remote memory do not migrate unified-ledger data. New `MEMORY_RECALL_ENGINE=mem0|voicemem` instead backfills derived SDK indexes from that ledger. The legacy VoiceMem read-only import is a separate migration path.

`MEMORY_EXTRACTORS=ledger,voicemem` adds opt-in VoiceMem emotion/trait extraction. Styles stay in the SDK store, never ledger facts; at least three distinct authorized user-conversation sources are required for a trait. Context expires within ten minutes of its earliest evidence and is revalidated at consumption. Corrections, forget, consent changes and purge enqueue transactional generation jobs; workers reconcile SDK state idempotently, with leased claims, external-write locks and restart retries. Engine candidates are always hydrated to canonical ledger IDs/revisions/evidence. General/project memories remain explicitly readable with canonical scope labels, but are excluded from automatic user-only recall. Engines reuse existing embedding and fast-model routes, not new memory-specific keys. See [production composition](../../design-notes/2026-11-03-memory-backend-composition.md) for provider requirements, failure handling and quality limits.

## Separate document knowledge (K)

The opt-in knowledge corpus is separate from live conversation and personal memory. A SQLite Worker
stores user-admitted documents, chunks and embeddings; lexical and cosine ranks are combined
with reciprocal-rank fusion. Lexical search uses FTS5 when available, otherwise bounded
parameterized LIKE (including Node 22.13); capable opens rebuild FTS from canonical chunks.
Ingestion/reindex is host-only and requires the settings
panel's data-egress consent. Text goes to the configured embedding provider; local storage
does not mean local-only inference.

FrontBrain sees only `mcp__nova_knowledge__recall`. Optional authenticated loopback MCP
adds `get_chunk` for Codex; work-order references are host-attached, bounded, and revalidated.
Public results omit private source paths and remain `untrusted_external`. Disabling the
module allocates no Worker or MCP server and does not change `memory__recall`.
There is no automatic corpus injection into ContextView. See the
[knowledge base guide](../knowledge-base.md).

Sensitive path and content gates live in `runtime/src/memory/sensitivity.ts` and are shared by
knowledge, personal-memory admission and executor reference handling, so credential-like content is
rejected on every path before it is stored or sent to a provider.
