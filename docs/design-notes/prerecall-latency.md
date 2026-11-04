# Cascaded prerecall latency measurements

Status: real-provider scripted-ASR replay measured below; spoken-device measurements remain outstanding. `memory_prerecall_enabled` remains **false** by default. No new environment settings.

## Provisional policy

- Minimum partial: 6 characters; starts throttled to 300 ms with one trailing-edge timer.
- Retrieval work budget: 1500 ms, including final-only starts.
- Final consume/revalidation wait: 250 ms. If it expires, skip injection and abort the run; no retry or cross-turn cache.
- Identical final text reuses the speculative promise. Changed text replaces it.
- Voiceprint/Doubao configurations that hide partials start only at final (`source=final`).
- Integrated native audio is unchanged. Workbench voice keeps no model tools; its cascaded prerecall now uses the shared retrieval port.

## Reproducible stub run

Build via `runtime/scripts/test-isolated.mjs` into an internal-storage output root namespaced by canonical worktree and chat ID. Use the printed isolated directory, never clean shared `runtime/dist`:

```sh
node runtime/scripts/prerecall-latency.mjs --dist <isolated-root>/runtime/dist --delay-ms 100,250,800,2000 --runs 3
node --test runtime/scripts/prerecall-latency.test.mjs
```

Each run replays three scripts: eight partials 80 ms apart then final; one partial 1 s before an identical final; final only. Output rows contain `delay_ms`, `starts`, nearest-rank `p50_ms`/`p95_ms`, `injected_ratio`, `reused_ratio`. Percentiles include all completed work (including aborted/timeout runs), so use `outcome` when interpreting real-provider data. Reuse means a matching promise existed before final, not necessarily successful injection.

## Real-key measurement (user)

Enable prerecall for about 30 spoken turns. Record completed `{duration_ms,source,query_length,outcome}` and injected `{injected,source,reused,wait_ms,query_length}` events. Production embedding metadata is derived from configuration: `remote` for configured embedding credentials or remote memory, otherwise `none`. `local` is reserved for a future local embedding engine; hosts are not classified. Never record URLs, hosts, query text, or credentials. Stub runs use `embedding=none`.

| Embedding class | Partial visibility | Turns | Starts | p50 ms | p95 ms | Injected ratio | Reused ratio | Final wait p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| remote | visible / hidden | | | | | | | |
| local (only if installed) | visible / hidden | | | | | | | |

Record failure/outcome counts and final-only vs speculative breakdown here:

Decision after measurement: keep/change provisional budgets? Is a greeting skip warranted? Local embeddings and greeting classification are not implemented in this pass.


## 2026-11-03: real-provider scripted-ASR replay (not spoken-device validation)

Parent-run synthetic replay used the actual `CascadedRealtimeAdapter → retrievalPrerecall →
UnifiedRetrieval → standalone mem0 SDK` path, real DashScope `text-embedding-v4`, and
real `qwen-plus` extraction of synthetic seed data. ASR, response LLM and TTS were
stubbed. This is **not** 30 spoken/user-device turns or a ledger-engine measurement.
No source text, credentials or endpoint values are recorded here.

| Script | Turns | Starts | Completed p50 ms | Completed p95 ms | Injected | Reused | Final wait p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Overall | 30 | 50 | 154.96 | 220.99 | 29/30 | 20/30 | 191.14 |
| Visible partial | 10 | 10 | — | 220.99 | 10/10 | 10/10 | 1.61 |
| Burst partial | 10 | 30 | — | 214.49 | 10/10 | 10/10 | 1.43 |
| Final only | 10 | 10 | — | 250.82 | 9/10 | 0/10 | 250.72 |

Outcomes: 49 ok, 1 aborted (final-only deadline). Each injected turn was checked for
the actual response LLM stream request's `possible_memory` marker (10/10/9 by group).
The burst run confirms throttling; visible partials reuse completed work at final.
The final-only sample retains one bounded skip. Aggregate artifact: parent scratch
`live-prerecall-replay.json`; reproduction harness: sibling `.mjs` (private local
measurement artifacts, not publication inputs).

Decision: this synthetic sample does not justify tuning. Keep provisional 1500 ms
work / 250 ms final-consume budgets and prerecall disabled by default. No new greeting
skip, local embedding, or device-performance claim. Still required: real spoken-device
turns, production ledger-engine measurements, and paired real-provider style-quality
review before default enablement.
