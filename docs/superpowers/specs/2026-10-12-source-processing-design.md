# 持续资料处理：最小整合设计

## 基线与边界

隔离分支以 `89804c578da162b2382ee2198e612fb65bff6180` 加父任务冻结补丁初始化，30 个文件 SHA-256 全部匹配。初始化 checkout 的额外修复保存在工作区外。父任务验收文档保留在原 handoff，不复制私有验收资料到公开仓库。

资料持续增长时，原文仍由现有 SQLite memory evidence 和来源权限系统保存。新增处理账本保存单调变化游标、分块断点、批次、主题索引及证据引用，不把摘要写成本人事实，不新增计时器或 scheduler。

## 数据与处理

1. Evidence 的增删改以及来源授权/版本变化写入同一事务的变化记录。旧库只在首次迁移时导入现存 evidence；后续按游标分页。
2. 每个用户及模型处理目的使用独立持久游标。批次有固定条数和字符预算，长文按偏移分块，持久断点避免只处理开头。模型读取前与提交时均重新验证当前 evidence、版本和授权。
3. 批次 claim 与扫描终点原子落盘。绑定真实 ScheduleRun/Task 后执行，未完成批次不重叠，重启返回原批次；失败不推进成功断点。确定终止后方可重试，不把未知执行当作未执行。
4. Agent 产出的主题摘要只用于定位和选择原证据。摘要引用只能来自本批输入；读取摘要时再次验证来源。最终 Profile 必须引用经重新读取的原证据；旧 Profile 在模型失败时保留，失效引用的内容不能继续显示。
5. 状态提供扫描游标、变化高水位、待扫描变化数、当前批次、最近成功及累计覆盖字符数。积压变化数不冒称独立文档数。

## Scheduler 集成合同与当前阻断

2026-10-12 只读核查定时任务工作区：ScheduleService 已有 create/claimDue/runNow/bindTask/markPrepared/markFinished，ScheduleRun 持久保存冻结输入、Task 来源及 namespace。现有 authority 仅 ui/user_turn，rule 仅 once/daily/weekly，没有 built-in authority、变化唤醒或无变化 preflight。

因此不能用伪造用户消息创建 built-in 规则，不能复制另一工作区未完成的调度代码。这里提供 host-only processing port：preflight/claim、bind、read evidence、commit、status。整合时同一个 ScheduleService 增加默认启用的 built-in source maintenance 注册；新资料合并唤醒，周期兜底只检查变化游标。无工作直接跳过，不创建 Task/模型调用。前台繁忙时推迟 claim；每轮最多一个有界批次，超出预算交回同一任务框架。后台 runtime 使用原有 TaskLoop 和恢复机制。

整合完成前，此账本可通过真实 worker API 独立验证，但不得宣称 built-in 定时 Agent Task 已运行。既有 ProfileWarmup 保持父基线行为，不同时启用第二个画像生成器。

## 验收

确定性测试覆盖超过一批的历史、追加、长文分块、无变化、持久重启、同一批次并发 claim、引用伪造、权限撤销/重授、来源删除/版本变化、提交重放以及失败保留旧结果。隔离 live 仅用合成资料与真实 provider，分别报告真实模型和真实后台触发；真实外部资料仅本人及直接 @ 飞书消息获授权，不读取或提交邮件/文件。
