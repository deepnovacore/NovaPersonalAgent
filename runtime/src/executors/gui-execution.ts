import {taskGrantService} from '../personal-agent/tasks.js'
import {randomUUID} from 'node:crypto'
import {mkdir} from 'node:fs/promises'
import {z} from 'zod'
import {executorManifestSchema} from '../core/ports.js'
import type {ExecutorAdapter, ExecutorDispatchContext, ExecutorHandoff} from '../core/causal-runtime.js'
import type {HostApprovalController} from '../core/approval.js'
import type {AgentController, AgentRuntimeDispatchPort} from './agent-controller.js'
import {acquireDeviceLock, recordDeviceProcess, quarantineDeviceLock, releaseDeviceLock} from './device-lock.js'
import {acquireTaskResources, taskResourcesBusy, taskResourcesUncertain, quarantineTaskResources} from './task-resources.js'
import {rememberGuiFrame} from './gui-evidence.js'
import type {GuiProgress} from './gui-runner.js'

const instructionSchema = z.string().trim().min(1).max(4000)
const requestSchema = z.object({instruction: instructionSchema, run_id: z.string().uuid()}).strict()
const resultSchema = z.object({code: z.enum(['model_finished', 'declined', 'cancelled', 'timeout', 'step_limit',
  'action_failed', 'model_failed', 'screen_changed', 'needs_user_action', 'invalid_configuration', 'cleanup_unknown']),
  steps: z.number().int().min(0).max(100)}).strict()
function handoff(code: string, outcome: ExecutorHandoff['outcome'], extra: Record<string, string | number> = {}): ExecutorHandoff {
  return {outcome, trust: 'untrusted_external', content: {code, verified: false, effects: 'unknown', ...extra}}
}

export class GuiExecutionLifecycle implements ExecutorAdapter {
  get descriptor() {return this.identity.descriptor}
  readonly manifest
  #reservation: string | null = null
  #delegateId: string | null = null
  #active: {abort: AbortController; done: Promise<ExecutorHandoff>} | null = null
  #closed = false
  constructor(readonly config: {budgetMs: number; lockRoot: string; deviceType: string; deviceId: string; target?: string},
    readonly approvals: HostApprovalController,
    readonly runner: (budgetMs: number, instruction: string, options: {signal: AbortSignal;
      beforeWrite?: () => void; capture?: (image: string, steps: number) => void; recordProcess?: (pid: number) => Promise<void>; approve: (actionName: string, params: unknown) => Promise<boolean>; progress: (event?: GuiProgress) => void}) => Promise<{code: string; steps: number}>,
    readonly identity: {descriptor: {name: string; summary: string; ownedChannels: readonly string[]}; displayName: string; project: string; title: string}) {
    this.manifest = executorManifestSchema.parse({name: identity.descriptor.name, display_name: identity.displayName, roles: [], approvals: true,
      model_visibility: 'hidden', probe_policy: 'none', ops: [{name: 'run', description: 'Run a supervised screenshot-driven task.',
        params: {type: 'object', properties: {instruction: {type: 'string', minLength: 1, maxLength: 4000}, run_id: {type: 'string'}},
          required: ['instruction', 'run_id'], additionalProperties: false}, readonly: false, confirm: false,
        deadline_budget: config.budgetMs / 1000 + 5, verifies: [], sensitive_params: ['instruction'], sync_result: false}],
      policy: {channel: this.descriptor.name, priority: 50, wake: 'surrogate', typical_latency: 10, compress_watermark: 8000, progress_via_surrogate: true}})
  }

  controller(port: AgentRuntimeDispatchPort): AgentController {
    return {descriptor: this.descriptor, dispatch: async request => {
      if (request.continuationGrant) {try {const tasks = taskGrantService(request.continuationGrant); tasks.validateContinuation(request.continuationGrant); if (request.taskContext !== request.continuationGrant) throw Error('invalid_continuation')} catch {return {code: 'superseded', accepted: false, detail: {}}}}
      if (!request.stillWanted() || request.taskContext?.stillWanted() === false) return {code: 'superseded', accepted: false, detail: {}}
      if (this.#closed) return {code: 'runtime_rejected', accepted: false, detail: {}}
      if (this.#reservation !== null) return {code: 'busy', accepted: true, detail: {}}
      const instruction = instructionSchema.safeParse(request.instruction)
      if (!instruction.success) return {code: 'clarification_required', accepted: true, detail: {}}
      const runId = randomUUID()
      this.#reservation = runId
      try {
        const admitted = await port.dispatch({...(request.taskContext ? {taskContext: request.taskContext} : {}), channel: this.descriptor.name, op: 'run', request: {instruction: instruction.data, run_id: runId},
          origin_ref: request.origin_ref, stillWanted: () => {
            const wanted = this.#reservation === runId && !this.#closed && request.stillWanted()
            if (!wanted && this.#reservation === runId && this.#active === null) this.#reservation = null
            return wanted
          }})
        if (!admitted.accepted || admitted.delegate_id === null) {
          if (this.#reservation === runId) this.#reservation = null
          return {code: 'runtime_rejected', accepted: false, detail: {}}
        }
        this.#delegateId = admitted.delegate_id
        return {code: 'delegated', accepted: true, delegate_id: admitted.delegate_id, detail: {channel: this.descriptor.name, op: 'run'}}
      } catch {
        if (this.#reservation === runId) this.#reservation = null
        return {code: 'runtime_rejected', accepted: false, detail: {}}
      }
    }, cancel: async request => {
      if (!request.stillWanted()) return {code: 'superseded', accepted: false, detail: {}}
      if (this.#reservation === null) return {code: 'not_running', accepted: true, detail: {}}
      if (this.#delegateId !== null) port.cancelPendingDispatch?.(this.#delegateId)
      this.#active?.abort.abort()
      await this.#active?.done
      if (this.#active === null) this.#reservation = null
      this.#delegateId = null
      return {code: 'accepted', accepted: true, detail: {}}
    }}
  }

  admitRequest(op: string, request: Readonly<Record<string, unknown>>) {
    const parsed = requestSchema.safeParse(request)
    return op === 'run' && parsed.success && parsed.data.run_id === this.#reservation && !this.#closed
      ? {ok: true as const, request: parsed.data, sync_result: false} : {ok: false as const}
  }

  async dispatch(op: string, request: Readonly<Record<string, unknown>>, context: ExecutorDispatchContext): Promise<ExecutorHandoff> {
    const admission = this.admitRequest(op, request)
    if (!admission.ok || this.#active !== null) return handoff('invalid_request', 'refused')
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, context.signal])
    const done = this.#run(admission.request.instruction, admission.request.run_id, context, signal)
      .catch(() => signal.aborted ? handoff('cancelled', 'cancelled') : handoff('runner_failed', 'unknown'))
    this.#active = {abort, done}
    try { return await done } finally { this.#active = null; this.#reservation = null; this.#delegateId = null }
  }

  cancelWork(workId: string): void {
    if (this.#delegateId !== workId) return
    if (this.#active) this.#active.abort.abort()
    else {this.#reservation = null; this.#delegateId = null}
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#active?.abort.abort()
    await this.#active?.done
    this.#reservation = null
  }

  async #run(instruction: string, taskId: string, context: ExecutorDispatchContext, cancelled: AbortSignal): Promise<ExecutorHandoff> {
    if (cancelled.aborted) return handoff('cancelled', 'cancelled')
    const budgetMs = Math.floor(Math.min(this.config.budgetMs, Math.max(0, ((context.delegate.deadline ?? Infinity) - context.clock.now()) * 1000)))
    if (budgetMs <= 0) return handoff('timeout', 'unknown')
    const deadline = AbortSignal.timeout(budgetMs)
    const signal = AbortSignal.any([cancelled, deadline])
    await mkdir(this.config.lockRoot, {recursive: true, mode: 0o700})
    const acquired = await acquireDeviceLock(this.config.lockRoot, this.config.deviceType, this.config.deviceId, taskId)
    if (!acquired.ok) return handoff(acquired.reason, 'refused')
    const resource = `${this.config.deviceType}:${this.config.deviceId}`
    let releaseResource: (() => void) | undefined
    const session = `gui:${taskId}`
    const target = this.config.target ?? resource
    let readback = ''
    const approval = this.approvals.forWork({work_id: context.delegate.delegate_id, project: this.identity.project, title: this.identity.title})
    const observed: Record<string, string | number> = {}
    let activity = 0
    let quarantined = false
    try {
      if (taskResourcesBusy([resource])) await context.resourceWaiting?.(taskResourcesUncertain([resource]) ? 'computer_resource_uncertain' : 'computer_resource_busy')
      releaseResource = await acquireTaskResources([resource], signal)
      await context.resourceWaiting?.(null)
      await context.bindSession?.(session, target)
      let result: ExecutorHandoff
      try {
        signal.throwIfAborted()
        const returned = resultSchema.parse(await this.runner(budgetMs, instruction, {signal, ...(context.beforeWrite ? {beforeWrite: context.beforeWrite} : {}), capture: (image, steps) => {
          const imageRef = rememberGuiFrame(image, {work: context.delegate.delegate_id, session, target})
          readback = 'Screenshot captured'
          context.activity?.({thread_id: session, turn_id: taskId, item_id: randomUUID(), stage: 'completed', kind: 'tool',
            text: JSON.stringify({type: 'guiObservation', status: 'completed', target, readback: 'Screenshot captured', image_ref: imageRef, steps, captured_at: new Date().toISOString()}), refs: []})
        }, recordProcess: pid => recordDeviceProcess(acquired.lock, pid),
          approve: async (actionName, params) => {
            if (signal.aborted || !/^[A-Za-z][A-Za-z _-]{0,39}$/u.test(actionName)) return false
            const scope = `${actionName}: ${JSON.stringify(params)}`
            if (scope.length > 1024) return false
            const resolution = await approval.offer({kind: 'permissions', local_detail: {kind: 'permissions', scope},
              operation_summary: `${this.identity.displayName}操作：${actionName}`, allowed_decisions: ['accept', 'decline'],
              executorIdentity: {executor: this.descriptor.name, display_name: this.identity.displayName}}, signal)
            const decision = resolution === null ? 'decline' : approval.consume(resolution)
            return !signal.aborted && decision === 'accept'
          },
          progress: event => {
            if (event?.phase === 'action_returned') {
              observed.last_returned_step = event.steps
              if (event.actionName !== undefined) observed.last_action = event.actionName
              if (event.executionMode !== undefined) observed.execution_mode = event.executionMode
            }
            if (signal.aborted) return
            const summary = event?.phase === 'planning' ? '正在观察屏幕并规划下一步'
              : event?.phase === 'action_pending' ? '等待批准'
              : event?.phase === 'action_returned' ? '动作已返回，等待下一次观察'
              : event?.phase === 'model_finished' ? '模型已结束，结果尚未验证' : `正在执行${this.identity.title}`
            context.progress({phase: 'working', internal_activity: ++activity,
              elapsed: Math.max(0, context.clock.now() - context.delegate.dispatched_at), summary})
          }}))
        quarantined = returned.code === 'cleanup_unknown'
        const outcome = returned.code === 'model_finished' ? readback ? 'ok' : 'unknown'
          : returned.code === 'cancelled' ? 'cancelled'
          : ['timeout', 'cleanup_unknown'].includes(returned.code) ? 'unknown'
          : ['declined', 'screen_changed', 'needs_user_action', 'invalid_configuration'].includes(returned.code) ? returned.steps > 0 ? 'unknown' : 'refused' : 'failed'
        result = handoff(returned.code, outcome, {steps: returned.steps, ...observed})
      } catch { result = handoff('runner_failed', 'unknown', observed) }
      if (quarantined) return {...result, content: {...result.content, cleanup_required: true,
        ...(cancelled.aborted ? {cancel_requested: true} : {})}}
      if (cancelled.aborted) return handoff('cancelled', 'cancelled', observed)
      if (deadline.aborted) return handoff('timeout', 'unknown', observed)
      return result
    } finally {
      // Do not race the runner against abort: even cancellation retains ownership through cleanup.
      approval.invalidate(`${this.descriptor.name}_finished`)
      // A timed-out device write can outlive the host request; retain quarantine for manual recovery.
      if (quarantined) {quarantineTaskResources([resource]); releaseResource = undefined}
      releaseResource?.()
      if (quarantined) await quarantineDeviceLock(acquired.lock, 'cleanup_unknown')
      else await releaseDeviceLock(acquired.lock)
    }
  }
}
