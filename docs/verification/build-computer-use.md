# Build Computer Use device acceptance

Status: **not verified on real macOS or Windows devices**. Fake-backend tests and type-checks are not device or release acceptance. Run this checklist separately on each platform and record the tested commit, packaged application version, OS version, selected display, Build model and computer executor model. Never record credentials or confidential screenshots here.

- [ ] Enable from a selected local Build conversation; verify remote clients and Plan cannot enable control.
- [ ] macOS: deny Screen Recording or Accessibility and verify preflight refuses; grant both and retry.
- [ ] Windows: verify the packaged process guardian starts and can terminate the backend on Stop.
- [ ] With a vision Build model, inspect a harmless test window, click known targets and confirm scaled screenshot coordinates match.
- [ ] With a nonvision Build model, expose no desktop tools; verify enabling is blocked with an explicit vision_model_required limitation.
- [ ] With ask approval, refuse Connect, then refuse an input; neither refusal may send input.
- [ ] With never approval, Connect still requires approval; disabling control must prevent any subsequent input.
- [ ] Stop during an input; verify backend cleanup, overlay removal, and no replay on Resume.
- [ ] Resume after an uncertain outcome; require a fresh screenshot before input.
- [ ] Refuse finish_build after input until a newer screenshot exists.
- [ ] Start a competing computer task and verify it cannot control the screen while Build holds the lease.
- [ ] Confirm overlays are visible to the user but absent from screenshots sent to the model.
- [ ] Verify screenshot artifacts are private and journals contain references, not image bytes.
- [ ] Record failures and uncertain cleanup honestly; never delete quarantine locks to force a pass.

Do not operate real accounts, send messages, publish content or enter credentials as part of this checklist.
