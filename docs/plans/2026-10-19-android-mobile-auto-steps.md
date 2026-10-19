# Android native task automatic steps

User request: create a branch, automatically allow every Android mobile-use step, and perform Android live acceptance.

Design: starting a task authorizes execution within its selected app. The native controller immediately grants a single-use permit bound to the observed action and screen. It never publishes waiting_approval or displays a per-step overlay. Stop, target package checks, current-screen checks, action budgets, durable attempt deduplication, password field restrictions, and final user verification remain enforced. Model instructions and Android consent copy describe automatic execution. iOS behavior is unchanged.

Alternatives considered: tapping approval buttons from Flutter would retain the race and waiting state; deleting all action permits would unnecessarily weaken stale-action checks. Automatic native permits keep the existing execution boundary without user interaction.

## Implementation and verification

- [x] Add regression assertions for automatic model instructions and Android start copy; observe failures with the existing implementation.
- [x] Replace native approval waiting with immediate, screen-bound authorization and remove unused Android approval overlay code. Retain the legacy approve command as a rejected compatibility call.
- [x] Update Android task and Hub acceptance copy, and native real-model fixtures to fail if a per-step approval is requested.
- [x] Run native unit tests, focused Flutter tests and Flutter analysis using isolated external outputs/caches.
- [x] Build the isolated .autonomy candidate, have the user enable its accessibility service, and run a real model against a multi-step synthetic counter and the user-selected Xiaohongshu search (replacing the calculator case). Independently inspect target UI and durable native receipts; verify stop and replay without repeating dispatched actions.
- [x] Record source state, APK hash, device, model, exact checks and limitations in the acceptance report; commit the reviewed change locally.

Build storage: external volume /Volumes/sqxh-junjie; namespace uses canonical worktree hash and chat ID. No publishing or merge is part of this task.

Live-driven fixes also bound pre-dispatch replanning, initial launch observation, screenshot throttling and transient loading observation; the Stop overlay no longer covers top navigation. The final normal APK was installed preserving data, and the duplicate .autonomy package was uninstalled. See the dated acceptance report for exact evidence and model limitations.
