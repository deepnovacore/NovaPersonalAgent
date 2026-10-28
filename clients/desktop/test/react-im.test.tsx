import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true })
const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/react')
const { ImPanel } = await import('../src/renderer/react/settings/im.tsx')
afterEach(() => cleanup())

const ZERO_COUNTS = { pending: 0, sending: 0, accepted: 0, retry_wait: 0, blocked: 0, unknown: 0, cancelled: 0, expired: 0, superseded: 0 }
function feishuState(extra: any = {}) {
  return {
    available: true, configured: true, state: 'ready', account_id: 'account-fixture', account_name: 'Nova 用户',
    app_id: 'cli_fixture', scope_configured: true, notification_ready: true, notification_enabled: true,
    bot_enabled: true, all_history: false, chats: [], history_complete: true, processing_consent_required: false,
    last_sync: '2026-10-28 09:00', ...extra,
  }
}
function deliverySnapshot(extra: any = {}) {
  return {
    primary_binding_id: 'feishu', route_revision: 1, local: false, configured: true,
    bindings: [{ id: 'feishu', provider: 'feishu', user_scope: 'scope-fixture', generation: 1, status: 'ready' }],
    counts: { ...ZERO_COUNTS }, deliveries: [], ...extra,
  }
}
function bridge(feishu: any, snapshot: any) {
  const calls: any[] = []
  const api = {
    feishuCommand: async (method: string, params: any) => {
      calls.push([method, structuredClone(params ?? {})])
      if (method === 'feishu.status')
        return structuredClone(feishu)
      if (method === 'notifications.status')
        return structuredClone(snapshot)
      return { ok: true }
    },
    openFeishuVerification: async () => { },
  }
  return { api, calls }
}
const card = (container: HTMLElement) => container.querySelectorAll('article.im-card')

test('the Feishu card hosts the proactive subsection before any separate card', async () => {
  const b = bridge(feishuState(), deliverySnapshot({ counts: { ...ZERO_COUNTS, accepted: 25, cancelled: 15 } }))
  const v = render(<ImPanel api={b.api}/>)
  await waitFor(() => assert.ok(v.getByText('主动消息'), 'proactive subsection should render'))
  const cards = card(v.container)
  assert.equal(cards.length, 1, 'there is no standalone 主动消息 card')
  const feishu = cards[0] as HTMLElement
  assert.equal(feishu.querySelector('h3')?.textContent, '飞书')
  const proactive = feishu.querySelector('h4')
  assert.ok(proactive, 'proactive subsection heading should be inside the Feishu card')
  const text = feishu.textContent ?? ''
  assert.ok(text.indexOf('飞书') < text.indexOf('主动消息'), 'the Feishu heading must come before 主动消息')
})

test('delivery counts are localized chips and never leak raw status keys', async () => {
  const b = bridge(feishuState(), deliverySnapshot({ counts: { ...ZERO_COUNTS, accepted: 25, cancelled: 15, expired: 0 } }))
  const v = render(<ImPanel api={b.api}/>)
  await waitFor(() => assert.ok(v.getByText('已取消')))
  const cancelled = v.getByText('已取消').closest('li') as HTMLElement
  assert.equal(cancelled.getAttribute('data-status'), 'cancelled')
  assert.equal(cancelled.textContent, '已取消 15')
  const accepted = v.getByText('平台已接收').closest('li') as HTMLElement
  assert.equal(accepted.textContent, '平台已接收 25')
  assert.equal(v.queryByText('已过期'), null, 'zero counts should not render a chip')
  const text = v.container.textContent ?? ''
  assert.doesNotMatch(text, /cancelled:\s*\d/)
  assert.ok(!text.includes('cancelled'), 'raw delivery status keys must never reach the UI')
})

test('channel choice keeps the existing notification commands', async () => {
  const toNova = bridge(feishuState(), deliverySnapshot({ primary_binding_id: 'feishu', local: false }))
  const first = render(<ImPanel api={toNova.api}/>)
  await waitFor(() => assert.ok(first.getByRole('button', { name: '改为在 Nova 接收' })))
  fireEvent.click(first.getByRole('button', { name: '改为在 Nova 接收' }))
  await waitFor(() => assert.ok(toNova.calls.some(([method, params]) => method === 'notifications.configure' && params.binding_id === 'nova')))

  const toFeishu = bridge(feishuState({ notification_enabled: false, notification_ready: true }), deliverySnapshot({ primary_binding_id: 'nova', local: true }))
  const second = render(<ImPanel api={toFeishu.api}/>)
  await waitFor(() => assert.ok(second.getByRole('button', { name: '改为在飞书接收' })))
  fireEvent.click(second.getByRole('button', { name: '改为在飞书接收' }))
  await waitFor(() => {
    assert.deepEqual(toFeishu.calls.find(([method]) => method === 'feishu.notification.configure')?.[1], { enabled: true })
    assert.ok(toFeishu.calls.some(([method, params]) => method === 'notifications.configure' && params.binding_id === 'feishu'))
  })
})

test('connection steps render only while Feishu is not connected', async () => {
  const disconnected = bridge(feishuState({ configured: false, state: 'unauthorized', app_setup: {} }), deliverySnapshot())
  const first = render(<ImPanel api={disconnected.api}/>)
  await waitFor(() => assert.equal(first.container.querySelectorAll('.im-steps li').length, 3), 'the 1/2/3 steps should show before a connection exists')
  assert.ok(first.getByText('连接应用'))

  const ready = bridge(feishuState(), deliverySnapshot())
  const second = render(<ImPanel api={ready.api}/>)
  await waitFor(() => assert.ok(second.getByText('主动消息')))
  assert.equal(second.container.querySelector('.im-steps'), null, 'steps should disappear once Feishu is connected')
})

test('unavailable runtime still renders one Feishu card without setup controls', async () => {
  const b = bridge({ available: false, error: 'lark-cli 不可用' }, deliverySnapshot({ primary_binding_id: 'nova', local: true }))
  const v = render(<ImPanel api={b.api}/>)
  await waitFor(() => assert.ok(v.getByText('lark-cli 不可用')))
  assert.equal(v.queryByText('当前运行环境尚未启用飞书连接。'), null)
  assert.equal(card(v.container).length, 1)
  assert.equal(card(v.container)[0].querySelector('h3')?.textContent, '飞书')
  assert.equal(v.container.querySelector('.im-steps'), null)
  assert.equal(v.queryByRole('button', { name: '创建飞书应用' }), null)
})

test('uncertain deliveries keep the resend confirmation and localized title', async () => {
  const snapshot = deliverySnapshot({
    counts: { ...ZERO_COUNTS, unknown: 1 },
    deliveries: [{ id: 'delivery-fixture', title: '每日简报', status: 'unknown', error: 'timeout', binding_id: 'feishu', updated_at: '2026-10-28T01:00:00.000Z' }],
  })
  const b = bridge(feishuState(), snapshot)
  const v = render(<ImPanel api={b.api}/>)
  await waitFor(() => assert.ok(v.container.querySelector('.im-delivery-row')))
  assert.equal(v.container.querySelector('.im-delivery-title')?.textContent, '每日简报 · 发送结果不确定')
  assert.ok(v.getByText('对方可能已经收到，请先在接收渠道核实。再次发送可能产生重复消息。'))
  fireEvent.click(v.getByRole('button', { name: '确认可能重复，仍重新发送' }))
  await waitFor(() => assert.ok(b.calls.some(([method, params]) => method === 'notifications.retry' && params.id === 'delivery-fixture' && params.confirm_unknown === true)))
})

test('long delivery copy lives in a closed details block, away from the open-platform link', async () => {
  const b = bridge(feishuState(), deliverySnapshot())
  const v = render(<ImPanel api={b.api}/>)
  await waitFor(() => assert.ok(v.getByText('投递说明')))
  const help = v.container.querySelector('.im-proactive-help') as HTMLDetailsElement
  assert.ok(help, 'delivery help should be a details element')
  assert.equal(help.open, false)
  assert.ok(help.textContent?.includes('飞书接收无需开启会话采集'))
  assert.equal(v.queryByRole('button', { name: '打开飞书开放平台' }), null, 'the open-platform link must not be a proactive action')
  assert.ok(v.getByRole('button', { name: '打开应用后台' }))
})
