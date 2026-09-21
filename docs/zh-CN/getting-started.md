# 上手指南

Nova 运行在电脑上，通过语音与你交流，并调用 Codex 完成编码任务。

## 1. 准备环境

源码运行需要 Node.js 22.13 或更新版本、npm、Git，以及已安装并登录的 Codex。

原生组件还需要对应平台的构建工具：

- macOS：Xcode Command Line Tools，可运行 `xcode-select --install` 安装。
- Windows：Visual Studio Build Tools，选择 **Desktop development with C++**。
- Ubuntu 22.04+ x64：C/C++20 编译器（GCC 12 或更新版本）、X11 或 XWayland，以及 Chromium 用户命名空间权限。

桌面支持 macOS arm64、Windows x64 和 Ubuntu 22.04+ x64。

## 2. 安装和启动

```bash
git clone https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
npm ci
cp .env.example .env
```

在 `.env` 中填写默认语音和搜索服务的密钥：

```dotenv
DASHSCOPE_API_KEY=你的百炼密钥
TAVILY_API_KEY=你的Tavily密钥
```

不需要搜索时，可以在能力配置中关闭搜索。随后启动桌面：

```bash
npm run start:client
```

源码启动时，项目 `.env` 中的值优先于同名 shell 环境变量。修改 `.env` 后需重新启动桌面应用。

## 3. 交办第一个任务

直接说：“帮我创建一个展示个人作品的网页。”Nova 会询问必要的信息，并在需要新建或切换项目时请求确认，然后交给 Codex 执行。

任务开始后，可以补充要求、询问进度或要求停止。任务横幅显示工作状态，进度气泡用于提醒；需要授权的操作会单独请求确认。

项目是存放文件的工作目录，会话是该项目下的一次持续交流。新会话可以保留项目文件，已有会话可以继续之前的工作。

## 4. 调整设置

在设置中选择中文或 English，可切换界面和 AI 系统提示词语言。开启本地唤醒后，“你好星核”和“Hi Nova”同时可用。

右键悬浮球打开「设置」。

- **保存**：保存修改；影响后台的配置会显示「待重启」。
- **重启**：使用已保存配置重启后台，保留面板中未保存的草稿。
- 外观和唤醒设置保存后立即生效。

密钥只显示是否已配置，不回显明文。来自 `.env` 的密钥需在文件中修改。

### 选择语音模式

| 模式 | 特点 | 默认服务 |
|---|---|---|
| 集成 `integrated` | 一个模型直接处理语音，配置较少 | Qwen `qwen-audio-3.0-realtime-plus`，音色 `longanqian` |
| 级联 `cascaded` | 分别配置识别、语言模型和合成 | 火山 ASR -> DeepSeek `deepseek-flash` -> 火山 TTS |

每个平台使用一把密钥，在选中的服务间复用：DeepSeek 使用 `DEEPSEEK_API_KEY`，Qwen 使用 `DASHSCOPE_API_KEY`，火山语音使用 `DOUBAO_BIGMODEL_API_KEY`。可通过 `DOUBAO_ASR_API_KEY` 单独指定识别密钥；未填写时，ASR 回退到 `DOUBAO_BIGMODEL_API_KEY`。

Ark 可显式选择为级联 LLM，使用 `ARK_API_KEY`。条件式设置面板只显示当前模式需要的配置；密钥只写并返回存在状态。服务配置在后台下次启动时生效，不会自动切换到其他供应商。

<a id="本地唤醒词"></a>

### 使用唤醒词

本地唤醒词默认关闭。开启后首次使用会下载模型，悬浮球默认空闲 60 秒后隐藏；可调整为 30–3600 秒，设为 0 则不自动隐藏。

待机时，麦克风输入交给本地唤醒检测。主动静音会停止检测，需要手动解除静音。

## 5. 记忆、知识库与手机

- **个人记忆**默认使用本地 mem0。右键悬浮球打开「记忆面板」，可查看原话与整理结果。详见[个人记忆](personal-memory.md)。
- **文档知识库**需在能力设置中启用。导入文件前会说明数据处理方式；生成向量会把文本发送给配置的模型服务。
- **连接 iPhone**：macOS 桌面右键悬浮球，选择「连接 iPhone…」，启用手机连接后按页面提示设置网络并扫码。详见[手机连接与远程服务](iphone.md)。

## 常见问题

| 问题 | 检查方式 |
|---|---|
| 语音连接失败 | 检查所选模式的密钥、服务权限和网络连接 |
| Codex 无法执行 | 确认 Codex 已登录，项目目录可访问 |
| 保存后没有变化 | 查看是否提示「待重启」，点击重启后台 |
| 搜索不可用 | 检查搜索服务密钥；使用 MCP 搜索时确认相应服务已开通 |
| 找不到刚说过的记忆 | 记忆整理需要时间，在记忆面板查看学习状态 |
| 手机没有文字聊天入口 | 主机需使用级联模式并支持可编辑输入 |

## 高级配置

能力配置默认位于 `~/.nova-audio-agent/capabilities.json`。可以关闭不需要的模块，或配置外部 MCP 服务及允许使用的工具。只有启用的服务需要凭据。

默认搜索服务是 Tavily。选择 MCP 搜索后使用对应服务的密钥，不再需要 Tavily 密钥。远程 MCP 需要 HTTPS；本机无认证测试可使用回环 HTTP。

开发说明见[工作原理](architecture.md)。

[核心环境变量](configuration.md)
