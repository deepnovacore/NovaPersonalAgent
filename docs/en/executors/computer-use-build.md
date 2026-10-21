# Computer Use in Build

Computer Use is an opt-in, per-conversation capability for local Build on macOS and Windows. Plan conversations never receive computer tools. Turning it off removes access and stops the current Build turn.

## Setup

Configure the existing computer executor with `COMPUTER_DISPLAY_ID`, `COMPUTER_BASE_URL`, `COMPUTER_MODEL`, `COMPUTER_MODEL_FAMILY` and `COMPUTER_API_KEY`. Its step, timeout, settling and click-duration limits use `COMPUTER_MAX_STEPS`, `COMPUTER_TIMEOUT_SECONDS`, `COMPUTER_SETTLE_MS` and `COMPUTER_CLICK_HOLD_MS`. Consult the generated environment reference for supported values and defaults; credentials belong in local configuration, not the project.

On macOS, grant Screen Recording and Accessibility permissions to the desktop application. On Windows, the packaged process guardian is required. Full-desktop control requires one configured display. Optional background Safari targeting uses `COMPUTER_MAC_WINDOW_PID` and `COMPUTER_MAC_WINDOW_ID`; its Connect prompt must identify the window and temporary keyboard-focus behavior.

Enable Computer Use from the local desktop Build conversation. Preflight reports unsupported platform, invalid configuration and missing permissions. Remote clients cannot authorize this switch.

## Tools and models

A vision-capable Build model receives screenshot, click, type, scroll and key tools, plus `computer_run` for synchronous delegation. Coordinates refer to the latest returned screenshot, scaled to a longest edge of 1280 pixels. Each click or scroll needs a fresh screenshot; typing and keys may follow a click directly.

The current Build vision allowlist is:

- Qwen: `qwen3-vl-plus`, `qwen3-vl-flash`, `qwen-vl-max`, `qwen-vl-plus`.
- StepFun: `step-3.7-flash`.
- Ark: `doubao-seed-2-0-pro-260215`.

Other model IDs are not assumed to support images. They receive delegation only, with a `vision_model` preflight notice. The Build model and the computer executor's `COMPUTER_MODEL` are separate settings.

## Approval, Stop and recovery

Every new direct-control lease requires Connect approval. With local tool approval set to `ask`, each input also requires approval; with `never`, Connect still requires approval. Delegated computer tasks retain their executor approvals.

Stop aborts the turn and waits for backend cleanup. Turning Computer Use off does the same. A timeout or unconfirmed cleanup is not success: uncertain input is recorded as `outcome_unknown`, and uncertain device cleanup retains both resource and device quarantine. Do not remove locks to force another action.

Resume requires a fresh observation before any direct input. Build cannot finish after an input until a newer screenshot is available; delegation returns a final observation. An executor's model-finished response alone is not proof that the user's goal was achieved.

Screenshots are private Build artifacts with owner-only file permissions. Journals keep references instead of image bytes; model history retains only the newest two images and replaces older ones with text placeholders. Screenshots sent to the selected model may contain sensitive screen content.

## Acceptance status

Automated tests use fake backends and never operate the real screen. A passing unit test is not macOS or Windows device acceptance. Real-device validation must separately check permissions, coordinate accuracy, approvals, Stop/Resume, competing task ownership, and that desktop overlays are visible to the user but absent from model screenshots.

Integration still requires the synchronous delegation bridge, selected Build-model capability wiring and executor queue behavior to be verified together. Do not treat this setup guide as a release or real-device verification record.

Use the [device acceptance checklist](../../verification/build-computer-use.md) for separate macOS and Windows verification.
