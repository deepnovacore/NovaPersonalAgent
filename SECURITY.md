# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Instead, use
[GitHub private vulnerability reporting](https://github.com/deepnovacore/NovaPersonalAgent/security/advisories/new)
for this repository. If that channel is unavailable, open an issue that only asks a maintainer to
get in touch — without any technical detail — and we will move the exchange to a private channel.

When reporting, never include:

- credentials, API keys, or tokens (rotate anything you suspect leaked);
- personal recordings, camera frames, or other local media;
- private runtime traces, telemetry, or workspace contents.

A minimal description of the affected component and the conditions to reproduce is enough. We will
acknowledge reports as quickly as we can; this is an experimental project maintained on a
best-effort basis.

## Scope notes

The settings window is a trusted local configuration surface. Enabling an external
MCP server authorizes its configured command to run with the user's permissions;
review the command, arguments and environment before saving. Keep remote content
out of this configuration authority.

- The runtime treats external search results and visual content as evidence, never instructions;
  reports about prompt-injection boundaries are in scope and welcome.
- Configuration errors must not echo secret values; any counterexample is a bug.
- Codex workspace paths, Camera file inputs, and the loopback-only MyContext provider base are
  validated before use; reports about bypasses of those validations are in scope.
- Home Assistant and AutoGLM are removed: legacy settings for them (including `AUTOGLM_*` and `EXECUTORS=autoglm`) fail closed before any client
  is constructed, and a configuration that still reaches one of those endpoints is a bug.
- Optional experience mode. Two features contact `api.deepnovacore.com`; nothing else in the clients does.
  Experience Spaces (sample personas, desktop Settings → Devices and the NovaCore Space list) only talk to
  it after you redeem an experience code. Redeeming sends the code and a random per-installation secret
  (kept in OS-encrypted storage, never in the renderer); later calls request short-lived tokens, refresh a
  sample persona's profile (persona id and source version), and send the text of that experience
  conversation to a hosted model. On the desktop, a text model you configured yourself is used first, and
  the hosted service only when none is set. Experience Spaces hold sample data, not yours, and cannot be
  paired with a phone. Separately, the clients fetch a small public catalogue of conversation-starter
  topics for the interface language (`/nova/common/v1/ideas/{zh,en}.json`): a credential-less GET
  that sends no account or personal data beyond ordinary network metadata such as your IP address, with
  a 64 KiB size cap, no redirects and strict validation. Reports about either path sending more than this are in scope.
- Live provider integrations (Qwen realtime, OpenAI, Gemini, Volcengine, Tavily, Codex) run with
  the credentials you configure locally; secure those credentials as you would for any other tool.
- The reference self-hosted voice services in `serving/` bind to loopback and do not authenticate
  requests. Do not expose their ports beyond a trusted machine; use an SSH tunnel or an
  authenticating reverse proxy.
