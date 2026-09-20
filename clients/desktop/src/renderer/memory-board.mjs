import {personalMemoryBoard} from './personal-memory-board.mjs'
import {boardTabForKey} from './channel-tabs.mjs'
import {
  captureBoardScrollPositions,
  diagnosticScrollKey,
  restoreBoardScrollPositions,
} from './board-scroll-state.mjs'
import {
  channelAccent,
  channelLabel,
  channelTabForKey,
  orderChannelsConversationFirst,
  resolveActiveChannel,
} from './channel-tabs.mjs'

const channelsRoot = document.querySelector('#channels')
const channelTabsRoot = document.querySelector('#channel-tabs')
const statusLabel = document.querySelector('#status')
const refreshButton = document.querySelector('#refresh')
const copyJsonButton = document.querySelector('#copy-json')
const exportButton = document.querySelector('#export')
const clearButton = document.querySelector('#clear-conversation')
const memoryTab = document.querySelector('#memory-tab')
const diagnosticsTab = document.querySelector('#diagnostics-tab')
const memoryPanel = document.querySelector('#memory-panel')
const diagnosticsPanel = document.querySelector('#diagnostics-panel')
const diagnosticsRoot = document.querySelector('#diagnostics')

const personalTab = document.querySelector('#personal-tab')
const personalPanel = document.querySelector('#personal-panel')
const personalBoard = personalMemoryBoard(personalPanel, query => window.novaAudioAgentDesktop.memoryBoard.request(query))

let latestPayload = null
let inFlight = false
let copyInFlight = false
let exportInFlight = false
let clearInFlight = false
let activeTab = 'memory'
let activeChannel = null
let loadOwnership = 0
let historyExpanded = false
let pageInFlight = false

function itemContent(raw) {
  try {
    return JSON.stringify(typeof raw === 'string' ? JSON.parse(raw) : raw, null, 2)
  } catch {
    return String(raw)
  }
}

function boardTime(item) {
  return item.historical && Number.isFinite(item.recorded_at_ms)
    ? `历史 · ${new Date(item.recorded_at_ms).toLocaleString()}`
    : `t=${Number(item.ts).toFixed(1)}s`
}

function renderItem(item, conversation = false) {
  const article = document.createElement('article')
  article.className = 'item'
  article.dataset.seq = String(item.seq)
  const meta = document.createElement('div')
  meta.className = 'meta'
  const trust = document.createElement('span')
  trust.className = `tag tag-trust trust-${item.trust}`
  trust.textContent = item.trust
  const seq = document.createElement('span')
  seq.className = 'item-ref'
  seq.textContent = `#${item.seq}`
  const ts = document.createElement('span')
  ts.className = 'item-time'
  ts.textContent = boardTime(item)
  meta.append(seq, trust, ts)
  if (item.outcome) {
    const outcome = document.createElement('span')
    outcome.className = 'tag tag-outcome'
    outcome.textContent = item.outcome
    meta.append(outcome)
  }
  if (item.truncated) {
    const truncated = document.createElement('span')
    truncated.className = 'tag tag-truncated'
    truncated.textContent = '已截断'
    meta.append(truncated)
  }
  const content = document.createElement('pre')
  content.textContent = itemContent(item.content)
  if (conversation) {
    let payload = item.content
    try { if (typeof payload === 'string') payload = JSON.parse(payload) } catch {}
    const role = payload?.role === 'user' || item.trust === 'trusted_user' ? 'user' : 'assistant'
    article.className = `item chat-message chat-${role}`
    article.tabIndex = 0
    article.setAttribute('aria-label', role === 'user' ? '你的消息，右键或 Shift+F10 查看详情' : 'Nova 的消息，右键或 Shift+F10 查看详情')
    const text = document.createElement('div')
    text.className = 'chat-text'
    text.textContent = typeof payload?.text === 'string' ? payload.text
      : typeof payload === 'string' ? payload : '非文本消息'
    const debug = document.createElement('div')
    debug.className = 'chat-debug'
    debug.hidden = true
    article.setAttribute('aria-expanded', 'false')
    const toggleDetails = event => {
      event.preventDefault()
      debug.hidden = !debug.hidden
      article.setAttribute('aria-expanded', String(!debug.hidden))
    }
    article.addEventListener('contextmenu', toggleDetails)
    article.addEventListener('keydown', event => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) toggleDetails(event)
      if (event.key === 'Escape') { debug.hidden = true; article.setAttribute('aria-expanded', 'false') }
    })
    debug.append(meta, content)
    article.append(text, debug)
  } else article.append(meta, content)
  return article
}

function renderChannel(channel, index) {
  const section = document.createElement('section')
  section.className = 'channel-card'
  // Keyed off the name, not the rail position: only one card is mounted, so
  // the accent has to travel with the channel rather than with its slot.
  section.style?.setProperty?.('--channel-accent', channelAccent(channel.name))
  const header = document.createElement('header')
  header.className = 'channel-header'
  const title = document.createElement('h2')
  title.id = `memory-channel-${index}`
  section.setAttribute('aria-labelledby', title.id)
  const shown = channel.items.length
  title.textContent = channelLabel(channel.name)
  const count = document.createElement('span')
  count.className = 'channel-count'
  count.textContent = channel.item_count > shown ? `${shown} / ${channel.item_count}` : String(channel.item_count)
  count.setAttribute('aria-label', channel.item_count > shown
    ? `显示最近 ${shown} 条，共 ${channel.item_count} 条`
    : `共 ${channel.item_count} 条`)
  header.append(title, count)

  const summary = document.createElement('p')
  summary.className = 'channel-summary'
  summary.textContent = channel.summary || '尚未生成频道摘要'

  const itemsRoot = document.createElement('div')
  itemsRoot.className = channel.name === 'conversation' ? 'channel-items chat-messages' : 'channel-items'
  itemsRoot.dataset.scrollKey = `channel:${channel.name}`
  if (channel.name === 'conversation') {
    const older = document.createElement('button')
    older.className = 'history-load'
    older.textContent = channel.has_more ? '向上滚动加载更早记录' : '已到可用记录的开头'
    older.disabled = !channel.has_more
    older.addEventListener('click', () => { void loadEarlier() })
    itemsRoot.append(older)
    itemsRoot.addEventListener('scroll', () => { if (itemsRoot.scrollTop === 0) void loadEarlier() })
    itemsRoot.addEventListener('wheel', event => { if (event.deltaY < 0 && itemsRoot.scrollTop === 0) void loadEarlier() }, {passive: true})
  }
  const historical = channel.name === 'conversation' ? channel.items.filter(item => item.historical) : []
  const current = channel.name === 'conversation' ? channel.items.filter(item => !item.historical) : channel.items
  if (historical.length) {
    const history = document.createElement('details')
    history.className = 'conversation-history'
    history.open = historyExpanded
    history.addEventListener('toggle', () => { historyExpanded = history.open })
    const label = document.createElement('summary')
    label.textContent = `重启前的历史记录（最近 ${historical.length} 条）`
    const historyItems = document.createElement('div')
    historyItems.className = 'chat-messages'
    for (const item of historical) historyItems.append(renderItem(item, true))
    history.append(label, historyItems)
    itemsRoot.append(history)
  }
  if (channel.name === 'conversation' && channel.historical_through_seq) {
    const label = document.createElement('p')
    label.className = 'conversation-boundary'
    label.textContent = '本次连接'
    itemsRoot.append(label)
  }
  if (!current.length) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = channel.name === 'conversation' ? '本次连接暂无对话' : '暂无记录'
    itemsRoot.append(empty)
  }
  for (const item of current) itemsRoot.append(renderItem(item, channel.name === 'conversation'))
  if (channel.name === 'conversation') section.append(header, itemsRoot)
  else section.append(header, summary, itemsRoot)
  return section
}

function renderDiagnostic(record, backendGeneration) {
  const article = document.createElement('article')
  article.className = 'diagnostic-record'
  const header = document.createElement('header')
  const kind = document.createElement('strong')
  kind.textContent = record.kind
  const timestamp = document.createElement('span')
  timestamp.textContent = boardTime(record)
  header.append(kind, timestamp)
  const payload = document.createElement('pre')
  payload.dataset.scrollKey = diagnosticScrollKey(backendGeneration, record)
  payload.textContent = JSON.stringify(record.payload, null, 2)
  article.append(header, payload)
  return article
}

function validDiagnostics(payload) {
  return payload?.diagnostics?.version === 1
    && Number.isSafeInteger(payload.backend_generation)
    && payload.backend_generation > 0
    && Array.isArray(payload.diagnostics.records)
    && payload.diagnostics.records.length <= 128
    && payload.diagnostics.records.every(record => (
      record
      && Number.isSafeInteger(record.seq)
      && record.seq > 0
      && Number.isFinite(record.ts)
      && typeof record.kind === 'string'
      && record.payload
      && typeof record.payload === 'object'
      && !Array.isArray(record.payload)
    ))
}

function orderedChannels() {
  return orderChannelsConversationFirst(latestPayload?.channels ?? [])
}

function renderActiveChannelCard() {
  const channel = orderedChannels().find(entry => entry.name === activeChannel)
  channelsRoot.replaceChildren(...(channel ? [renderChannel(channel, 0)] : []))
}

function markActiveChannelTab() {
  for (const tab of channelTabsRoot.children ?? []) {
    const selected = tab.dataset.channel === activeChannel
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
  }
}

/**
 * Channel selection re-renders from the payload already in hand and never
 * issues a request, so it stays outside the single-flight bookkeeping that
 * guards the backend read.
 */
function selectChannel(name) {
  if (name === activeChannel) return
  activeChannel = name
  markActiveChannelTab()
  renderActiveChannelCard()
}

function buildChannelTab(name) {
  const tab = document.createElement('button')
  tab.type = 'button'
  tab.className = 'channel-tab'
  tab.id = `channel-tab-${name}`
  tab.dataset.channel = name
  tab.setAttribute('role', 'tab')
  tab.setAttribute('aria-controls', 'channels')
  tab.addEventListener('click', () => { selectChannel(name) })
  tab.addEventListener('keydown', event => {
    const names = [...(channelTabsRoot.children ?? [])].map(entry => entry.dataset.channel)
    const next = channelTabForKey(names, activeChannel, event.key)
    if (next === null) return
    event.preventDefault()
    selectChannel(next)
    document.querySelector(`#channel-tab-${next}`)?.focus?.()
  })
  return tab
}

/**
 * Rebuilds only when the channel set itself changes. The board refreshes every
 * two seconds, and replacing the buttons each time would drop the keyboard
 * focus sitting on one of them, stopping arrow navigation until the user
 * tabbed back into the rail.
 */
function renderChannelTabs() {
  const ordered = orderedChannels()
  const names = ordered.map(channel => channel.name)
  activeChannel = resolveActiveChannel(names, activeChannel)
  const mounted = [...(channelTabsRoot.children ?? [])].map(tab => tab.dataset.channel)
  if (mounted.length !== names.length || mounted.some((name, index) => name !== names[index])) {
    channelTabsRoot.replaceChildren(...names.map(buildChannelTab))
  }
  for (const [index, tab] of [...(channelTabsRoot.children ?? [])].entries()) {
    // Depth changes on nearly every refresh, so the label is always restated.
    tab.textContent = `${channelLabel(names[index])} ${ordered[index].item_count}`
  }
  markActiveChannelTab()
}

async function load() {
  if (document.hidden) return
  if (activeTab === 'personal') return
  if (clearInFlight) return
  if (inFlight || pageInFlight) return
  const owner = loadOwnership
  inFlight = true
  statusLabel.textContent = '加载中…'
  refreshButton.disabled = true
  try {
    const payload = await window.novaAudioAgentDesktop.memoryBoard.request()
    if (owner !== loadOwnership || document.hidden) return
    if (!payload || payload.error || !Array.isArray(payload.channels) || !validDiagnostics(payload)) {
      statusLabel.textContent = payload?.error === 'timeout' ? '后端无响应' : '加载失败'
      return
    }
    const sameGeneration = latestPayload?.backend_generation === payload.backend_generation && latestPayload?.conversation_epoch === payload.conversation_epoch
    const previous = sameGeneration ? latestPayload?.channels.find(c => c.name === 'conversation') : null
    const recent = payload.channels.find(c => c.name === 'conversation')
    if (previous && recent && recent.retention_revision === previous.retention_revision && recent.item_count >= previous.item_count) {
      // Fill any interval missed while the board was hidden before merging the recent tail.
      let cursor = recent.items[0]?.seq
      const last = previous.items.at(-1)?.seq
      const collected = [...recent.items]
      while (last !== undefined && cursor > last + 1) {
        const page = await window.novaAudioAgentDesktop.memoryBoard.request({channel: 'conversation', before_seq: cursor})
        if (!page || page.error || !Array.isArray(page.channels)) throw new Error('history_page_failed')
        if (owner !== loadOwnership || (page?.backend_generation !== payload.backend_generation || page?.conversation_epoch !== payload.conversation_epoch)) return
        const channel = page.channels?.find(c => c.name === 'conversation')
        if (!channel || channel.retention_revision !== recent.retention_revision) throw new Error('history_changed')
        if (!channel.items.length) break
        collected.push(...channel.items)
        const next = channel.items[0].seq
        if (next >= cursor) break
        cursor = next
      }
      recent.items = mergeItems(previous.items, collected)
      recent.has_more = previous.has_more
      recent.next_before_seq = previous.next_before_seq
    }
    latestPayload = payload
    const scrollPositions = captureBoardScrollPositions(document)
    copyJsonButton.disabled = copyInFlight
    exportButton.disabled = exportInFlight
    renderChannelTabs()
    renderActiveChannelCard()
    diagnosticsRoot.replaceChildren(...payload.diagnostics.records.map(record => (
      renderDiagnostic(record, payload.backend_generation)
    )))
    if (payload.diagnostics.records.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'empty'
      empty.textContent = '暂无诊断记录'
      diagnosticsRoot.append(empty)
    }
    restoreBoardScrollPositions(document, scrollPositions)
    statusLabel.textContent = `更新于 ${new Date().toLocaleTimeString()}`
  } catch {
    if (owner !== loadOwnership || document.hidden) return
    statusLabel.textContent = '加载失败'
  } finally {
    refreshButton.disabled = false
    inFlight = false
    if (owner !== loadOwnership && !document.hidden) {
      queueMicrotask(() => { void load() })
    }
  }
}

function mergeItems(older, newer) {
  const items = new Map(older.map(item => [item.seq, item]))
  for (const item of newer) {
    const previous = items.get(item.seq)
    if (!previous || !item.truncated || (previous.truncated && item.content.length > previous.content.length)) items.set(item.seq, item)
  }
  return [...items.values()].sort((a, b) => a.seq - b.seq)
}

async function loadEarlier() {
  const channel = latestPayload?.channels.find(c => c.name === 'conversation')
  if (activeChannel !== 'conversation' || !channel?.has_more || pageInFlight || inFlight || clearInFlight) return
  const owner = loadOwnership, generation = latestPayload.backend_generation, epoch = latestPayload.conversation_epoch
  const cursor = channel.next_before_seq
  pageInFlight = true
  try {
    const payload = await window.novaAudioAgentDesktop.memoryBoard.request({channel: 'conversation', before_seq: cursor})
    if (owner !== loadOwnership || payload?.backend_generation !== generation || latestPayload?.backend_generation !== generation || payload?.conversation_epoch !== epoch || latestPayload?.conversation_epoch !== epoch) return
    const page = payload.channels?.find(c => c.name === 'conversation')
    if (!page) { statusLabel.textContent = '历史记录加载失败，向上滚动重试'; return }
    const current = latestPayload.channels.find(c => c.name === 'conversation')
    if (!current || current.next_before_seq !== cursor || page.retention_revision !== current.retention_revision) return
    const positions = captureBoardScrollPositions(document)
    current.items = mergeItems(page.items, current.items)
    current.has_more = page.has_more
    current.next_before_seq = page.next_before_seq
    renderActiveChannelCard()
    restoreBoardScrollPositions(document, positions)
  } catch { statusLabel.textContent = '历史记录加载失败，向上滚动重试' }
  finally { pageInFlight = false }
}

async function copyBoardJson() {
  if (!latestPayload || copyInFlight || clearInFlight) return
  copyInFlight = true
  copyJsonButton.disabled = true
  try {
    const result = await window.novaAudioAgentDesktop.memoryBoard.copyJson()
    statusLabel.textContent = result?.copied ? '已复制 JSON' : '复制失败'
  } catch {
    statusLabel.textContent = '复制失败'
  } finally {
    copyInFlight = false
    copyJsonButton.disabled = latestPayload === null
  }
}

async function exportBoard() {
  if (!latestPayload || exportInFlight || clearInFlight) return
  exportInFlight = true
  exportButton.disabled = true
  try {
    const result = await window.novaAudioAgentDesktop.memoryBoard.export()
    if (result?.saved) statusLabel.textContent = `已导出：${result.saved}`
    else if (result?.error) statusLabel.textContent = '导出失败'
  } catch {
    statusLabel.textContent = '导出失败'
  } finally {
    exportInFlight = false
    exportButton.disabled = latestPayload === null
  }
}

async function clearConversation() {
  if (clearInFlight || copyInFlight || exportInFlight) return
  clearInFlight = true
  loadOwnership += 1
  clearButton.disabled = true
  copyJsonButton.disabled = true
  exportButton.disabled = true
  statusLabel.textContent = '等待清除确认…'
  try {
    const result = await window.novaAudioAgentDesktop.memoryBoard.clear()
    if (result?.cleared) {
      latestPayload = null
      channelsRoot.replaceChildren()
      channelTabsRoot.replaceChildren()
      statusLabel.textContent = '近期会话记录已清除'
    } else if (result?.canceled) statusLabel.textContent = '已取消清除'
    else statusLabel.textContent = '无法确认清除结果，请刷新检查'
  } catch {
    statusLabel.textContent = '无法确认清除结果，请刷新检查'
  } finally {
    clearInFlight = false
    clearButton.disabled = false
    copyJsonButton.disabled = latestPayload === null
    exportButton.disabled = latestPayload === null
  }
}

function selectTab(tab) {
  activeTab = tab
  const diagnosticsActive = activeTab === 'diagnostics'
  const tabElements = {memory: memoryTab, personal: personalTab, diagnostics: diagnosticsTab}
  for (const [name, element] of Object.entries(tabElements)) {
    element.setAttribute('aria-selected', String(name === activeTab))
    element.tabIndex = name === activeTab ? 0 : -1
  }
  memoryPanel.hidden = activeTab !== 'memory'
  diagnosticsPanel.hidden = !diagnosticsActive
  personalPanel.hidden = activeTab !== 'personal'
  copyJsonButton.hidden = exportButton.hidden = activeTab === 'personal'
  statusLabel.hidden = activeTab === 'personal'
  if (activeTab === 'personal') void personalBoard.load()
  copyJsonButton.disabled = copyInFlight || latestPayload === null
  clearButton.hidden = activeTab !== 'memory'
  exportButton.disabled = exportInFlight || latestPayload === null
  void load()
}

personalTab.addEventListener('click', () => { selectTab('personal') })
memoryTab.addEventListener('click', () => { selectTab('memory') })
diagnosticsTab.addEventListener('click', () => { selectTab('diagnostics') })
function handleTabKey(event) {
  const nextTab = boardTabForKey(activeTab, event.key)
  if (nextTab === null) return
  event.preventDefault()
  selectTab(nextTab)
  const tabElements = {memory: memoryTab, personal: personalTab, diagnostics: diagnosticsTab}
  const nextElement = tabElements[nextTab]
  nextElement.focus()
}
personalTab.addEventListener('keydown', handleTabKey)
memoryTab.addEventListener('keydown', handleTabKey)
diagnosticsTab.addEventListener('keydown', handleTabKey)
refreshButton.addEventListener('click', () => {
  if (activeTab === 'personal') { void personalBoard.load(); return }
  void load()
})
copyJsonButton.addEventListener('click', () => { void copyBoardJson() })
exportButton.addEventListener('click', () => { void exportBoard() })
clearButton.addEventListener('click', () => { void clearConversation() })
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    loadOwnership += 1
    return
  }
  void load()
})
setInterval(() => {
  if (document.hidden) return
  void load()
}, 2000)
selectTab('memory')
