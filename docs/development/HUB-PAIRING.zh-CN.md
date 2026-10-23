# Space / Host / Client 连接

当前开发版本使用固定角色的 Space。创建 Space 时选择独立运行，或作为 Client 绑定桌面 Host。选择不可原地变更；切换运行方式需要新建 Space，旧数据不迁移。

- 独立运行：数据与 Agent 留在本机，不连接 relay。
- Client：通过 relay 与 Host 配对。Host 是唯一业务写入方；手机只展示缓存、回传意图并执行经权限校验的明确系统操作。
- 聊天需要 Host 在线；离线不排队，不在手机启动本地模型。普通事项操作保留持久意图，重连后提交；冲突供用户处理。
- 每个 Space 一个 Host、多个 Client。在线状态只影响可用性，不触发选主、定时任务接管或主设备交接。Host 损坏即 Space 丢失，不提供备份恢复。

relay 可自托管，仅中转密文；不需要另一套 Tailscale 产品连接流程。推送网关可见设备令牌、发送时间与密文大小。iOS 经 APNs、Android 首期以 FCM 为主；小米公信通知有每天每设备每应用五条配额，超额在应用内补拉。实际锁屏到达仍需要凭据与真机验收，不能由自动化测试代替。

旧 `/hub/v1` 服务、手动 token、LaunchAgent/Tailscale Serve 配对外壳及验收脚本已删除；旧二维码不用于新 Space 配对。authority、主设备恢复和 schedule handoff 接口也已删除。旧数据库状态直接重置，不提供兼容层。当前设置入口与命令见 [Space 使用指南](../zh-CN/space-host-client.md)。

实现进度与真实验证证据见 [全量实施账本](../design-notes/2026-10-23-space-host-client-full-plan.md)。具体加密协议与元数据边界见 [wire 协议](../design-notes/2026-10-23-space-host-client-wire.md)。
