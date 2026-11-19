# Settings

Open Settings from the orb menu. The desktop panel groups controls by purpose:

| Category | Holds |
|---|---|
| General | Language, startup view, wake word, notifications, intent clarification, proactivity and display |
| Briefings | Morning and evening briefings and quiet hours |
| Themes | Nova Visor desktop HUD and the orb appearance |
| Usage | Current-run and lifetime usage with estimated costs |
| API keys | ChatGPT/Codex sign-in and provider credentials |
| Models | Text and voice model routes, integrated or cascaded voice, speech recognition and synthesis |
| Skills | Installed skills and the skills directory |
| Executors | Vision and coding agents, executor configuration and workspaces |
| MCP | MCP servers and exposed tools |
| Connectors | IM channels, authorized sources and connected applications |
| Devices | Space Host settings and paired Clients |
| Permissions | Desktop system permissions and approval controls |
| Privacy & data | Consent for sending conversation content to model services |
| Knowledge Base | Imported documents, embeddings, storage and retrieval |

## Saving and restarting

Save stores your changes. The panel reports whether they apply immediately or need a backend restart. Appearance and the default agent for new sessions apply without restarting. Model, capability, MCP and connection changes may require a restart; use the panel's pending-restart notice as the authority.

Replacing a supported provider key can apply to the running backend when that client already exists and the previous key is not shared by another setting. Adding or clearing a key, changing a shared key, or changing an unsupported credential requires a restart. Keys are write-only: the panel shows their presence, never the saved value. Edit `.env` for credentials managed by that file.

Restart uses the saved settings and preserves unsaved drafts. If a configuration prevents startup, the panel can restore the last working settings.

## Local Build approval

The composer approval control switches local Build writes, edits and shell commands between **Always ask** and **Always approve**. Changes apply from the next tool call and are saved for the next launch. This is separate from the coding executor's approval policy. `NOVA_LOCAL_TOOL_APPROVAL` sets the same choice for a direct runtime launch.

Computer Use also requires its platform, model, display and system-permission checks to pass. Enabling it does not grant missing operating-system permissions. Plan and Build voice sessions provide no tools; return to text for execution.

## Skills and usage

Skills live in `~/.nova-personal-agent/skills`. Each subfolder with a readable `SKILL.md` supplies one skill. The first run seeds Computer Use without overwriting an existing `SKILL.md`; refresh the panel after changing the directory.

Usage costs are estimates. Some external tools do not report usage, so the displayed total is not a complete billing statement.

[Getting started](getting-started.md) · [Workbench](workbench.md) · [Coding agents](executors/coding.md) · [Core configuration](configuration.md)
