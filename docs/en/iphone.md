# Use Nova on iPhone & Android (NovaCore)

The mobile companion app **NovaCore** (`clients/flutter`) supports both **iOS and Android**. You can run it as a **Client** paired to your desktop/headless Host, or create an independent **Standalone Space** on your phone.

## Two Space modes

- **Client Space (paired to a Host):** Models, personal memory, connectors, and background executors run on your computer (the fixed Space Host). Your phone displays cached state, sends chat/voice requests when the Host is online, approves operations, and queues non-chat intents when offline.
- **Standalone Space (on-device):** Runs directly on the phone without a desktop Host or relay. Data, workspace files, and local memory stay on the device. A standalone Space cannot be converted into a Client Space in place; switching modes requires creating a new Space.

## Pair a Client Space to your desktop Host

1. On the desktop, open **Settings → Space & phones** and create a Space (either with **Tailscale automatic setup** or an existing self-hosted [relay](../../relay/README.md)).
2. Generate a one-time pairing QR code on the desktop.
3. In NovaCore on iOS or Android, choose **Client** and scan the QR code.
4. Compare the full device fingerprint shown on the phone and desktop, then confirm on the desktop.

The first confirmed phone on a fresh Host becomes the Space **owner** and can manage Host settings, model keys, and Feishu sign-in from **Settings → Host settings**. You can revoke paired devices from the desktop or CLI at any time. See [Space / Host / Client setup and deployment](space-host-client.md) for full details.

## Talk, type, and manage tasks

- **Voice & text:** Realtime voice is supported alongside text chat and dictation drafts (when the Host pipeline supports editable input).
- **Tasks & approvals:** Background tasks execute on the Host. When an executor needs confirmation, NovaCore presents the operation and lets you approve or reject it. Disconnecting or closing the app does not cancel a running task on the Host.
- **Standalone local memory:** In a standalone phone Space, you can explicitly ask Nova to remember or forget short facts; these stay local to that Space and are excluded from OS cloud backups.

## Limits

- Client chat requires the Host to be online; messages are not queued silently when the Host is offline.
- Phone cameras, screen sharing, and background wake words are not supported.
- Host loss means Client Space loss (there is no cloud backup or automatic failover).
- Legacy native iOS client sources remain in `clients/ios/Nova`; active cross-platform development targets `clients/flutter`.
