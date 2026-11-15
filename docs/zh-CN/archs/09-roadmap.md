# 路线图

Nova v1.0.0 已实现双脑实时语音与文本交互、基于 React 重构的桌面端 Workbench、多后端编程执行（Codex 及 OpenCode、CodeBuddy、Pi、DeepSeek Harness 等 ACP Agent）、受控的桌面操作（Computer Use）与手机操控（`mobile.run`）、独立 Loop Camera 视觉监控、以账本为权威底座的个人记忆系统，以及基于端到端加密的 Space / Host / Client 跨端连接（桌面端与 iOS / Android）。当前兼容性见[支持矩阵](../support-matrix.md)。

v1.0.0 之后的演进方向包括：

- **原生全双工语音模型。** 在明确的能力契约下评估端到端全双工语音模型（如 MiniCPM-o、PersonaPlex）。
- **更广泛的信息来源与连接器。** 在现有的 Google（Gmail / Calendar）、macOS 日历/邮件与飞书之外，扩展更多只读个人账号与服务连接器。
- **更完善的移动端与跨设备体验。** 扩展真机推送通道覆盖、移动端独立 Space 本地能力，以及低延迟加密 Relay 优化。
- **可扩展皮肤与桌面 HUD。** 推进实验性的悬浮球皮肤（Orb Skins）与透明桌面 Visor 规范成熟，形成稳定的扩展格式。

以上为规划方向，不代表当前已支持的能力或发布时间承诺。每项新能力都将经过独立的权限、信任边界与兼容性验证。
