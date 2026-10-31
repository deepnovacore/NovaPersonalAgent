# Space / Host / Client development and deployment

A Space has exactly one fixed Host. The Host keeps authoritative data, calls models and runs background tasks; the phone Client keeps a display cache and pending intents. A standalone phone Space uses the on-device runtime and cannot become a Client in place. Creating or switching a Space never migrates old data. There is no cloud recovery or automatic takeover if the Host is lost.

## Build and local verification

Node.js 22.13 or newer. Install the repository dependencies, then pick an existing output root that this task owns exclusively:

```sh
npm run build:space -- --output-root /your/build-disk --run-id your-task
npm run test:space -- --output-root /your/build-disk --run-id your-task
```

The scripts isolate build output by worktree path and run id. Call the output path `$SPACE_BUILD`; its `node_modules/@nova-personal-agent/` holds separate relay, push-gateway and runtime packages. Tests use a real local HTTP/WebSocket stack and fixed model output, with no external model or push vendor. The regular desktop build also builds the relay package first.

## Run order

1. Start a self-hosted relay following the [relay deployment notes](../../relay/README.md). Public access must be HTTPS; local development may use explicit loopback HTTP. Give the bootstrap credential that creates Spaces only to the Host operator, never to phones.
2. Prepare a bootstrap credential file with mode `0600` and at least 32 random characters. Create the Host Space in new directories:

   ```sh
   node "$SPACE_BUILD/node_modules/@nova-personal-agent/runtime/dist/src/space-host/cli.js" init \
     --config /private/new-space/config.json \
     --data /private/new-space/personal.json \
     --relay https://your-relay.example \
     --bootstrap-file /private/relay-bootstrap
   ```

   The config holds the Host private keys and content key; never commit it or put it on the relay. `--data` must be a fresh path; existing data is neither migrated nor overwritten. The config and data directories must be private to your user: missing ones are created `0700`, an existing one needs `chmod 700` first, otherwise `init` fails with `space_directory_must_be_private`. If the network drops during first creation, keep the written config and retry the same identity with `resume --config /private/new-space/config.json --bootstrap-file /private/relay-bootstrap`; do not delete the config to rebuild the identity.
3. Start the desktop with `NOVA_SPACE_HOST_CONFIG=/private/new-space/config.json`. Settings > Connections > Space creates one-time QR codes, shows the phone's full fingerprint, confirms pairing and revokes devices.
4. On the phone choose "Client" and scan the QR. Compare the fingerprint on the phone and the desktop, then confirm on the desktop. The Client waits for key delivery and then pulls display data. While the Host is offline, state changes show as waiting and chat fails immediately; nothing is sent silently when the Host returns.
5. Other Spaces created on the phone can be standalone or a Client of another Host; credentials, caches, intents and tool-run records stay isolated per Space. To use another Host Space on the desktop, start it with a separate config.

## Create a Space from desktop settings

Instead of the command line, you can create the Host Space under Settings > Space & phones on the desktop. You still need a working HTTPS relay (loopback HTTP for local development) and its bootstrap credential; starting a relay automatically over Tailscale is not supported yet.

1. Enter the relay address (only `https://host[:port]`) and the bootstrap credential (at least 32 characters), then choose Create Space. The credential is used only in the desktop main process's memory; it is not written to disk or sent back to the page.
2. The config and data live in a fixed `space/` folder (mode `0700`) under the desktop app data directory; you cannot choose the path. A new Space starts with fresh data and does not migrate existing data on this computer; if the Host is lost, the Space cannot be recovered.
3. After creation the desktop restarts its backend and the page shows "Create one-time pairing code"; pair the phone as in step 4 above. If the network drops during creation, choosing Create Space again resumes registration with the same identity; enter the same relay address.
4. If `NOVA_SPACE_HOST_CONFIG` is already set in the launch environment, it takes precedence and the settings page does not create a Space.

## Headless Host (Linux/macOS)

A machine without a desktop UI can be the Host: one service process runs the Space Host and pairing happens in the terminal.

1. Build as above and start a relay following the [relay deployment notes](../../relay/README.md).
2. Create the Host Space with `init` (step 2 above; `nova-space-host` is `cli.js`, and the server npm package installs it as the `nova-space-host` command).
3. Put these in a private (`0600`) environment file:

   ```sh
   NOVA_SPACE_HOST_CONFIG=/private/new-space/config.json
   SERVER_PORT=19876
   SERVER_TOKEN_FILE=/private/nova/client-token
   # plus model credentials, pipeline and absolute workspace paths
   ```

   `SERVER_MEDIA_MODE=relay` relays phone audio and is unrelated to the Space relay; Space needs no such setting.
4. Start the service: `novapersonal-server --env-file /private/nova/server.env start`. While it runs, `config.json.admin.sock` (mode `0600`, removed on exit) appears next to the config. The same OS user that can read the private config can use it; there is no extra password.
5. Pair from a second terminal (over SSH use `ssh -t`):

   ```sh
   nova-space-host pair --config /private/new-space/config.json
   # same thing: novapersonal-server space pair --config /private/new-space/config.json
   ```

   The terminal shows a one-time QR; in the Nova app choose "连接 Host" (Connect Host) → "扫描 Host 邀请码" (Scan Host invitation) and scan it. When the phone sends its request, the terminal prints the full fingerprint; type `y` after checking it matches the phone. Without a TTY, pass `--yes-fingerprint <fingerprint>`, which must match the request exactly. `--timeout-seconds N` sets the wait (default 300); Ctrl+C cancels.
6. Manage devices: `nova-space-host devices --config ...` lists paired devices, `nova-space-host revoke --config ... --device DEVICE_ID` revokes one and rotates keys, `nova-space-host status --config ...` shows state. With the service stopped these commands fail with `space_host_not_running`.

## Notifications and phone tools

Lock-screen notifications need a deployed [push gateway](../../push-gateway/README.md) and vendor configuration. The Host private config pins `push_gateway_url` to a trusted HTTPS gateway. On first enablement the phone enters an operator-issued one-time invitation, redeems an installation-specific credential and registers its token directly with that gateway; the operator signing key must never be compiled into the app. The phone gives the Host only a random handle and restricted credential, never the installation credential. The Client rotates fixed-lifetime handles before expiry; see the gateway notes. In-app data catch-up does not depend on push success. Xiaomi public notifications use generic text and are quota-limited.

The Client's system tools run only actions the Host explicitly sends, and check foreground state, system permission, user confirmation and a persistent action id. Calendar read and camera capture are included; reminder creation is iOS only and Android returns an explicit unsupported result. The Client runs no local model or autonomous planning loop.

## Managing the Host from the phone

The first phone the Host confirms becomes the owner only on a fresh Host with no paired devices. A Host that already has members but no owner — the owner was revoked while other devices stayed paired, or an older Host was upgraded with devices — never promotes a later phone, because the owner controls provider keys and Feishu login: admin intents are rejected with `owner_unassigned` and no device can change credentials. To recover, list the paired devices with `nova-space-host devices --config ...` and revoke all of them with `nova-space-host revoke --config ... --device DEVICE_ID`; once no member remains the Host is fresh again and the next confirmed phone becomes owner. Only the owner sees Settings → Host settings on the phone, where it can change the assistant name, how the assistant addresses you, the role description, proactive discovery and news topics, manage the Host's model keys, and set up and sign in to Feishu for the Host.

Model keys go only to the Host and are stored in a private file next to its config; the phone shows only whether each key is set and its fingerprint. A key takes effect after the Host restarts. A key of the same name already set in the Host's startup environment wins, and the phone marks it as coming from the Host environment. If that private file is damaged the Host ignores it and keeps the bytes instead of refusing to start, and the phone asks for the affected keys again.

This is not the journal tag key next to the Space journal (`space.json.key`). A damaged tag key — empty, the wrong length, or not 64 hex characters — makes the Host refuse to start with `space_secret_key_empty` or `space_secret_key_invalid`; permission and symlink problems report `space_secret_key_permissions` and `space_secret_key_symlink`. The Host never ignores, deletes or recreates that file, because it may be the only copy that can still authenticate existing journal tags, and concurrent starters must not remove the complete key another starter just published. Stop every Host process first and back the file up before inspecting it; delete it yourself only when you accept losing the existing tags, and the next start will create a new key, after which old tags cannot be verified and replays of old operations are reported as conflicts. Never delete or replace it while a Host is running.

Feishu authorization happens on the Host. Tap Sign in to Feishu, confirm on the authorization page the Host provides, then tap Done. While the Host waits for that confirmation the phone shows it as waiting. If the authorization page expires or confirmation fails, tap Restart sign-in; the earlier authorization link stops working. The phone's own Feishu tokens are never passed to the Host.

If a temporary network failure prevents the Host from verifying an existing login, the phone shows that verification is temporarily unavailable and the Host's reason instead of offering a fresh login. The saved authorization is kept; verification resumes automatically when the network recovers.

## Acceptance boundary

Automated tests can prove ciphertext protocol interop, idempotent retry, conflicts and id remapping, real-network catch-up, pairing and revocation, and handling up to the push vendor boundary. iOS NSE and system permissions, Android Doze/force-stop, Xiaomi lock screen and overnight arrival need real devices with signing and vendor accounts. Without that evidence do not claim M0/M5/M6 device acceptance. The matrix is in the [design milestones](../design-notes/2026-10-23-space-host-client-milestones.md).
