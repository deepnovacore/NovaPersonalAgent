/** Private local input process. No model, no task system, no DOM/AX tree and no logs. */
import {ComputerDevice} from '@midscene/computer'
import {setLogDirectoryResolver} from '@midscene/shared/logger'
import {devNull} from 'node:os'
import {validComputerDisplayId} from './computer-device.js'
import {createRequire} from 'node:module'
import {createInterface} from 'node:readline'
import {z} from 'zod'
import {MacNativeReader} from '../connectors/macos/reader.js'

setLogDirectoryResolver(() => devNull)
// stdout is the RPC channel; SDK health-check chatter must not corrupt receipts.
console.log = console.info = console.warn = console.error = () => undefined
const clickHoldMs = Number(process.argv[3] ?? 100)
if (!Number.isSafeInteger(clickHoldMs) || clickHoldMs < 10 || clickHoldMs > 1000) throw Error('invalid_configuration')
const displayId = process.argv[2]
if (!displayId || !validComputerDisplayId(displayId)) throw new Error('invalid_configuration')
const macWindow = process.argv[4] ? z.object({pid: z.number().int().positive().max(2147483647), windowId: z.number().int().positive().max(4294967295)}).strict().parse(JSON.parse(process.argv[4])) : undefined
if (macWindow && (process.platform !== 'darwin' || !process.argv[5])) throw Error('invalid_configuration')
const native = macWindow ? new MacNativeReader(process.argv[5]!, 'macos_gui') : undefined
let binding: string | undefined
const device = macWindow ? undefined : new ComputerDevice({displayId, inputStrategy: 'sequential'})
// Public MouseAction avoids SDK Tap's automatic focus-follow-up click.
interface Mouse {setMousePosition(point: {x: number; y: number}): Promise<void>; currentMousePosition(): Promise<{x: number; y: number}>; pressButton(button: number): Promise<void>; releaseButton(button: number): Promise<void>}
const mouse = macWindow ? undefined : new (createRequire(import.meta.url)('@computer-use/libnut') as {DefaultMouseAction: new () => Mouse}).DefaultMouseAction()
let queue = Promise.resolve()
const input = createInterface({input: process.stdin})
input.on('line', (line: string) => {
  const message: unknown = JSON.parse(line)
  queue = queue.then(async () => {
    const request = message as {id: number; op: string; params?: unknown}
    if (!Number.isSafeInteger(request?.id) || typeof request.op !== 'string') return
    try {
      let value: unknown
      if (native && macWindow) {
        const params = request.params as {locate?: {center?: [number, number]}; value?: string; keyName?: string; direction?: string; distance?: number; focusLease?: {focus: unknown; targetStarted: unknown; clickGroup: number}}
        const point = params?.locate?.center
        const body: Record<string, unknown> = {...macWindow, op: request.op, target: binding}
        if (request.op === 'Tap') Object.assign(body, {x: point?.[0], y: point?.[1], holdMs: clickHoldMs, focus: params?.focusLease?.focus, targetStarted: params?.focusLease?.targetStarted, clickGroup: params?.focusLease?.clickGroup})
        if (request.op === 'Input') body.value = params?.value
        if (request.op === 'KeyboardPress') body.keyName = params?.keyName
        if (request.op === 'Scroll') {
          const size = await native.request({...macWindow, op: 'size'})
          const distance = Math.round(params.distance ?? 300)
          if (!['up', 'down', 'left', 'right'].includes(params.direction ?? '') || !Number.isSafeInteger(distance) || distance <= 0) throw Error('invalid action')
          Object.assign(body, {x: point?.[0] ?? Number(size.width) / 2, y: point?.[1] ?? Number(size.height) / 2,
            dx: params.direction === 'left' ? distance : params.direction === 'right' ? -distance : 0,
            dy: params.direction === 'up' ? distance : params.direction === 'down' ? -distance : 0})
        }
        if (request.op === 'listDisplays') value = [{id: displayId}]
        else {
          const result = await native.request(body)
          if (request.op === 'target' || request.op === 'connect') {
            if (result.keyWindowMatches !== true || typeof result.target !== 'string' || (binding !== undefined && result.target !== binding)) throw Error('screen_changed')
            binding = result.target
          }
          value = request.op === 'screenshot' ? result.image : result
        }
      } else if (!device || !mouse) throw Error('invalid_configuration')
      else if (request.op === 'releaseInput') {
        const cleanup = z.object({pointer: z.boolean(), keyName: z.string().min(1).max(100).optional()}).strict().parse(request.params)
        if (cleanup.pointer) await mouse.releaseButton(0)
        if (cleanup.keyName) {
          // Match the pinned SDK's shortcut aliases; release only this approved shortcut's keys.
          const aliases: Record<string, string> = {windows: 'win', ctrl: 'control', esc: 'escape', del: 'delete', ins: 'insert', pgup: 'pageup', pgdn: 'pagedown',
            arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', volumedown: 'audio_vol_down', volumeup: 'audio_vol_up',
            mediavolumedown: 'audio_vol_down', mediavolumeup: 'audio_vol_up', mute: 'audio_mute', mediamute: 'audio_mute', mediaplay: 'audio_play',
            mediapause: 'audio_pause', mediaplaypause: 'audio_play', mediastop: 'audio_stop', medianexttrack: 'audio_next', mediaprevioustrack: 'audio_prev', medianext: 'audio_next', mediaprev: 'audio_prev'}
          const keys = cleanup.keyName.split('+').map(key => key.toLowerCase())
          const primary = keys.pop()!
          const native = createRequire(import.meta.url)(`@computer-use/libnut-${process.platform}`) as {keyToggle(key: string, state: string): void}
          for (const key of [({command: 'cmd', cmd: 'cmd', meta: 'meta', control: 'control', ctrl: 'control', shift: 'shift', alt: 'alt', option: 'alt'} as Record<string, string>)[primary] ?? aliases[primary] ?? primary, ...keys.reverse().map(key => aliases[key] ?? key)]) native.keyToggle(key, 'up')
        }
      }
      else if (request.op === 'connect') await device.connect()
      else if (request.op === 'listDisplays') value = await ComputerDevice.listDisplays()
      else if (request.op === 'size') value = await device.size()
      else if (request.op === 'screenshot') value = await device.screenshotBase64()
      else if (request.op === 'Tap') {
        const params = request.params as {locate: {center: [number, number]}}
        const [x, y] = params.locate.center
        if (![x, y].every(Number.isFinite)) throw Error('invalid_coordinates')
        await mouse.setMousePosition({x: Math.floor(x), y: Math.floor(y)})
        const current = await mouse.currentMousePosition()
        if (Math.abs(current.x - x) > 1 || Math.abs(current.y - y) > 1) throw new Error('pointer mismatch')
        await mouse.pressButton(0)
        try {await new Promise(resolve => setTimeout(resolve, clickHoldMs))} finally {await mouse.releaseButton(0)}
      } else {
        const action = device.actionSpace().find(item => item.name === request.op)
        if (!action || !['Input', 'Scroll', 'KeyboardPress'].includes(request.op)) throw new Error('invalid action')
        await action.call(request.op === 'Input' ? {...request.params as {value: string}, mode: 'typeOnly'} : request.params)
      }
      process.stdout.write(JSON.stringify({id: request.id, ok: true, value}) + '\n')
    } catch {process.stdout.write(JSON.stringify({id: request.id, ok: false}) + '\n')}
  }).catch(() => {process.exitCode = 1; process.exit(1)})
})
input.on('close', () => process.exit())
