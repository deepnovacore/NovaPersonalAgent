# 2. Memory

Nova uses several memory layers with deliberately different authority. They are not one global bag
of prompt text.

## Layers

- **L0 — causal runtime blackboard.** `Memory` channels, active delegates, accepted handoffs, and
  revision-bound intake slots are the live session truth. Host authorization and project-confirmation
  FSMs are separate host state, never model-writable planning state. Entries carry time, trust,
  priority, outcome, and evidence references. Applying an event precedes any response derived from
  it. Only the causal runtime owns current task/executor state.
- **Personal memory.** Local mem0 is enabled by default; VoiceMem, a host-managed remote
  connection, or disabled memory can be selected explicitly. Durable source admission and
  asynchronous extraction retain facts across conversations. Recall, host deletion and optional
  inspection are independent of live task state. See [personal memory](../personal-memory.md)
  for configuration, model data flow and the limits of the current desktop view.

## Session recovery store

The L0 blackboard persists through a dedicated SQLite Worker
(`runtime/src/memory/blackboard-session.ts`, `blackboard-store.ts`, `blackboard-worker.ts`) so a
conversation survives a restart. Retention is bounded by three independent limits — a 7-day entry
lifetime, 1000 items and 8MB — and the oldest entries are dropped first. The database path is
`NOVA_AUDIO_AGENT_BLACKBOARD_PATH` (default `~/.nova-audio-agent/blackboard.sqlite`), scoped by
`NOVA_AUDIO_AGENT_BLACKBOARD_OWNER_ID`. This store recovers session history; it is not a queryable
long-term memory, and unrestricted long-term memory search remains deferred
([design constraints](07-decision-record.md)).

## Personal memory engines

Three engines sit behind one port (`runtime/src/memory/personal-memory.ts`), selected by
`NOVA_AUDIO_AGENT_MEMORY_CONNECTION` and `NOVA_AUDIO_AGENT_MEMORY_PROVIDER`; `factory.ts` returns
`undefined` when memory is disabled, so no store is allocated.

**mem0 (default)** admits sources to its own ledger before any model sees them. Each source moves
through `pending → learned`, or `forgotten` when deleted, and `recall()` returns only `learned`
sources — re-checking state after its asynchronous extraction call so a concurrent `forget()` is
never raced. Extraction drains in the background under a single-drainer lock
(`learning-lock.db`, `PRAGMA busy_timeout=0`), so a second process fails fast rather than
duplicating work. Admission is idempotent by source identity. Storage is per user:
`memory.sqlite.mem0/<sha256(userId)>/`, holding `ledger.db` alongside the mem0 SDK's own vector
databases.

**VoiceMem** is the alternative local engine, wrapping the `packages/voicemem-ts` SDK behind the
same port. **Remote personal memory** (`remote-personal-memory.ts`) is a host-managed HTTP client
over `/v1/remember`, `/v1/forget`, `/v1/recall` and `/v1/preferences`; the URL must be HTTPS or
loopback, and responses are size-capped.

Each engine keeps its own database, so switching engines does not migrate existing memories.

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
