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
- Native helper compiled and initially rejected reads before permission. After the user granted access, the same packaged Nova launched successfully, enumerated six existing calendars, and completed the selected account/personal/work calendar window (zero events). Adding the existing holiday calendar ingested 15 events; persisted batch/completed_batch both reached 3 with no error. Five September all-day entries, including a multiday holiday, matched the macOS Calendar UI in title and local dates. Connection, selected scope and disabled model processing survived a client restart; memory_extractions remained zero. No system permission surface was automated or bypassed.
- Original-client Google acceptance initially persisted 81 mail objects and completed both connector checkpoints across restart; a later live sync reached 82 objects. Google Calendar remained empty. The local ad-hoc-signed development bundle now exposes a usable window; this does not establish production release signing/notarization acceptance.
- User clarification: “已授权” grants permission to continue testing; it is not a user declaration that acceptance passed. The native results above were subsequently verified through the original client and its persisted source ledger.

Independent review found and prompted fixes for interrupted consent fanout, no-progress page receipts, interrupted deletion, oversized history and native window bounds. Original-client acceptance additionally found a production assembly argument error that bypassed the source ledger; all three production callers were corrected with a production-host regression test.

Final verification: runtime 2577 tests / 2569 pass / 8 skip / 0 fail; desktop 932 tests / 929 pass / 3 skip / 0 fail. Runtime build/typecheck and changed production-file ESLint passed. The production-host regression was rerun after isolating its temporary storage. Swift compiles and rejects unsupported mutation commands. Native permission, nonempty readonly ingestion and date alignment were subsequently verified as described above.


Unclaimed: second Google identity, real revoked OAuth, Gmail deletion lifecycle, nonempty Google recurrence/cancellation, real sleep/wake, model output quality. No emails or calendar events were sent, created, modified or deleted.

Native capacity limit: at most 200 events per selected window. Oversized/time-limited snapshots are visibly incomplete, preserve existing evidence and require a narrower window; large-calendar pagination is not claimed. Production release signing/notarization and live native edit/cancellation/deletion lifecycle acceptance remain open.
