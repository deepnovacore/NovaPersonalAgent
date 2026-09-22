# Task loop and executor interaction acceptance

Run against an isolated desktop profile and disposable local project. Do not use production Todos, publish artifacts, send external messages, or copy credentials into fixture files. Automated evidence and real product/device evidence are separate gates.

## Automated checks

Run serially from the repository root because runtime builds replace `runtime/dist`:

```sh
npm run test:runtime
npm run test:desktop
npm run test:cli
npm run test:server-cli
npm run lint --workspace @nova-audio-agent/runtime
npm run check
```

Focused UI: `node --test clients/desktop/test/task-handoff.test.mjs clients/desktop/test/personal-controller.test.mjs clients/desktop/test/task-detail.test.mjs clients/desktop/test/chat-pane.test.mjs`.
Host receipt coverage: `node --test runtime/dist/test/task-control.test.js` after a serial runtime build.
Capture commands, exit status, test counts, skipped checks, and named failures. Do not substitute a mocked adapter or direct host command for live acceptance.

## Real product protocol

1. Start the source desktop using a disposable `--user-data-dir` and isolated host persistence. Confirm actual configured model, Codex, and managed computer-use discovery without printing credential values. Record application revision and fixture directory.
2. Create a disposable Todo in the UI. Use its assistance action to delegate a local coding task with explicit acceptance: fix a known defect, show its failing then passing regression, and inspect the result through configured computer use. Also delegate a separate Nova-only deliverable, such as a short three-step plan.
3. Inspect both cards in their origin conversation and the tasks page. Browse, switch sessions, change conversations, blur the window, and close/reopen the inspector. Confirm none of those actions acquires or returns control. Main composer must still address Nova.
4. Explicitly take over the coding task. Verify the host controller and control revision before the executor composer enables. Send one correction to the displayed exact session; check the accepted input receipt. Leave another message unsent. Switch away and back to verify its task/session draft isolation.
5. Switch workbench to orb using the mode control; repeat through tray/hotkey/collapse requests. While awaiting acknowledgment, expect pending feedback. Only a host receipt with returned task IDs and control revisions permits the returned-to-Nova notice. Ensure every task owned by this client returns once, other clients retain control, and no draft, approval, cancellation, or extra instruction is sent.
6. Converse with Nova in orb. Verify aggregate task counts and that a decision or new result is prioritized above ongoing tool activity. Open its task link: workbench must open before detail and the controller must remain Nova. Check exact new public events since the previous view, artifacts, and outstanding decisions. Missing/truncated history must remain visibly qualified.
7. Repeat exit during an active executor turn and an actual pending approval. Existing approval identity and decision remain unchanged until explicitly acted on. Takeover does not claim physical device control; use the adapter's explicit stop/pause before manually operating its surface.
8. Interrupt the connection while an exit acknowledgment is outstanding, then reconnect. Check the original presentation request ID and parameters are retried and reconciled, with no duplicate handback or instruction. An attempted return to workbench must first reconcile the outstanding exit. Unknown input delivery remains blocked pending exact receipt reconciliation; do not resend with a new ID.
9. Observe the real Codex run repair the fixture, capture failing and passing check output, and use the real configured computer-use tool to activate the fixture and read back its result. Verify same-device calls are exclusive. Confirm task verification, completion, linked Todo projection, and artifact references. A passing executor summary alone is insufficient.
10. Confirm the Nova-only deliverable was actually delivered and verified without a fabricated executor session. Verify keyboard opening/Back/Escape, focus restoration, narrow layouts through 959px, long activity scroll, and preserved unsent drafts. Background must stop capture and must not speak the handback notice.

## Evidence record

Complete each row with dated evidence, exact revision, and links to local logs/screenshots. An unavailable gate must name the missing provider, adapter, permission, or device prerequisite.

| Gate | Evidence at implementation handoff |
| --- | --- |
| Automated runtime/desktop/CLI checks | Runtime 2943 passed / 8 skipped; desktop 1027 passed / 3 skipped; CLI 21 passed; server CLI 4 passed; repository check passed. Final focused UI 48 passed. See isolated Task8 logs for revision and command context |
| Real Nova text/model preflight | Parent observed preflight only; not task completion evidence |
| Two live tasks / takeover / accepted correction / retained draft | Pending parent acceptance |
| Orb/background / tray/hotkey / reconnect / pending approval | Pending parent acceptance |
| Real Codex failing-then-passing task and linked Todo | Pending parent acceptance |
| Real computer-use observable result and exclusive device | Pending parent acceptance |
| Nova-only verified deliverable | Pending parent acceptance; initial live attempt exposed a separate verification prerequisite issue |
| Keyboard / focus / narrow layout / scroll | Automated fixture coverage; real GUI pending parent acceptance |

No live task-loop acceptance is claimed by this document at implementation handoff.
