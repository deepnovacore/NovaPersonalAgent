# Space / Host / Client：产品方向讨论纪要

日期：2026-10-23  
基线：`v1.0.0dev`，`ecb533f9`  
状态：产品讨论结论，未实施，未经 codex 评审。承接 [PC 执行后台任务、手机接收结果](2026-10-23-pc-owned-background-work-handoff.md)。

证据等级：除特别标注外，代码结论来自静态阅读（含子代理的 grep 级盘点，未逐条复核）；nanoMuse 与小米推送的结论来自文档页面，未读实现、未做真机验证。

## 1. 产品定位

personal agent，差异点是 **self-host** 与 **纯端侧（隐私）**。原则：agent runtime 不跑在云端；relay 只做中转，开源，可自托管，也提供我们托管的版本。

## 2. 核心模型

只有三个用户概念：

| 概念 | 含义 |
|---|---|
| Space | 一套独立的数据与密钥。本地空间，不是云端注册账号 |
| Host | 持有 runtime 与 context 的桌面端；原 Hub 并入 Host |
| Client | 接入某个 Space 的手机 App，没有自己的 runtime |

- 创建 Space 时二选一：**独立运行**（完整移动端能力，无 relay，无同步）或 **作为 Client 绑定 Host**。
- 一个 Space 一个 Host，多个 Client。运行时不转移主从权，不做在线选主。
- 角色按 Space 定义，协议不假设设备类型。PC 作为 Client 接入别的 Host：协议预留，首期不做。
- 切换模式等于新建 Space，不做迁移（预研产品，不写兼容层）。
- Host 损坏即 Space 丢失，不做备份恢复，产品上明说。

### 为什么不平权
平权意味着多个设备有 runtime 与写入权，会带回合并语义、后台任务归属、旧执行者恢复后的 fencing，也就是现有 Hub “什么都想要”的来源。

## 3. 数据流

- **状态单向**：Host → Client。timeline、profile 的 about、待办、目标、feed 卡片、通知。
- **意图回传**：Client → Host。完成待办、忽略卡片、手机采集输入（相机、日历、提醒、位置）。意图带幂等 ID，Host 落盘后回投影。
- **聊天**：Client 无本地聊天，一律转给 Host；Host 离线时明确失败，不排队。回复流式显示；流只是预览，Host 生成结束后把完整回复落入信箱，手机重连按游标补全，以消息 ID 去重，不重复调用模型。
- **展示契约**：Host 推版本化的结构化数据，Client 原生渲染。规则只增不改，未知字段忽略，未知卡片类型降级成通用文本卡；配对握手交换协议版本。

## 4. relay

小而盲：
- 密文信箱（状态、事件、意图）+ 短时效实时流（聊天）+ 在线状态 + 内容无关的唤醒。
- 端到端加密：扫码配对时交换密钥，relay 只见密文与游标；撤销设备时轮换空间密钥。
- 无云账号：relay 只见不透明空间 ID；空间 ID 可取公钥，消息签名，按空间设配额。托管版如何限流与防滥用是开放问题。
- 可 Docker 自托管。

## 5. 锁屏通知（首期必须）

| 平台 | 方案 | 状态 |
|---|---|---|
| iOS | 必须经我们的 push gateway（APNs 凭证绑定 App 发布者）；`mutable-content` + Notification Service Extension 在端上解密，失败降级通用文案；不依赖静默推送 | 未验证，需真机 |
| Android | 首期只做 FCM；用纯 data 消息交给 App，在 `onMessageReceived` 里解密后发本地通知（官方页面确认后台状态会触发；被杀/force-stop、Doze、Android 12+ 后台限制页面未覆盖）。国内无 FCM 设备首期不保证锁屏到达 | 机制已由文档确认，到达率未验证，需 M0 真机 |
| 小米 | 见下 | 官方页面摘要，未验证 |

隐私说明需公开写明：gateway 可见“设备令牌 + 时间 + 密文大小”。

### 小米推送（Mi Push）
- 通知栏消息由系统通道展示，App 进程不必常驻；设备在线才送达；离线缓存公信最长 1 天、私信最长 10 天。
- 分类：私信（聊天、日程管理、行程提醒、任务进程等，不限量）；公信（内容/营销，有配额，“AI互动”“内容推荐”列在其中，无新闻资质时每设备每应用每天 5 条）；默认（每设备每应用每天 1 条）。
- 2026-08-01 新规：私信限 41 个场景且须模板接入，**2026-12-31 前未完成私信模板接入会影响私信下发**。
- 助手类消息归类官方页面未明说；透传消息的唤醒与配额页面未提；Mi Push 是否可读 payload 未说明，按可读处理。
- 对设计的影响：
  1. 通知栏消息由系统直接展示，App 无法像 iOS NSE 先解密。通知文字要么用通用文案，要么用透传消息让 App 解密后发本地通知，后者的可靠性必须真机验证。
  2. 官方规则（codex 提示，已读原文核实）：私信“好友聊天”排除“AI发起的聊天”，且主副标题均为模糊内容算违规（例：“你好 / 你收到一条新消息”）；“AI互动”归公信。因此 E2E + 通用文案在小米上大概率不符合私信规范，会落入公信配额（无新闻资质每设备每应用每天 5 条）。聊天回复应带发送人与实际内容才合规，与 E2E 冲突。首期承诺不能写成“小米私信不限量”。

  **决定（用户，2026-10-23）**：小米上保留 E2E，通知用公信通用文案，接受每设备每应用每天 5 条的配额，不承诺私信不限量；超配额时靠 App 内补拉。
  2. 同样需要我们的 push gateway。
  3. 聊天回复与用户设定的提醒争取归私信；AI 主动推荐可能是公信，只发“有新内容”的通用唤醒。

## 6. Hub 盘点（haiku 子代理，grep 级）

**删除**：`space-authority`（TS 与 Dart）、schedule handoff 与 owner-revision 对账、`life-sync.ts` 双写 outbox（由 Client 意图取代，改动最大）、authority 转移 UI、`life_host.dart` 中的转移逻辑。

**保留并入 Host**：Life reducer、`life-projection`、`routing` 的任务投影与阶段规则、`context-sync`（去掉 primary 门槛）、schedule claim/checkpoint。这些模块读明文，在 Host 上解密后处理，不阻碍 relay E2E。

**搬到 relay**：`routing` 的 presence/inbox/ack/deadline，`store` 的信封存取与配对邀请。其余 relay 代码是新写。

**取代 `life-sync` 时必须保留的语义**（codex 评审，已对照 `clients/flutter/lib/personal/local_life.dart` 核实）：持久化 pending 意图（`op_id`、`entity_id`），提交后断网/退出不丢、沿用原 ID；创建后新旧 ID 重映射并改写后续 pending 里的 `goal_id`/`idea_id` 引用（先建目标再建关联待办的依赖顺序）；冲突反馈（两端改 about 需版本冲突，不能静默覆盖）。仅写“意图带幂等 ID”不够。保留这些语义不要求保留双主。

**投影契约缺口**：`runtime/src/hub/life-projection.ts` 的同步实体只有 goal/todo/idea/profile.about，没有 Timeline；`LifeState` 与 reducer 有 `version`，但投影 schema 未带出。M3 需补 Timeline（含忽略状态）与版本字段。

**命令通道缺口**：只有 `start`/`cancel`；没有完成待办、聊天、手机输入类型；目标离线即失败无队列；无通用 Host→Client 事件与流；请求体 64 KB。

**推送**：手机端没有 APNs/FCM/entitlement/Firebase，只有 iOS BGAppRefresh 与 Android JobService 的 15 分钟本地通知，全部是新做。

**易错点**：Flutter 里 `device/space_authority.dart`（删）与 `device/authority.dart`（任务授权与 fence，留）重名；`profile_agent.dart`、`profile_repository.dart` 依赖 `space_authority`。

**未读**：`scheduled-tasks.ts`、`scheduled_agent_runner.dart`、`todo_sync.dart`、`hub/ui/*`、`hub/cli.ts`。

## 7. nanoMuse 对照（文档级，本地检出不完整）

可借鉴：设备端 runtime；每设备一条出站 WebSocket（无需开端口）；按设备签发可撤销密钥；对话同步用单调游标 + 幂等键 + 墓碑；连接背压上限。

它的局限：呼叫离线设备直接失败、无队列；无 APNs/FCM；同步内容无 E2E，hosted 版保存 IP/UA 并默认留存训练数据；记忆、目标、feed 不跨设备同步；工作状态只在内存。不要照抄它的 hosted 数据策略。

## 8. 里程碑草案

| # | 内容 | 验收证据 |
|---|---|---|
| M0 | 风险 spike：iOS APNs + NSE 解密、FCM、小米（被杀进程、锁屏、透传 vs 通知栏）、WebSocket 流式 | 真机截图/录屏；降级文案生效；流式延迟记录 |
| M1 | relay + 配对：密文信箱、游标、ack、deadline、签名与配额、扫码配对、撤销与密钥轮换、Docker 自托管 | 直读存储只见密文；撤销后旧设备无法收发 |
| M2 | Host 并入 Hub，删除 TS 侧 authority/handoff | Host 重启后游标续传；既有 runtime 测试通过 |
| M3 | 展示契约 + Space 创建二选一 | 版本错位测试；未知卡片降级 |
| M4 | Client 意图，取代 `life-sync.ts` | 重复提交不重复变更 |
| M5 | 聊天转发 + 流 | 流中途杀 App，重开得完整回复且不重复调用模型 |
| M6 | push gateway：APNs+NSE、FCM、小米 | 真机锁屏收到，点击后补拉；gateway 日志无明文 |
| M7 | 清理 Dart/TS 遗留，改写 README 与 docs | 无残留引用；`documentation-contract.test.ts` 同步更新 |

依赖：M1 → M2/M3/M5/M6；M0 可与 M3 并行；M4 依赖 M3；M7 最后。M4/M5 联验依赖 M2；M6 依赖 M0 结论。

验收补充（codex 评审）：单次截图只证明一次到达；密文存储不证明配对抗冒充。需补记录：断网重启、ACK 丢失、双 Client 编辑冲突、撤销后重放被拒、长时间锁屏后仍能到达。

## 9. 约束与风险

- relay 与 push gateway 走公开分支；不嵌入内部端点、组织域名或部署文件，托管地址只作部署配置。
- 构建输出放外置盘并按 worktree/chat ID 隔离。
- 分支：`v1.1.0dev` 等 `v1.0.0` 打标签后从标签分叉，在独立 worktree 开发；此前不创建。

风险：
1. NSE 解密与 APNs 配置是最大未验证假设。
2. `life-sync.ts` 的取代涉及待办等数据过渡，改动最大。
3. 无云账号的托管 relay：空间 ID = 公钥时，批量生成公钥可绕过按空间配额，签名只证明持钥。至少需要创建准入、入口限速、全局存储/流量上限与 push 配额（codex 评审，推断）。
4. Android 无 FCM 设备首期不保证锁屏到达；小米归类与私信模板期限（2026-12-31）。
5. E2E 与 Android 通知文字的冲突尚无已验证方案。

## 10. 仍开放

- 展示契约的具体字段清单与最低版本协商。
- 托管 relay 的配额与滥用策略。
- 小米：助手类消息归类、透传消息可靠性、海外/国内服务器差异。
- 是否让 relay 取代 Tailscale 成为默认连接方式（高级选项保留局域网/Tailscale）：尚未向用户确认。
