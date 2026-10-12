# 持续资料处理实施计划

**Goal:** 完成独立持久资料处理层及可验证的 Scheduler 接口，不复制另一分支未完成代码。

**Architecture:** 复用现有 SQLite worker 和 evidence 权限。变化日志 → 有界 claim → Task 绑定 → 原文读取 → 带证据主题产物，断点与结果在同一事务提交。

**Tech Stack:** TypeScript、Zod、现有 SQLite worker、node:test。

**Spec:** `docs/superpowers/specs/2026-10-12-source-processing-design.md`

用户已授权写出最小设计与接口后直接实施；本会话按顺序执行，不增加审批步骤。

## 实施与验证

- [x] 为 `source-processing` 写失败测试：有限批次、长文、去重、重启、撤销、失败和跨用户引用。
- [x] 实现 SQLite 变化日志、处理断点、claim/bind/read/commit/fail/status，通过既有 worker 暴露。
- [x] 添加用户及 provider 由 host 注入的资源接口，外部输入不能自报授权。
- [x] 实现主题检索与原证据再读取，验证摘要不进入本人事实表。
- [x] 执行 focused tests、typecheck 与父基线相关回归；隔离真实 provider live。
- [x] 记录可用接口、实际验收结果与 Scheduler 未完成接口，交付父任务合并说明。

## Review Focus

长文断点不截掉尾部；重启不重新产生批次；撤销后重授也不能恢复旧授权产物；无变化不扫描历史；超出预算仍保留可恢复进度。每项由上述持久化测试覆盖。

## 交付状态

底层与接口实施完成；默认 built-in 的 Scheduler/Task 集成因共享接口未提供而保持未实现，不计作本计划验收通过。Runtime 构建通过，13 个专项测试及共 179 个相关回归通过。真实模型合成资料链路通过；真实后台触发未验收，画像文风未通过验收。
