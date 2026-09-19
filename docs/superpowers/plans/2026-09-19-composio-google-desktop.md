# Composio Google Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已验证的 Composio 只读契约接入 Nova 来源设置与可恢复后台同步。

**Architecture:** runtime 固定操作客户端、Google provider 和同步管理复用现有 source state；desktop 负责密钥存储和设置。Gmail history 与 Calendar 窗口核对显式区分模式，不增加任意执行工具。

**Tech Stack:** Node、TypeScript、现有 zod/SQLite worker、Electron。无新增生产依赖。

**Spec:** `docs/superpowers/specs/2026-09-19-composio-connectors-design.md`

## 状态与前置门槛

待审阅。Phase 0 已有真实 key、10 个固定版本 schema、两个授权连接、身份匹配、Gmail 三页/单封/空 history、Calendar 空窗口/空增量。仍未完成双账号隔离、日历非空分页/重复/取消、真实过期游标；这些是安装版验收的明确缺口，不能改写成通过。

以下计划只采用已观察的 REST envelope 与已保存 schema。Calendar 第一版使用有界窗口快照，不将空增量成功推断为删除链路已通过。启用生产连接必须本地重验账户和范围；此计划不导入临时探针凭据或私有数据到版本库。

## Global Constraints

- 所有代码在 v0.3.0dev 工作树；无推送、无公司 pilot 集成。
- tool version 固定 `20260915_00`，origin 固定 `https://backend.composio.dev`，仅 link/auth configs/connected account/明确只读工具。
- 每请求 15 秒 / 2 MiB，每轮 30 秒 / 5 MiB / 20 请求 / 200 对象；游标保持字符串。
- OAuth full scope 如实展示，本地操作白名单只读。不新增前脑任意查询或写工具。
- source_id 含 generation；current 派生效力；范围/epoch/consent/provider 指纹在最终写入复核。
- 代码文件不超过 4,000 行。runtime/dist 构建和测试串行。

## Review Focus

- HTTP 200 successful:false 必须失败，不推进检查点。
- 连接歧义/账号串号/账户身份改变必须在读取正文前失败。
- 数据页缺失、空页带游标、重复游标及中途预算耗尽不能清除来源覆盖。
- 暂停/撤权/改范围期间晚到响应及模型结果不能重新激活来源。
- 密钥 cleared 不从父进程回流，宿主重启后旧同步进程不能继续写入。

### Task 1: 固定 Composio 客户端与授权生命周期

**Files:** 新增 `runtime/src/connectors/composio/client.ts` 与 `runtime/test/composio-client.test.ts`；复用探针确认的参数，但生产错误不带 raw error/body。

**Interfaces:** `ComposioClient` 提供 link、inspect、listScopes、executeRead；工具参数由对应 Google provider 构造。executeRead 必须要求已验证的连接与 scope，不接受 model 给的 slug。对 HTTP 错误和 successful:false 内嵌 status_code 分开解析，未知错误失败关闭。

- [ ] RED：私有字段不进入异常、redirect/流超限/取消、401/403/429、HTTP200+410、歧义连接和伪身份失败。
- [ ] 实现固定路由、请求预算、日期 pin、每连接独立 user_id 和已验证身份。
- [ ] GREEN：上述测试；运行 runtime typecheck/lint；提交此任务。

### Task 2: Google 页读取与快照/增量协议

**Files:** 新增 `runtime/src/connectors/composio/google.ts` 与 `runtime/test/composio-google.test.ts`。

**Interfaces:** scope 为 Gmail 标签+保留窗口或 Calendar IDs+窗口；读取返回 changes/continuation/checkpoint/complete。Gmail 先 profile 基线再快照、最后 history 补漏；message 读取后再次校验标签/时间，标签变化仅 metadata。Calendar 使用有界窗口 snapshot，保留 recurringEventId/originalStartTime/全天日期和取消标记。

- [ ] RED：分页重试/重复 token、巨型消息、字符串 historyId、404 失效与单对象消失的区分、跨窗口和标签移出、全天/重复实例。
- [ ] 实现 provider 与可见完整性；只在完整核对后输出 coverage_removed，窗口外内容不入库。
- [ ] GREEN：伪 provider 契约测试；复跑授权范围只读 live 探针；提交。

### Task 3: 后台同步、源状态和命令

**Files:** 新增 `runtime/src/connectors/composio/index.ts`；修改 `runtime/src/personal-agent/contracts.ts`、`runtime/src/personal-agent/host.ts`、`runtime/src/composition/production-composition.ts`；测试 `runtime/test/composio-sync.test.ts`。

**Interfaces:** 连接管理 snapshot/command/open/close 对齐现有 Feishu 宿主接法；增加明确的 connector.status/link/complete/scopes/configure/consent/sync/pause/resume/disconnect/delete 命令和各自严格 params schema。复用 acquirePersonalLock 与 SubstrateMemoryResource.applySourcePage，不另写来源数据库。

- [ ] RED：崩溃重放幂等、200 对象批通知、暂停后晚到、A→B→A、删除先 bump、断开不删、未同意无外发。
- [ ] 实现单轮有界调度、重试/backoff/睡眠恢复、持久 continuation/checkpoint 和独立账户状态。
- [ ] GREEN：新同步测试及 Plan1 回归；提交。

### Task 4: 桌面 key 与来源设置

**Files:** 修改 `clients/desktop/src/main/settings-store.mjs`、`backend.mjs`、`settings-apply.mjs`，`clients/desktop/src/renderer/settings.html`、`settings.mjs`、`personal-view.mjs`；新 UI 分支按职责分文件以保持上限；更新对应 desktop tests。

- [ ] RED：saved/unset/cleared 三态、spawn env 删除旧 key、UI 不回显 key、授权完成不自动同步、scope/processing consent 独立。
- [ ] 加入 COMPOSIO_API_KEY secret map；使用现有加密存储与 runtime restart 流程，CLI 读取同一环境变量。
- [ ] 来源设置展示账户、OAuth 实际能力/未知状态、选择范围、处理许可、同步模式、最近尝试/完整成功/错误及控制按钮。
- [ ] GREEN：desktop tests/build；原客户端真实配置与同步验收；提交。

### Task 5: 交付检查与 Plan 3

- [ ] runtime 全套、desktop 相关回归串行；检查公共树无 key/邮箱正文/账号标识。
- [ ] 一次独立完整分支审阅；重要问题 RED→GREEN 修复，不将 reviewer 作为实测替代。
- [ ] 编写安装版验收 Plan 3：实际 UI、退出重启、睡眠恢复、撤权、取消/删除及非空日历样本。未有写授权时不造真实日程。
- [ ] 更新 04/06/STATUS 为实际完成层级；明确保留未测项。无推送或发布。
