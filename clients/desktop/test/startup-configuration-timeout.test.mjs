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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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

test('aborting an owner rejects an unsettled wait immediately as superseded', async () => {
  const coordinator = createLifecycleCoordinator()
  const attempt = createConfigurationAttempt()
  const started = Date.now()
  const pending = coordinator.run('startup', () => runConfigurationStage(
    attempt, 'settings', () => new Promise(() => {}), {onStage: () => {}, timeoutMs: 5_000},
  ))
  await sleep(10)
  attempt.abort()
  await assert.rejects(pending, error => error.code === 'configuration_superseded')
  assert.ok(Date.now() - started < 1_000)
  assert.equal(coordinator.busy, false)
})

test('async late-cleanup failures never escape as unhandled rejections', async () => {
  const attempt = createConfigurationAttempt()
  const seen = []
  const onUnhandled = reason => seen.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    let release
    const pending = runConfigurationStage(attempt, 'capabilities', () => new Promise(resolve => { release = resolve }), {
      onStage: () => {},
      timeoutMs: 5,
      onLateResult: () => Promise.reject(new Error('late cleanup failed')),
    })
    await assert.rejects(pending, error => error.code === 'configuration_timeout')
    release({health: 'ready'})
    await sleep(20)
    assert.deepEqual(seen, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('a maintenance service opened after the stage deadline is closed, not installed', async () => {
  let releaseOpen
  let closed = 0
  const {context, published} = configurationContext({
    projectNativeHost: {},
    currentSettings: {},
    process: {env: {}},
    homedir: () => '/home/test',
    path: {sep: '/'},
    mkdir: async () => {},
    prepareDesktopStartup: async () => ({config: {stateRoot: '/state', managedRoot: '/managed'}, codexStatus: {}}),
    ManagedWorkspaceMaintenanceService: {
      openFromDesktop: () => new Promise(resolve => { releaseOpen = resolve }),
    },
    runConfigurationStage: (attempt, stage, operation, options = {}) => runConfigurationStage(
      attempt, stage, operation, {...options, timeoutMs: 20},
    ),
  })
  const attempt = context.beginConfigurationAttempt()
  const pending = context.prepareDesktopConfiguration(attempt)
  await assert.rejects(pending, error => error.code === 'configuration_timeout' && error.stage === 'maintenance')
  assert.equal(context.managedWorkspaceMaintenance, null)
  releaseOpen({close: async () => { closed += 1 }})
  for (let index = 0; index < 50 && closed === 0; index += 1) await sleep(5)
  assert.equal(closed, 1)
  assert.deepEqual(published.map(entry => entry[1]), ['configuration_wait_maintenance'])
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
})

test('each preparation wait has its own budget instead of sharing one settings deadline', async () => {
  const stages = []
  const attempt = createConfigurationAttempt()
  const {posix} = await import('node:path')
  const runStage = (stage, operation) => runConfigurationStage(attempt, stage, operation, {
    onStage: name => stages.push(name),
    timeoutMs: 40,
  })
  const prepared = await prepareDesktopStartup({
    settings: {codexWorkspace: '/home/test/ws'}, environment: {}, home: '/home/test',
    platform: 'linux', arch: 'x64', pathApi: posix,
    canonicalizePath: value => value, canonicalizeExecutable: () => null, canonicalizeInvocation: () => null,
    mkdir: async () => {}, inspectCodex: () => null,
    inspectWorkspace: async () => { await sleep(25); return {isDirectory: () => true} },
    ensureDirectories: async () => { await sleep(25) },
    runStage,
  })
  assert.deepEqual(stages, ['workspace', 'directories', 'codex'])
  assert.ok(prepared.config)
})

test('a preparation timeout names the stage it actually constrained, not settings', async () => {
  const stages = []
  const attempt = createConfigurationAttempt()
  const {posix} = await import('node:path')
  const runStage = (stage, operation) => runConfigurationStage(attempt, stage, operation, {
    onStage: name => stages.push(name),
    timeoutMs: 40,
  })
  await assert.rejects(prepareDesktopStartup({
    settings: {codexWorkspace: '/home/test/ws'}, environment: {}, home: '/home/test',
    platform: 'linux', arch: 'x64', pathApi: posix,
    canonicalizePath: value => value, canonicalizeExecutable: () => null, canonicalizeInvocation: () => null,
    mkdir: async () => {}, inspectCodex: () => null,
    inspectWorkspace: async () => { await sleep(25); return {isDirectory: () => true} },
    ensureDirectories: async () => { await sleep(200) },
    runStage,
  }), error => error.code === 'configuration_timeout' && error.stage === 'directories')
  assert.deepEqual(stages, ['workspace', 'directories'])
  assert.equal(attempt.current(), false)
})
