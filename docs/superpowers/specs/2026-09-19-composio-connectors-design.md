# Composio 应用连接与持续同步设计

日期：2026-09-19。目标分支：`v0.3.0dev`。

状态：修订稿已获用户确认（2026-09-19），进入 Phase 0 与 Plan 1 计划编写；产品实现与真实账号验收尚未开始。执行拆分见 §14。

## 1. 目的与已确认方向

用户希望 Nova 接入更多日常应用，尤其邮件、日历，并像现有 IM 渠道一样定期获取变化，形成有来源的记忆和建议。最终决定先使用 Composio，未来端侧模型阶段再评估本地连接器；本版不开发 macOS EventKit、Mail 自动化或本地 MCP bridge。

Composio 负责授权连接及云端服务调用。Nova 负责读取范围、后台同步、对象身份、记忆一致性和执行授权。模型部署位置与连接器部署位置独立：切换端侧模型不会自动移除 Composio 的云端数据处理。

首个完整同步闭环选用 Gmail + Google Calendar，复用一个服务商生态验证邮件与日程联动。Outlook、Slack、Notion 等后续通过相同边界扩展，不能仅因 Composio 支持它们就显示为已支持后台同步。此选型是本设计的具体建议，不代表此前已完成账号验收。

## 2. 现状与复用

- `runtime/src/connectors/feishu/index.ts`：每轮完成后等待 60 秒再同步；已有选择范围、分页检查点、重叠窗口、暂停、断开、generation 和删除历史。
- `runtime/src/composition/production-composition.ts`：连接器将证据交给记忆，通知 personal host 来源更新；删除后重验建议并刷新记忆。
- `runtime/src/memory-substrate/store.ts`：证据类型已包含 mail/calendar，但 `resource.ts` 的 `ingestEvidence` 目前只接受 im/task_result；不能把新数据伪装为 IM。
- `runtime/src/executors/mcp-client.ts`、`mcp.ts`：已有有界 MCP I/O、工具白名单和严格 schema；不需要重写通用 MCP 客户端。
- 桌面 `settings-store.mjs` 已有系统加密凭据存储；继续复用，不创建第二套明文密钥配置。

参考 OpenMausBot 的主机持有密钥、多账户选择及后端生成授权链接。不同于直接挂载完整 Composio MCP，本版由主机调用明确的 provider 操作，后台同步不通过模型规划工具调用。

飞书目前跳过 deleted 消息；其定时器、连接状态模式可参考，但不据此宣称现有 IM 已具备完整删除同步。本次不重写飞书同步；唯一必要例外是共享模型处理同意门控：飞书和目录需显式传递、持久化已有用户同意，替换 composition 中硬编码的 true，兼容旧状态的安全默认值见 §5。

## 3. 范围与非目标

首版包含：Composio project key 设置、Gmail/Calendar 独立授权、账户及范围选择、定期只读同步、来源证据与记忆更新、暂停/断开/删除、覆盖与错误可见。按需远程只读查询延后，不新增前脑工具面；已有本地记忆检索继续使用。

首版不开放发送邮件、修改标签、创建草稿、修改/取消日程、Composio 远程代码沙箱、任意 HTTP proxy 或任意工具执行。后续写操作逐项进入 Nova 的结构化执行授权路径，读取许可不得变成写许可。

不建设应用市场、通用插件安装器、云端 webhook 服务或多租户凭据代理。不承诺 Mac 关机、Nova 退出后持续同步。不接入组织专属信息；公共分支继续遵守现有隔离约束。

## 4. 组件与调用关系

桌面设置 → 主机连接管理 → Composio 连接/账号 API。

主机同步调度 → Gmail/Calendar provider → Composio 明确工具或受限 Proxy → 服务商 API。

provider 变更 → 来源对象状态与证据账本 → 既有记忆抽取/索引 → 批次合并的宿主通知 → 建议重验及界面刷新。

`sourceChanged()` 会刷新记忆、重验并可能触发 discovery；一轮 200 对象不得调用 200 次。每个已提交批次最多发一次来源失效通知，同步检查点不等待模型；本批抽取完成后合并发一次记忆就绪通知。通知带单调批次 revision，host 合并在途通知并使用包含 mail/calendar 对象激活版本的签名，不仅依赖现有本地目录 refs 签名。失效立即阻止旧建议交付，新内容抽取完成后才参与发现；禁止逐对象 flush 全局抽取队列。

组件只按实际职责拆分：

| 组件 | 职责与边界 |
|---|---|
| Composio client | 主机持有 key，固定可信端点，超时/响应预算，账号授权/查询/断开，结构化错误 |
| Google provider | 邮件线程、标签、日历事件/重复规则、游标及服务商错误语义；不负责模型调用 |
| 同步管理 | 账户和范围状态、调度、恢复、generation、检查点和预算；不理解 Composio Session |
| 来源写入 | 对象版本、证据替换/撤回、删除级联、忘记抑制，幂等写入 |
| desktop/personal host | 设置命令及只读状态投影，范围同意、同步状态及模型处理许可 |

Provider 最小能力为：账户/范围枚举、有界快照页、变更页、按 ID 读取。每页返回对象变更、下一页位置，以及本次范围是否完整；检查点为 provider 自己解释的持久 JSON。无变更游标的 provider 必须声明只支持快照核对，不能伪造游标能力。

未来按需查询复用同一 provider、账户和范围检查，不推进后台检查点；本版不实现该入口。

## 5. 授权与凭据

首版为用户自带 Composio project key，不内置共享项目密钥。桌面新增 `SECRET_KEYS.composioApiKey` 条目和 `SECRET_ENV_MAP` 映射（即数组中的键名，不改变现有数据结构），经现有安全 IPC 写入系统加密存储，在 spawn 时注入 `COMPOSIO_API_KEY`；CLI 使用同一环境变量。密钥不在状态回传、模型、日志或持久 renderer 状态中出现，不转发给 agent/MCP 子进程。

保存或清除 key 显示“重启 runtime 后生效”，使用既有受控重启流程；本版不实现热换 key。重启前停止并排空旧采集，重启后核对项目/连接归属，验证成功前暂停旧连接，不因新 key 无效清空旧数据。显式清除必须阻止父进程旧环境变量重新注入，区别于“未配置、允许 CLI 环境继承”；此覆盖语义纳入 backend 测试。key 轮换不自动删除来源或推进数据 generation。

每个 Nova 连接分配并持久化独立随机 Composio user_id，一个该 user_id/toolkit 只允许一个可用 connected account；同时保存并在执行时显式传 connected account ID，别名只用于展示。账户数量异常或 provider 身份核对不一致时停止同步，不选择“最近连接”。Gmail 和 Calendar 分别建立连接；重新授权需禁用/移除旧的执行连接并再次核对身份。

这是降低路由歧义的隔离策略，仍须 Phase 0 实测，不宣称能绕过所有上游路由缺陷。issue #3470 报告 Google Ads 的 customer_id 注入问题，正文说明其他 toolkit 正常，且状态已关闭；不能推导 Gmail/Calendar 也有相同故障或独立 user_id 必定修复。Composio user_id 是执行路由标识，不进入服务商对象身份。

v1 允许 Composio 托管 OAuth 默认 scopes，界面如实显示它们可能包含写权限；Nova 在主机操作白名单强制只读，不把两者混为一谈。请求 scope 与实际授予 scope 分开展示，实际值不可查询时标为未知，不推断只读。要求严格 OAuth 只读的部署可配置限制 scopes 的 auth config，作为 Phase 0 对照，不增加首版必须自建 Google OAuth 应用的门槛。

官方当前文档支持使用托管 OAuth app 的 auth config 自定义 scopes；创建 auth config 与自行注册 OAuth app 不等价。Gmail/Calendar 的具体支持、默认范围及后台执行可用性由探针验证。授权完成不自动开始采集：用户选择范围并确认数据处理方式后开始。

使用 connectedAccounts.link()/对应 hosted Connect Link API 生成授权链接，校验 HTTPS 与可信域，浏览器完成 OAuth，主机有界轮询连接状态。托管 OAuth 的 initiate() 已自 2026-07-03 起对所有组织停用，不采用旧示例。中断后重新查询连接状态，不把超时当成功；切换 key 后不能未经核对沿用旧项目的连接 ID。

Composio Cloud 会托管 provider 凭据并代为请求。界面分别说明 Composio 处理和模型/embedding 外发，不把“本地存储记忆”描述为全链路本地。

同意记录绑定连接、scope revision 和模型/embedding provider fingerprint。未授权模型处理时只保存获准读取的本地来源数据与同步状态，不调用 LLM 抽取、摘要或 embedding；不能只将 embeddingConsent 设为 false 却仍发出抽取请求。更换处理服务商要求重新核对同意，在队列出队和实际请求前检查；撤销同意后停止新外发。

门控落在共享 `SubstrateMemoryResource` 抽取入口、重抽取和实际模型请求边界上，不只包住 Composio 调用者。飞书/目录已有勾选框值通过 command → 持久同意记录 → 来源写入显式传递，移除 production-composition 的 `embeddingConsent:true` 和 `embedding_consent:true`。旧状态缺少同意证据时不从“曾同步过”推断同意：保留本地数据，暂停外发并提示补确认。只读采集许可不自动扩展到模型或 embedding；与此无关的飞书流程保持原状。

不依赖从 Composio 导出原始 provider token。主路径为 pin 日期版本的明确工具：`GMAIL_GET_PROFILE`、`GMAIL_LIST_HISTORY`、邮件分页/正文工具和 `GOOGLECALENDAR_EVENTS_LIST`。Phase 0 保存实际 schema，验证 historyId、分页、syncToken/showDeleted、取消及原始错误的透传；目录列出工具不等于这些契约已验收。只有确认某个必须参数缺失时才启用对应固定 endpoint/method/query 的 Proxy 兜底，用户或模型不能提供任意目标。Proxy 不继承 Session 限制，本地范围与操作检查始终执行。

## 6. 数据身份与写入一致性

连接状态保存 connection ID、provider、connected account ID、用户可读账户名、scope 配置和 scope revision、data generation、run epoch、授权状态、运行状态、检查点、最近尝试/成功时间与结构化错误。凭据仅保存引用。

凭据未配置、系统凭据库暂时不可读、服务商授权过期分别展示；暂时不可读不得清空连接列表或覆盖已有密钥。状态结构升级使用现有 `schema_migrations`；损坏时停止该连接，不静默重置进度。复用 `acquirePersonalLock` 的主机锁，避免两个 runtime 推进同一检查点，不引入第二套锁实现。

对象键由 provider + 明确账户身份 + 对象种类 + 原始对象 ID 组成；Calendar 加 calendar ID，重复实例保留 recurringEventId/originalStartTime。标题、正文和邮箱别名不能作主键。Composio 连接 ID 与服务商账户身份分别保存；重授权只有核对服务商身份后才能关联旧状态。

每个对象保存当前 provider revision/内容指纹、结构化元数据、当前 evidence IDs、所属范围和最后观察时间。邮件保留 message/thread ID、参与者、服务商时间、标签与正文；日历保留时区、全天日期、开始/结束、重复规则及例外、取消状态和原始定位符。

身份字段有长度上限；内部键使用固定长度摘要，原始长 ID/URL 放在受控元数据中，避免越过现有 MemorySourceRef 的 256 字符限制。联系人元数据新增 provider 命名空间；不得沿用当前抽取代码中的“飞书联系人”标签描述邮件发件人。

证据行保持现有内容寻址 ID，不增加 current/status/version 效力字段。对象表保存 `current_evidence_id`（分块时为集合）和单调 `activation_revision`；效力由对象 current 指针派生。A→B→A 的最后一个 A 复用第一行 A，但对象激活版本再次递增，必须重新应用派生状态。旧的 evidence ID 单独不足以授权迟到模型结果：还需匹配对象 activation_revision 和处理同意 revision。

“新语义版本”由规范化领域内容决定：邮件正文、主题、参与者、线程归属，日历时间/时区/全天/重复规则/例外/取消及事件内容属于语义输入；标签、已读/星标、provider etag/historyId 本身仅更新对象元数据。选中标签的变化仍可触发范围进出，但仅标为已读不得把承诺 tombstone。服务商 revision 用于传输顺序与去重，不直接等同语义版本。

从 A 切到 B 时，在同一事务改变 current 指针并使 A 不再有效；只依赖失效依据的推断记忆形成 tombstone，清除相关向量并使建议失效，再对 B 重抽取。混合依据记忆只可保留仍由有效依据支持的内容；无法确定时阻止其参与发现，重抽取后恢复。用户明确陈述/纠正的独立依据不被外部修订覆盖。最后 A 重新激活时也要重建派生状态，不能被现有 evidence_id 级 `extraction_done` 跳过；抽取任务/完成标记需关联对象激活版本，仍可复用内容提取结果但重新校验及 merge。原始来源时间与观察时间分别保存。

`source_id` 按对象粒度包含 connection namespace、data generation 和对象键摘要，限制在现有长度内。物理删除前先持久化递增 data generation，并保留待删旧 generation 清单供崩溃恢复；新采集永不重用登记在 `memory_deleted_sources` 的 ID。暂停、断开或重启只改变运行 epoch/取消旧任务，不增加数据 generation，也不调用 `delete_source`；断开保留已有内容。范围移出/普通修订采用 current 效力撤回，可重新进入，不能误用永久删除。

来源内容和变更先可靠落盘，再推进 provider 检查点。无需跨数据库强求分布式事务：采用持久变更批次和幂等应用，重启后先完成未应用批次，最后提交检查点。run epoch、data generation 和 scope revision 的匹配检查在最终写入边界执行；仅在网络调用前检查不够。

持久化优先复用现有 memory worker 的 SQLite：增加连接同步状态、对象当前版本和批次进度表，同一事务提交对象变化、证据有效性及本页已应用位置。密钥仍在系统凭据库；连接设置可在模型未启动时完成，采集需本地账本可用，缺失时明确暂停。初始列表返回的待取正文 IDs 和当前页剩余工作也要落盘，不能取得列表下一页 token 后就跳过本页未取正文。已提交页可恢复，内存队列仅用来唤醒工作。

按对象维护来源引用，支持单个对象撤回和整连接删除。新增语义需要在现有账本接口补齐，不复制另一套记忆库。外部正文始终是低信任证据，不能直接变成 dispatch 或授权。

当前 `delete_source` 会永久登记来源已删除，不适合作为普通版本替换接口；当前 `append_evidence` 也不替换同 ID 的 payload。实现补充对象 current 事务边界，普通修订与用户删除分别处理。检索、pending extraction、模型返回后的 merge、索引和建议校验共用同一有效证据判定，包含 current、保留期、抑制标记及适用的处理同意。未纳入对象表的旧来源沿用兼容判定，不因没有 current 行被全部判失效；不得出现一个路径按存在性、另一个按 current 判定的分歧。

## 7. 同步算法与默认预算

每个连接一次只运行一轮；全局最多两个连接并发。正常轮次结束后间隔 60 秒；错误退避为 1、2、4、8、15 分钟封顶并带抖动，遵守 Retry-After。网络恢复、唤醒及重新授权触发一次去重后的补同步。

每轮上限：20 个 provider 请求、200 个正文/事件对象、5 MiB 解码后数据、30 秒。单次请求最长 15 秒、响应最多 2 MiB；批次达到预算即持久化进度并显示“同步中”，不得显示为范围已完整同步。下一轮继续。各限制由主机强制，服务商更低上限优先。

首次默认范围：用户明确选定标签中的最近 30 天邮件；选定日历过去 30 天至未来 90 天的事件。附件不自动下载，HTML 转可读正文且不加载远程资源。邮件默认原文保留 30 天；日历对象结束 30 天后清理正文，仍有效的重复系列按当前覆盖窗口维护。保留期到期不是服务商删除，来源状态需区分。

邮件 30 天按 provider 接收时间计算，不因轮询、重启或重授权延长；日历按事件结束时间计算，全天日期使用日历时区。滚动窗口在一批扫描开始时冻结，下一批才推进，防止同一批各页比较不同的范围。正文超出证据单条上限时显示截断标记并保留原始定位符，截断内容不得被宣称为完整线程或完整事件。

### Gmail

初始快照开始前记录 history 基线，按范围分页读取 IDs 和正文，再从基线补拉期间变化；全部应用后提交新 historyId，避免扫描期间漏信。history 分页使用稳定批次起点，最后一页才推进已完成水位。

新增、标签变化、删除通过 history 处理；标签进出范围要重新判定成员关系。线程按当前授权范围检查，不为判断“待回复”静默读取未授权邮件；证据不完整时明确标识。历史游标失效触发受限重建，不把 history 端点的 404 当作单封邮件删除。

### Google Calendar

每个日历独立保存 syncToken 和分页状态。使用服务商允许的稳定查询参数获取初始集合及后续变更，不能把与 syncToken 不兼容的 timeMin/timeMax 塞进增量请求。Nova 本地执行已同意的正文保留窗口；若同步要求读取更宽的事件元数据，须在授权范围说明中明确。未获该同意则使用有界窗口快照核对并如实显示该模式。

保留重复系列、例外及取消语义，按当前窗口形成实例视图。定期推进窗口并补取新进入窗口的实例，不能仅等待事件修改。410 触发新的扫描批次重建，不改变用于来源身份的 data generation；重建期间原结果标为陈旧，完整核对后再应用缺失对象撤回。被截断或失败的快照不能证明对象删除。

### 周期核对

每天对已授权覆盖范围做一次分批核对，补偿分页期间对象移动、游标边界及窗口推进；保持同样的预算和检查点。只有成功完成同一账户、同一范围版本的全部扫描，才能依据“未出现”撤回对象。权限丢失、账户离线、窗口外对象、截断和临时 API 错误均不得推导删除。

分页 API 不保证原子快照时，完整遍历只是核对前提，不是删除的充分证据。对“原来存在、本次未出现”的对象，再按 ID 查询并检查范围，或使用可靠变更流确认。对象仍存在但移出范围时标记 coverage_removed，不宣称会议取消；单次 404 与权限/容器状态有歧义时保留陈旧标记并重试，不立即删除。无法解析、超大或读取失败的对象记录为 skipped/error，也不能计作不存在。

## 8. 暂停、断开、删除与恢复

| 操作 | 行为 |
|---|---|
| 暂停 | 持久化暂停并阻止新请求，增加 run epoch 并取消在途请求，拒绝旧 epoch 写入，已有记忆保留 |
| 恢复 | 重新核对授权/账户/范围，从可靠检查点继续；游标失效执行重建 |
| 断开 | 先本地停止访问，再移除 Composio 连接；不调用 delete_source，保留本地内容并显示已断开；若 provider 撤销不支持或失败，显示手动撤销步骤，不声称已撤销授权 |
| 删除本地来源数据 | 先暂停并持久化增加 data generation，再清理旧 generation 的对象、证据、索引及关联建议；不删除云端邮件/日历 |
| 用户忘记 | 保留最小不含正文的抑制标记，防止重连或重放立即重新形成相同记忆；用户明确重置后才解除 |
| 缩小范围 | 取消旧范围任务并撤回被移除范围的数据；扩大范围显式同意后补同步 |

授权状态与同步错误分别保存；429/网络失败不能改成“未连接”。同步进度包括未完成页和对象数；最近成功时间仅在完整轮次结束后推进。

Composio 连接替换、本地 provider 切换不按邮箱名自动合并。未来迁移核对服务商对象 ID，先停止旧采集再启用新采集；不能让两个渠道同时创建同一对象的重复记忆。

## 9. 设置和调用入口

在现有连接与权限设置中增加“应用连接”：配置 Composio → 连接 Gmail/Calendar → 选账户及范围 → 确认后台采集和模型处理 → 查看状态。

每行展示账号、服务、读取范围、授权状态、同步中/暂停/错误、最近成功时间、实际采集量；提供立即同步、暂停/恢复、断开、删除本地数据。错误使用可操作分类，日志不含 key、OAuth URL 参数和邮件正文。

后台同步由主机调度，不受当前会话和当前 coding backend 影响。连接操作扩展现有 `personalCommandSchema`，不再建立并行控制 API。本版不注册远程查询/通用 Composio 执行工具。已有有界 fetch 优先提取真正共用的响应预算/取消部分；保留各调用方端点及鉴权策略差异，不再复制第四套 readBounded，也不为统一而放宽 MCP 的网络边界。

## 10. 未来本地替换

保持连接器边界以服务商对象和变更页为中心，不让 Composio Session ID 进入记忆主键。未来 EventKit、Mail bridge 可替换 provider；连接设置仍需呈现本机权限差异。

本地快照没有云端 durable cursor 时使用完整性标识和核对，不追求假装相同的底层协议。现阶段不编写这些 provider、不引入 orchard/Macuse，也不把它们作为产品依赖。

## 11. 验收与发布边界

使用隔离状态和伪 provider 的确定性检查覆盖：重复页、乱序重试、A→B→A、分页预算、游标过期、断网与429、线程不完整、重复/全天/跨时区事件、取消、窗口推进、对象移出范围、账户隔离、暂停/换账号后的晚到响应、删除中崩溃恢复、忘记后重连。

对真实 Composio 验证授权、已授予 scopes、account 路由、工具版本响应及 Proxy 所需端点；未通过时不能把替代工具查询视为同步验收。

桌面安装版验证安全存储、浏览器 OAuth、状态刷新、退出/重启/睡眠恢复及删除交互。真实账号由用户选择范围并授权后读取；测试内容创建/修改/删除由用户或明确授权的隔离测试账户完成，本版只读 connector 不借验收开放写工具。

完成判据：一封新邮件进入来源，日历改期后旧建议失效，取消后提醒撤回；重启不重复；暂停/断开后停止；删除本地来源后检索与仅依赖该来源的记忆不再有效。

分别报告代码检查、伪 provider 检查、真实账号调用、安装版交互与发布状态。无真实账号权限时明确该验收尚未完成，不能宣称全链路通过。本次设计提交仅包含本文，不推送远端。

## 12. 依据

- [现有来源规范](../../specs/v0.3.0/04-sources-and-connectors.md)
- [Composio 凭据托管](https://docs.composio.dev/docs/security/token-custody)
- [Composio 执行与 Proxy](https://docs.composio.dev/docs/tools-direct/executing-tools)
- [Composio 只读及工具限制](https://docs.composio.dev/kb/guide/platform-session-tool-policies)
- [Gmail 同步](https://developers.google.com/workspace/gmail/api/guides/sync)
- [Calendar 增量同步](https://developers.google.com/workspace/calendar/api/guides/sync)
- [Composio Connected Accounts 与 link 迁移](https://docs.composio.dev/docs/auth-configuration/connected-accounts)
- [托管 OAuth 的 scopes 配置](https://docs.composio.dev/docs/authentication/controlling-scopes)
- [多账户模式](https://docs.composio.dev/docs/authentication/managing-multiple-connected-accounts)
- [Google Ads 路由问题 #3470（非 Gmail 已知故障的证据）](https://github.com/ComposioHQ/composio/issues/3470)

以上 API 资料已在本次调研读取；实现时对固定工具版本及原始 API 参数再次核对。OpenMausBot 仅作为接入模式参考，不迁入其企业/托管部署配置。

## 13. 本轮审阅记录

用户明确授权把代码和计划发送给本地 Claude CLI 的 `claude-fable-5-1`。首次调用因 ENOTFOUND 失败；联网重试仍未产出可用审查意见，用户表示不强求后结束调用。返回状态为 error_during_execution，不能计为外部评审通过；未使用其他模型替代。

本地自审已补齐：永久来源删除与普通修订分离、模型返回后的证据效力检查、读取/抽取/embedding 分别授权、长对象 ID、非飞书联系人身份、凭据库不可读与未配置区分、单实例状态锁、保留期固定基准、完整分页不等于原子快照。

自审检查文档中的本地链接、占位项、范围与阶段声明。此记录证明设计审阅过程，不代表代码、账号或设备验收。用户已确认修订稿，后续按 §14 编写独立实现计划。

用户审阅提出的 7 项已在修订稿落实：current 派生效力及语义版本、generation 来源身份、共享同意门控、批次通知、link/默认 scope/连接隔离、spawn env 与 runtime 重启、分阶段交付。另采纳延后按需查询及复用锁/迁移/命令/fetch 的建议。scope 可调整与 Google Ads issue 的适用范围按本轮官方资料校正，不将未证实 API 行为当成事实。

## 14. Phase 0 与三个独立实现计划

本文不是单一实施计划。修订稿获确认后，先同步 04 卷 §4、06 卷 §10、STATUS 中本次已决策的条目；无关待评审项保留，不能把设计决定标为实现完成。再使用 writing-plans 编写 Phase 0 和 Plan 1；此时不展开 Plan 2/3 的逐文件任务。

| 阶段 | 产物与退出条件 | 依赖 |
|---|---|---|
| Phase 0：契约探针 | 在隔离账号/状态中验证 link、默认及限制 scopes、pin 工具 schema、history/profile、Calendar syncToken/showDeleted/分页、错误映射；双账户交错读取验证独立 user_id + account ID 以及实际服务商身份；验证密钥重启通路。形成脱敏证据和通过/失败/未测矩阵，不能输出凭据或私有正文 | 经用户选择范围并授权的 Composio 测试连接；没有条件则明确阻塞对应实测，不凭 mock 通过 |
| Plan 1：provider 无关底座 | 对象 current/activation、generation、统一证据效力、共享处理同意、幂等批次及检查点、合并宿主通知、schema migration；全部用伪 provider 与真实临时数据库可验证，保留 IM/目录兼容 | 修订 spec 确认；可与 Phase 0 并行，不依赖具体 Composio 成功 |
| Plan 2：Composio + Google + 桌面 | 根据探针实际契约编写账号/授权、工具调用、Google 同步及设置集成计划；逐项落实第一版范围，不使用“看起来可用”的 API 假设 | Phase 0 结论落地，Plan 1 接口明确后才编写；底座完成后集成 |
| Plan 3：安装版与跨层验收 | 连接真实账号、重启/睡眠、修改/取消/删除级联、真实权限撤销、回归及发布证据；新发现的问题回到负责模块修复，不能以验收阶段替代 Plan 1/2 的测试 | Plan 2 可用后编写，用户授权账号范围；发布/推送仍另行明确授权 |

Plan 1 的关键回归必须包含：A→B 时 A 的承诺失效，B→A 时恢复正确且不复活旧已忘记记忆；只改已读/标签不触发无谓语义重抽取；删除后新 generation 可写，断开不删除；旧 IM/目录同意的显式传递；200 对象的批次通知次数有界；晚到抽取对已失效激活版本拒绝 merge。
