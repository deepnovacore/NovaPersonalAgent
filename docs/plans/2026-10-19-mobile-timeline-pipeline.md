# Mobile Timeline: bounded requests, complete themes

## Problem and design

The mobile writer previously selected all validated observations in one request and applied a 120-original / 48,000-character budget to the entire final result. A broad topic could contain more originals than that budget, leaving no writable Timeline. Increasing the context window alone does not address this shape of failure.

The desktop implementation screens batches, reconciles a small topic index, and composes multiple bounded batches. The mobile pipeline adopts those boundaries while retaining complete observation text and complete original messages. It deliberately does not adopt transitive merging by shared references: shared background does not identify one event.

## Stages

1. Screen every validated observation once in deterministic batches of at most 80 observations, 16,000 JSON characters and 48,000 UTF-8 bytes. A single oversized observation fails visibly; no text is truncated. The input retains global indices and supplies the exact permitted set. Output is `topics: [{title, observation_indices}]`. Every index must be an integer belonging to this batch. Titles identify concrete independent deliveries and remain untrusted retrieval material.
2. Reconcile the candidates once using a small index of complete titles, all global member indices, date bounds, groups, relations and original counts. Output is `groups: [{members: [topic_id]}]`. Every candidate ID must occur exactly once. Only semantic identity of actor, object and delivery justifies joining early plans with later completion/cancellation. Shared sources do not trigger automatic merging.
3. Resolve every selected observation to all its original references. Pack complete logical themes into writing batches of at most 120 originals, 48,000 serialized characters and four themes. The limits apply to each request, not the whole Timeline. Optional smaller writing limits only change packing; they cannot split an original or assert a complete state from a fragment.
4. Each writing batch has a composition request and an independent review returning a complete corrected `timeline`. Both responses must pass the existing exact quote, cited original, single-topic reference, time, actor and display-quality validations. Profile and todo generation are excluded. Only reviewed, validated cumulative Timeline entries are eligible for incremental publication.

## Repair and deferral

Each stage permits at most one contract correction through the same completion callback, authorization checks and budget reservation path. Network, authorization, budget and context failures never become contract retries. The host must disable additional transport retries for these stages so two semantic attempts cannot multiply into more HTTP requests.

An oversized proposed theme triggers the same single correction allowance to separate genuinely independent deliveries. Refinement must preserve the originally selected observation set; it cannot silently delete indices to fit a capacity. If the theme still does not fit, it is retained as deferred rather than cut into misleading fragments. If every selected theme is deferred, `profile_timeline_deferred` stops before any paid composition. Smaller complete themes may still publish, with deferred work explicitly counted as pending.

Every full request, including correction material, must fit 128,000 characters and 220,000 UTF-8 bytes. A reconciliation index that exceeds this bound stops and retains completed screening checkpoints; hierarchical reconciliation is not silently substituted.

## Cache and host contract

`TimelinePipeline` requires `authorize`, a nonempty `cacheScope`, the model completion callback, and optional checkpoint/publication callbacks. The host scope must cover account, authorization/consent, authority, source fingerprints, model/protocol, corrections and result recipe. A stage cache key additionally hashes the pipeline recipe, scope, instructions and full stage input. The host owns encrypted local persistence and clears processing checkpoints on authorization/source changes. Published historical display is separate from these caches.

Only validated responses are stored. Reading a cache performs authorization before and after the read and revalidates every schema and, for writing, exact quotes against the current full originals. Cache hits do not bypass publication validation. Cancellation or budget exhaustion retains successful stages; resuming regenerates the same deterministic plan and requests only uncached stages. Composition cache entries are never published until independent review succeeds. The publication callback receives cumulative stable entries and is surrounded by authorization checks. Empty output never invokes publication; the host preserves earlier Timeline/Profile content.

`TimelinePipelineResult.totalBatches` includes deferred placeholders. `pendingBatches = totalBatches - completedBatches`; `partial` indicates pending output, while the host independently accounts for unobserved source history. `final_original_records` counts the union of complete originals examined in finished writing batches, not the number of cards or only their cited subset.

The host treats `profile_selection_invalid`, `profile_timeline_invalid`, `profile_timeline_checkpoint_invalid`, `profile_timeline_deferred` and `profile_context_too_large` as terminal for unchanged input. A new authorized input scope can create new work. It must not restart an already paid round merely because output remains partial or a theme is too large.

## Cost and verification

With 624 short observations, screening needs approximately eight requests; actual batches also obey serialized size. One reconciliation request follows, then two requests per writing batch. A valid cached stage requires no paid replay. Each stage can require one additional correction, so the budget owner must estimate and reserve per request and stop before exceeding the existing allowance. Smaller composition batches alone do not reduce a provider's maximum-output reservation.

Synthetic tests cover lossless 624-observation screening, 160 full originals across multiple writing batches, cross-batch plan/outcome reconciliation, cancellation after incremental publication and cache-only resume of completed stages, scope isolation, authorization changes during cache reads, corrupted cached quotes, exact candidate coverage, foreign batch indices, oversized-topic deferral without writing, refinement conservation, empty-output preservation, and non-contract errors without extra requests. No real user data or online model calls are needed for these tests.
