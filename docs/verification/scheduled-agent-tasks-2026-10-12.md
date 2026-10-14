# Scheduled Agent Tasks — acceptance record

Local feature branch: `feature/scheduled-agent-tasks`, based on `89804c578da162b2382ee2198e612fb65bff6180`. All live profiles use isolated synthetic App records. This record does not certify a release, deployment, Windows desktop or physical phone.

## Behavior

- A shared Runtime service supports manual and Agent creation. Once, daily and weekly rules use IANA time zones, explicit DST handling and durable occurrence identities. Every occurrence runs a real Agent Task in an isolated execution conversation.
- The two editable suggestions are **每日优先级清单与风险提示** (09:00 daily) and **重点项目周度进展整理** (09:00 Monday). They are not enabled automatically. User-facing copy says **常用任务 / Suggested tasks** and **安排这个任务 / Set up task**; preset remains an internal API term.
- The worker reads current authorized App data at execution time. Verified reports arrive as normal body text in **the main conversation**. No fabricated user turn or automatic conversation switch is used. An already-open main conversation receives report context on the next model response after source authorization is rechecked.
- Optional cards open management/history. “Discuss result” returns to the main conversation. Saving a selected action as a Todo or Idea, optionally linked to a Goal, is explicit.
- Pause stops future occurrences; Stop cancels the current Task. An uncertain delivery after restart requires reconciliation instead of automatic reexecution. A user-confirmed continuation obtains a fresh execution fence.

## Automated checks

At `55b28472`, the complete root suite passed: Runtime 3,437 passed / 8 skipped; desktop 1,251 passed / 3 skipped; CLI 30 passed; server CLI 4 passed. `npm run check` and `npm run build` passed. The later recovery changes at `2bd706a5` passed 54 targeted recovery/runtime/control tests, Runtime lint and TypeScript compilation; the subsequent complete bounded-concurrency run passed 3,439 Runtime tests with 8 skips, 1,251 desktop tests with 3 skips, CLI 30 and server CLI 4. An initial full run had one unchanged 100ms speech-cleanup timing failure; its complete file passed 26/26 standalone before the full green rerun.

Flutter analyze passed. After the review fix, the complete Flutter suite passed 102 tests with one existing live-socket skip; schedule/store/workbench coverage passed 25 tests, and the final copy change passed all 8 schedule widget tests plus analyze. Desktop copy tests passed 3/3.

Live acceptance exposed integration defects and produced focused regressions: scheduled tool admission, background presentation, interrupted provider delivery, optional Feishu capture state on reopening, lost delivery reconciliation and renewal of the execution fence after explicit continuation. Two old memory retention fixtures had fixed dates outside the 30-day window; only fixture dates changed, leaving retention and consent intact.

## Real model and wall clock

The run at `55b28472` passed actual timed execution, fresh App data after rule creation, main-chat body and real-model follow-up, single delivery/adoption, restart after durable claim, and weekly execution/pause/resume/edit. Agent creation also happened, but the runner then rejected its correct `user_turn` authority because the assertion expected the wrong enum; that harness assertion was corrected.

A clean run at `2bd706a5` subsequently encountered an App pagination failure and did not complete. This failure is retained, not relabelled as a pass. The diagnostic rerun at the same production commit, with an additional observational cursor-error log in the harness, passed all eight checks (05:13:50–05:16:50 UTC). It covered actual timer execution, fresh data, main-chat follow-up, idempotent adoption, claim/restart, weekly management/execution, Agent clarification/creation and a real in-flight process kill. A deterministic regression also reproduced the misleading JSON/encoding error from a string `"null"` cursor; the host now reports an actionable invalid-cursor error, and the tool schema explicitly requires JSON null for the first page. The failed run did not record its cursor, so that exact argument remains unconfirmed.

An independent process-kill experiment at the recovery-fix working tree observed a real provider request in flight, killed only that child process, and restarted the normal production composition. Exactly one Task and one model request remained; the Task waited at `task_delivery_uncertain`. This proves no blind reexecution after an unknown result, not that the killed provider request had completed.

## Native macOS acceptance

Normal Electron startup at clean commit `2bd706a5`, using an isolated profile, passed:

1. Manual editable suggestion and real Agent creation of the weekly rule; rule persistence across restart.
2. Reconciliation of an interrupted scheduled delivery through native controls, followed by Continue and a real completed Agent report.
3. Report body directly visible in the main conversation, with a real-model follow-up in the same conversation.
4. Explicit adoption of the report's suggested action, edited to “补齐本周带日期的项目进展”, and verification in Todos.
5. Final “常用任务 / 安排这个任务” wording and visual layout.

These are full-window native captures, not HTML fixtures:

- [Suggested tasks and the main-chat report](scheduled-agent-tasks/03-suggested-tasks-main-report.png)
- [Main-chat follow-up](scheduled-agent-tasks/04-main-follow-up.png)
- [Adopted action in Todos](scheduled-agent-tasks/05-adopted-todo.png)

The native profile intentionally had no project evidence, and the report explicitly described that limitation. A separate Runtime live scenario uses populated synthetic project records to verify freshness and linkage.

## Platform limits

No registered iOS simulator/runtime was available, the paired iPhone was unavailable, and no authorized Android device was attached. Mobile automated tests do not replace physical-device acceptance. The existing Windows-only source startup smoke skips macOS; the normal macOS app was separately exercised above. Windows native acceptance is not claimed.

## Final regression and independent review

One fresh read-only review by `gpt-6-astra` examined `89804c57..43eab488`. It found four Important defects and no Critical/Minor findings. One fix pass was committed as `6816425f`:

1. Scheduled report bodies are excluded from automatic understanding intake, so an ordinary user turn cannot resend revoked report content to the support model. Main-chat follow-up retains its separate recipient-validated report context.
2. A report whose source changes before publication is safely settled without sending its content. Per-run publication failures no longer block startup or other work, and completed unpublished tasks release execution capacity. A main/feed commit remains the delivery receipt if acknowledgement was interrupted.
3. Both clients use ISO weekday 7 for Sunday in the editor and formatter.
4. Retired report references become unavailable context; stale focus is cleared without breaking ordinary chat.

Each finding was reproduced in a failing test before the fix. Runtime lifecycle/understanding/recovery/integration checks passed 27/27; desktop scheduling checks passed 7/7; Flutter analyze and the full 102-test suite passed. Final whole-suite and live results at this fix commit are recorded below. There was no second reviewer pass. No merge, push or release has been performed.

### Final verification at 6816425f

Production code was unchanged during these checks. The dirty-tree marker in the live reports refers only to this acceptance Markdown and subsequently added screenshots.

| Check | Result |
| --- | --- |
| Root typecheck and build | Passed |
| Runtime, bounded test concurrency 8 | 3,445 passed, 8 skipped, 0 failed |
| Desktop | 1,252 passed, 3 skipped, 0 failed |
| CLI / server CLI | 30 / 4 passed |
| Flutter analyze / full tests | No issues / 102 passed, 1 existing skip |

The final catalog run (05:46:03–05:51:50 UTC) passed six checks: shared API/idempotency and fresh data; real wall-clock/model/Task delivery; main-chat body and real follow-up; single delivery and explicit adoption; production restart after claim; weekly execution with pause/resume/edit. It then **failed** at Agent creation: the model reported a refused request, and the runner timed out. The original run did not capture the exact refused arguments or refusal code, so its cause is unconfirmed. This remains a failed complete-catalog run.

A separate diagnostic at the same production commit (05:53:46–05:54:00 UTC), adding only private observation of the creation controller, passed real Agent clarification and creation with the requested 09:00 Asia/Shanghai rule and Todos-only scope. It also passed the real in-flight child-process kill/restart: one Task, one model request, waiting at `task_delivery_uncertain`. Together these runs exercise all eight checks at the final code commit, but they are **not one uninterrupted eight-check pass**, and intermittent creation refusal remains an observed limitation. The diagnostic passed without changing production code or broadening authority.

Native macOS was repeated at the same commit: the editable suggestion opened, Sunday preview showed **2026-10-18 09:00**, saving retained Sunday correctly, and Run now produced a real report in the main conversation using the current adopted Todo. History showed completed after clicking Refresh history. Existing rules and reports survived normal app restart. Full-window captures:

- [Sunday editor and next occurrence](scheduled-agent-tasks/06-sunday-preview.png)
- [Sunday result in main conversation](scheduled-agent-tasks/07-sunday-main-report.png)

### Execution decisions

- Continued initial implementation while investigating the two preexisting memory failures; resolved them as stale fixture dates, without changing retention policy.
- Kept Windows-only startup smoke semantics and separately tested the actual macOS app.
- Fixed optional Feishu capture state because normal isolated native restart failed; covered fresh pause/reopen behavior.
- Ran the one read-only review alongside the final frozen-code regression. Any resulting fixes receive tests and a fresh full regression.
- Mobile and Windows native behavior remain unclaimed; platform-specific defects may remain unobserved.
- Model-based creation intent is verified for tested cases, not guaranteed universally; unseen interpretations remain a limit.
- Retained the unchanged 100ms cleanup test and production behavior; used bounded test concurrency after standalone and full reruns passed. This does not certify every load condition.
- Deployment, public-history publishing audit and release readiness remain outside this local feature delivery and are still required before any future publication.
- Preserved the final catalog failure and reported the narrower successful diagnostic separately; exact original refusal remains unconfirmed, and intermittent Agent creation failure may recur.

Deferred minor, observed during final native acceptance after review: an already-open history detail retains its running state until **Refresh history** is clicked. The main-chat report arrives automatically. This is recorded for a later UI polish pass.
