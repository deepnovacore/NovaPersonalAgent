# Getting Started

Nova runs on your computer, talks with you by voice, and hands coding tasks to a coding agent (Codex by default).

## 1. Prepare your computer

To run from source, install Node.js 22.13 or later, npm, Git, and the coding agent you will use (Codex by default). Sign in to it before starting Nova.

Only the agent you select is required: Codex is needed only for the Codex backend. To use OpenCode, CodeBuddy, Pi or DeepSeek Harness instead, install it and pick it in Settings; see [Coding](executors/coding.md#choosing-an-agent).

Native components also need a platform toolchain:

- macOS: Xcode Command Line Tools (`xcode-select --install`).
- Windows: Visual Studio Build Tools with **Desktop development with C++**.
- Ubuntu 22.04+ x64: a C/C++20 compiler (GCC 12 or newer), X11 or XWayland, and permission to use Chromium user namespaces.

Desktop targets macOS arm64, Windows x64, and Ubuntu 22.04+ x64.

## 2. Install and start

### Install or upgrade

```bash
npm install --global nova-personal-agent@latest
npa
```

The command is `npa`; `novapersonal` remains an alias. To upgrade, quit Nova and run the same command. Pin a version with `nova-personal-agent@1.0.0`. Upgrades keep your local settings and data; moving back to an older version does not roll back data changes, so back up your Nova data first. An upgraded install keeps using `~/.nova-audio-agent`; moving it to `~/.nova-personal-agent` with `npa migrate-data [--dry-run]` (with Nova closed) is optional (see [Local data location](configuration.md#local-data-location)).

For headless Ubuntu 22.04+ x64, use `npm install --global nova-personal-agent-server@latest`.

For development from source:

```bash
git clone https://github.com/deepnovacore/NovaPersonalAgent.git nova-personal-agent
cd nova-personal-agent
npm ci
cp .env.example .env
```

Add the voice credential to `.env`:

```dotenv
DASHSCOPE_API_KEY=your-dashscope-key
```

The same key covers memory and web search, which uses Bailian search until you add `TAVILY_API_KEY`. A feature whose key is missing stays off, and Settings shows the key it needs. Without a key, the desktop opens a setup window on first launch. Start the desktop:

```bash
npm run start:client
```

When running from source, the project `.env` takes precedence over matching shell variables. Restart the desktop after editing it.

Desktop source launch commands currently provide no hot reload or file watching. `start:client` and `start:workbench` build before launching. With an existing build, `npm run start:built --workspace @nova-personal-agent/desktop` skips building for a faster launch. Changes to main, preload or runtime require quitting and restarting; runtime source changes also require rebuilding. Keep isolated build outputs and compiler caches on internal storage, namespaced per worktree and run (for example via `npm run build:space -- --output-root <dir> --run-id <id>`). Run `npm run check` and `npm test` to verify runtime, desktop, CLI, and env contracts.

## 3. Give Nova a task

Try: “Create a webpage to showcase my work.” Nova asks for any missing information, requests confirmation when creating or switching projects, and sends the task to the selected coding agent.

You can add requirements, ask about progress, or request a stop. The task banner shows work status; bubbles provide brief updates. Operations that need permission have a separate approval prompt.

A project is a directory containing your files. A session is an ongoing conversation with the coding agent within that project. You can start a new session without discarding project files, or continue an existing session.

## 4. Change settings

Choose Chinese or English in Settings for the interface and AI system prompts. When local wake detection is enabled, both “你好星核” and “Hi Nova” are available.

Right-click the orb and open Settings.

- **保存 (Save)** stores changes. Service settings show a pending-restart notice.
- **重启 (Restart)** starts the backend with saved settings and preserves unsaved drafts.
- Appearance and wake-word changes apply immediately after saving.

Keys are write-only: the panel shows presence, not their values. Edit `.env` to change keys managed by that file.

### Choose a voice mode

| Mode | How it works | Defaults |
|---|---|---|
| `integrated` | One model handles speech directly | Qwen `qwen-audio-3.0-realtime-plus`, voice `longanqian` |
| `cascaded` | Separate recognition, language model and speech synthesis | Volcengine ASR -> DeepSeek `deepseek-flash` -> Volcengine TTS |

Integrated mode can also use StepFun (`INTEGRATED_PROVIDER=stepfun`, preview) with `STEPFUN_API_KEY`.

One key per platform is reused across selected services: DeepSeek uses `DEEPSEEK_API_KEY`; Qwen uses `DASHSCOPE_API_KEY`; Volcengine speech uses `DOUBAO_BIGMODEL_API_KEY` for both ASR and TTS.

Ark is an explicit cascaded LLM option using `ARK_API_KEY`. The conditional Settings Panel shows only the selected mode's controls. Service settings take effect on the backend's next launch. Nova does not automatically fail over to another provider.

### Enable a wake word

Local wake-word detection is off by default. Enabling it downloads the model on first use. The orb hides after 60 idle seconds by default; choose 30–3600 seconds, or 0 to disable automatic hiding.

While asleep, microphone input goes to local wake detection. Explicit mute stops detection too; unmute manually to resume.

### Choose the main window

Desktop launches into one of three views, controlled by the `startupView` setting: `orb` starts hidden as a floating orb, `workbench` opens the full window (the default), and `last` reopens whichever view was active when Nova last closed. Run `npm run start:workbench` to open Workbench for a single launch regardless of the saved setting. See [Workbench](workbench.md).

## 5. Memory, documents and iPhone

- **Personal memory** is on by default and stored locally in the unified memory ledger; inspect, correct or forget entries from the Workbench's Profile page. mem0 remains available as an explicit alternative. See [personal memory](personal-memory.md).
- **Document knowledge** is enabled in capability settings. Review the data-processing notice before importing files; embedding sends text to your configured model service.
- **Phones (NovaCore)**: see [Pair a phone](#pair-a-phone) below, or the [mobile guide](iphone.md) for what a paired phone can do.

## Pair a phone

Nova runs on your computer (the Host); the NovaCore app on iOS or Android connects to it as a Client. Pairing takes one QR code.

1. On the desktop, open **Settings → Devices**. Under **Connection**, keep **Tailscale automatic setup** (both devices must sign in to the same Tailscale network, with MagicDNS and HTTPS certificates enabled) or choose **Advanced: existing relay**, then choose **Create Space**. To use data already on this computer, set **Space data** to **Connect existing data on this computer**; the default is **Start a new Space**.
2. Under **Connect your phone**, choose **Create one-time pairing code**.
3. In NovaCore, create a Space, choose **Connect to a computer**, and scan the code.
4. On the desktop, enter the full fingerprint shown on the phone under **Phone waiting to connect** and choose **Confirm pairing**.

The first confirmed phone becomes the Space owner. See [Connect a phone](iphone.md) for what a Client can and cannot do, and [Space / Host / Client](space-host-client.md) for the full setup.

## Troubleshooting

| Problem | What to check |
|---|---|
| macOS says the app is "damaged" | The app is unsigned and a browser download carries a quarantine flag. Move it to Applications, run `xattr -dr com.apple.quarantine "/Applications/Nova Personal Agent.app"`, then open it again |
| Voice cannot connect | Credentials, service access and connectivity for the selected mode |
| The coding agent cannot run | Sign-in of the agent selected in Settings (Codex only if it is the selected backend) and access to the project directory |
| Unsure which keys are missing | Run `npa doctor`; it checks the keys your selected voice providers need, and `--online` tests them |
| Saved settings have no effect | Look for the pending-restart notice and restart the backend |
| Search is unavailable | Search credentials; Bailian or other MCP search also needs the selected service enabled |
| A recent fact is missing | Learning takes time; check its state in the memory panel |
| The phone does not pair | Both devices on the same Tailscale network with MagicDNS and HTTPS enabled, or a reachable relay; the QR code is single-use and expires, so create a new one |

## Advanced configuration

Capabilities are stored in `~/.nova-personal-agent/capabilities.json`. Disable unneeded modules or configure external MCP services and their allowed tools. Only enabled services need credentials.

Search uses Tavily when `TAVILY_API_KEY` is set, otherwise Bailian MCP search with `DASHSCOPE_API_KEY`, otherwise it stays off. MCP search uses its own service credentials and does not need a Tavily key. Remote MCP requires HTTPS; unauthenticated local testing can use loopback HTTP.

For implementation details, see the [architecture guide](architecture.md).

[Core environment variables](configuration.md)
