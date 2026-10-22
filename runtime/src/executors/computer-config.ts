import {homedir} from 'node:os'
import {join} from 'node:path'
import {validGuiConfig,type GuiModelConfig} from './gui-runner.js'
import {validComputerDisplayId} from './computer-device.js'

export interface ComputerConfig extends GuiModelConfig {displayId: string; lockRoot: string; resourcesPath?: string; clickHoldMs?: number; macWindow?: {pid: number; windowId: number}; macApplication?: {name:string;bundleId:string;path:string}}

export function loadComputerConfig(env: NodeJS.ProcessEnv): ComputerConfig {
  const config = {...(env.CODEX_RESOURCES_PATH ? {resourcesPath: env.CODEX_RESOURCES_PATH} : {}), displayId: env.COMPUTER_DISPLAY_ID ?? '', baseUrl: env.COMPUTER_BASE_URL ?? '', model: env.COMPUTER_MODEL ?? '',
    modelFamily: env.COMPUTER_MODEL_FAMILY ?? '', apiKey: env.COMPUTER_API_KEY ?? '', maxSteps: Number(env.COMPUTER_MAX_STEPS ?? 30),
    budgetMs: Number(env.COMPUTER_TIMEOUT_SECONDS ?? 600) * 1000, settleMs: Number(env.COMPUTER_SETTLE_MS ?? 4000), clickHoldMs: Number(env.COMPUTER_CLICK_HOLD_MS ?? 100),
    lockRoot: join(homedir(), '.nova-audio-agent', 'gui-devices')}
  const windowPid = env.COMPUTER_MAC_WINDOW_PID === '' ? undefined : env.COMPUTER_MAC_WINDOW_PID, windowId = env.COMPUTER_MAC_WINDOW_ID === '' ? undefined : env.COMPUTER_MAC_WINDOW_ID
  let macWindow: ComputerConfig['macWindow']
  if (windowPid !== undefined || windowId !== undefined) {
    if (process.platform !== 'darwin' || !/^[1-9]\d{0,9}$/u.test(windowPid ?? '') || !/^[1-9]\d{0,9}$/u.test(windowId ?? '')
      || Number(windowPid) > 2147483647 || Number(windowId) > 4294967295) throw Error('invalid_computer_configuration')
    macWindow = {pid: Number(windowPid), windowId: Number(windowId)}
  }
  if (!Number.isSafeInteger(config.clickHoldMs) || config.clickHoldMs < 10 || config.clickHoldMs > 1000 || !validComputerDisplayId(config.displayId) || !validGuiConfig(config, 'validate')) throw new Error('invalid_computer_configuration')
  return {...config, ...(macWindow ? {macWindow} : {})}
}
