# 持续资料处理交付与 Scheduler 接入

## 本分支交付范围

本地 SQLite evidence 仍是原文存储，不另建全文仓库。新增 source_processing worker operation，以及 PersonalMemoryResource.sourceProcessing 的 host-only 入口。用户空间、模型处理指纹与 recipe 由 resource 注入，模型参数不能指定这些字段。

已实现变化日志、一次性旧数据导入、长文分块、处理成功游标、单用户未完成批次、任务/运行绑定、幂等提交、主题索引、原文回查和单独的画像草稿发布。画像草稿存于 processing_profiles，不覆盖 ProfileWarmup 或正式 Profile。无变化 claim 返回 null，不涉及模型调用。

每次最多扫描 200 个变化记录，模型批次最多 8 块、16000 个 UTF-16 字符，每块最多 4000 字符。超过一页的无权限记录可以返回 null 但 pending_changes 仍非零；调度方下一次继续检查，不能把 null 当成全库处理完成。每批完成后才推进成功断点；无效或已处理记录可在无模型调用时推进扫描位置。processed_chars 是累计处理量，pending_changes 是变化记录数，均不冒称唯一文档覆盖率。

缓存键包含模型处理指纹、host recipe、内置算法版本、原文/元数据、来源版本和授权状态。接入时 sourceProcessingRecipe 必须包含实际 Agent 任务提示词及画像处理算法版本的稳定 hash；修改提示词不能继续使用旧 recipe。recipe 或模型切换时不覆盖旧的未决运行，status 暴露旧批次和 reconciliation_required。

## Host API

`memory.sourceProcessing(request)` 返回 worker 的序列化结果；输入由 processingRequestSchema 验证。所有写操作只供可信 host 使用，不直接注册为普通会话模型工具。

| action | 输入 / 输出 | 整合要求 |
| --- | --- | --- |
| status | 扫描 cursor、high_watermark、pending_changes、active_batch、最近成功、累计处理量 | 可投影到来源状态；旧 recipe 的阻塞批次也可见 |
| claim | 返回原 active batch、新 batch 或 null | 前台繁忙/预算用尽时不调用；本操作不创建 Task |
| bind | batch_id、task_id、run_id | 仅绑定已持久的真实 ScheduleRun + Task，重复绑定须一致 |
| read | batch_id → 本批原文块/来源元数据或 null | 每次读取重核当前模型授权、版本与消息归属 |
| topics | query、after、limit → 索引条目和分页游标 | 低信任摘要仅用于选择；失效引用不返回 |
| evidence | 绑定的 batch/task/run + refs → 当前原文块或 null | 用于按主题回查历史；一轮最多 16000 字符 |
| commit | 绑定的 batch/task/run + topics | refs 必须来自本批；原子提交主题、receipts 与处理断点 |
| profile | 当前 recipe 的草稿与 CAS revision | 无效引用条目隐藏；不是正式 Profile |
| publish | 绑定关系、expected_revision、draft、refs | 必须在本批实际读取过相同原文 refs，版本必须匹配；再次核验权限 |
| fail | 完全匹配的绑定关系 | 只有确认 Task 已终止才能调用；保留旧草稿、不推进成功断点 |
| retire | batch_id、原 task/run（可为 null）、明确 reason | 升级/切换后的 host 恢复入口：先核实 Task/Run 账本；超时或未知状态不能作终态依据 |

来源删除会在同一事务删除相关主题正文，裁剪相关 Profile 条目并保留无关条目；混合主题的仍有效输入重新排队。永久 purge 使用同一触发器清除派生正文，再沿用现有压缩流程。旧消息没有 head 时采用已有 profile_evidence 的 rowid 回退规则；A→B→A 的新激活也不会复活旧摘要。

## 尚未完成的 Scheduler 整合

只读核查的 ScheduleService 当前 authority 是 ui/user_turn，trigger 是 scheduled/manual，日历规则是 once/daily/weekly。缺少默认注册 built-in authority、资料变化合并唤醒、固定周期维护与无变化 preflight。这里没有拷贝对方未完成代码、伪造用户来源、另造计时器或自动启用第二个 Profile 生成器。

整合方应在同一个调度系统中增加 source-maintenance built-in：默认注册启用，只有来源范围和模型处理配置有效时工作。资料变化先落盘再唤醒；周期兜底先做 preflight。claim 产生批次后，用 batch.id 作为稳定幂等键冻结 ScheduleRun，复用 TaskService 的真实后台 runtime；先反查旧 run/task，再创建和 bind。重启时先核对 batch/run/task 三者关系，再恢复原 namespace；未决任务不重新派发。

Agent 负责读取索引、选择原文、判断归属和写作，Scheduler 只决定执行时机。每轮一个有限预算批次；前台优先、全局后台并发、超时、失败退避及任务终止核验复用共享 Task 调度层。语义失败不能通过 fail 立即无限循环重试。无变化不调用模型，不为每条消息建 Task，不在每轮发送状态消息。

正式 UI 状态、默认任务启用、真实后台 Task 触发、Task 重启恢复和 Profile 正式替换尚未接通。因此本分支不能被标为完整内置任务交付。

## 验收及限制

确定性测试包含长文尾部、多批资料、增量追加、无变化、重启、绑定去重、伪造 refs、撤销/重授、消息 A→B→A、旧库版本、recipe 切换恢复、CAS 发布、永久 purge 字节检查、删除后保留无关内容，以及真实 worker 的身份隔离。Runtime 构建通过，专项测试 13/13、相关回归合计 179/179 通过；新增模块和专项测试 ESLint 通过。

隔离 live 使用真实 DashScope qwen3-vl-plus，仅提交脚本内的合成本人消息。2 个批次、8 次真实模型请求完成主题索引、原文回查及独立草稿发布；重启空闲与撤销检查通过，原 Profile 和飞书配置哈希未变。第一次沙箱网络请求报 TransportError，经批准的网络执行后通过。

此 live 的 task/run ID 是明确标注的 fixture，不是实际 ScheduleService/TaskLoop 运行。真实后台触发未验收。首次生成正文夹带内部引用别名；最终复跑虽没有这些别名，仍将未直接支持的“团队或助手产出”扩写进个人描述，因此画像语义与文风未通过验收；沿用父任务待交付的写作改进，不以字符串规则硬删来冒充文风修复。

公开仓库只保存合成 live harness；数据库、模型输出、日志和恢复资料保存在工作区外。没有提交真实飞书消息、邮件正文、文件正文或模型凭据。未推送、未部署。

## 合并顺序

父任务冻结状态单独保存为 `9fe112e6`。后续增量提交只包含 source_processing 实现、resource 接口、测试、合成 live harness、设计与本接入说明，并恢复初始化 checkout 自带的飞书状态回归测试。父任务已有同等冻结改动时不要重复合并基线提交；在处理父任务之后的小修订冲突后，只合入后续增量提交。
