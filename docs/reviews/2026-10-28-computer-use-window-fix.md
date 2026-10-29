# macOS computer-use window observation and ownership fix

Base: `92bbe8ef`. This isolated follow-up fixes two source-level refusal paths found during release acceptance. It does not establish the exact native stage of an earlier `screen_changed`, or successful completion of a real GUI task.

Read-only window discovery previously required AXFocusedWindow, even when a valid main or unique visible window existed. It now selects a valid focused window, a valid main window, or the sole visible normal window; ambiguous candidates remain refused. Observation/connect can proceed without AX focus through both the native helper and worker. The bound process generation, window ID, geometry and key-window state remain part of the observation identity. All native input still requires the selected window to be the AX key window, matching identity and secure-input checks; focus changes require a fresh observation.

AX element ownership previously depended only on AXWindow. Window elements and elements exposing only an AXParent chain could be refused despite belonging to the selected window. Ownership now checks the window itself, its explicit AXWindow or a bounded parent chain. Every visited/explicit owner must have the expected PID; cycles, depth overflow and foreign owners fail closed. The returned window ID must still match the binding before input.

The Swift source compiler and native test include the new shared policy source. No UI, dependencies, profile/data migration, automatic quarantine release or public API were added.

Validation:

- New Swift policy regression first failed on missing AX focus; the final policy harness passes 14 selection/ownership assertions.
- Native helper compiles and rejects all malformed target requests before contacting an application; both desktop test cases pass.
- A new child-RPC regression first failed at windowTarget with keyWindowMatches=false; target/connect/screenshot now pass with a stable identity.
- Isolated Space stack TypeScript compilation passes. The focused computer-backend, computer-device, computer-use and device-lock suites pass 74/74. Fixtures do not send real GUI input or call a model.
- Changed runtime files pass ESLint; build script syntax and git diff whitespace checks pass. Independent source review found the remaining worker gate, which was fixed and reviewed again without further important findings.

Operational recovery is separate: an old quarantined device owner was verified dead together with its recorded worker PID and process group, then its lock directory was atomically archived with unchanged owner/quarantine hashes. Its task outcome remains unknown and no action was replayed. Private device/task identifiers and evidence remain outside this repository.

Not checked: real Calculator/Bilibili task after the fix, full runtime/desktop suites, Windows/Android/iOS GUI effects, packaged application installation. This branch is not merged into the shared checkout; earlier release acceptance applies to its recorded base candidate only.

## AX readback follow-up (2026-10-29)

The real Bilibili run passed screenshot and background search-field click, then stopped with `editor_readback_changed` after a value write. A later independent AX observation found the expected text; raising the window showed it and search suggestions. The write had applied asynchronously, after the immediate confirmation. The old task remains unknown and was not replayed.

Value and selection confirmations now poll read-only after one AX write, preserving process generation/window geometry, key-window, same-editor and secure-input checks on every sample. A nonoriginal/nonexpected value still refuses immediately; expiry remains unconfirmed. The poll has a monotonic 500ms deadline and at most50 samples, but cannot interrupt an in-flight synchronous AX call; the outer RPC timeout remains the hard bound. No fallback input or repeated write is attempted.

The asynchronous readback regression failed before the change; the final Swift harness passes19 assertions and the full helper compile/malformed-target test passes. Independent source review found no important remaining issue. Real search completion after this follow-up is still pending, separate from these unit results.
