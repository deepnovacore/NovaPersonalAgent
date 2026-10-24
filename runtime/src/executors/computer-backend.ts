/** SDK isolation: synchronous native calls must never block Nova's cancellation/budget clock. */
import {z} from '@midscene/core'
import {tmpdir} from 'node:os'
import {randomInt} from 'node:crypto'
import {mkdtempSync, rmSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {PosixCodexProcessOwnerFactory} from './codex/process-owner.js'
import {loadWindowsGuardianFactoryFromResources} from './codex/windows-guardian.js'
import {fileURLToPath} from 'node:url'
import {MacNativeReader} from '../connectors/macos/reader.js'
import type {AbstractInterface} from '@midscene/core/device'
import {actionTapParamSchema, actionScrollParamSchema, actionKeyboardPressParamSchema} from '@midscene/core/device'

export async function startComputerBackend(displayId: string, signal: AbortSignal,
  budgetMs = 30_000, worker = new URL('./computer-worker.js', import.meta.url), resourcesPath?: string, clickHoldMs = 100, macWindow?: {pid: number; windowId: number}) {
  if (!Number.isSafeInteger(clickHoldMs) || clickHoldMs < 10 || clickHoldMs > 1000) throw Error('invalid_configuration')
  const resources = resourcesPath ?? (process as NodeJS.Process & {resourcesPath?: string}).resourcesPath
  const factory = process.platform === 'win32'
    ? resources ? loadWindowsGuardianFactoryFromResources({resourcesPath: resources, platform: process.platform, arch: process.arch}) : null
    : new PosixCodexProcessOwnerFactory()
  if (!factory) throw Error('windows_process_guardian_required')
  const nativeRoot = macWindow ? resources ?? resolve(fileURLToPath(new URL('../../../../clients/desktop/build/', import.meta.url))) : undefined
  const focusReader = nativeRoot ? new MacNativeReader(nativeRoot, 'macos_gui') : undefined
  const focusSchema = z.object({focus: z.object({pid: z.number().int().positive().max(2147483647), windowId: z.number().int().positive().max(4294967295), started: z.number().finite().positive()}), targetStarted: z.number().finite().positive()})
  let focusLease: (z.infer<typeof focusSchema> & {clickGroup: number; releasePointer: boolean; releaseKey?: string}) | undefined
  let pointerReleaseNeeded = false, keyboardReleaseNeeded: string | undefined
  const temporary = mkdtempSync(join(tmpdir(), 'nova-gui-input-'))
  const environment: Record<string, string> = {TMPDIR: temporary, TEMP: temporary, TMP: temporary, ELECTRON_RUN_AS_NODE: '1'}
  // Only driver dependencies; no model credentials or inherited NODE_OPTIONS.
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR']) if (process.env[name]) environment[name] = process.env[name]!
  const child = await factory.spawn({binary: process.execPath, argv: [fileURLToPath(worker), displayId, String(clickHoldMs), ...(macWindow ? [JSON.stringify(macWindow), nativeRoot!] : [])], cwd: process.cwd(),
    environment, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true}, {signal, expiresAtMs: Date.now() + budgetMs}).catch(error => {rmSync(temporary, {recursive: true, force: true}); throw error})
  let killing: Promise<void> | undefined
  let closed = false, nextId = 0
  const pending = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; write: boolean; abort: () => void}>()
  const stop = () => {
    if (closed) return
    closed = true
    // The detached group also owns SDK screenshot/scroll/AppleScript subprocesses.
    killing = child.killTree().catch(() => undefined)
    for (const entry of pending.values()) {
      clearTimeout(entry.timer); signal.removeEventListener('abort', entry.abort)
      entry.reject(new Error(entry.write ? 'cleanup_unknown' : signal.aborted ? 'cancelled' : 'action_failed'))
    }
    pending.clear()
  }
  child.stdin.on('error', stop)
  child.stdout.on('error', stop)
  child.stderr.resume()
  void child.exit.then(stop, stop)
  let buffer = ''
  const receive = (message: unknown) => {
    if (!message || typeof message !== 'object') return
    const result = message as {id?: unknown; ok?: unknown; value?: unknown; detail?:unknown}
    if (typeof result.id !== 'number') return
    const entry = pending.get(result.id)
    if (!entry) return
    pending.delete(result.id); clearTimeout(entry.timer); signal.removeEventListener('abort', entry.abort)
    if (result.ok === true) entry.resolve(result.value)
    else {entry.reject(new Error(entry.write ? 'cleanup_unknown' : 'action_failed',{cause:typeof result.detail==='string'&&/^native_gui:[a-z_]{1,80}$/u.test(result.detail)?new Error(result.detail):undefined})); stop()}
  }
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    if (buffer.length > 50_000_000) {stop(); return}
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      try {receive(JSON.parse(line))} catch {stop()}
    }
  })
  const request = (op: string, params?: unknown, write = false, timeoutMs = Math.min(budgetMs, 30_000)): Promise<unknown> => {
    if (closed || signal.aborted) return Promise.reject(new Error(signal.aborted ? 'cancelled' : 'action_failed'))
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const abort = () => {if (!write) stop()}
      const timer = setTimeout(stop, timeoutMs)
      pending.set(id, {resolve, reject, timer, write, abort})
      signal.addEventListener('abort', abort, {once: true})
      child.stdin.write(JSON.stringify({id, op, params}) + '\n', error => {if (error) stop()})
      if (signal.aborted) abort()
    })
  }
  const close = async (): Promise<boolean> => {
    stop()
    await killing
    if (!await child.waitTreeGone(2000)) return false
    if (focusLease && focusReader && macWindow) {
      try {
        const restored = await focusReader.request({...macWindow, op: 'focusRestore', ...focusLease}, AbortSignal.timeout(2000))
        if (restored.restored !== true) return false
        focusLease = undefined
      } catch {return false}
    }
    if (pointerReleaseNeeded || keyboardReleaseNeeded) {
      let cleanup: Awaited<ReturnType<typeof startComputerBackend>> | undefined
      let released = false
      try {
        cleanup = await startComputerBackend(displayId, AbortSignal.timeout(2000), 2000, worker, resources, clickHoldMs)
        await cleanup.releaseInput(pointerReleaseNeeded, keyboardReleaseNeeded)
        released = true
      } catch { /* Unconfirmed input release retains ownership. */ }
      if (cleanup && !await cleanup.close()) return false
      if (!released) return false
      pointerReleaseNeeded = false
      keyboardReleaseNeeded = undefined
    }
    await child.dispose()
    rmSync(temporary, {recursive: true, force: true})
    return true
  }
  const descriptions: Record<string, string> = {Tap: 'Click once at the point.', Input: 'Append text to the already focused field; Tap it first.', Scroll: 'Scroll once by a bounded distance.', KeyboardPress: 'Press a shortcut in the current focus; use Command on macOS, Control on Windows.'}
  const schemas = {Tap: actionTapParamSchema, Input: z.object({value: z.string().min(1).max(macWindow ? 200 : 4000), mode:z.enum(['append','replace']).default('append')}).strict(), Scroll: actionScrollParamSchema, KeyboardPress: actionKeyboardPressParamSchema}
  const device: AbstractInterface = {interfaceType: 'computer',
    size: async () => {
      const value = await request('size') as {width?: unknown; height?: unknown}
      if (typeof value?.width !== 'number' || typeof value.height !== 'number') throw new Error('action_failed')
      return {width: value.width, height: value.height}
    }, screenshotBase64: async () => {
      const value = await request('screenshot')
      if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,') || value.length > 50_000_000) throw new Error('action_failed')
      return value
    }, actionSpace: () => Object.entries(schemas).map(([name, paramSchema]) => ({name, description: descriptions[name] ?? name, paramSchema,
      call: async (params: unknown) => {
        if (['Tap', 'Input', 'KeyboardPress'].includes(name) && focusReader && macWindow) {
          const lease = {...focusSchema.parse(await focusReader.request({...macWindow, op: 'focusSnapshot'}, signal)), clickGroup: randomInt(1, 2147483647), releasePointer: name === 'Tap', ...(name === 'KeyboardPress' ? {releaseKey: actionKeyboardPressParamSchema.parse(params).keyName} : name === 'Input' ? {releaseKey: 'unicode'} : {})}
          if (closed || signal.aborted) throw Error('cancelled')
          focusLease = lease // Host survives worker teardown and releases targeted input before ownership.
          const receipt = await request(name, {...params as object, focusLease: lease}, true) as {restored?: unknown}
          if (name === 'Tap' && receipt?.restored !== true) {stop(); throw Error('cleanup_unknown')}
          focusLease = undefined
        } else {
          if (!macWindow && name === 'Tap') pointerReleaseNeeded = true
          if (!macWindow && name === 'KeyboardPress') keyboardReleaseNeeded = actionKeyboardPressParamSchema.parse(params).keyName
          await request(name, params, true)
          if (name === 'Tap') pointerReleaseNeeded = false
          if (name === 'KeyboardPress') keyboardReleaseNeeded = undefined
        }
      }}))}
  return {device, pid: child.pid, releaseInput: async (pointer: boolean, keyName?: string) => {await request('releaseInput', {pointer, ...(keyName ? {keyName} : {})}, true)}, windowTarget: async () => z.object({target: z.string().min(1), width: z.number().positive(), height: z.number().positive()}).parse(await request('target')), connect: async () => {await request('connect', undefined, true)}, listDisplays: async () => {
    const value = await request('listDisplays')
    return z.array(z.object({id: z.string()})).parse(value)
  }, close}
}
