# Integration review — 2026-09-22

Scope: reconcile the uncommitted memory/Life continuation, source sampling/RSS language work, workbench redesign, and presentation/session integration on `v0.3.0dev`. This is source integration and regression evidence, not installed-release or physical-audio acceptance.

## Preservation check

- Saved the initial HEAD, staged patch, full tracked diff, untracked files and SHA-256 manifest before staging. Recovery material stays outside the public tree.
- Compared the IDE/Orb integration manifest: 33 of 36 paths were byte-identical. The remaining three were the documented later workbench changes in `personal-view.mjs`, `chat-pane.mjs` and `workbench.css`; presentation controls and coding-target bindings remain present.
- Compared the pre-integration snapshot's 137 paths. The only absent file is `personal-view.css`, intentionally replaced by `workbench.css`.
- The presence/session implementation plan existed locally but was excluded by the blanket `docs/superpowers/` ignore rule. It is explicitly included in the desktop integration commit.
- No missing implementation was found in these snapshots and the referenced task records. This does not establish completeness of edits that were never recorded in any available snapshot or task log.

## Workbench review

Two remaining defects were reproduced and fixed before committing:

1. Malformed Markdown link openers repeatedly searched the remaining reply. The existing 20,000-character timing test missed the quadratic behavior; 320,000 unmatched brackets took approximately 1.5 seconds. Forward delimiter searches now cache both hits and misses. A larger malformed-link regression fails before the fix and passes afterwards.
2. Feed presented receipts ignored document visibility and focus. A hidden or unfocused window could report presentation on snapshot refresh. Receipts now require a visible, focused workbench pane and retry when focus/visibility returns. The new regression fails before the fix and passes afterwards.

Also checked settings IPC sender/method validation and snapshot projection, safe external link routing, briefing bodies, task-to-chat navigation, collapsed-pane read receipts, and coexistence with presentation modes and coding targets. No additional blocking finding was established in that review scope.

## Verification

- Runtime full suite with local loopback access: 2,855 tests, 2,847 passed, 8 skipped, zero failures.
- Desktop source test collection: 1,008 tests, 1,005 passed, 3 skipped, zero failures.
- CLI: 21 passed. Live-runner contracts: 13 passed.
- Workbench focused regressions: 12 passed.
- Both intermediate commit runtime trees passed standalone TypeScript checks.
- The initial 169-path manifest was rechecked: only the seven reviewed production/test fix files changed during this task; all other content and the intentional CSS deletion were preserved.
- After lint cleanup, rebuilt runtime and reran the affected Feishu, consolidation and news tests: 27 passed.
- Runtime typecheck and ESLint passed. Eight lint errors in the incoming test changes were corrected without changing production behavior.
- The initial sandboxed runtime run could not open local endpoints and failed; it is not counted as a passing run. The full rerun above used loopback access.
- Physical microphone/speaker, actual account connectors, installed packages, real-model behavior and live settings deep-link acceptance were not rerun for this commit review. Earlier task-specific evidence retains its original scope.

## Commit boundaries

1. Auditable memory, Life state updates, model-processing consent and their acceptance harnesses.
2. Bounded source sampling and operating-system-language RSS selection.
3. Workbench/settings redesign plus presentation modes, approval waiting and independent coding-session ownership. These desktop features share entry points and are integrated together, with the review fixes included.
