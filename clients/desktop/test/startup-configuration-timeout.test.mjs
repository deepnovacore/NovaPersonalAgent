import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import {
  CONFIGURATION_STAGE_TIMEOUT_MS,
  configurationTimeout,
  createConfigurationAttempt,
  createLifecycleCoordinator,
  prepareDesktopStartup,
  reportStartupFailure,
  runConfigurationStage,
  startupFailureCode,
} from '../src/main/desktop-startup.mjs'
import {startupMessage} from '../src/renderer/startup-notice.mjs'

const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
const configurationLifecycle = source.slice(
  source.indexOf('function beginConfigurationAttempt('),
  source.indexOf('async function refreshManagedWorkspaceCapabilities('),
)

function configurationContext(overrides = {}) {
  const published = []
  const context = vm.createContext({
    createConfigurationAttempt,
    runConfigurationStage,
    configurationTimeout,
    setTimeout,
    clearTimeout,
    Promise,
    CONFIGURATION_CLOSE_TIMEOUT_MS: 2_000,
    activeConfigurationAttempt: null,
    configurationReady: false,
    settingsReady: false,
    desktopConfig: null,
    codexStatus: null,
    managedWorkspaceMaintenance: null,
    managedWorkspaceCapabilities: {health: 'unavailable'},
    projectNativeAuthorityPresent: true,
    publishStartup: (stage, code = null) => published.push([stage, code]),
    managedWorkspaceBackendRecovery: {observe: async () => {}},
    publicManagedWorkspaceCapabilities: capabilities => capabilities ?? {health: 'unavailable'},
    ...overrides,
  })
  vm.runInContext(configurationLifecycle, context)
  return {context, published}
}

test('a configuration wait that never settles reports its stage and aborts the attempt', async () => {
  const attempt = createConfigurationAttempt()
  const stages = []
  const pending = runConfigurationStage(attempt, 'maintenance', () => new Promise(() => {}), {
    onStage: stage => stages.push(stage),
    timeoutMs: 15,
  })
  await assert.rejects(pending, error => error.code === 'configuration_timeout' && error.stage === 'maintenance')
  assert.deepEqual(stages, ['maintenance'])
  assert.equal(attempt.current(), false)
  assert.equal(CONFIGURATION_STAGE_TIMEOUT_MS, 20_000)
  assert.equal(startupFailureCode(configurationTimeout('maintenance')), 'configuration_timeout')
})

test('configuration stage diagnostics are non-secret and end in a visible retriable failure', () => {
  assert.match(startupMessage({stage: 'configuration', code: 'configuration_wait_maintenance'}), /工作区维护服务/)
  assert.match(startupMessage({stage: 'configuration', code: 'configuration_wait_directories'}), /目录/)
  assert.doesNotMatch(startupMessage({stage: 'configuration', code: 'configuration_wait_directories'}), /\/Users|\/home|token|key=/u)
  assert.match(startupMessage({stage: 'failed', code: 'configuration_timeout'}), /超时/)
  const written = []
  const code = reportStartupFailure(configurationTimeout('state_and_workspace_directories'), {
    write: chunk => written.push(chunk),
    showError: () => {},
  })
  assert.equal(code, 'configuration_timeout')
  assert.deepEqual(written, ['[desktop-diagnostic] startup_failure code=configuration_timeout stage=state_and_workspace_directories\n'])
})

test('a timed-out configuration wait releases the lifecycle lock so an explicit retry can run', async () => {
  const coordinator = createLifecycleCoordinator()
  const attempt = createConfigurationAttempt()
  const timedOut = coordinator.run('startup', () => runConfigurationStage(
    attempt, 'settings', () => new Promise(() => {}), {onStage: () => {}, timeoutMs: 10},
  ))
  await assert.rejects(timedOut, error => error.code === 'configuration_timeout')
  assert.equal(coordinator.busy, false)
  const retried = await coordinator.run('startup', async () => 'configured')
  assert.equal(retried.status, 'completed')
  assert.equal(retried.value, 'configured')
  assert.equal(coordinator.busy, false)
})

test('a result that arrives after its attempt lost ownership is handed to cleanup, never committed', async () => {
  const attempt = createConfigurationAttempt()
  const late = []
  let release
  const pending = runConfigurationStage(attempt, 'capabilities', () => new Promise(resolve => { release = resolve }), {
    onStage: () => {}, timeoutMs: 10, onLateResult: value => late.push(value),
  })
  await assert.rejects(pending, error => error.code === 'configuration_timeout')
  release({health: 'ready'})
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(late, [{health: 'ready'}])
})

test('normal startup commits the current attempt and observes recovery once', async () => {
  const observed = []
  const {context, published} = configurationContext({
    managedWorkspaceBackendRecovery: {observe: async (capabilities, authority) => { observed.push([capabilities.health, authority]) }},
  })
  const attempt = context.beginConfigurationAttempt()
  let closed = 0
  const maintenance = {
    capabilities: async () => ({health: 'ready', current: {available: false, display_name: null}, all: {available: false, count: 0}}),
    reconcileExternalCleanup: async () => ({status: 'reconciled', active_workspace_reset: true}),
    close: async () => { closed += 1 },
  }
  const result = await context.commitDesktopConfiguration({
    maintenance, config: {stateRoot: '/state'}, codexStatus: {status: 'ready'}, attempt,
  })
  assert.equal(result.externalWorkspaceReset, true)
  assert.equal(context.configurationReady, true)
  assert.equal(context.settingsReady, true)
  assert.equal(context.desktopConfig.stateRoot, '/state')
  assert.equal(context.managedWorkspaceMaintenance, maintenance)
  assert.equal(context.managedWorkspaceCapabilities.health, 'ready')
  assert.deepEqual(observed, [['ready', true]])
  assert.equal(closed, 0)
  assert.deepEqual(published, [
    ['configuration', 'configuration_wait_reconcile'],
    ['configuration', 'configuration_wait_capabilities'],
    ['configuration', 'configuration_wait_recovery'],
  ])
})

test('a superseded attempt cannot install configuration or keep its maintenance store open', async () => {
  const observed = []
  const {context} = configurationContext({
    managedWorkspaceBackendRecovery: {observe: async () => { observed.push('observed') }},
  })
  const attempt = context.beginConfigurationAttempt()
  let releaseReconcile
  let closed = 0
  const maintenance = {
    capabilities: async () => { throw new Error('a stale attempt must not read capabilities') },
    reconcileExternalCleanup: () => new Promise(resolve => { releaseReconcile = resolve }),
    close: async () => { closed += 1 },
  }
  const pending = context.commitDesktopConfiguration({
    maintenance, config: {stateRoot: '/stale'}, codexStatus: {status: 'stale'}, attempt,
  })
  await new Promise(resolve => setImmediate(resolve))
  context.beginConfigurationAttempt()
  releaseReconcile({status: 'unchanged'})
  await assert.rejects(pending, error => error.code === 'configuration_timeout' && error.stage === 'commit')
  assert.equal(context.desktopConfig, null)
  assert.equal(context.configurationReady, false)
  assert.equal(context.managedWorkspaceMaintenance, null)
  assert.equal(closed, 1)
  assert.deepEqual(observed, [])
  assert.match(configurationLifecycle, /onLateResult: service => \{ void closeMaintenanceBounded\(service\) \}/)
})

test('preparation reports the workspace, directory and Codex waits as stages', async () => {
  const stages = []
  const {posix} = await import('node:path')
  await prepareDesktopStartup({
    settings: {}, environment: {}, home: '/home/test', platform: 'linux', arch: 'x64', pathApi: posix,
    canonicalizePath: value => value, canonicalizeExecutable: () => null, canonicalizeInvocation: () => null,
    mkdir: async () => {}, inspectCodex: () => null, ensureDirectories: async () => {},
    onStage: stage => stages.push(stage),
  })
  assert.deepEqual(stages, ['directories', 'codex'])
})
