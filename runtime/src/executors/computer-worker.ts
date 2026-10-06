/** Private local input process. No model, no task system, no DOM/AX tree and no logs. */
import {ComputerDevice} from '@midscene/computer'
import {setLogDirectoryResolver} from '@midscene/shared/logger'
import {devNull} from 'node:os'
import {validComputerDisplayId} from './computer-device.js'
import {createRequire} from 'node:module'
import {createInterface} from 'node:readline'

setLogDirectoryResolver(() => devNull)
// stdout is the RPC channel; SDK health-check chatter must not corrupt receipts.
console.log = console.info = console.warn = console.error = () => undefined
const clickHoldMs = Number(process.argv[3] ?? 100)
if (!Number.isSafeInteger(clickHoldMs) || clickHoldMs < 10 || clickHoldMs > 1000) throw Error('invalid_configuration')
const displayId = process.argv[2]
if (!displayId || !validComputerDisplayId(displayId)) throw new Error('invalid_configuration')
const device = new ComputerDevice({displayId})
// Public MouseAction avoids SDK Tap's automatic focus-follow-up click.
interface Mouse {setMousePosition(point: {x: number; y: number}): Promise<void>; currentMousePosition(): Promise<{x: number; y: number}>; pressButton(button: number): Promise<void>; releaseButton(button: number): Promise<void>}
const {DefaultMouseAction} = createRequire(import.meta.url)('@computer-use/libnut') as {DefaultMouseAction: new () => Mouse}
const mouse = new DefaultMouseAction()
let queue = Promise.resolve()
const input = createInterface({input: process.stdin})
input.on('line', (line: string) => {
  const message: unknown = JSON.parse(line)
  queue = queue.then(async () => {
    const request = message as {id: number; op: string; params?: unknown}
    if (!Number.isSafeInteger(request?.id) || typeof request.op !== 'string') return
    try {
      let value: unknown
      if (request.op === 'connect') await device.connect()
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
