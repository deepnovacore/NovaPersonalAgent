import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import {normalizeSettings} from '../src/main/settings-store.mjs'
import {invalidCommit, validatePreparedSettings, parseSettingsCommit} from '../src/main/capabilities-settings.mjs'

const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
const helpers = source.slice(source.indexOf('function configuredSpaceModelsPath()'), source.indexOf('// The single shape the settings panel'))
const plain = value => JSON.parse(JSON.stringify(value))
function fixture({operator, disconnected = false, corrupt = false, providerUnconfigured = false} = {}) {
  const configPath = '/fixed-space/config.json', calls = [], writes = [], notices = []
  let state = {version: 4, routes: {support: {provider: 'qwen', model: 'saved'}}}
  const runtime = {
    readHostSpaceConfig: path => {assert.equal(path, configPath); return {}},
    readHostModelRoutes: path => {assert.equal(path, configPath); if (corrupt) throw Error('sensitive-file-bytes'); return state},
    seedHostModelRoutes: async (path, routes) => {writes.push({path, routes})},
  }
  const control = {request: async (method, params) => {
    calls.push({method, params: plain(params)})
    if (method === 'space.models.status') return {...state, applied_version: 4, source: 'space', locked: false, secret: 'must-not-project'}
    if (providerUnconfigured) return {error: 'model_provider_unconfigured'}
    if (params.expected_version !== state.version) return {error: 'version_conflict'}
    state = {version: state.version + 1, routes: {...state.routes, ...params.routes}}
    return {version: state.version, applies: 'restart'}
  }}
  const context = vm.createContext({process: {env: {NOVA_SPACE_HOST_CONFIG: configPath, ...(operator ? {MODEL_ROUTES: operator} : {})}},
    currentSettings: {modelRoutes: {fast: {provider: 'qwen', model: 'old-global'}}}, spaceModelsCache: null, spaceModelsAppliedVersion: null,
    loadSpaceHostRuntime: async () => runtime, backendControl: disconnected ? null : control,
    normalizeSettings, invalidCommit, validatePreparedSettings, parseSettingsCommit,
    classifyBackendFailure: code => ({code}), t: text => text, settingsRestartPending: false,
    lifecycleCoordinator: {run: async (_kind, operation) => ({status: 'completed', value: await operation()})},
    publishSettingsApplyStatus: status => notices.push(status), sendToSettings: (...args) => notices.push(args),
    settingsView: () => ({modelRoutes: context.spaceModelsCache?.routes, hostModelRoutes: context.spaceModelsCache}),
  })
  vm.runInContext(helpers, context)
  return {context, calls, writes, notices, change: () => {state = {...state, version: state.version + 1}}}
}

test('PC reads the fixed validated Host file while disconnected and seeds only before launch', async () => {
  const f = fixture({disconnected: true})
  await f.context.refreshSpaceModels({seed: true, status: false})
  assert.equal(f.writes[0].path, '/fixed-space/config.json')
  assert.deepEqual(plain(f.context.spaceModelsCache.routes.support), {provider: 'qwen', model: 'saved'})
  assert.equal(f.context.spaceModelsCache.routes.fast, null)
  await f.context.refreshSpaceModels()
  assert.equal(f.writes.length, 1, 'ordinary settings refresh cannot write the Host file')
  assert.equal(JSON.stringify(f.context.spaceModelsCache).includes('old-global'), false)
})

test('operator settings are read-only without exposing other environment fields', async () => {
  const f = fixture({disconnected: true, operator: '{"fast":{"provider":"openai","model":"operator"}}'})
  await f.context.refreshSpaceModels({seed: true, status: false})
  assert.equal(f.writes.length, 0)
  assert.equal(f.context.spaceModelsCache.source, 'environment')
  assert.equal(f.context.spaceModelsCache.locked, true)
  const result = await f.context.applySpaceModelRoutes({settingsPatch: {modelRoutes: {fast: null}, hostModelRoutesVersion: 4}})
  assert.equal(result.saved, false)
  assert.equal(f.calls.length, 0)
})

test('damaged Host settings fail closed and never return the raw read error', async () => {
  const f = fixture({corrupt: true})
  await f.context.refreshSpaceModels()
  assert.deepEqual(plain(f.context.spaceModelsCache), {routes: {}, locked: true, source: 'unavailable'})
  await assert.rejects(f.context.refreshSpaceModels({seed: true}), {code: 'configuration_required'})
  assert.equal(JSON.stringify(f.context.spaceModelsCache).includes('sensitive'), false)
})

test('PC sparse writes enter the Runtime CAS command and only mark restart pending', async () => {
  const f = fixture()
  await f.context.refreshSpaceModels()
  const patch = {conversationText: {provider: 'qwen', model: 'selected'}}
  const result = await f.context.applySpaceModelRoutes({settingsPatch: {modelRoutes: patch, hostModelRoutesVersion: 4,
    cascadedLlmProvider: 'qwen', cascadedLlmModels: {qwen: 'selected'}}})
  assert.equal(result.saved, true)
  assert.equal(result.restarted, false)
  assert.equal(result.operationStatus, 'pending_restart')
  assert.deepEqual(f.calls.find(call => call.method === 'space.models.configure'), {
    method: 'space.models.configure', params: {expected_version: 4, routes: patch}})
  assert.equal(f.context.settingsRestartPending, true)
  assert.equal(f.context.currentSettings.modelRoutes.fast.model, 'old-global')
  assert.equal(JSON.stringify(result).includes('must-not-project'), false)
  assert.equal(f.writes.length, 0)
})

test('a phone update conflicts with the captured PC draft version instead of being overwritten', async () => {
  const f = fixture()
  await f.context.refreshSpaceModels()
  f.change()
  const result = await f.context.applySpaceModelRoutes({settingsPatch: {modelRoutes: {fast: null}, hostModelRoutesVersion: 4}})
  assert.equal(result.saved, false)
  assert.equal(result.operationStatus, 'invalid')
  assert.equal(result.hostModelRoutes.version, 5)
  assert.match(result.problems[0], /其他设备/)
})

test('invalid or mixed PC route payloads never partially save unrelated settings', async () => {
  for (const patch of [
    {modelRoutes: {unknown: null}}, {modelRoutes: {fast: {provider: 'bogus', model: 'x'}}},
    {modelRoutes: {fast: {provider: 'qwen', model: 'x', token: 'secret'}}},
    {modelRoutes: {fast: null}, secrets: {dashscopeApiKey: 'secret'}},
    {modelRoutes: {fast: null}, startupView: 'orb'},
    {modelRoutes: {conversationText: {provider: 'qwen', model: 'x'}}, cascadedLlmModels: {qwen: 'different'}},
  ]) {
    const f = fixture()
    await f.context.refreshSpaceModels()
    const result = await f.context.applySpaceModelRoutes({settingsPatch: {...patch, hostModelRoutesVersion: 4}})
    assert.equal(result.saved, false)
    assert.equal(f.calls.some(call => call.method === 'space.models.configure'), false)
    assert.equal(f.writes.length, 0)
  }
})

test('unavailable new credentials explain how to safely activate them before selecting a model', async () => {
  const f = fixture({providerUnconfigured: true})
  await f.context.refreshSpaceModels()
  const result = await f.context.applySpaceModelRoutes({settingsPatch: {modelRoutes: {support: {provider: 'qwen', model: 'x'}}, hostModelRoutesVersion: 4}})
  assert.equal(result.saved, false)
  assert.match(result.problems[0], /保存模型密钥并重启后台/)
  assert.equal(f.context.settingsRestartPending, false)
})

test('explicit operator routes remain usable when the unused Space model file is damaged', async () => {
  const f = fixture({disconnected: true, corrupt: true, operator: '{"support":{"provider":"qwen","model":"operator"}}'})
  await f.context.refreshSpaceModels({seed: true, status: false})
  assert.equal(f.context.spaceModelsCache.source, 'environment')
  assert.equal(f.context.spaceModelsCache.locked, true)
  assert.equal(f.context.spaceModelsCache.routes.support.model, 'operator')
  assert.equal(f.writes.length, 0)
})
