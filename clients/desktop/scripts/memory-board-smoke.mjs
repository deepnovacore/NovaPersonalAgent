import assert from 'node:assert/strict'
import {readFile, mkdir} from 'node:fs/promises'
import {resolve} from 'node:path'
const {chromium} = await import(process.env.NOVA_PLAYWRIGHT_MODULE || 'playwright')
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'build/memory-board-smoke')
await mkdir(output, {recursive: true})
const browser = await chromium.launch({headless: true, ...(process.env.NOVA_BROWSER_EXECUTABLE ? {executablePath: process.env.NOVA_BROWSER_EXECUTABLE} : {})})
try {
  const context = await browser.newContext({viewport: {width: 1200, height: 820}})
  await context.route('http://nova.test/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!/^\/[\w.-]+\.(html|css|mjs)$/.test(path)) return route.abort()
    await route.fulfill({body: await readFile(`${root}/src/renderer${path}`), contentType: path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'})
  })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    window.boardRows = Array.from({length: 237}, (_, i) => ({seq: i + 1, ts: i, trust: i % 2 ? 'trusted_user' : 'trusted_system', content: JSON.stringify({text: `对话 ${i + 1}：历史分页与刷新验收。`}), ...(i < 30 ? {historical: true, recorded_at_ms: 1000 + i} : {})}))
    window.boardEpoch = 0
    window.pageRequests = 0
    window.novaAudioAgentDesktop = {memoryBoard: {
      request: async options => {
        const before = options?.before_seq
        if (before) window.pageRequests++
        const rows = window.boardRows.filter(row => !before || row.seq < before).slice(before ? -50 : -12)
        const more = rows.length > 0 && window.boardRows.some(row => row.seq < rows[0].seq)
        return {type: 'memory.board', backend_generation: 1, conversation_epoch: window.boardEpoch, diagnostics: {version: 1, records: []}, channels: [{name: 'conversation', item_count: window.boardRows.length, historical_through_seq: 30, items: rows, has_more: more, next_before_seq: more ? rows[0].seq : null}]}
      }, clear: async () => ({canceled: true}), copyJson: async () => ({}), export: async () => ({}),
    }}
  })
  await page.goto('http://nova.test/memory-board.html')
  await page.waitForFunction(() => document.querySelectorAll('[data-seq]').length === 12)
  for (const expected of [62, 112, 162, 212, 237]) {
    await page.locator('.chat-messages').first().evaluate(element => {element.scrollTop = 0; element.dispatchEvent(new WheelEvent('wheel', {deltaY: -100}))})
    await page.waitForFunction(count => document.querySelectorAll('[data-seq]').length >= count, expected).catch(async error => { console.log('PAGING', expected, await page.evaluate(() => ({count: document.querySelectorAll('[data-seq]').length, requests: window.pageRequests, status: document.querySelector('#status').textContent}))); throw error })
  }
  assert.equal(await page.evaluate(() => new Set([...document.querySelectorAll('[data-seq]')].map(e => e.dataset.seq)).size), 237)
  await page.locator('.conversation-history').evaluate(e => {e.open = true})
  await page.locator('[data-seq="100"]').scrollIntoViewIfNeeded()
  const before = await page.locator('[data-seq="100"]').evaluate(e => e.getBoundingClientRect().top)
  await page.evaluate(() => window.boardRows.push({seq: 238, ts: 238, trust: 'trusted_user', content: JSON.stringify({text: '新消息'})}))
  await page.locator('#refresh').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-seq]').length === 238)
  assert.ok(Math.abs(before - await page.locator('[data-seq="100"]').evaluate(e => e.getBoundingClientRect().top)) < 2)
  await page.screenshot({path: `${output}/history.png`})
  await page.evaluate(() => {window.boardEpoch++; window.boardRows = [{seq: 1, ts: 0, trust: 'trusted_user', content: JSON.stringify({text: '清空后的新对话'})}]})
  await page.locator('#refresh').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-seq]').length === 1)
  assert.deepEqual(errors, [])
  console.log('PASS: 237 records, paging, refresh merge, scroll anchor and clear epoch')
} finally {await browser.close()}
