# Computer Use in Build

Computer Use is opt-in for each local Build conversation on macOS and Windows. Plan never receives desktop tools. Disabling it revokes access and stops the current Build turn. Remote clients cannot authorize it.

## Setup and model capability

The current implementation shares the computer executor configuration: `COMPUTER_DISPLAY_ID`, `EXECUTOR_BASE_URL`, `EXECUTOR_MODEL`, `EXECUTOR_MODEL_FAMILY`, and `EXECUTOR_API_KEY`. Limits use `EXECUTOR_MAX_STEPS`, `EXECUTOR_TIMEOUT_SECONDS`, `EXECUTOR_SETTLE_MS`, and `COMPUTER_CLICK_HOLD_MS`. Keep credentials in local configuration. Build uses its own selected vision model to plan desktop actions; it does not invoke a second GUI planner. The shared configuration loader still validates executor-model settings.

macOS requires Screen Recording and Accessibility permissions. Windows requires the packaged process guardian. Whole-screen control requires one configured display. Platform, configuration, permission **and vision-model** preflight failures all block enabling.

A nonvision Build model receives **no desktop tools**. The host returns `vision_model_required` with an explicit instruction to switch to a vision-capable model. If the selected model changes after enabling, desktop calls are also refused. The persisted `direct` field is retained for compatibility and recomputed as current visual capability; it is not a delegation mode. Supported models are determined by the runtime vision-capability check, not inferred from arbitrary model names.

## Select and observe a window

On macOS, call `computer_screenshot` with `application`, the exact running application name or bundle ID. Nova resolves that application's focused window and binds the session to it without activating the application. Ambiguous or missing applications are refused. To start an application in the background, use an authorized `/usr/bin/open -g -a` command first.

A new session without `application` observes the whole screen; Build does not inherit `COMPUTER_MAC_WINDOW_PID` / `COMPUTER_MAC_WINDOW_ID`. Subsequent observations in a bound session retain its target. Switching to a different target requires a new session. Voice-dispatched execution may explicitly bind the configured PID/window pair.

The shared observation contains:

- `id`, `captured_at`, and an image scaled to a longest edge of 1280 pixels. Build journals store `image_ref`, not image bytes.
- `space.logical_width`, `space.logical_height`, and `space.scale` for coordinate mapping.
- `target` application/PID/window/title, or `null` for whole-screen capture; `focus` and `foreground` describe foreground identity.
- `ax.status`: `ok`, `unavailable`, `timeout`, or `truncated`; optional `ax.summary` and focused-field `ax.editor`.

macOS attempts AX observation for resolved foreground and background windows. Windows returns `ax: {status: 'unavailable'}`; this implementation has no UIA reader. AX is bounded, untrusted application data, never instructions. Secure text-field values are excluded. Background screenshots may contain stale pixels when an application does not repaint: combine image, AX and later observations, without treating field text alone as proof of submission or task completion.

## Inputs and freshness

The five tools are `computer_screenshot`, `computer_click`, `computer_type`, `computer_scroll`, and `computer_key`.

Every input must carry the **latest observation's `id` as `observationId`**. Click/scroll coordinates use the returned image. After every input, observe again before any subsequent input—including typing and keyboard shortcuts. A stale ID is refused with `observe_required`; a changed target or geometry is refused with `screen_changed`. Identity is checked again after approval. Do not retry uncertain effects blindly.

`computer_type` supports `mode: 'append' | 'replace'` (default `append`):

- `append` inserts at the caret, replacing a selected range as ordinary typing does.
- `replace` overwrites the focused field. Unsupported background replacement is refused rather than silently appended. Native background input is limited to 200 UTF-16 units per action; whole-screen input permits up to 4000.

Action receipts record `executionMode`: `background` for window-targeted delivery, or `activated` for foreground/global delivery, including a window that was already active. The latter is **not proof that Nova activated a window and not permission to activate another one**. There is no automatic foreground-activation fallback for unsupported background actions.

## Approval, ownership and verification

Each new session requires Connect approval. `ask` requires approval for each input; `never` still requires Connect approval. Application-scoped remembered consent is handled by the host. Authority is rechecked immediately before input.

Build and the voice executor share session/observation/action handling and the same desktop resource lease. Voice's existing lifecycle owns its lease; the shared session does not acquire it twice. Midscene remains the voice planner: AX enters its `aiAct` context only at startup, labelled with observation ID, capture time, untrusted provenance and a **may-be-stale** warning. It is not refreshed in planner context at every step.

Stop/cancellation waits for bounded input receipts and backend teardown. Session wall-clock and step limits remain enforced. Uncertain input or cleanup is not success: `cleanup_unknown` retains device/resource quarantine. Never remove locks to force another attempt. Resume requires a new observation. Build cannot finish after input without a newer screenshot; even a successful receipt or model-finished response does not itself prove the user's goal.

Screenshots are private, owner-only artifacts. Model history keeps only the newest two images. Images and AX sent to the selected model may contain sensitive application content.

## Acceptance boundary

Tests with fake devices or local scripted planners do not prove real model reasoning, microphone/voice interaction, packaged desktop UI, or Windows device behavior. Record those separately. See the [acceptance checklist](../../verification/build-computer-use.md); a source change or passing test is not a release record.
