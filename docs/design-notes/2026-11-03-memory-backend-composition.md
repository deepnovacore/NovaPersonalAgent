# Production memory engine composition

The ledger remains the authority for versions, consent, source evidence, corrections,
tombstones, forgetting and product surfaces. Engine selection is an expert environment
setting, not a UI picker. Defaults and legacy migration are unchanged.

## Configuration and providers

- `MEMORY_RECALL_ENGINE=ledger|mem0|voicemem` selects recall candidates. Default: ledger.
- `MEMORY_EXTRACTORS=ledger` (default) or `ledger,voicemem`. `ledger` is required;
  duplicates and unsupported names are rejected. VoiceMem extraction is opt-in even
  when VoiceMem recall is selected.
- Neither new variable: ledger plus the existing legacy read-only migration.
- Deprecated `MEMORY_PROVIDER=voicemem` retains that behavior; `MEMORY_PROVIDER=mem0`
  retains standalone mem0 and reduced explicit-write tools. Legacy and new variables
  conflict. Remote services select their own engines; local overrides are rejected.
- There is no `MEMORY_BACKEND` alias. `MEMORY_CONNECTION` still selects local, remote
  or disabled. Missing local credentials still disable optional local memory.
- Engines reuse `resolveEmbeddingConnection` (`EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`,
  `EMBEDDING_API_KEY`, or the configured embedding model route) and the fast/extraction
  model route (`MODEL_ROUTES`, otherwise selected provider and `FAST_MODEL`). Existing
  DashScope defaults use `DASHSCOPE_API_KEY`. No Mem0 cloud key is needed.
- Providers must implement OpenAI-compatible `POST /embeddings` and, for extraction,
  `POST /chat/completions`; generic example base URL: `https://api.example/v1`.
  No local embedding model is added. SDK embedding dimensions must match their store.
- Invalid memory settings carry only fixed startup error codes and allowlisted variable
  names; credentials, URLs and raw configuration values are not diagnostic metadata.

## Real adapters and authority

Installed `mem0ai/oss` 3.2.0 `Memory.add(infer:false)`, `search`, `getAll` and `delete`
operate the SDK's own persistent memory vector store. Canonical facts are not extracted
again by mem0. Metadata maps SDK IDs to ledger IDs/revisions. There is no replacement
vector database masquerading as mem0. Its public `langchain` embedding-model integration
accepts `embedQuery`/`embedDocuments`; these use the installed OpenAI-compatible
VoiceMem embedding provider without internal HTTP retries. Each actual HTTP request
is authorized at the fetch boundary, including embedding batches. Failed requests
return to durable outer retries, which acquire fresh authorization. The mem0 SDK still
owns admission, search, deletion and the vector store. Its configured LLM is unused
on this `infer:false`/search path; VoiceMem model calls, repairs and batches use the
same per-request authorization hook and do not internally retry HTTP failures.

Installed `voicemem` 0.0.1 `VoiceMem.store.admit/commit` indexes canonical facts;
`VoiceMem.ingest/resumeIngest/search/forget` handles its own emotion/trait extraction,
search and source lifecycle. Its OpenAI-compatible provider implementations are used.
Both SDKs run in bounded workers. Mem0 SDK telemetry is disabled for these workers.

Every candidate is hydrated from the current, active ledger revision and authorized
source references. Engine text, kind and claimed evidence are not facts. General/project
entries are excluded at the ledger boundary. Engine selection preserves the actual
`SubstrateMemoryResource`, its product surfaces and ledger mutation capabilities.
No engine error silently falls back to ledger recall. Pending/failed indexing is marked
degraded and exposed through content-free `engineIndexStatus()`.

## Durable indexing and erasure

`memory_engine_outbox` is a content-free transactional dirty-generation outbox per user
scope and engine configuration. SQL triggers enqueue work with evidence/revision/grant,
message-head, suppression and purge changes, including hand-edited memory files.
Registration backfills an existing ledger. Worker claims carry an owner, generation and
120-second crash-recovery lease. Stale or expired acknowledgements cannot complete newer work.
Every authorization check enforces the earliest entry/source-evidence retention deadline,
including while an existing synchronization promise is awaiting earlier provider work;
it does not depend on another claim to detect expiration.
A separate SQLite write lock serializes external SDK writes even if a lease expires;
process death releases that lock. The worker rechecks authority after acquiring the external lock, before any mutation, and again at provider-bound steps.
SDK stdout/stderr are drained privately; only content-free RPC failures escape. Workers have a 30-second RPC bound and are terminated on abort/shutdown. SDK provider
requests use 20-second bounds where supported.

Retries reconcile SDK state rather than blindly appending. Mem0 finds interrupted adds
by deterministic metadata keys and removes duplicates. VoiceMem uses durable source
admission plus an engine-local provenance manifest. Corrections replace old index
revisions; forgotten/revoked/expired evidence removes derived sources and styles. Jobs
retry every second and on refresh/flush, including after restart (a hard-crashed lease
can delay retry for up to 120 seconds). Retired configurations are registered privately
without credentials and receive erasure-only reconciliation when a different local
engine/extractor configuration is opened. Physical cleanup failures remain pending;
ledger revalidation hides the data immediately. An index generation is acknowledged only after secure-delete, WAL truncation and VACUUM of owned SDK/manifest stores. Purge receipts remain `incomplete` with `memory_engine_cleanup_pending` until all registered active/retired stores acknowledge erasure. Private engine files live under
`MEMORY_PATH.engines/<hashed-user-scope>/<engine-configuration>/`.

## VoiceMem response-style safeguards

Only current user-conversation evidence authorized for **both extraction and embedding**
feeds VoiceMem styles. Files, imported messages, project/general entries and correction
records do not feed this pathway. Raw SDK facts from style extraction are never promoted
to ledger facts or factual recall. `heartnote` maps to host `experience`; traits require
at least three distinct surviving conversation sources. One turn, retries of one turn,
or a passing emotion cannot become a stable trait.

Emotion/trait context has a fixed maximum ten-minute lifetime from its earliest evidence,
not from query time. A content-free expiry deadline makes the outbox dirty even without new ledger traffic, so expired engine sources are removed on the next retry tick. This intentionally requires repeated evidence within the short
window; it is not durable personality inference. Context travels only through a host-configured `supportsResponseStyle` internal
`contextHits` channel, independently of the factual engine, never serialized factual/tool results.
Arbitrary results from resources without that capability cannot enable style injection. Every consume rechecks ledger
source authorization, authority fencing, sensitivity and expiry before rendering escaped,
bounded `<response_style_hint ttl_turns="3">`. This is advisory response style, not action
authority or a three-turn cache. Current user instructions always win.

## Evidence and remaining quality gate

`memory-production-engines.test.ts` runs the same paired behavior through production
ledger/mem0/VoiceMem resources, actual SDK APIs and deterministic provider HTTP fixtures:
standing preference vs one-turn request; emotion vs repeated trait; canonical hydration;
correction; forget; restart; consent revoke; destination and user isolation; abort;
provider failure and durable backfill. `memory-engine-composition.test.ts` additionally exercises env-plan-to-`composeRealtime` feeding with only transport endpoints redirected to HTTP fixtures.
`memory-engine-outbox.test.ts` checks transactional enqueue, leases, stale acknowledgements and retirement. `memory-engine-purge.test.ts` verifies sentinel-byte erasure across owned SDK/manifest/WAL files, blocked erasure receipts, retirement and reactivation. `memory-engine-fencing.test.ts` covers processing revocation while SDK cleanup is blocked and safe real-config startup metadata; `memory-engine-expiry.test.ts` checks idle expiry deadlines. Existing authority-race tests remain separate adversarial-port tests.

Fixtures prove integration and policy, not the quality of unconstrained provider output.
Paired real-provider replies and spoken-device evaluation still require review before
any default enablement. Check tone improvement without diagnoses, invented user facts,
or enduring personality claims. Record only aggregate outcomes; never log source text,
queries, credentials, endpoint URLs or consumer fingerprints. See `prerecall-latency.md`
for the distinct scripted-ASR real-provider measurement; it is not a spoken-device result.


## Prior immutable real-provider smoke (2026-11-03)

The parent ran actual `loadSettings → resolveMemoryComposition → buildAssembly →
composeRealtime` with synthetic data, real DashScope `text-embedding-v4` and `qwen-plus`,
and `MEMORY_EXTRACTORS=ledger,voicemem`. Realtime transport was stubbed. Both ledger+mem0
and ledger+VoiceMem passed eight checks: config/open; ledger extraction and SDK feeding;
canonical hydration; receiving-consumer allow/deny; general/project isolation;
versioned correction propagation; physical SDK/manifest/WAL sentinel erasure before
complete purge acknowledgement; and forgetting.

| Factual engine | Admission → indexed ms | Three warm recall samples ms |
| --- | --- | --- |
| mem0 | 13976 | 591 / 507 / 630 |
| VoiceMem | 14774 | 580 / 469 / 371 |

These are only three samples, **not** percentiles or voice-prerecall latency. Styles-enabled
queries can perform additional provider retrieval. Private local artifacts are
`live-composed-mem0.json`, `live-composed-voicemem.json` and `live-composed-engine.mjs`.
The run used immutable `engines-expiry-final-n9iorb` output, before the subsequent
retry/expiry/style review fixes. It does not validate those fixes, nor prove mixed-style
consumption or 30 spoken turns. New deterministic real-SDK regressions separately cover
503/revoke, in-flight expiry, and mixed-engine prerecall consumption. The new retry-disabled
embedding integration has HTTP-fixture evidence; no new live-provider verification is
claimed here.
