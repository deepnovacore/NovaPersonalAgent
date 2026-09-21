# Nova Audio Agent

![Nova Audio Agent chalkboard architecture](https://raw.githubusercontent.com/deepnovacore/NovaAudioAgent/main/assets/ideas/v3/nova-audio-agent-runtime-chalkboard.png)

**An always-on voice agent with restrained proactivity and voice-controlled workspaces.**

[GitHub](https://github.com/deepnovacore/NovaAudioAgent) ·
[简体中文](https://github.com/deepnovacore/NovaAudioAgent/blob/main/README.zh-CN.md) ·
[Watch the demo (Chinese)](https://youtu.be/t1c-2O-QsxE) ·
[Desktop downloads](https://github.com/deepnovacore/NovaAudioAgent/releases)

Nova (小诺) keeps a conversation going while longer tasks run in the background.
It is designed to report useful milestones, clarify requests, and let you steer
work through voice without narrating every small step.

This npm package provides the `novaaudio` command to install and launch the
desktop application. You do not need to clone or build the repository to use it.

## Get started

Requirements: **Node.js 22.13.0 or newer**, npm, and **macOS on Apple Silicon**,
**Windows x64**, or **Ubuntu 22.04+ x64** with a desktop session. The first launch needs access to GitHub to download the app.
Linux also requires Chromium user namespaces to be permitted by the host or container policy.

```bash
npm install --global nova-audio-agent
novaaudio config
```

In the desktop settings, configure your [DashScope](https://platform.qianwenai.com)
API key for the default Qwen realtime voice service and your
[Tavily](https://docs.tavily.com) API key for web search. For coding tasks, set up
a logged-in Codex executable; see the
[setup guide](https://github.com/deepnovacore/NovaAudioAgent/blob/main/docs/en/getting-started.md).
Allow microphone access when prompted, then launch Nova:

```bash
novaaudio
```

Hover over the desktop orb to access its controls. Open settings again with
`novaaudio config`, or inspect your local setup with `novaaudio doctor`.

## Why Nova?

- **Talk while work continues.** Long-running tasks execute in the background
  while Nova stays available for conversation.
- **Progress worth hearing.** Restrained proactivity aims to surface meaningful
  updates without reading out every coding event.
- **Manage workspaces by voice.** Create or switch workspaces and sessions
  through proposals that you confirm.
- **Steer ongoing work.** The Codex integration uses its native app-server
  transport to support real-time steering.

The repository also documents ongoing development. Features and acceptance
status on development branches may differ from the shipped desktop release;
check the [release notes](https://github.com/deepnovacore/NovaAudioAgent/releases)
for your installed version.

## Commands

| Command | What it does |
| --- | --- |
| `novaaudio` or `novaaudio start` | Download the desktop app if needed, then launch it |
| `novaaudio config` | Download the app if needed, then open its settings |
| `novaaudio doctor` | Inspect platform support, local installation, and configuration status |
| `novaaudio --version` | Print the desktop release version used by the CLI |
| `novaaudio --help` | Show command help |

## Installation details

The CLI downloads the matching `v0.2.0` desktop release from
[GitHub Releases](https://github.com/deepnovacore/NovaAudioAgent/releases/tag/v0.2.0)
into `~/.nova-audio-agent/cli/releases/` and verifies its published SHA-256 digest
before launching it. It reuses the desktop client's encrypted settings store;
the CLI does not read or print secret values.

Documentation-only npm updates may have a newer package version while retaining
the same desktop release. `novaaudio --version` continues to report `0.2.0`.

Desktop targets are macOS arm64, Windows x64, and Ubuntu 22.04+ x64 (AppImage). Intel Mac
and Linux ARM64 downloads are not included. The desktop application is currently unsigned, so
macOS Gatekeeper or Windows SmartScreen may display a security warning.

For headless Ubuntu 22.04+, install `nova-audio-agent-server` and use `novaaudio-server start`; `novaaudio-server pair wss://your-host.ts.net` shows a terminal pairing QR after configuring the service.

## Learn more

- [Getting started and integrations](https://github.com/deepnovacore/NovaAudioAgent/blob/main/docs/en/getting-started.md)
- [Runtime architecture](https://github.com/deepnovacore/NovaAudioAgent/blob/main/docs/en/architecture.md)
- [Design: when should a proactive voice agent speak?](https://github.com/deepnovacore/NovaAudioAgent/blob/main/docs/en/blog/2026-08-proactive-voice-agent-design-space.md)
- [Report an issue](https://github.com/deepnovacore/NovaAudioAgent/issues)
- [Build from source and contribute](https://github.com/deepnovacore/NovaAudioAgent/blob/main/CONTRIBUTING.md)

## License

Copyright 2026 DeepNovaCore.
[Apache License 2.0](https://github.com/deepnovacore/NovaAudioAgent/blob/main/LICENSE).
