# Nova Personal Agent server

v0.4.0 brings scheduled Agent Tasks, incremental source processing, source-backed Profile updates and additional coding backends. Manage tasks and talk to Nova through the paired iPhone client.

[Website](https://deepnovacore.github.io/NovaAudioAgent/) · [Release notes](https://github.com/deepnovacore/NovaAudioAgent/releases/tag/v0.4.0)

Run Nova without Electron on Ubuntu 22.04+ x64 using Node.js >=22.14.0.

```sh
npm install --global nova-personal-agent-server@latest
mkdir -p "$HOME/.nova-remote"
chmod 700 "$HOME/.nova-remote"
export SERVER_PORT=19876
export SERVER_TOKEN_FILE="$HOME/.nova-remote/client-token"
novapersonal-server token-init
novapersonal-server --env-file "$HOME/.nova-remote/server.env" start
```

Use a private (0600) environment file with your model credentials, pipeline and absolute workspace paths; the service does not read desktop settings. It stays in the foreground and listens on loopback. See the [remote service guide](https://github.com/deepnovacore/NovaAudioAgent/blob/main/docs/en/deployment/remote-server.md) for configuration and private WSS access.

With the service running, use the same environment in a second interactive terminal:

```sh
novapersonal-server --env-file "$HOME/.nova-remote/server.env" pair wss://your-host.ts.net
```

Scan the one-use QR with Nova on iPhone. SSH needs a TTY (`ssh -t`); Ctrl+C cancels the invitation without stopping the service. No desktop session or local microphone is required for remote phone audio.

## Upgrading

Install or update with `npm install --global nova-personal-agent-server@latest`, or pin `nova-personal-agent-server@0.4.0`. Stop the service and back up its data before upgrading; installing a different version changes the executable, not the persisted data.
