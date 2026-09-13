# 06 记忆底座：账本 / 条目 / 视图

> 目标：把 Nova 的持续理解收敛到**一套**底座上。来源（对话、授权目录、邮件、IM、可核验的执行器结果）
> 只产证据；证据只追加；理解以修订日志形式派生；表现层只读视图。可追溯不是一层，是每条理解都带的属性。
> 本卷定义 `evidence_record`、`entry_revision` 两个底座契约，03 卷的 `memory_entry` 与 02 卷的 proposal
> 都是它们之上的投影。

状态：待评审。对应里程碑"记忆底座"（见 [STATUS](STATUS.zh-CN.md)）。本卷不改产品代码。

## 0. 为什么要这一卷

2026-09-12 对照 mem0、VoiceMem、OpenClaw、today.ai、mycontext 与同事的
"Human-centric × Work-centric" 架构图（对照记录见
[design-notes/2026-09-12-memory-references-comparison](../../design-notes/2026-09-12-memory-references-comparison.zh-CN.md)），
得出三条结论：

1. 现有三套记忆（会话黑板、VoiceMem 个人记忆、Workspace Graph）各自为真，03 卷要求的
   逐条 ID / 版本 / origin / 纠正传播在任何一套里都不完整。再按参考项目各加一层只会更散。
2. 记忆层内部应按**数据变更方式**分阶段，而不是按参考项目或按"人 / 工作"分库。变更方式只有三种：
   只追加、受控修订、只读重算。
3. "有迹可循"是每条修订都必须带的 `evidence_refs`，不是独立的一层；把它单独立层会让两层互相持有指针，
   永远解不开。

## 1. 现有基础（2026-09-12 核实）

- `runtime/src/memory.ts`：会话内运行时黑板（`Memory` / `Channel`，按 handoff 通道编号的 `MemoryItem`），
  `docs/archs/02-memory.md` 的 L0。**不进本卷底座**；它是当前会话事实，不是持续理解。
- `runtime/src/workspace-graph/`：`models.ts` 已有 `EvidenceRefSchema`、`ObservationSchema`（只追加观测）、
  `LogicalWorkspace` / `WorkspaceInstance` / `RelationCard`（带 revision 的派生卡片）、`RecallPack`；
  `store.ts` + `store-worker.ts` 由 Worker 独占 SQLite；`projector.ts` 产出 `PublishedGraphSnapshot`；
  `identity.ts` 做工作区别名归一（`candidate | confirmed | suppressed`，ASR 别名置信上限 0.25）；
  `sensitivity.ts` 有 `SensitivePathPolicy` 与字段级 `SensitiveContentPolicy`。这套已经是
  "账本 + 条目 + 视图"的雏形，对应 `docs/archs/02-memory.md` 的 L1–L4，本卷以它为底座的**第一个实现**。
- `runtime/src/memory/personal-memory.ts`：`PersonalMemoryResource` 端口（`recall` 必选，
  `remember` / `forget` / `responseAdaptation` 可选）；`factory.ts` 选择本地 VoiceMem sidecar 或
  `remote-personal-memory.ts`。命中没有稳定 `entry_id`、版本、origin；`forget` 按轮次；无 `list`。
- `runtime/src/context-view.ts`：唯一面向模型的同步有界投影。
- `runtime/src/realtime-assembly.ts` 的 `responseAdaptationFor()` 把 `<reply_preferences>` 同步注入；
  `runtime/src/tool-schema.ts` 的 `memory__recall` 工具带 `source: session | personal`。
  实时语音路径没有逐轮 prompt 组装，记忆只能经 host item 或工具结果进入模型。
- `runtime/src/suggestions.ts` + `runtime/src/floor.ts`：Suggestion Pool 与说话权仲裁，是本卷视图层的消费者。
- `runtime/src/knowledge/`：用户主动导入的资料库，独立 SQLite Worker，存分块与 embedding。
  `docs/archs/02-memory.md` 明确它不是 L0–L4 的一层；与本卷账本的关系见 §9。
- `docs/superpowers/specs/2026-09-05-native-ts-memory-design.md`：原生 TS 双脑（事实 + 情绪/风格）设计，
  未实现。本卷把它定位为 B 阶段 human-centric kind 的候选写入方，不改该文档。

## 2. 三个架构层与记忆层内部的三个阶段

```text
┌─ 表现层 ─────────────────────────────────────────────────────┐
│  回复风格 / memory__recall / proposal（02）/ 记忆页（03）       │
│  只读视图；唯一写回动作 = 用户纠正，且它作为证据回到 A           │
├─ 记忆层 ─────────────────────────────────────────────────────┤
│  C 视图（只读重算）  fold 当前态；四种投影；发布快照；降级用上一份 │
│  B 条目（受控修订）  entry_revision 只追加；merge 是唯一写入口     │
│  A 账本（只追加）    evidence_record 存原文；来源断开物理删除     │
├─ 来源层 ─────────────────────────────────────────────────────┤
│  对话 / 授权目录 / 邮件 / IM（飞书）/ 可核验的执行器结果          │
│  连接器只做一件事：把变化写成 evidence_record                    │
└──────────────────────────────────────────────────────────────┘
```

A / B / C 是记忆层**内部的三个阶段**，不是三个部署单元：同一个 SQLite 文件里三族表，
一个 Worker 独占，主线程与语音热路径只读发布快照（沿用 `docs/archs/02-memory.md` L1 / L3 的规则）。
数据只向上流；控制只有一条向下的路，就是用户纠正，而它也是先写进 A 再经 merge 进 B。

| 阶段 | 变更模型 | 写入者 | 读者 | 对应 archs/02 |
|---|---|---|---|---|
| A 账本 | 只追加；来源断开时物理删除该来源的行 | 连接器、对话轮次入账、执行器结果入账、用户纠正 | merge、重抽取、记忆页"查看依据" | L1 观测 |
| B 条目 | 只追加的修订日志；不原地改 | 仅 merge 纯函数 | fold | L2 卡片 + 乐观修订 |
| C 视图 | 只读重算；发布快照 | 无 | 表现层全部消费者 | L3 快照 + L4 投影 |

## 3. A 阶段契约：`evidence_record`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 稳定；`entry_revision.evidence_refs` 的引用目标；沿用 `EvidenceRefSchema` 的形态 |
| `source_id` | string | 04 卷连接器实例 ID；对话为会话 ID；执行器结果为 `work_id` |
| `source_kind` | `conversation \| file \| mail \| calendar \| im \| task_result \| user_correction` | `user_correction` 是用户在记忆页的纠正 / 忘记动作本身 |
| `locator` | string | 能回到原处的定位：文件路径 + 修改时间、邮件消息 ID、IM 消息 ID、事件 `MemoryRef` |
| `cursor` | string \| null | 连接器同步游标，重放与恢复用 |
| `observed_at` / `recorded_at` | ISO 8601 | 依据发生时间 / 写入时间，分开 |
| `raw_text` | string \| null | **存原文**（2026-09-12 决定）。经字段级 `SensitiveContentPolicy` 处理；被整段屏蔽时为 null 并在 `sensitivity` 记录原因 |
| `extracted` | object | 入库时的结构化抽取（见 §7）：候选条目、实体、日期；是模型输出，**本身不是证据** |
| `hash` | string | 归一化内容哈希；03 卷"忘记后不再生成"的抑制标记以它为键 |
| `sensitivity` | `{policy_version, redactions[]}` | 应用了哪版策略、屏蔽了什么类型 |
| `retention_until` | ISO 8601 \| null | 原文保留期；到期后 `raw_text` 置 null，行保留 |
| `trust` | 沿用 `runtime/src/events.ts` 的 `trustSchema` | 外部内容一律低信任；`user_correction` 最高 |

规则：

- 只追加。没有 UPDATE；同一来源同一 locator 的新版本是新行，`cursor` 与 `hash` 区分。
- **来源断开或删除来源数据 = 物理删除该 `source_id` 的全部行**，不是墓碑。B 阶段指向它们的
  `evidence_refs` 变成悬空引用，条目在视图里显示"证据已删除"（§5），不消失也不伪装仍有依据。
- 保留期是连接器配置：IM 与邮件原文默认有期（数值待评审，§10），本地目录与对话默认长期。
  到期只清 `raw_text`，`extracted`、`hash`、`locator` 保留，追溯降级为"能回到原处看"。
- 敏感策略落在字段级：`raw_text`、`extracted` 内每个字符串字段、`locator` 各自过策略，
  复用 `runtime/src/workspace-graph/sensitivity.ts` 的 `SensitiveContentPolicy`，不新写一套。
- 模型对自己行为的叙述不能成为 `evidence_record`（§8）。

## 4. B 阶段契约：`entry_revision`

| 字段 | 类型 | 说明 |
|---|---|---|
| `entry_id` | string | 条目稳定 ID，跨修订不变；03 卷 `memory_entry.id` |
| `revision` | number | 单调；03 卷 `memory_entry.version`；02 卷 `memory_refs` 用 `entry_id@revision` |
| `supersedes` | number \| null | 被本修订替代的上一修订；首条为 null |
| `op` | `add \| update \| tombstone` | 对应 mem0 的 ADD / UPDATE / DELETE；NOOP 不产生行 |
| `kind` | 见 §6 | |
| `origin` | `stated \| inferred` | 沿用 03 卷语义；`written_by = user_correction` 时必为 `stated` |
| `written_by` | `merge \| user_correction` | **同一种记录**，不分两张表；记忆页修订历史一套渲染 |
| `evidence_refs` | array of `evidence_record.id` | 至少 1 条；可悬空（§5） |
| `entity_refs` | array of `entry_id` | 指向 `kind = entity` 的条目，两视角共享实体的落点 |
| `content` | object | 按 kind 定形；用户可读一句话由 C 阶段投影生成 |
| `valid_until` | ISO 8601 \| null | 有时效的状态（"这周在赶演示"）；过期后不进投影，历史可查 |
| `recorded_at` | ISO 8601 | |

**merge 是唯一写入口**，签名固定为纯函数：

```text
merge(current: FoldedEntry | null, candidate: Candidate, policy) -> NOOP | add | update | tombstone
```

- `candidate` 来自入库抽取（§7）或用户纠正；带 `evidence_refs`、`origin`、`written_by`。
- 不变量（吸收自 mycontext，已在 workspace-graph spec 的 Design rules 中）：
  数据库为真；`written_by = user_correction` 优先于任何 `merge`，且后者不能覆盖前者，
  除非新的用户纠正；agent 自身输出不作候选；同一 `hash` 已被用户忘记（03 卷抑制标记）则 NOOP；
  来源撤回级联：其 `evidence_refs` 全部悬空的条目自动写一条 `tombstone`，`written_by = merge`，
  content 记录原因 `evidence_deleted`。
- NOOP 判据：候选与当前态内容等价（按 kind 的归一化比较）且 `origin` 不升级、`valid_until` 不延后。
- 乐观并发：`candidate.expected_revision` 与当前 fold 的 `revision` 不一致则拒绝，由调用方刷新重试。
  这就是 03 卷 `correct(entry_id, expected_version, …)` 的底层实现。
- **重抽取**：对账本一段范围重新跑 §7 的抽取并逐条 merge。只产生新修订，不改旧修订；
  旧修订的 `evidence_refs` 不变。用于换模型或修 bug 后回填。

## 5. C 阶段契约：视图

fold 规则：按 `entry_id` 取最大 `revision`；`op = tombstone` 则条目不在当前态；
`valid_until` 已过则不进任何模型投影，记忆页可在"已过期"筛选中看到。

| 投影 | 延迟档 | 输入 | 输出 | 现有落点 |
|---|---|---|---|---|
| 回复偏好 | 同步 | `kind = preference`，`origin = stated` 优先 | `<reply_preferences>` | `realtime-assembly.ts` |
| 按需回忆 | 请求时 | 查询 + 作用域 | 有界命中列表，每条带 `entry_id@revision` | `memory__recall` |
| proposal 候选 | tick | 02 卷快照所需的少量相关条目 + commitment 到期窗口 | 02 卷 §2.2 的"少量相关个人记忆" | 02 卷适配层 |
| 记忆页 | 列表 / 分页 | 全部 active 条目 | 03 卷 `memory_entry` | 03 卷 |

- 每次 fold 结果作为不可变快照发布；消费者只读最新快照，发布失败时继续用上一份并可见地标记降级
  （沿用 `PublishedGraphSnapshot` 的做法）。
- **悬空 `evidence_refs`**：条目仍在当前态时，投影里该依据显示为"证据已删除（来源 X，时间 T）"，
  `locator` 不再展示；全部悬空的条目已由 §4 级联墓碑处理。
- 视图层不写任何东西。记忆页的纠正 / 忘记走 `client.command`，主机把它写成
  `source_kind = user_correction` 的 `evidence_record`，再经 merge。

## 6. kind 目录

| kind | 视角 | content 要点 | 来源 |
|---|---|---|---|
| `fact` / `preference` / `plan` / `concern` | Human-centric | 沿用 03 卷 §2.2 定义 | 对话为主；VoiceMem / 原生 TS 双脑作为写入方 |
| `commitment` | 两视角交界 | `direction: owed_by_me \| owed_to_me`、`due`（可空）、`counterparty` → `entity_refs`、`status: open \| done \| dropped` | 对话、IM、邮件；抽取规则 §7 |
| `entity` | 共享 | `entity_kind: person \| project \| workspace`、别名列表 | `identity.ts` 已做 workspace；person 归一待评审 |
| `topic` | Work-centric | 标签 + 出现范围 | 授权目录（today.ai 式关键词，证据指向文件） |
| Workspace Graph 的 `LogicalWorkspace` / `WorkspaceInstance` / `RelationCard` | Work-centric | 保持现有 schema | 现有 projector 改为经 merge 写修订 |

Human-centric 与 Work-centric 是同一张修订表上的 kind，不是两个库。一条 `commitment` 的
`counterparty` 与一条"重要关系"的 `fact` 指向同一个 `entity` 条目，这是"两个视角关联同一份事实"的物理含义。

`commitment` 到 02 卷 suggestion kind 的映射：`owed_by_me` → `notify`；`owed_to_me` → `followup`。
`due` 是抽取出的截止时间，**不是**依据的发生时间；02 卷"记忆的发生时间不当作未来截止时间"仍然成立。

## 7. Discovery 拆成两半

| 半 | 何时 | 属于 | 输入 → 输出 |
|---|---|---|---|
| 发现即抽取 | 入库时，每条 `evidence_record` 写入后 | A → B 写路径 | 原文 → `extracted`（候选 `commitment` / `fact` / `entity` / 日期）→ 逐条 merge |
| 发现即筛选 | 02 卷的 `tick` 与来源变化机会 | C 视图 → 02 卷 | 当前态 + 时钟 + 近期交付 → 少量值得此刻提的条目，交给 Surrogate |

- 抽取是有界的一次模型调用，输出经 zod 校验后才进 `extracted`；校验失败记录并跳过，不阻塞入账。
- 抽取结果全部是 `origin = inferred`，除非来源本身是用户在对话中的明确表达（`user_confirmed`，
  非 ASR 原始转写，沿用 workspace-graph spec 的 `user_transcript` vs `user_confirmed` 区分）。
- 筛选不调用工具、不新增条目，只是 02 卷 §2.2 快照的供给方；02 卷 Surrogate 的职责不变。
- 同事架构图上的 "Discovery" 框只是后一半；前一半画进 Memory 框内（改图意见见对照记录）。

## 8. 执行器结果入账规则

右侧来源"任务与工具结果"只在**有可核验产物**时产生 `evidence_record`：文件被修改（路径 + 哈希）、
PR / commit 已创建（URL 或 SHA）、命令返回码与截断输出、`EXECUTOR_TASKS` 里主机确认的
`completed` 事实。`source_kind = task_result`，`locator` 指向产物。模型对"我做了什么"的叙述、
进度气泡文案、Surrogate 的 reason 一律不入账。这是 mycontext "agent 输出不作证据"在 Nova 的落点。

## 9. 不做

- 不生成叙事式人物画像作为主体（D3 不变）。
- 不引入向量数据库或 mem0 作为依赖；mem0 的贡献只是 §4 的 merge 动作集合。
- 不在 06 卷底座之外新建记忆存储；VoiceMem 与 Workspace Graph 改为写入方，不再各自为真。
- 不让 renderer、模型或语音热路径直接读写底座 SQLite。
- 不把 `knowledge/` 资料库并入本卷（是否并入列为待评审）；资料库分块不作为 `evidence_record`。
- 不做精确到点的提醒（02 卷不变）；`commitment.due` 只供筛选，不承诺时效。

## 10. 待评审

| 项 | 选项 | 影响 |
|---|---|---|
| `knowledge/` 资料库与 A 账本的关系 | 独立保留，账本只存 locator 指向资料库 / 并入账本，资料库退为索引 | 前者少改代码但两处存原文；后者一处存原文但要迁移 v0.2 知识库 |
| VoiceMem 改造成 B 写入方的路径 | sidecar 输出候选由主机 merge / 原生 TS 双脑直接替代 sidecar | 前者保住现有后端；后者依赖 09-05 设计落地 |
| IM 与邮件原文默认保留期 | 30 天 / 90 天 / 用户配置无默认 | 越短越轻，重抽取窗口越小 |
| person 实体归一 | 复用 `identity.ts` 的 candidate / confirmed / suppressed 机制 / 只按连接器给的稳定 ID，不做跨来源归一 | 前者能把飞书里的人和邮件里的人对上，误合并风险需 ASR 式置信上限 |
| Workspace Graph 迁移时机 | 底座里程碑内一次迁 / 先并行写、后切换 | 前者干净，后者可分步验收 |

## 11. 验收场景

编号续 02 / 03 / 04 卷，从 12 起。

- **12 纠正只出新修订**：用户纠正一条 `inferred` 条目；账本多一条 `user_correction` 记录，修订表多一条
  `written_by = user_correction`、`origin = stated` 的修订，fold 只返回它；依赖旧修订的 pending
  suggestion 撤回，`feed_item` 置 `invalidated`（与 03 卷场景 7 一致）。旧修订原样可查。
- **13 来源断开物理删除**：断开一个 IM 来源；该 `source_id` 的账本行物理消失；只依赖它的条目自动
  出现 `tombstone`；同时有对话依据的条目保留，记忆页对应依据显示"证据已删除"。
- **14 重抽取不改历史**：对同一段账本用新抽取器重跑；产生的新修订 `supersedes` 指向旧修订；
  旧修订与其 `evidence_refs` 不变；内容等价的候选为 NOOP，不产生行。
- **15 承诺从飞书消息抽出并被筛选**：fixture 里一条飞书消息"周五前把评审意见发我"；入库抽取出
  `commitment{owed_by_me, due=本周五, counterparty=发送者}`；周四的 `tick` 筛选把它交给 Surrogate；
  用户在对话中说"已经发了"后，merge 写 `status: done` 修订，下次 tick 不再筛出。
- **16 有时效条目过期**：`valid_until` 已过的条目不出现在回复偏好、回忆、proposal 候选三种投影；
  记忆页"已过期"筛选可见，修订历史完整。
- **17 叙述不入账**：执行器报告"已修复测试"但没有产物；账本无新行。同一任务产生了 commit SHA 时，
  账本有一行 `task_result`，`locator` 是该 SHA。
