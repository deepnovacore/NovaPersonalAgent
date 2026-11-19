<!-- Keep in sync with README.md -->

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/npa-header-dark.svg">
  <img src="assets/brand/npa-header-light.svg" alt="Nova Personal Agent — Understands you. Interacts in real time." width="100%">
</picture>

<a href="README.md"><ins>English</ins></a> | <a href="README.zh-CN.md"><ins>简体中文</ins></a>

[![CI](https://github.com/deepnovacore/NovaPersonalAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/deepnovacore/NovaPersonalAgent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/deepnovacore/NovaPersonalAgent?label=release)](https://github.com/deepnovacore/NovaPersonalAgent/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-339933.svg)](package.json)
[![npm downloads](https://img.shields.io/npm/d18m/nova-personal-agent?logo=npm&label=npm%20downloads)](https://npm-stat.com/charts.html?package=nova-personal-agent)
[![Website](https://img.shields.io/badge/Website-GitHub%20Pages-222222?logo=github)](https://deepnovacore.github.io/NovaPersonalAgent/)
[![Film](https://img.shields.io/badge/观看-宣传片-2f6fde.svg)](https://deepnovacore.github.io/NovaPersonalAgent/zh/#film)

**开源、语音优先的个人 Agent：边干活边聊天，越聊越懂你，数据留在你的设备上。**

桌面应用名为 **Nova Personal Agent（NPA）**；Android 和 iOS 应用名为 **NovaCore**。

Nova 结合你的上下文与私有记忆，理解你关心什么。它知道如何、何时澄清意图、征求批准，再推进工作。前后双脑协作，让后台 Agent 执行长任务时，前台依然能流畅交流。你可以边聊边调整目标，随时回看结果，始终掌握主动权。

**[官网](https://deepnovacore.github.io/NovaPersonalAgent/) · [文档](docs/zh-CN/README.md) · [宣传片](https://deepnovacore.github.io/NovaPersonalAgent/zh/#film)**

[快速开始](#3-快速开始) · [核心特性](#1-核心特性) · [Nova 能做什么](#21-nova-能做什么) · [画廊](#22-画廊) · [路线图](#5-路线图)

</div>

---

[![看剧时 Nova 主动开口，起草回复但不代发](assets/gallery/stills/pc-proactive-invite.webp)](https://deepnovacore.github.io/NovaPersonalAgent/zh/#gallery)

<sub>真实录屏，使用人设账号。查看[画廊与短片](#22-画廊)，或观看[宣传片](https://deepnovacore.github.io/NovaPersonalAgent/zh/#film)。</sub>

## News

- **2026-11 · [v1.0.0](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v1.0.0)** — **边干活边聊天，越聊越懂你，数据留在你的设备上：** Space / Host / Client 与端到端加密同步、统一的 iOS / Android 伙伴应用、重做的 Workbench、更多执行器（编码、电脑操作、受监督的手机操作）以及可审计的记忆账本。[发布说明](docs/releases/v1.0.0.md)。
- **2026-10-13 · [v0.4.0](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v0.4.0)** — **持续理解，持续行动：** 浏览器、电脑与手机的 GUI-use（实验能力）、定时 Agent 任务，以及保留上下文、证据和任务结果的完整 Timeline。
- **2026-10-07 · [v0.3.0](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v0.3.0)** — **你的个人 Agent：** 待办、想法、目标、资讯和 Profile，配合有出处的记忆与按证据核验的任务。
- **2026-09-21 · [v0.2.0](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v0.2.0)** — **按你的方式对话：** 可配置 ASR / LLM / TTS、个人记忆、MCP 与 iPhone 客户端。
- **2026-08-31 · [v0.1.0](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v0.1.0)** — **常驻语音助手，前后双脑协作：** 前台持续对话，后台 Agent 执行，途中随时补充需求。

<details>
<summary>其他小版本更新</summary>

- **2026-10-09 · [v0.3.1](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v0.3.1)** — **上手更顺畅：** 文字对话开箱即用，桌面端升级更省心。
- **2026-09-24 · [v0.2.3](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v0.2.3)** — 首次启动引导，一个 DashScope API Key 即可开始对话。
- **2026-09-21 · [v0.2.2](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v0.2.2)** — Ubuntu 桌面端与支持扫码配对的无头服务。

</details>

## 1. 核心特性

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture/nova-overview.zh-CN.dark.svg">
  <img src="assets/architecture/nova-overview.zh-CN.light.svg" alt="Nova 架构：设备、Space、对话、任务协调与专长执行器" width="100%">
</picture>

你的上下文帮助 Nova 理解需求，前脑通过对话协调后脑执行。结果按证据核对，提醒在合适时机开口。

- **主动。** Nova 判断什么值得说、何时开口，只起草，不替你发。
- **记忆。** 有出处的 Timeline 与画像随对话生长，每条记忆都可追溯、编辑或遗忘。
- **可交互。** 后台干活，前台照常聊。
- **语音优先。** 全双工语音：前脑负责说，后脑负责做。
- **本地优先。** Space 住在你掌控的 Host 上，设备通过端到端加密的 relay 或 Tailscale 同步。

v1.0.0 还包括：

- **你的主动式个人 Agent。** 时间线、想法、目标、资讯和 Profile，把 Nova 对你的了解变成可以行动的建议。
- **理解广泛、非结构化的上下文。** 接入文件夹、邮件、日历、对话和文档；个人记忆可追溯、可编辑、可删除。
- **常驻语音助手，前后双脑协作。** 前脑陪你交流，后脑处理长时间运行的工作。
- **薄而清晰的前台任务协调层。** 问清目标、确认授权，再委派给 coding agent；按标准核对证据，随时接管和交还。
- **主动有分寸。** Nova 判断什么值得提醒、什么时候开口。琐碎更新保持安静，不抢你的话。

- **更多执行器。** 编码代理、电脑操作与受监督的手机操作共享审批、取消和证据核验，详见[执行器](docs/zh-CN/executors/overview.md)。
- **更多编码执行器。** 新会话也可以通过 ACP 交给 OpenCode、CodeBuddy、Pi 或 DeepSeek Harness；每个会话始终沿用创建时的执行器。执行中追加要求目前只有 Codex 支持。详见 [Coding](docs/zh-CN/executors/coding.md)。

[工作原理](docs/zh-CN/architecture.md) · [任务控制](docs/zh-CN/tasks.md) · [资料授权](docs/zh-CN/sources-and-connectors.md)

## 2. 和 Nova 一起做事

### 2.1 Nova 能做什么

- **操作你的电脑。** 搜索、打开并点赞一个视频，或者写代码、跑测试，审批由你掌握，随时可以叫停。
- **在手机上办事。** 在虚拟屏幕里，受监督地浏览应用。只浏览，不下单。
- **边干活边聊天。** 交代完任务接着聊。用语音描述一个网站，或者让它读篇论文、交回一份文档。
- **越聊越懂你。** 时间线和个人资料随对话慢慢完整，每个回答都有出处，可以改、可以忘。
- **主动开口。** 有事值得你看，它会告诉你并起草回复，但不会替你发。
- **跨设备接力。** 在 Mac 上交代，在 iPhone 上看结果，数据在你自己的 Space 里。

### 2.2 画廊

均为真实录屏，使用人设账号。短片与宣传片见[官网画廊](https://deepnovacore.github.io/NovaPersonalAgent/zh/#gallery)。

<table>
  <tr>
    <td width="33%" valign="top"><a href="assets/gallery/stills/pc-computer-use.webp"><img src="assets/gallery/stills/pc-computer-use.webp" alt="Nova 在 Mac 上搜索视频并点赞" width="100%"></a><br><b>操作你的电脑</b><br>搜索视频并点赞，全程可见。</td>
    <td width="33%" valign="top"><a href="assets/gallery/stills/phone-mobile-result.webp"><img src="assets/gallery/stills/phone-mobile-result.webp" alt="Nova 在虚拟手机屏幕上浏览应用" width="100%"></a><br><b>在手机上办事</b><br>在虚拟屏幕里浏览，不经你同意不下单。</td>
    <td width="33%" valign="top"><a href="assets/gallery/stills/phone-voice-site.webp"><img src="assets/gallery/stills/phone-voice-site.webp" alt="手机上用语音描述并生成网站" width="100%"></a><br><b>边干活边聊天</b><br>语音描述网站，边聊边做。</td>
  </tr>
  <tr>
    <td width="33%" valign="top"><a href="assets/gallery/stills/pc-timeline-cited.webp"><img src="assets/gallery/stills/pc-timeline-cited.webp" alt="带 Timeline 出处的回答" width="100%"></a><br><b>越聊越懂你</b><br>回答带着出处。</td>
    <td width="33%" valign="top"><a href="assets/gallery/stills/pc-draft-unsent.webp"><img src="assets/gallery/stills/pc-draft-unsent.webp" alt="回复存入草稿箱，未发送" width="100%"></a><br><b>只起草，不替你发</b><br>回复存进草稿箱，发不发由你决定。</td>
    <td width="33%" valign="top"><a href="assets/gallery/stills/iphone-feed.webp"><img src="assets/gallery/stills/iphone-feed.webp" alt="Nova 判断值得推送的 iPhone 通知" width="100%"></a><br><b>主动</b><br>值得看的才推。</td>
  </tr>
</table>

## 3. 快速开始

### 3.1 安装与启动

**快捷下载 · v1.0.0** — [发布说明与 SHA-256 校验文件](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v1.0.0) · [最新版本](https://github.com/deepnovacore/NovaPersonalAgent/releases/latest)

| 平台 | 下载 |
| --- | --- |
| macOS · Apple Silicon（arm64） | [DMG](https://github.com/deepnovacore/NovaPersonalAgent/releases/download/v1.0.0/nova-personal-agent-1.0.0-macos-arm64.dmg) · [ZIP](https://github.com/deepnovacore/NovaPersonalAgent/releases/download/v1.0.0/nova-personal-agent-1.0.0-macos-arm64-app.zip) |
| Windows · x64 | [EXE](https://github.com/deepnovacore/NovaPersonalAgent/releases/download/v1.0.0/nova-personal-agent-1.0.0-windows-x64.exe) · [便携版 ZIP](https://github.com/deepnovacore/NovaPersonalAgent/releases/download/v1.0.0/nova-personal-agent-1.0.0-windows-x64-portable.zip) |
| Linux · Ubuntu 22.04+ x64 | [AppImage](https://github.com/deepnovacore/NovaPersonalAgent/releases/download/v1.0.0/nova-personal-agent-1.0.0-linux-x64.AppImage) · [DEB](https://github.com/deepnovacore/NovaPersonalAgent/releases/download/v1.0.0/nova-personal-agent-1.0.0-linux-x64.deb) |

手机端：<!-- TODO(v1.0.0): 发布前补充 TestFlight 邀请与 Android APK 链接 -->iOS TestFlight 与 Android APK 链接将在发布时补充。环境要求：Node.js 22.13+ 与 npm。编码任务需安装并登录所选编码后端；Codex 使用 app-server。

可直接用 npm 安装。

```bash
# 全局安装
npm install --global nova-personal-agent@latest
# 启动客户端；语音功能需在设置中配置服务商
novapersonal
# 打开设置面板
novapersonal config
# 查看当前语音管线需要哪些密钥；加 --online 在线验证
novapersonal doctor
```

自 v0.4 起使用 Nova Personal Agent 新包名。已发布的 v0.3.x 仍使用旧包名和 `novaaudio`；新包保留该命令别名，并继续读取原有数据与设置。迁移已有全局安装时，先运行 `npm uninstall --global nova-audio-agent nova-audio-agent-server`，避免命令链接冲突；这不会删除用户数据。


升级前先退出 Nova，再运行上面的安装命令。如需固定版本，使用 `nova-personal-agent@1.0.0`。升级保留设置与数据。状态文件带版本号，旧版本可能拒绝读取新文件；降级前请先备份，再运行 `novapersonal reset-state`。

Nova 使用 Space / Host / Client。按 [Space 设置指南](docs/zh-CN/space-host-client.md)配置桌面 Host，部署或选择加密 [relay](relay/README.md)。Runtime 与 context 留在 Host，relay 只转发密文。Client 聊天需要 Host 在线，不会接管后台任务；独立 Space 在本机运行，无需 relay。Host 损坏即 Space 丢失；切换模式需要新建 Space，旧数据不迁移。从 v0.4 升级请见[升级说明](docs/releases/v1.0.0.md)。

### 3.2 从源码开发

从源码开发时：

```bash
git clone https://github.com/deepnovacore/NovaPersonalAgent.git nova-personal-agent
cd nova-personal-agent
npm ci && cp .env.example .env
# 在 .env 中填入 DASHSCOPE_API_KEY
```

从 [DashScope](https://platform.qianwenai.com) 获取 API Key 并配置 `DASHSCOPE_API_KEY`。这一把密钥就能用语音、记忆、摄像头和联网搜索；搜索默认走百炼，配置 [Tavily](https://docs.tavily.com) 的 `TAVILY_API_KEY` 后改用 Tavily。

启动桌面应用：
```bash
npm run start:client
# 本次直接打开 Workbench，覆盖已保存的启动偏好
npm run start:workbench
# 构建、诊断或运行本地演示
npm run build --workspace @nova-personal-agent/runtime
node runtime/dist/src/cli.js diagnose --json
node runtime/dist/src/cli.js demo all
```

客户端提供麦克风、摄像头、声音、设置和外部 MCP 控件。

### 3.3 支持矩阵

| 平台 | 桌面应用（Host 或独立） | 无头服务 | 手机 Client |
|---|---|---|---|
| macOS arm64 | ✅ 原生回声消除 | ✅ 源码运行 | 通过 relay 配对 Host，或独立运行 |
| Windows x64 | ✅ | ❌ | 通过 relay 配对 Host，或独立运行 |
| Ubuntu 22.04+ x64 | ✅ | ✅ npm 包 | 通过 relay 配对 Host，或独立运行 |

| 层 | 可选服务 |
|---|---|
| 集成语音 | Qwen realtime、OpenAI realtime、Gemini Live、StepFun（预览） |
| 级联 ASR / TTS | 火山语音、Gemini、自托管（参考实现：Whisper / Breeze） |
| 级联 LLM | DeepSeek、Qwen / DashScope、火山方舟、OpenAI、Gemini、自托管 |
| 视觉 | Qwen-VL 系列、Doubao Seed |
| 编码 Agent | Codex、OpenCode、CodeBuddy、Pi、DeepSeek Harness |
| 数据源 | 本地文件夹、Google（经 Composio）、Apple 邮件与日历（macOS）、飞书 |

各模型、凭据与服务商限制见[支持矩阵](docs/zh-CN/support-matrix.md)。

## 4. 文档

| 读这篇 | 目的 |
|---|---|
| [架构](docs/zh-CN/architecture.md) | 模块与边界 |
| [术语与不变量](docs/zh-CN/glossary.md) | 核心常量 |
| [上手指南](docs/zh-CN/getting-started.md) | 安装与集成 |
| [Workbench](docs/zh-CN/workbench.md) · [任务](docs/zh-CN/tasks.md) · [资料来源与连接器](docs/zh-CN/sources-and-connectors.md) | 主窗口、交办的任务，以及 Nova 能读取哪些资料 |
| [语音助手什么时候该开口？](docs/zh-CN/blog/2026-08-proactive-voice-agent-design-space.md) | 语音交互设计 |
| [Node runtime 迁移归档](https://github.com/deepnovacore/NovaPersonalAgent/tree/20a0812c0acb83b53cbad4b415d637dafff3c7f6/docs/archs/node-runtime-migration) | `v0.1.0` tag 历史中的迁移期计划 |

## 5. 路线图

- [x] **v0.4.0 — 持续上下文与专长 Agent。** 持续主会话与 Timeline、定时任务、增量画像及多编码后端；GUI/设备执行继续作为实验能力。
- [x] **v1.0.0 — 语音优先，本地优先。** Space / Host / Client、统一的手机伙伴应用、重做的 Workbench、更多执行器与可审计的记忆账本。
- [ ] **下一步。** 扩大平台验收（Windows、Linux、Android 录屏）、打包本地语音栈，并深化手机操作。

未列入发布说明的接入不等于正式版支持；各项能力完成对应配置的验收后再发布。

## 6. 贡献

```bash
npm ci && npm run check && npm run build && npm test
```

安全问题见 [SECURITY.md](SECURITY.md)，贡献规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 7. 许可证

版权所有 2026 DeepNovaCore，[GNU GPL v3 或更高版本](LICENSE)。

## 8. 致谢

Nova 建立在多个开源项目之上，包括 OpenMinis（GPL-3.0）与 Mika（Apache-2.0）。第三方声明见 [LICENSES](LICENSES)。
