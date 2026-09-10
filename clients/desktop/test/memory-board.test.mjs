import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  captureBoardScrollPositions,
  diagnosticScrollKey,
  restoreBoardScrollPositions,
} from '../src/renderer/board-scroll-state.mjs'
import * as channelTabs from '../src/renderer/channel-tabs.mjs'

class BoardElement extends EventTarget {
  constructor(id) {
    super()
    this.id = id
    this.dataset = {}
    this.children = []
    this.attributes = new Map()
    this.disabled = false
    this.hidden = false
    this.tabIndex = 0
    this.textContent = ''
  }

  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = [...children] }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  focus() {}
  click() { this.dispatchEvent(new Event('click')) }
}

class BoardDocument extends EventTarget {
  constructor() {
    super()
    this.hidden = false
    this.scrollingElement = new BoardElement('page')
    this.elements = new Map([
      'channels', 'status', 'refresh', 'export', 'copy-json', 'memory-tab',
      'diagnostics-tab', 'graph-tab', 'memory-panel', 'diagnostics-panel',
      'graph-panel', 'diagnostics', 'workspace-graph', 'graph-state',
      'clear-conversation', 'channel-tabs',
    ].map(id => [`#${id}`, new BoardElement(id)]))
  }

  querySelector(selector) { return this.elements.get(selector) ?? null }
  querySelectorAll(selector) {
    assert.equal(selector, '[data-scroll-key]')
    return []
  }
  createElement(tagName) { return new BoardElement(tagName) }
}

function settle() {
  return new Promise(resolve => setImmediate(resolve))
}

test('diagnostic scroll identity stays unique when kind and timestamp collide', () => {
  const first = diagnosticScrollKey(3, {seq: 41, kind: 'renderer.ack', ts: 7})
  const second = diagnosticScrollKey(3, {seq: 42, kind: 'renderer.ack', ts: 7})

  assert.equal(first, 'diagnostic:3:41')
  assert.equal(second, 'diagnostic:3:42')
})

test('diagnostic scroll identity changes when a replacement backend reuses a sequence', () => {
  const record = {seq: 1, kind: 'renderer.ack', ts: 7}

  assert.notEqual(diagnosticScrollKey(8, record), diagnosticScrollKey(9, record))
})

test('board refresh preserves page and keyed panel scroll positions after DOM replacement', () => {
  const page = {dataset: {}, scrollTop: 21, scrollLeft: 7}
  const oldChannel = {dataset: {scrollKey: 'channel:alpha'}, scrollTop: 83, scrollLeft: 11}
  const oldDiagnostic = {dataset: {scrollKey: 'diagnostic:one'}, scrollTop: 47, scrollLeft: 13}
  const document = {scrollingElement: page, querySelectorAll: selector => {
    assert.equal(selector, '[data-scroll-key]')
    return [oldChannel, oldDiagnostic]
  }}

  const positions = captureBoardScrollPositions(document)
  const newChannel = {dataset: {scrollKey: 'channel:alpha'}, scrollTop: 0, scrollLeft: 0}
  const newDiagnostic = {dataset: {scrollKey: 'diagnostic:one'}, scrollTop: 0, scrollLeft: 0}
  document.querySelectorAll = () => [newChannel, newDiagnostic]

  restoreBoardScrollPositions(document, positions)

  assert.deepEqual(
    [page.scrollTop, page.scrollLeft, newChannel.scrollTop, newChannel.scrollLeft, newDiagnostic.scrollTop, newDiagnostic.scrollLeft],
    [21, 7, 83, 11, 47, 13],
  )
})

test('board auto-refresh is renderer-owned, guarded, and visibility-aware', async () => {
  const source = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')

  assert.match(source, /setInterval\(/)
  assert.match(source, /2000/)
  assert.match(source, /let inFlight = false/)
  assert.match(source, /if \(inFlight\) return/)
  assert.match(source, /async function load\(\) \{\n\s*if \(document\.hidden\) return/)
  assert.match(source, /const owner = loadOwnership[\s\S]*await window\.novaAudioAgentDesktop\.memoryBoard\.request\(\)[\s\S]*owner !== loadOwnership/u)
  assert.match(source, /document\.hidden\) \{\s*loadOwnership \+= 1/u)
  assert.match(source, /addEventListener\('visibilitychange'/)
  assert.match(source, /let exportInFlight = false/)
  assert.match(source, /exportButton\.disabled = exportInFlight/)
})

test('board caches the latest payload and exports it through the preload API', async () => {
  const source = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')

  assert.match(source, /let latestPayload = null/)
  assert.match(source, /latestPayload = payload/)
  assert.match(source, /memoryBoard\.export\(\)/)
  assert.doesNotMatch(source, /memoryBoard\.export\(\{\s*channels:/)

  const html = await readFile(new URL('../src/renderer/memory-board.html', import.meta.url), 'utf8')
  assert.match(html, /<button id="copy-json" type="button" disabled>复制 JSON<\/button>/)
  assert.match(html, /<button id="export" type="button" disabled>导出<\/button>/)
})

test('copy JSON uses the sender-validated desktop bridge when web clipboard permission is denied', async t => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const intervalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'setInterval')
  const dateDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Date')
  const document = new BoardDocument()
  const requestDetails = []
  const clipboardWrites = []
  const compact = {
    channels: [], backend_generation: 4,
    diagnostics: {version: 1, records: []},
  }
  const full = {
    backend_generation: 4,
    channels: [{name: 'conversation', summary: null, item_count: 1, items: [{seq: 1}]}],
    diagnostics: {version: 1, records: [{seq: 2, ts: 3.5, kind: 'runtime', payload: {ok: true}}]},
  }
  const RealDate = Date
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? ['2026-09-02T03:00:00.000Z'] : args))
    }
  }
  Object.defineProperties(globalThis, {
    document: {configurable: true, value: document},
    window: {configurable: true, value: {
      novaAudioAgentDesktop: {
        memoryBoard: {request: async detail => {
          requestDetails.push(detail)
          return detail === 'full' ? full : compact
        }, copyJson: async () => {
          clipboardWrites.push('desktop bridge')
          return {copied: true}
        }, export: async () => ({canceled: true})},
        graphBoard: {request: async () => ({error: 'unavailable'})},
      },
    }},
    navigator: {configurable: true, value: {
      clipboard: {writeText: async () => { throw new Error('NotAllowedError') }},
    }},
    setInterval: {configurable: true, value: () => 1},
    Date: {configurable: true, value: FixedDate},
  })
  t.after(() => {
    for (const [key, descriptor] of Object.entries({
      document: documentDescriptor,
      window: windowDescriptor,
      navigator: navigatorDescriptor,
      setInterval: intervalDescriptor,
      Date: dateDescriptor,
    })) {
      if (descriptor === undefined) delete globalThis[key]
      else Object.defineProperty(globalThis, key, descriptor)
    }
  })

  await import(`../src/renderer/memory-board.mjs?copy-test=${Date.now()}`)
  await settle()
  document.querySelector('#copy-json').click()
  await settle()

  assert.deepEqual(requestDetails, [undefined])
  assert.deepEqual(clipboardWrites, ['desktop bridge'])
  assert.equal(document.querySelector('#status').textContent, '已复制 JSON')
})

test('clearing fences a stale read, is single-flight, and blocks export', async t => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const intervalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'setInterval')
  const document = new BoardDocument()
  const requests = [], clears = [], exports = []
  let resolveRead, resolveClear
  const stale = {backend_generation: 1, channels: [{name: 'conversation', summary: 'old', item_count: 1, items: [{seq: 1, trust: 'inferred', ts: 1, content: 'old'}]}], diagnostics: {version: 1, records: []}}
  Object.defineProperties(globalThis, {
    document: {configurable: true, value: document},
    window: {configurable: true, value: {novaAudioAgentDesktop: {
      memoryBoard: {
        request: () => new Promise(resolve => { requests.push(resolve); if (!resolveRead) resolveRead = resolve }),
        clear: () => new Promise(resolve => { clears.push(resolve); resolveClear = resolve }),
        copyJson: async () => ({copied: true}),
        export: async () => { exports.push(true); return {saved: 'never.json'} },
      },
      graphBoard: {request: async () => ({error: 'unavailable'})},
    }}},
    navigator: {configurable: true, value: {}},
    setInterval: {configurable: true, value: () => 1},
  })
  t.after(() => {
    for (const [key, descriptor] of Object.entries({
      document: documentDescriptor, window: windowDescriptor, navigator: navigatorDescriptor, setInterval: intervalDescriptor,
    })) {
      if (descriptor === undefined) delete globalThis[key]
      else Object.defineProperty(globalThis, key, descriptor)
    }
  })

  await import(`../src/renderer/memory-board.mjs?clear-test=${Date.now()}`)
  await settle()
  assert.equal(requests.length, 1)
  document.querySelector('#clear-conversation').click()
  document.querySelector('#clear-conversation').click()
  document.querySelector('#export').click()
  assert.equal(clears.length, 1)
  assert.equal(exports.length, 0)
  resolveClear({cleared: true})
  await settle()
  assert.equal(document.querySelector('#status').textContent, '近期会话记录已清除')
  resolveRead(stale)
  await settle()
  await settle()
  assert.equal(document.querySelector('#channels').children.length, 0)
  assert.equal(exports.length, 0)
})

test('board presents accessible Memory, Diagnostics and Graph tabs and never exports graph data', async () => {
  const source = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')
  const html = await readFile(new URL('../src/renderer/memory-board.html', import.meta.url), 'utf8')

  assert.match(html, /role="tablist"/)
  assert.match(html, /id="memory-tab"[^>]+role="tab"/)
  assert.match(html, /id="diagnostics-tab"[^>]+role="tab"/)
  assert.match(html, /id="graph-tab"[^>]+role="tab"/)
  assert.match(html, /id="memory-panel"[^>]+role="tabpanel"/)
  assert.match(html, /id="diagnostics-panel"[^>]+role="tabpanel"/)
  assert.match(html, /id="graph-panel"[^>]+role="tabpanel"/)
  assert.match(source, /graphBoard\.request\(\)/)
  assert.match(source, /exportButton\.hidden = activeTab === 'graph'/)
  assert.match(source, /boardTabForKey\(activeTab, event\.key\)/)
  assert.match(source, /tabElements\[nextTab\]/u)
  assert.match(source, /\.focus\(\)/)
  assert.doesNotMatch(source, /graphBoard\.export|workspace_graph\.board\.(?:delete|edit|suppress|merge|switch|inspect)/u)
})

test('diagnostics render versioned body-free lifecycle records', async () => {
  const source = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')
  const css = await readFile(new URL('../src/renderer/memory-board.css', import.meta.url), 'utf8')

  assert.match(source, /payload\?\.diagnostics\?\.version === 1/u)
  assert.match(source, /payload\.diagnostics\.records\.length <= 128/u)
  assert.match(source, /Number\.isSafeInteger\(payload\.backend_generation\)/u)
  assert.match(source, /Number\.isSafeInteger\(record\.seq\)/u)
  assert.match(source, /function renderDiagnostic\(/u)
  assert.match(source, /diagnosticsRoot\.replaceChildren/u)
  assert.match(css, /#diagnostics/u)
  assert.match(css, /\.diagnostic-record/u)
})

test('memory channels render as semantic cards with summary, count, tags, and a scroll region', async () => {
  const source = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')
  const css = await readFile(new URL('../src/renderer/memory-board.css', import.meta.url), 'utf8')

  assert.match(source, /section\.className = 'channel-card'/)
  assert.match(source, /header\.className = 'channel-header'/)
  assert.match(source, /count\.className = 'channel-count'/)
  assert.match(source, /summary\.className = 'channel-summary'/)
  assert.match(source, /itemsRoot\.className = channel\.name === 'conversation'/)
  assert.match(source, /className = `tag tag-trust trust-\$\{item\.trust\}`/)
  assert.match(source, /className = 'tag tag-outcome'/)
  assert.match(source, /className = 'tag tag-truncated'/)
  assert.match(css, /#channels\s*\{\s*display:\s*block;\s*\}/)
  assert.doesNotMatch(css, /\.channel-card:nth-child/, 'accents follow the channel, not its slot')
  assert.match(css, /\.channel-items\s*\{[^}]*overflow:\s*auto;/s)
  assert.match(css, /font-family:\s*ui-monospace/)
  assert.match(css, /\.channel-tabs\s*\{[^}]*overflow-x:\s*auto;/s)
  assert.match(css, /\.channel-tabs \.channel-tab\[aria-selected="true"\]/)
})

test('export handler saves through a dialog with the atomic write pattern', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const formatter = await readFile(new URL('../src/main/debug-board-client.mjs', import.meta.url), 'utf8')

  assert.match(source, /ipcMain\.handle\('nova:memory-board:export', async event => \{\n\s*if \(!boardWindow \|\| event\.sender !== boardWindow\.webContents\)/)
  assert.match(source, /requestBoardSnapshot\(connection, \{\s*board: 'memory',\s*detail: 'full',\s*\}\)/u)
  assert.match(source, /formatMemoryBoardExport\(snapshot\)/u)
  assert.match(formatter, /snapshot\.diagnostics\.records\.length > 128/u)
  assert.match(formatter, /Number\.isSafeInteger\(record\.seq\)/u)
  assert.match(formatter, /snapshot\.diagnostics\.records\.every/u)
  assert.match(formatter, /Buffer\.byteLength\(body, 'utf8'\) > MAX_MEMORY_BOARD_EXPORT_BYTES/u)
  assert.match(source, /dialog\.showSaveDialog/)
  assert.match(source, /memory-board-/)
  assert.match(formatter, /exported_at/)
  assert.match(source, /mode: 0o600/)
  assert.match(source, /randomBytes\(4\)\.toString\('hex'\)/)
  assert.match(source, /const temporary = [^\n]+\n\s*try \{\n\s*await writeFile\(temporary/)
  assert.match(source, /await rename\(temporary, filePath\)/)
})

test('main requests compact board snapshots directly without relaying through the orb', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  assert.match(source, /createDebugBoardRequester\(\)/)
  assert.match(source, /ipcMain\.handle\('nova:memory-board:request', async \(event, detail\) =>/u)
  assert.match(source, /board: 'memory',\s*detail: detail === 'full' \? 'full' : 'compact'/u)
  assert.match(source, /backendGeneration \+= 1/u)
  assert.match(source, /backend_generation: generation/u)
  assert.match(source, /board: 'workspace_graph',\s*detail: 'compact'/u)
  assert.doesNotMatch(source, /nova:memory-board:(?:fetch|data)/u)
  assert.doesNotMatch(source, /nova:workspace-graph-board:(?:fetch|data)/u)
  const exportBody = source.slice(source.indexOf("ipcMain.handle('nova:memory-board:export'"))
  assert.match(exportBody, /loadMemoryBoardExport\(\)/)
  assert.doesNotMatch(exportBody.slice(0, exportBody.indexOf("ipcMain.handle('nova:settings:get'")), /graph|workspace_graph/u)
})

test('channel labels mirror the runtime manifests and unwrap dynamic servers', () => {
  // The wire payload carries no display_name, so these must not drift from
  // the executor manifests they mirror.
  assert.equal(channelTabs.channelLabel('conversation'), '对话')
  assert.equal(channelTabs.channelLabel('watch'), 'Watch')
  assert.equal(channelTabs.channelLabel('guard'), 'Guard')
  assert.equal(channelTabs.channelLabel('codex'), 'Codex')
  assert.equal(channelTabs.channelLabel('search'), '搜索')
  assert.equal(channelTabs.channelLabel('mcp__nova_camera'), '相机')
  assert.equal(channelTabs.channelLabel('mcp__nova_knowledge'), '知识库')
  assert.equal(channelTabs.channelLabel('mcp__acme_tools'), 'acme_tools', 'a dynamic server sheds its prefix')
  assert.equal(channelTabs.channelLabel('unknown_channel'), 'unknown_channel')
  assert.equal(channelTabs.channelLabel(undefined), '')
})

test('conversation leads the rail and other channels keep payload order', () => {
  const ordered = channelTabs.orderChannelsConversationFirst([
    {name: 'codex'}, {name: 'guard'}, {name: 'conversation'}, {name: 'watch'},
  ])

  assert.deepEqual(ordered.map(channel => channel.name), ['conversation', 'codex', 'guard', 'watch'])
  assert.deepEqual(channelTabs.orderChannelsConversationFirst([]), [])
  assert.deepEqual(channelTabs.orderChannelsConversationFirst(null), [], 'a malformed payload yields no tabs')
  assert.deepEqual(
    channelTabs.orderChannelsConversationFirst([{name: 'watch'}, {}]).map(channel => channel.name),
    ['watch'],
    'a nameless channel cannot own a tab',
  )
})

test('rail navigation rolls over a runtime-sized channel list', () => {
  const names = ['conversation', 'watch', 'guard']

  assert.equal(channelTabs.channelTabForKey(names, 'conversation', 'ArrowRight'), 'watch')
  assert.equal(channelTabs.channelTabForKey(names, 'conversation', 'ArrowLeft'), 'guard', 'wraps backwards')
  assert.equal(channelTabs.channelTabForKey(names, 'guard', 'ArrowRight'), 'conversation', 'wraps forwards')
  assert.equal(channelTabs.channelTabForKey(names, 'guard', 'Home'), 'conversation')
  assert.equal(channelTabs.channelTabForKey(names, 'conversation', 'End'), 'guard')
  assert.equal(channelTabs.channelTabForKey(names, 'conversation', 'Tab'), null, 'other keys pass through')
  assert.equal(channelTabs.channelTabForKey(names, 'vanished', 'ArrowRight'), null)
  assert.equal(channelTabs.channelTabForKey([], 'conversation', 'ArrowRight'), null)
})

test('the selected channel survives a refresh and falls back when it disappears', () => {
  assert.equal(channelTabs.resolveActiveChannel(['conversation', 'guard'], 'guard'), 'guard')
  assert.equal(
    channelTabs.resolveActiveChannel(['conversation', 'watch'], 'guard'),
    'conversation',
    'a channel the backend stopped reporting yields to the first',
  )
  assert.equal(channelTabs.resolveActiveChannel(['conversation'], null), 'conversation')
  assert.equal(channelTabs.resolveActiveChannel([], 'guard'), null)
})

test('a channel accent follows its name, not its position in the rail', () => {
  assert.equal(channelTabs.channelAccent('watch'), channelTabs.channelAccent('watch'))
  assert.match(channelTabs.channelAccent('conversation'), /^#[0-9a-f]{6}$/)
  assert.match(channelTabs.channelAccent(''), /^#[0-9a-f]{6}$/, 'never yields undefined')
})

test('the memory panel carries a channel rail above its cards', async () => {
  const html = await readFile(new URL('../src/renderer/memory-board.html', import.meta.url), 'utf8')
  const panel = html.match(/<section id="memory-panel"[\s\S]*?<\/section>/)?.[0]

  assert.ok(panel, 'the memory panel is present')
  assert.match(panel, /<nav class="channel-tabs" id="channel-tabs" role="tablist" aria-label="记忆频道"><\/nav>/)
  assert.ok(
    panel.indexOf('id="channel-tabs"') < panel.indexOf('id="channels"'),
    'the rail sits above the card it selects',
  )
  // The rail is built from the payload, so it must ship empty.
  assert.doesNotMatch(panel, /id="channel-tabs"[^>]*>\s*<button/)
})

test('the rail renders one tab per channel and mounts only the selected card', async t => {
  const descriptors = Object.fromEntries(['document', 'window', 'setInterval'].map(
    key => [key, Object.getOwnPropertyDescriptor(globalThis, key)],
  ))
  const document = new BoardDocument()
  const payload = {
    backend_generation: 3,
    channels: [
      {name: 'codex', summary: 'built a thing', item_count: 2, items: [
        {seq: 1, trust: 'inferred', ts: 1, content: 'codex-one'},
      ]},
      {name: 'conversation', summary: null, item_count: 1, items: [
        {seq: 2, trust: 'trusted_system', ts: 2, content: 'said-hello'},
      ]},
      {name: 'mcp__acme_tools', summary: null, item_count: 0, items: []},
    ],
    diagnostics: {version: 1, records: []},
  }
  Object.defineProperties(globalThis, {
    document: {configurable: true, value: document},
    window: {configurable: true, value: {novaAudioAgentDesktop: {
      memoryBoard: {
        request: async () => payload,
        clear: async () => ({canceled: true}),
        copyJson: async () => ({copied: true}),
        export: async () => ({canceled: true}),
      },
      graphBoard: {request: async () => ({error: 'unavailable'})},
    }}},
    setInterval: {configurable: true, value: () => 1},
  })
  t.after(() => {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor === undefined) delete globalThis[key]
      else Object.defineProperty(globalThis, key, descriptor)
    }
  })

  await import(`../src/renderer/memory-board.mjs?rail-test=${Date.now()}`)
  await settle()

  const rail = document.querySelector('#channel-tabs')
  assert.deepEqual(
    rail.children.map(tab => tab.dataset.channel),
    ['conversation', 'codex', 'mcp__acme_tools'],
    'conversation leads regardless of payload order',
  )
  assert.deepEqual(
    rail.children.map(tab => tab.textContent),
    ['对话 1', 'Codex 2', 'acme_tools 0'],
    'each tab names its channel and its depth',
  )
  for (const tab of rail.children) assert.equal(tab.attributes.get('role'), 'tab')
  assert.equal(rail.children[0].attributes.get('aria-selected'), 'true')
  assert.equal(rail.children[0].tabIndex, 0)
  assert.equal(rail.children[1].attributes.get('aria-selected'), 'false')
  assert.equal(rail.children[1].tabIndex, -1, 'the rail is one tab stop')

  const cards = document.querySelector('#channels')
  assert.equal(cards.children.length, 1, 'only the selected channel is mounted')

  // Selecting a channel repaints from the cached payload; it must not read again.
  rail.children[1].click()
  await settle()
  assert.equal(rail.children[1].attributes.get('aria-selected'), 'true')
  assert.equal(rail.children[0].attributes.get('aria-selected'), 'false')
  assert.equal(document.querySelector('#channels').children.length, 1)
})

test('channel selection never issues a backend read', async () => {
  const source = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')
  const select = source.slice(source.indexOf('function selectChannel('))
  const body = select.slice(0, select.indexOf('\n}\n'))

  assert.doesNotMatch(body, /memoryBoard\.request|await|loadOwnership|inFlight/,
    'selection stays outside the single-flight read path')
  assert.match(source, /let activeChannel = null/)
  assert.match(source, /activeChannel = resolveActiveChannel\(/)
})

test('a refresh reuses the channel buttons so keyboard focus survives it', async t => {
  const descriptors = Object.fromEntries(['document', 'window', 'setInterval'].map(
    key => [key, Object.getOwnPropertyDescriptor(globalThis, key)],
  ))
  const document = new BoardDocument()
  let depth = 1
  let channels = ['conversation', 'codex']
  const payload = () => ({
    backend_generation: 3,
    channels: channels.map(name => ({
      name, summary: null, item_count: depth, items: [],
    })),
    diagnostics: {version: 1, records: []},
  })
  Object.defineProperties(globalThis, {
    document: {configurable: true, value: document},
    window: {configurable: true, value: {novaAudioAgentDesktop: {
      memoryBoard: {
        request: async () => payload(),
        clear: async () => ({canceled: true}),
        copyJson: async () => ({copied: true}),
        export: async () => ({canceled: true}),
      },
      graphBoard: {request: async () => ({error: 'unavailable'})},
    }}},
    setInterval: {configurable: true, value: () => 1},
  })
  t.after(() => {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor === undefined) delete globalThis[key]
      else Object.defineProperty(globalThis, key, descriptor)
    }
  })

  await import(`../src/renderer/memory-board.mjs?reuse-test=${Date.now()}`)
  await settle()

  const rail = document.querySelector('#channel-tabs')
  const firstPass = [...rail.children]
  assert.equal(firstPass.length, 2)

  // A refresh that only changes depth must not replace the focusable nodes:
  // in a browser, replacing them drops focus and arrow navigation stops.
  depth = 5
  document.querySelector('#refresh').click()
  await settle()
  assert.deepEqual([...rail.children], firstPass, 'the same button nodes are reused')
  assert.deepEqual(
    rail.children.map(tab => tab.textContent),
    ['对话 5', 'Codex 5'],
    'labels still restate the current depth',
  )

  // A genuine channel-set change does rebuild.
  channels = ['conversation', 'codex', 'guard']
  document.querySelector('#refresh').click()
  await settle()
  assert.equal(rail.children.length, 3)
  assert.notDeepEqual([...rail.children], firstPass, 'a new channel set rebuilds the rail')
})
