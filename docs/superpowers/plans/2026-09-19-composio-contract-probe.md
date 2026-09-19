# Composio Contract Probe Implementation Plan (Phase 0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用可重复的只读探针确定 Composio + Google 的真实契约，为 Plan 2 提供版本、schema、错误与账号路由证据。

**Architecture:** 独立脚本和临时隔离项目，不修改生产 runtime 依赖、不调用模型。离线断言检查探针本身；真实 OAuth/分页/错误验证单独记录。缺账号或无法诱发服务商错误时保留未测，不伪造通过。

**Tech Stack:** Node >=22.13.0、node:test、原生 fetch；在临时项目安装并精确锁定官方 @composio/core，用于核对 SDK/REST 请求映射。

**Spec:** [已批准设计](../specs/2026-09-19-composio-connectors-design.md)，§5、§7、§14。

## Global Constraints

- 仅在 `v0.3.0dev` worktree 工作，不推送；不修改用户现有账号绑定或组织配置。
- key 只从 `COMPOSIO_API_KEY` 读取，不写文件、不回显；不读取/导出 provider token。
- 独立随机 Composio user_id，每连接一个 toolkit、一个 ACTIVE 账号；显式 account ID，不选最近账号。
- 使用 link，不使用托管 OAuth initiate；接受默认 scopes 并记录其实际可见程度，限制 scope auth config 为对照项。
- 请求 15 秒、响应 2 MiB；每轮 20 请求/200 对象/5 MiB/30 秒；预算耗尽保留进度。
- 仅读取用户授权的测试标签/日历；邮件/事件写操作白名单为空。用户自己在测试账号制造变更，脚本不发送邮件或创建/修改日程。
- 原始 OAuth URL、account/user ID、邮箱、正文、token、游标不进入报告或 git。私有状态放 `/private/tmp/nova-composio-probe-*`，目录 0700、文件 0600，退出提示清理路径。
- Phase 0 不运行生产后台同步，不实现本地 macOS connector。无 live 授权时继续离线任务及 Plan 1。

## Review Focus

1. A/B 账户交错读取是否串号：比较实际 provider 身份与仅各自可读对象（Task 2）。
2. schema 有参数不等于真实响应保留了游标/服务商错误：独立验证并标注层次（Task 3）。
3. 429、HTML 错页、redirect、超大流、无 Content-Length 和取消不得泄漏 key 或无限等待（Task 1）。
4. OAuth 超时/多账号/不可见 scopes 不得算连接成功或只读授权（Task 2）。
5. 清除 key 后父进程旧 env 不能回流；新进程与旧进程配置隔离（Task 4）。

## 文件布局

- 新增 `runtime/scripts/composio-probe.mjs`：固定操作路由、CLI、请求预算和脱敏报告；不导入生产 composition。
- 新增 `runtime/scripts/composio-probe.test.mjs`：本地 HTTP/假 fetch 与子进程检查，不访问网络。
- 新增 `docs/research/2026-09-19-composio-probe.md`：日期、工具版本/schema 摘要、矩阵、结论。没有 live 证据的项明确 unobserved。
- 新增 `docs/research/composio-tool-contracts.json`：仅公开工具 input/output schema、工具日期版本、SDK 精确版本及 schema SHA-256，无账号数据。

不新增通用 SDK wrapper。SDK 装在临时项目，锁文件摘要和精确版本写入报告；正式 runtime 是否使用 SDK 由体积、可控 fetch 与探针结果决定。

### Task 1: 有界、脱敏的探针与离线检查

**Interfaces:** 脚本导出 `requestJson(path,{method,body,signal},transport=fetch):Promise<{status:number,data:unknown,retryAfter:string|null}>`、`summarize({caseId,status,layer,checks}):object`。method 限 GET/POST；POST 只能是 link 或已核对只读工具 execute，不提供任意 endpoint CLI 参数。CLI 模式 `catalog | link | inspect | gmail | calendar | routing | env-check`，未给模式仅显示用法，导入不执行。

- [ ] 写离线测试并跑失败：

```js
import {test} from 'node:test'; import assert from 'node:assert/strict'
import {requestJson,summarize} from './composio-probe.mjs'
test('report omits raw upstream fields',()=>{
 const report=summarize({caseId:'routing',status:'pass',layer:'live',
  checks:{identity_matches:true},raw:'secret-body',token:'secret-key'})
 assert.deepEqual(report,{caseId:'routing',status:'pass',layer:'live',checks:{identity_matches:true}})
})
test('response bytes are bounded without a length header',async()=>{
 const fake=async()=>new Response('x'.repeat(2*1024*1024+1))
 await assert.rejects(requestJson('/probe',{method:'GET'},fake),/response_too_large/)
})
```

Run: `node --test runtime/scripts/composio-probe.test.mjs`。
- [ ] 实现 reader：逐块累加解码前 bytes 并 cancel 超限流；请求 AbortSignal.any 合并用户取消与 15000ms；redirect:error；先保留 HTTP status/Retry-After，再尝试 JSON 解析，解析失败返回结构化 invalid_json，绝不输出响应片段。只允许可信固定 Composio HTTPS origin；路径匹配固定 API 路由，禁止 URL/query 注入。
- [ ] summary 采用字段白名单，checks 只允许布尔/计数/公开参数名；error code 枚举，拒绝原始异常 message。加入 302、不停流、HTML 500、429 Retry-After、错误对象含 key/body、总轮次预算的测试。
- [ ] 查询官方 npm 包元数据并在隔离目录精确安装当前版本。读取其已发布类型/源码核对 `connectedAccounts.link/get/list`、`tools.execute` 与 raw schema 获取的 REST endpoint 和参数映射，把固定路由写入脚本；保存公开 schema。此步骤是探针的研究产物，禁止凭旧例子猜 endpoint。日期工具版本从 toolkit metadata 获取一次后写入 contracts JSON；执行时不接受 latest/dangerouslySkipVersionCheck。

```bash
npm view @composio/core version
node --test runtime/scripts/composio-probe.test.mjs
```

安装命令使用查询到的确切版本和 `--save-exact --prefix` 临时目录；报告记录锁文件摘要。不得添加到 runtime/package.json。
- [ ] 通过后提交脚本、测试和公开 contracts 文件，`git commit -m "test(connectors): add bounded Composio contract probe"`。

### Task 2: Link、scopes 与账户路由

**Consumes:** Task 1 固定路由及 schema；仅当用户提供可用 key/测试账号范围时运行 live。可用性检查只报告布尔值，不打印 env。

**Produces:** 私有状态 `{connection,userId,connectedAccountId,toolkit,expectedIdentity,selectedScope}`；报告只保存编号 A/B、scopes 公共名字、身份匹配布尔值、连接状态。

- [ ] 离线测试 link 轮询到期返回 unobserved、两个 ACTIVE 返回 fail、未知 granted scopes 记录 unknown，不能记录 readonly。测试 userId/accountId 不匹配时请求执行次数为 0。
- [ ] link 使用 SDK 文档中的 hosted Link 流程，对生成 URL 检查 HTTPS 和经官方资料核对的精确可信主机，不打印其 query 到报告；只在本机打开。轮询间隔 2 秒、最多 60 秒一轮，超时保留等待状态，下轮先查已有连接，不重复创建。每次执行前确认 toolkit/user/唯一 ACTIVE 连接/expectedIdentity。
- [ ] 测试默认 auth config；记录请求 scopes 和已授予 scopes 的可观察性。若已有可用的受限 auth config，再跑对照；没有则标 unobserved，不要求注册自己的 Google OAuth app。
- [ ] A/B 采用不同 userId 和各自 accountId，以 A→B→A→B 次序读取 profile 与授权测试范围内各自独有对象。报告记录 `identity_matches` 和 `foreign_object_visible`，不保存邮箱/对象 ID。Calendar 若工具不能提供稳定账户身份，报告 fail/阻塞其路由验收，不能用连接别名代替身份核对。
- [ ] 不自动 disable/delete 用户旧连接；只操作此次创建的隔离连接，测试完提供清理清单。重授权产生多 ACTIVE 时停止并记录，不任意挑选。
- [ ] 保存脱敏矩阵并提交 `docs: record Composio authorization and routing evidence`；若无账号，只提交明确 unobserved 的记录，继续 Plan 1。

### Task 3: Google 工具、游标与错误契约

**Consumes:** 已 pin 的工具 schema 和授权连接。**Produces:** 每个必需行为 pass/fail/unobserved + schema/offline/live 层级；固定 endpoint Proxy 是否确有必要的结论。

- [ ] 在 contracts JSON 中登记以下能力对应的真实 slug（前四个已在目录找到，邮件列表/正文/日历枚举须从 catalog 核对）：GMAIL_GET_PROFILE、GMAIL_LIST_HISTORY、GOOGLECALENDAR_EVENTS_LIST、日期 pin。列出请求必需参数、分页字段、响应 envelope、错误字段的精确路径；公开 schema 保留原样，不把私有示例响应当 schema。
- [ ] Gmail：先 profile history 基线，再对选定测试标签进行小页列表/正文读取，然后 history 分页补拉。验证 historyId 字符串无数值精度损失、pageToken 传递、labels 变化、删除事件、空页与 has-more。用户未制造某项变化时该项 unobserved。用失效 history 测试原始错误映射，必须区分 history404 和 message404。
- [ ] Calendar：固定同一日历，初始列表到 nextSyncToken；后续只带服务商允许的稳定参数，测试 showDeleted、nextPageToken、取消事件、重复实例 originalStartTime、时区和全天日期。另做 bounded timeMin/timeMax 快照；不得把它们与 syncToken 混用。令用户在测试日历改期/取消时记录前后是否被观测到，不在脚本增加写操作。
- [ ] 401/403/404/410/429 的测试逐项记录真实 HTTP 层与工具 envelope 层。无法自然诱发的 live 错误保持 unobserved，同时离线构造相同形状验证分类：

```js
assert.equal(classify('gmail-history',404),'cursor_expired')
assert.equal(classify('gmail-message',404),'object_unavailable')
assert.equal(classify('calendar-events',410),'cursor_expired')
assert.equal(classify('calendar-events',403),'permission_denied')
assert.equal(classify('calendar-events',429),'rate_limited')
```

`classify(operation,status)` 在探针脚本定义，status 是从 live 证实路径取出的原始 provider status；若 Composio 丢失此字段，不依据英文错误文本 regex 猜测，返回 unknown 并记录契约缺口。
- [ ] 测试分页中途预算耗尽后从私有状态继续，既不重复扩大读取范围，也不把未读对象算删除。每日核对/窗口推进完整算法属 Plan 2，此处只确认按 ID 读取、分页与游标能力。
- [ ] 只有明确必需参数缺失或错误透传缺口时，测试对应固定 GET Proxy 路由。保存该路由的 method/path/query allowlist；不暴露任意 proxy 参数，不以 Proxy 取代所有正常工具。
- [ ] 输出逐能力矩阵和 Plan 2 决策：Gmail history 是否可用、Calendar token 还是 bounded snapshot、删除确认方法、Proxy 必需操作、尚待真实验收项。提交 `docs: pin Google connector contracts and probe limitations`。

### Task 4: 密钥重启通路证据与 Plan 2 入口

**Files:** 探针脚本/测试/报告；只读检查 `clients/desktop/src/main/settings-store.mjs`、backend.mjs、backend-supervisor.mjs 及对应测试。生产 SECRET_KEYS/SECRET_ENV_MAP 的新增留给 Plan 2。

- [ ] 做不含真实 key 的最小子进程实验：用 `fixture-old` 启动进程，父进程变更为 `fixture-new`，原子进程仍读 old；新 spawn 才读 new。子进程只输出 `matchesExpected:boolean`，不打印变量值。验证显式清除与未配置继承行为，测试策略函数：

```js
function effectiveKey(setting,parent){
 return setting.kind==='cleared'?undefined:setting.kind==='saved'?setting.value:parent
}
assert.equal(effectiveKey({kind:'cleared'},'fixture-old'),undefined)
assert.equal(effectiveKey({kind:'unset'},'fixture-old'),'fixture-old')
assert.equal(effectiveKey({kind:'saved',value:'fixture-new'},'fixture-old'),'fixture-new')
```

- [ ] 对照 desktop 当前 SECRET_KEYS→加密存储→SECRET_ENV_MAP→capabilityEnvironment→spawn 的实际代码，报告哪些现有行为已证明，哪些需 Plan 2 修改；特别核查清除后父 env fallback 与 agent/MCP env 继承。此实验不冒充生产桌面 composioApiKey 已接通；生产集成与 installed app 证据分别留在 Plan 2/3。
- [ ] 运行离线全套和 git diff --check；人工检查报告只含白名单字段、公开 schema 与无私密账户的错误分类。
- [ ] 报告必须包含矩阵列 `case | layer | status | evidence | implication`；evidence 是脱敏断言与时间、脚本版本，不是原始 response 文件。账号缺失的项 status=unobserved、implication 写明阻塞哪项；不能把整个 Phase 0 标全绿。
- [ ] 达到退出条件后写 Plan 2：以已固定 schema、账户身份、范围模式、错误路径为输入；若关键 live 契约失败先改设计/受限 fallback，再规划集成。未解决账号隔离或分页契约时不假设可用。提交 `docs: conclude Composio probe and integration prerequisites`。

## 依据与自审

- [工具执行与日期 pin](https://docs.composio.dev/docs/tools-direct/executing-tools)：代码解析响应需固定版本，Proxy 是例外路径。
- [账号与 link 迁移](https://docs.composio.dev/docs/auth-configuration/connected-accounts)：托管 OAuth 使用 link，账号 state 不用于提取 token。
- [获取公开 schema](https://docs.composio.dev/docs/tools-direct/fetching-tools)：探针读取实际工具 schema 后固化契约。
- [Google Gmail 同步](https://developers.google.com/workspace/gmail/api/guides/sync)、[Calendar 增量同步](https://developers.google.com/workspace/calendar/api/guides/sync)：游标失效与同步模式的原始语义。

五个 Review Focus 均有对应任务。Phase 0 只产出探针及事实，Plan 1 不等待真实账号；Plan 2 等结论。代码实施前审阅本计划，真实 OAuth 需要用户选择测试账户/范围，不能从“允许发送设计给 Claude”推导读取邮件授权。
