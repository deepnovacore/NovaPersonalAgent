# Nova 全仓架构瘦身方案与 50% 可行性

更新：2026-09-13。状态：**仅计划，未授权实施代码变更**。

本文件接续旧 Ponytail worktree 的同名方案，收录用户最新取舍及源码核查。当前章节优先于末尾历史方案；历史数字、旧建议和旧测试结果不自动适用于当前主目录。

旧 worktree 已改名为 `.worktrees/legacy-ponytail`，本地分支为 `feature/legacy-ponytail`，停留在 `53c0085a`，仅保留作历史参考。后续实施应从当时最新开发状态建立新的工作树，不继续在旧树上开发或整体合并旧分支。

## 一、已经确认的产品边界

| 项目 | 最新决定 |
| --- | --- |
| 自动生成任务标题 | 必须保留；不因额外模型回合而删除 |
| Nova 从零创建项目、会话 | 核心能力，必须保留；共享 HOME 不得变成只续接已有任务 |
| semantic acknowledgement 自动恢复 | 保留现有行为，不改为一次播报后放弃 |
| 确认 carrier 的透明恢复 | 保留，不改成异常后要求用户手动重连 |
| `embedding_provider=local` | 用户认可删除未实现入口；本轮只记录计划 |
| Codex 协议预检 | 用户认可继续验证简化；不等于批准取消所有运行时校验 |
| Codex HOME | 研究共享 HOME，保留项目、新会话、标题及认证能力 |
| 知识库 | 对照 Qwen 审查实现成本；没有授权取消 URL、PDF/DOCX 或语义检索 |
| 受控重连／历史回填 | 完成历史调查，暂不改变默认值或行为 |
| 图谱 | 仍需与最新 memory 设计协调；旧“整目录删除”建议不是当前执行授权 |

不再把“取消新建项目”“取消标题”“放弃确认补播”“确认故障要求手动重连”列为当前瘦身方案。50% 净删尚无证据，不以牺牲上述能力补数字。

## 二、删除未实现的 local embedding 入口

现状：`runtime/src/config.ts` 接受 `dashscope | local`；桌面保存层也接受 local，界面展示禁用的“本地（即将支持）”；`knowledge/assembly.ts` 最终只允许 DashScope，local 会报 `embedding_provider_unavailable`。没有可删除的本地 embedding 引擎。

计划范围：

1. 去掉 local 配置选项、禁用的 UI 选项及“即将支持”承诺；运行配置仅保留当前实际支持的服务。
2. 更新 runtime 配置、knowledge assembly、desktop settings-store/backend 的相关契约和专属测试。
3. 更新知识库规格与设置规格；历史实施计划保留为历史，不继续作为能力承诺。
4. 显式配置的旧 local 值应给出清晰的“不再支持”错误，不能静默切成 DashScope 后上传文档。直接复用现有配置校验，不新增迁移框架。
5. 保留 embedding 模型、服务地址及实际 DashScope embedding 调用；不借此删除语义检索。

验证：默认配置正常；旧 local 明确拒绝；UI 不再呈现不可用入口；知识库禁用/启用和 embedding 失败处理仍符合契约。由于是预留入口，收益应按真实 diff 统计，不能宣称删掉一个 provider 实现。

## 三、共享 Codex HOME，同时保留项目管理

参考仓库：本地参考仓库 `qwen-audio-agent`。其 `server/src/agent/backends/codex.mjs` 将项目目录设为 cwd，继承环境，不为每项目创建独立 CODEX_HOME；模型配置经 ACP 适配器传递。这个职责划分可借鉴，ACP 专用环境协议不能直接视为 Nova app-server 的协议。

Nova 的 `ProjectStore.createManaged` 创建工作目录，`persistentHome` 另行管理项目专属 Codex 状态目录。两者可解耦。

目标：多个项目共享用户选定的 Codex HOME，独立保留 cwd、thread、Nova workspace/session 绑定。Nova 继续新建目录、创建任务和生成标题，Codex 管理共享 HOME 中的认证与会话文件；Nova 所需执行配置通过经过验证的进程或请求级覆盖传递。

必须先处理的耦合：

- `credential-snapshot.ts` 的非 preserveHome 路径会同步登录文件、写 config.toml，不能直接把路径改为用户 HOME。
- preserveHome 当前会忽略独立 API key；应把认证选择与 HOME 所有权分开。
- `factory.ts` 当前 `generateTitles: project && !binding.preserveHome`；应按新建/续接和是否已有名称决定标题行为，不能因为共享 HOME 关闭标题。
- 新建与导入会话统一明确 HOME 绑定，保持同一 thread 的执行所有权，核查与外部 Codex 同时操作时的行为。
- 保留 shared-home 配置覆盖与实际 config/read 检查，避免继承不符合 Nova 策略的扩展、MCP、环境和审批设置。
- 旧私有 HOME 的线程不能靠改路径自动恢复。制定可验证的迁移或保留访问方案，不删除旧数据。

候选退役职责：每项目 HOME 创建与专属迁移、认证副本及同步标记、生成磁盘配置及相应清理。临时 HOME 如仍被 preflight/其他执行模式使用，不纳入整块删除。

验收覆盖：新建项目、续接项目、自动标题、登录/API key 两种认证、项目切换、审批、取消、旧会话访问、并发线程、用户共享配置文件未被覆盖。净减待实现统计。

## 四、协议预检：先减少重复，再决定认证范围

当前版本契约为最低 0.145.0 + 运行时 schema 准入，参考 schema fixture 为 0.152.0，并未限定某个认证构建。

实际链：factory 启动检查执行 preflight；每次冷 establish 再执行；共享 HOME 首次 config/read 后重启 establish 又执行一遍。预热复用已有连接，未缓存成功 schema 认证。

第一步候选：同一次连接建立流程中，配置覆盖后的重启复用已完成的协议认证；保留重启后的真实配置检查、工作区与沙箱检查。明确认证边界为一次建立流程，验证启动对象身份，不能假设两次调用间二进制永不变化。主要减少子进程与文件 IO，预计不会显著减行。

第二步待决定：若限定经过认证的 Codex 构建，将 schema 元数据验证移至 CI/安装验收。候选毛范围约 750 行（schema 主体约 670、生成读取器 62、调用约 12 及少量接线）；迁出生产不等于仓库净删除。

保留 `validateEffectiveCodexConfig`、真实消息与审批请求验证、thread/turn 绑定、登录检查及沙箱实测。不要以仅版本号/路径的缓存取代身份验证；复杂失效缓存可能反而增加代码。

已有验证：本次讨论上一轮直接针对主目录源码运行 32 项测试，schema 16、transport 9、host 7，均通过；临时 loader/假 runner，不构建共享 dist，不运行真实模型。它们证明当前边界，不证明尚未实施的方案已经通过。

## 五、知识库：保留能力，优先删内部协议绕行

2026-09-13 主目录 `runtime/src/knowledge` 为 10 文件、2,533 物理行（含注释与空行，不含测试/UI）。旧 worktree 的 2,433 行是旧快照，不能混用。

Qwen 当前应用层主要通过 ACP 传入 MCP servers，并透传后端工具；没有发现与 Nova 等价的自建文档解析、embedding、SQLite/FTS 持久索引。旧 Nova 规格提到的 Qwen substring domain library 也不能据此当成当前参考仓库的实现。对比收益应扣除下沉到依赖/外部服务的成本。

### 优先候选：去掉进程内 MCP 往返

当前 `knowledge/mcp.ts`：Executor.dispatch → SDK Client → InMemoryTransport → McpServer → 同进程 backend.recall → structuredContent → handoff。内部 adapter 为此管理连接、失败重建、关闭和 reopen；外部 Codex 的 HTTP MCP 是独立路径。

计划共用一份经过参数检查、取消检查和 safeHits 过滤的 recall handler；内部 executor 直接调用并转换 handoff，外部 MCP 调同一 handler 并转换协议结果。删除内部 linked pair 与连接重建职责，保留外部 HTTP MCP、untrusted_external、字段预算、错误语义和资源关闭行为。

重点审查范围约 80 行，不是净删承诺。测试改为验证取消、关闭/重开与返回契约，不再维护 clientForTest 的 SDK 对象身份；HTTP MCP 契约测试继续保留。

### 后续小范围候选

- `store-worker.ts` 将 candidates 与 byId 两份平行索引合为 `id → {row, vectorRank, lexicalRank}`，保持现行词法覆盖顺序、前 50 候选、RRF、排序和截断；做结果差分验证。收益数行级，主要减少同步条件。
- 对照 `private-database.ts` 复用数据库路径、父目录及主文件身份校验，候选主体约 60 行；验证平台差异和 StoreError 映射。sidecar 操作不同，不直接合并。
- `store-client.ts` 单一路径的 request/send 可合并，优先级低于内部 MCP。
- knowledge 引用图谱目录中的敏感内容策略，应改为共享策略归属；保留同一策略实现。移动行数不算减少。

保留：PDF/DOCX 解析 worker 的限时/限内存/取消、SQLite 后台 worker、来源删除和原子重建、引用 ok/stale/gone、FTS 降级及 dirty rebuild、旧摘要兼容。这些有具体正确性或数据恢复用途。

不纳入当前实施计划：删除 URL 导入、只支持 TXT/Markdown、取消 embedding 改纯全文检索。这些会改变产品能力，用户尚未认可。

## 六、受控重连历史核查

功能区分：Guard 监控提醒正常运行；controlled reconnect 仅在取消被拒绝等严格条件下更换 provider 会话；history recovery 给替换后的会话补最近对话，不承担一般任务恢复。

关闭时提醒仍排队，适用的 350ms deadline 隔离旧音频，但不会强制释放 provider 推理占用；等待 provider 终结、用户不在说话后再播。provider 永不终结时，这条路径无法保证提醒最终播出。

本轮使用 `git log --all -S/-G` 核对本地可达历史（当时 132 个 refs），**未找到产品默认 true 的版本**：

| 日期／提交 | 证据 | 结论 |
| --- | --- | --- |
| 2026-08-16 `c87fdd62` | Python config.py:36–38、service.py:225–226 | False / none；assembly 测试明确命名 opt-in |
| 同一提交 | scripts/realtime_probe/history_recovery.py:267–269 | 实验脚本显式 True，不是默认 |
| 2026-08-19 `27e97cd8` | 初始 TS service | `?? false` / `?? 'none'` |
| 2026-08-20 `b4aa5287` | TS assembly | 仅转发调用方提供的值 |
| 2026-08-20 `eca04657` | TS config | `.default(false)` / `.default('none')` |
| 2026-08-22 `0ecdcaa0` | .env.example | 新增注释 false，不是生效的 true 覆盖 |

历史提交 `40103b9c` 将受控换会话描述为最后手段；当前七条件防止替换已经产生内容的正常会话。但未找到“效果评估证明无用”的结论，也没有据此证明真实 Qwen 取消拒绝链路已经验收。

范围限制：最早可达根提交已经默认关闭，不能推断导入历史之前从未开启；未调查未提交的私有环境设置或不可达对象。实验显式开启与产品默认必须分开。

本轮不退役这条路径。后续价值判断需要实际触发次数、取消失败后等待时间、恢复成功率和上下文影响。

### 本地共同备份（2026-09-13）

按用户要求，受控重连、历史恢复与 WebUI 保存到同一个本地分支 `backup/webui-2026-09-13`，固定提交 `248dbf9dc1999f64f5e7c56be409c21432c6cce6`。

创建前确认该分支此前仅在计划中指定、尚不存在；本次实际创建。备份保留整个提交树和其可达历史，包含 WebUI、realtime service/session/history、provider 接线、配置、测试及构建依赖，避免只拷几个函数而丢失恢复所需上下文。创建时相关工作目录文件与提交一致。

仅本地保存，未推送，未删除当前实现，也未开启相关功能。需要恢复或对照时从该分支建立独立工作树；不要将整份快照直接覆盖后续主线。这个 Git 分支仍属于同一仓库，不是独立磁盘灾备。

## 七、默认关闭路径的纠正

| 路径 | 当前事实 | 处理 |
| --- | --- | --- |
| 图谱 | schema false，但 .env.example 有生效的 true 覆盖 | 不能称默认无人用；先协调 memory substrate 与共享策略依赖 |
| 知识库 | 默认关闭，Settings 有启用入口 | 审查内部成本，不认定死代码 |
| 向 Codex 暴露知识库 | 独立默认关闭，开启后启动 HTTP MCP | 保留对外协议边界 |
| 个人记忆连接 | 默认 disabled，local/remote 实际可达 | 不混淆为核心会话 Memory 关闭 |
| 对话视觉附帧 | 默认关闭，仅支持视觉的级联模型启用 | 不等于整个 Vision 默认关闭 |
| 级联管线 | 非默认选项，有生产实现 | 不以非默认为退役证据 |
| local embedding | 接受配置却没有实现 | 纳入明确删除计划 |

## 八、runtime 目录组织与适度重构（新增计划）

2026-09-13 核对：`runtime/src/` 根层直接平铺 85 个 TS 文件。问题是业务状态、启动装配、桌面接口、存储安全和验证工具混在同一层；不能只把这些文件全部搬进一个 core 或 utils 大目录。

### 建议归属

以下是职责分组草案，不要求每组都新建目录；先复用现有目录，再按实际调用关系决定归属。迁移时一次处理一个闭合模块。

| 归属 | 根层文件示例 | 组织原则 |
| --- | --- | --- |
| 根层入口 | index.ts、desktop.ts、cli.ts、server-entry.ts、desktop-entry.ts | 保留发布 exports、可执行入口；不以增加转发壳制造表面整齐 |
| composition/ | assembly.ts、production-composition.ts、各 provider 的 realtime assembly/config | 只负责依赖装配、资源打开与关闭；不接管业务状态机 |
| core/ | runtime.ts、causal-runtime.ts、events.ts、effects.ts、ports.ts、calls.ts、slots.ts | 确定性决策和异步执行保留各自职责；不把其他文件都塞入 core |
| projects/ | project-store.ts、project-confirmation.ts、project-root-file.ts、managed-workspace-maintenance.ts 等 | 项目身份、确认、持久化和目录维护按真实所有权归组；配合共享 HOME 计划去耦合 |
| desktop/ | desktop-wire.ts、desktop-bridge.ts、desktop-control.ts、desktop-progress.ts、desktop-camera*.ts 等 | Node 侧桌面协议与适配；客户端 UI 仍在 clients/desktop |
| server/ | client-server.ts、client-pairing.ts、server-config.ts、aoq-chat-server.ts 等 | HTTP/WebSocket、认证配对和服务生命周期；共享协议按消费者归属，不复制到多处 |
| 已有 realtime/、executors/、memory/、knowledge/ | floor/playback、coding-executor、memory/context 等相关根文件 | 逐项追踪调用后归入已有模块；memory.ts 是核心状态模型时不与个人记忆存储强行合并 |
| config/、model/（视调用规模决定） | config.ts、environment-contract.ts、capability-registry.ts；model-gateway.ts、model-adapters.ts、prompting.ts | 配置、能力注册与模型调用分责；不为一个常量建立新目录 |
| 具体公共模块 | private-database.ts、native-file-lock.ts、canonical-json.ts、python-text.ts、unicode-*.ts 等 | 只有多个模块实际使用才提取公共归属；保留 Python 兼容语义与生成表标记，不建立通用 Manager |
| 验证支持 | fixture-host.ts、fixtures.ts、sim.ts、sims.ts、demos.ts、scorecard.ts 等 | 先核对 CLI 子命令和公开 exports；仅测试消费者可迁入 test/support，仍被产品使用的不能直接移走 |

### 迁移前必须完成

1. 列出 import/动态 import、Worker URL、相对资源路径、package exports、打包规则、脚本和测试中的路径消费者；以此确定每个文件的模块归属。
2. 记录当前跨模块循环和公开入口。通过引用方向收敛职责，不用大量 barrel re-export 隐藏循环，也不为每个搬迁文件新增兼容壳。
3. 检查 runtime/dist 与桌面构建的共享输出，以及 node-parity-audit、边界检查 allowlist、CLI 和 packaged worker 的路径依赖。

### 分批执行顺序

1. 先迁移职责清楚的 desktop/server 适配和 composition 文件，只改路径，不同时重写状态机。
2. 项目模块与共享 HOME 的职责解耦分别验证；service 状态归属重构仍按原子模块推进，不能将“移动目录”当作该重构已完成。
3. 再整理 core、模型与公共存储工具；优先复用现有 private-database 等实现，删除有证据的重复状态和无职责转发。
4. 最后处理验证支持与公开入口，核实打包可达性后减少生产产物中的非运行设施。

验收：类型检查、模块边界与定向测试、公开入口加载、Worker 启动、CLI/桌面打包后的资源路径和关键任务链路；需要 runtime/desktop 构建时串行执行。检查迁移后是否新增循环或重复实现。

计量：文件数、根层 TS 数、跨模块依赖变化与代码净减分别报告。根层减少只是组织改善；移动、改名和 import 改写不算删除收益。本轮没有迁移任何 runtime 文件。

### 同轮已授权的遗留文件清理

- 根目录 `src/` 经核对仅含 192 个未跟踪 `.pyc` 文件，共 4,373,729 字节，已删除；不是 `runtime/src/`。
- 本地 `.env` 删除 6 个当前运行实现不再读取的旧项：`NOVA_AUDIO_AGENT_UNDERSTAND_MODEL`、`NOVA_AUDIO_AGENT_DELIBERATE_MODEL`、`LANGGRAPH_STRICT_MSGPACK`、`NOVA_AUDIO_AGENT_ROVER_MCP_URL`、`NOVA_AUDIO_AGENT_ROVER_MCP_TOKEN`、`NOVA_AUDIO_AGENT_CODEX_PROJECTS_ENABLED`。
- 更新火山凭据注释为实际 TTS/ASR 回退关系；保留的有效配置赋值逐行核对未变。本文不记录任何配置值或凭据。
- 此清理不计生产源码净减少，不表示 runtime 重构已实施。

## 九、后续顺序与计量

1. local embedding 未实现入口清理。
2. 内部知识查询去 MCP 往返；随后处理有差分证据的小范围复用。
3. 共享 HOME 解耦与旧会话迁移设计，保留新建、标题及认证能力。
4. 同次连接重复认证消除；认证构建策略单独决定。
5. 继续全仓状态归属审查；图谱与 memory 联合评估，不沿用旧整目录删除预算。
6. 按第八节推进 runtime 目录组织，路径迁移与行为重构分批验证，不为根层文件数量设机械指标。

以上均为计划。实施时重新固定最新代码基线，生产/测试/脚本/文档分别记录新增、删除、净减；搬文件不算删代码，迁到依赖或 CI 的成本单列。旧分支历史收益不重复计入新计划。本轮生产代码修改及删除均为 0。

## 历史方案存档

原方案保留在退役 worktree 的同名文件，原始行数清单、CSV 和统计脚本一并保留。下文附原稿便于追溯；其图谱整块删除、外部后端接管项目、串行化主动播报等建议均须服从本文件最新决定，不是当前执行清单。

<details>
<summary>2026-09-12 历史原稿（已由上文更新，不作为当前执行清单）</summary>

# Nova 全仓架构瘦身方案与 50% 可行性

审查基线：独立 worktree `.worktrees/ponytail-simplify`，`feature/ponytail-simplify`，`53c0085a`。本轮只读代码并编写方案；未授权执行下列功能退役或重构。此文件统领全仓，service 子计划仅为其中一项。

## 结论

保留全部当前功能、平台及失败恢复契约时，现有证据不支持净删 50%。可以设计代码规模更小的产品，但达到减半必须重定职责：少管线、少客户端/平台、后端拥有项目生命周期、简化主动播报等，不能伪装成行为等价重构。

建议首先退役当前工作区图谱，然后处理跨模块状态归属，再以兼容性原型判断执行器协议替换。保留 Nova 的个人记忆、用户优先、用户批准执行和必要主动性，不能只为行数删掉产品差异。

## 计数口径与完整范围

固定比较分母为之前实测的 `src + native` 文本物理行 104,028，含注释与空行，不含字体二进制、test、scripts 和旧备份。减半要求净减 52,014 行。它是目录口径，不能再称为严格的全仓纯生产逻辑：其中有 README/LICENSE、生成代码和 fixture 支撑，也漏了非 src 布局的 iOS 等入口。

| 互不重叠目录组 | 固定基线行数 |
| --- | ---: |
| runtime/src 根文件 | 26,637 |
| runtime/src/realtime | 23,694 |
| clients/desktop（src+native） | 22,733 |
| runtime/src/executors | 14,860 |
| runtime/src/workspace-graph | 8,976 |
| runtime/src/knowledge | 2,433 |
| runtime/src/memory + voicemem | 1,840 |
| clients/webui/src | 2,030 |
| cli/src | 825 |
| 合计 | 104,028 |

明确修正：desktop native 含 README 83 行、WebUI 含字体许可 93 行；CLI 的266行由单源生成。固定分母漏 iOS app Swift 2,098 行、WebUI 根 host/server 330 行、CLI bin 11 行。这些归类调整不计为删除，也不能移动文件来完成减量目标。

测试 118,084 的旧口径为 runtime/test 91,672、desktop/test 25,413、WebUI/test 458、CLI/test 375，加 live contract 166。它也不包含所有根 tests 和 iOS Tests；必须和生产减量单列。不要将减半目标通过删除测试满足。

## 全仓决策表

| 范围 | 问题与判断 | 建议 | 计量与代价 |
| --- | --- | --- | --- |
| 工作区图谱 | 生产主要积累相邻项目切换的 weak discussed_with；任务完成无关系 cue；enrich/explain/suppress 未接通生产调用 | 退役当前集成，不另造小图谱 | 独立目录及两个 board 合计9,641行待删除范围；另有胶水，最终扣除共享导航等保留成本 |
| 实时服务与语音 | service交叉修改播报、工具和确认状态；provider管线有实际行为差异 | 保留一个会话协调入口、三个具体状态owner；管线取舍另决策 | service拆分先记0减量；单管线范围见下表，不把重写范围当删除 |
| CoreRuntime/CausalRuntime | 一者确定性状态决策，一者管理异步任务及持久化后启动，非重复实现 | 保留职责，减少重复状态投影与单次转发；不合成巨型runtime | 两文件合2,313行，不能全算可删 |
| 项目/执行器/审批 | Nova自管app-server、项目恢复、凭据和进程；通用协议只替代部分 | 先验证ACP替换边界；保留权限、回收和项目一致性 | codex目录11,536行并非协议包装全可删；等价替换2–4千仅为未验证预算 |
| 桌面主进程与renderer | 多窗口、设置、音频、原生资源和状态同步；部分已共享 | 主进程拥有OS资源，renderer拥有交互；复用已有表单和音频设施，去掉镜像状态 | 保留全部行为无可信万行删除块；视觉/基础表单取舍另列 |
| desktop transport/bridge/assembly | 序列化、身份校验、音频流控与构建关闭混杂，但不是同一层重复 | 明确原始消息校验→有类型命令→service；生命周期只由composition管理；清理无职责转发 | 四种队列有不同丢弃/优先级，不统一为普通FIFO；跨信任边界校验保留；净减未证实 |
| 项目、会话、个人记忆、知识库 | 内容可能重叠，但删除、提交与恢复语义不同 | 项目事实在project store；会话事件在blackboard；长期事实交给已有VoiceMem；人工文档归knowledge | 不合并成通用MemoryManager。VoiceMem891行已是外部引擎适配；知识库约2.4千，不是图谱附属 |
| WebUI/iOS/CLI/原生平台 | 多入口有实际产品成本，WebUI已共享desktop音频/视觉模块 | 保留共享协议，核查剩余重复；是否停止支持某入口需产品决策 | iOS不在固定分母内，删iOS不能计入104,028的减量；Windows删除会失去该平台 |
| 测试/fixture/兼容/脚本 | 旧功能测试可随退役删除，现用回归不能因名字旧删除 | 按退役能力移除测试；保留跨模块行为和故障恢复，开发设施从生产打包隔离 | 独立test fixtures约2.2%，不能把11.8万行全称布局重复；归类/移动不算全仓删减 |

## 图谱：优先退役范围

1. 删除 workspace-graph 目录、runtime/realtime/workspace-graph-board.ts（335）、desktop workspace-graph-board.mjs（330）及专属界面接线。
2. 从 realtime-assembly 删除图谱observer、实例映射、写入队列和graph header；从core context/prompt中删除图谱材料；去掉图谱开关与provider配置。
3. 保留 `workspace_context` 通道：它同时携带权威的 active project 与 active executor 状态。保留项目切换、工具授权、普通记忆窗口和个人记忆/知识库。
4. 现有图谱DB不自动删除。图谱专属用例退役；共享导航、默认无图谱运行和项目上下文用例保留。
5. 验收：设置/记忆面板无悬空入口，项目切换与任务运行正常，个人记忆和知识库正常，无图谱worker/import/配置依赖。

实际损失：弱跨项目提示、图谱header、图谱历史诊断展示。接口存在但没有生产调用的外部 enrichment/解释/抑制，不应当作为现有用户已经拥有的完整能力宣传。

## 语音管线：互斥选项

| 选择 | 独立待替换范围 | 保留/替代成本 |
| --- | ---: | --- |
| 只保留Qwen原生实时音频 | cascaded 2,316 + Volcengine 4,237 + cascaded assembly417 + config149 = 7,119 | 视觉复用的图片校验不能删；草稿听写仅级联实现，保留听写须保留或替换ASR链 |
| 只保留级联 | Qwen原生音频adapter/transport1,555 + qwen/integrated assembly218 = 1,773 | 级联内部的Qwen文本LLM不是原生音频adapter；Volc ASR/TTS/endpointing需保留 |
| 保留两条管线 | 暂无整块可删额度 | 聚焦状态归属与重复边界，不抽象到丢失两者协议差异 |

主动播报串行化是另一项产品决定：普通主动事实等当前轮次结束，不主动抢占。service约503行主动抢占恢复及约1,095行混合调度需重写，均不是可全删行数。用户打断、工具输出补偿、普通去重和确认不能随之移除。若紧急提醒仍是核心需求，不建议为行数取消。

## 执行器与项目职责：先原型，不直接换库

当前不重叠范围：codex11,536、其他executors3,324、根project*.ts4,822、approval/approval-port/coding-executor1,745，合21,427行。

Qwen的ACP client+adapter+registry+tools+utils+profile也有2,563行，并依赖外部SDK和codex-acp。它的connection close/SIGTERM、JSON registry不等价于Nova进程树归属、Windows guardian、credential snapshot与project journal。

兼容性原型必须覆盖：取消后实际停止、迟到进程回收、审批撤销、项目切换期间旧结果隔离、会话恢复、失败重开。只有这些通过且全套适配净减成立，才接受ACP迁移。

另一种方案是让外部后端拥有workspace/session管理，Nova只保存已选项目引用。这样才能连项目创建、维护、事务恢复一起收缩，但会改变现有项目管理体验；单独记作产品改版。禁止将协议替换、项目管理删除与审批UI删除的预算直接相加。

## 客户端：先结构整理，再讨论明显取舍

全功能整理：保持OS资源在main、视图在renderer；已有WebUI共享音频/Orb、CLI配置生成不重复计收益。音频关闭、wake epoch、权限/秘密设置等差异必须保留。

可选产品裁剪（估计，尚未实现）：

- Orb粒子效果1,467行改基本状态视觉，净减约1,167–1,317；视觉明显改变。
- 专门设置四文件2,397行改基础表单，净减约1,397–1,797；仍须实现秘密字段、保存失败、权限处理，不能只删界面。
- 不提供WebUI涉及1,937行src源码及根入口；固定分母只计src，许可单列。
- 不提供Windows涉及2,347行三份原生C及胶水；项目原生安全代码不能因删桌面窗口顺带移除。
- macOS原生音频改浏览器音频涉及至多1,173行现有实现，须扣替代代码并验证回声/打断；不建议仅为减量贸然采用。

不建议把上述全部打包成默认方案。保留个人/移动使用场景时，砍平台或客户端可能降低产品价值。图谱board已在图谱项计数，不再次计入“删记忆面板”。

## 核心与存储的具体替代边界

CoreRuntime+CausalRuntime 的2,313行保留确定性决策与异步持久化屏障。ModelGateway+adapters602行被intake、vision、watcher、Surrogate和压缩调用，不能判为旧模型兼容层。

- worker client 的request ID/pending/error机械部分可考虑窄共享，净减100–250行仅为未验证工程估计；Blackboard单个未确认写入、Personal独立取消和Knowledge关闭排空不能被抹平。
- ProjectStore→SQLite 可能减少JSON状态替换、锁与版本管理，净减300–800行是原型预算；外部目录操作、身份校验、Codex恢复仍要journal与补偿，SQLite不能原子提交文件系统操作。此方案与“项目完全交给外部后端”互斥。
- 将会话与个人记忆改用同一个source log需要消费游标、重试、forget及长期来源策略，第一阶段可能增代码，不列为减量捷径。
- 个人记忆改成远端唯一部署最多涉及本地891行adapter，仍有迁移和运维成本；不建议仅为删代码取消本地能力。
- Knowledge若完整退役涉及2,433行目录；若仍需授权导入、删除、重建和citation，外部检索替代必须先验证相同契约。当前不建议连同图谱一起删除。

## 测试、验证工具和兼容退役

118,084行中，案例文件115,013、独立test fixtures2,587、其他支持484。测试内仍有mock/setup，案例文件不等于全是断言；但没有证据称其主要是独立JSON布局。

| 产品退役前提 | 不重叠测试候选文件范围 | 行数 |
| --- | --- | ---: |
| 完整图谱退役 | 12份workspace-graph测试及runtime/desktop图谱board | 8,939 |
| 退役Qwen原生实时管线 | adapter、transport、normalization、assembly四文件 | 2,920 |
| 退役级联/Volcengine管线 | 六份cascaded加十一份Volcengine文件 | 10,384 |

两种管线测试取舍互斥；保留ASR等子能力就保留对应测试。通用service/provider-session/assembly不能整文件删。图谱board内通用键盘导航测试也要保留。

src里的fixture-host/fixtures/sim/sims/scorecard/demos/session-fixtures/executors-fixture共2,198行是验证设施混入目录口径，CLI命令与公开exports仍使用；移到测试目录只是澄清口径，不计删除。旧Volcengine oracle仍覆盖当前级联行为；journal/locator等兼容是否保留取决于现用数据消费者，不能按旧名字删。

## 50%算术与证据边界

最明确的两个独立功能范围：图谱9,641 + 只留integrated的另一管线7,119 =16,760行，约固定基线16.1%。即使两块全删除且不用替代，距离52,014还差35,254行；实际听写等替代会进一步扣减。

因此不能从“图谱约一万、service主文件缩五千、ACP一万、客户端一万”拼出50%：service是搬迁、ACP不是全删、客户端与图谱/原生有交叉，都会重复或虚增。

三种结论：

- **全行为保持：**能继续改善维护性，但目前没有50%的删除依据；不报虚构全仓净减区间。
- **推荐瘦身：**先图谱退役+状态归属重构+通过验收的协议替换；预计图谱是首个约万行级退役候选，其余按实现成本补账，不预支收益。
- **强制减半：**重新设计一个更窄产品：单语音管线、外部后端拥有项目生命周期、更基础的桌面、减少主动抢占与部分平台/入口；需要完整替代原型测量。当前尚不能把“52,014行以内”当成已证明可达的交付承诺。

## 实施依赖与审查节点

1. **固定测量清单与验收。** 为生产、测试、生成物、开发设施及外部依赖分别列文件清单；继续保留104,028兼容统计，不悄悄换分母。记录关键用户链路。
2. **图谱退役，独立交付。** 先解绑共享入口，再删专用实现和测试，验证项目上下文/记忆；精确报告生产及测试净量。无需等待service重构。
3. **实时/核心状态归属。** 按service子计划推进三个owner；同时核查core与assembly的状态传递，保留单份origin、epoch和生命周期权威。不能由多个agent同时改service共享状态。
4. **执行器协议兼容性原型。** 可在独立范围并行调研，正式替换需兼容性与净量证据；成功后再决定是否重画项目管理边界。
5. **桌面传输与客户端整理。** 先固定协议与资源拥有者，再收敛无职责转发和镜像；图谱UI先行清理不干扰其余页。
6. **管线/平台产品取舍。** 必须单独确定哪些能力不再支持；选择后成组删除配置、构建、文档和专属测试。用户当前仅要求分析，尚未授权这些变更。
7. **最终验收与总账。** 串行构建后完整runtime/desktop测试、check:built、真实Chrome；实际provider和跨平台结果单列。总diff扣除新增代码，依赖承接成本单列，移动与格式变化不计收益。

每组做完记录：实际源码新增/删除/净减、删除的产品行为、残余兼容、测试新增/删除/结果、新依赖、外部实现转移、未覆盖平台。只有净删除与用户行为取舍都清楚，才继续下一组。

## 关联子计划

`../superpowers/plans/2026-09-12-realtime-service-refactor.md`：只覆盖service状态归属。该子计划不是全仓完成凭据，也不意味着图谱或功能裁剪已执行。

</details>
