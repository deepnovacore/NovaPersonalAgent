import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {readFile} from 'node:fs/promises'
import {createContext, runInContext} from 'node:vm'
import test from 'node:test'
import {browserWindowOptions} from '../src/main/security.mjs'
import {createWorkbenchFrame} from '../src/main/workbench-frame.mjs'
import {createWindowsPresentationWindows} from '../src/main/windows-presentation.mjs'

function setup({opaque = false, roundBounds = false} = {}) {
  const views = [], loads = []
  let closes = 0
  class View {
    children = []
    setBackgroundColor(color) { this.backgroundColor = color }
    setBounds(bounds) { this.bounds = {...bounds} }
    addChildView(view) { this.children.push(view) }
    removeChildView(view) { this.children = this.children.filter(child => child !== view) }
  }
  class WebContentsView extends View {
    constructor(options) {
      super()
      this.options = options
      this.webContents = {loadURL: url => loads.push(url), isDestroyed: () => closes > 0, close: () => closes++}
      views.push(this)
    }
  }
  class BaseWindow extends EventEmitter {
    contentView = new View()
    visible = false
    destroyed = false
    boundsWrites = 0
    constructor(options) {
      super()
      this.options = options
      this.bounds = {x: 10, y: 20, width: options.width, height: options.height}
    }
    getBounds() { return {...this.bounds} }
    getContentBounds() { return this.getBounds() }
    setBounds(bounds) {
      this.boundsWrites++
      this.bounds = {...bounds, width: bounds.width + Number(roundBounds), height: bounds.height + Number(roundBounds)}
      this.emit('resize')
    }
    isVisible() { return this.visible }
    showInactive() { this.visible = true; this.emit('show') }
    hide() { this.visible = false }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
    setResizable() {}
    setMinimumSize() {}
    setMaximumSize() {}
    setAlwaysOnTop() {}
    setHasShadow() {}
  }
  const options = browserWindowOptions('/preload.cjs', 'shell-test', {opaque})
  const shells = createWindowsPresentationWindows({BaseWindow, WebContentsView, options, workbenchBackground: '#f4f5f7', platform: 'win32'})
  return {shells, views, loads, options, get closes() { return closes }}
}

test('Windows workbench enables an opaque native frame and shadow while the orb keeps its transparent options', {skip:process.platform!=='win32'}, () => {
  const {shells, views, options} = setup()
  assert.equal(shells.workbench.options.transparent, false)
  assert.equal(shells.workbench.options.thickFrame, true)
  assert.equal(shells.workbench.options.hasShadow, true)
  assert.equal(shells.workbench.options.backgroundColor, '#f4f5f7')
  assert.equal(shells.workbench.options.alwaysOnTop, false)
  assert.equal(shells.orb.options.transparent, true)
  assert.equal(shells.orb.options.hasShadow, false)
  assert.equal(shells.orb.options.alwaysOnTop, true)
  for (const window of shells.windows) {
    assert.equal(window.options.frame, false)
    assert.equal(window.options.skipTaskbar, true)
    assert.equal(window.options.show, false)
    assert.equal(window.options.title, 'Nova Personal Agent Desktop')
    assert.equal(window.options.webPreferences, undefined, 'shells must not create extra renderers')
  }
  assert.equal(views.length, 1)
  assert.deepEqual(views[0].options.webPreferences, options.webPreferences)
  assert.equal(views[0].backgroundColor, '#00000000')
  assert.equal(setup({opaque: true}).shells.orb.options.transparent, false, 'preserve the explicit orb fallback')
})

test('mode switches reparent one renderer without reload and resize only its current view', {skip:process.platform!=='win32'}, () => {
  const {shells, views, loads} = setup()
  const view = views[0], renderer = shells.orb.webContents
  shells.orb.loadURL('nova://orb/index.html')
  for (let i = 0; i < 10; i++) {
    for (const collapsed of [false, true]) {
      const previous = shells.activeWindow
      previous.showInactive()
      const current = shells.select(collapsed)
      assert.equal(current.webContents, renderer)
      assert.equal(previous.isVisible(), false)
      assert.deepEqual(previous.contentView.children, [])
      assert.deepEqual(current.contentView.children, [view])
      current.setBounds({x: 40, y: 60, width: collapsed ? 160 : 1120, height: collapsed ? 160 : 780})
      assert.deepEqual(view.bounds, {x: 0, y: 0, width: current.bounds.width, height: current.bounds.height})
      previous.setBounds({x: 0, y: 0, width: 10, height: 10})
      assert.equal(view.bounds.width, current.bounds.width)
      assert.equal(shells.select(collapsed), current, 'selecting the same mode is a no-op')
    }
  }
  assert.deepEqual(loads, ['nova://orb/index.html'])
})

test('renderer is closed after both native shells close', {skip:process.platform!=='win32'}, () => {
  const state = setup()
  state.shells.orb.destroy()
  assert.equal(state.closes, 0)
  state.shells.workbench.destroy()
  assert.equal(state.closes, 1)
})

test('Windows mode switches preserve workbench bounds at fractional DPI and hidden windows stay hidden', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('  let personalCollapsed = false')
  const body = source.slice(start, source.indexOf("  ipcMain.handle('nova:personal:presentation-error'", start))
  const {shells} = setup({roundBounds: true})
  const area = {x: 0, y: 0, width: 1920, height: 1080}
  const screen = {getCursorScreenPoint: () => ({x: 0, y: 0}), getDisplayNearestPoint: () => ({workArea: area}), getDisplayMatching: () => ({workArea: area})}
  let syncs = 0
  const fixture = new Function('mainWindow', 'windowsPresentation', 'screen', 'orbWindow', 'sendToOrb', 'createWorkbenchFrame', 'currentSettings', 'settingsReady', 'settingsWriter', `${body};return {set:setPersonalCollapsed,frame:workbenchFrame,window:()=>mainWindow}`)(shells.orb, shells, screen, {sync: () => syncs++}, () => {}, o => createWorkbenchFrame({...o, platform: 'win32'}), {workbenchMaximized: false}, false, async () => {})
  fixture.set(false)
  const natural = shells.workbench.getBounds()
  assert.equal(shells.workbench.isVisible(), false)
  shells.workbench.showInactive()
  for (let i = 0; i < 20; i++) {
    fixture.set(true)
    assert.equal(fixture.window(), shells.orb)
    assert.equal(shells.orb.isVisible(), true)
    assert.equal(shells.workbench.isVisible(), false)
    fixture.set(false)
    assert.equal(fixture.window(), shells.workbench)
    assert.equal(shells.workbench.isVisible(), true)
    assert.equal(shells.orb.isVisible(), false)
    assert.deepEqual(shells.workbench.getBounds(), natural)
  }
  assert.equal(shells.workbench.boundsWrites, 1, 'do not feed rounded DIP bounds back into the native frame on every switch')
  assert.equal(syncs, 20)
  fixture.frame.toggleMaximize()
  fixture.set(true)
  fixture.set(false)
  assert.equal(fixture.frame.maximized, false)
  assert.ok(shells.workbench.getBounds().width < area.width, 'return to natural size after leaving a maximized workbench')
  shells.workbench.hide()
  fixture.set(true)
  assert.equal(shells.windows.some(window => window.isVisible()), false)
})

test('default maximize preference: 20 collapse/expand cycles keep a stable restore rectangle at fractional DPI', () => {
  return (async () => {
    const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
    const start = source.indexOf('  let personalCollapsed = false')
    const body = source.slice(start, source.indexOf("  ipcMain.handle('nova:personal:presentation-error'", start))
    const {shells} = setup({roundBounds: true})
    const area = {x: 0, y: 0, width: 1920, height: 1080}
    const screen = {getCursorScreenPoint: () => ({x: 0, y: 0}), getDisplayNearestPoint: () => ({workArea: area}), getDisplayMatching: () => ({workArea: area})}
    const writes = []
    const fixture = new Function('mainWindow', 'windowsPresentation', 'screen', 'orbWindow', 'sendToOrb', 'createWorkbenchFrame', 'currentSettings', 'settingsReady', 'settingsWriter', `${body};return {set:setPersonalCollapsed,frame:workbenchFrame}`)(shells.orb, shells, screen, {sync: () => {}}, () => {}, o => createWorkbenchFrame({...o, platform: 'win32'}), {workbenchMaximized: true}, true, async patch => { writes.push(patch) })
    fixture.set(false)
    shells.workbench.showInactive()
    const first = fixture.frame.naturalBounds()
    for (let i = 0; i < 20; i++) {
      fixture.set(true)
      fixture.set(false)
      assert.equal(fixture.frame.maximized, true)
      assert.deepEqual(fixture.frame.naturalBounds(), first, `cycle ${i}: restore rectangle must not grow`)
    }
    assert.deepEqual(writes, [], 'automatic fill and collapse must not write the preference')
    fixture.frame.toggleMaximize()
    assert.deepEqual(shells.workbench.getBounds().width, first.width + 1, 'one user restore applies the stored rectangle once')
  })()
})

test('two-shell construction and system-corner styling are limited to Windows', async () => {
  const main = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const index = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')
  const creation = main.slice(main.indexOf('async function createWindow('), main.indexOf('function openMemoryBoard('))
  assert.match(creation, /if \(process\.platform === 'win32'\) \{\s*windowsPresentation = createWindowsPresentationWindows/u)
  assert.match(creation, /windowsPresentation\?\.orb \?\? new BrowserWindow\(options\)/u)
  assert.match(index, /if \(bootstrap\.platform === 'win32'\) document\.body\.dataset\.platform = 'win32'/u)
})

test('presentation acknowledgement follows the destination shell after switching from background', {skip:process.platform!=='win32'}, async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const start = source.indexOf("ipcMain.handle('nova:personal:presentation',")
  const body = source.slice(start, source.indexOf('\n  })', start) + 5)
  const {shells} = setup()
  let handler, acknowledged = false
  // Deliver show separately so the test can observe which native shell owns
  // the acknowledgement, including a wake configuration that shows early.
  shells.workbench.show = () => {}
  shells.workbench.focus = () => {}
  const context = createContext({
    ipcMain: {handle: (_name, value) => { handler = value }},
    mainWindow: shells.orb,
    process: {platform: 'win32'},
    presentationMode: 'background', settingsReady: false,
    wakeWord: {configure: () => {}},
    acceptanceWakeSettings: value => value, currentSettings: {}, acceptance: null,
  })
  context.setPersonalCollapsed = collapsed => { context.mainWindow = shells.select(collapsed) }
  runInContext(body, context)
  const pending = handler({sender: shells.orb.webContents}, 'workbench').then(() => { acknowledged = true })
  await Promise.resolve()
  assert.equal(acknowledged, false)
  assert.equal(shells.orb.listenerCount('show'), 0)
  assert.equal(shells.workbench.listenerCount('show'), 1)
  shells.orb.emit('show')
  await Promise.resolve()
  assert.equal(acknowledged, false)
  shells.workbench.emit('show')
  await pending
  assert.equal(acknowledged, true)
})

for (const platform of ['darwin', 'linux']) test(`${platform} cannot construct Windows presentation shells`, () => {
  class ForbiddenWindow {
    constructor() { assert.fail('Windows shells and renderer must not be constructed on this platform') }
  }
  assert.equal(createWindowsPresentationWindows({platform, BaseWindow: ForbiddenWindow, WebContentsView: ForbiddenWindow}), null)
})

for (const platform of ['darwin', 'linux']) test(`${platform} keeps the native show acknowledgement before changing window bounds`, async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const start = source.indexOf("ipcMain.handle('nova:personal:presentation',")
  const body = source.slice(start, source.indexOf('\n  })', start) + 5)
  const events = [], sender = {}
  let handler, onShow
  runInContext(body, createContext({
    process: {platform}, presentationMode: 'workbench', settingsReady: false, wakeWord: null,
    mainWindow: {
      webContents: sender, isVisible: () => false,
      once: (_name, callback) => { events.push('listen-show'); onShow = callback },
      show: () => { events.push('show'); onShow() }, focus: () => events.push('focus'),
    },
    ipcMain: {handle: (_name, value) => { handler = value }},
    setPersonalCollapsed: () => events.push('change-bounds'),
  }))
  await handler({sender}, 'orb')
  assert.deepEqual(events, ['listen-show', 'change-bounds', 'show', 'focus'])
})
