import {homedir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import type {HostApprovalController} from '../core/approval.js'
import type {ExecutorAdapter, ExecutorDispatchContext} from '../core/causal-runtime.js'
import type {AgentRuntimeDispatchPort} from './agent-controller.js'
import {GuiExecutionLifecycle} from './gui-execution.js'
import {runGui, validGuiConfig, type GuiModelConfig, type GuiProgress} from './gui-runner.js'
import {guardComputerDevice, guiApproval} from './computer-device.js'
import {createBrowserDevice, validBrowserUrl} from './browser-device.js'

export interface BrowserConfig extends GuiModelConfig {engine: 'chromium' | 'firefox' | 'webkit'; url: string; headless: boolean; lockRoot: string}
interface BrowserOptions {diagnostic?: (message: string) => void; beforeWrite?: () => void; capture?: (image: string, steps: number) => void; signal: AbortSignal; recordProcess?: (pid: number) => Promise<void>;
  approve: (name: string, params: unknown) => Promise<boolean>; progress: (event?: GuiProgress) => void}
export const BROWSER_DESCRIPTOR = Object.freeze({name: 'browser', summary: 'Uses a dedicated browser page with screenshot planning and Playwright coordinates. Explicit target URL, approvals and independent verification required.', ownedChannels: Object.freeze(['browser'])})
export function loadBrowserConfig(env: NodeJS.ProcessEnv): BrowserConfig {
  const engine = env.BROWSER_ENGINE ?? 'chromium'
  const config = {engine, url: env.BROWSER_URL ?? '', headless: env.BROWSER_HEADLESS !== 'false',
    baseUrl: env.BROWSER_BASE_URL ?? '', model: env.BROWSER_MODEL ?? '', modelFamily: env.BROWSER_MODEL_FAMILY ?? '', apiKey: env.BROWSER_API_KEY ?? '',
    maxSteps: Number(env.BROWSER_MAX_STEPS ?? 30), budgetMs: Number(env.BROWSER_TIMEOUT_SECONDS ?? 600) * 1000,
    settleMs: Number(env.BROWSER_SETTLE_MS ?? 1000), lockRoot: join(homedir(), '.nova-audio-agent', 'gui-devices')}
  if (!['chromium', 'firefox', 'webkit'].includes(engine) || !validBrowserUrl(config.url) || !validGuiConfig(config, 'validate')
    || (env.BROWSER_HEADLESS !== undefined && !['true', 'false'].includes(env.BROWSER_HEADLESS))) throw Error('invalid_browser_configuration')
  return config as BrowserConfig
}
export async function runBrowser(config: BrowserConfig, instruction: string, options: BrowserOptions): Promise<{code: string; steps: number}> {
  const result = {code: 'invalid_configuration', steps: 0}
  if (!validGuiConfig(config, instruction) || !validBrowserUrl(config.url)) return result
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(config.budgetMs)])
  let backend: Awaited<ReturnType<typeof createBrowserDevice>> | undefined
  let guarded: Awaited<ReturnType<typeof guardComputerDevice>> | undefined
  try {
    if (!await guiApproval(options.approve('Navigate', {engine: config.engine, url: config.url}), signal)) return Object.assign(result, {code: 'declined'})
    backend = await createBrowserDevice({...config, signal, ...(options.beforeWrite ? {beforeWrite: options.beforeWrite} : {}), ...(options.recordProcess ? {recordProcess: options.recordProcess} : {})})
    guarded = await guardComputerDevice(backend.device, backend.target, {...options, signal, displayId: backend.id,
      maxSteps: config.maxSteps, budgetMs: config.budgetMs, screenshotScrollDistance: config.modelFamily.startsWith('auto-glm'), progress: options.progress})
    const code = await runGui(instruction, guarded.device, {...config, signal, steps: guarded.steps, planning: guarded.planning,
      progress: options.progress, ...(options.diagnostic ? {diagnostic: options.diagnostic} : {}), ...(options.capture ? {capture: options.capture} : {}), context: 'Operate only this browser page. Tap a field before Input; Input appends to current focus and omits locate. KeyboardPress omits locate. Scroll once with singleAction and a distance no larger than the viewport. Never use shell commands.'})
    return Object.assign(result, {code: guarded.failure() ?? code, steps: guarded.steps()})
  } catch (error) {return Object.assign(result, {code: signal.aborted ? options.signal.aborted ? 'cancelled' : 'timeout'
    : error instanceof Error && ['screen_changed', 'cleanup_unknown'].includes(error.message) ? error.message : 'action_failed', steps: guarded?.steps() ?? 0})}
  finally {if (backend && !await backend.close()) result.code = 'cleanup_unknown'}
}
export class BrowserExecutor implements ExecutorAdapter {
  readonly #execution: GuiExecutionLifecycle
  constructor(readonly config: BrowserConfig, approvals: HostApprovalController, runner: typeof runBrowser = runBrowser) {
    this.#execution = new GuiExecutionLifecycle({...config, deviceType: 'browser', deviceId: randomUUID()}, approvals,
      (budgetMs, instruction, options) => runner({...config, budgetMs}, instruction, options),
      {descriptor: BROWSER_DESCRIPTOR, displayName: '浏览器助手', project: 'Browser', title: '浏览器任务'})
  }
  get descriptor() {return this.#execution.descriptor}
  get manifest() {return this.#execution.manifest}
  controller(port: AgentRuntimeDispatchPort) {return this.#execution.controller(port)}
  admitRequest(op: string, request: Readonly<Record<string, unknown>>) {return this.#execution.admitRequest(op, request)}
  dispatch(op: string, request: Readonly<Record<string, unknown>>, context: ExecutorDispatchContext) {return this.#execution.dispatch(op, request, context)}
  cancelWork(workId: string) {this.#execution.cancelWork(workId)}
  close() {return this.#execution.close()}
}
