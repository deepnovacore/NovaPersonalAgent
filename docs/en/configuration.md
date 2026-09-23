# Core configuration

Use desktop Settings to select models and enter credentials. When running from source, you can also edit the project `.env`; restart the desktop afterwards.

## Minimal setup

The defaults use Qwen realtime speech and Tavily search:

```dotenv
DASHSCOPE_API_KEY=your-dashscope-key
TAVILY_API_KEY=your-tavily-key
```

Disabling search removes the need for a Tavily key. Cascaded mode defaults to Volcengine recognition, DeepSeek and Volcengine synthesis, requiring `DOUBAO_BIGMODEL_API_KEY` and `DEEPSEEK_API_KEY`. Keep `DASHSCOPE_API_KEY` for supporting models such as personal-memory processing.

For Qwen Audio 3.1, select `qwen-audio-3.1-realtime-plus` and its matching `longanqian_v3.1` voice. StepAudio 3 is a preview integration awaiting live acceptance. To use it, select StepFun and provide `STEPFUN_API_KEY`; Step 3.7 Flash uses the same key for auxiliary chat and vision by default. Local memory embeddings still need a configured embedding service. To use a custom auxiliary gateway, set `NOVA_AUDIO_AGENT_MODEL_API_KEY` and `NOVA_AUDIO_AGENT_MODEL_BASE_URL`.

## Common options

Set only what you need to change. Keep credentials out of Git.

<!-- BEGIN GENERATED ENV CONTRACT -->
| Variable | Default | Purpose |
|---|---|---|
| `NOVA_AUDIO_AGENT_PIPELINE_MODE` | integrated | Product pipeline shape: integrated or cascaded. |
| `NOVA_AUDIO_AGENT_LANGUAGE` | zh-CN | AI system prompt language: zh-CN or en; desktop supplies its saved preference. |
| `NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER` | qwen | Integrated realtime provider. |
| `NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER` | deepseek | Cascaded LLM provider. |
| `NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL` | provider default | Cascaded LLM model override. |
| `NOVA_AUDIO_AGENT_CODEX_APPROVAL_MODE` | ask | Codex approval mode. |
| `NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG` | ~/.nova-audio-agent/capabilities.json | Capabilities registry path. |
| `NOVA_AUDIO_AGENT_MEMORY_CONNECTION` | local | Memory connection: disabled, local, or remote. |
| `NOVA_AUDIO_AGENT_MEMORY_PROVIDER` | None | Local engine: voicemem (default; unified ledger) or explicit mem0. Remote engines are service-owned. |
| `DASHSCOPE_API_KEY` | None | Qwen realtime credential. |
| `NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL` | qwen-audio-3.0-realtime-plus | Qwen realtime model. |
| `NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE` | longanqian | Qwen realtime voice. |
| `STEPFUN_API_KEY` | None | StepFun realtime credential. |
| `DEEPSEEK_API_KEY` | None | Official DeepSeek cascaded LLM credential. |
| `ARK_API_KEY` | None | Ark cascaded LLM credential. |
| `DOUBAO_ASR_API_KEY` | Doubao big-model key | Volcengine ASR credential override. |
| `DOUBAO_BIGMODEL_API_KEY` | None | Volcengine TTS and ASR fallback credential. |
| `NOVA_AUDIO_AGENT_CODEX_WORKSPACE` | None | Host-approved Codex workspace. |
| `NOVA_AUDIO_AGENT_CODEX_BIN` | codex | Host-approved Codex app-server binary. |
| `TAVILY_API_KEY` | None | Tavily search credential. |
<!-- END GENERATED ENV CONTRACT -->

`ask` retains permission prompts; `yolo` lets Codex execute without approval. Choose according to your trust requirements.

Remove the local provider setting when disabling memory or selecting a remote service. See [personal memory](personal-memory.md) for remote settings and the [iPhone guide](iphone.md) for phone connections.

[Back to getting started](getting-started.md)
