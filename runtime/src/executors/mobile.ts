import {homedir} from 'node:os'
import {join} from 'node:path'
import type {ExecutorAdapter, ExecutorDispatchContext, ExecutorHandoff} from '../core/causal-runtime.js'
import type {HostApprovalController} from '../core/approval.js'
import type {AgentController, AgentRuntimeDispatchPort} from './agent-controller.js'
import type {MobileIosConfig, runMobileIos} from './mobile-ios.js'
import {GuiExecutionLifecycle} from './gui-execution.js'

export const MOBILE_DESCRIPTOR = Object.freeze({name: 'mobile', summary:
  'Operates the configured phone under user supervision. Every device action needs confirmation. Screenshots go to the configured model service.',
  ownedChannels: Object.freeze(['mobile'])})

export function loadMobileConfig(env: NodeJS.ProcessEnv): MobileIosConfig {
  const values = {
    ENGINE: env.MOBILE_ENGINE,
    DEVICE_TYPE: env.MOBILE_DEVICE_TYPE,
    DEVICE_ID: env.MOBILE_DEVICE_ID,
    BASE_URL: env.EXECUTOR_BASE_URL,
    WDA_URL: env.MOBILE_WDA_URL,
    MODEL: env.EXECUTOR_MODEL,
    MODEL_FAMILY: env.EXECUTOR_MODEL_FAMILY,
    API_KEY: env.EXECUTOR_API_KEY,
    MAX_STEPS: env.EXECUTOR_MAX_STEPS,
    TIMEOUT_SECONDS: env.EXECUTOR_TIMEOUT_SECONDS,
    SETTLE_MS: env.EXECUTOR_SETTLE_MS,
  }
  const required = (name: keyof typeof values, fallback?: string, max = 4096): string => {
    const value = (values[name] ?? fallback)?.trim()
    if (!value || value.length > max || /[\x00-\x1f]/u.test(value)) throw new Error(`invalid_mobile_configuration:${name}`)
    return value
  }
  const integer = (name: keyof typeof values, fallback: number, max: number, min = 1): number => {
    const value = Number(values[name] ?? fallback)
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid_mobile_configuration:${name}`)
    return value
  }
  if (required('ENGINE', 'midscene') !== 'midscene') throw new Error('invalid_mobile_engine')
  const deviceType = required('DEVICE_TYPE', 'ios-simulator')
  if (deviceType !== 'ios' && deviceType !== 'ios-simulator' && deviceType !== 'android') throw new Error('invalid_mobile_device_type')
  const deviceId = required('DEVICE_ID', undefined, 128)
  if (!/^[A-Za-z0-9_.:\-]+$/u.test(deviceId)) throw new Error('invalid_mobile_device')
  const baseUrl = required('BASE_URL', undefined, 2048)
  const wdaUrl = required('WDA_URL', 'http://127.0.0.1:8100', 2048)
  for (const value of [baseUrl, wdaUrl]) {
    const url = new URL(value)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error('invalid_mobile_endpoint')
    if (value === wdaUrl && deviceType === 'ios-simulator' && (!local || url.protocol !== 'http:' || url.pathname !== '/')) throw new Error('invalid_mobile_wda_endpoint')
  }
  return {deviceId, deviceType, wdaUrl, baseUrl, model: required('MODEL', undefined, 200),
    modelFamily: required('MODEL_FAMILY', undefined, 200), apiKey: required('API_KEY'),
    maxSteps: integer('MAX_STEPS', 30, 100), budgetMs: integer('TIMEOUT_SECONDS', 600, 1800) * 1000,
    settleMs: integer('SETTLE_MS', 4000, 30000, 0),
    // Share the existing phone quarantine across engines; changing engines must not bypass ownership.
    lockRoot: join(homedir(), '.nova-audio-agent', 'autoglm-devices')}
}

export class MobileExecutor implements ExecutorAdapter {
  readonly #execution: GuiExecutionLifecycle
  constructor(readonly config: MobileIosConfig, readonly approvals: HostApprovalController,
    readonly runner: typeof runMobileIos = async (...args) => (await import('./mobile-ios.js')).runMobileIos(...args)) {
    this.#execution = new GuiExecutionLifecycle(config, approvals,
      (budgetMs, instruction, options) => runner({...config, budgetMs}, instruction, options),
      {descriptor: MOBILE_DESCRIPTOR, displayName: '手机助手', project: config.deviceType === 'android' ? 'Android' : 'iOS', title: '手机任务'})
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
