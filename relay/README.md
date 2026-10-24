# Self-hosted Space relay

This package provides an HTTP/WebSocket service, outbound Host/Client SDK, SQLite opaque mailbox, signed identity and pairing controls, and endpoint-only JOSE helpers. It never runs a model, decrypts business content or owns Life data. Node >=22.13 is required. The exact signed wire and endpoint key-delivery requirements are in [Space wire v1](../docs/design-notes/2026-10-23-space-host-client-wire.md).

Create a deployment JSON file outside the repository:

```json
{
  "dataDirectory": "/data",
  "bootstrapTokenFile": "/run/secrets/relay-bootstrap",
  "bind": "127.0.0.1",
  "port": 8080
}
```

The bootstrap file must contain at least 24 random characters; distribute it only to operators authorized to create Spaces. The CLI uses a restrictive umask and persists membership/session and mailbox SQLite databases under `dataDirectory`. Do not delete/reuse a Space's database namespace to reset capacity. A Host's private identity and content keys belong on the Host, never in these deployment files.

After compiling this package to an isolated output, run `node /your-build/src/cli.js --config /path/to/deployment.json`. SIGINT/SIGTERM close the network service and databases. The default listener is loopback. Public binding requires either `tlsCertificateFile` + `tlsKeyFile` or explicit `externalTls: true` with an HTTPS `publicUrl`, for a reverse proxy which terminates TLS. Forwarded source-IP headers are ignored by default. Behind a reverse proxy, explicitly set `trustedProxyAddresses` to its exact transport-peer IP addresses (for example `["127.0.0.1", "::1"]` for a local proxy). Hostnames, CIDRs and implicit trust-all hop counts are not supported. The trusted proxy must overwrite or correctly append `X-Forwarded-For`; the relay walks the chain from the socket right-to-left and stops at the first untrusted hop, so forged client prefixes cannot select a quota bucket. Malformed trusted forwarding headers are rejected. With no header, the transport peer remains the source. Restrict the relay listener to the proxy network and configure edge connection/body limits as well. Host and Client URL configuration must use the HTTPS origin; HTTP is accepted only for explicit loopback development. No hosted or organization endpoint is embedded.

Docker builds use the repository root as context:

```sh
docker build -f relay/Dockerfile -t nova-relay .
docker run --rm -p 127.0.0.1:8080:8080 \
  -v /your-data:/data \
  -v /your-config:/etc/nova-relay:ro \
  -v /your-secrets:/run/secrets:ro nova-relay
```

For a build behind a TLS-inspecting development proxy, inherit proxy variables using `--build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY` and supply the public CA bundle with `--secret id=relay_build_ca,src=/path/to/ca-certificates.crt`. The optional CA is a build-only secret mount; TLS certificate verification remains enabled, and no proxy credential or CA bundle is copied into the runtime image.

The container runs as the unprivileged `node` user; the data volume must be writable by that user. Inside a container, explicitly configure `bind: "0.0.0.0"`, `externalTls: true`, and your deployment's HTTPS `publicUrl`; keep the published port private to the TLS reverse proxy. Alternatively mount certificate/key files and enable direct TLS. The image contains the service and production dependencies, with no endpoint identity or bootstrap default.

## HTTP and WebSocket API

JSON POST requests require `Content-Type: application/json`. Errors are `{ "error": "code" }`; success is HTTP 200. The bootstrap creation header is `X-Relay-Bootstrap-Token`. All other protected routes require `Authorization: Bearer <session-token>` and derive the principal solely from durable security state. Tokens come from single-use Ed25519-signed login challenges; all ciphertext envelopes independently carry verified Ed25519 signatures. Invalid/stale/revoked identities cannot read, ACK, send, stream or change membership.

| Method/path | Request / response |
|---|---|
| `POST /v1/spaces` | Bootstrap header + signed creation body → SpaceRecord |
| `POST /v1/auth/challenge` | `{space,device}` → LoginChallenge |
| `POST /v1/auth/session` | `{challengeId,proof}` → `{token,principal,expiresAt,selected_version}` |
| `POST /v1/pairing/requests` | One-use QR secret + device possession proof → pending request |
| `POST /v1/pairing/invitations` | Host session + `{ttlMs?}` → invitation |
| `GET /v1/pairing/requests` | Host session → pending requests/fingerprints |
| `POST /v1/pairing/confirm` | Host session + `{requestId,opId}` → admitted public device |
| `GET /v1/devices` | Session → public active devices |
| `POST /v1/devices/revoke` | Host session + `{device,opId}` → `{epoch,remainingDevices}` |
| `POST /v1/mailbox` | Signed envelope → `{seq,duplicate}` |
| `GET /v1/mailbox?after=0&limit=100` | Recipient page `{messages:[{seq,envelope}],nextCursor,ackCursor,hasMore}` |
| `POST /v1/mailbox/ack` | `{cursor}` → `{ackCursor}` |
| `GET /v1/mailbox/status` | Recipient-only last/ACK/delivered/retainedAfter cursors |
| `GET /v1/presence?device=...` | Same-Space presence → `{online}` |
| `POST /v1/stream` | Signed short-lived stream envelope → `{accepted:true}` |
| `GET /v1/live` (upgrade) | Bearer header → `{type:"ready",principal}`, then `{type:"stream",envelope}` |

WebSocket credentials are sent in the upgrade header, never URLs. The service pings every 10 seconds; standard WebSocket pong responses refresh heartbeat presence. A JSON `{type:"heartbeat"}` is also accepted. Other frames and oversized incoming frames close the connection. Streams have no offline queue or replay. HTTP pull remains the reliable delivery mechanism, including while connected; a successful stream enqueue is not a mailbox ACK.

Signed pairing requests must include `business_versions` as the last signed payload field after the encryption public key. Both endpoints currently support version 1; missing declarations, signature changes and incompatible versions are rejected. The negotiated `selected_version` persists on the member and login session. An identical signed claim can recover its response before QR expiry, while one QR still admits only one device.

Host confirmation and revocation use persistent `opId` receipts. Journal the ID and pending membership/key change before sending, then retry that same ID after a lost response. `confirmPairing(requestId, opId)` and `revokeDevice(device, opId)` never perform a second mutation for the same operation. Revocation clears the SDK session even if the response is lost, so a retry reauthenticates at the current epoch. Reusing IDs for different operations in the current epoch is rejected. Receipts from an older result epoch cannot be replayed and are deleted. A revoke transaction replaces old-epoch receipts with its own durable new-epoch receipt, so even a full confirmation ledger cannot prevent revocation. The latest revoke receipt has a reserved slot and survives restart/response loss; confirmation limits and short-lived pairing claims are isolated per Space.

Pairing confirmation is only admission. The Host must first show the fingerprint for explicit user confirmation, then deliver a Host-signed, recipient-encrypted content key using the pinned Host identity. Revocation invalidates all old-epoch sessions immediately; the Host must reauthenticate, generate a fresh content key and distribute it only to remaining devices before resuming traffic.

## Outbound SDK

`RelayClient` is exported as `@nova-personal-agent/relay/client`. Its URL is deployment configuration. Construct one client per Space/device:

```ts
const relay = new RelayClient({
  url: configuredOrigin, space, device: identity.device,
  signChallenge: c => signControl({v:1,purpose:'relay-login',challengeId:c.id,
    nonce:c.nonce,space:c.space,device:c.device,epoch:c.epoch,expiresAt:c.expiresAt},
    identity.signingPrivateKey)
});
const stop = relay.start({
  onMailbox: async (envelope, seq) => { /* verify, decrypt, deduplicate and commit */ },
  onStream: envelope => { /* verified preview only */ },
  loadCursor: async () => savedCursor,
  saveCursor: async cursor => { /* atomically persist with local state */ },
  onError: error => { /* show offline or initiate explicit snapshot recovery */ }
});
```

`start` reconnects the outbound WebSocket with bounded exponential delay, polls the HTTP mailbox every second by default, and catches up after reconnect. `onMailbox` and `saveCursor` must complete durably before ACK. If durable handling fails, no ACK advances. Replayed messages still require endpoint message/business-ID deduplication. `stop()` stops reconnect/poll timers and the socket; it does not recall already accepted durable operations. Explicit `send`, `read`, `acknowledge`, `status`, `presence`, `stream`, `synchronize`, and pairing methods support other lifecycle managers.

An invalid/expired cursor is surfaced to the endpoint; the SDK never silently skips valid durable history. New mailbox envelopes must have `expiresAt: null` (TTL belongs to stream envelopes). For pre-upgrade databases only, expired legacy mailbox rows are not delivered, and reads advance across those rows so a malicious expired ciphertext cannot poison a recipient forever. This also works for empty pages, lost ACKs and restart; dedup history remains intact and the legacy rows follow normal pruning. Coordinate a Host snapshot and ordering barrier, then resume at its cursor. If Host is offline, show the existing cache as stale. Prefix pruning is an operator/kernel operation, deliberately absent from the HTTP API.

## Limits and storage

Limits are configurable service bounds, not filesystem quotas. Defaults:

| Bound | Default |
|---|---:|
| HTTP body / mailbox encoded envelope | 768 KiB / 512 KiB |
| Entire mailbox HTTP response | 1.5 MiB |
| Stream encoded envelope / incoming socket frame | 64 KiB / 1 KiB |
| Connections global / per source | 1,024 / 32 |
| HTTP+upgrade requests per source / globally per minute | 600 / 30,000 |
| Bootstrap/login/pair requests per source / globally per minute | 20 / 200 |
| Source-rate bucket capacity | 10,000 |
| Current-epoch confirmation receipts per Space | 10,000, plus one reserved revoke receipt |
| Short-lived pairing claims per Space | 32 |
| Stream queue per device including in-flight | 64 messages / 1 MiB |
| Heartbeat expiry / maximum stream TTL | 30 seconds / 60 seconds |
| Retained messages global / recipient | 100,000 / 20,000 |
| Retained encoded bytes global / recipient | 256 MiB / 64 MiB |
| Dedup history global / recipient | 1,000,000 / 100,000 |
| Read page | 100 messages |

`maxResponseBytes` limits whole mailbox JSON responses; reads use a SQLite iterator and stop before the next entry crosses the page byte budget. `nextCursor`, `hasMore` and delivered/ACK validation refer to returned entries and skipped expired legacy rows, never to an unreturned live entry. A configured budget must fit one maximum envelope plus metadata. An undersized direct kernel `read({maxBytes})` fails with `page_too_small` without advancing delivery.

The standalone `MailboxStore` keeps its 16 KiB default; `RelayServer` explicitly raises it for bounded camera-tool results. Compact JWS embeds the signed payload and outer base64 adds further expansion: a 96 KiB JPEG string yields roughly 486 KiB of encoded envelope. Endpoints must cap thumbnail sizes; stream is for short previews, not images. Queues, global/source connections, request rates, source-bucket count, body size and retained SQLite payload/history are bounded independently. Direct TCP peers retain the raw per-source socket cap. Trusted proxy TCP connections use the global cap; their verified source addresses share a per-source budget across active HTTP requests and WebSocket lifetimes. A long-lived WS and a simultaneous HTTP request therefore both consume source capacity, while unrelated clients behind the same proxy do not share its 32-slot cap. Overload rejects traffic rather than silently evicting messages. Security state also bounds Spaces, devices, pending challenges and sessions. `maxControlOperationsPerSpace` defaults to 10,000 current-epoch confirmation receipts, with one separately reserved latest-revocation receipt. Confirmation exhaustion rejects new confirmations for that Space only; revocation still succeeds and atomically clears stale epoch history. Short-lived claim receipts expire and are limited per Space. Valid receipts remain replayable, including after response loss and restart. This pre-release schema uses fresh security databases; it does not migrate prototype state.

Dedup hashes survive pruning and restart but use finite capacity. History exhaustion fails closed with `history_capacity_exceeded`; deploying a namespace lifecycle or cleaning history requires coordinated replay and snapshot decisions. SQLite pages/indexes/journals consume additional disk space. An optional service `onMailbox` hook receives metadata/ciphertext after a new durable insert for gateway wake integration; wake failures never roll back accepted mail or cause duplicate insertion. External crypto review, sustained throughput and real mobile lock-screen delivery are separate release evidence.

## Verification

From repository root:

```sh
npm run check:relay
npm run test:relay -- --output-root /mounted/existing-build-root --run-id your-chat-id
```

The root must already exist. Outputs are isolated by canonical worktree hash and run ID; the runner does not clean other chats' builds. Tests exercise real loopback HTTP/WebSocket clients, signed login/pairing, tampered-envelope rejection, durable pull/ACK, reconnect/persisted cursor, stream/presence, revocation, limits, a 96 KiB encrypted camera result, and multi-page recovery of a ciphertext backlog above 2 MiB. Kernel tests additionally cover rejection of mailbox TTL, pre-upgrade expired-row recovery, stale connections, bounded queues, ACK loss and prefix recovery. No real model or push provider is invoked.
