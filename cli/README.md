# Nova Personal Agent

![Nova Personal Agent chalkboard architecture](https://raw.githubusercontent.com/deepnovacore/nova-personal-agent/main/assets/ideas/v3/nova-personal-agent-runtime-chalkboard.png)

**An always-on voice agent with restrained proactivity and voice-controlled workspaces.**

[![npm](https://img.shields.io/npm/v/nova-personal-agent.svg)](https://www.npmjs.com/package/nova-personal-agent)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://github.com/deepnovacore/nova-personal-agent/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](https://nodejs.org)

[Website](https://deepnovacore.github.io/nova-personal-agent/en) ·
[GitHub](https://github.com/deepnovacore/nova-personal-agent) ·
[简体中文](https://github.com/deepnovacore/nova-personal-agent/blob/main/README.zh-CN.md) ·
[Watch the demo (Chinese)](https://youtu.be/t1c-2O-QsxE)

Nova (小诺) keeps a conversation going while longer tasks run in the background.
It reports useful milestones, clarifies requests, and lets you steer work through
voice without narrating every small step.

![Nova in conversation](https://raw.githubusercontent.com/deepnovacore/nova-personal-agent/v0.2.0/assets/features/conversation.en.png)

This package provides the `novapersonal` command, which installs and launches the
desktop application. You do not need to clone or build the repository.

## Install

Requires **Node.js 22.13.0 or newer**, npm, and **macOS on Apple Silicon**,
**Windows x64**, or **Ubuntu 22.04+ x64** with a desktop session. Intel Macs and
Linux ARM64 are not covered. Linux requires Chromium user namespaces to be
permitted by the host or container policy.
The application is not yet signed, so macOS Gatekeeper and Windows SmartScreen
will warn on first launch.

```bash
npm install --global nova-personal-agent
```

### Upgrading

Quit Nova, then run `npm install --global nova-personal-agent@latest`. Pin a version with `nova-audio-agent@0.3.1`. Upgrades keep your local settings and data; moving back to an older version does not roll back data changes, so back up your Nova data first.

For headless Ubuntu 22.04+ x64, use `npm install --global nova-personal-agent-server@latest`.

## Configure

Run `novapersonal`. The first launch downloads the app and opens a setup window
that asks for one key and tests it before you start:

- **[DashScope](https://platform.qianwenai.com)** — the default Qwen realtime voice service, plus memory, the camera and web search. Required.
- **[Tavily](https://docs.tavily.com)** — web search through Tavily instead of Bailian. Optional.
- **Codex** — a logged-in Codex executable, for coding tasks. Optional. See the [setup guide](https://deepnovacore.github.io/nova-personal-agent/en/docs/getting-started).

Allow microphone access when prompted.

## Run

```

The rename takes effect in v0.4; the new npm packages become installable after their first release. Published v0.3.x versions retain the old package names and `novaaudio` command. The new package keeps that command alias and reuses existing data and settings. When migrating an existing global install, first run `npm uninstall --global nova-audio-agent nova-audio-agent-server` to avoid command-link collisions; this leaves user data intact.
bash
novapersonal
```

Hover over the desktop orb to reach its controls.

## Why Nova?

- **Talk while work continues.** Long-running tasks execute in the background while Nova stays available for conversation.
- **Progress worth hearing.** Restrained proactivity surfaces meaningful updates instead of reading out every coding event.
- **Manage workspaces by voice.** Create or switch workspaces and sessions through proposals you confirm.
- **Steer ongoing work.** The Codex integration uses its native app-server transport, so you can redirect a task while it runs.

## Commands

| Command | What it does |
| --- | --- |
| `novapersonal` or `novapersonal start` | Download the desktop app if needed, then launch it |
| `novapersonal config` | Download the app if needed, then open its settings |
| `novapersonal doctor` | Inspect platform support, local installation, and which keys the voice pipeline needs |
| `novapersonal doctor --online` | Also test keys set in the environment against their provider |
| `novapersonal --version` | Print the desktop release version used by the CLI |
| `novapersonal --help` | Show command help |

## How it works

The CLI downloads the matching desktop release from
[GitHub Releases](https://github.com/deepnovacore/nova-personal-agent/releases) into
`~/.nova-audio-agent/cli/releases/` and verifies its published SHA-256 digest
before launching it. It reuses the desktop client's encrypted settings store and
never reads or prints secret values.

Run `novapersonal doctor` to see which release is installed and which voice keys
are still missing. `novapersonal config` opens the full settings for the other
features.

For headless Ubuntu 22.04+, install `nova-personal-agent-server` and use `novapersonal-server start`; `novapersonal-server pair wss://your-host.ts.net` shows a terminal pairing QR after configuring the service.

## Learn more

- [Getting started and integrations](https://deepnovacore.github.io/nova-personal-agent/en/docs/getting-started)
- [How Nova works](https://deepnovacore.github.io/nova-personal-agent/en/docs/architecture)
- [Design: when should a proactive voice agent speak?](https://github.com/deepnovacore/nova-personal-agent/blob/main/docs/en/blog/2026-08-proactive-voice-agent-design-space.md)
- [Report an issue](https://github.com/deepnovacore/nova-personal-agent/issues)
- [Build from source and contribute](https://github.com/deepnovacore/nova-personal-agent/blob/main/CONTRIBUTING.md)

## License

Copyright 2026 DeepNovaCore.
[Apache License 2.0](https://github.com/deepnovacore/nova-personal-agent/blob/main/LICENSE).
