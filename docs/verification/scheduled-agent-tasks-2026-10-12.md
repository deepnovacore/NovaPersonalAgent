# Scheduled Agent Tasks — acceptance record

Local feature branch: `feature/scheduled-agent-tasks`, based on `89804c578da162b2382ee2198e612fb65bff6180`. All live profiles use isolated synthetic App records. This record does not certify a release, deployment, Windows desktop or physical phone.

## Behavior

- A shared Runtime service supports manual and Agent creation. Once, daily and weekly rules use IANA time zones, explicit DST handling and durable occurrence identities. Every occurrence runs a real Agent Task in an isolated execution conversation.
- The two editable suggestions are **每日优先级清单与风险提示** (09:00 daily) and **重点项目周度进展整理** (09:00 Monday). They are not enabled automatically. User-facing copy says **常用任务 / Suggested tasks** and **安排这个任务 / Set up task**; preset remains an internal API term.
- The worker reads current authorized App data at execution time. Verified reports arrive as normal body text in **the main conversation**. No fabricated user turn or automatic conversation switch is used. An already-open main conversation receives report context on the next model response after source authorization is rechecked.
- Optional cards open management/history. “Discuss result” returns to the main conversation. Saving a selected action as a Todo or Idea, optionally linked to a Goal, is explicit.
- Pause stops future occurrences; Stop cancels the current Task. An uncertain delivery after restart requires reconciliation instead of automatic reexecution. A user-confirmed continuation obtains a fresh execution fence.

## Automated checks

At `55b28472`, the complete root suite passed: Runtime 3,437 passed / 8 skipped; desktop 1,251 passed / 3 skipped; CLI 30 passed; server CLI 4 passed. `npm run check` and `npm run build` passed. The later recovery changes at `2bd706a5` passed 54 targeted recovery/runtime/control tests, Runtime lint and TypeScript compilation; final whole-branch regression and review are recorded below when complete.

Flutter analyze passed. The complete Flutter suite passed 101 tests with one existing live-socket skip; schedule/store/workbench coverage passed 25 tests, and the final copy change passed all 8 schedule widget tests plus analyze. Desktop copy tests passed 3/3.

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

Pending completion of the final live diagnostic and review. No merge, push or release has been performed.
