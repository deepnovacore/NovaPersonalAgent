# Optional voiceprint upload service

A small anonymous audio broker for Volcengine voiceprint enrollment. Each desktop calls Volcengine directly with its own speech API key. This service never receives that key or the resulting voiceprint ID. Do not share a speech application/key between unrelated users: IP addresses and MAC addresses are not account identities.

The desktop Settings panel records 12 seconds of speech, uploads a canonical 16 kHz mono PCM WAV, registers the voiceprint, then requests deletion of the temporary recording. Record in a quiet room with only the intended speaker. Settings supplies an original localized reading passage so users can speak continuously at their usual pace and volume. It is a capture aid, not a vendor-prescribed passphrase or a liveness check. Save the speech key before registering. Enable verification and save afterwards; restart the microphone to continue the conversation. Only cascaded Volcengine ASR supports verification.

The vendor retains the registered voiceprint after the temporary audio is deleted. Deleting audio or disabling verification does not unregister it. Re-registering saves the new `SpeakId` first, then deletes the previous one with `UpdateVoiceprint` Action 2; if that deletion fails, Settings shows the old ID for manual cleanup. If the speech key changes during registration, the new record is deleted and nothing is saved. The upload service only rejects stalled bodies at its request timeout, so it keeps one operation slot free for the provider's audio download.

## Deployment

Use Node >=22.13 or build the included Dockerfile. Keep actual credentials and deployment addresses outside this repository. Supply:

- `TOS_ACCESS_KEY_ID`, `TOS_SECRET_ACCESS_KEY`, `TOS_BUCKET`, `TOS_REGION`
- `PUBLIC_BASE_URL`: HTTPS base URL without query/fragment
- `IP_HASH_SALT`: at least 32 random characters
- `DATABASE_PATH`: persistent writable SQLite path
- `HOST`, `PORT`: defaults `127.0.0.1:8787`
- `TRUSTED_PROXY_IPS`: exact comma-separated proxy peer addresses; empty by default
- `PER_IP_DAILY_LIMIT`, `GLOBAL_DAILY_LIMIT`: defaults 5 and 100; zero disables uploads

Use a private encrypted bucket, no public ACL/CORS, and an IAM principal restricted to `PutObject`, `GetObject`, `DeleteObject` on `voiceprint-tmp/*`. The TOS credentials belong only on the server. Use HTTPS at a reverse proxy, overwrite `X-Real-IP` from the actual peer, cap request bodies at 960044 bytes, rate-limit all routes, and omit request paths from access/error logs because audio URLs contain bearer tokens. Set proxy read timeout above the storage request timeout. Keep the container non-root/read-only with a writable data volume and bounded memory, processes, CPU and logs.

## Limits and cleanup

- 5–30 second WAV only, maximum 960044 bytes; no arbitrary file/URL fetch.
- IP quotas persist across restarts and deletion; IPv6 addresses share a /64 quota. Upload attempts consume quota, including invalid audio after admission. Daily reset is UTC.
- One upload per IP per minute, four concurrent operations, 100 uploads/day globally by default.
- Audio uses a random 256-bit bearer token, expires after 15 minutes, and allows three GET/HEAD requests. Anyone holding the token can read/delete that recording until expiry; no list endpoint exists. Tokens are hashed in SQLite.
- Successful or failed registration requests cleanup. The server retries expired-object deletion every minute from persistent records. Storage outages can delay physical deletion, while expired URLs remain inaccessible.
- Keep SQLite durable and backed up. Configure a one-day bucket lifecycle rule on `voiceprint-tmp/` as an additional safety net against losing the database or stopping the service permanently.
- Shared IPs share quota; rotating IPs can evade per-IP limits but not the global upload quota. This is bounded anonymous access, not per-person authentication or DDoS protection. Set cloud billing alerts separately before broad distribution.

`GET /healthz` returns `{ "ok": true }` only when configured uploads are enabled and the storage read probe succeeds. It does not prove speech service entitlement or all write/delete permissions. Desktop Settings rechecks every 30 seconds; new ASR sessions use a health result cached for up to 30 seconds. If unhealthy, registration is hidden and new ASR sessions transcribe without speaker filtering, as configured by product policy. Saved voiceprint settings remain for recovery; an in-flight ASR session keeps its initial mode.

Verification filters final recognized text by the registered speaker name; unidentified/partial text is withheld. It does not prevent VAD from detecting another person's voice and interrupting playback before recognition. Real provider response/voice acceptance is required before relying on target-speaker behavior.

Run `npm ci && npm test`. The lockfile overrides the SDK's Axios dependency with the compatible 0.33 security maintenance release; check real TOS upload/download/delete when updating it.

Official references: [speaker verification](https://docs.volcengine.com/docs/DoubaoVoice/speaker-separation?lang=zh), [voiceprint management](https://docs.volcengine.com/docs/DoubaoVoice/voiceprint-registration-management-api?lang=zh).
