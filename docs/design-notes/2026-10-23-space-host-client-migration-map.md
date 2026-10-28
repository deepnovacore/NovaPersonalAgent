# Space / Host / Client 迁移图：现有代码去留

日期：2026-10-23  
基线：`v1.0.0dev`，`ecb533f9`

## 0. 证据说明

- 本表的“作用”和“分类”来自一个 haiku Explore 子代理对 `runtime/src/hub/`、`runtime/src/device/` 与 `clients/flutter/lib/` 的**只读 grep 级盘点**，**行号与调用方没有逐条复核**。
- 我自己直接读过并核对的有：`runtime/src/hub/routing.ts` 前 60 行、`runtime/src/hub/server.ts` 路由表、`runtime/src/hub/life-projection.ts` 头部、`clients/flutter/lib/personal/local_life.dart` 的 `:140-270`；以及全部路径存在性与文件行数。
- 每个文件开头的行数（`wc -l`）：`store.ts` 153，`space-authority.ts` 127，`schedule-coordinator.ts` 52，`routing.ts` 108，`context-sync.ts` 180，`context-bridge.ts` 110，`life-projection.ts` 83，`life-sync.ts` 195，`life-sync-transport.ts` 88，`pairing.ts` 17，`pairing-http.ts` 26，`managed.ts` 123，`managed-entry.ts` 20，`server.ts` 79，`cli.ts` 32，`device/schedule-ownership.ts` 88；Dart：`space_authority.dart` 200，`authority.dart` 253，`ownership.dart` 185，`life_host.dart` 439，`local_life.dart` 405，`life_sync_scheduler.dart` 56，`hub_pairing.dart` 189，`profile_agent.dart` 877，`profile_repository.dart` 604，`authority_controls.dart` 228，`hub_connection_page.dart` 295，`hub_tasks.dart` 373。

动手前请先跑入口文档的 V1–V5 并用全仓搜索与类型检查复核本表。

## 1. 分类定义

| 标记 | 含义 |
|---|---|
| KEEP | 保留，并入 Host 或继续留在 Flutter |
| DELETE | 删除（D9） |
| MOVE | 内容无关的部分，搬去 relay |
| REPLACE | 由新机制取代，旧的在新机制通过验收后再删 |
| NEW | 全新 |

## 2. 运行时（`runtime/src/`）

| 文件 | 作用（子代理） | 去向 | 说明 |
|---|---|---|---|
| `hub/store.ts` | SQLite 账号存储、回执、日志、设备令牌 | **SPLIT** | 信封存取与配对邀请 → relay；Life reducer 使用（`:133` 附近）留 Host。注意 V1：它含 Life 副本；`:26-27` 注释说“不触及执行器或调度”，但实际 import 了 Life reducer（`:4`）与 `ScheduleOwnership`（`:9`） |
| `hub/space-authority.ts` | 主设备、pending、transition、recover | DELETE | 另有 `runtime/test/space-authority.test.ts` |
| `hub/schedule-coordinator.ts` | Host 侧调度适配器 | DELETE（owner-revision 对账 `:25-34`）；调度本身留 Host | |
| `device/schedule-ownership.ts` | claim、checkpoint、handoff | KEEP claim / checkpoint；DELETE `handoff`（`:55-77`） | `schedule-owners/*` 路由里 `register / claim / checkpoint / handoff / control` 共五个，需逐一决定 |
| `hub/routing.ts` | presence、inbox、ack、deadline、任务投影 | MOVE（presence / inbox / ack / deadline）；KEEP（任务投影与阶段规则 `:84-107`） | 命令类型只有 `start` / `cancel`；见架构文档 §8 |
| `hub/context-sync.ts` | 明文事实、授权、投影 | KEEP（Host）；DELETE primary 门槛（`:166`） | 读明文，并入 Host 后在 Host 处理，不阻碍 relay E2E |
| `hub/context-bridge.ts` | PC 侧桥 | KEEP；DELETE primary 门槛（`:47`、`:58`、`:80`） | |
| `hub/life-projection.ts` | 实体投影、字段调和 | KEEP | 需扩充：Timeline、实体 version（架构文档 §7.2） |
| `hub/life-sync.ts` | 双写 outbox、基线与冲突调和（`:31-195`） | **REPLACE** | 由“Client 意图 + Host 落盘 + 回投影”取代，**改动最大**；语义见架构文档 §8.2 |
| `hub/life-sync-transport.ts` | 传输 | MOVE / REPLACE | `:75` 处有对 authority 的依赖 |
| `hub/pairing.ts`、`pairing-http.ts` | 邀请与兑换 | MOVE | 只有 17 与 26 行，扩展成扫码配对 + 密钥交换是新写 |
| `hub/managed.ts`、`managed-entry.ts`、`cli.ts` | 守护进程外壳 | 待核实（V2） | Hub 并入 Host 后，这个独立外壳是否保留？`cli.ts` 未读 |
| `hub/server.ts` | HTTP 路由表 | 改写 | 保留 `mutations`、`commands`、`changes`；删 `authority/*`、`schedule-owners/*`（除保留的 claim/checkpoint 部分）与 `context/publish`。relay 是新服务，不是在这个文件上改 |
| `hub/ui/*`、`hub/ui.ts` | 控制台 | 未读 | 见 `docs/development/hub-console.md` |
| `composition/realtime-assembly.ts` | `:405-408`、`:1471-1475` 依赖 authority | 随之改 | 子代理报告 |
| `memory-substrate/resource.ts` | `:44-45`、`:170-222` 依赖 authority | 随之改 | 子代理报告 |
| `personal-agent/host.ts` | `scheduledTaskTick`、`publishScheduledResult` | KEEP | Host 后台工作的入口；起点文档 §3 |
| `notifications/*` | 持久 outbox、适配器 | KEEP，新增手机推送适配器（O10） | 见架构文档 §10.6 |
| relay 服务 | 无 | **NEW** | 密文信箱、流、presence、唤醒、配额、配对 |
| push gateway | 无 | **NEW** | APNs / FCM / Mi Push |

## 3. Flutter（`clients/flutter/lib/`）

| 文件 | 去向 | 说明 |
|---|---|---|
| `device/space_authority.dart`（`:8-200`） | **DELETE** | 与下一行重名，别删错 |
| `device/authority.dart` | **KEEP** | 任务授权与 fence，不是空间主设备 |
| `device/ownership.dart` | KEEP | 回执去重 |
| `personal/life_host.dart` | 改 | DELETE `_refreshAuthority`、`joinAuthority`、`authorityMembers`、`transferAuthority`、`authorityTransition`（`:332-392`），以及 `:132-134`、`:290-297`、`:322-326`、`:346-392` 处调用；同步核心保留 |
| `personal/local_life.dart` | **KEEP 语义** | 持久化 pending、ID 重映射、冲突，是新机制的蓝本（架构文档 §8.2） |
| `personal/life_sync_scheduler.dart` | KEEP | 前台定时器，可作为断线补拉基础（起点文档 §3） |
| `personal/hub_pairing.dart`、`ui/hub_connection_page.dart` | 改 | 配对流程改成扫码 + relay 选择 |
| `context/profile_agent.dart`（`:166`、`:409`、`:433`）、`context/profile_repository.dart`（`:419`、`:538`） | 改 | 依赖 `space_authority`，删除时要一起改 |
| `ui/authority_controls.dart`（228 行） | DELETE | 整个主设备转移 UI |
| `ui/feishu_direct_page.dart`（`:765-849`） | 改 | 引用 authority |
| `ui/schedule_editor.dart`（`:49`、`:173`、`:469`）、`ui/scheduled_tasks_page.dart`（`:441-443`） | 改 | 引用 authority |
| `agent/hub_tasks.dart` | 待核实 | 15 分钟过期逻辑（`:160-170`）对状态类意图不合适 |
| `agent_core/scheduled_agent_runner.dart`、`schedule_repository.dart`、`schedule_wake.dart`、`background_execution.dart` | 待核实（V2） | 独立模式仍需要；Client 模式下手机不应执行 proactivity / 定时（见架构文档 §12） |
| iOS：`ios/Runner/NovaScheduleBridge.swift` | KEEP | 只发本地通知；推送是新增 |
| Android：`android/app/src/main/kotlin/com/nova/nova_mobile/NovaScheduleBridge.kt` | KEEP | 同上 |
| iOS NSE target、FCM 服务、小米 SDK 接入、推送令牌注册 | **NEW** | 现在 `pubspec.yaml` / Gradle 里没有 Firebase 依赖，没有 `aps-environment` entitlement，manifest 没有消息服务（子代理报告） |
| 创建 Space 二选一、展示契约渲染、意图队列 | **NEW** | |

文件里有一些行号来自子代理，文件内容可能已因后续合并而变化；只把它们当作搜索线索。

## 4. 受影响的测试

### 4.1 runtime（`runtime/test/`）

| 测试 | 预期处理 |
|---|---|
| `space-authority.test.ts` | 随模块删除 |
| `schedule-ownership.test.ts`、`hub-schedule-coordinator.test.ts` | 保留 claim / checkpoint 部分，删 handoff 与 owner-revision |
| `hub-life-sync.test.ts`、`hub-life-sync-transport.test.ts`、`hub-life.test.ts`、`hub-life-backend.test.ts` | 被意图机制取代，先写新测试再删旧测试 |
| `hub-routing.test.ts`、`hub-server.test.ts` | 按新路由表与命令类型改写 |
| `context-sync.test.ts`、`hub-context-bridge.test.ts` | 去掉 primary 门槛相关断言 |
| `hub-pairing.test.ts`、`hub-pairing-http.test.ts`、`hub-managed.test.ts`、`hub-cli.test.ts`、`hub-ui.test.ts` | 视 V2 结论 |
| `documentation-contract.test.ts` | README 改写后同步 |

### 4.2 Flutter（`clients/flutter/test/`）

以下测试引用了待改动模块（grep 命中，非全部）：`devices_page_test.dart`、`hub_tasks_test.dart`、`hub_roundtrip_test.dart`、`hub_connection_page_test.dart`、`hub_pairing_transport_test.dart`、`feishu_direct_page_test.dart`、`scheduled_agent_runner_test.dart`、`local_schedule_test.dart`、`personal_store_test.dart`、`local_profile_results_test.dart`、`profile_pipeline_checkpoint_test.dart`、`profile_pipeline_agent_test.dart`、`profile_todo_candidate_test.dart`、`task_todo_completion_test.dart`、`timeline_brief_cards_test.dart`、`agent_core_test.dart`、`nova_local_chat_wiring_test.dart`。Flutter 测试在本环境**从未运行过**，SDK 位于外置盘并非总在挂载状态；执行前先确认 SDK 可用。

## 5. 删除的顺序与保护

1. 先建新机制，**新机制通过验收后**再删旧代码（见里程碑 M4 / M7）。不要先删再补。
2. 删除前建备份分支，例如 `backup/pre-space-host-client-<sha>`，而不是只依赖 git 历史（项目约定）。
3. 先删叶子（UI、Dart 调用点），再删被依赖的模块，最后删路由与存储表。
4. 每一步：全仓搜索残留引用 + 类型检查 + 对应测试。
5. 预研阶段无兼容层：旧的 Hub 数据库与 authority 状态**直接重置**，不写迁移。
6. 删除 `device/space_authority.dart` 前，确认 `profile_agent.dart`、`profile_repository.dart` 已改完。

## 6. 容易出错的点

- `space_authority.dart`（删）与 `authority.dart`（留）重名。
- `store.ts` 的注释与实际依赖不一致（见上表）。
- `schedule-owners/*` 的五个路由不要整组删：claim / checkpoint 在 Host 仍有用。
- `device/ownership.dart` 是回执去重，与空间主设备无关。
- Hub 命令通道请求体上限 64 KB（`server.ts:58`，子代理报告），聊天与快照可能超出。
- 起点文档里“Hub 共享任务只允许 desktop 注册 / 作为交接目标”这条限制，在 Host 并入后需重新审视。
