# Local Markdown reading copies

The desktop runtime maintains `profile.md`, `timeline.md`, `todos.md`, `goals.md`, and `ideas.md` beside its configured Personal Agent state. With the default local data directory these files live in `~/.nova-audio-agent/`.

These are private, automatically refreshed reading copies. The database and existing application stores remain authoritative. Editing Markdown never updates the app; a subsequent sync can overwrite edits. No model call is needed to create the copies.

## Refresh behavior

- After local account restoration and successful host initialization, existing saved results populate the files without waiting for online login.
- Profile selection follows the existing presentation: user-written introduction first, then the selected successful publication (discussion-derived history preferred), then an available draft. An explicit blank user introduction remains blank.
- Timeline includes all visible cards in the current account scope, independent of UI pagination. Only successfully persisted timeline cards are exported.
- Todos, goals and ideas include completed and archived records, grouped by status. Removed records disappear on the next sync.
- Updates are coalesced for 500 ms and serialized; unchanged content is not rewritten. Shutdown flushes queued output before releasing the host lock.
- Every file is written atomically with private permissions. A failed read keeps the existing copy for the same scope. Switching scope cannot preserve a previous account's content as the new account's output.
- Write failures do not undo application saves or block startup. Diagnostics use `reading_copy_write_failed:<filename>` or `reading_copies_snapshot_failed`, without private content. Later changes or restart retry the export.

## Boundaries

The files are local plaintext, not a backup or a synchronization protocol. All five files are independently atomic, not a cross-file transaction. No raw chats, execution logs, credentials, or automatic re-import are included. Public RPC and database schemas are unchanged. Custom Host callers must opt in with `readingCopiesDirectory`; the production composition derives it from the configured state path.
