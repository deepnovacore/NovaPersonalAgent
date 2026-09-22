# Modular memory live acceptance / 分模块记忆验收

Each target runs independently with a fresh synthetic data directory. The existing live runner serializes the selected targets; it does not build the runtime. Build once before a batch and do not rebuild or run other `runtime/dist` consumers concurrently. None of these modules opens the user's memory, Life, connector or Electron profile.

| Target | Real components | Checks | Does not establish |
|---|---|---|---|
| `memory-storage` | SQLite worker, Markdown/Git, Life migration | Manual edits, stable revisions, restart, index rebuild, publication recovery, read-only legacy input | Model quality or client behavior |
| `memory-purge` | Host command, memory resource, Knowledge index, registered synthetic backups | Precise deletion, retry after missing backup, no index resurrection, Git objects and SQLite bytes, preservation of other objects | Arbitrary external copies or forensic disk erasure |
| `memory-daily` | Configured model and memory resource | Explicit synthetic seed → derived summary, references, once per day, correction invalidation | Extraction quality, timer behavior during OS sleep |
| `memory-reading` | Configured model, unified retrieval and memory projections | Grounded answers, text/voice context budgets, correction/new resource session, recipient/revocation gates | Conversation transport or actual audio |
| `memory-architecture` | Configured model and complete resource lifecycle | “我不吃辣” → paraphrase NOOP → temporary update → correction → restart → daily summary | Broad human-labelled semantic quality |
| `memory-desktop` | Actual isolated Electron renderer, host, resource, SQLite/Markdown/Git | Display, correction, new conversation, host reopen/renderer reload, delete confirmation, screenshots | Model-generated conversation, microphone/speaker, packaged installation |

The model targets send only synthetic fixtures to the existing configured model. Daily and reading targets seed explicit fixtures through the real merge operation and label that provenance. Runtime-only and desktop targets fail if an unexpected model call occurs. Desktop acceptance runs the source renderer in an isolated Electron window; it does not replace installed-app acceptance.

## Run from the repository root

```sh
npm run build --workspace @nova-audio-agent/runtime
node runtime/scripts/live-smoke.mjs --list
node runtime/scripts/live-smoke.mjs --target=memory-storage,memory-purge --output=/tmp/nova-memory-local.json
node runtime/scripts/live-smoke.mjs --env-file=.env --target=memory-daily,memory-reading,memory-architecture --output=/tmp/nova-memory-model.json
node runtime/scripts/live-smoke.mjs --target=memory-desktop --output=/tmp/nova-memory-desktop.json
```

Repeat only the failed target, or add `--repeat=2` for repeated fresh-data runs. Existing `--provider` and `--model` overrides remain specific to `text-tools`; configure memory modules through the normal runtime environment. The `text-tools` fixture also includes `memory-evidence` to verify the current source-reading tool schema separately.

## Evidence contract

The parent JSON records selected modules, repeats, Git HEAD/dirty state, harness hash and a hash of the compiled runtime JavaScript. Every structured module must provide its matching ID, completed status, checks, coverage and synthetic-data declaration. Exit code zero without valid completed evidence is a failure. A missing model credential is blocked, not passed. Interrupted runs retain checkpoints but cannot be accepted. Child stdout/stderr, environment values and credentials are not copied into the parent report.

Each module writes a private JSON artifact next to the parent report (`<output>.<target>-<repeat>.json`); Electron also writes screenshots. Temporary synthetic ledgers remain at the artifact's recorded location for inspection. Model module artifacts retain synthetic inputs/outputs and timings. Source-script checks: `node --test runtime/scripts/live/contract.test.mjs` (after the runtime build).

## Current results / 当前结果

2026-09-21, main worktree `v0.3.0dev`, uncommitted changes present. All six modules have passing live evidence. These local `/tmp` artifacts are inspectable run evidence, not durable release assets.

| Modules | Result | Parent report |
|---|---|---|
| Storage, purge | Both passed; real local persistence and synthetic migration backups | `/tmp/nova-memory-modular-local.json` |
| Daily, architecture | Passed with the configured real model; architecture covers all six lifecycle assertions | `/tmp/nova-memory-modular-model.json` |
| Reading | Two fresh-data repeats passed with the configured real model | `/tmp/nova-memory-modular-reading-rerun.json` |
| Desktop | Two fresh Electron profiles passed; separate reports and screenshots for each repeat | `/tmp/nova-memory-modular-desktop-final.json` |

The first model batch correctly remains **not accepted**: its reading target returned a version-qualified reference where the harness requested a canonical entry ID. The acceptance prompt now explicitly distinguishes those fields and its schema enumerates the actual entry IDs; production behavior and state assertions were unchanged. Both subsequent reading runs passed. The first desktop run timed out before Electron became ready because of the harness's top-level asynchronous initialization; moving initialization into `main()` fixed startup. Its failed report remains at `/tmp/nova-memory-modular-desktop.json`. Subsequent runs exercised real renderer actions, correction, a new conversation, host reopen/renderer reload and permanent deletion, with zero model calls. The reopened screenshot was also visually inspected.

The runner and project-report contracts passed 13 checks, including blocked credentials, stale reports and rejection of exit-zero runs without completed evidence. Script syntax checks and `git diff --check` passed. This script-only follow-up reused the previously built runtime; it did not rerun or replace the full runtime regression recorded in [the implementation record](MEMORY-ARCHITECTURE-IMPLEMENTATION.md).

The broader v0.3 continuation task owns features and acceptance outside this memory slice; JEV human-labelled quality, real accounts, physical voice, cross-platform installed clients and publication remain separate gates. No real user data was migrated or deleted, and no source commit, push or release was performed.

## Continuation Life and directory acceptance (2026-09-21)

The same catalog now exposes `life-objects`, `life-desktop`, `personal-understanding` and `directory-snapshot`. Build once before running them; serialize builds and all `runtime/dist` consumers.

```sh
node runtime/scripts/live-smoke.mjs --target=life-objects,life-desktop --output=/tmp/nova-life-local.json
node runtime/scripts/live-smoke.mjs --env-file=.env --target=personal-understanding --output=/tmp/nova-life-model.json
node runtime/scripts/live-smoke.mjs --target=directory-snapshot --output=/tmp/nova-directory.json
```

- `life-objects`: real temporary host/SQLite/Markdown, typed recall and canonical evidence, reminder invalidation, completion/cancellation, news conversion/hash validation, durable deduplication and restart. No external model.
- `life-desktop`: visible isolated source Electron renderer; news preview/save, public provenance, native date/status controls and restart. Synthetic seed and stub conversation acknowledgement; no generated conversation or physical audio.
- `personal-understanding`: real configured extraction/resolution model plus JEV, seven synthetic user turns with a fixed Asia/Shanghai date anchor, temporary Substrate persistence and restart. It preserves actual model failures; this is not a human-labelled quality benchmark or a generated conversational response test.
- `directory-snapshot`: reads only local repository docs metadata, then rebuilds anonymous topology with synthetic bodies. Real directory scanning and Knowledge Worker, deterministic local embeddings, no network. Runs 1/10/100/up-to-500 eligible files, mutation/deletion/restart and depth/byte bounds. The current Knowledge store has a **hard 100-source total limit**. The observed 276-file run fails at this limit; do not interpret the module as accepting larger corpora.

Continuation evidence and remaining boundaries: [CONTINUATION-IMPLEMENTATION.md](CONTINUATION-IMPLEMENTATION.md). Earlier artifacts remain separate from current executions.

## Integrated source-client workflow

`system-life` closes the gap between the separate renderer-only and model-only targets. It runs the visible production renderer, authenticated desktop WebSocket, production conversation runtime, actual Qwen / Understanding / JEV, durable Life and message state, UI correction/completion, and recall after an independent Electron process restart. Only synthetic data is used. The fixture explicitly selects the configured Qwen text model without changing saved settings; DashScope and OpenRouter credentials are required. It checks real tool calls/results, date precision and reply-to persistence. Lexical fallback is allowed and remains visible as `degraded` in tool evidence.

```sh
node runtime/scripts/live-smoke.mjs --env-file=.env --target=system-life --repeat=2 --output=/tmp/nova-system-life.json
```

This is the highest local source-client layer of the bottom-up sequence, not an installed-release, real-account or physical-audio acceptance. See [the continuation record](CONTINUATION-IMPLEMENTATION.md) for failed runs, fixes and current results.
