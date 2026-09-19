# Composio Phase 0：离线探针与剩余验证

日期：2026-09-19。状态：**部分完成，不能据此启动 Plan 2 生产集成**。

本机未配置 `COMPOSIO_API_KEY`；未建立 OAuth 连接，未读取邮箱、日历、账号身份或 provider token。工具 schema、实际 envelope 与账号隔离尚未实测。Plan 1 的 provider 无关底座可以独立验证。

Plan 1 已提交至 `4a7f0201`（六个实现提交，从 `13b3ff2d` 起）：schema 4 对象状态、current/generation 效力、显式处理同意、抽取/embedding 返回校验、可恢复批次与删除、宿主批次通知。独立审阅发现的授权落盘顺序、暂停队列阻塞、Knowledge stamp、通知丢失、provider 更换提示已修复，并补了旧批次晚完成测试。最终完整 runtime 测试 **2557 项：2549 通过、8 跳过、0 失败**；TypeScript 构建、lint、diff 检查通过。测试为本地确定性验证，不代表 Google 账号或安装版验收。

## 已核对的公开契约

隔离安装官方 `@composio/core@0.18.1`（`--ignore-scripts --save-exact`），其客户端为 `@composio/client@0.1.0-alpha.76`。临时锁文件 SHA-256：`eb4ddaf9af43aff55d3c50a2bf303ff0311bd70262e69d82804394da0cc43ba8`。没有添加生产依赖。

已发布客户端源码确认 origin `https://backend.composio.dev`，API 前缀 `/api/v3.1`：

- `POST /connected_accounts/link`：`auth_config_id`、`user_id`；不使用 initiate。
- `GET /connected_accounts/:id`、`GET /connected_accounts`：可查连接与筛选 user_ids/statuses。
- `GET /tools/:slug?version=...` 获取版本化 schema。
- `POST /tools/execute/:slug`：`arguments`、`connected_account_id`、`user_id`、`version`。

[Gmail 官方目录](https://docs.composio.dev/toolkits/gmail)与 [Google Calendar 官方目录](https://docs.composio.dev/toolkits/googlecalendar)显示 `20260915_00`。这里只确认公开目录版本和 slug，不将目录示例当作 live 响应契约。详细清单见 `composio-tool-contracts.json`。

## 验证矩阵

| case | layer | status | evidence | implication |
|---|---|---|---|---|
| 输出脱敏、HTML/429、redirect、无长度超限、取消、预算 | offline | pass | `node --test runtime/scripts/composio-probe.test.mjs`，9 项通过 | 原始响应不进入报告 |
| 固定只读 slug、日期 pin、无验证 scope 禁止执行 | offline | pass | 写工具/动态版本/未验证 scope 请求数为 0 | 执行入口保持关闭 |
| SDK REST 映射 | catalog | pass | 上述精确 npm 版本的发布源码 | 不采用旧版 SDK 示例 |
| Gmail/Calendar 日期版本、slug | catalog | pass | 官方 toolkit 目录，2026-09-19 | schema 尚待认证读取 |
| 工具 input/output schema 与摘要 | live | unobserved | 无 API key | 尚未保存原始 schema；不能解析生产响应 |
| link、授权 scope、A/B/A/B 身份隔离 | live | unobserved | 无测试账号与范围 | 阻塞 Plan 2 账号路由 |
| Gmail history、列表/正文分页、404 分类 | live | unobserved | 无测试标签 | 阻塞 Gmail 增量同步契约 |
| Calendar syncToken/showDeleted、实例、取消、410 | live | unobserved | 无测试日历 | 阻塞 Calendar 增量模式选择 |
| provider status 透传、Proxy 必要性 | live | unobserved | 仅离线分类测试 | 暂不引入 Proxy fallback |
| 子进程环境快照、clear/unset 策略 | offline | pass | fixture 子进程旧值不变，新 spawn 获取新值；不输出值 | 换 key 需要重启 |
| 桌面 Composio 密钥与安装包 | production | unobserved | 本次不改桌面 SECRET_KEYS | 属于 Plan 2/3 |

## 密钥通路核查

`settings-store.mjs` 的 SECRET_KEYS、加密封装和 `backend.mjs` 的 SECRET_ENV_MAP/capabilityEnvironment 是现有通路。当前没有 Composio 条目。`resolveSecretConfiguration` 会从 dotenv、saved、parent environment 选取非空值；清除 saved secret 不等于禁止父环境回流，`capabilityEnvironment` 又从父环境副本开始。因此 Plan 2 必须持久区分 cleared/unset，并在 spawn 前显式删除 cleared 对应 env。探针的 `effectiveKey` 只证明所需策略，未接入生产。

## 可重复执行与剩余工作

运行离线检查：`node --test runtime/scripts/composio-probe.test.mjs`。运行公开目录认证探测：`node runtime/scripts/composio-probe.mjs catalog`，key 仅从进程环境读取。未配置时输出 unobserved 并不访问网络。可附加一个不存在的输出文件路径，全部 schema 通过 slug、日期版本、结构检查后保存公开 input/output schema 与 SHA-256；不会覆盖现有文件。新增契约检查后离线共 10 项通过。当前 CLI 仅开放 catalog；`executeRead` 关闭，link/inspect/gmail/calendar/routing 尚未实现。

裁定：没有 key 和账号范围时，不猜 schema、不搭建不可验证的 OAuth/采集流程。Phase 0 Task 1 部分完成、Task 4 离线实验完成；Task 2/3 和 schema 保存保持未完成。后续需在本机配置 key、选择测试账号和只读标签/日历，补齐安全 link、身份检查、分页探针，取得真实契约后再写 Plan 2。临时 SDK 项目可在后续核对结束后删除：`/private/tmp/nova-composio-probe-6FGUGC`。
