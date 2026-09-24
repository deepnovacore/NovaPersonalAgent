# Nova private client protocol v1

Remote endpoint: `/client/v1`, WSS via Tailscale Serve. Local mock/simulator may use WS on loopback. This endpoint never exposes camera or debug-board requests. Desktop `/` remains a separate legacy endpoint.

The first frame is text, within 3 seconds:

```json
{"type":"hello","token":"0123456789abcdef0123456789abcdef","protocol_version":1}
```

Token is 128 random bits, lowercase hex, provisioned locally and stored in iOS Keychain. The example is for the mock only. Do not put credentials in a URL. Authentication precedes any state or audio. Failure closes 4003; unsupported protocol version closes 4006; unsupported path closes 4004; a concurrent client closes 4009.

Authenticated response (IDs below are examples):

```json
{"type":"client.ready","protocol_version":1,"server_instance_id":"server-uuid","connection_id":"connection-uuid","input_audio":{"encoding":"pcm_s16le","sample_rate":16000,"channels":1},"output_audio":{"encoding":"pcm_s16le","sample_rate":24000,"channels":1},"capabilities":["audio","captions","projects","executor"]}
```

These formats match the existing desktop/Qwen pipeline: input 16 kHz, output 24 kHz, mono signed PCM16 little endian. iOS must resample device input, which is often 48 kHz. Unsupported formats must be refused, not silently played at the wrong speed. No compressed audio negotiation in v1.

## Media

Uplink binary frames: 1–65536 bytes, even length, raw PCM16. Downlink: existing `desktop-wire.ts` NOVA framing: four ASCII magic bytes, a two-byte big-endian JSON header length (maximum 2048), header UTF-8 bytes, then PCM16. Header fields: `utterance_id`, `generation_epoch` (positive safe integer), `sequence` (nonnegative safe integer). Never parse a length before checking available bytes. Decode non-ASCII identifiers and reject unrepresentable integers rather than rounding.


Downlink text uses the existing `caption`, `playback.clear`, `playback.alert`, `playback.terminal`, `project.state`, `executor.state`, `executor.progress`, `executor.result`, `executor.results.reset`, `executor.approval`, and `clock.ping` payloads. Their authoritative encoders are `desktop-wire.ts`, `desktop-progress.ts`, and `desktop-session.ts`. Client must not treat terminal as proof that audio already played.

## Controls and receipts

Wrap existing selected desktop controls:

```json
{"type":"client.command","request_id":"request-uuid","connection_id":"connection-uuid","payload":{"type":"project.confirmation_decision","proposal_id":"proposal-1","confirmed":true}}
```

Allowed payloads are the existing desktop control schema: `speech.onset`, `playback.started/stopped/done/cleared`, project/approval decisions, clock pong and diagnostics/telemetry. Camera and arbitrary tool execution are rejected. The optional `scope: "session"` on an affirmative executor decision is valid only when the current host approval offers it; the UI must follow `allowed_decisions`.

```json
{"type":"client.command_result","request_id":"request-uuid","status":"applied"}
```

`applied` is a delivery receipt from the host callback, **not** proof that a proposal was accepted or a task executed. Host state events decide that. `rejected` means conflicting retry, capacity, or callback failure; `stale` means wrong connection ID. Each connection remembers at most 256 controls, including failed ones. Same ID + same normalized payload returns the original receipt; changed payload cannot redeliver. At capacity the server closes 4008 after the receipt and the client reconnects for a fresh snapshot. Controls are serialized; never automatically retry approvals across a connection boundary.

Text controls are limited to 16 KiB; numbers must be finite, integers safe in JS. Input buffering is bounded at 256 KiB / 128 pending messages and output at 256 KiB / 128 pending sends. Exceeding limits retires the current connection. This does not stop the Runtime graph. No audio backlog replay after reconnect.

On disconnect clear local audio and actionable approval UI. New ready means use its connection ID. Same server instance restores in-memory project/work/result state; a different instance means a restarted service, not transparent task recovery. A client ending the call disconnects; it does not cancel a Codex task.

## Media selection (backward-compatible v1 extension)

New clients include `media: {transports: ["host_pcm_v1"]}` in `hello`.

`hello` may also include `language: "zh-CN" | "en"`. The host validates this enum after authentication and before accepting input. It selects translated AI system instructions for this connection, including task narration; it does not translate user messages, force a response language, or change ASR/TTS models or voices. Omitting it restores the host's configured default (`PROMPT_LANGUAGE`, otherwise `zh-CN`), rather than inheriting the previous client's choice. Unsupported values reject the connection. Relay and both AOQ modes support the field; older hosts may ignore it. Clients reconnect to apply a changed language.

The authenticated host selects its configured pipeline and returns in `client.ready`:

```json
{"media":{"transport":"host_pcm_v1","path":"relay","audio_owner":"client","pipeline":"integrated"}}
```

`pipeline` is `integrated` or `cascaded`, derived from the same validated settings used to construct the production provider. It is independent of the media path. Qwen integrated and the supported Volcengine cascaded configuration use the same transport, approval UI, connection identity and PCM formats. No provider credentials, URLs, raw events or SDK objects cross this contract.

An omitted offer means the original v1 relay. An explicit offer must contain 1–8 bounded transport names and include `host_pcm_v1`; otherwise the server closes with 4006 **before** Runtime admission. A client offering both AOQ and relay receives an explicit relay selection; AOQ-only is rejected. Unknown fields in the offer are rejected. New iOS clients accept old hosts without `media`, but reject any explicit unsupported path, owner, pipeline or malformed descriptor before microphone activation. There is one media path per connection; switching requires disconnect/reconnect. `connection_id` and existing playback/provider generations retain their distinct ownership; this extension does not fabricate a provider session identity in `client.ready`.

Direct mode and provider-control messages are deliberately not enabled: accepting raw provider events as `client.command` or returning an AOQ token would not preserve the existing authorization/playback contracts.

Unconfigured/test transports omit `media` rather than invent a production pipeline. Configured descriptors are strictly validated and copied before the listener is allocated; extra fields (including credentials) are rejected.

## QR pairing v1

All media modes share pairing; the existing `hello` and media protocol are unchanged.

- QR payload: `{type:"nova.pair",version:1,server:"wss://host/client/v1",code:<32 lowercase hex>}`. WSS only; reject userinfo/query/fragment and unrelated paths. The client shows the destination before exchange. New invitations omit `expires_at`; updated clients still validate it when scanning an older server invitation.
- `/client/pair`: send one text frame `{type:"pair.redeem",code,device_name}`. Success: `{type:"pair.ready",token,device_id}`; failure: `{type:"pair.error",message}`. A socket closes after one response. No microphone, model allocation or host controls are admitted here.
- `/client/pair-admin`: one text request authenticated with the master `token`. `pair.create` takes `server` and returns the QR payload; `pair.list` returns `{type:"pair.devices",devices:[{id,name,created_at}],pairing_active}`. Optional `code` checks whether that specific invitation remains active. `pair.revoke` takes `device_id`; `pair.cancel` takes `code`; both return the current device list. A device token cannot call these operations.
- One active 128-bit random invitation per process, without time-based expiry, consumed synchronously after durable device registration. New invitations replace old ones. Up to 8 concurrent pairing/management sockets, 4096-byte requests, five-second socket lifetime, 60 redemption attempts/minute per host and 32 registered devices.
- Each successful exchange issues a distinct 128-bit device token. The private store persists only token hashes and is bound to the master token. Relay and both AOQ modes accept these in their normal `hello`. Revoking a device persists the removal before closing its active sockets with 4003.
- Pairing requests/credentials must not be logged, placed in URL parameters or automatically retried. If delivery or local Keychain persistence fails, regenerate an invitation and remove the orphan device entry. Network reachability/TLS remains a prerequisite.


### Editable input in cascaded mode

A cascaded host advertises `text_input` and `dictation` in `client.ready.capabilities`. These payloads use the existing `client.command`, bound to `connection_id` and `request_id`, with deduplicated receipts:

- `input.text`: `text` is non-empty user input, at most 4000 UTF-16 code units.
- `input.dictation`: `id` identifies the draft; `action` is start/finish/cancel. After start, binary PCM goes only to a bounded draft buffer (16 kHz PCM16, up to 60 seconds). Finish calls the configured cascaded ASR with a 30-second timeout; cancel or disconnection cancels recognition.
- `input.audio`: exits draft mode and explicitly resumes continuous voice. Late draft audio does not automatically enter the model.

Recognition returns `input.transcription` with the matching `id` and `text`, or only `error: recognition_failed` on failure. A draft is not a user turn and does not trigger an LLM or tools. The client must explicitly submit the edited `input.text`.

## Conversation presentation

The iOS UI starts in realtime mode. It offers text chat only when the host selects
cascaded media and advertises both `text_input` and `dictation`; losing that
capability returns the UI to realtime. Switching the UI mode does not reconfigure
the host pipeline. Entering text mode suspends live audio; leaving it cancels the
in-progress dictation while preserving the editable text draft.

The Swift client accumulates captions as an in-memory conversation list,
using `message_id` / final text to update a message rather than rendering each
partial caption as a new reply. This is client presentation, not a remote history
pagination API or a guarantee of persistence across app restart. Desktop memory
history pagination uses its separate local host interface. Approval decisions
continue through the existing connection-bound command contract.
