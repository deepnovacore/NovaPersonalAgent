# Native audio channel contract

`nova/audio` is a MethodChannel. All controls carry a connection `generation`.
`startRelay` additionally carries capture (bool) and threshold (double, 0..1).
`enqueue` carries one Uint8List containing a validated NOVA frame. `terminal` and
`clear` carry utterance_id and generation_epoch. `mute` carries muted; `speaker`
carries enabled. stop/disconnect release device resources. requestMicrophone is
invoked only by an explicit user audio action. capabilities never implies AEC acceptance.

Native-to-Dart `event` calls contain generation, kind and a kind-specific payload:
- level: normalized level double.
- control: server command payload with playback identity and monotonic t_render_ms.
- stopped: reason string. Requires explicit user restart.
- aec: Android available, enabled and has_control booleans for diagnostics only.

`nova/audio/pcm` is a BinaryCodec channel: 8-byte big-endian signed connection
identifier followed by PCM16 little-endian mono 16 kHz samples. Dart acknowledges
one accepted handoff with byte 1 (byte 0 for a stale packet). Native permits only one
in-flight packet; a one-second stall fails capture instead of accumulating audio.
Acknowledgement is not network delivery or proof that any audio was heard.

Swift ledger tests and CoreCheck use the repository's shared frame fixtures. The
CoreCheck executable is an alternate harness for the same native core when SwiftPM
manifest loading is unavailable. Device build, live route control and acoustic
validation are still separate acceptance gates.

`playback.progress` carries the current identity and cumulative `played_ms` from
the same native render ledger used by terminal receipts, at most once per 100 ms
of credited audio. It never uses enqueue time or a wall-clock estimate. The phone
coordinator limits outstanding native audio to 50 seconds (below the ledger's
60-second cap), waiting for these receipts for credit. Incoming burst storage is
separately capped at 120 seconds of PCM16/24 kHz and 4096 events; a source exceeding
that bounded burst contract fails visibly. Clearing/stopping releases waits and
fences queued frames immediately.
