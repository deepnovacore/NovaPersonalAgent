# Task Completion and Executor Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry explicitly delegated work through execution, verification, correction, and Todo synchronization, with task-scoped human takeover and automatic handback when leaving workbench.

**Architecture:** Add a small persistent task service beside the existing personal host. Reuse controller dispatch, work IDs, executor sessions, approvals, and Life mutations; enforce task ownership at instruction admission, then project the same state into conversation cards and expandable details. A durable task grant permits bounded continuation without fabricating a new user utterance.

**Tech Stack:** Existing Node.js >=22.13, TypeScript, Zod, bounded JSON persistence, Electron and vanilla renderer modules, node:test; no new dependency.

**Spec:** `docs/superpowers/specs/2026-09-22-task-loop-and-executor-interaction-design.md` (user approved in this conversation, including the three-correction default).

## Global Constraints

- “Recording a Todo or Idea does not authorize execution.”
- “The main composer and orb voice always address Nova.”
- “Leaving workbench mode automatically returns controlled tasks to Nova. Returning to the workbench does not take them over again.”
- “Handback never grants approval, revokes an existing approval by itself, submits a draft, or grants additional scope.”
- “Clearing a conversation does not silently cancel delegated work or erase its task record.”
- “Keep the existing single active run per coding workspace and existing global limits.” Current global coding limit is 3.
- Maximum three consecutive automatic corrective attempts after failed acceptance; explicit continue resets this allowance. Existing run deadlines still apply.
- Never replay an uncertain side effect automatically. Task controller, execution status, and approval are independent.
- Preserve public/internal separation. No pilot configuration, new runtime dependency, release, push, or deployment.
- Serial runtime builds: build deletes runtime/dist. Never test against a directory another worker is rebuilding.

## Review Focus

- A delayed Nova dispatch or verifier crosses takeover: Task 3 tests final-boundary fencing and Task 5 tests stale verification.
- A send succeeds but its acknowledgment is lost: Tasks 2 and 4 test receipts and uncertain dispatch without replay.
- A user changes a Todo while work finishes: Task 5 tests version conflict without overwriting or rerunning.
- Two views or clients control one task/session: Tasks 2 and 3 test ownership identity and exclusive active session binding.
- Renderer closes or conversation is cleared while work runs: Tasks 3 and 6 test task lifetime independence and reconnection before admission.

---

## Execution preparation and file responsibilities

Use an isolated worktree at execution time via using-git-worktrees. The current checkout has unrelated in-progress host, workbench-context, and desktop changes. Base on the approved design commit and subsequent committed changes; do not stash, reset, or copy uncommitted changes into the implementation. Reinspect the current context integration before touching shared host files. If an uncommitted change becomes an actual dependency, stop only that integration and identify it explicitly.

New production modules:

- `runtime/src/personal-agent/tasks.ts`: schema, serialized persistence, controller revisions, receipts and public event replay. Use BoundedJsonStore, under the existing personal-host process lock.
- `runtime/src/personal-agent/task-loop.ts`: event-driven continuation, verification decisions, three-correction budget and Todo reconciliation; no timer-based polling scheduler.
- `runtime/src/core/task-tools.ts`: model-facing task declaration/action schemas and descriptions, with source-reference authority.
- `clients/desktop/src/renderer/task-detail.mjs`: reusable cards/detail view, session selection, drafts and takeover controls.

Modify existing host/controller/transport/renderer files only at integration boundaries identified below. Keep work_owners backward compatible; add task references instead of reinterpreting the existing map. Do not relocate unrelated large-file code.

### Task 1: Persistent task identity and guarded state transitions

**Files:** Create tasks.ts and `runtime/test/personal-tasks.test.ts`; modify `runtime/src/personal-agent/host.ts` for open/close/snapshot integration.

**Interfaces:** Export these contracts from tasks.ts (schemas enforce them at input boundaries):

```ts
export type TaskPhase = 'queued'|'running'|'verifying'|'waiting'|'completed'|'cancelled'
export type TaskActor = {kind:'nova'} | {kind:'user'; client_id:string}
export interface TaskFence { task_id:string; control_revision:number; goal_revision:number }
export interface TaskInput {
  conversation_id:string; goal:string; acceptance:string[]; origin_ref:string
  todo_ref?:{id:string; version:number}
}
export interface TaskRecord extends TaskInput {
  id:string; phase:TaskPhase; controller:TaskActor
  control_revision:number; goal_revision:number; corrections:number
  work_ids:string[]; session_ids:string[]; evidence_refs:string[]
  waiting_reason:string|null; todo_sync:'none'|'pending'|'synced'|'conflict'
}
// TaskService(path: string); open(): Promise<void>; close(): Promise<void>
// delegate(requestId: string, input: TaskInput): Promise<TaskRecord>
// get(id: string): TaskRecord; list(): TaskRecord[]
// control(requestId: string, fence: TaskFence, actor: TaskActor,
//         next: TaskActor): Promise<TaskRecord>
// assertCurrent(fence: TaskFence, actor: TaskActor): void
// bindWork(fence: TaskFence, workId: string, sessionId?: string): Promise<void>
// reviseGoal(requestId: string, fence: TaskFence, actor: TaskActor,
//            goal: string, acceptance: string[]): Promise<TaskRecord>
```

- [ ] Write the initial runnable persistence test using node:test, tmpdir and the new service:

```ts
const path=join(await mkdtemp(join(tmpdir(),'nova-tasks-')),'tasks.json')
const tasks=new TaskService(path); await tasks.open()
const input={conversation_id:'c',goal:'Fix login',acceptance:['regression passes'],origin_ref:'user:1'}
const task=await tasks.delegate('request:1',input)
assert.equal((await tasks.delegate('request:1',input)).id,task.id)
await assert.rejects(tasks.delegate('request:1',{...input,goal:'Different'}),/request_conflict/)
await tasks.close()
const restored=new TaskService(path); await restored.open()
assert.equal(restored.get(task.id).goal,'Fix login')
await restored.close(); await rm(dirname(path),{recursive:true,force:true})
```

- [ ] Run `npm run build --workspace @nova-audio-agent/runtime`, then `node --test runtime/dist/test/personal-tasks.test.js`; initially expect missing module/API, then implement until green.
- [ ] Use `${personalPath}.tasks.json`, existing BoundedJsonStore with a 16 MiB bound, cloned staged state, write-before-publish, and one serialized mutation tail. Start absent files empty. No implicit task conversion from existing Todos. Validate nonempty bounded text and IDs; preserve active work when storage reaches capacity by rejecting new delegation visibly rather than evicting active records.
- [ ] Implement transitions with the existing ownership discipline:

```ts
// Inside the serialized write boundary; never mutate published state before persistence.
const next=structuredClone(state)
const task=next.tasks.find(item=>item.id===fence.task_id)
if(!task)throw Error('task_not_found')
if(task.control_revision!==fence.control_revision || task.goal_revision!==fence.goal_revision)
  throw Error('stale_task')
if(JSON.stringify(task.controller)!==JSON.stringify(actor))throw Error('not_controller')
task.controller=nextActor; task.control_revision++
await store.write(next); state=next
```

- [ ] Extend tests for failed disk writes leaving prior state unchanged, stale goal/control revisions, same request with different payload, and active session reuse refusal. A session may bind to a new task only after its previous active work is reconciled as idle.
- [ ] Commit only this task's files: `feat(tasks): persist delegated task identity and control`.

### Task 2: Host commands, receipts and acknowledged mode handback

**Files:** Modify `runtime/src/personal-agent/{contracts,host,tasks}.ts`, `runtime/src/desktop/desktop-control.ts`, `runtime/src/server/client-protocol.ts`; create `runtime/test/task-control.test.ts`.

**Interfaces:** Extend existing personal.command methods with `tasks.list`, `tasks.get`, `tasks.delegate`, `tasks.control`, `tasks.input`, `tasks.cancel`, `tasks.continue`. Existing envelope request_id is the idempotency key. `tasks.control` takes TaskFence plus `action:'takeover'|'return'`. `tasks.input` takes TaskFence, `session_id`, and bounded `text`. Never accept client_id as authoritative renderer input.

- [ ] Add a host-level test using the fixture style from personal-agent.test.ts: delegate, take over from authenticated client A, reject an input from B and a stale revision from A. Two same-ID command retries return the same receipt. A conflicting retry returns request_conflict.
- [ ] Run the runtime build and `node --test runtime/dist/test/task-control.test.js`; expect unknown task command before implementation.
- [ ] Derive client ownership from the authenticated transport. Keep the desktop host-owned client identity stable across websocket reconnect; do not reuse ephemeral connection_id as durable ownership. Propagate trusted client context to personal host command handling. An authenticated explicit return may release a disconnected owner's task; silently taking it over may not.
- [ ] Integrate handback into host presentation handling, before acknowledging mode exit. Return only tasks owned by the requesting workbench client, and do so idempotently with durable transition receipts. Preserve current background audio behavior if a handback write fails; report pending handback rather than pretending it completed.

```ts
if(previous==='workbench' && mode!=='workbench') {
  await tasks.returnClientTasks(requestId, trustedClientId)
}
// returnClientTasks(requestId: string, clientId: string): Promise<TaskRecord[]>
// performs one serialized durable mutation; it increments each affected control_revision.
```

- [ ] Pin in tests: mode exit returns two owned tasks but not another client's task; collapse/blur cannot invoke this command; duplicate mode request does not increment twice; disk failure does not acknowledge handback; pending approval remains unchanged.
- [ ] Keep tasks.input capability unavailable until Task 3 binds its transport handler. Commit `feat(tasks): arbitrate control and presentation handback`.

### Task 3: Bind dispatch and targeted input to durable task authority

**Files:** Modify `runtime/src/{core/work-tools,core/tool-schema,executors/agent-controller,realtime/tool-continuations,realtime/frontend-instructions,realtime/system-prompts.en}.ts`, `runtime/src/executors/codex/{controller,adapter-project}.ts`, `runtime/src/executors/coding/intake.ts`, `runtime/src/personal-agent/{conversation-runtime,conversations,tasks}.ts`; create core/task-tools.ts and `runtime/test/task-dispatch.test.ts`.

**Interfaces:** `TaskDispatchContext = {fence:TaskFence; origin_ref:string; stillWanted:()=>boolean}` is host-created and optional on existing AgentDispatchRequest. Define model tool `task` as a strict discriminated union: `declare` (goal, acceptance, source_refs), `revise` (task_id, goal, acceptance, source_refs), `continue` (task_id, source_refs), `return` (task_id, source_refs). A declare result exposes task_id. Add optional task_id to existing dispatch; preserve existing callers. Todo identity is injected from the explicit UI source context, never inferred from title matching.

- [ ] Write a deferred-dispatch race test: declare a task, let intake plan, acquire user control, then release the deferred plan; assert no executor instruction was admitted. Repeat with a deferred verifier in Task 5. Also test one task bound to two sessions: takeover fences both.
- [ ] Build and run `node --test runtime/dist/test/task-dispatch.test.js runtime/dist/test/agent-controller.test.js`.
- [ ] Register the task tool in core/tool-schema.ts and host-tool routing alongside dispatch/cancel/confirm; expose it only when the personal task host is available. Extend the runtime tool-schema tests so advertised operations and actual handlers stay aligned. Keep current origin checks for initial user tools. Admit model task declarations only against current final user input and selected source refs, using structured function calls, not keywords. Existing direct dispatch can create its task binding at work admission; project-only switch/create must not fabricate a completed task. Plain questions, Idea capture and context suggestions produce no task.
- [ ] For background continuation introduce a host-only continuation grant tied to task identity, goal/control revisions, and original authorized origin. Do not bypass #interceptHost by inventing a current user turn, and do not make arbitrary spontaneous model dispatch legal. Expose the optional grant in the controller request, validate it at admission and combine fences:

```ts
const stillWanted=()=>{
  if(!request.stillWanted())return false
  try { tasks.assertCurrent(taskContext.fence,{kind:'nova'}); return true }
  catch { return false }
}
// Carry stillWanted through intake resolution, dispatch and transport write admission.
```

- [ ] Direct user input bypasses semantic project selection but not validation: host resolves a task member session, checks client/revision, then calls supported steer for an active turn or existing resume/new-turn path for an idle session. Add an optional `beforeWrite:()=>void` callback to transport admission so validation happens after awaits immediately before writing the request. Record intent before dispatch; record accepted/failed/unknown afterward. If the socket dies after a possible write, mark unknown and reconcile; never blindly send it again.
- [ ] Keep task-owned execution alive independently of clearing/switching the foreground conversation. Detach the task work lifetime from conversation abort signals while preserving explicit task cancellation. Deliver late results via durable origin mapping; do not recreate cleared transcript messages or cancel executor work implicitly.
- [ ] Test forged session target, stale delayed direct send after mode exit, original-user origin retention, session continuation with the correct executor home, and conversation clearing while task runs.
- [ ] Commit `feat(tasks): fence executor instructions by task ownership`.

### Task 4: Replayable public execution events

**Files:** Modify tasks.ts, `runtime/src/executors/codex/{turn-projection,app-server-transport}.ts`, `runtime/src/desktop/{desktop-progress,desktop-wire}.ts`; create `runtime/test/task-events.test.ts`, extend codex-turn-projection.test.ts.

**Interfaces:** `TaskEvent = {seq:number; task_id:string; work_id?:string; session_id?:string; kind:'message'|'tool'|'artifact'|'control'|'verification'|'status'; text:string; refs:string[]}`. `appendEvent(event:Omit<TaskEvent,'seq'>, sourceKey:string):Promise<TaskEvent>` deduplicates provider events. `events(taskId:string, after:number):{items:TaskEvent[];next:number;truncated:boolean}`. `tasks.get` returns TaskRecord plus a page of events and adapter detail/input capabilities.

- [ ] Add a test that appends one provider event twice, reconnects after its cursor, and sees no duplicate; another event returns a larger stable seq. Out-of-order or wrong thread/turn IDs must not enter the task stream.

```ts
const event={task_id:task.id,kind:'message' as const,text:'Checking login',refs:[]}
const first=await tasks.appendEvent(event,'thread:1/turn:1/item:1')
assert.equal((await tasks.appendEvent(event,'thread:1/turn:1/item:1')).seq,first.seq)
assert.equal(tasks.events(task.id,first.seq).items.length,0)
```

- [ ] Run runtime build then `node --test runtime/dist/test/task-events.test.js runtime/dist/test/codex-turn-projection.test.js`.
- [ ] Project only protocol-supported public messages/tool activity/artifact references with exact task/work/thread/turn identity. Keep existing coarse progress working. Do not forward raw protocol blobs, credentials, private reasoning or arbitrary filesystem URLs.
- [ ] Persist accepted public items and control/verification events. Coalesce streaming display deltas; do not rewrite the ledger on every token. Page at 100 items and retain at most 1,000 display events per task, with an explicit truncated marker and original artifact references. Never prune active receipts, outcome evidence or control authority to meet display limits. Bound each public text to 16,000 characters with a visible truncation flag in the projection.
- [ ] Advertise summary-only mode for adapters without public event support; no fabricated transcript. Verify message attribution distinguishes user-to-executor, executor, and Nova summaries.
- [ ] Commit `feat(tasks): replay public executor activity`.

### Task 5: Event-driven completion, bounded correction and Todo reconciliation

**Files:** Create task-loop.ts and `runtime/test/task-loop.test.ts`; modify `runtime/src/personal-agent/{host,life,tasks}.ts`, `runtime/src/composition/realtime-assembly.ts`, `runtime/src/model/model-adapters.ts`.

**Interfaces:** `TaskDecision = {kind:'complete';evidence_refs:string[]}|{kind:'correct';instruction:string;evidence_refs:string[]}|{kind:'wait';reason:string;evidence_refs:string[]}`. `TaskLoop(tasks, ports)` consumes `evaluate(task, signal):Promise<TaskDecision>`, `execute(task, instruction, fence):Promise<void>`, and `syncTodo(task):Promise<'synced'|'conflict'>`. `wake(taskId:string):Promise<void>` coalesces per-task wakes and reads fresh state; `close():Promise<void>` joins evaluation. Add `applyDecision(fence:TaskFence, decision:TaskDecision):Promise<TaskRecord>` and a task-owned pending-effect receipt to TaskService.

- [ ] Write tests with small injected port functions: a real evidence ref permits completion; empty/fabricated refs do not. A failed check admits corrections 1–3, the next failed check waits; explicit continue resets the allowance. Intake/dispatch errors cannot spin forever under a failed check.
- [ ] Build and run `node --test runtime/dist/test/task-loop.test.js runtime/dist/test/life-backend.test.js`.
- [ ] Bind wakeups to terminal work results, acknowledged return, recovered resources/service, explicit continue and completed conversational delivery. Store original goal and latest accepted goal revision in the evaluation context. Await all active work belonging to the task before final acceptance. Never poll merely because the application is visible.
- [ ] Use the existing model adapter's structured-output machinery for TaskDecision. Supply resolved evidence from actual tool/result records and delivered content; reject references outside that task. A complete decision needs evidence covering the acceptance criteria. Missing checks become wait or bounded corrective work. Native conversation delivery is evidence only after actual completion, not generated/interrupted output.

```ts
const fence={task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision}
const decision=await ports.evaluate(task,signal)
await tasks.applyDecision(fence,decision) // rechecks Nova control and goal version
// Persist a pending effect before execute; reconcile an unknown effect, do not blindly retry.
```

- [ ] Replace the task-bound handoff shortcut that labels outcome ok as task completed. Legacy unbound work keeps its existing presentation; bound tasks publish completion only after verification. A cancelled task ignores late success. Manual takeover invalidates an in-flight verifier even if no goal text changed.
- [ ] On completion, durably mark todo_sync pending and call existing LifeService.mutate with op update, kind todo, captured expected_version, status done and deterministic receipt `task-complete:<task-id>:<goal-revision>`. Mark synced on receipt; version/state conflict becomes conflict. Retry projection without restarting execution. Leave unrelated Todo fields and manually edited states alone.
- [ ] Test a lost Life acknowledgment, a changed/cancelled Todo, interrupted Nova delivery, cancellation during evaluation, model failure, and concurrent completion/goal revision. Commit `feat(tasks): verify outcomes and reconcile linked todos`.

### Task 6: Recovery and real resource boundaries

**Files:** Modify tasks.ts, task-loop.ts, host.ts, `runtime/src/executors/codex/adapter-project.ts`, `runtime/src/executors/mcp.ts`; create `runtime/test/task-recovery.test.ts`.

**Interfaces:** A narrow optional adapter capability `taskResource():string|null` returns a host-resolved resource key for a configured computer-use endpoint. No model/client-provided resource identity. Use existing workspace slots for Codex; task service tracks queued task order and retries only after observed resource release. Unsupported/undeclared computer-use resource isolation is surfaced as unavailable for concurrent task execution.

- [ ] Test two tasks in the same workspace wait without a second run, while a different workspace runs within the global limit; use the existing codex-project-concurrency fixture. Test two computer-use calls with the same configured device key serialize and distinct device keys do not block each other.
- [ ] Build and run `node --test runtime/dist/test/task-recovery.test.js runtime/dist/test/codex-project-concurrency.test.js runtime/dist/test/codex-project-store.test.js`.
- [ ] Reconcile work receipts and persistent project/session identities on startup before any new task instruction. Read known session state and available outcome evidence. Uncertain side effects or unavailable resume become waiting; do not make a new thread as silent fallback or replay an unknown input.
- [ ] On task-loop startup wake Nova-controlled nonterminal tasks only after reconciliation. Preserve disconnected user control; explicit authenticated return releases it and increments revision. Expose task list access even when the origin conversation has been cleared.

```ts
switch(recoveredEffect){
 case 'accepted': /* observe existing work, do not dispatch again */ break
 case 'not_written': /* retry only after current grant and resource checks */ break
 case 'unknown': /* persist waiting_reason='uncertain_recovery' */ break
}
```

- [ ] Test crash after intent persistence/before write, after possible write/before receipt, and after task completion/before Todo sync. Same desktop execution remains exclusive during user messaging takeover; physical user operation requires explicit stop/pause supported by the adapter.
- [ ] Do not build a new computer-use provider: apply the boundary to registered adapters and test it with an injected adapter. Real external-device acceptance remains separately required.
- [ ] Commit `feat(tasks): recover task authority without replaying effects`.

### Task 7: Conversation cards and expandable executor interaction

**Files:** Create task-detail.mjs and `clients/desktop/test/task-detail.test.mjs`; modify `clients/desktop/src/renderer/{chat-pane,personal-view,personal-controller,tasks-page,life-view,messages.en}.mjs`, `clients/desktop/src/renderer/workbench.css`, and existing chat-pane tests.

**Interfaces:** `mountTaskDetail(root,{command,onClose,storage})` returns `{update(detail),receive(event),dispose()}`. Export `taskDraftKey(clientId,taskId,sessionId)` for local draft storage. Cards reference opaque task IDs; selecting a session changes only detail input target, never conversation coding_target.

- [ ] Extend existing fake-DOM test style to assert browsing sends no control command; takeover enables an explicitly labeled executor composer only after receipt. Nova composer still calls its original submit path. Use the existing fixture rather than adding a DOM framework.

```js
assert.notEqual(taskDraftKey('a','t1','s1'),taskDraftKey('a','t1','s2'))
assert.notEqual(taskDraftKey('a','t1','s1'),taskDraftKey('b','t1','s1'))
```

- [ ] Run `node --test clients/desktop/test/task-detail.test.mjs clients/desktop/test/chat-pane.test.mjs`; initially expect missing module, then implement.
- [ ] Render compact stable cards in the origin conversation. On expand, use the main workbench content region for detail while keeping Nova chat available; on narrow layouts use one panel at a time with an obvious back button preserving drafts and scroll. Never rebuild the focused composer on every progress event.
- [ ] Detail offers session selector, public activity, artifacts, existing approval controls, Take over and reply / Return to Nova, and explicit Stop. Only show controls the adapter supports. Escape returns to the originating card without changing control; restore keyboard focus. Give status updates polite live regions, not per-token announcements.
- [ ] Persist draft per trusted client/task/session locally. Clear only after accepted input receipt; retain on failure/unknown response and disable retry while reconciliation is pending. Display recipient and old-control-period draft state. Do not auto-submit on session switch or handback.
- [ ] Change Todo assistance to pass id/version into delegation context; keep source identity alongside the prepared draft until submission, then create the task through the host. Record-only flows remain unchanged. Existing tasks page uses durable tasks rather than expiring banner entries and links directly to the right task result.
- [ ] Test two task cards, multi-session switching, hostile message text, keyboard focus, scroll stability during live events, draft isolation, stale input errors and unsupported adapter detail. Commit `feat(desktop): inspect and take over delegated tasks`.

### Task 8: Orb handback feedback and end-to-end acceptance

**Files:** Modify `clients/desktop/src/renderer/{personal-controller,task-banner,index,messages.en}.mjs`, `clients/desktop/src/main/main.mjs` only as necessary for task deep links; extend personal-controller.test.mjs and create `clients/desktop/test/task-handoff.test.mjs`. Add `docs/testing/task-loop-acceptance.md` for reproducible manual checks.

**Interfaces:** Extend presentation result with `returned_task_ids` and authoritative task control revisions. Add taskNotice:string to the existing personal controller and render it as a polite status message. Existing presentation mode remains authoritative. Opening a task requests workbench mode then selects task detail; it never requests takeover.

- [ ] Add controller tests: workbench→orb and →background return all owned tasks once; a failed acknowledgment shows pending state; reconnect reconciles receipts; return to workbench shows Nova control. Blur/collapse/chat selection cause zero handbacks.
- [ ] Run `node --test clients/desktop/test/task-handoff.test.mjs clients/desktop/test/personal-controller.test.mjs`.
- [ ] Add quiet handback feedback, aggregate task counts, prioritized decision/result notification and task deep links. Preserve voice target Nova, background capture suppression, and existing approval ownership. Show changes since last viewed event cursor, not an invented model-generated activity history.

```js
// Feedback must be receipt-driven, not an optimistic local controller toggle.
if(result.ok && result.returned_task_ids.length) {
  controller.taskNotice='已交还 Nova，未发送的草稿已保留'
  controller.changed()
}
```

- [ ] Run serially: `npm run test:runtime`, `npm run test:desktop`, `npm run test:cli`, `npm run test:server-cli`, then `npm run lint --workspace @nova-audio-agent/runtime`. Record inherited failures separately; do not fix unrelated code. Never claim these passed without captured results.
- [ ] Record real desktop acceptance: delegate two tasks; browse; take one over; send a correction; retain a second unsent draft; switch to orb; converse with Nova; return and inspect changes. Repeat mode exit with pending approval, network interruption and an active executor turn. Confirm no automatic approval, draft send or duplicate instruction.
- [ ] Run one real Codex task with failing then passing regression checks and linked Todo; one Nova-only delivered plan; one configured computer-use operation with observable result and exclusive device ownership. If a provider/device is unavailable, mark that gate blocked with the exact missing prerequisite rather than substituting a simulated result.
- [ ] Commit `feat(desktop): complete task handback and acceptance flows`; attach proof-layer results to the final review. No release/push is implied.

## Self-review and implementation handoff

Coverage: spec scenarios 1–3 map to Tasks 1/3/5/7; 4–5 to 2/3/5; 6–8 to 2/4/7/8; 9 to 6; 10–11 to 5; 12 to 6; 13 to 7/8. Every Review Focus item has an owning regression test. The production sequence is serial because each task consumes prior ownership/persistence contracts.

Review this plan before execution. Recommended method: subagent-driven, with one task implemented at a time and independent review at each boundary; the main benefit is catching ownership and side-effect races before the UI obscures them. Native implementation with one final independent review is a lower-cost alternative. The user has not yet selected an execution method.
