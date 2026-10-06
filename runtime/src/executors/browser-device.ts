/** Managed Playwright page: screenshot and coordinates only; never DOM selectors or user profiles. */
import {randomUUID} from 'node:crypto'
import type {AbstractInterface} from '@midscene/core/device'
import {actionTapParamSchema, actionScrollParamSchema, actionKeyboardPressParamSchema} from '@midscene/core/device'
import {z} from '@midscene/core'
import {chromium, firefox, webkit, type BrowserServer} from 'playwright'
import type {ComputerTarget} from './computer-device.js'

export function validBrowserUrl(value: string): boolean {
  try {const url = new URL(value); return !url.username && !url.password
    && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))}
  catch {return false}
}

export async function createBrowserDevice(options: {engine: 'chromium' | 'firefox' | 'webkit'; headless: boolean;
  url: string; signal: AbortSignal; beforeWrite?: () => void; recordProcess?: (pid: number) => Promise<void>}) {
  const type = {chromium, firefox, webkit}[options.engine]
  let server: BrowserServer | undefined
  const close = async (): Promise<boolean> => {
    if (!server) return true
    const child = server.process()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const exit = new Promise<void>(resolve => {if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve())})
      await Promise.race([server.close().catch(() => undefined), new Promise<void>(resolve => {timer = setTimeout(resolve, 2000)})])
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) void server.kill().catch(() => undefined)
      await Promise.race([exit, new Promise<void>(resolve => {timer = setTimeout(resolve, 2000)})])
      return child.exitCode !== null || child.signalCode !== null
    } catch {return false} finally {clearTimeout(timer)}
  }
  try {
    options.signal.throwIfAborted()
    server = await type.launchServer({headless: options.headless, host: '127.0.0.1', timeout: 30_000})
    const pid = server.process().pid
    if (!pid) throw Error('invalid_configuration')
    await options.recordProcess?.(pid)
    options.signal.throwIfAborted()
    const browser = await type.connect(server.wsEndpoint(), {timeout: 30_000})
    options.signal.throwIfAborted()
    const context = await browser.newContext({viewport: {width: 1280, height: 800}, deviceScaleFactor: 1})
    options.signal.throwIfAborted()
    const page = await context.newPage()
    options.signal.throwIfAborted()
    page.setDefaultTimeout(30_000); page.setDefaultNavigationTimeout(30_000)
    let popup = false
    context.on('page', opened => {if (opened !== page) popup = true})
    options.signal.throwIfAborted(); options.beforeWrite?.()
    await page.goto(options.url, {waitUntil: 'domcontentloaded'})
    const id = randomUUID()
    const target = (): Promise<ComputerTarget> => {
      options.signal.throwIfAborted()
      const viewport = page.viewportSize()
      if (page.isClosed() || !browser.isConnected() || popup || !viewport || !validBrowserUrl(page.url())) throw Error('screen_changed')
      return Promise.resolve({displayId: id, ...viewport, target: JSON.stringify([id, page.url(), viewport])})
    }
    const check = async () => {await target()}
    const device: AbstractInterface = {interfaceType: 'browser', size: async () => {const {width, height} = await target(); return {width, height}},
      screenshotBase64: async () => {await check(); const bytes = await page.screenshot({type: 'png', timeout: 30_000}); await check(); return `data:image/png;base64,${bytes.toString('base64')}`},
      actionSpace: () => [
        {name: 'Tap', description: 'Click the point once.', paramSchema: actionTapParamSchema, call: async (params: unknown) => {
          await check(); const {locate} = params as {locate: {center: [number, number]}}; await page.mouse.click(...locate.center)
        }},
        {name: 'Input', description: 'Append text to the focused field; Tap it first.', paramSchema: z.object({value: z.string().min(1).max(4000)}).strict(),
          call: async (params: unknown) => {await check(); await page.keyboard.insertText((params as {value: string}).value)}},
        {name: 'KeyboardPress', description: 'Press a key in the current focus. Use Meta for macOS shortcuts.', paramSchema: actionKeyboardPressParamSchema,
          call: async (params: unknown) => {await check(); await page.keyboard.press((params as {keyName: string}).keyName.replace(/\b(?:Command|CMD)\b/gu, 'Meta'))}},
        {name: 'Scroll', description: 'Scroll once by a bounded pixel distance.', paramSchema: actionScrollParamSchema,
          call: async (params: unknown) => {await check(); const {direction = 'down', distance = 400, locate} = params as {direction?: string; distance?: number; locate?: {center: [number, number]}};
            await page.mouse.move(...(locate?.center ?? [640, 400] as [number, number])); await page.mouse.wheel(direction === 'left' ? -distance : direction === 'right' ? distance : 0,
              direction === 'up' ? -distance : direction === 'down' ? distance : 0)}}]}
    return {device, target, id, close}
  } catch (error) {if (!await close()) throw Error('cleanup_unknown'); throw error}
}
