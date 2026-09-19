# Composio Phase 0：离线探针与剩余验证

日期：2026-09-19。状态：**部分完成，不能据此启动 Plan 2 生产集成**。

用户已将 key 配置到工作树忽略的 `.env`（0600），并完成 Gmail OAuth。10 个固定日期版本工具的认证 schema 获取全部 HTTP 200，公开 schema 与摘要已保存。Gmail 单连接身份、三页列表、单封正文格式和空 history 读取已实测；尚未完成生产集成与完整同步。Google Calendar 已授权且身份匹配，窗口为空，空增量成功；macOS 原生日历实现与 live 验收已获用户纳入后续范围。

Plan 1 已提交至 `4a7f0201`（六个实现提交，从 `13b3ff2d` 起）：schema 4 对象状态、current/generation 效力、显式处理同意、抽取/embedding 返回校验、可恢复批次与删除、宿主批次通知。独立审阅发现的授权落盘顺序、暂停队列阻塞、Knowledge stamp、通知丢失、provider 更换提示已修复，并补了旧批次晚完成测试。最终完整 runtime 测试 **2557 项：2549 通过、8 跳过、0 失败**；TypeScript 构建、lint、diff 检查通过。测试为本地确定性验证，不代表 Google 账号或安装版验收。

## 已核对的公开契约

隔离安装官方 `@composio/core@0.18.1`（`--ignore-scripts --save-exact`），其客户端为 `@composio/client@0.1.0-alpha.76`。临时锁文件 SHA-256：`eb4ddaf9af43aff55d3c50a2bf303ff0311bd70262e69d82804394da0cc43ba8`。没有添加生产依赖。

已发布客户端源码确认 origin `https://backend.composio.dev`，API 前缀 `/api/v3.1`：

- `POST /connected_accounts/link`：`auth_config_id`、`user_id`；不使用 initiate。
- `GET /connected_accounts/:id`、`GET /connected_accounts`：可查连接与筛选 user_ids/statuses。
- `GET /tools/:slug?version=...` 获取版本化 schema。
- `POST /tools/execute/:slug`：`arguments`、`connected_account_id`、`user_id`、`version`。

[Gmail 官方目录](https://docs.composio.dev/toolkits/gmail)与 [Google Calendar 官方目录](https://docs.composio.dev/toolkits/googlecalendar)显示 `20260915_00`。认证 API 已确认全部 10 个工具的该版本 input/output schema。详细清单见 `composio-tool-contracts.json`。

## 验证矩阵

| case | layer | status | evidence | implication |
|---|---|---|---|---|
| 输出脱敏、HTML/429、redirect、无长度超限、取消、预算 | offline | pass | `node --test runtime/scripts/composio-probe.test.mjs`，15 项通过 | 原始响应不进入报告 |
| 固定只读 slug、日期 pin、无验证 scope 禁止执行 | offline | pass | 写工具/动态版本/未验证 scope 请求数为 0 | 通用执行入口保持关闭；固定 gmail/calendar 探针显式核对 scope 后可执行 |
| SDK REST 映射 | catalog | pass | 上述精确 npm 版本的发布源码 | 不采用旧版 SDK 示例 |
| Gmail/Calendar 日期版本、slug | catalog | pass | 官方 toolkit 目录，2026-09-19 | 认证 schema 已确认 |
| 工具 input/output schema 与摘要 | live | pass | 10 个认证 GET 均为 200，slug/version/schema 校验及 SHA-256 | 公开 schema 已落盘 |
| link 与 Gmail 单账号路由 | live | pass | 两个 link 请求 201；Gmail ACTIVE、独立 user_id 下唯一 active 连接，GET_PROFILE 身份匹配 | 仅证明单账号；双账号隔离仍未测 |
| OAuth 最小 scope | live | fail | 仅配置只读 creation tools 后，Gmail 仍申请全邮件权限，Calendar 仍申请完整日历权限 | 如实披露；Nova 必须本地限制只读，不能称只读 OAuth |
| Gmail 列表、单封正文、空 history | live | pass | 2026-09-19T15:15:55Z：近 30 天 INBOX，三页各 2 条、6 个不同 ID；单封 full 返回匹配 ID/INBOX/时间戳/正文/payload；historyId 为字符串、history 为空 | 分页有更多数据，未声称全量完成；未测试真实变化、404、删除 |
| Calendar 身份、窗口与空增量 | live | pass | primary 过去 30 天至未来 90 天，showDeleted=true，0 events，nextSyncToken 存在；随后无时间参数的 token 请求为空且返回新 token | 只证明空集契约；非空分页、重复、取消、真实过期 token 仍未测 |
| provider 错误 envelope | live | partial | 人工无效 Calendar token：HTTP200、successful:false、data 含 status_code/http_error/message | 不可只检查 HTTP；无效不等于真实过期，410 仍未测；不引入 Proxy |
| 子进程环境快照、clear/unset 策略 | offline | pass | fixture 子进程旧值不变，新 spawn 获取新值；不输出值 | 换 key 需要重启 |
| 桌面 Composio 密钥与安装包 | production | unobserved | 本次不改桌面 SECRET_KEYS | 属于 Plan 2/3 |

## 密钥通路核查

`settings-store.mjs` 的 SECRET_KEYS、加密封装和 `backend.mjs` 的 SECRET_ENV_MAP/capabilityEnvironment 是现有通路。当前没有 Composio 条目。`resolveSecretConfiguration` 会从 dotenv、saved、parent environment 选取非空值；清除 saved secret 不等于禁止父环境回流，`capabilityEnvironment` 又从父环境副本开始。因此 Plan 2 必须持久区分 cleared/unset，并在 spawn 前显式删除 cleared 对应 env。探针的 `effectiveKey` 只证明所需策略，未接入生产。

## 可重复执行与剩余工作

运行离线检查：`node --test runtime/scripts/composio-probe.test.mjs`。运行公开目录认证探测：`node runtime/scripts/composio-probe.mjs catalog`，key 仅从进程环境读取。未配置时输出 unobserved 并不访问网络。可附加一个不存在的输出文件路径，全部 schema 通过 slug、日期版本、结构检查后保存公开 input/output schema 与 SHA-256；不会覆盖现有文件。新增契约及固定连接恢复路由检查后离线共 15 项通过。CLI 已开放 catalog、gmail、calendar；通用 `executeRead` 仍关闭。固定读取流程先核对唯一 active 连接、provider 身份和显式 scope，最多三页，每页两条。

复跑命令：`node --env-file=.env runtime/scripts/composio-probe.mjs gmail <private-state.json>`，calendar 替换 gmail。状态文件必须为 0600 普通文件，connections 中对应 toolkit 必须唯一，并包含 userId/connectedAccountId/expectedIdentity/scope。Gmail scope 固定 `{kind:"gmail",label:"INBOX",pastDays:30}`，Calendar 为 `{kind:"calendar",calendar:"primary",pastDays:30,futureDays:90}`；其他范围失败关闭。实际身份、恢复路由和窗口探针已通过该 CLI 复跑，增量和人工无效游标仍为一次性只读探针。正文不保存到报告或版本库。此次恢复临时状态通过 auth_config_ids 筛选已有配置，避免重复创建 Gmail 连接。账户/游标状态只存在本机 0700 临时目录的 0600 文件中；临时状态遗失不代表远端授权失效。

剩余：link/恢复/增量错误探针 CLI；Calendar 非空分页与取消；双账号身份隔离；真实过期游标；桌面密钥和完整同步。Plan 2 草案已另行写明验收缺口和窗口快照模式，等待审阅；macOS Calendar 使用 EventKit 的独立实现计划，复用现有源状态与同意门控，不将探针当成产品完成。
