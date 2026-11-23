import {codingBackendStatus, codingBlockedByCodex} from '../src/main/coding-settings.mjs'
import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import {readFile, mkdtemp, writeFile, rm} from 'node:fs/promises'
import {statSync} from 'node:fs'
import {join} from 'node:path'
import {resolveSecretConfiguration} from '../src/main/backend.mjs'
import {createBackendSupervisor} from '../src/main/backend-supervisor.mjs'
import {classifyBackendFailure} from '../src/main/backend-supervisor.mjs'
import {capabilityPath, capabilityDocumentRevision, readCapabilityDocument} from '../src/main/capabilities-settings.mjs'

const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
const launch = source.slice(source.indexOf('async function launchBackend('), source.indexOf('function initializeDesktopBootstrap('))
const view = source.slice(source.indexOf('function settingsView()'), source.indexOf('async function loadMemoryBoardExport()'))

test('actual main prelaunch registry failures stop the supervisor without scheduling reconnect', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-task4-prelaunch-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const path = join(root, 'cap.json')
  for (const bytes of ['invalid json', ' '.repeat(256 * 1024 + 1), null]) {
    if (bytes === null) await rm(path)
    else await writeFile(path, bytes)
    const context = vm.createContext({refreshSpaceModels: async () => {}, acceptance: null, readCapabilityDocument, classifyBackendFailure, currentSettings: {capabilitiesConfigPath: path}, process: {env: {}}, desktopConfig: {}, codexStatus: {status: 'ready'}})
    vm.runInContext(launch, context)
    let retries = 0
    const supervisor = createBackendSupervisor({start: () => context.launchBackend(), stopBackend: async () => {}, onStatus: () => {}, schedule: () => {retries++; return 1}})
    await supervisor.start()
    assert.equal(supervisor.status().state, 'configuration_required')
    assert.equal(supervisor.status().diagnostic, 'configuration_required')
    assert.equal(retries, 0)
    await supervisor.stop()
  }
})
async function launchEnvironment({codingBackend, desktopConfig = {}, codexStatus = {status: 'ready'}}) {
  const specs = []
  const context = vm.createContext({refreshSpaceModels: async () => {}, acceptance: null, readCapabilityDocument: () => ({version: 1}), classifyBackendFailure,
    accessCredentials: fn => fn(), refreshCapabilityEditor() {}, preferredLanguage: () => 'en', acceptanceBackendSettings: value => value,
    currentSettings: codingBackend === undefined ? {} : {codingBackend}, process: {env: {}, cwd: () => '/tmp'}, desktopConfig, codexStatus, codingBlockedByCodex,
    randomBytes: () => Buffer.alloc(16), createReadinessListener: () => ({endpoint: Promise.resolve('ep'), close() {}}), createBackendDiagnosticCollector: () => ({}),
    decryptSecretsForSpawn: () => ({}), secretCodec: {}, settingsGeneration: 0, launchGeneration: 0, mainWindow: null, app: {isPackaged: false, getAppPath: () => '/app', getPreferredSystemLanguages: () => ['en']},
    nodeRuntimeEntry: () => 'entry', packageRoot: '/pkg', realpathSync: value => value, existsSync: () => false, chatGptFile: () => '/tmp/fixture-chatgpt-accounts.enc', resolve: (...parts) => parts.join('/'), openSetupWindow: () => {},
    backendLaunchSpec: () => { const spec = {env: {}}; specs.push(spec); return spec },
    // Stop right after the spawn environment is built; the fork itself is not under test.
    describeHostBlockingEnvironment: (_environment, textConversations) => {assert.equal(textConversations, true); return {pipeline: 'cascaded', missing: ['DASHSCOPE_API_KEY']}}})
  vm.runInContext(launch, context)
  await assert.rejects(context.launchBackend('node', {}), error => error.kind === 'configuration_required' && error.code !== 'manual_path_required')
  return specs[0].env
}
test('actual main turns Coding off instead of blocking on an unfinished manual Codex path', async () => {
  assert.equal((await launchEnvironment({desktopConfig: {codexConfigurationError: 'manual_path_required'}})).CODING_MODULE_ENABLED, 'false')
  assert.equal((await launchEnvironment({codingBackend: 'codex', desktopConfig: {codexConfigurationError: 'manual_path_required'}})).CODING_MODULE_ENABLED, 'false')
})
test('actual main gates Coding on the Codex CLI only when Codex is the selected backend', async () => {
  assert.equal((await launchEnvironment({codingBackend: 'codex', codexStatus: {status: 'missing'}})).CODING_MODULE_ENABLED, 'false')
  assert.equal((await launchEnvironment({codingBackend: 'codex'})).CODING_MODULE_ENABLED, undefined)
  for (const codingBackend of ['opencode', 'codebuddy', 'pi', 'deepseek']) {
    assert.equal((await launchEnvironment({codingBackend, codexStatus: {status: 'missing'}})).CODING_MODULE_ENABLED, undefined, codingBackend)
    assert.equal((await launchEnvironment({codingBackend, desktopConfig: {codexConfigurationError: 'manual_path_required'}})).CODING_MODULE_ENABLED, undefined, codingBackend)
  }
})
// Whether Coding runs is fixed in the launch environment, so a backend change that flips it needs a restart.
async function saveCodingBackend({from, to, codexStatus, desktopConfig = {}}) {
  const live = []
  const context = vm.createContext({configuredSpaceModelsPath: () => null, settingsRestartPending: false, currentSettings: {codingBackend: from},
    settingsRecoveryAvailable: false, backendSettings: ({codingBackend: _coding, ...rest}) => rest, backendControl: {}, backendStatus: {state: 'connected'},
    lifecycleCoordinator: {}, desktopConfig, codexStatus, codingBlockedByCodex, applyLiveCodingBackend: async backend => { live.push(backend) }, applyLiveCredentials: async () => {},
    refreshSettingsCapabilities: async () => {}, settingsView: () => ({}), publishSettingsApplyStatus() {}, publishCommittedSettings() {},
    completeSettings: async () => {}, commitDesktopConfiguration() {}, discardDesktopConfiguration() {}, restartSettingsBackend() {},
    applySettingsTransaction: async options => {
      context.currentSettings = {codingBackend: to}
      const restart = options.needsBackendRestart()
      await options.applyLive()
      return {saved: true, operationStatus: restart ? 'pending_restart' : 'applied'}
    }})
  vm.runInContext(source.slice(source.indexOf('async function applyDesktopSettings('), source.indexOf('function visorUsage()')), context)
  const result = await context.applyDesktopSettings({settingsPatch: {codingBackend: to}})
  return {status: result.operationStatus, live}
}
test('actual main restarts instead of reporting applied when a coding backend change turns Coding on or off', async () => {
  const missing = {status: 'missing'}, ready = {status: 'ready'}
  // Codex missing: Coding started off, so choosing OpenCode only takes effect after a restart (and vice versa).
  assert.deepEqual(await saveCodingBackend({from: 'codex', to: 'opencode', codexStatus: missing}), {status: 'pending_restart', live: []})
  assert.deepEqual(await saveCodingBackend({from: 'opencode', to: 'codex', codexStatus: missing}), {status: 'pending_restart', live: []})
  assert.deepEqual(await saveCodingBackend({from: 'codex', to: 'pi', codexStatus: ready, desktopConfig: {codexConfigurationError: 'manual_path_required'}}), {status: 'pending_restart', live: []})
  // Coding stays on: the default is handed to the running backend.
  assert.deepEqual(await saveCodingBackend({from: 'opencode', to: 'pi', codexStatus: missing}), {status: 'applied', live: ['pi']})
  assert.deepEqual(await saveCodingBackend({from: 'codex', to: 'opencode', codexStatus: ready}), {status: 'applied', live: ['opencode']})
})
test('actual settings view never decrypts while projecting startup and panel state', () => {
  let decrypts = 0
  const context = vm.createContext({configuredSpaceModelsPath: () => null, settingsRestartPending: false, codingBackendStatus, createManagedPhoneService: () => ({}), VISION_MODELS: {}, MODEL_CATALOG: {}, resolveSecretConfiguration, developmentEnv: {}, frontendUsage: {snapshot: () => ({})}, wakeWord: null, settingsWindow: null, skillsCache:[], capabilityEditorCache: null, settingsGeneration: 0, currentSettings: {}, process: {env: {}},
    readCapabilityDocument: () => ({version: 1}), decryptSecretsForSpawn: () => {decrypts++; return {}},
    readCapabilityEditor: () => ({document: {version: 1}, revision: 'test-revision', problems: []}), capabilityEnvironment: () => ({}), capabilityPath, statSync, capabilityDocumentRevision: () => 'fixed',
    runtimeCapabilities: null, publicSettings: () => ({}), codexStatus: {}, backendStatus: {}, settingsApplyStatus: 'idle', settingsRecoveryAvailable: false, managedWorkspacesView: () => ({}),
    startup: {}, keyringAvailable: true, microphoneStatus: 'unknown', desktopConfig: null, dataRootNotice: null, secretsPresent: () => ({}), secretCodec: {available: () => true}, hasPlaintextSecret: () => false})
  vm.runInContext(view, context)
  context.settingsView(); context.settingsView()
  assert.equal(decrypts, 0)
  context.settingsWindow = {}
  context.settingsView(); context.settingsView()
  assert.equal(decrypts, 0)
  context.settingsGeneration++
  context.settingsView()
  assert.equal(decrypts, 0)
  context.settingsWindow = null
  context.settingsView()
  assert.equal(decrypts, 0)
})
test('explicit settings refresh reads hand edits without IO in the public projection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-task6-cache-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const path = join(root, 'capabilities.json')
  let credentials = 0
  const context = vm.createContext({capabilityEditorCache: null, currentSettings: {capabilitiesConfigPath: path}, process: {env: {}},
    readCapabilityDocument, capabilityEnvironment: () => ({}), readCapabilityEditor: settings => ({document: readCapabilityDocument(settings, {})}),
    accessCredentials: operation => {credentials++; return operation()}, decryptSecretsForSpawn: () => ({}), secretCodec: {}, backendStatus: {state: 'connected'}, credentialFailure: null})
  const helpers = source.slice(source.indexOf('async function refreshSettingsCapabilities('), source.indexOf('async function loadMemoryBoardExport('))
  vm.runInContext(helpers, context)
  for (const budget of [4, 5, 6]) {
    await writeFile(path, JSON.stringify({version: 1, frontbrainToolBudget: budget}))
    await context.refreshSettingsCapabilities()
    assert.equal(context.capabilityEditorCache.view.document.frontbrainToolBudget, budget)
  }
  assert.equal(credentials, 3)
  context.credentialFailure = {code: 'credential_access_failed'}
  await context.refreshSettingsCapabilities(); assert.equal(credentials, 3)
})
