/** Shared screenshot planner. Callers supply only Nova-guarded actions and own target/approval/cleanup. */
import {Agent} from '@midscene/core'
import type {AbstractInterface} from '@midscene/core/device'
import {setLogDirectoryResolver} from '@midscene/shared/logger'
import {devNull} from 'node:os'
import {setTimeout as delay} from 'node:timers/promises'

// 1.12.9 appends filenames to this path; a null device cannot contain files on either platform.
setLogDirectoryResolver(() => devNull)

/** AutoGLM emits distance in screenshot pixels; the SDK only rescales locator centers. */
export function logicalSwipeDistance(distance: number, screenshotToLogicalRatio: number): number {
  if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(screenshotToLogicalRatio)
    || screenshotToLogicalRatio <= 0) throw new Error('needs_user_action')
  return distance / screenshotToLogicalRatio
}

export interface GuiModelConfig {
  baseUrl: string
  model: string
  modelFamily: string
  apiKey: string
  maxSteps: number
  budgetMs: number
  settleMs?: number
}
export interface GuiProgress {
  phase: 'planning' | 'action_pending' | 'action_returned' | 'model_finished'
  steps: number
  actionName?: string
  executionMode?: 'background'|'activated'
}
export interface GuiRunOptions extends GuiModelConfig {
  signal: AbortSignal
  context: string
  steps: () => number
  planning: () => void
  diagnostic?: (message: string) => void
  capture?: (image: string, steps: number) => void
  progress: (event: GuiProgress) => void
}

export function validGuiConfig(config: GuiModelConfig, instruction: string): boolean {
  try {
    const endpoint = new URL(config.baseUrl)
    const settleMs = config.settleMs ?? 4000
    return !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
      && (endpoint.protocol === 'https:' || (endpoint.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))
      && ['auto-glm', 'auto-glm-multilingual', 'qwen3-vl'].includes(config.modelFamily)
      && Boolean(config.model.trim() && config.apiKey && instruction.trim()) && instruction.length <= 4000
      && Number.isSafeInteger(config.maxSteps) && config.maxSteps >= 1 && config.maxSteps <= 100
      && Number.isSafeInteger(config.budgetMs) && config.budgetMs >= 1 && config.budgetMs <= 1_800_000
      && Number.isSafeInteger(settleMs) && settleMs >= 0 && settleMs <= 30_000
  } catch { return false }
}

/** model_finished is execution status, never task verification. No screenshot persistence or device destruction. */
export async function runGui(instruction: string, guarded: AbstractInterface, options: GuiRunOptions): Promise<string> {
  if (options.signal.aborted) return 'cancelled'
  if (!validGuiConfig(options, instruction)) return 'invalid_configuration'
  const settleMs = options.settleMs ?? 4000
  let agent: Agent | undefined
  let finished = false
  let limited = false
  const diagnose = (value: unknown) => {
    const message = value instanceof Error ? value.message : typeof value === 'string' ? value : 'model_failed'
    options.diagnostic?.(message.replaceAll(options.apiKey, '[redacted]').replace(/data:image\/[^\s"']+/gu, '[image]').slice(0, 1000))
  }
  try {
    agent = new Agent(guarded, {modelConfig: {MIDSCENE_MODEL_FAMILY: options.modelFamily, MIDSCENE_MODEL_NAME: options.model,
      MIDSCENE_MODEL_BASE_URL: options.baseUrl, MIDSCENE_MODEL_API_KEY: options.apiKey, MIDSCENE_MODEL_RETRY_COUNT: 0,
      MIDSCENE_MODEL_TIMEOUT: Math.min(options.budgetMs, 60_000)},
    waitAfterAction: settleMs, replanningCycleLimit: options.maxSteps, cache: false,
    generateReport: false, persistExecutionDump: false, autoPrintReportMsg: false})
    agent.addProgressListener(event => {
      if (event.scope !== 'aiAct') return
      if (event.phase === 'failed' || event.phase === 'plan_failed') {
        const data = event.data as {error?: unknown}
        diagnose(data?.error)
      }
      if (event.phase === 'plan_thinking') {
        options.planning()
        options.progress({phase: 'planning', steps: options.steps()})
      }
      if (event.phase === 'complete' && !options.signal.aborted) finished = true
      if (event.phase === 'failed' && options.steps() >= options.maxSteps) limited = true
    })
    await delay(settleMs, undefined, {signal: options.signal})
    await agent.aiAct(instruction, {abortSignal: options.signal, cacheable: false, context: options.context})
    options.signal.throwIfAborted()
    const lastTask = agent.dump.executions.at(-1)?.tasks.at(-1)
    finished &&= lastTask?.status === 'finished' && !lastTask.error
      && (options.modelFamily === 'qwen3-vl' || (lastTask.type === 'Action Space' && lastTask.subType === 'Finished'))
    if (finished && options.capture) options.capture(await guarded.screenshotBase64(), options.steps())
    if (finished) options.progress({phase: 'model_finished', steps: options.steps()})
    return finished ? 'model_finished' : limited ? 'step_limit' : 'model_failed'
  } catch (error) {diagnose(error); return options.signal.aborted ? 'cancelled' : limited ? 'step_limit' : 'model_failed'}
  finally { await agent?.destroy() }
}
