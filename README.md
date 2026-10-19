<!-- Keep in sync with README.zh-CN.md -->

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/npa-header-dark.svg">
  <img src="assets/brand/npa-header-light.svg" alt="NovaPersonalAgent — Understands you. Interacts in real time." width="100%">
</picture>

<a href="README.md"><ins>English</ins></a> | <a href="README.zh-CN.md"><ins>简体中文</ins></a>

[![CI](https://github.com/deepnovacore/NovaPersonalAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/deepnovacore/NovaPersonalAgent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](package.json)
[![npm downloads](https://img.shields.io/npm/d18m/nova-audio-agent?logo=npm&label=npm%20downloads)](https://npm-stat.com/charts.html?package=nova-audio-agent)
[![Website](https://img.shields.io/badge/Website-GitHub%20Pages-222222?logo=github)](https://deepnovacore.github.io/NovaPersonalAgent/)
[![YouTube](https://img.shields.io/badge/YouTube-Demo-FF0000.svg)](https://youtu.be/t1c-2O-QsxE)

**An open-source personal agent with private memory, smart proactivity and realtime interaction.**

Nova draws on your context and private memory to understand what matters to you. It knows how and when to clarify, ask for approval, and move work forward. Its dual brains keep the conversation responsive while background agents handle longer tasks. Refine your goals as work progresses, revisit the results, and stay in control.

**[Website](https://deepnovacore.github.io/NovaPersonalAgent/) · [Documentation](docs/en/README.md) · [Product film](https://deepnovacore.github.io/NovaPersonalAgent/#film)**

[Quickstart](#3-quickstart) · [Highlights](#1-highlights) · [Use cases](#23-use-cases) · [Roadmap](#5-roadmap)

</div>

---

https://github.com/user-attachments/assets/89a52d5a-b8c8-4587-b0c9-e082cf27fae9

## News

- **2026-10-13 · [v0.4.0](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v0.4.0)** — **Continuous context, ongoing work:** GUI-use across browser, computer and phone (experimental), Scheduled Agent Tasks, and a full Timeline for context, evidence and task results.
- **2026-10-07 · [v0.3.0](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v0.3.0)** — **Your personal agent:** Todos, Ideas, Goals, Feeds and Profile, with source-backed memory and evidence-checked tasks.
- **2026-09-21 · [v0.2.0](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v0.2.0)** — **Voice, your way:** configurable ASR / LLM / TTS, personal memory, MCP and an iPhone companion.
- **2026-08-31 · [v0.1.0](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v0.1.0)** — **Always-on voice assistant with dual brains:** responsive frontend conversation and background agent execution, with live steering.

<details>
<summary>Earlier minor releases</summary>

- **2026-10-09 · [v0.3.1](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v0.3.1)** — **A smoother start:** ready-to-use text chat and easier desktop upgrades.
- **2026-09-24 · [v0.2.3](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v0.2.3)** — Guided first run with one DashScope API key.
- **2026-09-21 · [v0.2.2](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v0.2.2)** — Ubuntu desktop and a headless server with QR pairing.

</details>

## 1. Highlights

[![Nova personal agent architecture](assets/architecture/nova-personal-agent.en.png)](assets/architecture/nova-personal-agent.en.png)

Your context informs the conversation; the front brain coordinates work with the back brain. Nova checks results and speaks when it matters.

- **Your proactive personal agent.** Todos, Ideas, Goals, Feeds and Profile turn what Nova knows about you into suggestions you can act on.
- **Wide and unstructured context.** Bring folders, mail, calendars, conversations and documents; keep personal memory traceable, editable and removable.
- **Always-on voice assistant with dual brains.** The front brain stays in conversation while the back brain handles long-running work.
- **A thin frontend task coordinator.** Clarify, authorize and delegate to a coding agent; check evidence against your criteria, take over and hand control back.
- **Restrained proactivity.** Nova chooses what matters and when to speak. Routine updates stay quiet, and reminders respect your turn.

- **More coding agents.** New sessions can also run on OpenCode, CodeBuddy, Pi or DeepSeek Harness over ACP; each session keeps the agent it started with. Live steering stays a Codex feature. See [Coding](docs/en/executors/coding.md).

[How Nova works](docs/en/architecture.md) · [Task controls](docs/en/tasks.md) · [Source permissions](docs/en/sources-and-connectors.md)

## 2. Work with Nova

### 2.1 Your personal agent, with wide and unstructured context

Connect the sources you choose: folders, mail, calendars and conversations. Personal memory and imported document knowledge help Nova understand your work; reading sources and model processing remain separate permissions.

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Your personal workbench</h3>
      <p>Turn scattered context into source-backed recaps and suggested todos. Choose what to do next, then continue with Nova.</p>
      <a href="assets/features/workbench-original.en.png"><img src="assets/features/workbench-original.en.png" alt="Nova workbench with project recaps, suggested todos and conversation" width="100%"></a>
    </td>
    <td width="50%" valign="top">
      <h3>Profile and personal memory</h3>
      <p>Nova builds an editable picture of your work and interests. Trace personal memories to their sources, correct them or remove them.</p>
      <a href="assets/features/profile-original.en.png"><img src="assets/features/profile-original.en.png" alt="Nova Profile showing a personal overview and recent projects" width="100%"></a>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Ideas and goals</h3>
      <p>Keep an idea, choose a direction, and turn it into a todo when you are ready. Suggestions wait for you to adopt them.</p>
      <a href="assets/features/ideas-goals-original.en.png"><img src="assets/features/ideas-goals-original.en.png" alt="Nova Ideas and Goals with actual suggestions and adoption controls" width="100%"></a>
    </td>
    <td width="50%" valign="top">
      <h3>Feeds that follow your interests</h3>
      <p>Review public news ranked by your Profile. Save a story or turn it into an idea, todo or goal.</p>
      <a href="assets/features/feeds-original.en.png"><img src="assets/features/feeds-original.en.png" alt="Nova interest-ranked news feed with save and personal-item controls" width="100%"></a>
    </td>
  </tr>
</table>

### 2.2 Your voice assistant with restrained proactivity

The front brain handles conversation; the back brain does the work. Task events and camera observations inform optional updates, while speaking has its own timing.

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Understands what you mean</h3>
      <p>Describe your goal naturally. Nova asks for missing details before starting a task; keep talking and refining it while the back brain works.</p>
      <a href="assets/features/conversation-polished.en.png"><img src="assets/features/conversation-polished.en.png" alt="Nova voice orb asking a clarifying question before starting a task" width="100%"></a>
    </td>
    <td width="50%" valign="top">
      <h3>You set the boundaries</h3>
      <p>Nova coordinates tasks and checks results against your criteria. Review permissions, take over when needed, and hear updates when they matter.</p>
      <a href="assets/features/permission-polished.en.png"><img src="assets/features/permission-polished.en.png" alt="Nova asking for permission to access the network for a task" width="100%"></a>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Voice-run workspaces</h3>
      <p>Create and switch workspaces and sessions by voice. A new workspace waits for your confirmation.</p>
      <a href="assets/features/workspace-polished.en.png"><img src="assets/features/workspace-polished.en.png" alt="Nova waits for approval to create a workspace" width="100%"></a>
    </td>
    <td width="50%" valign="top">
      <h3>Bring your tools and knowledge</h3>
      <p>Configure ASR / LLM / TTS and MCP; ask questions across your documents.</p>
      <a href="assets/features/knowledge-polished.en.png"><img src="assets/features/knowledge-polished.en.png" alt="Knowledge-base answer using the CN-27 demo documents" width="100%"></a>
    </td>
  </tr>
</table>

### 2.3 Use cases

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Voice Vibe Coding</h3>
      <p>Describe what you want, let a coding agent build and test it, and refine the work through conversation.</p>
      <a href="assets/features/coding.en.svg"><img src="assets/features/coding.en.svg" alt="Voice requests delegated to a background coding agent" width="100%"></a>
    </td>
    <td width="50%" valign="top">
      <h3>Camera Monitoring</h3>
      <p>Ask Nova to watch for a condition and tell you when it happens. Observation runs independently of coding tasks.</p>
      <a href="assets/features/vision-camera.png"><img src="assets/features/vision-camera.png" alt="Camera monitoring a cat on a sofa" width="100%"></a>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Weekly Report</h3>
      <p>Ask Nova to recall recent work and help organize a weekly report. Watch the original phone demo.</p>
      <a href="assets/demos/weekly-report/weekly-report.mp4"><img src="assets/demos/weekly-report/poster.en.png" alt="Original phone demo of a conversation about recent work and a weekly report" width="225"></a>
      <p><a href="assets/demos/weekly-report/weekly-report.mp4">▶ Watch the demo</a></p>
    </td>
    <td width="50%" valign="top">
      <h3>Take Nova with you</h3>
      <p>Connect your iPhone over Tailscale to your desktop or headless server. Talk to Nova and approve tasks wherever you are.</p>
      <a href="assets/features/iphone.en.png"><img src="assets/features/iphone.en.png" alt="Nova iPhone client and connection settings" width="100%"></a>
    </td>
  </tr>
</table>

## 3. Quickstart

### 3.1 Install and run

**Quick downloads · v0.4.0** — [Release notes and SHA-256 checksums](https://github.com/deepnovacore/NovaPersonalAgent/releases/tag/v0.4.0) · [Latest release](https://github.com/deepnovacore/NovaPersonalAgent/releases/latest)

| Platform | Download |
| --- | --- |
| macOS · Apple Silicon (arm64) | [DMG](https://github.com/deepnovacore/NovaPersonalAgent/releases/download/v0.4.0/nova-personal-agent-0.4.0-macos-arm64.dmg) · [ZIP](https://github.com/deepnovacore/NovaPersonalAgent/releases/download/v0.4.0/nova-personal-agent-0.4.0-macos-arm64-app.zip) |
| Windows · x64 | [EXE](https://github.com/deepnovacore/NovaPersonalAgent/releases/download/v0.4.0/nova-personal-agent-0.4.0-windows-x64.exe) · [Portable ZIP](https://github.com/deepnovacore/NovaPersonalAgent/releases/download/v0.4.0/nova-personal-agent-0.4.0-windows-x64-portable.zip) |
| Linux · Ubuntu 22.04+ x64 | [AppImage](https://github.com/deepnovacore/NovaPersonalAgent/releases/download/v0.4.0/nova-personal-agent-0.4.0-linux-x64.AppImage) · [DEB](https://github.com/deepnovacore/NovaPersonalAgent/releases/download/v0.4.0/nova-personal-agent-0.4.0-linux-x64.deb) |

Requirements: Node.js 22.13+ and npm. For coding tasks, install and authenticate your chosen coding backend; Codex uses its app-server transport.

Install the release with npm.

```bash
npm install --global nova-personal-agent@latest
# open the shipped app; configure a provider to enable voice
novapersonal
# open the settings panel in the app
novapersonal config
# list the keys your voice pipeline needs; --online tests them
novapersonal doctor
```

v0.4 introduces the Nova Personal Agent package names. Published v0.3.x versions retain the old package names and `novaaudio` command. The new package keeps that command alias and reuses existing data and settings. When migrating an existing global install, first run `npm uninstall --global nova-audio-agent nova-audio-agent-server` to avoid command-link collisions; this leaves user data intact.


Quit Nova before upgrading, then rerun the install command above. To pin a version, use `nova-personal-agent@0.4.0`. Upgrades keep your settings and data; back up your Nova data before downgrading.

Headless Ubuntu 22.04+ x64:

1. Install or upgrade with `npm install --global nova-personal-agent-server@latest`, then configure the service and initialize credentials using the [configuration guide](docs/en/deployment/remote-server.md).
2. Start the service with `novapersonal-server start`.
3. In a second terminal, run `novapersonal-server pair wss://your-host.ts.net` to display a one-use pairing QR code.

### 3.2 Develop from source

For development from source:

```bash
git clone https://github.com/deepnovacore/NovaPersonalAgent.git nova-personal-agent
cd nova-personal-agent
npm ci && cp .env.example .env
```

Get an API key from [DashScope](https://platform.qianwenai.com) and set `DASHSCOPE_API_KEY`. That one key runs voice, memory, the camera and web search. Search goes through Bailian until you add a [Tavily](https://docs.tavily.com) `TAVILY_API_KEY`.

```bash
npm run start:client
# Open Workbench for this launch, overriding the saved startup preference
npm run start:workbench
# Build, diagnose or run the local demos
npm run build --workspace @nova-personal-agent/runtime
node runtime/dist/src/cli.js diagnose --json
node runtime/dist/src/cli.js demo all
```

The client includes microphone, camera, sound, settings and external MCP controls. Try hovering over the desktop orb for a surprise :)

### 3.3 Support matrix

| Platform | Desktop app | Headless server | Connect iPhone |
|---|---|---|---|
| macOS arm64 | ✅ Native echo cancellation | ✅ From source | ✅ Desktop pairing |
| Windows x64 | ✅ | ❌ | ❌ |
| Ubuntu 22.04+ x64 | ✅ | ✅ npm package | ✅ Headless pairing |

| Layer | Providers |
|---|---|
| Integrated voice | Qwen realtime, OpenAI realtime, Gemini Live, StepFun (preview) |
| Cascaded ASR / TTS | Volcengine Speech, Gemini, self-hosted (reference: Whisper / Breeze) |
| Cascaded LLM | DeepSeek, Qwen / DashScope, Volcengine Ark, OpenAI, Gemini, self-hosted |
| Vision | Qwen-VL family, Doubao Seed |
| Coding agent | Codex, OpenCode, CodeBuddy, Pi, DeepSeek Harness |
| Sources | Local folders, Google via Composio, Apple Mail and Calendar (macOS), Feishu |

Models, credentials and per-provider limits: [support matrix](docs/en/support-matrix.md).

## 4. Documentation

| Read this | For |
|---|---|
| [Architecture](docs/en/architecture.md) | Modules and boundaries |
| [Glossary and invariants](docs/en/glossary.md) | Vocabulary and rules |
| [Getting started](docs/en/getting-started.md) | Setup and integrations |
| [Workbench](docs/en/workbench.md) · [Tasks](docs/en/tasks.md) · [Sources and connectors](docs/en/sources-and-connectors.md) | The main window, delegated work, and what Nova may read |
| [When should a voice agent speak?](docs/en/blog/2026-08-proactive-voice-agent-design-space.md) | Voice interaction design |
| [Node runtime migration archive](https://github.com/deepnovacore/NovaPersonalAgent/tree/20a0812c0acb83b53cbad4b415d637dafff3c7f6/docs/archs/node-runtime-migration) | Migration-era plans in the history of tag `v0.1.0` |

## 5. Roadmap

- [x] **v0.4.0 — Ongoing context and specialist agents.** Persistent home and Timeline, scheduled tasks, incremental Profile updates and multiple coding backends. GUI/device execution remains experimental.
- [ ] **v1.0.0 — Stable release.** Establish stable core behavior across supported platforms, reliable installation and upgrades, predictable recovery, and complete user documentation.

Development integrations are not release guarantees. Features ship after their supported configurations pass acceptance.

## 6. Contribution

```bash
npm ci && npm run check && npm run build && npm test
```

Live integrations are credential- and hardware-dependent and never substitute for the
deterministic tests. Security reports: [SECURITY.md](SECURITY.md); contribution rules and
invariants: [CONTRIBUTING.md](CONTRIBUTING.md).

## 7. License

Copyright 2026 DeepNovaCore, [GNU GPL v3 or later](LICENSE).
