# 移动端飞书质量迁移：下一位实现者交接

日期：2026-10-30。当前目标是参照 PC 改善手机 Profile / Timeline 的内容质量；先修主体与选材，再做表达组件。

## 当前状态与入口

### 2026-10-30 傍晚：元数据补读修复，Android build 21 验收通过

- 代码 HEAD `a7d84b0d`（在下文 `c910cf74` 之上两笔修复），仍**未合入、未 push**。
- build 19 上点“同步消息”触发一次性元数据补读后，所有卡片和画像都标“原始来源已不可用”，下一轮出现新旧重复卡。根因：仓库证据指纹覆盖消息全部字段，补读新增 `sender_type`/`mention`/`relation`/回复链就让指纹失配。修复：
  - `b3283e86`：证据指纹只覆盖内容身份（id、会话、时间、发送者 id、正文、状态），元数据补充不再算内容变化；新发布写 `history_schema: 2`。
  - `a7d84b0d`：旧 `history_schema: 1` 发布不再重置，全部作为历史保留；旧摘要能按“补读前的记录形态”验证通过的原文恢复为可用，并在下次发布时换成内容指纹；删除或内容改动的原文继续标不可用。
- 全量 Flutter（`a7d84b0d`）：analyze 干净；1263 通过 / 5 跳过 / 2 失败（仅两个新 Mac 截图 golden）。
- Android build 21（`1.0.0 (21)`，证书不变）原地安装，业务数据哈希一致：2 张卡、无重复；两张卡原文都能打开；一条参与者直接@你的卡片显示“直接@你”（与 PC 存储 mention=direct 一致），另一条 @ 的是别人、显示“其他参与者”（PC 为 none）；主体归属正确；再次同步后仍 72 条消息、2 张卡、账本不变。
- 账本保守占用 ¥1.502848（上限 ¥6，非账单）。
- **已接受限制（用户产品原则：凡只在用户编辑原数据时才出现的复杂边界，不支持编辑）**：被编辑的原消息被新条目重新引用时，旧摘要可能被重新认作可用；被编辑原消息不做卡片对账。
- 中间的 build 20 带有“重置 schema-1”的问题版本，只在本机测试设备装过，不要分发。

### 2026-10-30 下午：P0/P1 已迁移，Android build 19 主体归属通过

- 工作分支：`feat/mobile-provider-credentials`，代码 HEAD `c910cf74`。主分支 `v1.0.0dev` 保持干净；功能分支**未合入、未 push**。实现契约见 [mobile-feishu-quality-contract.md](mobile-feishu-quality-contract.md)。
- 已迁移（契约 T1–T4 及四轮 Codex 对抗审查的修复）：
  - 采集保留 `sender_type`、`mention`、`mention_ids`、回复/根/转发 id；近 14 天一次性元数据补读。模型看到 `author{key,kind,is_user}`、`relation=self|addressed|participant|app|unknown`、`links`、`local_date`。
  - Timeline 四个阶段不再拼入画像“本人”规则，改用移植自 PC 的主体/相关性/时间规则；Timeline 直接读近 14 天原文，小输入直接撰写，Profile 失败不阻塞 Timeline。`history_complete` 在流水线内按整题计算，不受画像覆盖率影响。
  - 时间校验移植 `timeline-time.ts`（含 大前天/大后天 整词匹配）；缺 `policy_revision>=2` 的旧卡不再展示。
  - 画像观察增加 relevance，宿主排除一次性任务、参考材料、不确定项；重复模式需两条以上不同原文；观察缓存升到 v4。
  - Timeline 卡稳定 id（有效 `prior_id` 优先，唯一原文集合兜底，否则标题+原文哈希，冲突时派生新 key）、`prior_cards`/`new_input_ids` 增量、独立的 Timeline 证据指纹；无变化不调用模型。只有引用原文全部仍可用的旧卡才会作为摘要发给模型。
  - 升级后观察缓存为空时可恢复：先发布 Timeline，再转入收集，不会卡在终止态。
- **已接受的产品限制（用户 2026-10-30 决定）**：不支持对“飞书原消息被编辑”做卡片对账。被编辑的消息指纹变化后，旧卡不作为已有卡片发给模型，可能出现新旧两张卡；超过 14 天的被编辑消息不会更正旧卡。不要为此再加复杂度。
- 全量 Flutter（`c910cf74`，新 Mac 内置盘）：analyze 干净；1257 通过 / 5 跳过 / 6 失败。失败全部是环境类：2 个截图 golden 在新 Mac 上差 8–20 像素（开工前基线同样失败，未更新 golden）；`source_store_performance_test` 2 个心跳计时、`profile_agent_test` 2 个 20ms deadline 用例在基线上也偶发失败（压测各 1/10）。
- Android build 19（`1.0.0 (19)`，arm64，同一签名证书）原地安装，三个业务 JSON 哈希安装前后一致。
- **内容验收**：2 张卡逐条打开原文核对，主体归属全部正确（参与者的话写成“对方”，用户自己的回复写成“用户回应称”，状态与不确定性如实）；build 18 的错误归属卡已不再显示；画像只引用本人原文。无变化重启 5 分钟账本零增长。
- **仍有的质量问题**：一张卡的事实提到同一参与者另一条消息里的链接，但没有引用那条原文（PC 同事件卡引用齐全）；画像只有 1 条本人原文却写成习惯性描述。均不是主体错误。
- **未完成**：真机上 @ 消息仍标“其他参与者”，元数据补读尚未在设备上观察到（重启后无线调试断开）；同模型同输入的 PC/手机 A/B 未做，只做了与 PC 已有结果的只读对照（主体一致，PC 引用更全）；iPhone 未操作。
- 私有证据（截图、诊断、APK、账本）在仓库外：`<build-dir>/evidence/`（`<build-dir>` 为内置盘上按 canonical worktree 与接手会话 ID 分出的构建目录），汇总为 `acceptance19-content-quality.json`。预算：总额经用户批准上调到 ¥20，Android 整理上限 ¥6，同一账本保守占用 ¥1.297520（非账单）。

### 2026-10-30 上午交接时的状态（历史）

- 代码/证据基线：`5c96444f`；最近代码修改为 `977df17a`。
- 全量 Flutter：**1171 通过 / 5 跳过 / 0 失败**；analyze 无问题；最终相关定向 **39/39**。
- Android build 18 已保留数据安装，真实调用能生成 Timeline、显示卡片并打开原文。
- **内容质量未通过**：现场引用的消息不是 self，正文却写成“本人提出/澄清”。格式、连续 quote 与 completed 状态均不能代替实际主体核对。

详细差异见 [PC 对比报告](../reviews/mobile-pc-feishu-parity-2026-10-30.md)。根 [HANDOFF.md](../../HANDOFF.md) 保留历史过程；以本文件的当前结论为准。本机运行信息另有仓库外私有交接，发给接手者时一并提供。

```sh
git show feat/mobile-provider-credentials:docs/handoffs/mobile-feishu-quality-next.md
git log --oneline v1.0.0dev..feat/mobile-provider-credentials
git worktree list --porcelain
```

在该分支现有 worktree 接手，或从它创建自己的实现分支/worktree；不要从主分支旧手机代码直接重写，也不要覆盖其他工作区。

## 已完成：不要回退或重复实现

| 提交 | 内容 |
| --- | --- |
| `387a958d` | 模型服务主入口、信息整理用途、密钥状态、紧凑工具历史 |
| `936f3fa2` / `c22ffb93` | 飞书卡片/spinner；持久化完整/简洁消息显示 |
| `7af8c9c5` | 倒序新窗口、独立增量/回填游标、持久队列、授权复验 |
| `00f9d0bc` | 按原始身份与内容指纹复用已验证观察 |
| `8b2dba65` | DeepSeek JSON 模式与末帧 usage 结算 |
| `a6789625` / `8c9b505c` | 大缓存后台处理、减少界面重建；思考/工具间距 |
| `4c21e6ec` / `86179a9f` | Timeline JSON 契约、有界纠正；安全阶段诊断与 HTTP 状态 |
| `977df17a` | 参考 PC 的逐卡严格复验、失败批次隔离、部分结果状态、阻止自动付费循环 |
| `22a6f71a` / `5c96444f` | PC 对比及“生成通过、内容质量失败”的证据 |

更早的统一密钥、思考输出长度、作品卡片去重等已进入主分支，不要回退。

逐卡保留机制不是放宽校验：首次仍整批验证，纠正到达停止条件后才逐卡复验；保留草稿仍须经过审查。部分响应不保存成完整阶段 checkpoint；坏缓存继续失败。全无可用卡、审查删光结果仍失败；授权、网络、存储、预算异常不被批次隔离吞掉。partial 保留 pending，停止自动付费重试。

## 同步效率：已优化及证据边界

### 已完成

1. 新窗口倒序读取；历史回填和头部增量使用独立持久游标，未完成历史进度不被头部覆盖。旧正序 token 保留其原范围和顺序。
2. 保存剩余聊天队列、头部队列和累计计数，恢复时不从已完成前缀重读；计数和缓存不从零开始。
3. 按消息原始身份、内容指纹和授权/提供商作用域复用完整观察批次；变更使受影响批次失效，读取续期不无故重做未变内容。
4. 大缓存解码/快照编码、证据投影、指纹计算移到后台 isolate；状态/对话计数单次汇总；折叠详情和普通进度不重建整个聊天/资料视图。
5. 异步工作前后、排队实际执行与落盘后仍检查授权、版本和到期；失效写入回滚。不要为了性能去掉这些边界。

### 已验证

- Android 实际复用全部 72 条观察。重开页面、无变化重复同步后仍保留 72 条消息，保守预算占用没有增加。
- 合成 16,800 条文本、155 个聊天、约 14.2 MB 缓存，原主 isolate 心跳阻塞约 1.65–1.71 秒，最终独立测试最大 55 ms。
- 上面是界面阻塞降低，**不是下载速度、原生 FPS 或整体吞吐提升**；后台总处理时间可能更长。

### 未验证/限制

- 没有网络吞吐、全量同步总时长的同条件 A/B，不能宣称整体快 N 倍。
- 真机同步仅覆盖一个真实聊天的近期范围，不代表全部聊天吞吐。
- 未提供 PC 常驻后台服务等价物；手机被 OS 挂起时依靠持久进度恢复，不承诺锁屏持续运行。
- 创建时间增量查询不保证发现窗口外的远端旧编辑/删除；收到变更会失效相关观察。
- 新授权范围、不同账户/提供商等仍会按权限边界失效派生缓存。
- iPhone 主线程优化尚未真机复验，不用合成或 Android 结果替代。

## 继续实现顺序

### P0：主体归属与职责分离

手机 `timeline_pipeline.dart` 的 `_composeInstructions` 拼入 `profileGrounding`，后者以“画像始终描述账号本人”开头。PC 的 Timeline 使用独立主体/相关性/时间规则和 author 元数据。这里存在任务语气混用。

- 分离 Timeline 与画像的写作及审查规则，逐句区分消息发送者、实际行动者与用户的具体联系。
- 利用已有授权/API 返回范围内的作者类型、显示名、self/participant/addressed/unknown、提及、线程/回复关系。缺字段保持未知，不猜姓名，不扩大通讯录权限。
- self 也只证明由用户发出；转贴助手回报不证明用户执行。participant 的“我”不等于账号本人。
- 不靠更多重试、删除代号或替换引用制造看似正确的结果。
- 旧错误派生卡应有版本地重验/失效，不能在升级后继续当可信事实；原始消息、人工修正、密钥和其他 Space 数据保留。

### P1：独立的近期原文 Timeline

当前是“Profile 观察 → Timeline 选题 → 回读所选原文”，前置摘要可能遗漏或误写事件。PC 独立消费近期原文，小输入直接写、大输入分批选题。

- 按 PC 的近期窗口、本地日期/时区、完整状态变化建立 Timeline 输入。
- Profile 失败不阻塞 Timeline；Profile 排除的一次性操作仍可能是有价值近期事件，不能直接共用长期画像的筛选结果。
- 保留请求容量上限、完整引用与已验证批次缓存，不机械照搬 PC 截短原文。

### P1：画像选材、时间、增量身份

- 迁移 PC relevance 分类，排除一次性任务、参考材料、不确定项；重复模式不能凭单条来源或同一事项连续更新成立。
- 区分发生、报告、截止、安排时间。旧计划不覆盖后续完成/取消/恢复；没有后续消息不证明当前仍未完成。
- 迁移 prior_cards / new_input_ids / prior_id，稳定修订旧卡；旧摘要只作索引，事实仍回读原文。
- 对旧观察缓存制定版本/迁移策略，缺新语义字段的旧观察不能冒充已分类新观察；只失效必要派生层。
- 人工纠正优先；空刷新不删除已有合法内容；撤权/到期则按既有安全策略处理。

### P2：表达与组件

内容正确后再迁移工作项、事实标签、人物、状态和时间结构。可选独立审查模型属于后续路由选择，不静默换模型、供应商或扩大费用。

## 文件入口

手机文件以 `clients/flutter/lib/` 为根：

| 内容 | 手机 | PC |
| --- | --- | --- |
| 采集与元数据 | `context/source_store.dart`、`connectors/feishu/ingest.dart` | `runtime/src/connectors/feishu/index.ts`、`memory-substrate/profile-source-input.ts`、`resource.ts` 的 timelineEvidence |
| 证据与缓存 | `context/profile_evidence.dart`、`profile_observation_checkpoint.dart`、`profile_pipeline_checkpoint.dart` | `personal-agent/timeline-inputs.ts`、summary store |
| 编排/写作 | `context/profile_agent.dart`、`profile_writer.dart`、`timeline_pipeline.dart` | `runtime/src/model/personal-writer.ts` 的 observeProfile / generateProfile / generateTimeline / #composeTimelineBatch |
| 主体/时间 | `context/timeline_brief.dart`、`profile_repository.dart` | `model/timeline-perspective.ts`、`timeline-selection.ts`、`personal-agent/timeline-time.ts`、`timeline-brief.ts` |
| 发布/恢复/界面 | `context/profile_generation_coordinator.dart`、`ui/local_profile_results.dart`、`profile_generation_status.dart`、`ui/app.dart` 的 _ProfileScope | PC Timeline checkpoint、prior_id、阶段诊断和增量发布 |

PC 表格中省略的根目录均为 `runtime/src/`。

优先复用现有测试：`timeline_partial_test.dart`、`timeline_pipeline_test.dart`、`timeline_compose_diagnostics_test.dart`、`profile_saved_agent_test.dart`、`profile_observation_checkpoint_test.dart`、`profile_generation_coordinator_test.dart`、`profile_generation_status_test.dart`、`feishu_recent_test.dart`、`feishu_auth_recovery_test.dart`、`source_store_performance_test.dart`。

## 必须通过的内容验收

| 场景 | 预期 |
| --- | --- |
| 用户发起评估，协作者回复“我验证完成” | 可写协作者完成验证、回应用户请求；不能写用户完成 |
| 只有别人的独立事务 | 无具体用户联系则不成卡，不补泛泛协作价值 |
| self 转贴助手“已帮你部署完成” | 不把他人/助手成果归为用户执行 |
| 一次性验收或参考材料 | 按实际价值进入 Timeline，不自动升级为长期能力、职责或兴趣 |
| 旧计划与后续完成/取消/恢复 | 最新有据状态正确；同事项不重复，不同项目同名事项不乱合并 |
| 日期/时区 | 不混淆发生、报告和整理日期，不按无后续消息推断当前状态 |
| 好坏卡混合、失败批次 | 合格且审查通过的内容保留，partial/pending 明确，全无合法内容仍失败 |
| 引文与权限失效 | 连续 quote 对应正确原文，不换 ref 掩盖错误；撤权/到期/换 Space 后不得发布旧结果 |
| 无变化重开与新消息 | 不从零同步、不重做付费整理；新增仅处理必要变化 |
| 旧派生数据升级 | 错误归属卡不继续当可信内容；原始数据、人工纠正和其他 Space 保留 |

使用相同授权消息、相同模型做 PC/手机对照，记录生成、接受、丢弃、发布数，人工核对主体、相关性、状态和日期。只断言提示词含某句话、只看 schema/quote 或 completed，不算内容验收。

0 卡须区分“无相关内容”“处理失败”“预算暂停”；不得为了有卡而放宽事实和相关性。

## 工程约束与交付

- 读仓库 AGENTS，遵守公私边界，不引入 internal/pilot 代码、租户数据或未批准素材，不 push。
- 私有聊天、账号/应用身份、日志、截图、密钥、产物留在仓库外；公开测试使用合成或获准脱敏样本。
- 构建与缓存放在内置盘，按 canonical worktree 路径 + 接手会话（chat ID）分目录隔离；外置盘不再使用。串行 Flutter/Dart/打包，不清共享输出。
- 原地升级且先核对证书，不卸载/清数据。iPhone 当前由用户使用，不自动操作。
- 真实调用沿用已有授权及同一累计账本，具体值在仓库外私有交接；不重置旧未知预留，不把新会话当新额度。
- 保留中央凭据引用、OAuth/语音隔离、Space/提供商作用域、授权复验和失败回滚。
- 测试可先运行 analyze 与全量 Flutter suite，前提是 TMPDIR 和所有可变输出已隔离到内置盘上按 worktree 路径与会话 ID 分出的目录。设备验收需保留原数据并区分自动、原生、真实模型和内容质量证据。
- 实现、复核、内容验收通过后才满足原本地合入条件；目标 v1.0.0dev，不自动 push。
- 更新本文件及根 HANDOFF 的最终状态。未验收的 iPhone、语音、Relay Client 或 PC 同样本对照不标通过。
