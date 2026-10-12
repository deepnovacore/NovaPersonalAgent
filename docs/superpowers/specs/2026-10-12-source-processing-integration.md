# 持续资料处理交付与 Scheduler 接入

## 本分支交付范围

本地 SQLite evidence 仍是原文存储，不另建全文仓库。新增 source_processing worker operation，以及 PersonalMemoryResource.sourceProcessing 的 host-only 入口。用户空间、模型处理指纹与 recipe 由 resource 注入，模型参数不能指定这些字段。

已实现变化日志、一次性旧数据导入、长文分块、处理成功游标、单用户未完成批次、任务/运行绑定、幂等提交、主题索引、原文回查和单独的画像草稿发布。画像草稿存于 processing_profiles，不覆盖 ProfileWarmup 或正式 Profile。无变化 claim 返回 null，不涉及模型调用。

每次最多扫描 200 个变化记录，模型批次最多 8 块、16000 个 UTF-16 字符，每块最多 4000 字符。超过一页的无权限记录可以返回 null 但 pending_changes 仍非零；调度方下一次继续检查，不能把 null 当成全库处理完成。每批完成后才推进成功断点；无效或已处理记录可在无模型调用时推进扫描位置。processed_chars 是累计处理量，pending_changes 是变化记录数，均不冒称唯一文档覆盖率。

缓存键包含模型处理指纹、host recipe、内置算法版本、原文/元数据、来源版本和授权状态。resource 自动将实际 Agent 任务目标、系统指令和画像处理算法版本纳入稳定 hash；sourceProcessingRecipe 可追加部署级版本，修改提示词会切换 recipe。recipe 或模型切换时不覆盖旧的未决运行，status 暴露旧批次和 reconciliation_required。

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

## 已接入的 Scheduler 与 Agent 生命周期

使用已提交的 ScheduleService / TaskService / conversationRuntimeFactory。默认注册 host-only built-in“资料增量整理”，不伪造 ui/user_turn authority。来源变更回调立即唤醒现有 scheduledTaskTick；同一个 60 秒调度 timer 提供兜底，没有新增资料处理 timer。claim 前检查前台忙碌、未终态运行及持久退避，无资料变化不创建 Task、不调用模型。内置维护不向主聊天或 feed 发布每轮状态。

批次 ID 和 recipe 冻结进入运行目标与 definition hash。先持久 ScheduleRun、创建真实 Task，再绑定批次；恢复时反查同一 run，沿用同一运行 namespace。未知执行或未交付结果仍交共享恢复逻辑处理，不能凭超时重新派发。已确认失败记录终态，保留成功断点和好草稿，1 分钟起指数退避、最多 1 小时。旧 recipe 绑定与完成后撤权有专门恢复测试。

只在 built-in runtime 中注册 source__process。Agent 自行读取本批原文、检索主题、选择历史原文、决定是否 compose，最后提交 topics。最多 24 个工具调用、一轮 compose；拒绝第 25 个新调用时停止续轮，但第 24 个已接受结果仍可交付。每次原文读取仍为 8 块 / 16000 字符。compose 调用与 extraction 相同端点和模型的 GatewayPersonalWriter，复用父任务“一次自然成文→整份原证据编辑复核”流程；来源到 ProfileInput 的作者、本人身份、thread 和回复映射与普通 profileSources 共用。只有经本批原文读取、当前授权与版本检查、CAS 的草稿可发布。

所有模型轮次重新核查已读取的批次、历史原文、主题及旧画像来源；撤权后不能带着旧 provider 上下文继续。任务完成由持久批次回执及真实 Task evidence 判定，不依赖另一个模型声称成功。画像仍存为可审核的 processing_profiles 草稿，不改写已接受的正式 Profile。

Qwen 的流式接口要求至少一条 user 角色 wire message。后台使用明确标记 host_scheduled_task 的宿主激活 envelope 满足传输协议；内部仍是 host_task，不创建用户聊天记录，不生成用户授权 receipt。普通聊天、播报和任务来源仍分开验证。

## 验收及限制

持久化专项覆盖长文、多批、增量、空闲、重启、去重、授权变化、旧消息版本、recipe 切换、CAS、删除/purge、历史原文撤权。新增 Scheduler 集成覆盖默认注册、真实 Task/Run 工具循环、静默完成、重启不重复、持久预算/退避、换配置恢复、完成后撤权与作者归属。第三轮整合构建、变更 TypeScript lint 与 183 项相关测试通过，日志随交付保存；完整仓库测试未作通过声明。

真实后台合成验收脚本为 runtime/scripts/live/source-processing-background.mjs，使用真实 SubstrateMemoryResource、SQLite worker、Host、ScheduleService、TaskLoop、conversationRuntimeFactory 和 DashScope qwen3-vl-plus。它检查来源事件触发、重启空闲、现有 60 秒 timer 触发增量以及下一次空闲 tick 无模型请求，输出真实 task/run IDs。脚本已得到 status=passed：来源事件与真实定时器各完成一个批次，重启不重做，后续空闲 tick 零模型调用，原本机文件校验值不变。报告分别记录草稿发布与调度完成；通过的是合成资料后台生命周期，不等于画像语义或真实业务资料验收通过。此前 substrate-only live 的 fixture IDs 不能替代这项验收。

父画像第三轮增量补丁已合入：批次索引仅选原文，大样本最多选 40 条，正文作者与平台发送者分开。编辑说明不进入正文，普通画像与后台 recipe 均含新生成版本。通用 profileReviewer 注入未配置时仍使用同一模型，不自动引入第二个服务。允许有依据的主题归纳与适度扩写，最后一步仍核对具体人物、名称、归属及计划/完成状态；不能把独立的父画像验收或文风评价冒称为此后台验收结果。

公开仓库仅保存合成 harness。真实消息、数据库、模型输出、日志及恢复资料在工作区外；本任务不推送、不部署，原本机 Profile/飞书配置只读校验。

## 合并顺序

父任务冻结状态单独保存为 `9fe112e6`。后续独立提交包含 source_processing、选择性 Scheduler 后端依赖、父画像 delta 和 built-in 集成；未导入桌面/Flutter 的 Scheduler 管理 UI 提交。并保留初始化 checkout 自带的飞书状态回归测试。父任务已有同等冻结改动时不要重复合并基线提交；在处理父任务之后的小修订冲突后，只合入后续增量提交。
