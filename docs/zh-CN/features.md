# 功能概览

Nova v1.0 目前能做什么。每一节都链接到包含细节与限制的指南。

## 对话

- **实时语音。** 直接说出需求，也可以在 Nova 说话时打断。可用集成模型（默认 Qwen；另有 OpenAI、Gemini Live 与预览版 StepFun），也可自行配置级联的 ASR、LLM、TTS，包括你自己运行的模型。见[支持矩阵](support-matrix.md)、[OpenAI 与 Gemini](global-providers.md)和 [Mac 本地语音栈](deployment/mac-local-voice.md)。
- **文字对话。** Workbench 对话提供 Chat、Plan 与 Build 三种模式，见 [Workbench](workbench.md)。
- **本地唤醒词**为可选功能，默认关闭；主动静音优先于唤醒。见[上手指南](getting-started.md#使用唤醒词)。
- **声纹校验**可以将语音指令限定给已注册的说话人。

## Nova 替你做的事

- **任务。** 交办的工作成为可持久跟踪的 Task，带有 Nova 会核验的验收标准。你可以查看进度、接管、交还，也可以设为定时运行。见 [Tasks](tasks.md)。
- **编码。** Codex、OpenCode、CodeBuddy、Pi 或 DeepSeek Harness 在你批准的项目中工作；只需安装你选用的那一个。见 [Coding](executors/coding.md)。
- **Computer Use。** 在审批下操作桌面应用，按 Build 对话单独开启，支持 macOS 与 Windows。见 [Build 中的 Computer Use](executors/computer-use-build.md)。
- **Mobile Use。** 通过 Midscene SDK 受监督地操作手机（`mobile.run`），需要用环境变量配置，不是一键功能。见 [Mobile Use](../guides/mobile.md)（英文）。
- **审批。** 执行器在敏感操作前会先询问；识别失败不会被当作同意。断开手机连接不会取消正在运行的任务。见[执行器](executors/overview.md)。

Loop Camera（独立摄像头监控）在 v1.0 桌面应用中暂不提供；运行时中保留的部分见 [Loop Camera](executors/loop-camera.md)。

## 记忆与你的数据

- **Workbench** 是桌面主窗口：Timeline、Ideas、Goals、Feeds、Tasks、Profile 页签，旁边是 Nova 对话。Ideas 与 Goals 是需要你确认、编辑或跳过的候选；Nova 不会自动生成待办，你仍可自己维护。见 [Workbench](workbench.md)。
- **个人记忆。** 有出处的本地账本，可在 Profile 页纠正或忘记条目；mem0 是显式可选项，管理功能较少。见[个人记忆](personal-memory.md)。
- **知识库。** 导入的文件与个人记忆分别检索。见[知识库](knowledge-base.md)。
- **信息来源与连接器。** 本地文件夹、经 Composio 的 Google、Apple 邮件与日历（macOS）和飞书，都需先经你授权。见[信息来源与连接器](sources-and-connectors.md)。
- **搜索与 MCP。** 搜索使用你配置的服务；外部 MCP 服务只开放你选择的工具。见[设置](settings.md)。
- **主动提醒。** Nova 会提示值得你关注的事并起草回复，但不会替你发送。每日简报为可选功能，默认关闭。

## 手机与其他设备

- **Space / Host / Client。** Space 保存在你掌控的 Host 上；客户端通过端到端加密的 relay 连接，relay 可自托管，也可由桌面端基于 Tailscale 自动配置。见 [Space / Host / Client](space-host-client.md) 与 [relay 部署说明](../../relay/README.md)。
- **NovaCore（iOS 与 Android）** 可作为 Host 的 Client，或在手机上运行独立 Space，界面支持中英文。Client 可以聊天、听写、查看任务，并由 Space 所有者批准 Host 操作；Client Space 的实时语音暂未提供。见[能力对照表](iphone.md#两种模式各提供什么)。
- **无头服务**支持 Ubuntu 22.04+ x64，使用 `nova-personal-agent-server` 包。见[远程服务](deployment/remote-server.md)。

## 使用限制

模型与搜索服务需要相应凭据；本地记忆和知识库仍可能把文本发送给你配置的远程模型。Client 聊天需要 Host 在线。桌面支持 macOS arm64、Windows x64 和 Ubuntu 22.04+ x64；服务商与模型见[支持矩阵](support-matrix.md)，哪些数据留在本地见[安全与隐私](security.md)。

[开始使用](getting-started.md) · [连接手机](iphone.md) · [工作原理](architecture.md)
