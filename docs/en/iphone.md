# Use Nova on iPhone

Talk to Nova, approve operations and receive task results on your iPhone. Models, memory and coding tasks run on your computer.

## Prepare

Have Nova working on the computer, connect both devices to the same Tailscale network, and install the iPhone client. Allow microphone access when needed. Keep the computer online.

## Pair

[![Nova iPhone client and connection settings](../../assets/features/iphone.en.png)](../../assets/features/iphone.en.png)

On macOS, right-click the orb and choose “连接 iPhone…”:

1. Enable the phone connection.
2. Follow the secure-connection prompts.
3. Scan the QR code on your iPhone and confirm the connection details.

Codes are single-use; refreshing invalidates the previous code. You can revoke paired devices on the computer. For a separately hosted service, see [remote deployment](deployment/remote-server.md).

## Talk or type

Realtime conversation is the default. If the computer uses cascaded speech and supports editable input, text chat is also available. Type a message or dictate, edit and send a draft.

Switching to text pauses live audio. Switching back cancels ongoing dictation but preserves the text draft. Changing the phone's view does not change the computer's voice pipeline.

## Tasks and permissions

Tasks execute on the computer. When approval is needed, the phone shows the operation and the available decisions. “Allow” applies only to that request; “Allow for this session”, when offered, keeps the grant for the rest of the session, so choose it deliberately.

Ending a call does not cancel a task; request cancellation explicitly. After reconnecting, use the returned task state to check progress instead of repeating an approved operation.

## Limits

The message list may not survive an app restart. Phone cameras, screen sharing and background wake words are not supported. Network conditions, computer sleep and audio permissions affect calls. Reconnection clears stale audio and approval controls; approvals are not replayed automatically.

The supported iPhone app is the native client in `clients/ios/Nova`. The Flutter client in `clients/flutter` (a five-tab workbench for Todos, Ideas, Goals, Feeds and Profile) is an in-progress port; it is not part of the 0.3.0 release, and Android, physical-device sync and live audio are not yet accepted.

For client integration, see the [protocol reference](protocols/client-v1.md).

## Flutter standalone local memory

In the Flutter client’s standalone Space, explicitly ask Nova to remember a short fact or preference. A save must quote the current user message verbatim (in direct voice, a verified final transcript); Nova should confirm saving only after a committed tool result. There is no automatic extraction. Local recall uses word overlap, not embeddings. Up to 200 active entries of 200 characters each are kept across restarts; a full store refuses new entries rather than evicting old ones. A bounded, data-only summary is supplied to chat and voice. Ask in text chat to recall or forget an entry: forgetting erases its ledger text and quote and retains a tombstone, not the user's own conversation messages. The user's typed messages and spoken transcripts remain conversation history and are not erased by forget. Memory-tool arguments and results are stored only as redacted metadata; legacy memory-tool payloads are redacted when conversation storage opens.

Direct voice offers recall and save when its provider supports tools; forgetting is available in text chat. Forget gives each live memory consumer up to five seconds to invalidate its context after committing the tombstone: other active chat rounds are cancelled, and cascaded voice clears its live history/receipts and refreshes its summary before continuing. Any utterance still in progress when forget occurs is discarded and may need to be repeated; the speaking floor and tentative turn/caption state are reset. Providers without context reset (including Qwen-family adapters) end the call instead; provider closure is bounded and does not wait for background native audio/presentation cleanup. Only cascaded voice expires consumed memory receipts after narration. Qwen-family adapters retain receipt payloads in their live call context with a 128-item lifetime limit; forgetting ends those calls rather than expiring individual receipts. Consumer failure or timeout is reported as a text-free `invalidation_warning` on the committed forget result; later ledger operations and Space reopening are not held indefinitely by listeners. This Dart-only store is separate from the computer: client mode continues to use host memory, with no local memory tools, merging or synchronization. Device acceptance remains separate from unit tests.

`local_memory.json` contains verbatim source quotes as well as saved text. Like other local data in the Space directory, it is included in device backups; forgetting on this device does not remove older backups. Backup flags are unchanged. Corrupt or unreadable memory storage stays unavailable and is never automatically replaced. Recovery requires an explicitly authorized developer call to `LocalMemoryStore.resetUnavailable()`; it copies any original file byte-for-byte to a sibling `local_memory.json.corrupt-<timestamp>` before resetting. No UI or automatic path calls this method. Recovery copies may contain private text and must be handled accordingly.

Local memory is not a source for profile inference, delegated tasks or scheduled runs. Space changes remount the Flutter shell (`KeyedSubtree` in `space_root.dart`): it stops the old voice session and agent, then closes the old memory store, rejecting new operations and draining pending writes. Ownership is per app process (the Flutter Dart isolate), not an inter-process lock. Each filesystem-canonical ledger identity has one live store owner, including while unavailable or closing. Identity resolves parent symlinks (or the deepest existing ancestor for new directories) and folds case only on case-insensitive volumes; Apple volumes are treated conservatively as case-insensitive unless proven otherwise. Opening a second store while that owner is live fails closed (`available == false`), with an explicit “Local memory is unavailable” message and no reads, writes, reset or cleanup; close the rejected instance and open a new one after the owner retires. Reopening while the old owner is already closing waits for its queued writes to drain. Failed startup attempts close their memory store before Retry is offered. Temporary filenames are instance-unique. Failed writes attempt to remove their own pending snapshot; at open and after every forget, only the sole owner inside its idle write queue removes abandoned snapshots matching this ledger's exact filename/UUID scheme. Cleanup compares the same canonical identities and never deletes pending filenames registered by an in-flight writer in the isolate. Cleanup failures are reported without file contents. Store-close and blocked-write/reopen behavior are unit tested; a live device Space-switch/call teardown still needs device acceptance. Voice tool payloads are not written to session logs or transcript caches; only actual conversation transcripts and delivery-state metadata enter conversation storage.

Native iOS model transfers can retain orphaned `.result` recovery files after an interrupted turn. Dart deletes these never-auto-replayed files from the current Space's `ModelTransfers` directory on memory-store open and every forget; cleanup is best-effort, and failure is exposed as `recoveryCleanupError` / a forget-result warning without file contents. An orphaned result can still exist between an interrupted turn and the next app launch or forget. The native write path is unchanged: closing this residual window requires a follow-up native fix validated by an iOS build. Ordinary conversation history and active `.request` transfers are not deleted.
