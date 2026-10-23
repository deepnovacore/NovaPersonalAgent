# 开工核实 V1–V5

基线：`5652030e`，云端分支 `v1.1.0dev`，2026-10-23。下面是全仓搜索和源码阅读证据，不是真机验收。本轮用户授权开始实施，新增 relay 投递内核；不删除旧机制。

## V1：Life 权威数据

`personal-agent/store.ts` 的 PersonalStore 保存 feed、conversations、settings 等，**不保存 Life 集合**。`personal-agent/host.ts` 分别构造 PersonalStore 与 LifeService。`personal-agent/life.ts` 在有 LifeBackend 时以 backend 为权威，无 backend 才使用 `.life.json`；`memory-substrate/resource.ts` 把 backend 读写接到 `life_load/life_mutate/life_sync_projection`，`life-operations.ts` 在事务内保存 evidence、merge、receipts。

`hub/store.ts` 的 `hub_accounts.state` 是另一份可写 Life，mutate 调 reducer 后写 state/receipt/log。`hub/life-sync.ts` 确有双写桥，但全仓 `configureHubSync` / `syncHub` / `new LifeSyncClient` 搜索发现其调用只在测试，生产代码只有 LifeService 定义和内部构造；不能宣称桌面已自动启用同步。

M2 应将意图统一交给既有 LifeService/LifeBackend，而不是保留 HubStore 第二权威。业务变更、意图回执与待投递结果还需要崩溃一致性设计。

## V2：此前未读模块

- `personal-agent/scheduled-tasks.ts`：持久定义、冻结 run 输入、receipt、adoption、claim/checkpoint；timer 在 Host。当前 `claimDue` 取 latest occurrence，存在 missed/skipped 与 catchup 限制，这不是新架构 O3 的产品结论。
- Flutter `scheduled_agent_runner.dart`：open/start/wake/execute 没有 `authority.canPublish` 检查；repository.claimDue 按 localDeviceId owner 领取，前台和 headless 都可能进模型循环。
- `device/authority.dart` 是审批 grant/effect fence；`attempt.dart`、`task_ledger.dart` 保持未知副作用与重启状态；`todo_sync.dart` 是纯合并状态机。全仓 import 未发现这四个模块在 lib 产品接线，只有测试/adapter 使用。不能把已有状态机当成产品已接线保证，也不能因删除主设备关系而误删它们。
- Hub UI `hub/ui/client.ts` 是手动刷新只读控制台，不执行 commands；`hub/cli.ts` serve/enroll/revoke/recover 中 recover 是旧主设备灾难接管，后续按 D8/D9 删除。工具副作用恢复与信箱补拉仍需保留。

## V3：调用方复核

全仓搜索 `/hub/v1`、`commands/ack`、`routing.inbox/ack/submit`、`devices/heartbeat`、desktop capabilities、`configureHubSync`，并核对实际生产入口。本批仅新增独立包，无删除和 Hub/Flutter 接线变更。**删除阶段 V3 尚未退出**：M2/M4/M7 仍需对当时全部调用方做类型检查和搜索，删除前建专用备份分支。

## V4：命令消费链纠错

`hub/client-cli.ts` 的 request 有 payload，实际是 POST commands 的发送方，不是消费者。真实 GET commands 在 Flutter `agent/hub_tasks.dart` 的 offers/poll；accept 经 ACK 后调用 NativeLocalAgent.run，cancel 调 native stop。生产构造位于 `personal/life_host.dart`，UI local_tasks 调用。

仓库内未发现桌面 GET commands → ACK → desktop executor，也没有 desktop heartbeat 接线。旧 routing.ts 还保存明文 goal/acceptance 并解释任务阶段，不能整个搬到盲 relay。D25 也不能原样复用会启动本地 Agent 的 run 路径。

## V5：自主执行入口

| 设备/入口 | 生产调用链 | 后续角色边界 |
|---|---|---|
| PC 启动 | realtime-assembly → PersonalAgentHost.open(deferBackground) → startBackgroundWork | Host 启动全部后台生产者 |
| PC 自主派生 | host.#startBackgroundWork → profile/digests/workbench/timeline/news/source drain | 不仅 discovery timer |
| PC discovery | host.#schedule / scheduledTick → discover；observation/handoff 与资料变化也触发 discover | 事件与周期都要覆盖 |
| PC 定时 | host.scheduledTaskTick → syncShared / sourceProcessingAgent.tick / schedules.claimDue / reconcile / wakeTask | 本地规则不依赖 shared 成功 |
| PC 恢复 | recoverTasks / reconcileScheduledRuns / runtime factory ready → tick | 已创建的 run 也需角色边界 |
| PC push-and-pull | core/runtime progress/result/observation/handoff → surrogate.watch / proactive selection → realtime publishNotification | 生成与通知路由是不同层 |
| Flutter 启动 | ui/app._openAgentCore → AgentCoreHost.open → _openLocalSchedules | Client 不创建本地 runtime |
| Flutter 定时 | runner.start 的 30 秒 timer、resumed、wake → claimDue → execute → agent.send | Client 在入口与恢复前阻断 |
| Flutter 原生后台 | main.novaScheduleMain → LifeHost(backgroundReader) / ModelSettings(headless) / runner.open(headless) | 后台 entrypoint 读取 Space 模式，不能仅隐藏 UI |
| Flutter Profile | ProfileGenerationCoordinator.start/listeners/timer/debounce → generate | 已有 canPublish/epoch fence，但只覆盖此链 |
| Flutter 同步/派生 | LifeHost 生命周期 → LifeSyncScheduler / LocalNews / context | Client 改为补拉与意图，独立模式保留 |

iOS BGAppRefresh 的 15 分钟是 earliestBeginDate，不是执行保证；锁屏 protected data 不可用时结束，headless engine 有时间限制。Android JobService 同样有锁屏检查和执行窗口。进程级 scheduler owner 只防止 foreground/headless 同时写，不能代替 Space 角色。

原生 notifyWaiting 只发本地“定时任务需要确认”，不构成 Host 推送。后台 runner 虽限制部分 Life 写入，仍可调用模型/web/workspace 工具。

## 本批边界

M0 缺少账号、证书及三类真机，无到达率证据。M1 先做无业务依赖的投递内核，认证通过必须提供的可信接口接入；不实现/宣称密码学安全的配对、网络服务或 Docker 发布。M3–M7 不在本批冒进删除；后续以各自退出证据推进。
