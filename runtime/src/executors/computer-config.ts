import {homedir} from 'node:os'
import {join} from 'node:path'
import {validGuiConfig,type GuiModelConfig} from './gui-runner.js'
import {validComputerDisplayId} from './computer-device.js'

export interface ComputerDeviceConfig extends Pick<GuiModelConfig,'maxSteps'|'budgetMs'|'settleMs'> {displayId: string; lockRoot: string; resourcesPath?: string; clickHoldMs?: number; macWindow?: {pid: number; windowId: number}; macApplication?: {name:string;bundleId:string;path:string}}

export interface ComputerConfig extends ComputerDeviceConfig, GuiModelConfig {}

export function loadComputerDeviceConfig(env: NodeJS.ProcessEnv): ComputerDeviceConfig {
  const displayId=env.COMPUTER_DISPLAY_ID?.trim()??''
  const config = {...(env.CODEX_RESOURCES_PATH ? {resourcesPath: env.CODEX_RESOURCES_PATH} : {}), displayId: displayId.length?displayId:'primary', maxSteps: Number(env.EXECUTOR_MAX_STEPS ?? 30),
    budgetMs: Number(env.EXECUTOR_TIMEOUT_SECONDS ?? 600) * 1000, settleMs: Number(env.EXECUTOR_SETTLE_MS ?? 4000), clickHoldMs: Number(env.COMPUTER_CLICK_HOLD_MS ?? 100),
    lockRoot: join(homedir(), '.nova-audio-agent', 'gui-devices')}
  const windowPid = env.COMPUTER_MAC_WINDOW_PID === '' ? undefined : env.COMPUTER_MAC_WINDOW_PID, windowId = env.COMPUTER_MAC_WINDOW_ID === '' ? undefined : env.COMPUTER_MAC_WINDOW_ID
  let macWindow: ComputerDeviceConfig['macWindow']
  if (windowPid !== undefined || windowId !== undefined) {
    if (process.platform !== 'darwin' || !/^[1-9]\d{0,9}$/u.test(windowPid ?? '') || !/^[1-9]\d{0,9}$/u.test(windowId ?? '')
      || Number(windowPid) > 2147483647 || Number(windowId) > 4294967295) throw Error('invalid_computer_configuration')
    macWindow = {pid: Number(windowPid), windowId: Number(windowId)}
  }
  if (!Number.isSafeInteger(config.clickHoldMs) || config.clickHoldMs < 10 || config.clickHoldMs > 1000 || !validComputerDisplayId(config.displayId)
    || !Number.isSafeInteger(config.maxSteps) || config.maxSteps < 1 || config.maxSteps > 100
    || !Number.isSafeInteger(config.budgetMs) || config.budgetMs < 1 || config.budgetMs > 1_800_000
    || !Number.isSafeInteger(config.settleMs) || config.settleMs < 0 || config.settleMs > 30_000) throw new Error('invalid_computer_configuration')
  return {...config, ...(macWindow ? {macWindow} : {})}
}

export function loadComputerConfig(env: NodeJS.ProcessEnv): ComputerConfig {
  const config={...loadComputerDeviceConfig(env),baseUrl:env.EXECUTOR_BASE_URL??'',model:env.EXECUTOR_MODEL??'',modelFamily:env.EXECUTOR_MODEL_FAMILY??'',apiKey:env.EXECUTOR_API_KEY??''}
  if(!validGuiConfig(config,'validate'))throw Error('invalid_computer_configuration')
  return config
}
