# 2. Memory

Nova uses several memory layers with deliberately different authority. They are not one global bag
of prompt text.

## Layers

- **L0 — causal runtime blackboard.** `Memory` channels, active delegates, accepted handoffs, and
  revision-bound intake slots are the live session truth. Host authorization and project-confirmation
  FSMs are separate host state, never model-writable planning state. Entries carry time, trust,
  priority, outcome, and evidence references. Applying an event precedes any response derived from
  it. Only the causal runtime owns current task/executor state.
- **Personal memory.** Optional VoiceMem retains user-approved facts across conversations.
  Its lifecycle, recall and deletion are independent of live task state.

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
There is no automatic corpus injection into ContextView. See
[spec 04](../specs/v0.2.0/04-knowledge-base.md) and its separate live acceptance ledger.

Sensitive path and content gates live in `runtime/src/memory/sensitivity.ts` and are shared by knowledge
and executor reference handling. The future memory substrate is specified separately in
[06](../specs/v0.3.0/06-memory-substrate.md); it is not implemented.
