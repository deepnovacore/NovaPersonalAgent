import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  MutationObserver: dom.window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/react')
const { ConnectorsPage } = await import('../src/renderer/react/settings/connectors.tsx')
const { SpaceHostPanel } = await import('../src/renderer/react/settings/space-host.tsx')
afterEach(() => cleanup())

function personalState(extra: any = {}) {
  return {
    sources: [{
      id: 'source-notes', path: '/Users/me/notes', state: 'connected',
      scanned: 3, read: 2, skipped: 1, last_sync: '今天', processing_consent_required: false,
    }],
    connectors: {
      available: true, memory_available: true, local_available: true, mail_available: true,
      connections: [
        { id: 'gmail-fixture', toolkit: 'gmail', identity: 'me@example.test', state: 'connected', scope: { kind: 'gmail', labels: ['INBOX'], pastDays: 30 }, processing_allowed: false },
        { id: 'calendar-fixture', toolkit: 'macos_calendar', identity: '本机日历', state: 'connected', scope: { kind: 'calendar', calendars: ['home'], pastDays: 30, futureDays: 90 }, processing_allowed: false },
      ],
    },
    capabilities: { sources: true },
    ...extra,
  }
}

function feishuState(extra: any = {}) {
  return {
    available: true, configured: true, state: 'ready', scope_configured: true,
    account_name: 'Nova 用户', chats: [], notification_ready: true, notification_enabled: true,
    bot_enabled: true, app_setup: { state: 'idle' }, ...extra,
  }
}

function notificationSnapshot() {
  return { primary_binding_id: 'feishu', route_revision: 1, local: false, configured: true, bindings: [], counts: {}, deliveries: [] }
}

function bridge({ personal = personalState(), feishu = feishuState(), notifications = notificationSnapshot() }: any = {}) {
  const calls: any[] = []
  const api = {
    personalCommand: async (method: string, params: any) => {
      calls.push(['personal', method, structuredClone(params ?? {})])
      if (method === 'state')
        return structuredClone(personal)
      if (method === 'connector.link')
        return { id: 'new-connection', url: 'https://auth.example/connector' }
      return { ok: true }
    },
    feishuCommand: async (method: string, params: any) => {
      calls.push(['feishu', method, structuredClone(params ?? {})])
      if (method === 'feishu.status')
        return structuredClone(feishu)
      if (method === 'notifications.status')
        return structuredClone(notifications)
      return { ok: true }
    },
    openFeishuVerification: async (url: string) => { calls.push(['openFeishu', url]) },
    openConnectorAuthorization: async (url: string) => { calls.push(['openConnector', url]) },
    chooseDirectory: async () => '/tmp/docs',
  }
  return { api, calls }
}

const cardButtons = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('.connector-card[data-connector]')]
const cardById = (container: HTMLElement, id: string) => cardButtons(container).find((card) => card.dataset.connector === id)!
const statusOf = (container: HTMLElement, id: string) => cardById(container, id).querySelector('.connector-status')?.textContent
const detailTitle = (container: HTMLElement) => container.querySelector('#connector-detail-title')?.textContent ?? ''

test('连接器入口按顺序渲染飞书、文件夹、邮件、日历四张图标卡片', async () => {
  const b = bridge()
  const v = render(<ConnectorsPage api={b.api}/>)
  await waitFor(() => assert.equal(cardButtons(v.container).length, 4))
  assert.deepEqual(cardButtons(v.container).map((card) => card.dataset.connector), ['feishu', 'files', 'mail', 'calendar'])
  for (const card of cardButtons(v.container)) {
    assert.ok(card.querySelector('svg.lucide'), `${card.dataset.connector} 卡片需要 lucide 图标`)
    assert.ok(card.querySelector('.connector-card-title')?.textContent)
    assert.ok(card.querySelector('.connector-card-description')?.textContent)
  }
  assert.deepEqual(cardButtons(v.container).map((card) => card.querySelector('.connector-card-title')?.textContent), ['飞书', '文件夹', '邮件', '日历'])
})

test('状态徽标来自 personal state 与飞书状态数据', async () => {
  const b = bridge()
  const v = render(<ConnectorsPage api={b.api}/>)
  await waitFor(() => assert.equal(cardButtons(v.container).length, 4))
  for (const id of ['feishu', 'files', 'mail', 'calendar'])
    assert.equal(statusOf(v.container, id), '已连接', `${id} 应显示已连接`)
  assert.equal(cardById(v.container, 'feishu').dataset.tone, 'ok')
})

test('未连接、需要授权、异常与暂停状态映射为对应的中文徽标', async () => {
  const b = bridge({
    personal: personalState({
      sources: [{ id: 'source-paused', path: '/notes', state: 'paused' }],
      connectors: {
        available: true, memory_available: true, local_available: true, mail_available: true,
        connections: [
          { id: 'gmail-authorizing', toolkit: 'gmail', identity: null, state: 'authorizing' },
          { id: 'calendar-error', toolkit: 'macos_calendar', state: 'error', error: '同步失败' },
        ],
      },
    }),
    feishu: feishuState({ state: 'paused' }),
  })
  const v = render(<ConnectorsPage api={b.api}/>)
  await waitFor(() => assert.equal(cardButtons(v.container).length, 4))
  assert.equal(statusOf(v.container, 'feishu'), '已暂停')
  assert.equal(statusOf(v.container, 'files'), '已暂停')
  assert.equal(statusOf(v.container, 'mail'), '需要授权')
  assert.equal(statusOf(v.container, 'calendar'), '需处理')
  assert.equal(cardById(v.container, 'mail').dataset.tone, 'warn')
  assert.equal(cardById(v.container, 'calendar').dataset.tone, 'error')
})

test('未配置飞书时显示待配置，连接器服务缺失时显示不可用', async () => {
  const b = bridge({ personal: personalState({ connectors: null }), feishu: feishuState({ configured: false, scope_configured: false, state: 'unauthorized' }) })
  const v = render(<ConnectorsPage api={b.api}/>)
  await waitFor(() => assert.equal(cardButtons(v.container).length, 4))
  assert.equal(statusOf(v.container, 'feishu'), '待配置')
  assert.equal(statusOf(v.container, 'mail'), '不可用')
  assert.equal(statusOf(v.container, 'calendar'), '不可用')
})

test('点击飞书卡片进入详情并显示返回按钮与飞书面板，返回后回到卡片网格', async () => {
  const b = bridge()
  const v = render(<ConnectorsPage api={b.api}/>)
  await waitFor(() => assert.equal(cardButtons(v.container).length, 4))
  fireEvent.click(cardById(v.container, 'feishu'))
  await waitFor(() => assert.ok(v.getByRole('button', { name: '返回连接器' })))
  assert.equal(detailTitle(v.container), '飞书')
  assert.ok(v.container.querySelector('.connector-detail[data-connector="feishu"]'))
  await waitFor(() => assert.ok(v.container.querySelector('.im-card'), '飞书详情应挂载现有 ImPanel'))
  assert.ok([...v.container.querySelectorAll('.im-card h3')].some((heading) => heading.textContent === '飞书'))
  assert.ok(b.calls.some((call) => call[0] === 'feishu' && call[1] === 'feishu.status'), '详情页应读取飞书状态')
  fireEvent.click(v.getByRole('button', { name: '返回连接器' }))
  await waitFor(() => assert.equal(cardButtons(v.container).length, 4))
  assert.equal(v.container.querySelector('.connector-detail'), null)
})

test('文件夹、邮件、日历卡片分别挂载对应详情面板', async () => {
  const b = bridge()
  const v = render(<ConnectorsPage api={b.api}/>)
  await waitFor(() => assert.equal(cardButtons(v.container).length, 4))

  fireEvent.click(cardById(v.container, 'files'))
  await waitFor(() => assert.equal(detailTitle(v.container), '文件夹'))
  await waitFor(() => assert.ok(v.container.querySelector('[data-panel="files"]'), '文件夹详情应挂载本机资料面板'))
  assert.ok(v.getByText('本机目录'))
  assert.ok(v.getByText('添加授权来源'))
  fireEvent.click(v.getByRole('button', { name: '返回连接器' }))
  await waitFor(() => assert.equal(cardButtons(v.container).length, 4))

  fireEvent.click(cardById(v.container, 'mail'))
  await waitFor(() => assert.equal(detailTitle(v.container), '邮件'))
  await waitFor(() => assert.ok(v.container.querySelector('[data-panel="mail"]'), '邮件详情应挂载邮件面板'))
  assert.ok(v.getByRole('button', { name: '连接 Gmail' }))
  assert.ok(v.container.textContent?.includes('Gmail · me@example.test'))
  fireEvent.click(v.getByRole('button', { name: '返回连接器' }))
  await waitFor(() => assert.equal(cardButtons(v.container).length, 4))

  fireEvent.click(cardById(v.container, 'calendar'))
  await waitFor(() => assert.equal(detailTitle(v.container), '日历'))
  await waitFor(() => assert.ok(v.container.querySelector('[data-panel="calendar"]'), '日历详情应挂载日历面板'))
  assert.ok(v.getByRole('button', { name: '连接 Google 日历' }))
  assert.ok(v.container.textContent?.includes('本机日历'), '本机日历连接应出现在日历详情中')
})

test('邮件详情的 Gmail 授权仍走 connector.link 并打开授权页面', async () => {
  const b = bridge()
  const v = render(<ConnectorsPage api={b.api}/>)
  await waitFor(() => assert.equal(cardButtons(v.container).length, 4))
  fireEvent.click(cardById(v.container, 'mail'))
  await waitFor(() => assert.ok(v.getByRole('button', { name: '连接 Gmail' })))
  fireEvent.click(v.getByRole('button', { name: '连接 Gmail' }))
  await waitFor(() => assert.ok(b.calls.some((call) => call[0] === 'personal' && call[1] === 'connector.link' && call[2].toolkit === 'gmail')))
  await waitFor(() => assert.ok(b.calls.some((call) => call[0] === 'openConnector' && call[1] === 'https://auth.example/connector')))
})

test('刷新状态会重新读取个人状态与飞书状态', async () => {
  const b = bridge()
  const v = render(<ConnectorsPage api={b.api}/>)
  await waitFor(() => assert.equal(cardButtons(v.container).length, 4))
  const before = b.calls.filter((call) => call[1] === 'state' || call[1] === 'feishu.status').length
  fireEvent.click(v.getByRole('button', { name: '刷新状态' }))
  await waitFor(() => assert.ok(b.calls.filter((call) => call[1] === 'state' || call[1] === 'feishu.status').length > before))
})

test('状态数据缺失时仍渲染四张卡片、合法状态徽标且可安全进入详情', async () => {
  const api = {
    personalCommand: async () => ({}),
    feishuCommand: async () => ({}),
  }
  const v = render(<ConnectorsPage api={api as any}/>)
  await waitFor(() => assert.equal(cardButtons(v.container).length, 4))
  const labels = ['已连接', '待配置', '需要授权', '同步中', '已暂停', '需处理', '不可用', '未连接', '待检查']
  for (const card of cardButtons(v.container)) {
    const label = card.querySelector('.connector-status')?.textContent
    assert.ok(label && labels.includes(label), `${card.dataset.connector} 状态未知: ${label}`)
  }
  fireEvent.click(cardById(v.container, 'files'))
  await waitFor(() => assert.ok(v.getByRole('button', { name: '返回连接器' })))
  assert.equal(detailTitle(v.container), '文件夹')
})

test('桥接方法缺失时显示待检查而不是不可用', async () => {
  const v = render(<ConnectorsPage api={{} as any}/>)
  await waitFor(() => assert.equal(cardButtons(v.container).length, 4))
  await waitFor(() => assert.equal(statusOf(v.container, 'mail'), '待检查'))
  assert.equal(statusOf(v.container, 'calendar'), '待检查')
})

test('接口缺失或读取失败时给出错误提示而不是崩溃', async () => {
  const failing = {
    personalCommand: async () => { throw Error('offline') },
    feishuCommand: async () => { throw Error('offline') },
  }
  const v = render(<ConnectorsPage api={failing as any}/>)
  await waitFor(() => assert.equal(cardButtons(v.container).length, 4))
  await waitFor(() => assert.ok(v.getByRole('alert')))
  assert.match(v.getByRole('alert').textContent ?? '', /未能读取连接状态/)
  cleanup()
  const missing = render(<ConnectorsPage/>)
  await waitFor(() => assert.equal(cardButtons(missing.container).length, 4))
})

test('Space 与手机面板不再包裹卡片，保留原有配对操作', async () => {
  const calls: any[] = []
  const api = {
    personalCommand: async (method: string, params: any) => {
      calls.push([method, params])
      if (method === 'space.status')
        return { mode: 'host', space: 'safe-space', clients: ['phone'] }
      if (method === 'space.pairings')
        return []
      return {}
    },
  }
  const v = render(<SpaceHostPanel api={api}/>)
  await waitFor(() => assert.ok(v.getByRole('button', { name: '刷新设备' })))
  assert.ok(v.container.querySelector('.space-host-panel'))
  assert.equal(v.container.querySelector('.im-card'), null, 'Space 页面不应再嵌套 card')
  assert.ok(v.getByRole('button', { name: '生成一次性配对码' }))
  assert.ok(v.getByRole('button', { name: '撤销 phone' }))
  assert.ok(calls.some(([method]) => method === 'space.pairings'))
})
