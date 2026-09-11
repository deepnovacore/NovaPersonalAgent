# Nova Audio Agent v0.4.0 Spec Series

2026-09-11 版本拆分：M8 及之后从 v0.3.0 移入本版，保留原编号与验收要求。当前只有规划，不声明实现或发布。

- M8：一个邮件/日历 provider；见 [01](01-mail-and-calendar.md)。依赖 v0.3.0 M7。
- M9-C：Kimi Code + pi agent；见 [02](02-coding-and-gui-executors.md)。
- M9-G：GUI / AutoGLM example；见 [02](02-coding-and-gui-executors.md)。
- M9-Demo：真实 agent2agent 闭环；依赖 M9-C、M9-G 验收。

执行器复用 v0.2 调度与授权，可独立于邮件/日历推进。Home Assistant 与 MyContext 仍是后续候选。公共/内部隔离不变；发布需要真实设备和服务证据。

[v0.3.0 M5–M7](../v0.3.0/00-overview.md) · [进度](STATUS.zh-CN.md)
