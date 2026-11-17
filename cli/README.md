# Nova Personal Agent

**Your personal agent and voice assistant: remembers context, keeps work moving, and leaves you in control.**

[Website](https://deepnovacore.github.io/NovaPersonalAgent/) · [Documentation](https://deepnovacore.github.io/NovaPersonalAgent/en/docs/) · [GitHub](https://github.com/deepnovacore/NovaPersonalAgent) · [简体中文](https://github.com/deepnovacore/NovaPersonalAgent/blob/main/README.zh-CN.md)

![Nova personal agent architecture](https://raw.githubusercontent.com/deepnovacore/NovaPersonalAgent/main/assets/architecture/nova-personal-agent.en.png)

## New in 1.0.0

- **Space / Host / Client.** Your Space lives on a Host you control; desktop, iOS and Android join it over an end-to-end encrypted relay or Tailscale.
- **A unified mobile companion.** iOS and Android with Timeline, Profile and documents, paired to a Host or running standalone.
- **A rebuilt Workbench.** Timeline, Ideas, Goals, Feeds, Tasks and Profile beside Chat, Plan, Build and Delegate conversations.
- **More executors.** Coding agents, computer use, supervised mobile use and loop-camera monitoring share approvals, cancellation and evidence checks.
- **Auditable memory.** A local ledger with optional mem0 or voicemem recall and separate consent for reading and model processing.

Model-written profiles can be wrong; review their references. The default message scope is your own messages and direct mentions. ACP agents have different permission controls from Codex and do not support live steering. Read the [coding support matrix](https://deepnovacore.github.io/NovaPersonalAgent/en/docs/executors/coding/).

## Install and start

Requires **Node.js 22.13+**, npm, and **macOS Apple Silicon**, **Windows x64**, or an **Ubuntu 22.04+ x64 desktop**. Linux requires Chromium user namespaces permitted by the host. Desktop apps are unsigned; macOS Gatekeeper and Windows SmartScreen may warn on first launch.

```bash
npm install --global nova-personal-agent@latest
novapersonal
```

The CLI downloads the matching desktop application from [GitHub Releases](https://github.com/deepnovacore/NovaPersonalAgent/releases), checks its SHA-256 digest and launches it. No source checkout or build is needed. Configure your model/voice provider in Settings; coding tasks additionally require an installed and authenticated coding backend.

For a headless Ubuntu server, use [nova-personal-agent-server](https://www.npmjs.com/package/nova-personal-agent-server).

## Upgrade from Nova Audio Agent

Nova Personal Agent reuses existing local data and encrypted settings. Quit the app before upgrading. When switching package names, remove the old package first to avoid command-link collisions:

```bash
npm uninstall --global nova-audio-agent
npm install --global nova-personal-agent@latest
```

`novaaudio` remains a command alias. The old `nova-audio-agent` npm entry also provides the same 1.0.0 launcher for existing installations; install only one package name. Pin this release with `nova-personal-agent@1.0.0`. Back up Nova data before downgrading; an older executable does not roll back data changes.

## Commands

| Command | Purpose |
| --- | --- |
| `novapersonal` or `novapersonal start` | Download and launch the desktop app |
| `novapersonal config` | Open desktop settings |
| `novapersonal doctor` | Inspect platform support, installation and required voice keys |
| `novapersonal doctor --online` | Also test provider keys from the environment |
| `novapersonal --version` | Show the bundled release version |
| `novapersonal --help` | Show command help |

Downloads remain under `~/.nova-audio-agent/cli/releases/`; the product rename does not move user data.

[Release notes](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v1.0.0) · [Report an issue](https://github.com/deepnovacore/NovaPersonalAgent/issues) · [GPL-3.0-or-later license](https://github.com/deepnovacore/NovaPersonalAgent/blob/main/LICENSE)
