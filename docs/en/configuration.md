# Core configuration

Environment names now omit the former `NOVA_AUDIO_AGENT_` prefix: for example, `PIPELINE_MODE` and `CODEX_WORKSPACE`. Rename existing `.env`, service and CI configuration keys before upgrading; old names are no longer read. Provider keys such as `DASHSCOPE_API_KEY` are unchanged. Desktop preferences override several non-secret values (including pipeline and language); these environment options also serve direct runtime launches.

Use desktop Settings to select models and enter credentials. When running from source, you can also edit the project `.env`; restart the desktop afterwards.

## Minimal setup

The default Qwen realtime pipeline needs one key:

```dotenv
DASHSCOPE_API_KEY=your-dashscope-key
```

Only the selected voice pipeline's keys are required. Search, camera watch, memory and knowledge turn off when their key is missing, and Settings and `novaaudio doctor` name the key each one needs. Search uses Tavily when `TAVILY_API_KEY` is set and Bailian MCP search otherwise. Desktop cascaded mode defaults to Volcengine recognition, DeepSeek and Volcengine synthesis, requiring `DOUBAO_BIGMODEL_API_KEY` and `DEEPSEEK_API_KEY`. Keep `DASHSCOPE_API_KEY` for supporting models such as personal-memory processing.

Direct runtime launches default to Qwen for the cascaded LLM. Set `CASCADE_LLM_PROVIDER=deepseek` explicitly to match the desktop default.

## Common options

Set only what you need to change. Keep credentials out of Git.

<!-- BEGIN GENERATED ENV CONTRACT -->
| Variable | Default | Purpose |
|---|---|---|
| `PIPELINE_MODE` | integrated | Product pipeline shape: integrated or cascaded. |
| `PROMPT_LANGUAGE` | zh-CN | AI system prompt language: zh-CN or en; desktop supplies its saved preference. |
| `CASCADE_LLM_PROVIDER` | qwen | Cascaded LLM provider. |
| `CASCADE_LLM_MODEL` | provider default | Cascaded LLM model override. |
| `CODEX_APPROVAL_MODE` | ask | Codex approval mode. |
| `CAPABILITIES_CONFIG` | ~/.nova-audio-agent/capabilities.json | Capabilities registry path. |
| `MEMORY_CONNECTION` | local | Memory connection: disabled, local, or remote. |
| `MEMORY_PROVIDER` | None | Local engine: mem0 (default) or voicemem. Remote engines are service-owned. |
| `DASHSCOPE_API_KEY` | None | Qwen realtime credential. |
| `QWEN_REALTIME_MODEL` | qwen-audio-3.0-realtime-plus | Qwen realtime model. |
| `QWEN_REALTIME_VOICE` | longanqian | Qwen realtime voice. |
| `DEEPSEEK_API_KEY` | None | Official DeepSeek cascaded LLM credential. |
| `ARK_API_KEY` | None | Ark cascaded LLM credential. |
| `DOUBAO_ASR_API_KEY` | Doubao big-model key | Volcengine ASR credential override. |
| `DOUBAO_BIGMODEL_API_KEY` | None | Volcengine TTS and ASR fallback credential. |
| `CODEX_WORKSPACE` | None | Host-approved Codex workspace. |
| `CODEX_BIN` | codex | Host-approved Codex app-server binary. |
| `TAVILY_API_KEY` | None | Tavily search credential. |
<!-- END GENERATED ENV CONTRACT -->

`ask` retains permission prompts; `yolo` lets Codex execute without approval. Choose according to your trust requirements.

Remove the local provider setting when disabling memory or selecting a remote service. See [personal memory](personal-memory.md) for remote settings and the [iPhone guide](iphone.md) for phone connections.

[Back to getting started](getting-started.md)
