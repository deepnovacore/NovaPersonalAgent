# 核心配置

[English](configuration.md) | **简体中文**

通常在桌面设置中选择模型和填写密钥即可。源码运行也可以在项目 `.env` 中配置；修改后重启桌面应用。

## 最小配置

默认使用 Qwen 实时语音和 Tavily 搜索：

```dotenv
DASHSCOPE_API_KEY=你的百炼密钥
TAVILY_API_KEY=你的Tavily密钥
```

关闭搜索后不需要 Tavily 密钥。切换级联模式时，默认使用火山识别、DeepSeek 和火山合成，需要 `DOUBAO_BIGMODEL_API_KEY`、`DEEPSEEK_API_KEY`。个人记忆等辅助模型仍使用百炼，保留 `DASHSCOPE_API_KEY`。

## 常用选项

只填写需要更改的项，其他保持默认。密钥不要提交到 Git。

<!-- BEGIN GENERATED ENV CONTRACT -->
| 变量 | 默认 | 用途 |
|---|---|---|
| `NOVA_AUDIO_AGENT_PIPELINE_MODE` | integrated | 产品管线形态：集成或级联。 |
| `NOVA_AUDIO_AGENT_LANGUAGE` | zh-CN | AI system prompt 语言：zh-CN 或 en；桌面端会提供其保存的偏好。 |
| `NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER` | deepseek | 级联 LLM 提供方。 |
| `NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL` | provider default | 级联 LLM 模型覆盖。 |
| `NOVA_AUDIO_AGENT_CODEX_APPROVAL_MODE` | ask | Codex 审批模式。 |
| `NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG` | ~/.nova-audio-agent/capabilities.json | 能力注册表路径。 |
| `NOVA_AUDIO_AGENT_MEMORY_CONNECTION` | local | 记忆连接：disabled、local 或 remote。 |
| `NOVA_AUDIO_AGENT_MEMORY_PROVIDER` | 无 | 本地引擎：mem0（默认）或 voicemem。远程引擎由服务端选择。 |
| `DASHSCOPE_API_KEY` | 无 | Qwen 实时凭据。 |
| `NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL` | qwen-audio-3.0-realtime-plus | Qwen 实时模型。 |
| `NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE` | longanqian | Qwen 实时音色。 |
| `DEEPSEEK_API_KEY` | 无 | DeepSeek 官方级联 LLM 凭据。 |
| `ARK_API_KEY` | 无 | 方舟级联 LLM 凭据。 |
| `DOUBAO_ASR_API_KEY` | Doubao big-model key | 火山 ASR 凭据覆盖。 |
| `DOUBAO_BIGMODEL_API_KEY` | 无 | 火山 TTS 及 ASR 回退凭据。 |
| `NOVA_AUDIO_AGENT_CODEX_WORKSPACE` | 无 | 主机批准的 Codex 工作区。 |
| `NOVA_AUDIO_AGENT_CODEX_BIN` | codex | 主机批准的 Codex app-server 可执行文件。 |
| `TAVILY_API_KEY` | 无 | Tavily 搜索凭据。 |
<!-- END GENERATED ENV CONTRACT -->

`ask` 保留权限确认；`yolo` 允许 Codex 无审批执行，请按信任范围选择。

选择远程记忆或关闭记忆时，移除本地 provider 配置。远程记忆设置见[个人记忆](personal-memory.zh-CN.md)；手机连接见[iPhone 指南](iphone.zh-CN.md)。

[返回上手指南](getting-started.zh-CN.md)
