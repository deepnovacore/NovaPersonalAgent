# Space / Host / Client 实施 Handoff（入口）

日期：2026-10-23  
基线：`v1.0.0dev`，`ecb533f9`  
状态：设计已讨论定稿，**尚未写任何产品代码**。本文档组交给执行同事，按 §6 的顺序阅读。

## 0. 文档组与阅读顺序

| 顺序 | 文档 | 内容 |
|---|---|---|
| 1 | 本文 | 前因后果、决策记录、范围、开放问题、约束 |
| 2 | [`2026-10-23-space-host-client-architecture.md`](2026-10-23-space-host-client-architecture.md) | 目标架构：角色、relay、信封、配对、展示契约、意图、聊天流、推送 |
| 3 | [`2026-10-23-space-host-client-migration-map.md`](2026-10-23-space-host-client-migration-map.md) | 现有代码逐模块去留、受影响调用方与测试、易错点 |
| 4 | [`2026-10-23-space-host-client-milestones.md`](2026-10-23-space-host-client-milestones.md) | M0–M7：范围、依赖、退出证据、分工建议、验收矩阵 |
| 5 | [`2026-10-23-space-host-client-push-research.md`](2026-10-23-space-host-client-push-research.md) | APNs / FCM / 小米推送的调研事实、来源、置信度 |
| 参考 | [`2026-10-23-space-host-client-direction.md`](2026-10-23-space-host-client-direction.md) | 讨论纪要（含 nanoMuse 对照、codex 评审后的修订） |
| 参考 | [`2026-10-23-pc-owned-background-work-handoff.md`](2026-10-23-pc-owned-background-work-handoff.md) | 起点文档：PC 执行后台任务、手机接收结果 |

### 证据标记

全组文档统一使用：

- ✅ **已决定**：产品负责人明确确认的决定。
- 💡 **建议**：作者提出、尚未经产品确认或评审的设计。可以推翻，但要说明理由。
- ❓ **开放**：没有结论，需要决定。
- ⚠️ **未验证**：来自文档页面、静态阅读或一般知识，没有真机或运行证据。

除特别说明外，代码结论来自静态阅读；其中 Hub 模块清单来自一个子代理的 grep 级盘点，**行号与调用方清单没有逐条复核**（见架构文档与迁移图中的标注）。没有运行任何构建、测试或真机验证。

## 1. 前因后果

### 1.1 产品定位

做一个 personal agent，对标 today.ai / muse / instinct 一类产品。差异点只有两个：

1. **self-host**：用户可以自己部署全部服务端部分。
2. **纯端侧（隐私）**：agent runtime 与用户 context 留在用户自己的设备上，**runtime 永远不跑在云端**。

端侧不想做得太弱、太受限，所以采用类似微信的形态：我们只提供**中转 relay**，relay 开源，可自托管，也提供我们托管的版本。

relay 的直接用途：PC 端会产生 proactive 生成、定时任务等结果，需要同步、推送到手机。

### 1.2 起点问题

起点文档 [`pc-owned-background-work-handoff`](2026-10-23-pc-owned-background-work-handoff.md) 描述的目标是：phone / PC / Hub 都在线时，手机不执行 proactivity 与定时任务，由 PC 执行，结果推给手机。该文档的核心结论是：

- 现有版本有主设备身份、任务 owner、跨端数据同步的基础，但**没有完成端到端行为**。
- 最大风险是把“主设备发布权限”“任务执行 owner”“设备在线状态”当成同一个概念。

### 1.3 为什么要重新定模型

现有 Hub 同时想要：主设备可转移（`authority prepare/ack/commit`）、定时任务 owner 可交接（`schedule-owners/handoff`）、手机与 PC 双写 Life 数据（`life-sync.ts` 双写 outbox）、在线状态相关逻辑。这些能力彼此牵制，**主从权在运行时可转移，与“手机可独立运行”“结果可靠到达”不可兼得**。结论是必须取舍，而不是继续叠加机制。

### 1.4 讨论中走过的弯路（避免重复）

| 阶段 | 当时的想法 | 为什么放弃 |
|---|---|---|
| 1 | 手机是 PC 的遥控器 | 手机本来就能独立运行（聊天、feed、完成待办），独立模式是产品选项 |
| 2 | 所有设备对等，多写入方 | 带回合并语义、后台任务归属、fencing，正是现有 Hub “什么都要”的来源 |
| 3 | 从设备“只单向接收” | 用户动作、手机采集输入、聊天必须回流；改成“状态单向、意图双向” |
| 4 | Host 做加密备份与恢复 | 用户决定不做：Host 损坏即空间丢失。注意只取消**备份**，relay 的 E2E 不变 |

## 2. 决策记录

状态均为 ✅，来源是与产品负责人的对话（2026-10-23），除非另注。

### 2.1 模型与拓扑

| ID | 决策 |
|---|---|
| D1 | 只有三个用户概念：**Space**（一套独立的数据与密钥）、**Host**、**Client**。relay 是基础设施，不是用户概念。命名是讨论中提出的，界面文案可以再定 |
| D2 | 安装后可创建多个相互独立的 Space；每个 Space 在创建时二选一：**独立运行** 或 **作为 Client 绑定 Host**。运行时不转移主从权，不做按在线状态的选主 |
| D3 | Space 是本地空间（一套密钥和数据），**不是云端注册账号** |
| D4 | 一个 Space 一个 Host，N 个 Client。首期 Host = 桌面端，Client = 手机 |
| D5 | 角色按 Space 定义，协议不假设设备类型。PC 作为 Client 接入别的 Host：**协议预留，首期不做** |
| D6 | Hub 并入 PC Host；relay 与 Hub 拆开，relay 只做盲中转 |
| D7 | 切换模式 = 新建 Space，不做迁移（预研产品，不写兼容层；这一条产品负责人强调“很重要”） |
| D8 | Host 损坏即 Space 丢失，**不做备份恢复**，产品上明说 |
| D9 | Hub 的主设备交接、schedule handoff、在线选主代码**直接删除** |

### 2.2 数据流与聊天

| ID | 决策 |
|---|---|
| D10 | 状态单向（Host → Client）；用户动作与手机采集输入作为**意图**回传 |
| D11 | Client **没有本地聊天**，聊天一律转给 Host；Host 离线时明确不可用，不排队 |
| D12 | 聊天回复需要**流式**显示 |
| D13 | 流只是实时预览；Host 生成结束后把完整回复落入信箱，Client 重连按游标补全，用消息 ID 去重，不重复调用模型 |
| D14 | 展示契约版本化、只增不改；未知字段忽略；未知卡片类型降级成通用文本卡；配对握手交换协议版本 |

### 2.3 relay、加密、推送

| ID | 决策 |
|---|---|
| D15 | relay 开源、可 Docker 自托管，也有我们托管的版本；只见不透明空间 ID、密文、游标 |
| D16 | relay 为**端到端加密**（配对时交换密钥）；hosted relay 也看不到内容 |
| D17 | **锁屏通知首期必须做**（产品负责人强调“很重要”） |
| D18 | iOS 锁屏通知一律经我们的 push gateway（APNs 凭证绑定 App 发布者）。接受并**公开说明**元数据边界：gateway 可见“设备令牌 + 时间 + 密文大小” |
| D19 | Android 首期只做 FCM；国内无 FCM 的设备首期不保证锁屏到达 |
| D20 | 小米：保留 E2E，通知使用**公信通用文案**，接受每设备每应用每天 5 条的配额，**不承诺“小米私信不限量”**；超配额靠 App 内补拉 |
| D24 | relay 取代 Tailscale 作为产品的连接方式；relay 底层可以评估基于 Tailscale 实现，但尚未选定技术方案。不给用户保留两套连接流程作为默认要求 |
| D21 | 预研阶段不写迁移/兼容层，旧状态直接重置 |

### 2.4 分支与流程

| ID | 决策 |
|---|---|
| D22 | 2026-10-23 更新：产品负责人授权将当前文档分支（包含 `v1.0.0dev` 的 `ecb533f9` 基线）推送为 `fork/v1.1.0dev`；本地仍为 `docs/space-host-client-handoff`。此授权替代此前“等标签后才创建该远端分支”的限制，不表示已经开始产品实现 |
| D23 | 关键设计用 codex 评审，只跑一轮，由负责人把握严重度，有争议的点向产品负责人提问 |

## 3. 范围

### 3.1 首期范围内

- relay：密文信箱、实时流通道、在线状态、唤醒；扫码配对、设备撤销与密钥轮换；Docker 自托管。
- Host：并入 Hub 的 Life / context / routing 逻辑；主动连出 relay；处理 Client 意图与聊天转发。
- Client（手机）：创建 Space 二选一；版本化展示契约渲染；意图回传；聊天转发与流式显示；锁屏通知。
- push gateway：APNs（含 Notification Service Extension）、FCM、小米。
- 删除：见迁移图。

### 3.2 首期范围外

- PC 作为 Client（协议预留，不实现）。
- 平权 / 多 Host / 在线自动选主 / 手机接管后台任务。
- Host 备份与恢复；模式切换时的数据迁移。
- Android 国内非小米、无 GMS 渠道（华为、OPPO、vivo、荣耀等）。
- Client 的本地 runtime、本地聊天。

## 4. 现状要点（静态阅读，⚠️）

完整模块级清单在迁移图。这里只给最影响判断的几点：

1. Hub 的命令通道只有 `start` / `cancel` 两种命令（`runtime/src/hub/routing.ts:8-11`），目标离线直接失败（`:50` 附近，presence 90 秒过期），deadline 上限 15 分钟。没有“完成待办”“聊天”“手机输入”类型，没有通用 Host → Client 事件与流。
2. 同步实体只有 goal / todo / idea / profile.about（`runtime/src/hub/life-projection.ts:9-14`），**没有 Timeline**，投影 schema 没有带出实体 `version`。
3. 手机端现有的 Life 同步在 `clients/flutter/lib/personal/local_life.dart`：持久化 pending 意图（`:146` 附近）、创建后 ID 重映射（`:249` 附近）、冲突保留（`:266` 附近）。这些语义是新方案**必须保留**的（见架构文档 §7）。
4. 手机端**没有** APNs / FCM / entitlement / Firebase 依赖。现有后台能力只有 iOS BGAppRefresh（`clients/flutter/ios/Runner/NovaScheduleBridge.swift`）与 Android JobService（`clients/flutter/android/app/src/main/kotlin/com/nova/nova_mobile/NovaScheduleBridge.kt`），15 分钟一次，只发本地通知。
5. Flutter 里有两个都叫 authority 的东西：`device/space_authority.dart`（空间主设备，删）与 `device/authority.dart`（任务授权与 fence，**留**）。改动时极易误删。

## 5. 开放问题（需要决定或验证）

| ID | 问题 | 倾向 / 建议 |
|---|---|---|
| O1 | relay 是否取代 Tailscale？ | ✅ 已确认，见 D24。底层是否复用 Tailscale 仍待技术评估；局域网直连是否需要另议，不自动保留旧连接流程 |
| O2 | Client 是否提供手机系统工具，例如读取日历、创建系统提醒、用户参与的拍照或设备操作？须区分“执行 Host 指定的明确动作”与“手机自行调用模型、规划并完成多步目标” | ❓ 建议保留前者：Host 规划，Client 校验权限、执行动作并回执；不在 Client 保留独立 Agent 循环。尚未获产品确认，详见架构文档 §5.4；不能直接保留整个 `device_run_task` 并声称不需要 runtime |
| O3 | Host 离线时错过的定时槽：跳过、只补最近一次、还是逐次补跑？ | ❓ 起点文档 §4-C 的原问题，尚未决定 |
| O4 | 展示契约的字段清单与最低版本协商 | ❓ M3 的首要产出 |
| O5 | 托管 relay 的滥用、配额、创建准入 | ❓ 空间 ID = 公钥只证明持钥，批量生成公钥可绕过按空间配额（codex 评审，推断）。见架构文档 §11 |
| O6 | 小米：助手类消息归类、透传消息能否可靠唤醒被杀进程、国内与海外服务器差异、包名与签名校验 | ❓⚠️ 官方页面未覆盖，M0 真机与向小米确认 |
| O7 | E2E 的具体密码学设计（原语、多 Client 密钥、撤销后轮换、NSE 与主 App 共享密钥） | ❓ **上线前必须经密码学评审**，不要自造协议 |
| O8 | relay 与 push gateway 的代码放哪（本仓库新增包，还是独立仓库）、如何发布与部署 | 💡 建议同仓库新增独立包，便于共享契约与测试；托管地址只作部署配置 |
| O9 | 一次安装里多个 Space 的本地数据隔离与切换 UI | ❓ 讨论中只确定“每个 Space 独立”，没展开 |
| O10 | 手机推送在通知系统里的位置：是新增第三个渠道，还是并入现有“Nova 展示适配器”？见 `docs/proactive-notification-channels.md` | 💡 建议作为新的 `NotificationChannelAdapter`（见架构文档 §10.6） |
| O11 | Client 冷启动或游标过期、信箱已清理时如何重建状态 | ❓ 见架构文档 §6 的两个方案 |
| O12 | 通用通知文案的具体文字与国际化 | ❓ |

### 开工前必须先核实的事项（V）

这些是静态阅读留下的缺口，**先核实再动手**：

| ID | 事项 |
|---|---|
| V1 | 子代理报告 Hub 的 `store.ts` 内含 Life reducer 与 `hub_*` 表，即 Hub 持有一份 Life 副本。需确认 Hub 的 Life 数据与 PC 上 `PersonalStore`（`runtime/src/personal-agent/life.ts` 一带）的关系，并入后只应保留**一份权威副本** |
| V2 | 未读：`runtime/src/personal-agent/scheduled-tasks.ts`、`clients/flutter/lib/agent_core/scheduled_agent_runner.dart`、`clients/flutter/lib/device/attempt.dart`、`task_ledger.dart`、`todo_sync.dart`、`runtime/src/hub/ui/*`、`runtime/src/hub/cli.ts` |
| V3 | 调用方清单是 grep 结果，可能漏掉动态调用；删除前用全仓搜索与类型检查复核 |
| V4 | `routing.ts` 的 `/commands` 在运行时只发现 `client-cli.ts:97` 一个消费方，需确认桌面端是否真的消费 desktop 能力命令 |
| V5 | 起点文档 §7 的“自主触发入口盘点”仍未完成：PC 与手机所有 proactivity 入口及其调用链 |

## 6. 建议的启动顺序

1. 读完本组文档，跑一遍 V1–V5。
2. **M0 风险 spike** 与 **M1 relay 骨架**可并行启动。M0 需要的账号与证书见里程碑文档 §M0 前置。
3. M3 的契约设计可以与 M0 并行（纯文档与 schema，不依赖推送）。
4. 当前只做 spike 与文档，不在 `v1.0.0dev` 上提交产品代码；远端文档分支按更新后的 D22 命名为 `fork/v1.1.0dev`。

## 7. 项目约束（`AGENTS.md`）

- **公开 / 内部分支**：`v0.2.0dev` 与发布分支是公开的；公司试点只在 `internal`。relay 与 push gateway 属通用能力，走公开分支。**不得**嵌入组织域名、员工数据、租户标识、内部端点、部署文件；托管 relay 的地址只作部署配置。公开修复可以流入 `internal`，反向不行。
- **角色 / IP 素材**：与本方案无关，但任何示例、截图、测试 fixture 不得带未审批角色或衍生媒体。
- **构建隔离**：构建输出与编译器缓存放用户指定的外置盘（本机为 `/Volumes/sqxh-junjie`），先确认已挂载，不得悄悄回落到系统盘；输出目录按**规范化 worktree 路径 + chat ID** 命名；只清理当前 chat 的输出目录，不要清理共享的 `runtime/dist` 或桌面构建目录。
- **推送**：先推 `fork`，确认后再推官方 `origin`。文档已提交；远端目标为 `fork/v1.1.0dev`，推送完成情况以 Git 远端引用为准。
- **预研阶段**：不写兼容层；旧状态直接重置。
- **删除前**：删除可工作代码之前，先备份到专用分支（例如 `backup/pre-space-host-client-<sha>`），不要只依赖 git 历史。
- **文档措辞**：沿用项目术语（proactivity 用 “push-and-pull”；抢占用 Floor / priority / preempt / defer；用 “executor” 不用 “lane”）。README 改动受 `runtime/test/documentation-contract.test.ts` 约束，环境变量文档由 `runtime/src/config/environment-contract.ts` 生成。

## 8. 本组文档的存放与状态

- 位置：独立 worktree `/Volumes/sqxh-junjie/worktrees/nova-audio-agent/docs-space-host-client-handoff`，分支 `docs/space-host-client-handoff`，基于 `v1.0.0dev`（`ecb533f9`）。
- 状态：首批文档已提交为 `cc142e8d`；后续讨论更新继续在此分支提交。主检出 `/Users/fishwowater/sqxh/nova-audio-agent` 的 `docs/design-notes/` 下另有两份同名未跟踪副本（起点文档与讨论纪要），以 worktree 内的版本为准。
- 当前新增内容仅为文档；本地分支名不变，远端名称按 D22 为 `v1.1.0dev`。

## 9. 来源索引

仓库内：`AGENTS.md`；`docs/proactive-notification-channels.md`；`docs/development/HUB-PAIRING.zh-CN.md`、`HUB-PAIRING-IMPLEMENTATION.md`、`hub-console.md`；`docs/ASSET_PUBLICATION.md`。

外部（均为 2026-10-23 读取的页面摘要，见推送调研文档的置信度说明）：

- 小米推送消息限制说明：<https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1656>
- 小米推送产品说明：<https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1533>
- 小米私信场景规范：<https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2321>
- 小米推送新规报道：<https://finance.sina.com.cn/tech/digi/2026-07-04/doc-inifscxw9298561.shtml>
- FCM Android 接收消息：<https://firebase.google.com/docs/cloud-messaging/android/receive-messages>

nanoMuse（`~/sqxh/nanoMuse`，**本地检出不完整，只有 33 个 `.py` 文件**，结论来自其 `docs/{hub,sync,every-device,cloud,privacy,roadmap}.md`，未读实现）：见讨论纪要 §7。
