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
- Providers must implement compatible embedding and chat-completion APIs.
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
entries remain readable through explicit authorized recall with canonical `memory_scope=general`
metadata, but are excluded from automatic user-only recall and SDK/style admission. Engine selection preserves the actual
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


## Explicit reads versus automatic user projection

Low-level `recall()` defaults to explicit/all authorized memory scopes, preserving the
legacy ledger and Workbench contract. The internal host-only `userOnly` option is set
by `retrievalPrerecall`; it is not an environment setting, model tool argument or UI
picker. Native ledger search filters this projection before ranking. SDK indexes stay
user-only; explicit SDK recall intentionally combines their user candidates with an
authorized general-only local lexical ledger search under one combined limit. SDK
failure is not replaced by a successful ledger-user search; degraded/error state remains.

Canonical `memory_scope` travels through MemoryEntry, recall hits and Unified entries.
Ledger-owned missing legacy scope retains its historical recall eligibility; unknown
provider scope is never defaulted to user. Automatic Unified retrieval and consumption
require a current canonical user scope, even if a backend ignores the host filter.
Unscoped standalone raw/source channels are not consulted for this automatic user
projection; personal snippets must link to retained canonical user entries.
The host-wired knowledge index is a separate `knowledge_reference` channel, not a
user-fact or general-memory escape hatch. Only its canonical file evidence can
become low-trust reference snippets, with the actual receiving consumer authorized
at retrieval and consume. Cached references also recheck source kind, locator,
time, text, deletion and retention; changed evidence is dropped without querying
again. Arbitrary raw hooks do not receive this host capability. Explicit raw/source
retrieval remains available under its canonical authorization checks. Remote transport without canonical scope
support rejects user-only recall rather than silently mixing sources.

USER.md, reply preferences and existing voice/user-background projection filters are
unchanged. General memories can still appear in the explicitly separate text Memory
directory. `memory-recall-projection.test.ts` covers legacy/default and selected SDK
reads, scope labels, single limits, user-only prerecall/live revalidation, unknown or
ignored scope filters, consent/forget, and SDK failure without fallback.

## Versioned SDK-owned grounded reply preferences (local patch)

The production composition stages a private patched copy of `voicemem@0.0.1`.
The registry dependency stays pristine: no installation or global module is patched.
Repository-owned `runtime/sdk-patches/voicemem-0.0.1` contains the complete installed
file SHA256 preimage manifest, exact unique patch hunks, the added SDK grounding module,
and provenance notice. `prepare-voicemem-sdk.mjs` rejects changed versions, changed or
additional package files, nonunique hunks, existing output, dependency-tree output and
symlink ancestors before staging. Upstream Apache-2.0 LICENSE/NOTICE and the modification
notice accompany the generated SDK. This is a local modification, not an upstream release.

Runtime `postbuild` and `test-isolated.mjs` invoke the same staging operation into
`dist/src/memory/voicemem-sdk`; the production worker loads that path and checks the
semantic protocol export. Missing or mismatched output fails closed, without falling
back to unpatched extraction. Runtime packages include `dist/src`; server staging copies
its JavaScript and notices, and desktop packaging explicitly retains those notices.
The direct-TypeScript Space builder also stages a freshly integrity-checked SDK outside
`node_modules`, then copies it into only that run's owned runtime output. Same-run
incremental builds replace the generated SDK subtree rather than retaining stale files;
the dependency-tree preparation guard is not weakened. A focused fixture built twice,
checked stale-file removal/notices and loaded the resulting SDK over HTTP fixtures.
The optional isolated-runner `--temp-root` keeps targeted test scratch under the caller's
owned root; its default short socket-compatible temporary root is unchanged.

Protocol `voicemem-0.0.1/grounded-reply-preferences-v1` replaces untrusted model/reaction
traits **inside the SDK before embedding or attachment**. The grammar consumes the whole
user text, not merely a matching quotation. English first-person standing assertions use
`always`, `consistently` or `generally` plus `prefer`, known adjectives and
`answers`/`replies`/`responses`. Chinese assertions require a first-person standing marker
and preference verb, known adjectives and an answer/reply noun. A narrowly specified
long-term-preference suffix is optional. Known terms cover only brief/detailed length
and direct/indirect delivery; conjunctions or concatenated Chinese adjectives may combine
these dimensions. Different supported surface wording shares canonical dimension/value
keys, never a similarity threshold. Canonical labels do not introduce answer ordering,
language, format, identity or factual preferences. No probe-specific text or hash is used.

Unknown adjectives, surrounding prose, conditional/ambiguous wording, third-party or
quoted/assistant statements, repeated one-off instructions, passing emotion and factual
preferences do not establish standing reply style. Other freeform traits are deliberately
withheld, even if a model supplies a matching quote, slot or `reply_preference` flag.
Malformed extraction cannot commit a trait. Supported explicit first-person denials are
stored only as structured contrary evidence: they are never delivered as standing hints.
This is a conservative closed bilingual slice, not general linguistic entailment; unsupported
paraphrases or compound negative constructions can be rejected rather than inferred.

Each admitted SDK evidence snapshot retains its protocol, dimension, value, polarity
and source support span. Canonical attachments preserve each source's snapshot; search
revalidates claims against surviving SDK sources. Before ranking, candidate truncation
or support-floor filtering, any supported contrary value or explicit denial withholds
the entire dimension. An opposite source below three therefore cannot let an older hint
escape. Unaffected dimensions may remain eligible. The host still requires three distinct
surviving conversation source identities and fixes expiry at earliest evidence plus ten
minutes. Retries are not independent sources. Pending source reconciliation withholds
styles because it might contain a new unindexed contradiction. SDK facts from this slice
remain nonauthoritative: only bounded derived `contextHits` carry style, while canonical
facts remain ledger-owned. Existing per-request processing checks, abort bounds, receiving
consumer authorization, physical erasure and SDK log suppression remain in place.

A prefetched style projection also retains the authority/inventory revision captured at
its original recall. Revalidation carries that origin forward rather than resetting it.
Style preparation checks before/after asynchronous source authorization, and the final
render closure checks again; current authorization reads discover other-client epoch
changes. New contrary evidence therefore invalidates an older cached style even when
its original supporting sources remain authorized. Independently canonical facts are
revalidated separately. Focused production fixtures and a separate reproduction verified
this cache boundary without another consume-time embedding/model request.

The semantic protocol participates in engine configuration identity. Existing registration,
retirement, erasure and backfill reconcile the previous key separately rather than silently
reusing learned sources/manifests. Old stores receive erasure-only reconciliation; currently
authorized live sources are reprocessed into the new store. Revoke, expiry and forgetting
withdraw support; restart cannot reinstate erased or unsupported old claims. No automatic
human `correct()` receipt or additional ledger write is introduced.

Deterministic real-SDK/HTTP-fixture checks cover the unchanged three-source positive,
withholding at one/two, grounded equivalent wording, per-source snapshots, retries,
opposite and explicit-denial suppression, repeated negative controls, malformed model
outputs, temporary emotion, old-store retirement/backfill, revoke/expiry/forget and
restart. Existing paired functional, authority, physical-purge and style-consumption
regressions also passed in isolated output. These fixtures are not real-provider quality
acceptance. The reviewed patch/packaging/cache changes subsequently received the bounded
live verification described below; that record is not a blanket GUI, device or lifecycle
acceptance and does not overwrite earlier failures.

## Preserved real-provider history and final functional results

Three historical trait-quality runs remain failed and retained. The original standing
positive fragmented across supports, including an unsupported answer-order label. Its
measured inter-label cosine was approximately 0.38775: lowering the threshold would mix
different dimensions, not establish entailment. One additional predeclared six-ingest
prompt-constraint experiment also failed the original three-source case (two-plus-one
fragmentation) and misclassified its one-off control. Fourth-source support did not
retroactively pass the original case. That failed prompt is not shipped by this repair;
neither language changes nor threshold lowering are treated as evidence of a fix.

Separate final production-composition verification before this SDK change passed all
11 functional checks for **each** factual engine with VoiceMem styles. These exercised
actual configured composition, ledger extraction/SDK indexing, canonical hydration,
consumer allow/deny, temporary-emotion extraction and prerecall consumption, forget
invalidation, explicit-general versus automatic-user projection, versioned correction,
physical SDK/manifest/WAL erasure and forgetting. Both reports explicitly remain
`status=partial`, `functional_status=passed`,
`trait_quality_status=failed_in_preserved_trials`; trait sampling was not retried.

| Factual engine | Admission → indexed ms | Three recall samples ms |
| --- | --- | --- |
| mem0 | 15117 | 809 / 676 / 665 |
| VoiceMem | 12626 | 489 / 409 / 463 |

These are three samples only, not percentiles, not spoken-device validation and not
post-patch trait-quality acceptance. Prior failed runs and the failed prompt experiment
remain evidence; the new deterministic protocol checks do not overwrite their outcome.

## Delivery evidence update: bounded post-patch live results

Delivery integration targets `integrate/memory-backends-20261103`; no unknown future
commit or published-package behavior is implied. The Chinese usage and rollback guide
is [记忆后端交付与使用](../zh-CN/memory-backends-delivery.md).

Evidence groups have different code vintages and overlap. The 297/297 integration group
predates the structured SDK patch. The subsequent real-SDK lifecycle/grounding,
integrity-packaging, Space-output and cached-conflict checks are targeted groups, not a
new full-repository total; they must not be mechanically summed. The two eleven-check
functional reports above also predate the patch and retain their original partial status.
No new complete Flutter, GUI or device acceptance is claimed.

### First post-patch fixed-eight attempt (v1)

The first predeclared attempt recorded four ingest attempts and only three completed
negative-control observations. Those repeated one-off controls produced neither SDK
traits nor canonical user facts/preferences. It stopped operationally before observing
the first original-positive outcome. The recorded error class was generic Error; no safe
error label/subphase was retained, and the synthetic state was deleted by the harness.
Its actual root cause remains unknown. A single controlled fixture later observed stale
outbox-ticket invalidation and same-source recovery, but its top-level flush fulfilled:
the fixture's expected-rejection assertion failed and did not reproduce the live error.
Neither record is relabeled as a successful original-positive test or a proven SDK bug.

### Second, separately authorized fixed-eight attempt (v2)

This used production mem0 recall plus VoiceMem styles with the same real `qwen-plus`
and `text-embedding-v4` models, a fresh synthetic corpus and stubbed realtime transport.
All eight admissions were attempted and acknowledged exactly once. Elapsed time was
approximately 88.8 seconds with ten explicit flush calls; internal same-source durable
retries were allowed and this count is not an HTTP-request cap.

Observed core checks passed:

- Three repeated one-off sources produced no SDK traits and no canonical user
  facts/preferences.
- The unchanged standing positive exposed no trait at one/two sources; at three,
  grounded length/directness each had exactly three supports and no invented ordering.
- The supported paraphrase attached to those same dimensions, each with four supports.
- An opposite length preference suppressed that dimension; directness retained four
  supports. Actual prerecall consumed the positive style, while the older prefetched
  brevity hint was withheld after the contradiction.

**The immutable v2 result remains `quality_failed`.** Execution stopped at the harness
assertion `revocation_changed`: the script compared the return from
[`setProcessingConsent`](../../runtime/src/memory-substrate/resource.ts) to true, but the
public method is `Promise<void>` and deliberately discards the private helper's boolean.
This is a harness contract error, not evidence that the SDK's trait semantics failed.
Read-only inspection of retained state confirmed source-one grant revision 2, denied
extraction/embedding authorization and an empty conversation-recipient grant list.

The failed assertion prevented observation of the subsequent real post-revocation style,
forget and restart checks. Those missing live observations are not marked passed;
existing deterministic real-SDK lifecycle checks remain valid separate evidence. No old
source was restamped, no TTL was extended and no corpus was replayed to turn the report
green. An additional private lifecycle-probe draft was stopped without execution when
work narrowed to documentation delivery. All failed trial/report history remains intact.

### Remaining acceptance boundaries

There is still no 30-turn spoken-device or representative latency acceptance. The earlier
three-sample timings are not percentiles. Standalone-mobile save/new-session and
restart/forget behavior, Space-to-Client non-merge behavior, iOS background/cancellation
and backup/file-protection effects still require device verification. Host Swift mock
checks are not iOS-device evidence. First upgrade may interrupt unfinished uploads that
lack the new persistent authority without deleting saved chats, memory or workspaces;
future-backup exclusion cannot erase historical backups or exported copies.
