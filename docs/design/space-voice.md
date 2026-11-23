# Client Space realtime voice through the Host

Status: design proposal (P9b step 1), revision 2 after review. Nothing here is implemented.

## Goal and scope

A phone in Client Space mode (paired to a Host through the E2EE relay) holds a realtime
voice conversation that runs on the **Host's** voice pipeline: the Host's selected
integrated or cascaded provider, its tools, memory and conversation history. Today Client
Space has text chat only. Dictation is being added separately.

**v1 scope (deliberately small):**
- relay-only transport
- PCM16 audio
- one relay socket pair per call
- any disconnect ends the call and the user sees **Retry**, which runs a fresh handshake
  with fresh keys

Same-key resume, path migration, a direct LAN/Tailscale path and Opus are later phases.
Out of scope: provider execution on the phone (Standalone mode), multi-party calls,
video, and changes to mailbox semantics.

## What the code does today

- **The relay already has a stream channel, but it is not a media channel.**
  `relay/src/live.ts` and `POST /v1/stream` forward short-lived signed envelopes
  (`chan:'stream'`, TTL ≤ 60 s) to the recipient's `/v1/live` WebSocket.
  - Uplink is one HTTPS POST per frame. The live WebSocket accepts only ≤1 KiB JSON
    heartbeats (`maxPayload: 1024`).
  - Each frame is JSON with a base64 JWE body plus a base64 Ed25519 JWS that embeds the
    body again.
  - The relay verifies the signature and checks membership and epoch in SQLite on
    enqueue *and* on dequeue.
  - Requests are limited to 600/min per source and 30 000/min globally. The queue holds
    64 messages / 1 MiB and drops the connection on overflow.
  - `chat.send` and `chat.delta` use this channel today.
- **Relay sessions:** login tokens live **900 s** (`security.ts`). The live socket
  re-authenticates the *upgrade-time* header on every heartbeat, so it dies at token
  expiry and the SDK reconnects.
- **The mailbox** is durable, polled about once per second, and snapshots are cut into
  48 KB chunks. It is unsuitable for audio.
- **Crypto:**
  - There is one 32-byte content key per epoch, shared by the Host and every member,
    delivered wrapped with ECDH-ES+A256KW. Bodies are JWE `dir`/A256GCM.
  - Epochs rotate only on revocation: the Host closes and recreates its `SpaceHost`
    service, and the relay sweeps stale principals.
  - The shared key proves "some member", never "the Host". Sender identity comes only
    from the Ed25519 envelope signature.
  - Flutter records verified newer-epoch evidence (`verifyAndObserve`,
    `observedHostEpoch`) before the new key arrives.
- **The Host voice pipeline:**
  - `conversations.voice {id, enabled, voice_mode}` keeps one `voice_id` per Host.
  - `sendConversationAudio` takes 16 kHz PCM16, and output arrives through
    `onAudioFrame/Clear/Terminal/Alert`.
  - `PlaybackRegistry` frames are `{utterance_id, generation_epoch, sequence, pcm ≤ 64 KiB}`
    at 24 kHz, with sequence contiguous from 0 per generation.
  - `desktop-session.ts` arbitrates one audio owner, `'desktop' | 'phone'`, where
    `'phone'` is the legacy LAN `ClientServer` on `/client/v1`.
  - `sendConversationAudio` and the `onAudioFrame` filter refuse in `background`
    presentation.
  - `playbackDisconnected({resumeDelivery:true})` fences the current generation and
    **unpauses delivery immediately** in its `finally`. It cannot hold delivery for a
    reconnect window.
- **The Space Host service:**
  - `#requireChat(id)` admits only `chat`/`topic` conversations in `chat` mode.
  - Intents are journaled by `(sender, op_id)`.
  - `intentSchema.kind` is a closed `z.enum`, and an unknown kind is **silently dropped**
    (`onError` only, no receipt).
  - Admin kinds are gated by `owner_device`.
- **The headless server** (`server-entry.ts`, `remote: true`) can load a Space Host config
  and builds non-text-only realtime, but its only audio owner is the legacy `ClientServer`.
- **The phone:**
  - `nova_audio` captures mono PCM16 at 16 kHz in ~20 ms (640 B) handoffs.
  - It plays PCM16 at 24 kHz through native `PlaybackLedger`s that require
    `frame.sequence == nextSequence` (contiguous from 0 per utterance), with
    `playback.progress{played_ms}` and `clear(utterance, epoch)` fencing.
  - `OwnedAudioPort` / `AudioOwner` arbitrate the device across voice and dictation.
  - `voice_media.dart` encodes `NOVA` frames.
  - `ClientState._replaceSnapshot` copies only an **allowlist** of snapshot keys.

## 1. Transport options

| | (a) New relay media WebSocket | (b) Direct Host connection + relay fallback | (c1) Existing `/v1/stream` | (c2) WebRTC | (c3) Turn-based voice notes over mailbox |
|---|---|---|---|---|---|
| NAT / mobile | Works everywhere (both ends dial out on 443) | Direct only on the same LAN or tailnet | Works everywhere | Needs TURN behind symmetric NAT or CGNAT (same cost as (a)) | Works everywhere |
| Added latency | One relay hop, ~20–80 ms in region | Lowest | A POST per frame, 100–300 ms on mobile | Low | 2–5 s per turn |
| Relay operator cost | Full call bandwidth, in and out | None when direct | ~5× bandwidth plus per-frame signature and DB work | Full bandwidth via TURN | Small |
| Within limits? | Purpose-built limits | n/a | No: 25+ POST/s against a 10/s source limit | n/a | Yes |
| Attack surface | Authenticated relay route | Listening socket on the Host | None | Large stack, bypasses `nova_audio` AEC | None |

Rejected: phone-to-provider tokens (bypass the Host pipeline, and cascaded providers have
none) and QUIC/WebTransport (immature on Dart and Node).

**Recommendation.**
- **v1 = (a) only:** `/v1/media`, a binary, bidirectional route with one socket pair per
  call. Frames are end-to-end AEAD (§2), so the relay forwards opaque bytes.
- **(b)** is a later phase behind the same frame format.
- **(c1)** is a spike only.
- **(c3)** is a possible later voice-note mode.
- Relay capability or presence hints may only **prevent** a call (hide the button, fail
  early). They never select keys, codecs the caller did not offer, or a destination for
  audio.

### `/v1/media` join and registration (v1)

1. **Principal.** Every media request uses the existing bearer token. The relay derives
   `(space, epoch, device)` from durable security state only, never from request fields.
2. **Reservation.** Only the Space's registered Host (`getSpace(space).host`) may call
   `POST /v1/media/sessions {session, client, ttl}`. `client` must be an active,
   non-revoked device of the same Space and different from the Host.
   - Reservations are keyed `(space, epoch, session)`, so the same session id in two
     Spaces never collides.
   - The relay caps lifetime at `min(ttl, media.maxSessionMinutes)` and sets a 15 s join
     deadline.
   - Pending reservations are bounded per Space (2) and globally.
   - A session id is never reusable: closed reservations are tombstoned until their
     lifetime cap passes.
3. **Join.** The upgrade is `GET /v1/media` with the `X-Nova-Media-Session` header (no
   query string, so the id stays out of access logs). The pre-upgrade limiter
   (`rate(req)`) and forwarded-connection accounting (`reserveForwardedConnection`) apply
   as for `/v1/live`.
   - The role claim is atomic: the Host principal claims `host`, and the reserved client
     device claims `client`. Any other socket is rejected.
   - A half-joined socket (peer absent) counts against a small per-Space and global cap
     and is closed at the join deadline.
4. **No replacement in v1.**
   - A second socket for an already-claimed role is rejected.
   - If either claimed socket closes, the relay closes the peer and tombstones the
     session.
   - Close handlers compare socket identity with the current claim before mutating
     state, so a late close of an old socket can never tear down another session.
5. **Token renewal.** A call may outlive the 900 s token. Before expiry, each endpoint
   sends a text frame `{"type":"renew","token":"…"}` carrying a fresh token from its
   normal login. The relay accepts it only if it maps to the identical
   `(space, epoch, device)` principal, then swaps the stored credential. At expiry
   without renewal the socket closes and the call ends.
6. **Invalidation.** Device revocation (`/v1/devices/revoke`) and the 1 s maintenance
   sweep run `assertActive` on every media socket. Stale-epoch or revoked principals
   close the session at once.

## 2. E2EE framing

The relay must never see plaintext audio. Because the epoch content key is shared, call
keys are bound to the *signed* handshake and mixed with the epoch key.

**Handshake.**
1. The phone sends intent `voice.start`: a signed envelope encrypted with the content key,
   **stream channel only**, with `expires_at ≤ created_at + 15 s` (like `chat.send`). It
   carries `op_id`, `conversation_id`, `voice_mode:"chat"`, an ephemeral X25519 key
   `ephC`, a 32-byte random `nonceC`, `offers {codecs:["pcm16"], frame_ms:[40]}`, and
   `deadline`.
2. Both sides compute
   `startHash = SHA-256(canonical(voice.start ‖ space ‖ epoch ‖ client_device ‖ host_device))`.
   The canonical form is RFC 8785 JCS JSON of the full intent, with the fixed fields
   appended as length-prefixed UTF-8.
3. The Host replies on the signed stream channel with `voice.accept {op_id, startHash,
   session, ephH, selected {codec, frame_ms}, call_deadline}`.
4. The phone verifies, before deriving keys:
   - the Host Ed25519 signature
   - `startHash` against the start it actually sent and has not cancelled
   - that `selected` was offered
   - that the attempt has not expired
5. Either side rejects the call on an all-zero or otherwise invalid X25519 result (checked
   in constant time). A late `voice.accept` for a cancelled or expired attempt is
   ignored, and the Host's reservation times out.

**Key derivation.** `LP(x)` is a 4-byte big-endian length followed by the bytes.

```
ikm   = X25519(eph_priv, eph_peer)
PRK   = HKDF-Extract(salt = content_key[epoch], ikm)
info  = LP("nova-voice/v1") ‖ LP(startHash) ‖ LP(ephC) ‖ LP(ephH) ‖ LP(session)
        ‖ LP(codec) ‖ LP(u16 frame_ms) ‖ LP(direction ∈ {"up","down"})
k_dir = HKDF-Expand(PRK, info, 32)
```

This gives per-call forward secrecy, direction separation, and binding to the epoch, the
exact start and the selected parameters. A former member holding an old content key
learns nothing. `X25519` is in `package:cryptography` (already a dependency) and in Node
`crypto`.

**Frame (binary WebSocket message, both directions):**

```
0      1      2       4                 12                                  end
| ver=1| type | flags | seq (u64 BE)     | AES-256-GCM ciphertext ‖ 16 B tag |
AAD = bytes[0..12)   nonce = 0x00000000 ‖ seq   key = k_up or k_down
```

- Types: 1 audio, 2 control (compact JSON), 3 keepalive (empty plaintext, still sealed).
  `flags` must be 0 in v1.
- The receiver drops any frame with an unknown `ver`, `type` or flag, or a total length
  outside `[28, 4096]`, before decryption.
- Plaintext layouts per type have fixed minimum lengths. A length mismatch after
  decryption is a protocol error.
- **One sender per direction.** The phone owns `up`, the Host owns `down`. A single
  counter allocates `seq` once across all frame types and paths, including frames whose
  send later fails. A seq is never reused. At 2⁴⁸ the call ends.
- **Receive state** is per direction: the highest authenticated `seq` plus a 128-bit
  replay bitmap. It advances **only after** the GCM tag verifies. Duplicates and frames
  older than the window are dropped, and gaps are allowed. More than 8 consecutive
  authentication failures end the call (`voice_crypto_failed`).
- **Volatile versus persisted state:**
  - Ephemeral private keys, `k_up`/`k_down`, counters and windows are **volatile**. They
    live only in memory, are never written to storage, and are zeroed when the call ends.
  - The persisted state is the existing epoch and content-key records only.
  - After an app or Host restart, a crash, an epoch change or any uncertain counter
    state, the call is gone. A new call needs a fresh `voice.start` with fresh
    ephemerals.
- **Epoch rotation mid-call.**
  - The Host fences and ends the call as part of tearing down `SpaceHost`.
  - The relay sweep closes the sockets.
  - Flutter ends the call as soon as it records verified higher-epoch evidence, even
    before the new key arrives.
  - There is no in-call rekey. "Retry" runs a fresh handshake in the new epoch.

## 3. Codec, packetization and receipts

- **v1: PCM16 only.** Uplink is 16 kHz mono (as captured) and downlink 24 kHz mono (as
  rendered), so there is no resampling. Each packet is 40 ms: two capture handoffs, or
  1 280 B up and 1 920 B down, giving 25 packets/s per direction.
- **Opus later** (~10× smaller, CBR to avoid leaking speech activity) via iOS
  `AVAudioConverter`, Android `MediaCodec` (encoder API 29+, otherwise PCM) and a Node
  binding. PCM stays mandatory.

**Downlink identity mapping.** The Host re-chunks each `PlaybackFrame` (up to 64 KiB) into
40 ms media packets.

| Layer | Identity | Scope |
|---|---|---|
| Host generation | `utterance_id`, `generation_epoch` | sent once in a sealed `playback.start` control, mapped to a u16 `gen` handle |
| Sample offset | u32 count of 24 kHz samples since generation start | each audio packet |
| Native frame seq | u32, contiguous from 0 per generation (what `PlaybackLedger` requires) | each audio packet |
| Transport seq | u64 frame counter (§2) | per direction, all types |

The audio plaintext is `gen (u16) ‖ native_seq (u32) ‖ sample_offset (u32) ‖ pcm`. The
phone re-wraps it with the existing `NOVA` encoder (`voiceFrame(identity, native_seq, pcm)`)
before `enqueue`, so native ledgers see exactly the Host's identities.

**v1 loss policy.** The native ledger cannot skip a sequence number. If a downlink audio
packet is missing (gap in `native_seq` for a live `gen`):
1. The phone **fences that utterance**: no further enqueue for `gen`, and the jitter
   buffer and pending enqueues are dropped.
2. It lets the native ledger finish the contiguous prefix already handed over, then
   reports `playback.stopped{utterance_id, generation_epoch, played_ms, reason:"loss"}`,
   where `played_ms` is the last confirmed contiguous prefix from the native ledger.
3. The Host treats this exactly like an interrupted playback receipt and truncates
   history to what was heard.

There is no concealment or splicing in v1. Uplink loss needs no repair: the Host feeds
audio in seq order and endpointing tolerates gaps.

**Receipts (phone → Host, control frames)** carry `utterance_id`, `generation_epoch` and
`played_ms` from the native render ledger, never enqueue time:
- `playback.started`
- `playback.progress` (≤ 10/s)
- `playback.done`
- `playback.stopped{reason}`
- `playback.cleared`

**Bandwidth.** Per-packet overhead is the 12 B header, 16 B tag and WS/TLS framing,
about 60 B, or ~12 kbps per direction at 25 packets/s.

| Mode | Up | Down (realtime) | Down (paced burst ≤1.25×) | Per hour, each relay leg |
|---|---|---|---|---|
| PCM16 v1 | ~268 kbps | ~396 kbps | ~495 kbps | ~300 MB in + ~300 MB out |
| Opus (later) | ~36 kbps | ~44 kbps | ~55 kbps | ~36 MB each way |
| PCM over `/v1/stream` | ~5× PCM | ~5× PCM | — | ~1.4 GB, 50 POST/s |

Providers generate faster than realtime. The Host paces downlink to **≤ 1.25× realtime**
with ≤ 1 s lead: 480 kbps of PCM payload, ~495 kbps on the wire, ~32 packets/s. This
stays under the default relay caps in §6. (The earlier 1.5× figure would have needed
576 kbps of payload, above the old 420 kbps cap.)

## 4. Session lifecycle and authorization

| Message | Path | Content |
|---|---|---|
| `voice.start` | phone → Host intent, stream only, ≤ 15 s deadline, idempotent by `(sender, op_id)` | §2 fields |
| `voice.accept` / `voice.reject{code}` | Host → phone, signed stream + journal receipt | §2. Codes include `voice_disabled`, `owner_required`, `owner_unassigned`, `conversation_read_only`, `voice_active`, `voice_unavailable`, `relay_media_unavailable` |
| `ready` | first sealed control frame, each direction | `{startHash}`, proves both keys |
| `voice.stop` | phone → Host intent, or a sealed in-band control `end` | `op_id` of the start |
| `voice.ended{reason}` | Host → phone, sealed control, plus signed stream best-effort | `stopped`, `epoch_rotated`, `revoked`, `idle`, `max_duration`, `taken_over`, `policy_changed`, `provider_failed`, `transport_lost`, `loss` |

`voice.end` and `voice.ended` are **best-effort**. Correctness rests on leases, deadlines
and relay teardown, never on the goodbye arriving.

**Authorization, evaluated in order before any `conversations.voice` call:**
1. The sender is a current member (existing check).
2. Space voice policy `off | owner | members` (Host setting, default `owner`):
   - `off` rejects everyone.
   - `owner` admits only `owner_device`. With no owner assigned (for example after the
     owner was revoked), it rejects everyone with `owner_unassigned`.
   - `members` admits every current member.
3. `#requireChat(conversation_id)`, the same rule as `chat.send`.
4. `voice_mode` is constrained to the authorized chat mode (`"chat"`). Anything else is
   rejected and never passed through.
5. Tool approvals raised during the call go through the same authorized decision surface
   as text chat. A spoken "yes" never approves.

**Start sequence (Host):**
1. Journal and dedupe by `(sender, op_id)`. A replayed start returns the same receipt and
   never a second call.
2. **Reserve the slot** in a single audio-owner arbiter shared by the desktop renderer,
   the legacy LAN phone and Space calls. Owners become `desktop | lan_phone |
   space:<device>`.
   - Each claim gets a monotonically increasing **lease id**.
   - Start, takeover, stop and cleanup are serialized in the arbiter.
   - Stop and cleanup must present the lease id, so a stale stop can never release a
     newer call.
   - A device's second start replaces only its own call. The local desktop user always
     takes over (`taken_over`).
3. Register the relay reservation and send `voice.accept`.
4. Wait for both sockets and an authenticated `ready` from the phone (15 s). **Only then**
   call `conversations.voice {id, enabled:true, voice_mode:"chat"}` and begin provider
   work.
5. Mark the call active. Playback is permitted in `background` presentation **only for
   frames whose conversation is the call's conversation**, through the owner bridge. All
   other background suppression stays.

**Teardown (timeout, revoke, close, policy change, takeover, stop).** **Fence first, then
clean up:**
1. Bump the lease so in-flight work is stale.
2. Stop accepting uplink and stop emitting downlink.
3. Clear the current generation.
4. Then stop the provider (`conversations.voice enabled:false`, only if this lease still
   holds it), release the owner, close the relay session and zero the keys.

A policy change re-evaluates every active call. Idle detection: no authenticated frame
from the peer for 20 s ends the call.

**Headless server.** v1 serves Space voice on the desktop Host only. The headless server
does not advertise `voice.v1` until its composition registers the shared owner arbiter
(Phase 5). Its legacy `ClientServer` phone stays as is.

## 5. Barge-in, latency and jitter

- **Barge-in is Host-authoritative.**
  - Endpointing detects speech, the service fences the generation, and a `playback.clear`
    control frame is sent.
  - A clear **cannot overtake bytes already written** to the socket. Its lag is bounded
    by keeping the Host's per-call app queue at ≤ 200 ms and the relay queue at ≤ 16
    frames.
  - The phone fences the generation across **all three stages**: the jitter buffer,
    pending `enqueue` calls, and the native ledger (`clear(utterance, epoch)`). Frames for
    a fenced `gen` that arrive later are dropped.
  - The phone then sends `playback.cleared{played_ms}`.
  - Optional later improvement: local ducking when capture level crosses the threshold.
    The phone never clears on its own.
- **No hold-on-disconnect in v1.** A disconnect ends the call (§7), so
  `playbackDisconnected({resumeDelivery:true})` is not used as a hold. If same-key resume
  is added later, it must:
  1. pause delivery explicitly
  2. discard stale input and output
  3. resume only after an *authenticated* replacement socket sends `ready`
- **AEC.** Native relay mode with platform voice processing. This is a
  **physical-device acceptance item**: simulators prove nothing.
- **Latency targets (same region, relay):**
  - added mouth-to-Host ≤ 150 ms p50, ≤ 300 ms p95
  - speech end to first audible reply ≤ 1.5 s p50 (otherwise provider-bound)
  - clear to silence ≤ 250 ms p95, **measured** from the Host fence timestamp to the
    `playback.cleared` render-ledger time, with clock offset taken from `ready`/keepalive
    RTT
- **Jitter.**
  - Downlink: an adaptive buffer before `enqueue`, starting at 80 ms (range 60–200 ms),
    growing on underrun and shrinking slowly. An underrun waits and never skips
    `native_seq`; a true gap triggers the §3 loss policy.
  - Uplink: no playout buffer; a 60 ms reorder window, then in-order feed.

**Flutter shape.** A small `SpaceCallController` owns the call. It is **not** a
`VoiceProvider` adapter around `PhoneVoiceSession`, whose turn and response model would
lose Host playback identities. It:
- acquires the device through `OwnedAudioPort` / `AudioOwner` (so it competes cleanly
  with dictation and Standalone voice)
- starts native relay mode with capture on
- re-wraps downlink audio with the existing `NOVA` encoder, preserving Host identities
- maps native `playback.progress` and stopped events to receipts

Platform cases:
- **Audio focus loss** (phone call, other app) ends the call.
- **App suspension** ends it unless the existing companion/PiP background path is active.
- **Mute** stops uplink frames and keeps the call alive with keepalives.
- **Teardown** releases the owner before closing the socket.
- **Dictation** cannot start during a call, and a call cannot start during dictation:
  `AudioOwner` decides.

## 6. Relay limits and abuse protection

Media is **disabled by default**. It costs the operator real bandwidth, so self-hosters
opt in.

| Option | Default when enabled | Notes |
|---|---|---|
| `media.enabled` | `false` | route 404 |
| `media.maxKbpsPerDirection` | 512 | token bucket with 1 s burst. Fits PCM downlink at 1.25× pacing (~495 kbps) |
| `media.maxFramesPerSecond` | 40 per direction | covers 32 paced audio packets + control + keepalive |
| `media.maxFrameBytes` | 4096 | enforced by `ws` `maxPayload` **during assembly**, not after |
| `media.queueFrames` / `media.queueBytes` | 16 / 64 KiB per direction | bounded app-level queue, not `bufferedAmount` |
| `media.controlQueueFrames` | 8 | control frames jump audio inside the queue only, charge the same budgets, and cannot bypass caps |
| `media.blockedPeerMs` | 2000 | a peer whose queue stays full this long is disconnected and the call ends |
| `media.maxSessionsPerSpace` / global | 1 / 64 | |
| `media.maxPendingReservations` | 2 per Space, 128 global | |
| `media.maxHalfJoined` | 2 per Space, 128 global | 15 s join deadline |
| `media.maxSessionMinutes` | 60 | server-side cap regardless of the requested TTL |
| `media.idleTimeoutSeconds` | 20 | endpoints send sealed keepalives every 5 s |
| `media.monthlyBytesPerSpace` | unset | optional quota |

- **Accounting.** Every inbound frame is charged against the byte and frame buckets
  *before* it is forwarded or dropped, so dropping is not free for an abuser. Sustained
  over-limit traffic (more than 3 s) closes the socket. Frames do not consume
  `requestsPerMinute`; reservations, upgrades and renewals do.
- Media sockets count toward `maxConnections`, `maxConnectionsPerIp` and the trusted-proxy
  per-source budget.
- **Timers.** The endpoint keepalive is 5 s, the relay idle timeout 20 s, the Host
  media-idle timeout 20 s, and WebSocket ping 10 s (as in live). Reverse proxies must
  allow upgrades on `/v1/media` and keep idle timeouts ≥ 60 s.
- **Metadata the relay learns:**
  - Space id, both device ids, IP addresses
  - call start, end and duration
  - byte and packet counts and timing (PCM is constant-rate, so speech activity is not
    revealed; any later Opus must be CBR)
  - renewal times

  It never sees audio, transcripts, conversation ids or keys. Logs contain neither the
  session header nor tokens; only a hashed session id and counters are recorded.
- `GET /v1/capabilities` (static) advertises `{media:{v:1, codecs:["pcm16"],
  maxKbpsPerDirection}}`. It is a hint only (§1).

## 7. Failure handling and fallback

- **Any disconnect, crypto failure, loss fence that ends the call, token expiry without
  renewal, epoch evidence, revoke or takeover** ends the call. The phone shows the reason
  and a **Retry** button. Retry is a fresh `voice.start` with new ephemerals. There is no
  silent auto-reconnect, no same-key socket replacement and no path migration in v1.
- **Cannot start** (old Host, reject, relay without media, no `voice.accept` within the
  15 s deadline, microphone denied): show the reason. The **typed composer stays
  available**. Dictation is offered as a separate button, and switching to it takes a
  fresh user action, because it needs its own ASR configuration and microphone access.
  Voice never auto-starts dictation.
- **Host offline** (presence false): the call button is disabled.

**Capability and fallback matrix**

| Phone | Host | Relay | Result |
|---|---|---|---|
| old | any | any | no voice UI. Old phones never send `voice.*` |
| new | old (no `host_capabilities`) | any | call hidden, composer and dictation as before |
| new | new, voice not allowed for this device | any | call hidden (capability is per caller) |
| new | new | old (no `/v1/media`) | Host omits `voice.v1`, call hidden |
| new | new | media enabled, PCM admitted | call shown. The per-call check still runs |
| new | stale positive capability (Host or relay changed) | — | start rejected or times out. Show reason, keep composer, refresh capability |
| new, mic denied | new | ok | call fails locally before `voice.start`, permission hint shown |

## 8. Protocol and versioning impact

- Add `host_capabilities` to `DisplaySnapshot` (additive; old phones ignore it). It
  contains `voice.v1` **only when** this Host can serve *this* recipient: the policy
  admits the device, the Host is a desktop Host with the owner arbiter, and the relay
  advertises media with PCM within the caps. Snapshots are already per recipient
  (`snapshot(to)`).
- The new phone **must add `host_capabilities` to the `_replaceSnapshot` allowlist**,
  otherwise it is stripped. Cached availability expires on any change of Host device,
  epoch or relay URL.
- The per-call check stays authoritative: the capability only shows or hides the button.
- An old Host silently drops `voice.start` (closed `intentSchema`), which is why the phone
  never sends it without `voice.v1`. The start deadline is the backstop.
- There is no change to `business_versions`, mailbox or stream semantics, or existing
  envelopes. The media frame has its own `ver` byte.
- AGENTS.md hygiene: no endpoints, domains or tenant data in defaults or docs.

## 9. Test plan

**Relay (`relay/test`)** (kernel plus real loopback WebSocket):
- reservation only by the registered Host, for a distinct active device
- atomic role claims, third socket rejected, replacement socket rejected
- late close of an old socket is harmless
- the same session id in two Spaces stays independent
- a tombstoned id cannot be reused
- join deadline and half-joined caps
- token-expiry boundary: a call survives with renewal and closes at 900 s without it;
  renewal with a different principal is rejected
- revoke during a renewal or join closes the session
- a stale epoch is swept within 1 s
- `maxPayload` rejects during assembly
- byte and frame buckets charge before drop
- queue and control-queue bounds, and a blocked peer is disconnected
- `media.enabled=false` gives 404
- the session header never appears in logs

**Frame crypto: cross-language vectors** (a JSON fixture shared by the TS and Dart tests):
- canonical `startHash`
- X25519 → HKDF → `k_up`/`k_down`
- sealed frames for each type
- negative cases: tampered header or ciphertext, nonzero flag, unknown type,
  short/long length, replay inside and outside the window, wrong-direction key,
  all-zero DH, an accept with an unoffered codec, a mismatched `startHash`, an expired
  attempt
- receive state unchanged after an authentication failure
- a former-member content key cannot derive keys

**Host voice session (`runtime`)** with a fake provider and a fake media socket:
- authorization order: policy `off`, `owner`, owner unassigned and `members`;
  `#requireChat`; `voice_mode` constraint
- idempotent start by `(sender, op_id)`
- no provider work before `ready`
- lease fencing: a stale stop cannot release a newer call, and the desktop takes over
- uplink reaches `sendConversationAudio`
- downlink re-chunking keeps `native_seq` contiguous, and pacing stays ≤ 1.25×
- clear is sent ahead of queued (not yet written) audio
- `playback.stopped{loss}` truncates at `played_ms`
- revoke, policy change and idle all fence before cleanup
- background playback only for the call's conversation
- an old-schema Host drops `voice.start`

**Flutter:**
- `SpaceCallController` unit tests with a fake `AudioPort` and transport: `NOVA` re-wrap
  preserves identities; fencing covers the jitter buffer, pending enqueues and native
  clear; a gap triggers the loss fence and report; mute; focus loss; suspension;
  teardown order; dictation competition through `AudioOwner`; higher-epoch evidence
  ends the call before the key arrives
- `SpaceVoicePanel` widget tests: hidden without `voice.v1`; connecting → active →
  ended → Retry; reasons; the composer stays usable; microphone denied
- capability tests: old phone/new Host, new phone/old Host, old relay, stale positive
  capability, the allowlist keeps `host_capabilities`

**End-to-end acceptance** (real relay, real devices):
1. Two phones start the same conversation: exactly one call becomes active and the other
   gets `voice_active`. There are no crossed sockets.
2. Revocation of a phone during Host playback: playback stops within 1 s on every
   device, the revoked device's sockets close, and the survivor gets `epoch_rotated` and
   can Retry after the new key.
3. A missing downlink packet just before terminal: the phone fences, reports the
   contiguous `played_ms`, and Host history ends at the heard prefix.

**Also:** AEC/speakerphone barge-in and clear-to-silence measured on physical iOS and
Android devices over cellular.

## 10. Phased plan

| Phase | Content | Rough effort |
|---|---|---|
| 0 | Spike: cellular RTT and jitter to a self-hosted relay. Confirm the owner-arbiter refactor scope. Settle open decisions | 2 days |
| 1 | Relay `/v1/media`: reservations, role claims, renewal, sweep, all §6 limits, capabilities, CLI/README config, tests | 6–8 days |
| 2 | Shared frame crypto (TS and Dart) with cross-language vectors | 3–4 days |
| 3 | Host: `voice.*` intents, authorization, shared lease-based owner arbiter (desktop / LAN phone / Space), `SpaceVoiceBridge`, re-chunking, pacing, receipts, scoped background playback, snapshot capability, tests | 8–11 days |
| 4 | Flutter: `SpaceCallController`, panel, allowlist and capability expiry, dictation fallback UX, tests. Physical-device AEC and acceptance runs | 7–10 days |
| 5 | Headless-server owner arbiter, so the headless server can advertise voice | 2–3 days |
| 6 | Opus (CBR) negotiation and lower default caps | 5–8 days |
| 7 | Same-key resume (explicit pause, authenticated replacement), then the direct LAN/Tailscale path with signed candidates and a pinned certificate | 8–12 days |

Phases 0–4 give a usable relay-only PCM call in about 5–7 weeks. Phases 5–7 are
optional follow-ups.

## Decisions (approved 2026-11-22)

1. **Default voice policy is `owner`.** A Space with no assigned owner cannot start voice
   (`owner_unassigned`).
2. **Relay media is off by default.** v1 ships no monthly per-Space byte quota; operators
   rely on the per-call caps and bandwidth limits in §6. A quota is later work.
3. **Opus is not a gate** for enabling media. The relay README warns operators of shared
   relays about PCM bandwidth (about 300 MB per hour per relay leg).
4. **Desktop takes over.** When the local desktop user starts voice during a phone call,
   the phone call ends with `taken_over`.
5. **Background playback is allowed** while the Host window is backgrounded, limited to the
   call's conversation.
6. **Headless server voice is deferred** to Phase 5; it is not in v1.
7. **Direct path and Host listening socket are deferred** to Phase 7. v1 and the near term
   are relay-only; the decision is revisited at Phase 7.
