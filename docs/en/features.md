# Features

What Nova v1.0 does today. Each section links to the guide with the details and limits.

## Conversation

- **Realtime voice.** Speak naturally and interrupt Nova's reply. Integrated models (Qwen by default; OpenAI, Gemini Live and StepFun preview) or a cascaded ASR, LLM and TTS pipeline you configure, including models you host yourself. See the [support matrix](support-matrix.md), [OpenAI and Gemini](global-providers.md) and the [Mac local voice stack](deployment/mac-local-voice.md).
- **Text chat.** The Workbench conversation has Chat, Plan and Build modes. See [Workbench](workbench.md).
- **Local wake word** is optional and off by default; explicit mute always wins. See [Getting started](getting-started.md#enable-a-wake-word).
- **Voiceprint verification** can restrict voice commands to a registered speaker.

## Work Nova does for you

- **Tasks.** Delegated work becomes a durable Task with acceptance criteria that Nova verifies. You can follow it, take over, hand it back, or schedule it. See [Tasks](tasks.md).
- **Coding.** Codex, OpenCode, CodeBuddy, Pi or DeepSeek Harness work in an approved project; only the agent you select must be installed. See [Coding](executors/coding.md).
- **Computer Use.** Operates desktop apps under approval, per Build conversation, on macOS and Windows. See [Computer Use in Build](executors/computer-use-build.md).
- **Mobile Use.** Supervised phone automation (`mobile.run`) through the Midscene SDK; it is configured with environment variables and is not a one-click feature. See [Mobile Use](../guides/mobile.md).
- **Approvals.** Executors ask before sensitive operations, and a failed recognition is never treated as approval. Disconnecting a phone does not cancel a running task. See [Executors](executors/overview.md).

Loop Camera (independent camera monitoring) is not offered in the v1.0 desktop app; see [Loop Camera](executors/loop-camera.md) for what remains in the runtime.

## Memory and your own data

- **Workbench** is the desktop main window: Timeline, Ideas, Goals, Feeds, Tasks and Profile beside the Nova conversation. Ideas and Goals are candidates you confirm, edit or skip; Nova does not generate Todos, but you can keep your own. See [Workbench](workbench.md).
- **Personal memory.** A source-backed local ledger that can be corrected or forgotten from the Profile page; mem0 is an explicit alternative with fewer controls. See [Personal memory](personal-memory.md).
- **Knowledge base.** Imported files are searched separately from memory. See [Knowledge base](knowledge-base.md).
- **Sources and connectors.** Local folders, Google through Composio, Apple Mail and Calendar (macOS) and Feishu, each only after you authorize it. See [Sources and connectors](sources-and-connectors.md).
- **Search and MCP.** Web search uses your configured service; external MCP servers expose only the tools you select. See [Settings](settings.md).
- **Proactivity.** Nova can surface what deserves attention and draft a reply, but never sends one for you. Optional daily briefs are off by default.

## Phones and other devices

- **Space / Host / Client.** Your Space lives on a Host you control; clients reach it through an end-to-end encrypted relay, self-hosted or set up automatically over Tailscale. See [Space / Host / Client](space-host-client.md) and the [relay guide](../../relay/README.md).
- **NovaCore for iOS and Android** runs as a Client of your Host or as a Standalone Space on the phone, in English or Chinese. A Client can chat, dictate, follow tasks, and let the Space owner approve Host actions; realtime voice in a Client Space is not yet available. See the [capability matrix](iphone.md#what-each-mode-offers).
- **Headless server** on Ubuntu 22.04+ x64 through the `nova-personal-agent-server` package. See [Remote server](deployment/remote-server.md).

## Limits

Model and search services need credentials, and local memory or knowledge can still send text to remote models you configure. Phones need their Host online for Client chat. Desktop targets macOS arm64, Windows x64 and Ubuntu 22.04+ x64; see the [support matrix](support-matrix.md) for providers and models, and [Security and privacy](security.md) for what stays local.

[Get started](getting-started.md) · [Connect a phone](iphone.md) · [Architecture](architecture.md)
