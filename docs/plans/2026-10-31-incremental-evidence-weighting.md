# 增量读取、新消息加权与旧新合并（Timeline / Profile）

Date: 2026-10-31
Status: **设计草案（Phase 2）**，依赖同分支已落地的「增量筛选索引 + 阶段结果缓存」。
Base: `v1.0.0dev` @ `62a3fa73`
Worktree: `fix/timeline-profile-parity`

## 1. 问题

新增消息后，两端仍倾向于把「整个历史池」重新读一遍：

| 现状 | 浪费点 |
| --- | --- |
| `personal-writer.ts:100-109` 每次对**全部**写作批跑 compose+review | 没有新消息的主题也被重写一遍，付全量 token |
| `timeline-selection.ts:18` 小池（≤200 条 / ≤60k）直通单主题 | 主题级增量失效，且直通结果不可复用 |
| `timeline-brief.ts:146-147` 的 `prior_cards` 只带 `title/category/why_now/anchor_date` | 模型不知道旧卡依据哪些原文，无法只补新证据 |
| `timeline-brief.ts:170-176` 合并只按 card id 覆盖 | 新卡漏填 `prior_id` 时新旧两张卡并存，旧状态残留 |

目标：**新消息到达后只读增量**（Timeline 与 Profile 都要），并且当新消息与旧消息讲同一主题/同一事实时，**新消息权重更高**；旧新合并要有确定性规则，不能只靠 prompt 语气。

## 2. 概念模型

### 2.1 时间权重（tier）——宿主确定性派生，不持久化

在每次生成时按输入派生，不进 prompt 以外的任何状态：

- `new`：id 不在 `brief.checkpoint.input_versions` 里（对照 `timeline-brief.ts:144` 的 `checkpointVersions`）；
- `recent`：`observed_at` 距 `context.local_date` ≤ 3 天且不是 `new`；
- `background`：其余。

同时给每条输入一个 `seq`（按 `observed_at` 升序）。tier/seq 作为 compose 输入的**只读元数据**（`personal-writer.ts:123` 的 inputs 数组加字段），不改变任何校验。

### 2.2 主题状态：clean / dirty

- **dirty**：主题成员中含 ≥1 条 `new` 输入，或成员的 id/version 与本轮缓存不一致（版本变化已由 cache 规则整主题失效）。
- **clean**：主题全部成员 id+version 与 checkpoint 一致，且不在 `new_input_ids`。
- 主题粒度沿用已落地的 screening 索引（`timeline-cache.ts` 的 `topics`），**不额外持久化 reconcile 后的主题**：写作批是否 clean 由批内主题决定。
- 全量校准：dirty 主题占比 >50%，或距上次全量生成 >7 天，或 `PROMPT/RECIPE` 版本变化时，本轮忽略 clean 判定做一次全量（与 `timeline-brief.ts:133` 的 key 变更天然一致）。

### 2.3 证据锚点（anchor evidence）

dirty 主题送写作时不再送主题全部原文，改为「新消息全量 + 旧证据锚点」：

1. 旧卡 `evidence_basis` / `refs` 引用的原文（旧卡状态就是这些原文建立的，**必须送**）；
2. 主题第一条原文；
3. 第一条 `new` 消息之前最近的 6 条；
4. 含状态词的旧消息（取消/完成/延期/恢复/撤回/截止/上线/失败）；
5. 回复/转发链上的 root/parent。

配额：旧证据 ≤ `max(8k, 0.5 × 新消息字符数)`，超出部分只记 `omitted_count` 诊断；主题被切分时 `history_complete=false`（复用 `TimelineTopic.history_complete` 语义）。
同 group + 正文 hash 相同的重复告警只送最新一条并附 `repeat_count`。

**跨消息状态不漏**由锚点 1、4 保证；review 阶段继续逐字核对引文，不因「新消息优先」放宽。

## 3. 新消息加权的确定性实现

### 3.1 prompt 侧（已经存在，保留）

`personal-writer.ts:68` 的增量规则 + `new_input_ids`/`prior_cards` 已经要求「只就新输入涉及的事项写卡、修订必须回填 prior_id」。tier/seq 让模型能按新→旧顺序阅读。

### 3.2 宿主校验侧（新增，可单测）

在 `timeline-brief.ts:159-172` 的物化循环里增加三条规则：

- **R1（修订必须有新证据）**：带 `prior_id` 的卡必须引用 ≥1 条 `new` 输入；否则这次修订被拒绝（`host_dropped.unsupported_revision`），旧卡保留。防止「没有新证据就改写旧结论」。
- **R2（唯一旧卡时可补身份）**：dirty 主题只对应 1 张旧卡、而模型漏填 `prior_id` 时，宿主补上该卡 id；对应多张旧卡时不猜，保留双方并记 `ambiguous_supersede` 诊断。
- **R3（stale_state）**：主题里有带状态提示的 `new` 消息，但产出的卡没有引用它、且卡的 `last_reported_on` 早于该消息 → 触发一次修复重试；仍不过则不发布本次修订。

### 3.3 防「新消息自动获胜」

- 覆盖必须满足：新原文被**逐字 quote** 引用，且主体（`author`/`relation`）一致；
- `participant` 的新消息只能补充事实，不能改写用户本人状态（沿用 `PROFILE_GROUNDING` 的主体规则）；
- 同文重复不计为更新；
- 新旧主体不同的冲突：两条事实都保留，写入 `uncertainty`，交给 review 判定；
- 所有既有校验（quote/time/refs/敏感内容）在新规则下不放松。

## 4. 合并方案对比与 P0 选择

| 方案 | 成本 | 质量风险 | 实现量 |
| --- | --- | --- | --- |
| (a) prompt 层「新优先、旧作背景」 | 0 额外调用 | 不可测，漏 `prior_id` 会重复出卡 | 已有 |
| (b) 模型在 reconcile/screen 输出 `updates/supersedes` 边 | 少量 token | 边判错即误覆盖，需要额外校验 | 中 |
| (c) 确定性规则（tier/anchor/R1–R3）+ 冲突时复用 review | 几乎不增 token | 可单测；误覆盖被 R1/R3 拦住 | 中 |

**P0 采用 (c)**，保留 (a)；(b) 留到 P2 作为 `continues:<topic>` 主题身份稳定化。

## 5. Profile 侧的等价设计（P1）

已具备的增量基础：

- 观察按 refs 复用（`source-processing.ts:391-401`）；
- `profile_context` key 命中时直接 `unchanged` 跳过重写（`:380-388`）。

要补的：

1. **观察抽取保留新消息份额**：每条 lane（people/work/style）预留 25% 名额给 `at` 最新的观察，其余维持 spread 均匀抽样（`source-processing.ts:368-379`），避免新信息被均匀抽样挤掉。
2. **work 以最新状态为准**：work 观察按 `products.projects` 分组，同一项目取最新观察为当前状态，旧观察只作「此前」背景，避免同一项目多阶段并存。
3. **按区重写**：`about`（people+style）/`work`/`interests` 各算一个子 key，只重写变化的区，其余沿用已发布段落（发布层已支持部分沿用，`source-processing.ts:445-446`）。
4. **不做时间衰减的**：style、identity、`repeated_pattern` 需要 ≥2 条独立证据，单条新消息不能覆盖；只有 work 状态与本人明确改口的偏好适用「最新为准」；`user_correction` 始终最高优先。

## 6. 失败与边界

| 场景 | 处理 |
| --- | --- |
| 新消息其实是无关噪音 | 归入主题但未被引用 → R1 拒绝修订，旧卡不动 |
| 旧消息被撤回 | 卡转 historical（`timeline-brief.ts:97-101`）；主题 dirty 后用剩余证据重算 |
| 主题漂移（新旧成员重叠 <30%） | 新主题独立成批，不强制覆盖旧卡（R2 只在唯一旧卡时生效） |
| 单主题新消息 >60k | 走现有 `timelineBatches` 切片，`history_complete=false` |
| reconcile 索引 >80k | 回退全量筛选（`timeline-selection.ts:80` 现有失败路径） |
| 跨天 TTL / 窗口滚动 | 主题成员全部滑出 14 天窗口即退役；dirty 占比 >50% 或 >7 天做一次全量校准 |
| 双端 parity | tier 派生、anchor 抽样、R1–R3 写成纯函数，同一份 JSON fixture 同时测 TS 与 Dart |

## 7. 分阶段与验收

| 阶段 | 内容 | 验收（可测） |
| --- | --- | --- |
| P0 | clean 批跳过 compose/review；anchor 配额；R1/R2；`prior_cards` 扩展 `evidence_ids`；小池直通在有主题索引时关闭 | ① 回放「14 天池 + 5% 新增」，按 usage 统计 compose/review 输入 token，降幅 ≥60%；② 同主题不重复出卡、`prior_id` 保持；③「计划→取消/完成」场景状态正确 |
| P1 | R3 + 修复重试；重复告警折叠；Profile 新观察预留名额 + work 最新状态 + 按区重写 | 离线评测：计划→取消、告警恢复、无关噪音、撤回、主题漂移各 ≥3 例，状态错误数不高于全量基线 |
| P2 | reconcile 增量（只送新主题 + 旧索引摘要）、`continues` 边、主题级 TTL/全量校准策略 | 归并调用 token 降幅 ≥40%，合并质量不下降 |

**token 降幅度量**：不靠估算，用现有 usage 记账（`runtime/src/usage/model-call.ts`）按 `feature:'timeline'` + `operation` 聚合，对比同一 fixture 回放的输入 token；Dart 端用 `ProfileBudget`/`ModelClient.completedUsage` 同口径统计。

## 8. 与当前分支改动的接口衔接

| 衔接点 | 现有/新增 | 说明 |
| --- | --- | --- |
| `timeline-cache.ts` | 本分支新增 | 提供 `topics` / `screened` / 阶段缓存；P0 在其上加 `getTopics()` 派生 clean/dirty，不需要新的持久化字段 |
| `personal-writer.ts:97-115` | 本分支改 | 分区在「复用主题 + 新主题」合并后、`reconcile` 之前/之后均可；建议在 `reconcile` 之后按批分区 |
| `personal-writer.ts:116-123` | 本分支改 | inputs 增加 `tier`/`seq`/`state_hint` 元数据（只读） |
| `timeline-brief.ts:146-177` | 本分支改 | `prior_cards` 扩展 `evidence_ids`；R1–R3 加在物化循环 |
| `timeline-selection.ts:18/49` | 本分支改 | 有小池直通与主题索引并存时，优先索引（直通仅用于首轮空索引） |
| Dart `timeline_pipeline.dart:122` | 后续 | 同源 prompt + 纯函数 fixture，P1 起对齐 |

## 9. 开放问题（需产品决策）

1. clean 主题跳过写作后，卡片 `time.as_of` 不变、UI 会自动标 historical；是否接受「整理于」时间戳只在本轮 dirty 主题上更新？
2. R1 拒绝「无新证据的修订」是否会在用户手动刷新时产生「看起来没变化」的观感？是否允许 `force` 绕过 R1（当前设计：force 已经绕过全部缓存，但仍受 R1 约束）。
3. Profile 按区重写会让未变区的 `generated_at` 落后于整体时间，是否需要展示分区时间？
4. 新消息权重是否要覆盖「本人旧状态」（例如用户改口偏好）——当前设计允许，但要求原文明示与逐字 quote。
