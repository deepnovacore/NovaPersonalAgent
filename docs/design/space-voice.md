# Client Space realtime voice through the Host

Status: design proposal (P9b step 1). Nothing here is implemented yet.

## Goal and scope

A phone in Client Space mode (paired to a desktop Host through the E2EE relay) holds a
realtime voice conversation that runs on the **Host's** voice pipeline: the Host's
selected integrated or cascaded provider, its tools, memory and conversation history.
Today Client Space offers text chat only. Dictation is being added separately and is the
fallback for this feature.

Out of scope: running providers on the phone (that is Standalone mode), multi-party calls,
video, and changing the relay's mailbox semantics.

## What the code does today (constraints this design starts from)

- **The relay already has a "stream" channel, but it is not a media channel.**
  `relay/src/live.ts` (`LiveRelay`) and `POST /v1/stream` forward short-lived signed
  envelopes (`chan: 'stream'`, `expiresAt` ≤ 60 s) to a recipient's `/v1/live` WebSocket.
  Uplink is **one HTTPS POST per frame** (the WebSocket accepts only 1 KiB JSON heartbeats
  from devices, `maxPayload: 1024`). Every frame is JSON with a base64 JWE body plus a
  base64 Ed25519 JWS that embeds the body a second time. The relay verifies the signature
  and runs SQLite membership/epoch lookups on enqueue *and* again on dequeue. Requests are
  limited to 600/min per source and 30 000/min globally. The per-recipient queue is
  64 messages / 1 MiB, and the connection is dropped on overflow. Chat deltas
  (`chat.delta`) and `chat.send` already use this path.
- **The mailbox** is durable, polled about once per second, and snapshots are cut into
  48 KB chunks (`space-host/service.ts`). It is unsuitable for audio.
- **Crypto.** There is one 32-byte content key per epoch, shared by the Host and all
  members. It is delivered to each device wrapped with ECDH-ES+A256KW
  (`relay/src/crypto.ts`, `space-host/config.ts`, `clients/flutter/lib/space/space_crypto.dart`).
  Bodies are JWE `dir`/A256GCM with random nonces. Epochs rotate **only on device
  revocation**: the Host closes and recreates its `SpaceHost` service, and the relay
  rejects stale-epoch principals (`assertActive`) and sweeps their live sockets.
  Because the content key is shared, it proves only "some member", never "the Host".
  Sender identity comes from the per-envelope Ed25519 signature.
- **The Host voice pipeline.** `conversations.voice {id, enabled, voice_mode}` on
  `PersonalAgentHost` binds a single `voice_id` per Host (`voice_active` if another
  conversation holds it). `sendConversationAudio(id, pcm)` feeds 16 kHz PCM16. Output
  leaves through `onAudioFrame` / `onAudioClear` / `onAudioTerminal` / `onAudioAlert`
  as `PlaybackFrame {utterance_id, generation_epoch, sequence, pcm}` at 24 kHz. Playback
  truthfulness depends on renderer delivery reports. `desktop-session.ts` arbitrates one
  audio owner, `'desktop' | 'phone'`. Here 'phone' is the legacy LAN `ClientServer`
  (`/client/v1`, `NOVA` binary frames, macOS-only `phone.start`).
- **The phone audio stack** (`packages/nova_audio`) captures mono PCM16 LE at 16 kHz,
  handed off in ~20 ms (640-byte) packets with one in-flight handoff. It plays mono
  PCM16 at 24 kHz with a render ledger (`playback.progress` with `played_ms`), a 50 s
  outstanding cap, and `clear(utterance, epoch)` fencing. Platform AEC runs in relay
  mode. Standalone voice is `PhoneVoiceSession` over the `VoiceProvider` interface.
- **Versioning.** The Host's `intentSchema.kind` is a closed `z.enum`. An unknown kind
  fails `safeParse` and is **silently dropped** (only `onError`), so an old Host never
  answers a `voice.start`. The relay negotiates only `business_versions: [1]`.

## 1. Transport options

| | (a) New relay media WebSocket | (b) Direct Host connection + relay fallback | (c1) Existing `/v1/stream` | (c2) WebRTC (ICE/TURN) | (c3) Turn-based voice notes over mailbox |
|---|---|---|---|---|---|
| NAT / mobile | Works everywhere (both ends dial out over 443) | Direct works on the same LAN or a shared Tailscale/VPN tailnet. Never across carrier NAT without a VPN | Works everywhere | Best traversal, but symmetric NAT and CGNAT need TURN (same cost as (a)) | Works everywhere |
| Latency added | ~1 relay hop, ~20–80 ms in region | Lowest on LAN (<10 ms) | One HTTPS POST per frame. 100–300 ms on mobile, head-of-line blocking | Low | 2–5 s per turn, not realtime |
| Relay operator cost | Full call bandwidth, in + out | Zero when direct | ~5× call bandwidth plus per-frame signature and SQLite work | TURN = full bandwidth | Small |
| Fits the limits? | New, purpose-built limits | n/a | No: 25–50 POST/s exceeds the 10/s source limit. The 64-message queue drops the connection | n/a | Yes |
| New attack surface | Relay route (authenticated) | A listening socket on the Host | None | Large dependency, DTLS/ICE stack | None |
| Effort | Medium | Medium-high (discovery, cert pinning, path switching) | Low for a prototype only | High (flutter_webrtc plus a Node WebRTC stack, and it bypasses nova_audio AEC) | Low |

**Rejected outright:** phone-to-provider direct (ephemeral provider tokens). It bypasses
the Host pipeline, its tools and memory, and cascaded providers have no such tokens.
QUIC/WebTransport is not mature on Dart or Node today.

**Recommendation:** build **(a) first**: a new authenticated, binary, bidirectional,
session-scoped relay route `/v1/media`. Its frames are end-to-end AEAD (section 2), so the
relay forwards opaque bytes and verifies nothing per frame. Add **(b) next** as an
optimization behind the same frame format: the Host advertises direct candidates in its
signed `voice.accept`, the phone tries direct for ≤1.5 s, and the relay stays the fallback.
The frame layer is transport-agnostic, so switching paths mid-call is a reconnect with the
same session keys and sequence spaces. Keep (c3) as a possible later "voice note" mode.
(c1) is useful only as a throwaway spike.

### `/v1/media` shape

- `GET /v1/media?session=<128-bit random id>` upgrades with `Authorization: Bearer`
  (the existing session token). The relay checks `assertActive`, that the session's two
  parties are this device and the space's Host (star topology, like
  `host_route_required`), and the per-space concurrency limit.
- **Session registration** has no relay-side business knowledge. The Host registers
  `{session, client_device, expires}` by an authenticated `POST /v1/media/sessions`.
  The relay pairs the first Host socket and the first Client socket of that session and
  refuses any third socket. Sessions expire when idle or at the max duration.
- Frames are binary WebSocket messages forwarded verbatim to the peer socket, size-capped
  (≤ 4 KiB). The relay keeps a bounded send queue per direction. When `bufferedAmount`
  exceeds ~250 ms of the cap, it **drops the oldest audio frames** (realtime, latest-wins)
  instead of closing. Control frames (type bit) are never dropped before audio.
- The membership sweep (`live.sweep()` already runs each second) also terminates media
  sockets whose principal became stale or revoked.

## 2. E2EE framing

The relay must never see plaintext audio. The shared epoch content key alone cannot
authenticate the Host, so the design binds per-session keys to the signed handshake and to
the epoch key:

1. The phone sends intent `voice.start` (a signed, content-key-encrypted envelope, as
   today) carrying an ephemeral X25519 public key `ephC`, `conversation_id`, codec offers
   and a client nonce. It travels on `chan: 'stream'` with a short TTL, like `chat.send`.
2. The Host replies on the signed stream channel with `voice.accept {session, ephH,
   codec, frame_ms, direct_candidates?, expires_at}`. The Host Ed25519 signature on the
   envelope authenticates `ephH`.
3. Both sides derive
   `PRK = HKDF-SHA256(salt = content_key[epoch], IKM = X25519(ephC, ephH))` and
   `k_up / k_down = HKDF-Expand(PRK, "nova-voice/v1|" + space + "|" + epoch + "|" + session + "|" + client_device + "|up" / "|down", 32)`.
   This gives forward secrecy per call, sender authentication by direction, and an
   explicit binding to the epoch. A former member holding an old content key learns
   nothing. `X25519` is in `package:cryptography` (already a dependency) and in Node
   `crypto`.

**Frame (binary, both directions):**

```
0      1      2      4                12                    end
| ver=1| type | flags| seq (u64 BE)    | AES-256-GCM(ciphertext ‖ 16-byte tag) |
AAD = bytes[0..12)        nonce = 0x00000000 ‖ seq (12 bytes, per-direction key)
```

- `type`: 1 audio, 2 control (JSON inside), 3 keepalive (empty plaintext, still sealed).
- The audio plaintext carries `media_ts` (u32 sample index), and on downlink the
  `utterance_id` / `generation_epoch` / `sequence` of the `PlaybackFrame`, compactly
  encoded, followed by codec payload. Control plaintext carries `playback.clear`,
  `playback.terminal`, `playback.alert`, captions, `playback.progress` (phone → Host),
  `voice.mute` and `voice.end`.
- **Nonce and sequence.** `seq` starts at 0 per direction and increments per frame. It
  never repeats because keys are per session and per direction. If `seq` reaches 2⁴⁸
  the session ends (unreachable in practice).
- **Replay protection.** The receiver keeps a 128-frame sliding window (SRTP/DTLS
  style). It rejects duplicates and frames older than the window, and accepts gaps.
  Any AEAD failure drops the frame. More than 8 consecutive failures end the session
  (`voice_crypto_failed`).
- **Epoch rotation mid-call.** Rotation happens only on revocation, and the Host
  already tears down its `SpaceHost` service then. The voice session ends: the Host
  stops the pipeline, sends a sealed `voice.end{reason:"epoch_rotated"}` best-effort,
  and the relay sweep closes stale sockets. After the phone installs the new
  Host-signed key it may offer "Resume call", which is a fresh `voice.start` in the new
  epoch. There is no in-call rekey. That would add complexity for an event that is
  rare and security-motivated. A revoked device's session is killed immediately.

## 3. Codec and frame size

- **PCM16 first** (no new native code). Uplink is 16 kHz mono as captured. Downlink is
  24 kHz mono as nova_audio renders, so there is no resampling on either side.
  Packetization is 40 ms on the relay (two capture handoffs, 25 packets/s per direction)
  and 20 ms on a direct path.
- **Opus is worth adding** (Phase 3), mainly for mobile data and relay cost: ~10×
  smaller. It uses the VOIP application at 20 ms frames, 16 kHz uplink (~24 kbps), and
  24 kHz downlink (~32 kbps) decoded to 24 kHz PCM before `nova_audio.enqueue`.
  Natively: iOS `AVAudioConverter` (Opus, iOS 11+); Android `MediaCodec` (decoder on
  every supported API level, encoder API 29+, otherwise fall back to PCM). On the Host,
  a Node Opus binding (native or WASM). It is negotiated in `voice.start` / `voice.accept`.
  PCM stays mandatory to implement.

Bandwidth per call (payload + 12 B header + 16 B tag + WS/TLS ≈ 60 B/packet at 25 pps
≈ 12 kbps per direction):

| Mode | Up | Down | Total | Per hour (each relay leg) |
|---|---|---|---|---|
| PCM16 via `/v1/media` | ~268 kbps | ~396 kbps | ~83 KB/s | ~300 MB in + ~300 MB out |
| Opus via `/v1/media` | ~36 kbps | ~44 kbps | ~10 KB/s | ~36 MB in + ~36 MB out |
| PCM16 via existing `/v1/stream` (c1) | ~5× PCM | ~5× PCM | ~400 KB/s | ~1.4 GB, plus 50 HTTP requests/s |

Downlink is bursty: providers generate faster than realtime. The Host paces downlink to
≤1.5× realtime with ≤2 s lead. This bounds relay queues and makes barge-in cheap.

## 4. Session lifecycle and authorization

New intents (Host `intentSchema` kinds) and Host messages:

| Message | Direction | Content |
|---|---|---|
| `voice.start` | phone → Host intent | `conversation_id`, `voice_mode?`, `ephC`, `codecs`, `transports` |
| `voice.accept` / `voice.reject{code}` | Host → phone (signed stream, plus a receipt) | see section 2. Rejection codes: `voice_active`, `voice_unavailable`, `conversation_busy`, `relay_media_disabled`, `owner_required`, … |
| `voice.stop` | phone → Host intent, or sealed in-band `voice.end` | `session` |
| `voice.ended{reason}` | Host → phone | `stopped`, `epoch_rotated`, `idle`, `max_duration`, `taken_over`, `provider_failed` |

- **Binding.** `voice.start` maps to `conversations.voice {id, enabled:true}` on the
  Host, so the existing per-Host `voice_id` singleton, the `voice_active` and
  `conversation_busy` checks, and the Build guard apply unchanged.
  `voice.stop` / teardown maps to `enabled:false`.
- **Audio owner.** Extend the desktop session's owner set from `'desktop' | 'phone'` to
  include `{space: device}`, with a new `SpaceVoiceBridge` that implements the same sink
  contract as `DesktopSocketBridge`. It handles `receiveAudio`, playback frames, clears,
  terminals and delivery reports. The **one active voice session per Host** rule (any
  device) follows from both `voice_id` and the audio owner. A device holds at most one
  session; a second `voice.start` from the same device replaces its own session.
  Desktop takeover policy: the local user always wins (`voice.ended{taken_over}`).
- **Authorization.** Any paired member may start voice in a conversation it can already
  chat in (same as `chat.send`). It is *not* in `ADMIN_KINDS`. A Host setting
  `space_voice: off | owner | members` (default `owner`) lets the owner restrict it,
  because voice spends the Host's provider credits and mic-driven tools. Tool approvals
  stay as in text chat.
- **Presentation.** `sendConversationAudio` and the `onAudioFrame` filter reject when
  `presentationMode === 'background'`. A Space voice session must count as a voice
  presentation (a new `'remote_voice'` reason, or the owner bridge exempting the check)
  so a minimised Host desktop still serves the call.
- **Timeouts.** `voice.accept` must arrive within 8 s or the phone falls back (section 7).
  Sessions end after 60 s without media in both directions, and at a max duration
  (default 60 min, configurable).

## 5. Barge-in, latency and jitter

- **Barge-in is Host-authoritative**, as on the desktop. Provider or cascaded
  endpointing detects speech, the service raises the fence, and `playback.clear`
  is sent as a control frame that overtakes queued audio (separate priority queue on
  the Host and relay). The phone calls `nova_audio.clear(utterance, epoch)`. The phone
  reports `playback.progress{played_ms}` from the native render ledger, so the Host
  truncates history to what was actually heard (current delivery-report semantics).
  Optional optimisation: the phone ducks playback locally when its capture level
  crosses the threshold, hiding one RTT. It never clears on its own.
- **AEC** is required (speakerphone self-barge-in). Use nova_audio relay mode with
  platform voice processing, as Standalone already does.
- **Latency targets** (transport only, same region): added mouth-to-Host ≤150 ms p50 /
  ≤300 ms p95 on the relay, ≤30 ms direct on LAN. Speech end to first audible reply:
  ≤1.5 s p50 over the relay, otherwise provider-bound. `playback.clear` to silence:
  ≤250 ms p95.
- **Jitter.** Downlink uses an adaptive buffer in front of `enqueue`: start 80 ms,
  range 60–200 ms, grow on underrun, shrink slowly. Late frames past the buffer are
  dropped and concealed (silence for PCM, Opus PLC). Uplink needs no playout buffer.
  The Host feeds frames in `seq` order with a 60 ms reorder window and inserts nothing,
  because endpointing tolerates gaps. Over a 1 s gap, the Host emits a
  `voice.degraded` caption.

## 6. Relay limits and abuse protection

Media is **disabled by default** on the relay. It costs the operator real bandwidth and
self-hosters must opt in. New `media` deployment config (and `RelayServerOptions.media`;
note that `cli.ts` does not expose `live` options today either):

| Option | Default when enabled | Purpose |
|---|---|---|
| `media.enabled` | `false` | The route returns 404 / `relay_media_disabled` |
| `media.maxKbpsPerDirection` | 420 (fits PCM16 downlink). Drop to 64 once all clients have Opus | Token bucket per socket. Excess frames are dropped, and sustained excess closes the socket |
| `media.maxFrameBytes` | 4096 | |
| `media.maxSessionsPerSpace` | 1 | Mirrors one-voice-per-Host |
| `media.maxSessionsGlobal` | 64 | |
| `media.maxSessionMinutes` | 60 | |
| `media.idleTimeoutSeconds` | 30 | |
| `media.monthlyBytesPerSpace` | unset | Optional quota, persisted in SQLite |

Media sockets count toward `maxConnectionsPerIp` / `maxConnections`, but **frames do not
count toward `requestsPerMinute`**. Session registration and upgrades do. Only paired,
non-revoked devices of one space can join, the two parties are fixed at registration,
and frames are opaque. The relay logs only session id, byte counts and durations, never
payloads. Self-hosters behind a reverse proxy must allow WebSocket upgrades on
`/v1/media` and raise proxy idle timeouts above the 15 s keepalive. `GET /v1/capabilities`
(new, unauthenticated, static) advertises `{media: {v:1, maxKbpsPerDirection}}` so the
Host can decide before offering voice.

## 7. Failure handling, fallback and reconnect

- **Cannot start** (old Host, `voice.reject`, relay without media, no accept within 8 s,
  mic denied): show the reason and offer **dictation** in the same composer. Never
  retry silently.
- **Mid-call socket loss:** the phone reconnects to the same session with exponential
  backoff (250 ms → 2 s, ≤10 s total). Keys and `seq` counters continue and the replay
  window stays. The Host keeps the pipeline for 10 s (input muted, output paused via
  `playbackDisconnected({resumeDelivery:true})`). Past that, it ends the session
  (`voice.ended{transport_lost}`) and the UI offers Retry or dictation.
- **Direct ↔ relay switching** (Phase 4): on direct-path loss, reconnect over the relay
  with the same session. Never run both at once.
- **Provider failure** on the Host maps to `voice.ended{provider_failed}` with the
  existing `realtime_*` codes. Background or app suspension on the phone: keep the call
  with the existing companion/PiP machinery when available, otherwise end it cleanly.
- **Host offline** (presence false): disable the call button. This reuses `hostOnline()`.

## 8. Protocol and versioning impact

- **Old phone + new Host:** no change. Old phones never send `voice.*`.
- **New phone + old Host:** the old Host drops unknown intent kinds silently. So the
  phone must **not** send `voice.start` unless the snapshot advertises it. Add
  `host_capabilities: ['voice.v1', ...]` to `DisplaySnapshot` (additive, ignored by old
  phones). Without it, the call button is hidden and dictation is offered. The 8 s
  timeout is the backstop.
- **New Host/phone + old relay:** `/v1/media` returns 404. The Host checks
  `/v1/capabilities` and stops advertising `voice.v1` when relay media is unavailable,
  unless a direct path is configured (Phase 4).
- No change to `business_versions`, mailbox or stream semantics, or existing envelope
  formats. The media frame has its own `ver` byte, and codecs and transports are
  negotiated in the handshake.
- Public/internal hygiene (AGENTS.md): no endpoints, domains or tenant data in defaults.
  The relay URL stays deployment-configured.

## 9. Test plan

- **Relay (`relay/test`)**, kernel plus real loopback WebSocket:
  - session registration and pairing of exactly two sockets
  - a third socket, a wrong device, a non-Host route, or a stale epoch is rejected
  - revocation mid-session closes the sockets within one sweep
  - frames are forwarded byte-identical and never parsed
  - oversized frames are rejected
  - the token-bucket cap drops excess frames, and sustained excess closes the socket
  - backpressure drops the oldest audio, and control frames are preserved
  - idle and max-duration expiry
  - `media.enabled=false` returns 404
  - `/v1/capabilities` output
- **Frame crypto (shared vectors, TS and Dart):**
  - golden HKDF and AES-GCM vectors, run by both `runtime` and Flutter tests
  - tampered header or ciphertext fails, and a replayed `seq` is rejected
  - window edges and wrong-direction keys
  - a former-member content key cannot derive session keys
- **Host voice session (`runtime`)**, fake provider, fake relay media socket:
  - `voice.start` claims `voice_id` and the audio owner, and a second device gets
    `voice_active`
  - uplink PCM reaches `sendConversationAudio`
  - fake provider audio becomes sealed downlink frames with paced lead ≤2 s
  - fake speech-start emits `playback.clear` ahead of queued audio
  - `playback.progress` drives delivery truncation
  - revocation ends the session with `epoch_rotated`
  - transport loss within 10 s resumes, and after 10 s ends
  - the policy `owner` rejects a non-owner
  - background presentation still serves the call
  - an old-schema Host drops `voice.start` (documents the capability gate)
- **Flutter:**
  - a widget test for a `SpaceVoicePanel` with a fake transport and a fake `AudioPort`:
    hidden without `voice.v1`, connecting → active → ended states, the mute button, a
    reject showing the dictation fallback, and `voice.ended{epoch_rotated}` showing Resume
  - a unit test for a `HostSpaceVoiceProvider` (implementing the existing
    `VoiceProvider` so `PhoneVoiceSession` is reused) covering jitter-buffer
    underrun/growth and `clear` fencing
- **Manual acceptance:** same-LAN and cellular calls against a self-hosted relay, with
  speakerphone barge-in, and with revoking another device mid-call.

## 10. Phased plan

| Phase | Content | Rough effort |
|---|---|---|
| 0 | Spike: measure relay RTT and jitter from cellular. Decide the open questions | 1–2 days |
| 1 | Relay `/v1/media` (route, session registry, limits, capabilities, config, README) and tests | 4–6 days |
| 2 | Shared frame crypto (TS and Dart) with vectors. Host `voice.*` intents, `SpaceVoiceBridge` audio owner, presentation exemption, snapshot capability. Flutter `HostSpaceVoiceProvider` plus panel on PCM16. Fallback to dictation. Tests | 8–12 days |
| 3 | Opus negotiation (iOS, Android, Node), lower default relay cap | 5–8 days |
| 4 | Direct path: Host listener (opt-in), signed candidates with a pinned cert fingerprint, LAN/Tailscale probing, path switching | 6–10 days |
| 5 | Hardening: reconnect polish, metrics without payloads, cellular soak tests, docs for self-hosters | 3–5 days |

Phases 1–2 give a usable relay-only call (~3 weeks). Phases 3–4 cut cost and latency.

## Open questions for the owner

1. Default voice authorization: `owner` only, or all paired members?
2. Ship Phase 2 on PCM16 (about 300 MB/h per relay leg) and require Opus before
   enabling media on shared relays? Or make Opus a Phase 2 prerequisite?
3. Should relay media ship disabled by default (proposed), and should a monthly
   per-space byte quota exist in v1?
4. Desktop/Space takeover policy when the local desktop user starts voice during a
   phone call: always take over (proposed), or refuse?
5. Is the Host allowed to open a listening socket for the direct path (Phase 4), or
   is relay-only acceptable long-term?
6. Is a dedicated "remote voice" presentation acceptable, or should Space voice require
   the Host window to be visible?
