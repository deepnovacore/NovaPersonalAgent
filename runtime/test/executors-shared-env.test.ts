import assert from 'node:assert/strict'
import test from 'node:test'
import {loadBrowserConfig} from '../src/executors/browser.js'
import {loadComputerConfig} from '../src/executors/computer-config.js'
import {loadMobileConfig} from '../src/executors/mobile.js'
import {publicEnvironmentContract} from '../src/config/environment-contract.js'

const model = {EXECUTOR_BASE_URL: 'http://127.0.0.1:8000/v1', EXECUTOR_MODEL: 'shared-model', EXECUTOR_MODEL_FAMILY: 'qwen3-vl', EXECUTOR_API_KEY: 'shared-key'}
const own = {
  browser: {BROWSER_URL: 'http://127.0.0.1:18765'},
  computer: {COMPUTER_DISPLAY_ID: '1'},
  mobile: {MOBILE_DEVICE_ID: 'dev', MOBILE_DEVICE_TYPE: 'ios-simulator'},
}
const load = {
  browser: (e: NodeJS.ProcessEnv) => loadBrowserConfig({...own.browser, ...e}),
  computer: (e: NodeJS.ProcessEnv) => loadComputerConfig({...own.computer, ...e}),
  mobile: (e: NodeJS.ProcessEnv) => loadMobileConfig({...own.mobile, ...e}),
}
const defaults = {browser: 1000, computer: 4000, mobile: 4000}

for (const kind of ['browser', 'computer', 'mobile'] as const) {
  test(`${kind} reads the shared EXECUTOR_* overrides`, () => {
    const config = load[kind]({...model, EXECUTOR_MAX_STEPS: '7', EXECUTOR_TIMEOUT_SECONDS: '90', EXECUTOR_SETTLE_MS: '250'})
    assert.deepEqual([config.baseUrl, config.model, config.modelFamily, config.apiKey], ['http://127.0.0.1:8000/v1', 'shared-model', 'qwen3-vl', 'shared-key'])
    assert.deepEqual([config.maxSteps, config.budgetMs, config.settleMs], [7, 90000, 250])
  })
  test(`${kind} keeps its own limits when the shared overrides are unset`, () => {
    const config = load[kind](model)
    assert.deepEqual([config.maxSteps, config.budgetMs, config.settleMs], [30, 600000, defaults[kind]])
  })
  test(`${kind} ignores the removed per-executor model variables`, () => {
    const prefix = kind.toUpperCase()
    const stale = Object.fromEntries(['BASE_URL', 'MODEL', 'MODEL_FAMILY', 'API_KEY', 'MAX_STEPS', 'TIMEOUT_SECONDS', 'SETTLE_MS']
      .map(name => [`${prefix}_${name}`, name === 'MODEL_FAMILY' ? 'auto-glm' : name.endsWith('URL') ? 'http://127.0.0.1:1/v1' : '9']))
    const config = load[kind]({...model, ...stale})
    assert.deepEqual([config.model, config.modelFamily, config.apiKey, config.maxSteps, config.budgetMs, config.settleMs], ['shared-model', 'qwen3-vl', 'shared-key', 30, 600000, defaults[kind]])
  })
}

test('browser and computer do not fall back to a removed variable for the model endpoint', () => {
  assert.throws(() => loadBrowserConfig({...own.browser, BROWSER_BASE_URL: 'http://127.0.0.1/v1', BROWSER_MODEL: 'm', BROWSER_MODEL_FAMILY: 'qwen3-vl', BROWSER_API_KEY: 'k'}), /invalid_browser_configuration/u)
  assert.throws(() => loadMobileConfig({...own.mobile, MOBILE_BASE_URL: 'http://127.0.0.1/v1', MOBILE_MODEL: 'm', MOBILE_MODEL_FAMILY: 'qwen3-vl', MOBILE_API_KEY: 'k'}), /invalid_mobile_configuration:BASE_URL/u)
})

test('environment contract exposes only the shared model variables', () => {
  const names = publicEnvironmentContract().map(entry => entry.name)
  for (const prefix of ['BROWSER', 'COMPUTER', 'MOBILE'])
    for (const name of ['BASE_URL', 'MODEL', 'MODEL_FAMILY', 'API_KEY', 'MAX_STEPS', 'TIMEOUT_SECONDS', 'SETTLE_MS']) assert.equal(names.includes(`${prefix}_${name}`), false)
  for (const name of ['BASE_URL', 'MODEL', 'MODEL_FAMILY', 'API_KEY', 'MAX_STEPS', 'TIMEOUT_SECONDS', 'SETTLE_MS']) assert.equal(names.includes(`EXECUTOR_${name}`), true)
})
