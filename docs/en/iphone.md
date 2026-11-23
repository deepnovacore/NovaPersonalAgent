# Use Nova on iPhone & Android (NovaCore)

The mobile companion app **NovaCore** (`clients/flutter`) supports both **iOS and Android**. You can run it as a **Client** paired to your desktop/headless Host, or create an independent **Standalone Space** on your phone. The interface is available in English and Chinese.

## Two Space modes

- **Client Space (paired to a Host):** Models, personal memory, connectors, and background executors run on your computer (the fixed Space Host). Your phone displays cached state, sends text chat to the Host when it is online, shows tasks and approvals, and queues edits to your own items when offline.
- **Standalone Space (on-device):** Runs directly on the phone without a desktop Host or relay. Data, workspace files, and local memory stay on the device. A standalone Space cannot be converted into a Client Space in place; switching modes requires creating a new Space.

## Pair a Client Space to your desktop Host

1. On the desktop, open **Settings → Devices** (设置 → 设备). Under **Connection**, keep **Tailscale automatic setup** (or choose **Advanced: existing relay** and enter your self-hosted [relay](../../relay/README.md)), then choose **Create Space**.
2. In **Connect your phone**, choose **Create one-time pairing code** to show a QR code.
3. In NovaCore on iOS or Android, create a Space, choose **Connect to a computer**, and scan the code or paste it.
4. Back on the desktop, under **Phone waiting to connect**, enter the full fingerprint shown on the phone and choose **Confirm pairing**.

The first confirmed phone on a fresh Host becomes the Space **owner**. Only the owner can approve Host actions from the phone and manage Host settings, model keys and Feishu sign-in. You can revoke paired devices from the desktop or CLI at any time. For the full flow and network requirements, see [Space / Host / Client setup and deployment](space-host-client.md).

## What each mode offers

| Capability | Client Space | Standalone Space |
|---|---|---|
| Text chat | Yes, answered by the Host; needs the Host online | Yes, on the phone |
| Dictation into the composer (hold to speak, then edit and send) | Yes; the draft is transcribed with the speech recognition set up on the phone and is never sent automatically | Yes |
| Realtime voice | Not yet available; use dictation | Yes |
| Tasks | View Host tasks and execution activity; continue them on the computer | Run on the phone |
| Approvals of executor actions | Yes, owner only: Allow or Deny on the phone | Not applicable (no Host) |
| Timeline, Profile, News, To-dos, Ideas, Goals | Yes, shown from the Host's data and cached for offline viewing | Yes, from local data |
| Scheduled tasks | Run on the Host | Run on the phone |
| Connectors | Feishu status and, for the owner, its settings; authorize Feishu on the computer. A Phone input & permissions page handles manual submissions | Connectors page on the phone |
| Host model keys and settings | Owner only | Not applicable |
| Phone control on a virtual screen | No | Android only |
| Memory | Held by the Host | Local to the Space; ask Nova to remember or forget short facts |

### Phone camera (`camera.capture`)

A Client has no camera feed. The Host can ask the paired phone for one photo, and only when:

- NovaCore is in the foreground and the request has not expired (at most 60 seconds);
- the system camera permission is granted;
- you take the picture yourself in the system camera screen. Cancelling denies the request.

NovaCore returns one JPEG, scaled to at most 640 px and under 64 KiB, with the prompt the Host supplied (up to 500 characters). Nothing is captured in the background, and a repeated request with the same id does not take a second photo. The same channel carries calendar reads (iOS and Android) and reminder creation (iOS only; Android reports it unsupported).

## Talk, type, and manage tasks

- **Text and dictation:** Type in the composer or hold the microphone button, release to transcribe, edit the draft and send. A Client chat message needs the Host online; if it is offline the send fails and nothing is resent automatically.
- **Tasks and approvals:** Background tasks execute on the Host. When an executor needs confirmation, NovaCore shows the operation and the owner can allow or deny it. An approval that expired or was already handled is reported and nothing runs. Disconnecting or closing the app does not cancel a running task on the Host.
- **Standalone local memory:** In a standalone phone Space, you can explicitly ask Nova to remember or forget short facts; these stay local to that Space and are excluded from OS cloud backups.

## Limits

- Client chat requires the Host to be online; messages are not queued silently when the Host is offline.
- Realtime voice in a Client Space is not yet available. Use dictation.
- There is no continuous phone camera, screen sharing or background wake word.
- Host loss means Client Space loss (there is no cloud backup or automatic failover).
- Legacy native iOS client sources remain in `clients/ios/Nova`; active cross-platform development targets `clients/flutter`.
