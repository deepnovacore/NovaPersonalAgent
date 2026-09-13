import assert from 'node:assert/strict'
import {posix, win32} from 'node:path'
import test from 'node:test'
import * as desktopStartup from '../src/main/desktop-startup.mjs'
import {createLifecycleCoordinator, reportStartupFailure, startupFailureCode} from '../src/main/desktop-startup.mjs'
test('desktop startup creates defaults then resolves an installed Codex candidate', async () => {
  const events = []
  const result = await desktopStartup.prepareDesktopStartup({
    settings: {},
    environment: { PATH: '/opt/codex/bin' },
    home: '/home/nova',
    platform: 'linux',
    arch: 'x64',
    pathApi: posix,
    canonicalizePath: value => value,
    canonicalizeExecutable: value => value === '/opt/codex/bin/codex' ? value : null,
    mkdir: async path => { events.push(`mkdir:${path}`) },
    inspectCodex: async invocation => {
      events.push(`inspect:${invocation.command}`)
      return { version: 'codex-cli 0.147.0' }
    },
  })

  assert.equal(result.config.workspace, '/home/nova/.nova-audio-agent/workspaces/default')
  assert.equal(result.config.stateRoot, '/home/nova/.nova-audio-agent')
  assert.equal(result.config.codexBinaryPath, '/opt/codex/bin/codex')
  assert.deepEqual(result.codexStatus, {
    status: 'ready',
    invocation: {command: '/opt/codex/bin/codex', prefixArgs: []},
    path: '/opt/codex/bin/codex',
    prefixArgs: [],
    source: 'path',
    version: 'codex-cli 0.147.0',
  })
  assert.deepEqual(events, [
    'mkdir:/home/nova/.nova-audio-agent',
    'mkdir:/home/nova/.nova-audio-agent/workspaces',
    'mkdir:/home/nova/.nova-audio-agent/workspaces/default',
    'inspect:/opt/codex/bin/codex',
  ])
})

test('Codex version inspection uses a bounded credential-free child environment', () => {
  let invocation
  const result = desktopStartup.inspectCodexVersion({
    command: '/opt/codex', prefixArgs: ['/official/bin/codex.js'],
  }, {
    environment: {
      PATH: '/usr/bin',
      HOME: '/home/nova',
      DASHSCOPE_API_KEY: 'secret',
      OPENAI_API_KEY: 'secret',
    },
    run: (command, args, options) => {
      invocation = { command, args, options }
      return { status: 0, stdout: 'codex-cli 0.147.0\n' }
    },
  })

  assert.deepEqual(result, { version: 'codex-cli 0.147.0' })
  assert.equal(invocation.command, '/opt/codex')
  assert.deepEqual(invocation.args, ['/official/bin/codex.js', '--version'])
  assert.equal(invocation.options.timeout, 5_000)
  assert.equal(invocation.options.maxBuffer, 64 * 1_024)
  assert.deepEqual(invocation.options.env, { PATH: '/usr/bin', HOME: '/home/nova' })
})

test('canonical executable validation rejects Windows script shims', () => {
  const dependencies = {
    platform: 'win32',
    realpath: value => `C:\\Real\\${value.split('\\').at(-1)}`,
    stat: () => ({ isFile: () => true }),
    access: () => {},
  }

  assert.equal(
    desktopStartup.canonicalInstalledExecutable('C:\\Bin\\codex.exe', dependencies),
    'C:\\Real\\codex.exe',
  )
  assert.equal(
    desktopStartup.canonicalInstalledExecutable('C:\\Bin\\codex.cmd', dependencies),
    null,
  )
})

test('validated npm launcher becomes direct Node argv without executing the cmd shim', () => {
  const packageRoot = 'C:\\Users\\nova\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex'
  const files = new Set([
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Users\\nova\\AppData\\Roaming\\npm\\codex.cmd',
    `${packageRoot}\\package.json`,
    `${packageRoot}\\bin\\codex.js`,
  ])
  const result = desktopStartup.canonicalInstalledInvocation({
    kind: 'npm-launcher',
    command: 'C:\\Program Files\\nodejs\\node.exe',
    prefixArgs: [`${packageRoot}\\bin\\codex.js`],
    packageRoot,
    manifestPath: `${packageRoot}\\package.json`,
    launcherPath: 'C:\\Users\\nova\\AppData\\Roaming\\npm\\codex.cmd',
  }, {
    platform: 'win32',
    pathApi: win32,
    realpath: value => value,
    stat: value => ({
      isFile: () => files.has(value),
      isDirectory: () => value === packageRoot,
    }),
    access: () => {},
    readFile: () => JSON.stringify({name: '@openai/codex', bin: {codex: 'bin/codex.js'}}),
  })
  assert.deepEqual(result, {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    prefixArgs: [`${packageRoot}\\bin\\codex.js`],
  })
})

test('a macOS npm launcher resolves to its validated platform-native Codex binary', () => {
  const packageRoot = '/prefix/lib/node_modules/@openai/codex'
  const platformRoot = `${packageRoot}/node_modules/@openai/codex-darwin-arm64`
  const entry = `${packageRoot}/bin/codex.js`
  const native = `${platformRoot}/vendor/aarch64-apple-darwin/bin/codex`
  const files = new Set([entry, `${packageRoot}/package.json`, `${platformRoot}/package.json`, native])
  const directories = new Set([packageRoot, platformRoot])
  const result = desktopStartup.canonicalInstalledInvocation({
    kind: 'native', command: '/prefix/bin/codex', prefixArgs: [], source: 'common',
  }, {
    platform: 'darwin',
    arch: 'arm64',
    pathApi: posix,
    realpath: value => value === '/prefix/bin/codex' ? entry : value,
    stat: value => ({
      isFile: () => files.has(value),
      isDirectory: () => directories.has(value),
    }),
    access: () => {},
    readFile: value => JSON.stringify(value === `${packageRoot}/package.json`
      ? {name: '@openai/codex', bin: {codex: 'bin/codex.js'}}
      : {name: '@openai/codex', os: ['darwin'], cpu: ['arm64']}),
  })

  assert.deepEqual(result, {command: native, prefixArgs: []})
})

test('a lifecycle owner prevents a competing operation from running', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const calls = []
  const coordinator = createLifecycleCoordinator({
    onChange: state => calls.push(state),
  })

  const first = coordinator.run('settings_save', async () => {
    await gate
    return 7
  })

  assert.equal(coordinator.busy, true)
  assert.equal(coordinator.owner, 'settings_save')
  assert.deepEqual(
    await coordinator.run('clear_current', async () => 9),
    { status: 'busy' },
  )

  release()
  assert.deepEqual(await first, { status: 'completed', value: 7 })
  assert.equal(coordinator.busy, false)
  assert.equal(coordinator.owner, null)
  assert.deepEqual(calls, [
    { busy: true, owner: 'settings_save' },
    { busy: false, owner: null },
  ])
})

test('a failed lifecycle operation releases ownership for a later operation', async () => {
  const coordinator = createLifecycleCoordinator()

  await assert.rejects(
    coordinator.run('settings_save', async () => {
      throw new Error('write failed')
    }),
    /write failed/,
  )

  assert.deepEqual(
    await coordinator.run('codex_rescan', async () => 'ok'),
    { status: 'completed', value: 'ok' },
  )
})

test('startup failures publish only a stable allowlisted code', () => {
  assert.equal(
    startupFailureCode(new Error('project_directory_open_failed')),
    'project_directory_open_failed',
  )
  assert.equal(
    startupFailureCode(Object.assign(new Error('private camera path'), {
      name: 'MainCameraConfigurationError',
    })),
    'camera_configuration_invalid',
  )

  let written = ''
  const code = reportStartupFailure(new Error('secret path C:\\private\\token'), {
    write: chunk => { written += chunk },
  })
  assert.equal(code, 'startup_failed')
  assert.equal(written, '[desktop-diagnostic] startup_failure code=startup_failed\n')
  assert.doesNotMatch(written, /private|token/u)
})


test('unsupported embedding startup shows an actionable message without exposing the stored value', () => {
  let shown, written = ''
  const code = reportStartupFailure(Object.assign(new Error('private stored value'), {
    code: 'embedding_provider_invalid',
  }), {
    write: chunk => {written += chunk},
    showError: message => {shown = message},
  })
  assert.equal(code, 'embedding_provider_invalid')
  assert.match(shown, /embeddingProvider.*dashscope/u)
  assert.match(shown, /后端未启动/u)
  assert.doesNotMatch(shown + written, /private stored value/u)
})
