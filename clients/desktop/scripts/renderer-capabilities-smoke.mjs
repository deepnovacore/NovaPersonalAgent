import assert from 'node:assert/strict'
import {readFile, mkdir} from 'node:fs/promises'
import {resolve} from 'node:path'
import {DEFAULT_SETTINGS, publicSettings} from '../src/main/settings-store.mjs'
import {settingsWindowOptions} from '../src/main/security.mjs'
const {chromium} = await import(process.env.NOVA_PLAYWRIGHT_MODULE || 'playwright')
const root = resolve(import.meta.dirname, '..')
const output = resolve(process.env.NOVA_RENDERER_SMOKE_OUTPUT || `${root}/build/capabilities-smoke`)
await mkdir(output, {recursive: true})
const browser = await chromium.launch({headless: true, ...(process.env.NOVA_BROWSER_EXECUTABLE ? {executablePath: process.env.NOVA_BROWSER_EXECUTABLE} : {})})
try {
  const context = await browser.newContext({deviceScaleFactor: 1, reducedMotion: 'reduce'})
  await context.route('http://nova.test/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!/^\/[\w.-]+\.(html|css|mjs)$/.test(path)) return route.abort()
    await route.fulfill({body: await readFile(`${root}/src/renderer${path}`), contentType: path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'})
  })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(initial => {
    let view = initial, changed
    window.__commits = []
    window.__probeCount = 0
    window.__outcome = 'applied'
    window.__push = patch => {view = {...view, ...patch}; changed?.(view)}
    window.novaAudioAgentDesktop = {wakeWord: {activity() {}}, settings: {
      get: async () => view,
      restart: async () => {window.__restarts = (window.__restarts ?? 0) + 1; return {...view, operationStatus: 'applied'}},
      knowledgeAction: async () => ({sources: [{id: 'demo', title: '产品资料与使用说明 · 长文件名和中文说明的排版检查.pdf', status: 'ready'}], jobs: [], fts: true}),
      onChanged: callback => {changed = callback; return () => {}},
      probeCapabilities: async payload => {
        window.__probeCount++
        return {status: 'ok', tools: [{name: 'lookup.raw', description: 'Fake metadata · tool calls remain disabled.', readOnlyHint: false}]}
      },
      set: async commit => {
        window.__commits.push(commit)
        const outcome = window.__outcome
        if (['busy', 'invalid'].includes(outcome)) return {...view, saved: false, operationStatus: outcome}
        view = {...view, ...commit.settingsPatch, ...(commit.capabilitiesDocument ? {capabilitiesDocument: commit.capabilitiesDocument} : {}), settingsApplyStatus: outcome,
          capabilities: {...view.capabilities, diskGeneration: view.capabilities.diskGeneration + 1}, saved: true, operationStatus: outcome, rejectedSecrets: []}
        return view
      },
    }}
  }, {...publicSettings(DEFAULT_SETTINGS), frontendUsage: {requests: 4, missingReports: 1, unpricedReports: 0, pricedReports: 3, costCny: .0961, rows: [{service: 'realtime', provider: 'qwen', model: 'qwen-audio-3.0-realtime-plus', missingReports: 1, pricedReports: 3, costCny: .0961, inputTokens: 10677, outputTokens: 316, inputTextTokens: 10520, inputAudioTokens: 157, outputTextTokens: 68, outputAudioTokens: 248}]}, backendStatus: 'connected', settingsApplyStatus: 'idle', secretsPresent: {}, keyringAvailable: true, codexStatus: {status: 'ready'}, managedWorkspaces: {health: 'ready'},
    capabilitiesDocument: {version: 1, modules: {search: {enabled: true, provider: 'tavily'}}, mcpServers: {demo: {enabled: false, transport: 'streamable-http', url: 'https://example.com/mcp', tools: {}, exposeTo: {frontbrain: false, codex: true}}}},
    capabilities: {path: '/fake/capabilities.json', diskGeneration: 2, problems: [], status: {modules: {search: {provider: 'tavily'}}, overrides: []}, runtime: {state: 'running', diskGeneration: 2, generation: 1, toolCount: 9, toolBudget: 24, servers: []}}})
  const bounds = settingsWindowOptions(resolve(root, 'src/preload/preload.cjs'), 'smoke')
  await page.setViewportSize({width: bounds.width, height: bounds.height})
  await page.goto('http://nova.test/settings.html')
  await page.locator('#category-capabilities').click()
  await page.getByText('前台可用 9 个工具', {exact: false}).waitFor()
  assert.equal(await page.locator('#embeddingProvider').inputValue(), 'dashscope')
  assert.equal(await page.locator('#embeddingModel').inputValue(), 'text-embedding-v4')
  await page.getByLabel('搜索服务', {exact: true}).selectOption('mcp')
  assert.equal(await page.getByLabel('原始搜索工具名', {exact: true}).inputValue(), 'bailian_web_search')
  assert.equal(await page.getByLabel('MCP 地址', {exact: true}).inputValue(), 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp')
  await page.getByLabel('搜索请求头（每行 key=${ENV}）', {exact: true}).fill('authorization=Bearer ${DASHSCOPE_API_KEY}')
  assert.equal(await page.getByRole('button', {name: '添加外部 MCP 服务器', exact: true}).count(), 0)
  await page.locator('details[data-server=demo] > summary').click()
  assert.equal(await page.getByLabel('demo 对 前台 开放', {exact: true}).isChecked(), false)
  assert.equal(await page.getByLabel('demo 对 Codex 开放', {exact: true}).isChecked(), true)
  await page.getByLabel('demo 启用', {exact: true}).check()
  await page.getByRole('button', {name: '检测连接与工具（仅 tools/list）', exact: true}).click()
  await page.getByLabel('demo/lookup.raw 允许调用', {exact: true}).waitFor()
  assert.equal(await page.getByLabel('demo/lookup.raw 允许调用', {exact: true}).isChecked(), false)
  await page.getByLabel('demo/lookup.raw 允许调用', {exact: true}).check()
  await page.getByLabel('demo 对 前台 开放', {exact: true}).check()
  await page.getByLabel('lookup.raw 超时 ms', {exact: true}).fill('12000')
  await page.getByLabel('lookup.raw 结果字节', {exact: true}).click()
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({path: `${output}/capability-server-draft.png`, fullPage: true})
  await page.getByLabel('demo 传输', {exact: true}).selectOption('stdio')
  await page.getByLabel('demo 命令', {exact: true}).fill('node')
  await page.getByLabel('demo 参数（每行一项）', {exact: true}).fill('/fake/server.mjs')
  await page.getByLabel('demo 环境变量（每行 KEY=${ENV}）', {exact: true}).fill('TOKEN=${DEMO_TOKEN}')
  await page.getByLabel('demo 启用', {exact: true}).click()
  await page.locator('#settings-save').click()
  let commit = await page.evaluate(() => window.__commits.at(-1))
  assert.equal(commit.capabilitiesDocument.mcpServers.demo.transport, 'stdio')
  assert.equal(commit.capabilitiesDocument.mcpServers.demo.url, undefined)
  assert.equal(commit.capabilitiesDocument.mcpServers.demo.tools['lookup.raw'].timeoutMs, 12000)
  assert.equal(commit.settingsPatch.searchProvider, undefined)
  await page.getByRole('button', {name: '删除服务器', exact: true}).click()
  await page.locator('#settings-save').click()
  commit = await page.evaluate(() => window.__commits.at(-1))
  assert.deepEqual(commit.capabilitiesDocument.mcpServers, {})
  for (const [outcome, expected] of [['busy', '另一项操作进行中，草稿未保存'], ['invalid', '配置校验失败，草稿未保存'], ['failed', '设置已保存'], ['restart_failed', '设置已保存']]) {
    await page.evaluate(outcome => {window.__outcome = outcome}, outcome)
    await page.getByLabel('相机与视觉', {exact: true}).click()
    await page.locator('#settings-save').click()
    assert.equal(await page.locator('#status').textContent(), expected)
  }
  await page.evaluate(() => window.__push({capabilities: {diskGeneration: 7, status: {modules: {search: {provider: 'mcp'}}, overrides: ['NOVA_AUDIO_AGENT_SEARCH_PROVIDER']}, problems: [], runtime: {state: 'startup_failed', diskGeneration: 7, generation: 4, toolCount: 27, toolBudget: 24}}}))
  assert.match(await page.locator('#capabilities-state').textContent(), /启动失败.*27 个工具（上限 24 个）/u)
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({path: `${output}/capability-budget-failure.png`, fullPage: true})
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.evaluate(() => window.__push({capabilities: {runtime: {state: 'running', modules: {knowledge: {enabled: true}}, toolCount: 9, toolBudget: 24}}}))
  await page.evaluate(() => window.__push({secretsPresent: {arkApiKey: true, doubaoBigmodelApiKey: true}, secretSources: {arkApiKey: 'dotenv', doubaoBigmodelApiKey: 'dotenv'}}))
  for (const width of [760, 620]) {
    await page.setViewportSize({width, height: 720})
    for (const category of ['knowledge', 'secrets', 'general', 'codex']) {
      await page.locator(`#category-${category}`).click()
      if (category === 'general') {
        await page.locator('#frontend-usage-section details').evaluate(el => {el.open = true})
        assert.equal(await page.locator('#wake-word-status').isVisible(), false)
        assert.equal(await page.locator('.usage-stats .usage-metric').count(), 3)
        assert.equal(await page.locator('.usage-card .usage-metric').count(), 6)
      }
      if (category === 'knowledge') {
        await page.locator('#knowledge-refresh').click()
      }
      await page.evaluate(() => scrollTo(0, 0))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.equal(await page.locator('footer').evaluate(el => Math.round(el.getBoundingClientRect().bottom)), 720)
      assert.equal(await page.locator('#settings-save').textContent(), '保存')
      assert.equal(await page.locator('#settings-restart').textContent(), '重启')
      if (category === 'secrets') {
        assert.equal(await page.locator('input[type=password]:visible').count(), 2)
        assert.equal(await page.locator('#badge-arkApiKey').textContent(), '来自 .env')
        assert.equal(await page.locator('#arkApiKey').inputValue(), '')
        assert.equal(await page.locator('#arkApiKey').isDisabled(), true)
        assert.equal(await page.locator('button.change, #modelApiKey, #doubaoAsrApiKey, #modelBaseUrl, #codexApiKey, #plannerModel').count(), 0)
      }
      await page.screenshot({path: `${output}/${category}-${width}.png`, fullPage: true})
    }
  }
  await page.locator('#category-capabilities').click()
  await page.evaluate(() => window.__push({capabilities: {runtime: {state: 'running', toolCount: 9, toolBudget: 24, modules: {search: {enabled: true, provider: 'mcp'}}, servers: [{name: 'workspace', status: 'ok'}]}}}))
  assert.match(await page.locator('.mcp-runtime-list').textContent(), /workspace/)
  assert.match(await page.locator('.mcp-runtime-list').textContent(), /搜索/)
  await page.screenshot({path: `${output}/mcp-runtime.png`, fullPage: true})
  const board = await context.newPage()
  board.on('pageerror', error => errors.push(error.message))
  await board.addInitScript(() => {
    window.novaAudioAgentDesktop = {
      memoryBoard: {request: async () => ({backend_generation: 1, channels: [{name: 'conversation', item_count: 3, summary: '', items: [
        {seq: 1, ts: 1, trust: 'trusted_user', content: {text: '帮我整理一下今天的安排。'}},
        {seq: 2, ts: 2, trust: 'trusted_system', content: {text: '今天有两件重要的事：\n上午完成方案评审，下午继续开发语音管线。', delivery: 'spoken'}},
        {seq: 3, ts: 3, trust: 'trusted_user', content: {text: '好的，先从方案评审开始。'}},
      ]}], diagnostics: {version: 1, records: []}})},
      graphBoard: {request: async () => ({error: 'unavailable'})},
    }
  })
  await board.setViewportSize({width: 980, height: 760})
  await board.goto('http://nova.test/memory-board.html')
  await board.locator('.chat-message').first().waitFor()
  assert.equal(await board.locator('.chat-message').count(), 3)
  assert.equal(await board.locator('.chat-debug:visible').count(), 0)
  await board.screenshot({path: `${output}/conversation.png`, fullPage: true})
  await board.locator('.chat-assistant').hover()
  assert.equal(await board.locator('.chat-debug:visible').count(), 1)
  await board.screenshot({path: `${output}/conversation-hover.png`, fullPage: true})
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({moduleToggles: true, preset: true, serverCrud: true, toolAllowlist: true, transportFields: true, saveLattice: true, exactBudget: '27/24', horizontalOverflow: false, pageErrors: errors, screenshots: output}))
} finally {await browser.close()}
