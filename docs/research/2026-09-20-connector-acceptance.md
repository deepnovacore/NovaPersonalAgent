# Connector implementation and acceptance

Branch: v0.3.0dev. Local-only implementation; no remote push or release.

Implemented:
- Fixed Composio readonly operations pinned to 20260915_00, isolated connection routing and profile identity checks. Managed OAuth scopes are disclosed; local reads remain bounded and scope checked.
- Gmail snapshot/history catch-up, durable pending IDs, full reconciliation, expired/oversized history recovery. Calendar uses explicit window snapshots pending nonempty incremental lifecycle evidence.
- Shared source-current evidence, generation fencing, atomic page checkpoints, persistent retries/status, interrupted deletion recovery, separate connection-level and object-level processing consent. Revocation fences late extraction; connection grant is authoritative after interrupted fanout.
- Desktop encrypted key field, saved/unset/cleared handling, strict OAuth URL opener and scope/consent/sync/lifecycle controls. Native macOS EventKit helper uses the same source state and signed-resource manifest route.

Live evidence:
- Real approved Gmail scope: 81 objects read and ingested into private temporary SQLite through bounded rounds, including history catch-up and final reconciliation. A large newsletter initially stopped a probe without advancing its pending checkpoint; after bounded excerpt handling the remainder resumed successfully.
- Google Calendar primary window returned zero events; complete snapshot/checkpoint succeeded. This proves routing and empty-window handling, not nonempty recurrence/deletion behavior.
- Model processing remained disabled for live source reads; manager harness recorded zero model calls.
- Native helper compiled; manifest-verified client returned not_determined and rejected snapshot before permission. Packaged Nova exposes Composio and local Calendar controls. Original-client Google acceptance then persisted all 81 objects, completed both connector checkpoints and retained them across restart; memory_extractions remained zero. Native TCC/nonempty acceptance remains blocked: no successful grant callback was obtained, and computer-use refuses the system UserNotificationCenter surface. User was asked to operate that prompt manually. Local ad-hoc signing verified resources, but the signed development bundle then failed to expose a usable window; this is not a production-signed installation acceptance. The temporary process was stopped.

Independent review found and prompted fixes for interrupted consent fanout, no-progress page receipts, interrupted deletion, oversized history and native window bounds. Original-client acceptance additionally found a production assembly argument error that bypassed the source ledger; all three production callers were corrected with a production-host regression test.

Final verification: runtime 2577 tests / 2569 pass / 8 skip / 0 fail; desktop 932 tests / 929 pass / 3 skip / 0 fail. Runtime build/typecheck and changed production-file ESLint passed. The production-host regression was rerun after isolating its temporary storage. Swift compiles and rejects unsupported mutation commands. Native event contents and TCC grant were not verified.


Unclaimed: second Google identity, real revoked OAuth, Gmail deletion lifecycle, nonempty Google recurrence/cancellation, real sleep/wake, model output quality. No emails or calendar events were sent, created, modified or deleted.

Native capacity limit: at most 200 events per selected window. Oversized/time-limited snapshots are visibly incomplete, preserve existing evidence and require a narrower window; large-calendar pagination is not claimed. Production release signing/notarization and nonempty native lifecycle acceptance remain open.
