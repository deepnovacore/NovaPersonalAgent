# Memory architecture implementation / 记忆架构实施记录

Development branch: `v0.3.0dev`. This record describes the implementation under test; it is not a release or a live-client acceptance report. The target contract remains [06](06-memory-substrate.md) and [07](07-memory-channels-and-interaction.md).

## Authority and writes

- A originals, source grants, deletion suppression, operation receipts and the file outbox remain in the existing SQLite ledger.
- B/C revisions live in an independent, local Git repository at `<ledger path>.memory`. It is not the source repository and has no configured remote. Each object has a stable ID, immutable revision metadata and an editable Markdown body. SQLite revision/vector and workspace projections can be rebuilt from these documents.
- Both extraction and accepted Understanding/Life changes enter the existing merge operation. Life JSON becomes read-only migration input once the backend is selected; a backend failure never falls back to writing JSON. Legacy imports retain their whole text, IDs, versions and receipts, and explicitly lack original quote evidence. Each imported object has separate migration evidence.
- Semantic extraction retrieves bounded, same-kind old entries, then resolves add/update/no-change. The model can choose only supplied IDs; the host owns versions, evidence and authorization. Every supplied context, including NOOP and unselected alternatives, is checked again in the worker transaction.
- Manual Markdown edits become `user_correction` evidence and revisions. The readable body and typed Life/workspace projections change together. Identity metadata is not a free-form edit surface. Conflicting or malformed files are preserved and reported, never reset to the last Git commit.

## Publication and recovery

All cooperating clients of one ledger use the same path lock, including clients that did not explicitly enable files. A SQLite transaction records revisions and a durable full-snapshot outbox. The repository then prepares an operation journal with file preimages, publishes owned files, makes a local Git commit, and removes the journal/outbox only after validation. Restart recovers only the matching operation and target snapshot. Unexpected edits stop recovery without overwriting them. Initial migration uses the same outbox protocol.

The lock is fail-fast. It does not steal a live process's lock. Confirmed dead owners can be recovered. Symlink roots, redirected Git common directories, edited machine history and unrecognized files are rejected. Raw admission and permission revocation remain usable when editable understanding documents need repair.

## Explicit facts, daily summaries and reading

Explicit profile/Life changes and corrections merge immediately. Daily consolidation writes only an inferred `memory_summary` containing a derived profile, a bounded one-page summary, generation day/time and the exact `id@revision` basis. It cannot modify stated facts or cite another summary as evidence. A changed, removed, expired or unauthorized basis invalidates the summary immediately; readers use current facts until the next successful scheduled run.

The initial defaults are configurable implementation choices: daily at 00:00 UTC, with one catch-up when the application is running after the scheduled hour. At most one successful consolidation per local day; failed work can retry on maintenance. Environment settings:

- `MEMORY_CONSOLIDATION_ENABLED=true`
- `MEMORY_CONSOLIDATION_HOUR=0` (0–23)
- `MEMORY_CONSOLIDATION_TIMEZONE=UTC` (IANA timezone)

Text sessions use a bounded directory and explicit recall/evidence tools. Optional text prefetch is disabled by default (`MEMORY_PRERECALL_ENABLED=false`). Realtime voice uses bounded facts/profile and the valid one-page summary, without automatic prerecall. Context is reference data, not authorization to act. The receiving conversation provider requires its own grant; extraction consent is not reused as consent for a different recipient. A send-time snapshot checks current revisions and grants, including edits or revocation from another client.

## Deletion boundaries

“Forget” retains revision/Git history and suppresses stale evidence. “Permanently delete” is a separate host command, never an LLM tool. The user confirmed that its scope includes selected content in the current ledger, Git history, and read-only migration backups. Cleanup preserves unrelated entries and reports `incomplete` when a backup cannot be verified or cleaned. A content-free receipt names removed object/evidence IDs so host feed and prepared-context copies are cleared, including after a retry. Pending cleanup remains visible after the selected row disappears. A temporary missing backup can be retried; unregistered or concurrently edited backups are not guessed or overwritten. No real user deletion is performed as part of development tests.

Known Knowledge index copies are part of the cleanup: linked chunks, vectors and FTS data are removed, and a persistent suppression prevents delayed reindexing from restoring them. The ledger retains an incomplete receipt until the index confirms cleanup. Missing index access is retryable and never reported as complete.

Completion covers this instance's ledger, managed indexes, user-data Git objects and registered migration backups. SQLite completion is recorded only after checkpoint/VACUUM succeeds; restart retries an interrupted compaction. It does not claim forensic disk erasure or discovery of arbitrary external copies. External source originals (for example, an imported file outside Nova) are not owned migration backups and are not deleted by this command. Clearing a connector's authorization is distinct from deleting retained history.

## 验收边界

以下均须分开记录，不能互相替代：

1. 自动化合成夹具：同 ID 改写去重、状态更新、立即纠正、重启；撤权与版本竞争；文件/迁移恢复；派生摘要不覆盖明确事实；删除可重试且不复活。
2. 真实模型合成数据：`runtime/scripts/live/memory-architecture.mjs` 保存实际模型输入输出、ID、版本、引用与耗时。该脚本使用临时新库，不读用户记忆。
3. 客户端 live：新会话、真实语音/文本切换、纠正、重启和来源授权测试账户。
4. 发布验收：本次未授权提交、推送或发布。

JEV remains replaceable. Deterministic contract tests are not a human-labelled quality assessment. mem0 remains outside the primary writer. Feishu identity binding and channel-specific access remain governed by the existing host/channel contract; this change grants no new bot, connector or execution permission.

## Validation in this worktree

- The real-model synthetic runner passed six assertions: initial admission with evidence, paraphrase NOOP, same-ID temporal update, correction protected against automatic key drift, restart retention, and a daily summary citing the current corrected revision. The first run exposed a resolver error: a paraphrase became an unnecessary revision. The resolver now sees bounded, already-authorized source context and distinguishes wording changes from factual/state/time changes; the unchanged fixture passed on rerun.
- Desktop memory/settings regression: 145 tests passed; desktop backend regression: 67 tests passed. Environment contract, shared capability drift and desktop wire-frame checks passed.
- All new deletion, migration and recovery tests use temporary synthetic stores. No real user migration or deletion was performed.
- Local Claude CLI review was attempted with a bounded public-source-only input, tools disabled and the requested model; it timed out without a review. Independent subagent review and executable regression evidence are recorded separately.
- Native GUI, physical/realtime voice latency, Feishu live delivery, human-labelled JEV quality and release validation have not been performed for this change. In particular, fresh authorized reads before audio send are covered by automated gates; their live latency still needs measurement.

- Final TypeScript build and full runtime ESLint passed. Final runtime suite: **2,793 passed, 8 skipped, 0 failed** (2,801 total; 119.9 seconds), including all new memory, migration, deletion, index and provider-recipient gates. Command: `cd runtime && node --test --test-concurrency=4 --test-timeout=300000 dist/test/*.test.js`.
- Final deletion/index/Life/host/retrieval focused run: **73 passed, 0 failed**. Desktop checks total **212 passed**, plus **2** wire-frame tests. `git diff --check`, environment contract and shared capability validation passed.
- Source checkout remains `v0.3.0dev` at `ad1c87a6`; implementation changes are uncommitted. Existing documentation, image and experiment files were preserved. No push, release or deployment was performed.

## Modular live follow-up

Independent runtime, real-model and isolated Electron modules are available through the existing live runner. See [module commands, evidence boundaries and results](MEMORY-LIVE-ACCEPTANCE.md).
