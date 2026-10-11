/** Native SDK planner; Nova alone grants authority for each atomic device write. */
import {createAndroidDevice} from './mobile-android.js'
import {execFile} from 'node:child_process'
import {basename} from 'node:path'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import {z, type DeviceAction} from '@midscene/core'
import {actionTapParamSchema, actionScrollParamSchema, type AbstractInterface} from '@midscene/core/device'
import {runGui, validGuiConfig, logicalSwipeDistance, type GuiProgress} from './gui-runner.js'

export interface MobileIosConfig {
  deviceId: string
  deviceType: 'ios' | 'ios-simulator' | 'android'
  wdaUrl: string
  baseUrl: string
  model: string
  modelFamily: string
  apiKey: string
  maxSteps: number
  budgetMs: number
  settleMs?: number
  lockRoot: string
}
export type MobileIosProgress = GuiProgress
interface RunOptions {
  beforeWrite?: () => void
  capture?: (image: string, steps: number) => void
  signal: AbortSignal
  approve: (actionName: string, params: unknown) => Promise<boolean>
  progress: (event?: MobileIosProgress) => void
}
const exec = promisify(execFile)
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export {logicalSwipeDistance} from './gui-runner.js'

/** Only positively acknowledged ADB refusals are safe to release; transport ambiguity wins over cancellation. */
export function mobileWriteFailure(error: unknown, android: boolean, stopped?: string): string {
  const reason = error instanceof Error ? error.message : ''
  if (android && ['action_failed', 'needs_user_action', 'cancelled', 'invalid_configuration'].includes(reason)) return stopped ?? reason
  return 'cleanup_unknown'
}

export async function runMobileIos(config: MobileIosConfig, instruction: string, options: RunOptions): Promise<{code: string; steps: number}> {
  const controller = new AbortController()
  let code: string | undefined
  let steps = 0
  const stop = (reason: string): never => {
    code ??= reason
    controller.abort()
    throw new Error(code)
  }
  const cancelled = () => { code ??= 'cancelled'; controller.abort() }
  options.signal.addEventListener('abort', cancelled, {once: true})
  if (options.signal.aborted) cancelled()
  const check = () => { if (controller.signal.aborted) throw new Error(code ?? 'cancelled') }
  const timer = setTimeout(() => { code ??= 'timeout'; controller.abort() }, config.budgetMs)
  const emit = (phase: MobileIosProgress['phase'], actionName?: string) => {
    options.progress({phase, steps, ...(actionName ? {actionName} : {})})
  }
  let configured = false
  try {
    check()
    const settleMs = config.settleMs ?? 4000
    if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > 30_000) stop('invalid_configuration')
    const endpoint = new URL(config.wdaUrl)
    // Borrow only a verified simulator runner or explicit USB iproxy binding.
    const android = config.deviceType === 'android'
    if ((!android && (!['ios-simulator', 'ios'].includes(config.deviceType) || process.platform !== 'darwin'
      || !(config.deviceType === 'ios-simulator' ? /^[A-Fa-f0-9-]{36}$/u : /^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{16})$/u).test(config.deviceId)
      || endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(endpoint.hostname)
      || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash))
      || !validGuiConfig(config, instruction)) stop('invalid_configuration')
    const adb = android ? await createAndroidDevice(config.deviceId, controller.signal) : undefined
    const ios = android ? undefined : await (async () => {
      const port = Number(endpoint.port || 80)
      const command = async (file: string, args: string[]) => {
        check()
        return (await exec(file, args, {timeout: 5000, signal: controller.signal, maxBuffer: 1024 * 1024})).stdout.trim()
      }
      const simulator = config.deviceType === 'ios-simulator'
      if (simulator) {
      const listing = record(JSON.parse(await command('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'booted', '-j'])))
      const devices = Object.values(record(listing.devices)).flatMap(group => Array.isArray(group) ? group as unknown[] : [])
      if (devices.filter(value => { const item = record(value); return item.udid === config.deviceId
        && item.state === 'Booted' && item.isAvailable !== false }).length !== 1) stop('invalid_configuration')
      }
      const identity = async () => {
        const listeners = await command('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'])
        const pids = [...new Set(listeners.split('\n').filter(line => /^p\d+$/u.test(line)).map(line => line.slice(1)))]
        if (pids.length !== 1) stop('invalid_configuration')
        const pid = pids[0]!
        const executable = await command('/bin/ps', ['-p', pid, '-o', 'comm='])
        if (simulator && !['WebDriverAgentRunner-Runner', 'WebDriverAgentRunner'].includes(basename(executable))) stop('invalid_configuration')
        if (!simulator) {
          const args = await command('/bin/ps', ['-p', pid, '-o', 'args='])
          if (!validIosUsbForwarder(executable, args, config.deviceId, port) || !(await command('idevice_id', ['-l'])).split('\n').includes(config.deviceId)) stop('invalid_configuration')
          return `${pid}:${await command('/bin/ps', ['-p', pid, '-o', 'lstart='])}`
        }
        const environment = await command('/bin/ps', ['eww', '-p', pid, '-o', 'command='])
        const ids = [...environment.matchAll(/(?:^|\s)SIMULATOR_UDID=([^\s]+)(?=\s|$)/gu)].map(match => match[1])
        if (ids.length !== 1 || ids[0] !== config.deviceId) stop('invalid_configuration')
        return `${pid}:${await command('/bin/ps', ['-p', pid, '-o', 'lstart='])}`
      }
      const initialIdentity = await identity()
      const verify = async () => { check(); if (await identity() !== initialIdentity) stop('invalid_configuration'); check() }
      const read = async (path: string) => {
        await verify()
        const response = await fetch(new URL(path, endpoint), {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(config.budgetMs, 30_000))]), redirect: 'error'})
        if (!response.ok) stop('action_failed')
        const data = record(await response.json())
        if (record(data.value).error) stop('action_failed')
        return data
      }
      const status = await read('/status')
      const value = record(status.value)
      const reportedId = value.udid ?? record(value.device).udid
      if (reportedId && reportedId !== config.deviceId) stop('invalid_configuration')
      const sessionId = status.sessionId ?? value.sessionId
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(sessionId)) stop('invalid_configuration')
      // Borrow the verified session without connecting, modifying settings, or installing WDA.
      const sessionPath = `/session/${sessionId as string}`
      const foreground = async () => {
        const bundle = record((await read('/wda/activeAppInfo')).value).bundleId
        if (typeof bundle !== 'string' || !bundle || bundle.length > 300) stop('action_failed')
        return bundle as string
      }
      const capture = async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const bundle = await foreground()
          const encoded = (await read(`${sessionPath}/screenshot`)).value
          if (typeof encoded !== 'string' || encoded.length > 40_000_000
            || !/^(?:iVBOR|\/9j\/)/u.test(encoded)) stop('action_failed')
          const image = `data:image/${(encoded as string).startsWith('/9j/') ? 'jpeg' : 'png'};base64,${encoded as string}`
          const rect = record((await read(`${sessionPath}/window/rect`)).value)
          if (![rect.width, rect.height].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)) stop('action_failed')
          if (await foreground() === bundle) return {image, bundle, context: JSON.stringify([bundle, rect.width, rect.height])}
          if (attempt < 2) await delay(250, undefined, {signal: controller.signal})
        }
        return stop('screen_changed')
      }
      return {verify, read, capture, sessionPath}
    })()
    const capture = adb ? adb.capture : ios!.capture
    const verify = adb ? adb.verify : ios!.verify
    let latest: Awaited<ReturnType<typeof capture>> | undefined
    let planned: typeof latest
    let size = {width: 0, height: 0}
    const point = (input: unknown): [number, number] => {
      const coordinates = Array.isArray(input) ? input : stop('needs_user_action')
      if (coordinates.length !== 2 || coordinates.some((n, i) => typeof n !== 'number'
        || !Number.isFinite(n) || n < 0 || n >= (i ? size.height : size.width))) stop('needs_user_action')
      return [Math.floor(coordinates[0] as number), Math.floor(coordinates[1] as number)]
    }
    const write = async (name: string, params: unknown, path: string, body: unknown) => {
      try {
        check()
        if (steps >= config.maxSteps) stop('step_limit')
        const baseline = planned
        if (!baseline) stop('screen_changed')
        const fresh = async () => {
          const current = await capture()
          if (current.context !== baseline!.context) {
            stop('screen_changed')
          }
        }
        await fresh()
        emit('action_pending', name)
        const approval = options.approve(name, params)
        // A pending approval must not keep a cancelled run alive.
        const accepted = await new Promise<boolean>((resolve, reject) => {
          const abort = () => reject(new Error(code ?? 'cancelled'))
          controller.signal.addEventListener('abort', abort, {once: true})
          approval.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort)).catch(() => undefined)
          if (controller.signal.aborted) abort()
        })
        check()
        if (!accepted) stop('declined')
        await fresh()
        await verify()
        check()
        options.beforeWrite?.()
        steps++
        // Cancellation cannot undo a dispatched action. Await its bounded acknowledgement, including the body.
        let rejected = false
        try {
          if (adb) await adb.perform(name, record(params))
          else {
            const response = await fetch(new URL(`${ios!.sessionPath}${path}`, endpoint), {method: 'POST', redirect: 'error',
              headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
              signal: AbortSignal.timeout(Math.min(config.budgetMs, 30_000))})
            const data = record(await response.json())
            if (!Object.hasOwn(data, 'value')) throw new Error('invalid_wda_acknowledgement')
            rejected = !response.ok || (Boolean(record(data.value).error) || Boolean(data.error))
          }
        } catch (error) {
          code = mobileWriteFailure(error, Boolean(adb), code)
          stop(code)
        }
        if (rejected) stop('action_failed')
        planned = undefined
        const observed = await capture()
        options.capture?.(observed.image, steps)
        emit('action_returned', name)
        check()
      } catch (error) {
        const reason = error instanceof Error ? error.message : ''
        stop(code ?? (['screen_changed', 'needs_user_action', 'invalid_configuration', 'cancelled'].includes(reason) ? reason : 'action_failed'))
      }
    }
    const actions: DeviceAction[] = [
      {name: 'Tap', paramSchema: actionTapParamSchema, call: async (param: unknown) => {
        const [x, y] = point(record(record(param).locate).center)
        await write('Tap', {x, y}, '/wda/tap', {x, y})
      }},
      {name: 'Input', description: 'Type text into the already focused field without clearing it or dismissing the keyboard.',
        paramSchema: z.object({value: z.string().min(1).max(4000)}).strict(), call: async (param: unknown) => {
          const text = record(param).value as string // Already validated by the action schema.
          await write('Type', {text}, '/wda/keys', {value: Array.from(text)})
        }},
      {name: 'AndroidHomeButton', description: 'Press the Home button.', call: async () => {
        await write('Home', {}, '/wda/pressButton', {name: 'home'})
      }},
      {name: 'Scroll', paramSchema: actionScrollParamSchema.extend({scrollType: z.literal('singleAction'), distance: z.number().finite().positive(), locate: actionTapParamSchema.shape.locate}), call: async (raw: unknown, context) => {
        const param = record(raw)
        if (param.scrollType !== 'singleAction' || typeof param.distance !== 'number' || !Number.isFinite(param.distance)
          || param.distance <= 0 || typeof param.direction !== 'string') stop('needs_user_action')
        const [fromX, fromY] = point(record(param.locate).center)
        const offset = ({down: [0, -1], up: [0, 1], right: [-1, 0], left: [1, 0]} as Record<string, number[]>)[param.direction as string]
        if (!offset) stop('needs_user_action')
        const distance = config.modelFamily.startsWith('auto-glm') ? logicalSwipeDistance(param.distance as number, context?.uiContext?.shrunkShotToLogicalRatio ?? NaN) : param.distance as number
        const [toX, toY] = point([fromX + offset![0]! * distance, fromY + offset![1]! * distance])
        await write('Swipe', {fromX, fromY, toX, toY, durationMs: 500}, '/actions', {actions: [{type: 'pointer', id: 'finger1',
          parameters: {pointerType: 'touch'}, actions: [{type: 'pointerMove', duration: 0, x: fromX, y: fromY},
            {type: 'pointerDown', button: 0}, {type: 'pause', duration: 100},
            {type: 'pointerMove', duration: 500, x: toX, y: toY}, {type: 'pointerUp', button: 0}]}]})
      }},
    ]
    if (android) actions.push(
      {name: 'Launch', description: 'Launch an installed Android app by exact package name (for example com.example.app), never a URL or shell command.',
        paramSchema: z.object({uri: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u)}).strict(),
        call: async (param: unknown) => write('Launch', {packageName: record(param).uri}, '', {})},
      {name: 'AndroidBackButton', description: 'Press Android Back.', call: async () => write('Back', {}, '', {})})
    const guarded: AbstractInterface = {interfaceType: android ? 'android' : 'ios',
      size: async () => {
        if (adb) { size = adb.size; return size }
        const value = record((await ios!.read(`${ios!.sessionPath}/window/rect`)).value)
        const parsed = z.object({width: z.number().finite().positive(), height: z.number().finite().positive()}).safeParse(value)
        if (!parsed.success) stop('action_failed')
        size = parsed.data!
        return size
      },
      screenshotBase64: async () => {
        try { latest = await capture(); return latest.image }
        catch (error) { return stop(error instanceof Error && error.message === 'screen_changed' ? 'screen_changed' : 'action_failed') }
      },
      actionSpace: () => actions}
    configured = true
    const returned = await runGui(instruction, guarded, {...config, signal: controller.signal,
      steps: () => steps, planning: () => { planned = latest }, progress: options.progress, ...(options.capture ? {capture: options.capture} : {}),
      context: android
        ? 'Use only the available actions. Launch requires an exact installed Android package name. Input appends text to the focused field. Never guess package names or execute shell commands.'
        : 'Only Tap, Type into an already focused field, one Swipe, Home, and finish are available. Never launch apps or use other actions.'})
    return {code: code ?? returned, steps}
  } catch {
    return {code: code ?? (configured ? 'model_failed' : 'invalid_configuration'), steps}
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', cancelled)
  }
}

/** Only an explicit USB tunnel to this UDID/port is eligible; never borrow a default or network device. */
export function validIosUsbForwarder(executable: string, args: string, deviceId: string, port: number): boolean {
  if (basename(executable) !== 'iproxy' || /(?:^|\s)(?:-n|--network)(?:\s|$)/u.test(args)) return false
  const ids = [...args.matchAll(/(?:^|\s)(?:-u|--udid)\s+(\S+)/gu)].map(match => match[1])
  const sources = [...args.matchAll(/(?:^|\s)(?:-s|--source)\s+(\S+)/gu)].map(match => match[1])
  return ids.length === 1 && ids[0] === deviceId && sources.every(source => source === '127.0.0.1')
    && args.split(/\s+/u).includes(`${port}:8100`)
}
