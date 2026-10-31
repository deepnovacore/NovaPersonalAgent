# Timeline / Profile 双端对齐：PC 增量缓存 + 移动端移除预算上限

Date: 2026-10-31
Worktree: `fix/timeline-profile-parity`
Branch: `fix/timeline-profile-parity`
Base: `v1.0.0dev` @ `62a3fa73`
Status: **未合入、未 push**；主 checkout 未改动。

## TL;DR

两处双端差异修复：

1. **PC（runtime）新增 Timeline 增量缓存 + Phase 2 P0 增量读取**：
   - 持久化 screening 主题索引（正/负两向）+ 阶段结果缓存（select / reconcile / batch），失败恢复、重复 tick、增量新消息不再为没变化的输入重复付费；
   - **所有刷新（含手动 `force`）都是缓存优先**：手动刷新只绕过 brief 的 checkpoint 提前返回，不再绕过缓存；
   - 没有新证据的主题整题跳过（不重写旧卡）；有新证据的主题只送「全部新消息 + 旧证据锚点」，并加两条宿主规则：修订必须引用新原文（R1）、唯一重叠旧卡可补稳定身份（R2）。
2. **移动端删除 Profile 预算硬上限**：`ProfileBudget` 退化为「验收专用记账」，保留 reserve/settle 与保守花费显示，删除 `profile_budget_exhausted` 抛出处、额度暂停/恢复/升级状态机与相关 dart-define；旧安装的 `profile_budget_exhausted` terminal 状态在启动时一次性自愈。

## 1. PC 增量缓存（runtime）

### 文件与结构

- 新增 [`runtime/src/personal-agent/timeline-cache.ts`](../../runtime/src/personal-agent/timeline-cache.ts)：`TimelineCache`（`BoundedJsonStore`，0600/原子 rename/4MB）+ `TimelineCachePort` / `TimelineCacheRun` / `TimelineRunOptions`。
- 缓存文件：`<personal path>.timeline-cache.json`（与 `.timeline.json` 同目录；space 模式跟随 `spaceConfig.personal_path`）。
- 文档结构：`{version:1, topics:[{scope,title,at,members:[{id,version}]}], screened:[{scope,id,version,at}], stages:[{key,kind:'select'|'reconcile'|'batch',at,payload}]}`。
- 限制：`topics`/`screened` TTL 72h、`MAX_TOPICS=256`、`MAX_SCREENED=4096`；`stages` TTL 24h、`MAX_STAGES=128`；写盘前按字节淘汰（≤3MB），仍超限则跳过写。

### 行为

| 场景 | 行为 |
| --- | --- |
| 输入池未变（重复 tick / 失败恢复） | topics 全部复用 → 不调用筛选；reconcile/compose/review 命中阶段缓存 → 0 次模型调用 |
| 新增 N 条消息 | 只有这 N 条进入 `selectTimelineTopics`（复用主题标题作为只读 `existing_topics` hints）；旧主题在 reconcile 后按「是否含新证据」分成 dirty / clean |
| 无新证据的主题（clean） | 整题跳过写作，旧卡保留（`cache_skipped_topics` 计数） |
| 有新证据的主题（dirty） | 新消息全量 + 旧证据锚点（旧卡 evidence_ids / 主题首条 / 状态词消息 / 新消息前 6 条），预算 `max(8k, 0.5×新消息字符)`，被裁剪时 `history_complete=false` |
| 修订旧卡 | 必须引用 ≥1 条新原文，否则丢弃本次修订（`host_dropped.unsupported_revision`）；模型漏填 `prior_id` 但只有一张旧卡与其 refs 重叠时，宿主补稳定身份 |
| 成员 version 变化 | 整个主题失效，其存活成员按新增输入重筛 |
| 成员从池中消失（滑出时间窗/撤权） | 只删该成员，主题保留其余成员 |
| 被筛掉的输入（负向索引） | 同 id+version 不再重筛，直到 72h TTL 或 version 变化 |
| `force=true`（手动刷新） | 绕过全部缓存读，只写；用于「刷新必须重算」 |
| 小池直通（≤200 条 / ≤60k 字符） | 不写主题索引（模型本来就没参与），避免直通结果被误复用 |

阶段缓存 key = `sha256('timeline-stage-v1'|<kind>|<model>|<system>|<attempt-0 prompt>)`；命中后仍走完整 schema/引用/quote/time/敏感内容校验，不通过即视为 miss 并删除条目；repair 成功的输出写回 attempt-0 key。batch 缓存以「compose+review 一个整体」为单位，payload 为该批复核后的 cards + 该批 `diagnostics.stages`。

### Phase 2 P0/P1（同分支追加）

- 新增 [`runtime/src/model/timeline-anchors.ts`](../../runtime/src/model/timeline-anchors.ts)：`withTimelineAnchors()` 纯函数，按「旧卡 evidence_ids → 主题首条 → 状态词消息 → 新消息前 6 条」挑旧证据，新消息永不裁剪，超预算只丢可选锚点并置 `history_complete=false`。
- `personal-writer.ts`：reconcile 之后按 `new_input_ids` 把主题分成 dirty / clean；clean 直接跳过；dirty 先裁锚点再打包写作批。`cache_skipped_topics` 进入 diagnostics。
- `timeline-selection.ts`：有持久索引时关闭小池直通（`screen:true`），让新增输入也进索引；`timelineCompositionBatches` 保留锚点裁剪带来的 `history_complete=false`。
- `timeline-brief.ts`：`prior_cards` 增加 `evidence_ids`（旧卡 refs，≤16/卡）；发布前加 R1（修订须引用新原文）与 R2（唯一重叠旧卡补 `prior_id`）。
- `timeline-anchors.ts` 追加 **重复告警折叠**：同 `group` + 归一化正文相同的告警只送最新一条，`repeat_count` 随批次走；没有 group 的消息不折叠（避免两条无关同文被合并）。
- `personal-writer.ts` 追加 **R3 stale-state 护栏**：修订卡若没引用带状态词（取消/完成/恢复/失败/上线…）的新消息，先发一次 `compose.repair` 要求补引；修复仍不达标就丢弃该修订卡（旧卡保留），并记 `stale_state_repairs` / `stale_state_dropped`。
- Profile **观察采样配额**：`source-processing.ts` 抽出 `profileLaneOrder()`，每条 lane 的**最新 25% 观察优先**，其余维持全历史均匀抽样，避免新信息被均匀抽样挤掉。
- **双端**：Dart 侧本轮未改，Anchor/R1-R3 与折叠的 Dart parity 需要单独分支 + 真机验收（parity 文档要求同模型同输入对照）。

### 生命周期与隐私

- `host.ts`：`TimelineCache` 在构造期创建、`#open()` 打开（读失败 fail-open）、`#close()` flush。
- 清空时机：`memory.purge`、`sources.delete/pause/disconnect/consent`、authorize 失败、access scope 变化。
- **不**在 `sourceChanged` 清空（否则每天的新消息同步会让增量失效）。
- `clear()` 递增 epoch：清空后旧 run 的迟到写入被丢弃，避免撤权后缓存被重新填回。
- `stages` 含 quote 原文，TTL 24h；`topics` 只存标题与 id/version，不含原文。

### 诊断

`timelineDiagnosticsSchema` 新增默认 0 的 `cache_reused_topics` / `cache_reused_inputs` / `cache_screened_inputs` / `cache_stage_hits` / `cache_stage_misses`（进 `personal.state.timeline.diagnostics`，UI 未改）。

## 2. 移动端移除预算上限（Flutter）

- [`profile_budget.dart`](../../clients/flutter/lib/context/profile_budget.dart)：删 `capMicroyuan` / `limitMicroyuan` / `NOVA_PROFILE_BUDGET_LIMIT_MICROYUAN` / `recoverExhaustedPause`；`reserve()` 不再抛 `profile_budget_exhausted`，保留 `requestCost()` 计费模型/请求形状校验与 `pending_reservations` 记账；`_read()` 去掉 `spent > cap` 判定。
- [`profile_agent.dart`](../../clients/flutter/lib/context/profile_agent.dart)：删额度升级相关 dart-define 与 `recoverBudgetPause`；`_budgetMetadata` 只留 `budget_id`；`inspectGeneration()` 一次性清除旧 receipt 的 `error_code=='profile_budget_exhausted'`（`unavailable`/`usage_*` 仍阻断，属记账完整性错误）；错误码白名单保留该码并注明 legacy-only。
- [`profile_generation_coordinator.dart`](../../clients/flutter/lib/context/profile_generation_coordinator.dart)：删 `recoverBudgetPause`/`budgetLimitMicroyuan` 与 budget 提前 blocked 分支；`_start()` 最前面幂等清理旧 `terminal_code=='profile_budget_exhausted'`（删 terminal/explicit-retry/`budget_*` 键，`retry_count=0`，保留 `manual_pause`）。
- UI：`app.dart` 的 `pauseAfterRound` 解耦为只读 `NOVA_PROFILE_PAUSE_AFTER_ROUND`（persistence key 仍带 budgetId 后缀不变）；`profile_generation_status.dart` / `feishu_direct_page.dart` 删「费用上限/额度用完」文案，预算行改为「已记账（保守估算）¥x / 非账单」。
- [`profile_acceptance_diagnostics.dart`](../../clients/flutter/lib/context/profile_acceptance_diagnostics.dart)：gate 只要求 `NOVA_PROFILE_ACCEPTANCE_DIAGNOSTICS`，`agent.budget` 空安全，去掉 `budget_cap_microyuan`。
- 测试：删除 `profile_budget_upgrade_test.dart`；重写 `profile_budget_test.dart`（超旧上限仍可 reserve、记账、usage 非法/超预留、ledger 不可读、模型白名单）；coordinator 测试改为 legacy 自愈用例；其余 fixture 同步。

## 3. 验证

### runtime（本 worktree，`runtime/dist` 仅本目录）

```
cd runtime && node scripts/clean-dist.mjs && ../node_modules/.bin/tsc -p tsconfig.json
node --test dist/test/timeline-*.test.js dist/test/model-adapters.test.js dist/test/timeline-host.test.js
node --test dist/test/*.test.js
../node_modules/.bin/tsc -p tsconfig.json --noEmit
```

### flutter

环境限制：沙箱不允许写 Flutter SDK 缓存（workspace 外），使用 APFS clonefile 把 SDK/pub cache 克隆到 `$TMPDIR` 后以 `PUB_CACHE` 指向克隆运行（不修改主 checkout，也不改 SDK 原件）：

```
export FLUTTER_SUPPRESS_ANALYTICS=true PUB_CACHE="$TMPDIR/pub-cache-dsh"
"$TMPDIR/flutter-sdk-dsh/bin/flutter" pub get --offline
"$TMPDIR/flutter-sdk-dsh/bin/flutter" analyze --no-pub
"$TMPDIR/flutter-sdk-dsh/bin/flutter" test --no-pub
```

结果见下方「验证记录」。

### 验证记录（本机，worktree 内）

runtime：

| 项目 | 结果 |
| --- | --- |
| `node scripts/clean-dist.mjs && tsc -p tsconfig.json` | ✅ 0 error |
| timeline / writer 定向（`timeline-*.test.js` + `model-adapters.test.js`，含新增 anchors / clean-skip / R1-R2 用例） | ✅ 150 passed |
| host + 邻近接线（`personal-agent*`、`reading-copies-host`、`daily-workbench`、`workbench-*`、`assembly`、`space-host*`、source-processing、scheduled、profile、lane-order 等） | ✅ 438 passed（含 P1 新增的折叠 / R3 / lane 配额用例） |
| 资料处理 / 调度 / 画像 / usage（`source-processing*`、`scheduled-*`、`profile-*`、`project-digests`、`usage-*`） | ✅ 141 passed |
| `tsc --noEmit` / `eslint src eval test` | ✅ 0 error |
| 全量 `node --test dist/test/*.test.js` | ⚠️ 未在本机跑完：全量并发时卡在与本次改动无关的重型集成用例（如 `task-dispatch` 单独跑 43 passed/21s，并发 390 文件时挂起），属本机沙箱资源/外部依赖限制；已用上面的定向批次覆盖受影响面 |

flutter（克隆 SDK + 独立 PUB_CACHE，见上）：

| 项目 | 结果 |
| --- | --- |
| `flutter analyze --no-pub` | ✅ No issues found |
| 受影响测试（budget/coordinator/status/diagnostics/feishu/first-retry/local-results/single-round/timeline pipeline） | ✅ 157 passed |
| 全量 `flutter test --no-pub`（实现者实跑） | 1264 passed / 5 skipped / 2 failed：均为 golden 截图像素差，已在 pristine HEAD 基线副本复现同样的 2 个失败，与本改动无关 |

## 4. 回滚

- PC 增量缓存：`host.ts` 不给 `TimelineBrief` 传 `{cache}`（或删掉这处入参）即回到「每次重新生成」的旧行为；缓存文件可安全删除，不影响已发布卡片。
- 移动端：本次是删除式改动，回滚即 revert 对应 commit；旧凭证/ledger 文件仍可读（新代码只读不写 cap 字段）。

## 5. 已知限制

- partial 失败恢复：`timeline-brief.ts` 在每次 progress 局部发布时就推进 checkpoint，`prior_cards`/`new_input_ids` 随之变化，因此 compose/review 的阶段缓存可能 miss（筛选/归并仍免费）。这是有意收窄的承诺，比改动前严格更好。
- 负向索引 72h：被筛掉的输入在 TTL 内不会重筛（version 变化或 `force` 除外），用于省 token 的代价是「误判延迟」。
- 移动端 golden 截图测试（`chat_screenshots_test` / `workbench_screenshots_test`）在本机环境因像素差恒失败，已用 `git archive HEAD` 基线复现同样失败，与本次改动无关。
- receipt 里其它 `profile_budget_*` 码（`unavailable`/`usage_*`）不会被 `retry()` 清除，属既有问题，本次未改。

## 6. 相关设计文档

- [`docs/plans/2026-10-31-incremental-evidence-weighting.md`](../plans/2026-10-31-incremental-evidence-weighting.md)：Phase 2「增量读取 + 新消息加权 + 旧新合并」设计（clean/dirty 主题、anchor 证据配额、R1–R3 宿主规则、Profile 侧增量），已完成两轮 opus-5-5 评审输入。
