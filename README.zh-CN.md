# Nova Audio Agent

[English](README.md) | **简体中文**

[![CI](https://github.com/deepnovacore/NovaAudioAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/deepnovacore/NovaAudioAgent/actions/workflows/ci.yml)

Nova 是常驻电脑的语音助手。你可以一边对话，一边让它通过 Codex 处理编码任务；需要补充需求、查看进度或停止时，直接告诉它。

## 最新动态

- **2026-09-22 · v0.2.0（预计）**
  - 完善跨平台审批：沙箱网络访问、命令执行等请求转交前台确认。
  - 精简快脑工具，将 workspace/session 调度下沉至编码执行器。
  - 接入可配置 ASR / LLM / TTS 的级联管线，协议与 QwenAudioRealtime 解耦。
  - 支持自定义 MCP、搜索与 RAG，以及中文唤醒词“你好星核”。
  - 接入 mem0 / VoiceMem 个人记忆，完善 Workspace Graph 工作区记忆。
  - 新增 iPhone 客户端，通过 Tailscale 连接电脑上的 runtime。
- **2026-08-31 · v0.1.0** — 常驻语音、Codex 后台执行、途中补充需求、工作区与会话管理，以及按需播报进度。

## 核心功能

<table>
<tr><td width="36%"><b>边聊边做</b><br>语音交办、澄清需求、查看进度，不用离开对话。</td><td><img src="assets/features/conversation.png" alt="语音对话与工作区状态" width="480"></td></tr>
<tr><td><b>操作由你确认</b><br>创建工作区、执行命令、访问网络，在前台审批。</td><td><img src="assets/features/approvals.png" alt="网络访问与工作区创建审批" width="560"></td></tr>
<tr><td><b>接入工具与知识</b><br>自由配置 ASR / LLM / TTS 和 MCP，基于自己的资料问答。</td><td><img src="assets/features/knowledge.png" alt="基于 CN-27 演示资料的知识库回答" width="480"></td></tr>
<tr><td><b>记住与你有关的事</b><br>mem0 跨对话回忆个人信息，随时查看记忆与原话。</td><td><img src="assets/features/mem0.png" alt="mem0 本机记忆及原话入口" width="560"></td></tr>
<tr><td><b>把 Nova 带在身边</b><br>iPhone 通过 Tailscale 连接电脑，随时对话和审批。</td><td><img src="assets/features/iphone.png" alt="iPhone 主界面与连接设置" width="480"></td></tr>
</table>

<sub>图中使用演示数据，部分截图已抠图、拼接。</sub>

## 开始使用

源码运行需要 Node.js 22.13 或更新版本、npm、Git，以及已登录的 Codex。

```bash
git clone https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
npm ci
cp .env.example .env
```

在 `.env` 中填写 `DASHSCOPE_API_KEY` 和 `TAVILY_API_KEY`，然后启动：

```bash
npm run start:client
```

原生组件所需的构建工具和详细步骤见[上手指南](docs/getting-started.zh-CN.md)。桌面面向 macOS 和 Windows，Linux 可从源码运行。

## 演示

https://github.com/user-attachments/assets/061697f3-fff6-47d6-924b-8a29eef4ab45

[视频演示](https://youtu.be/t1c-2O-QsxE)

## 文档

[上手指南](docs/getting-started.zh-CN.md) · [架构](docs/architecture.md) · [iPhone 指南](clients/ios/Nova/README.md)

## 参与贡献

[贡献指南](CONTRIBUTING.md) · [安全报告](SECURITY.md)

## 许可证

Copyright 2026 DeepNovaCore. [Apache License 2.0](LICENSE).
