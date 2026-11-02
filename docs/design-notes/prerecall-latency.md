# Cascaded prerecall latency measurements

Status: measurement template; no real-provider measurements yet. `memory_prerecall_enabled` remains **false** by default. No new environment settings.

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
