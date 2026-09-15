# Live project acceptance

Use `project` when validating real workspace creation and coding execution. Unlike `text-tools`, it runs the production intake/confirmation path and the real Codex executor. It does not replace model-routing tests.

Build the desktop resources and runtime first. On macOS, supply the existing DashScope and Doubao keys through the runner's `--env-file` or environment. Codex must already be installed and signed in. The test does not read the desktop keychain, change credentials, or approve executor permission prompts.

```sh
npm run build --workspace @nova-audio-agent/desktop
NOVA_LIVE_PROJECT_EXECUTE=1 node runtime/scripts/live-smoke.mjs \
  --target project --env-file /path/to/live.env --output /tmp/project-live.json
```

This is opt-in because it consumes model usage, creates files, and leaves real Codex threads in the shared Codex home. Nova's project state and managed workspaces are isolated under a new OS temporary directory, retained for inspection. The sidecar `/tmp/project-live.json.project-1.json` records stage results, ASR transcripts, spoken output, confirmation identity, final executor status and artifact contents. It intentionally omits the discovered session roster and credentials. Do not publish reports without reviewing their generated text.

The default uses text input and a natural confirmation sentence, then continues in the same session and explicitly creates a new session in the same workspace. It checks all three files and verifies that continuation preserves the Codex thread id while new-session execution changes it. An unnecessary first-turn clarification, replacement proposal, missing completion, wrong session identity, or incorrect/missing artifact fails acceptance. It never silently substitutes a short confirmation or presses the host's confirmation control after a failure.

- `NOVA_LIVE_PROJECT_CONFIRMATION=short`: explicitly test the short-confirmation baseline.
- `NOVA_LIVE_PROJECT_INPUT=audio`: synthesize the same request and send PCM through production endpointing and ASR. Transcripts reveal fragmentation or lost constraints. Playback acknowledgements are digital; this is not physical microphone/speaker or GUI acceptance.
- `NOVA_AUDIO_AGENT_CODEX_BIN`: installed Codex path, default `/opt/homebrew/bin/codex` on this macOS harness; the desktop's canonical discovery helper resolves the npm launcher.
- `NOVA_AUDIO_AGENT_CODEX_RESOURCES_PATH`: native resource directory, default `clients/desktop/build`.

Run these variants separately. A text pass does not certify audio, and an executor `started` event does not certify completion. Spoken output is preserved for review; the harness does not pretend to judge every paraphrased false claim with a keyword list.

Regression covered: a natural confirmation must preserve the proposal until structured `confirm` admission. Requirement changes must instead reach intake through structured `dispatch`. Audio endpointing and physical desktop acceptance remain separate checks.

Before project execution, check frontend clarification with `--target text-tools --case coding-clarify-before-dispatch` and `--case coding-clarification-still-unresolved`. These use real multi-turn model conversations: no dispatch before the user answers, one dispatch with the original task and selected user source quotes after clarification, and no dispatch while the user is still deciding. They do not execute tools. The host separately validates quoted user text before coordinator admission; general conversation history is context, not project-selection authority.

### Cascaded clarification and receipt delivery

After building runtime, run `node runtime/scripts/live/cascaded-clarification.mjs` with
`DASHSCOPE_API_KEY` configured. This exercises the real CascadedRealtimeAdapter and Qwen:
ambiguous request → clarification → dispatch → silent receipt → one concrete host question → a failure report without requesting another confirmation or promising a retry.
The script uses synthetic TTS and host facts; it does not prove microphone, workspace creation,
or executor acceptance. Unlike text-tools routing probes, it checks the actual adapter's
response guidance and host-message encoding.

Memory board preserves durable history, folding restored conversation records separately from
this connection. The orb displays “正在安排任务” during coordinator assessment/planning,
then yields to a concrete question, confirmation, or running task. These are state projections,
not additional model-generated acknowledgements.
