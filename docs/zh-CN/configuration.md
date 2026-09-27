# 核心配置

环境变量已移除原来的 `NOVA_AUDIO_AGENT_` 前缀，例如 `PIPELINE_MODE`、`CODEX_WORKSPACE`。升级前请同步修改已有 `.env`、服务和 CI 配置中的键名；旧名称不再读取。`DASHSCOPE_API_KEY` 等供应商密钥名称不变。桌面偏好设置会覆盖管线、语言等部分非密钥变量；这些环境变量也供直接启动运行时使用。

通常在桌面设置中选择模型和填写密钥即可。源码运行也可以在项目 `.env` 中配置；修改后重启桌面应用。

## 最小配置

默认的 Qwen 实时语音只需要一把密钥：

```dotenv
DASHSCOPE_API_KEY=你的百炼密钥
```

只有所选语音管线的密钥是必填的。搜索、摄像头监控、记忆和知识库缺少密钥时自动关闭，设置页和 `novaaudio doctor` 会写明各自需要的密钥。配置了 `TAVILY_API_KEY` 时用 Tavily 搜索，否则用百炼 MCP 搜索。桌面切换级联模式时，默认使用火山识别、DeepSeek 和火山合成，需要 `DOUBAO_BIGMODEL_API_KEY`、`DEEPSEEK_API_KEY`。个人记忆等辅助模型仍使用百炼，保留 `DASHSCOPE_API_KEY`。

选择 Qwen Audio 3.1 时使用 `qwen-audio-3.1-realtime-plus` 和配套音色 `longanqian_v3.1`。StepAudio 3 为预览接入，尚待真实环境验收。选择 StepAudio 3 时，`STEPFUN_API_KEY` 同时用于实时语音和默认辅助对话、视觉模型 Step 3.7 Flash。本地记忆嵌入仍需单独配置嵌入服务；不使用本地记忆时可关闭它。如需自定义辅助模型网关，设置 `MODEL_API_KEY` 和 `MODEL_BASE_URL`。

## 常用选项

只填写需要更改的项，其他保持默认。密钥不要提交到 Git。

直接启动运行时时，级联 LLM 默认选择 Qwen；显式设置 `CASCADE_LLM_PROVIDER=deepseek` 可与桌面默认选择一致。

<!-- BEGIN GENERATED ENV CONTRACT -->
| 变量 | 默认 | 用途 |
|---|---|---|
| `PIPELINE_MODE` | integrated | 产品管线形态：集成或级联。 |
| `PROMPT_LANGUAGE` | zh-CN | AI system prompt 语言：zh-CN 或 en；桌面端会提供其保存的偏好。 |
| `INTEGRATED_PROVIDER` | qwen | 集成实时提供方。 |
| `CASCADE_LLM_PROVIDER` | deepseek | 级联 LLM 提供方。 |
| `CASCADE_LLM_MODEL` | provider default | 级联 LLM 模型覆盖。 |
| `CODEX_APPROVAL_MODE` | ask | Codex 审批模式。 |
| `CAPABILITIES_CONFIG` | ~/.nova-audio-agent/capabilities.json | 能力注册表路径。 |
| `MEMORY_CONNECTION` | local | 记忆连接：disabled、local 或 remote。 |
| `MEMORY_PROVIDER` | 无 | 本地引擎：voicemem（默认，统一账本）或显式选择 mem0。远程引擎由服务端选择。 |
| `DASHSCOPE_API_KEY` | 无 | Qwen 实时凭据。 |
| `QWEN_REALTIME_MODEL` | qwen-audio-3.0-realtime-plus | Qwen 实时模型。 |
| `QWEN_REALTIME_VOICE` | longanqian | Qwen 实时音色。 |
| `STEPFUN_API_KEY` | 无 | StepFun 实时凭据。 |
| `DEEPSEEK_API_KEY` | 无 | DeepSeek 官方级联 LLM 凭据。 |
| `ARK_API_KEY` | 无 | 方舟级联 LLM 凭据。 |
| `DOUBAO_ASR_API_KEY` | Doubao big-model key | 火山 ASR 凭据覆盖。 |
| `DOUBAO_BIGMODEL_API_KEY` | 无 | 火山 TTS 及 ASR 回退凭据。 |
| `CODEX_WORKSPACE` | 无 | 主机批准的 Codex 工作区。 |
| `CODEX_BIN` | codex | 主机批准的 Codex app-server 可执行文件。 |
| `TAVILY_API_KEY` | 无 | Tavily 搜索凭据。 |
<!-- END GENERATED ENV CONTRACT -->

`ask` 保留权限确认；`yolo` 允许 Codex 无审批执行，请按信任范围选择。

还有几个变量用于较少见的配置。`COMPOSIO_API_KEY` 用于通过 Composio 授权 Google 连接器（Gmail 与 Calendar）。`OPENROUTER_API_KEY` 提供 Jev 判定模型，用于给个人记忆候选内容（Todo、Idea、Goal、Profile）打分，以及给资讯排序相关性；缺少此密钥时，这两项功能都会保持关闭。`DOUBAO_ASR_VOICEPRINT_ENABLED` 与 `DOUBAO_ASR_VOICEPRINT_ID`、`DOUBAO_ASR_VOICEPRINT_NAME`、`DOUBAO_ASR_VOICEPRINT_HEALTH_URL` 搭配使用，开启可选的 ASR 声纹校验。`NEWS_LANGUAGE` 独立于界面语言设置资讯流的语言。`MEMORY_LEDGER_PATH` 可覆盖统一记忆账本 SQLite 文件的存放位置（默认 `~/.nova-audio-agent/workspace-graph.sqlite`）。

选择远程记忆或关闭记忆时，移除本地 provider 配置。远程记忆设置见[个人记忆](personal-memory.md)；手机连接见[iPhone 指南](iphone.md)。

[返回上手指南](getting-started.md)
