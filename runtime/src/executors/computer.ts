import type {ComputerConfig} from './computer-config.js'
export {loadComputerConfig,type ComputerConfig} from './computer-config.js'
import type {HostApprovalController} from '../core/approval.js'
import type {ExecutorAdapter, ExecutorDispatchContext, ExecutorHandoff} from '../core/causal-runtime.js'
import type {AgentController, AgentRuntimeDispatchPort} from './agent-controller.js'
import {startComputerBackend} from './computer-backend.js'
import {GuiExecutionLifecycle} from './gui-execution.js'
import {runGui, validGuiConfig, type GuiProgress} from './gui-runner.js'
import {connectComputerDevice, computerForeground, validComputerDisplayId} from './computer-device.js'

interface ComputerOptions {beforeWrite?: () => void; capture?: (image: string, steps: number) => void; diagnostic?: (message: string) => void; signal: AbortSignal; recordProcess?: (pid: number) => Promise<void>; approve: (name: string, params: unknown) => Promise<boolean>; progress: (event?: GuiProgress) => void}
export const COMPUTER_DESCRIPTOR = Object.freeze({name: 'computer', summary:
  'Operates the explicitly configured local macOS or Windows display, or an opt-in background Safari key window, using screenshots and coordinates under user supervision. Each input needs approval; model completion still needs verification.',
  ownedChannels: Object.freeze(['computer'])})


export async function runComputer(config: ComputerConfig, instruction: string, options: ComputerOptions): Promise<{code: string; steps: number}> {
  if (options.signal.aborted) return {code: 'cancelled', steps: 0}
  if ((config.macWindow && process.platform !== 'darwin') || !['darwin', 'win32'].includes(process.platform) || !validComputerDisplayId(config.displayId) || !validGuiConfig(config, instruction)) {
    return {code: 'invalid_configuration', steps: 0}
  }
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(config.budgetMs)])
  let backend: Awaited<ReturnType<typeof startComputerBackend>> | undefined
  let guarded: Awaited<ReturnType<typeof connectComputerDevice>> | undefined
  let unknown = false
  const result = {code: 'invalid_configuration', steps: 0}
  try {
    backend = await startComputerBackend(config.displayId, signal, config.budgetMs, undefined, config.resourcesPath, config.clickHoldMs, config.macWindow)
    if (!backend.pid) throw new Error('invalid_configuration')
    await options.recordProcess?.(backend.pid)
    guarded = await connectComputerDevice(backend, config, {...options, signal, foreground: computerForeground,
      ...(options.beforeWrite ? {beforeConnect: options.beforeWrite} : {}), screenshotScrollDistance: config.modelFamily.startsWith('auto-glm')})
    const code = await runGui(instruction, guarded.device, {...config, signal, steps: guarded.steps, planning: guarded.planning,
      progress: options.progress, ...(options.capture ? {capture: options.capture} : {}), ...(options.diagnostic ? {diagnostic: options.diagnostic} : {}), context: `Current OS is ${process.platform === 'darwin' ? 'macOS; use Command for select-all and paste shortcuts' : 'Windows; use Control for shortcuts'}. ${config.macWindow ? 'This is a bound background application window. Never raise or switch windows. Use supported AX operations or window-targeted events without changing the user\'s foreground app. KeyboardPress supports only Command+A, Meta+A, Return, Enter, Tab, Escape and Backspace.' : ''} Use only Tap, Input, one Scroll and KeyboardPress. Tap a field before Input. Input appends to the focused field and must omit locate; KeyboardPress must omit locate. Scroll must use singleAction and distance no larger than the screen. All coordinates are in the provided screen. Do not run shell commands.`})
    const returned = guarded.failure() ?? code
    unknown = returned === 'cleanup_unknown'
    return Object.assign(result, {code: unknown ? returned : signal.aborted ? options.signal.aborted ? 'cancelled' : 'timeout' : returned, steps: guarded.steps()})
  } catch (error) {
    const reason = error instanceof Error ? error.message : ''
    unknown = reason === 'cleanup_unknown'
    return Object.assign(result, {code: unknown ? reason : signal.aborted ? options.signal.aborted ? 'cancelled' : 'timeout'
      : ['declined', 'screen_changed', 'needs_user_action', 'action_failed'].includes(reason) ? reason : 'invalid_configuration', steps: guarded?.steps() ?? 0})
  } finally {
    // Kill the SDK process group on every exit; unknown writes still retain device quarantine.
    if (backend) {
      try {if (!await backend.close()) result.code = 'cleanup_unknown'}
      catch {result.code = 'cleanup_unknown'}
    }
  }
}

export class ComputerExecutor implements ExecutorAdapter {
  readonly #execution: GuiExecutionLifecycle
  constructor(readonly config: ComputerConfig, approvals: HostApprovalController, runner: typeof runComputer = runComputer) {
    this.#execution = new GuiExecutionLifecycle({...config, deviceType: 'desktop', deviceId: 'local-input', target: config.macWindow ? `mac-window:${config.macWindow.pid}:${config.macWindow.windowId}` : `desktop:${config.displayId}`}, approvals,
      (budgetMs, instruction, options) => runner({...config, budgetMs}, instruction, options),
      {descriptor: COMPUTER_DESCRIPTOR, displayName: '电脑助手', project: 'Computer', title: '电脑任务'})
  }
  get descriptor() {return this.#execution.descriptor}
  get manifest() {return this.#execution.manifest}
  controller(port: AgentRuntimeDispatchPort): AgentController {return this.#execution.controller(port)}
  admitRequest(op: string, request: Readonly<Record<string, unknown>>) {return this.#execution.admitRequest(op, request)}
  dispatch(op: string, request: Readonly<Record<string, unknown>>, context: ExecutorDispatchContext): Promise<ExecutorHandoff> {
    return this.#execution.dispatch(op, request, context)
  }
  cancelWork(workId: string) {this.#execution.cancelWork(workId)}
  close(): Promise<void> {return this.#execution.close()}
}
