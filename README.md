# Nova Audio Agent

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/deepnovacore/NovaAudioAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/deepnovacore/NovaAudioAgent/actions/workflows/ci.yml)

Nova is an always-on desktop voice assistant. Talk with it while Codex handles coding tasks in the background. Add requirements, ask for progress, or request a stop without leaving the conversation.

## News

- **2026-09-22 · v0.2.0 (planned)**
  - Cross-platform approvals for sandbox network access and command execution.
  - A leaner voice layer; workspace/session scheduling moves into the coding executor.
  - Pluggable ASR / LLM / TTS pipelines, decoupled from QwenAudioRealtime.
  - Custom MCP servers for search and RAG; Chinese wake word “你好星核”.
  - Personal memory with mem0 / VoiceMem, plus improved Workspace Graph.
  - An iPhone client connected to your PC runtime over Tailscale.
- **2026-08-31 · v0.1.0** — Always-on voice, background Codex tasks, live steering, workspace/session management, and selective progress updates.

## Features

<table>
<tr><td width="36%"><b>Talk while work gets done</b><br>Assign tasks, clarify requirements, and follow progress without leaving the conversation.</td><td><img src="assets/features/conversation.en.png" alt="Voice conversation and workspace status" width="480"></td></tr>
<tr><td><b>You approve the next step</b><br>Review workspace changes, command execution, and network access.</td><td><img src="assets/features/approvals.en.png" alt="Network access and workspace approval cards" width="560"></td></tr>
<tr><td><b>Bring your tools and knowledge</b><br>Configure ASR / LLM / TTS and MCP; ask questions across your documents.</td><td><img src="assets/features/knowledge.en.png" alt="Knowledge-base answer using the CN-27 demo documents" width="480"></td></tr>
<tr><td><b>Memory that stays with you</b><br>mem0 recalls personal context across conversations, with source text you can inspect.</td><td><img src="assets/features/mem0.en.png" alt="Four local mem0 memories with source details" width="560"></td></tr>
<tr><td><b>Take Nova with you</b><br>Connect your iPhone over Tailscale to talk and approve tasks on your PC.</td><td><img src="assets/features/iphone.en.png" alt="iPhone home and connection settings" width="480"></td></tr>
</table>

<sub>Demo data; screenshots cleaned up and translated for presentation.</sub>

## Get started

Source use requires Node.js 22.13 or later, npm, Git, and a signed-in Codex installation.

```bash
git clone https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
npm ci
cp .env.example .env
```

Set `DASHSCOPE_API_KEY` and `TAVILY_API_KEY` in `.env`, then start:

```bash
npm run start:client
```

See [getting started](docs/getting-started.md) for native build tools and setup details. Desktop targets macOS and Windows; Linux supports source use.

## Documentation

[Getting started](docs/getting-started.md) · [Architecture](docs/architecture.md) · [iPhone guide](clients/ios/Nova/README.md)

## Contribute

[Contributing](CONTRIBUTING.md) · [Security reports](SECURITY.md)

## License

Copyright 2026 DeepNovaCore. [Apache License 2.0](LICENSE).
