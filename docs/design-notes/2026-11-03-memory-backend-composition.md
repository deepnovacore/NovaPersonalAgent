# Memory backend composition (staged WP4)

Nova's ledger remains the system of record for revisions, consent, tombstones,
forgetting and product surfaces. Engine selection is an expert environment setting,
not a user-visible picker. Defaults and the existing legacy migrations are unchanged.

## Configuration

- `MEMORY_RECALL_ENGINE=ledger` selects a ledger composition without legacy migration.
- `MEMORY_EXTRACTORS=ledger` is a comma-list setting; only `ledger` is implemented.
  Unsupported extractors are rejected, not silently ignored.
- With neither new variable, local configuration retains ledger + legacy migration.
- Deprecated `MEMORY_PROVIDER=voicemem` retains that same migration behavior;
  `MEMORY_PROVIDER=mem0` retains standalone mem0, including its reduced tools.
  A process emits one content-free deprecation warning on legacy factory use.
- Legacy and new variables cannot be combined. New variables cannot override remote
  service engines. Disabled memory and missing local credentials remain optional.
- `voicemem` and `mem0` are recognized recall-engine names, but their new ledger
  feeding pipeline is **not available yet**. Selecting either fails immediately with
  `ConfigurationError`, including without credentials. There is no silent fallback.

`resolveMemoryComposition` is side-effect-free. `personalMemoryFactory` returns a
factory and an explicit plan; planning and runtime composition share that plan.
The former `localMemoryConfig` factory tag is accepted only as a compatibility shim.

## Implemented seam, not an enabled production engine

`MemoryRecallEngine` / `LedgerRecallEngine` accept candidate ids and ledger revisions.
Engine text and evidence claims are discarded; hits are hydrated from current ledger
rows and checked against consumer grants. Missing, stale and forgotten rows are dropped.
The engine cannot grant mutation capabilities or supply product surfaces.

VoiceMem-only `contextHits` (`experience`, the host name for heartnotes, and `trait`)
require current authorized ledger evidence and a fixed `recordedAt`/`expiresAt` window
of at most ten minutes. They are never written into the ledger. Unified retrieval keeps
these in an internal side channel, not in its serialized factual results or tools.
The shared prerecall/background consume path revalidates evidence and expiry and renders
an escaped, bounded `<response_style_hint ttl_turns="3">` separately from
`<possible_memory>`. The current request wins; hints cannot authorize actions or become
stable traits. This tag is advisory, not a persistent three-turn cache; every consume
rechecks the ten-minute deadline and source authorization. Default ledger and standalone
mem0 do not inject these hints.

## Deferred before production selection can be enabled

- Durable ledger-transaction engine index jobs keyed by `(entryId, revision)`.
- Durable engine forget jobs for entry/source erasure and purge, with restart retry.
- Real VoiceMem/mem0 indexing adapters and provider-id-to-ledger-id mapping.
- Engine source admission for temporary emotion/trait generation.

Inspection found only file-publication and source-processing outboxes, not a reusable
engine-index job table. No table was added in this staged change. Fake candidate engines
exercise the recall seam over the real persistent ledger; the existing standalone mem0
suite separately covers its SDK facade. These tests do not claim durable engine feeding
or deletion from an external index.

## Manual evaluation gate (not run)

Before enabling production selection, compare paired replies for stable preference vs
one-turn request, temporary emotion vs stable trait, correction, and forgetting. Check
that style hints improve tone without inventing facts, diagnoses or enduring traits.
Record reviewed engine/asset versions and outcomes separately; do not log queries,
provider endpoints, content or fingerprints. No default enablement is approved here.
