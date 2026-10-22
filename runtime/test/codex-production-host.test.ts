import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {
  NativeCodexHostPreflightRunner,
  NativeCodexLiveSchemaProbe,
  canonicalSystemTemporaryDirectoryForTest,
  codexSandboxProbePathForTest,
  createProductionCodexHost,
  loadCodexSandboxProbeFromResources,
  runBoundedCodexCommand,
  type BoundedCodexCommand,
  type BoundedCodexCommandResult,
} from '../src/executors/codex/production-host.js'
import {hostBinaryForTest, hostCodexHomeForTest, hostWorkspaceForTest} from '../src/executors/codex/process-owner.js'
import {validateCodexSchemaBundle} from '../src/executors/codex/app-server-schema.js'
import {supportedSchemaBundle} from './fixtures/codex/supported-schema-bundle.js'
import {loadSettings} from '../src/config/config.js'
import {sanitizeCodexPreflightReport} from '../src/executors/codex/contract.js'

function fakeMachExecutable(): Buffer {
  const body = Buffer.alloc(64)
  body.writeUInt32LE(0xfeedfacf, 0)
  body.writeUInt32LE(0x0100000c, 4)
  body.writeUInt32LE(2, 12)
  return body
}

test('Codex sandbox probe resolves only the fixed manifest-bound executable', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-codex-probe-resource-')))
  const relative = 'native/codex-sandbox-probe'
  const probe = join(root, relative)
  const body = fakeMachExecutable()
  try {
    await mkdir(join(root, 'native'), {recursive: true})
    await writeFile(probe, body, {mode: 0o755})
    await chmod(probe, 0o755)
    await writeFile(join(root, 'native-resources-v1.json'), JSON.stringify({
      schema_version: 1,
      target: 'darwin-arm64',
      resources: [{
        logical_id: 'codex_sandbox_probe',
        relative_path: relative,
        byte_size: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        kind: 'executable',
        platform: 'darwin',
        architecture: 'arm64',
        electron_abi: null,
        build_contract_version: 1,
      }],
    }))
    const loaded = loadCodexSandboxProbeFromResources({
      resourcesPath: root,
      platform: 'darwin',
      arch: 'arm64',
    })
    assert.notEqual(loaded, null)
    assert.equal(codexSandboxProbePathForTest(loaded!), probe)

    if (process.platform !== 'win32') {
      await chmod(probe, 0o700)
      assert.notEqual(loadCodexSandboxProbeFromResources({resourcesPath: root, platform: 'darwin', arch: 'arm64'}), null)
      await chmod(probe, 0o644)
      assert.equal(loadCodexSandboxProbeFromResources({
        resourcesPath: root,
        platform: 'darwin',
        arch: 'arm64',
      }), null)
    }
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('production preflight uses the fixed native probe and never passes credentials to commands', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-codex-production-host-')))
  const workspace = join(root, 'workspace')
  const binary = join(root, 'codex')
  const home = join(root, 'home')
  const probe = join(root, 'probe')
  await mkdir(workspace)
  await mkdir(join(workspace, '.git'))
  await mkdir(home)
  await writeFile(binary, '#!/bin/sh\nexit 0\n', {mode: 0o755})
  await writeFile(probe, '#!/bin/sh\nexit 0\n', {mode: 0o755})
  const calls: BoundedCodexCommand[] = []
  const commandRunner = async (command: BoundedCodexCommand): Promise<BoundedCodexCommandResult> => {
    await Promise.resolve()
    calls.push(command)
    if (command.argv[0] === '--version') {
      return {status: 0, stdout: Buffer.from('codex-cli 0.151.0-alpha.7.2\n')}
    }
    if (command.argv[0] === 'login') {
      return {
        status: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('Logged in using ChatGPT\n'),
      }
    }
    const mainIndex = command.argv.indexOf('--main')
    const materializedProbe = mainIndex > 0 ? command.argv[mainIndex - 1] : undefined
    assert.equal(typeof materializedProbe, 'string')
    assert.notEqual(materializedProbe, probe)
    assert.equal(await readFile(materializedProbe!, 'utf8'), '#!/bin/sh\nexit 0\n')
    return {status: 0, stdout: Buffer.from(JSON.stringify({
      cwd_matches: true,
      inside_write: true,
      inside_remove: true,
      outside_write_denied: true,
      child_outside_write_denied: true,
      network_denied: true,
      limits: {cpu: 'finite', as: 'unbounded', nofile: 'finite'},
    }))}
  }
  try {
    const runner = new NativeCodexHostPreflightRunner({
      probePath: probe,
      environment: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        CODEX_API_KEY: 'must-not-cross-preflight',
      },
      hasApiKey: false,
      commandRunner,
    })
    const stages: string[] = []
    const result = await runner.run({
      binary: hostBinaryForTest(await realpath(binary)),
      workspace: hostWorkspaceForTest(await realpath(workspace)),
      codexHome: hostCodexHomeForTest(await realpath(home), {ephemeral: true}),
      apiKey: null,
      developerInstructions: null,
      resumeThreadId: null,
      persistent: false,
      preserveHome: true,
      workingInterval: 30,
    }, 5_000, event => { stages.push(event) })
    assert.deepEqual(stages, ['version', 'login', 'sandbox'])
    assert.deepEqual(result, {
      version: '0.151.0-alpha.7.2',
      root_matches: true,
      mount: 'workspace_only',
      subprocess: 'contained',
      network: 'blocked',
      credential: {present: true, identity: 'chatgpt', policy: 'saved_login'},
      limits: {cpu: 'finite', as: 'unbounded', nofile: 'finite'},
    })
    assert.equal(calls.length, 3)
    assert.equal(calls.find(call => call.argv[0] === 'login')?.environment.CODEX_HOME, await realpath(home))
    for (const call of calls) {
      assert.equal(call.binary, await realpath(binary))
      assert.equal(call.cwd, await realpath(workspace))
      assert.equal('CODEX_API_KEY' in call.environment, false)
      assert.equal('CODEX_API_KEY' in call.environment, false)
      assert.equal(call.shell, false)
    }
    await writeFile(probe, '#!/bin/sh\nexit 9\n', {mode: 0o755})
    await assert.rejects(runner.run({
      binary: hostBinaryForTest(await realpath(binary)),
      workspace: hostWorkspaceForTest(await realpath(workspace)),
      codexHome: hostCodexHomeForTest(await realpath(home), {ephemeral: true}),
      apiKey: null,
      developerInstructions: null,
      resumeThreadId: null,
      persistent: false,
      workingInterval: 30,
    }, 5_000), error => (
      typeof error === 'object'
      && error !== null
      && Reflect.get(error, 'code') === 'sandbox_failed'
    ))
    assert.equal(calls.length, 5, 'replacement is rejected before the sandbox command')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('production preflight accepts a canonical non-Git workspace for a new managed project', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-codex-non-git-workspace-')))
  const workspace = join(root, 'workspace')
  const binary = join(root, 'codex')
  const home = join(root, 'home')
  const probe = join(root, 'probe')
  await mkdir(workspace)
  await mkdir(home)
  await writeFile(binary, '#!/bin/sh\nexit 0\n', {mode: 0o755})
  await writeFile(probe, '#!/bin/sh\nexit 0\n', {mode: 0o755})
  let call = 0
  try {
    const runner = new NativeCodexHostPreflightRunner({
      probePath: probe,
      environment: {PATH: '/usr/bin:/bin', HOME: home},
      hasApiKey: true,
      commandRunner: async () => {
        call += 1
        await Promise.resolve()
        if (call === 1) return {status: 0, stdout: Buffer.from('codex-cli 0.147.0')}
        return {status: 0, stdout: Buffer.from(JSON.stringify({
          cwd_matches: true,
          inside_write: true,
          inside_remove: true,
          outside_write_denied: true,
          child_outside_write_denied: true,
          network_denied: true,
          limits: {cpu: 'finite', as: 'unbounded', nofile: 'finite'},
        }))}
      },
    })

    const report = await runner.run({
      binary: hostBinaryForTest(await realpath(binary)),
      workspace: hostWorkspaceForTest(await realpath(workspace)),
      codexHome: hostCodexHomeForTest(await realpath(home), {ephemeral: true}),
      apiKey: null,
      developerInstructions: null,
      resumeThreadId: null,
      persistent: false,
      workingInterval: 30,
    }, 5_000)

    assert.equal(Reflect.get(report as object, 'root_matches'), true)
    assert.equal(call, 2)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('Windows production preflight derives HOME from USERPROFILE without a synthetic HOME', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-codex-windows-preflight-env-')))
  const workspace = join(root, 'workspace')
  const binary = join(root, 'codex')
  const home = join(root, 'home')
  const probe = join(root, 'probe')
  await mkdir(workspace)
  await mkdir(home)
  await writeFile(binary, 'binary', {mode: 0o755})
  await writeFile(probe, 'probe', {mode: 0o755})
  let call = 0
  try {
    const runner = new NativeCodexHostPreflightRunner({
      probePath: probe,
      platform: 'win32',
      environment: {
        Path: 'C:\\Windows\\System32',
        USERPROFILE: 'C:\\Users\\nova',
      },
      hasApiKey: true,
      commandRunner: async command => {
        assert.deepEqual(command.environment, {
          PATH: 'C:\\Windows\\System32',
          HOME: 'C:\\Users\\nova',
        })
        call += 1
        await Promise.resolve()
        if (call === 1) return {status: 0, stdout: Buffer.from('codex-cli 0.147.0')}
        return {status: 0, stdout: Buffer.from(JSON.stringify({
          cwd_matches: true,
          inside_write: true,
          inside_remove: true,
          outside_write_denied: true,
          child_outside_write_denied: true,
          network_denied: true,
          limits: {cpu: 'finite', as: 'unbounded', nofile: 'finite'},
        }))}
      },
    })
    await runner.run({
      binary: hostBinaryForTest(await realpath(binary)),
      workspace: hostWorkspaceForTest(await realpath(workspace)),
      codexHome: hostCodexHomeForTest(await realpath(home), {ephemeral: true}),
      apiKey: null,
      developerInstructions: null,
      resumeThreadId: null,
      persistent: false,
      workingInterval: 30,
    }, 5_000)
    assert.equal(call, 2)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('production preflight reports a safe login-status diagnostic without command output', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-codex-login-diagnostic-')))
  const workspace = join(root, 'workspace')
  const binary = join(root, 'codex')
  const home = join(root, 'home')
  const probe = join(root, 'probe')
  await mkdir(workspace)
  await mkdir(home)
  await writeFile(binary, '#!/bin/sh\nexit 0\n', {mode: 0o755})
  await writeFile(probe, '#!/bin/sh\nexit 0\n', {mode: 0o755})
  const scenarios: readonly [BoundedCodexCommandResult, string][] = [
    [{status: 1, stdout: Buffer.from('private login detail')}, 'codex_login_status_nonzero'],
    [{status: 0, stdout: Buffer.alloc(0)}, 'codex_login_status_no_output'],
    [{status: 0, stdout: Buffer.from('one'), stderr: Buffer.from('two')},
      'codex_login_status_multiple_streams'],
    [{status: 0, stdout: Buffer.from('private changed wording')},
      'codex_login_status_unrecognized'],
  ]
  try {
    for (const [loginResult, expected] of scenarios) {
      const diagnostics: string[] = []
      let call = 0
      const runner = new NativeCodexHostPreflightRunner({
        probePath: probe,
        environment: {PATH: '/usr/bin:/bin', HOME: home},
        hasApiKey: false,
        onDiagnostic: code => diagnostics.push(code),
        commandRunner: async () => {
          await Promise.resolve()
          call += 1
          return call === 1
            ? {status: 0, stdout: Buffer.from('codex-cli 0.147.0')}
            : loginResult
        },
      })
      await assert.rejects(runner.run({
        binary: hostBinaryForTest(await realpath(binary)),
        workspace: hostWorkspaceForTest(await realpath(workspace)),
        codexHome: hostCodexHomeForTest(await realpath(home), {ephemeral: true}),
        apiKey: null,
        developerInstructions: null,
        resumeThreadId: null,
        persistent: false,
        workingInterval: 30,
      }, 5_000), (error: unknown) => (
        typeof error === 'object'
        && error !== null
        && Reflect.get(error, 'code') === 'credential_missing'
        && typeof Reflect.get(error, 'message') === 'string'
        && (Reflect.get(error, 'message') as string).includes('private') === false
      ))
      assert.deepEqual(diagnostics, [expected])
    }
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('production preflight adds shared provider tokens as an alternative to saved login', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-codex-provider-credential-')))
  const workspace = join(root, 'workspace')
  const binary = join(root, 'codex')
  const home = join(root, 'home')
  const probe = join(root, 'probe')
  await mkdir(workspace)
  await mkdir(home)
  await writeFile(binary, 'binary', {mode: 0o755})
  await writeFile(probe, 'probe', {mode: 0o755})
  const token = 'provider-token-sentinel-must-not-leak'
  const savedToken = `model_provider = "proxy"\n[model_providers.proxy]\nbase_url = "https://provider.example/v1"\nexperimental_bearer_token = "${token}"\n`
  const cases = [
    {name: 'saved provider token without auth.json', config: savedToken, accepted: true},
    {name: 'OpenAI login still takes precedence', config: savedToken, savedLogin: true, accepted: true},
    {name: 'empty token', config: savedToken.replace(token, '')},
    {name: 'unselected provider', config: savedToken.replace('model_provider = "proxy"', 'model_provider = "openai"')},
    {name: 'provider URL is required', config: savedToken.replace('base_url = "https://provider.example/v1"\n', '')},
    {name: 'provider URL cannot be empty', config: savedToken.replace('https://provider.example/v1', '')},
    {name: 'environment-only credentials do not satisfy the saved credential alternative', config: `${savedToken.replace(token, '')}env_key = "OTHER_PROVIDER_API_KEY"\n`},
    {name: 'auth.json API key without bearer token', config: savedToken.replace(`experimental_bearer_token = "${token}"\n`, ''), auth: JSON.stringify({OPENAI_API_KEY: token}), accepted: true},
    {name: 'empty bearer token falls back to auth.json API key', config: savedToken.replace(token, ''), auth: JSON.stringify({OPENAI_API_KEY: token}), accepted: true},
    {name: 'API key supports a provider requiring OpenAI authentication', config: `${savedToken.replace(token, '')}requires_openai_auth = true\n`, auth: JSON.stringify({OPENAI_API_KEY: token}), accepted: true},
    {name: 'empty auth.json API key is rejected', config: savedToken.replace(token, ''), auth: '{"OPENAI_API_KEY":" "}'},
    {name: 'non-string auth.json API key is rejected', config: savedToken.replace(token, ''), auth: '{"OPENAI_API_KEY":123}'},
    {name: 'ChatGPT tokens alone do not satisfy the provider API key alternative', config: savedToken.replace(token, ''), auth: '{"tokens":{"access_token":"expired-sentinel"}}'},
    {name: 'malformed auth.json is rejected', config: savedToken.replace(token, ''), auth: '{"OPENAI_API_KEY":'},
    {name: 'a saved bearer token does not depend on auth.json', config: savedToken, auth: '{invalid', accepted: true},
    {name: 'malformed configuration', config: 'model_provider = "proxy"\n[invalid'},
    {name: 'missing provider token', config: 'model_provider = "proxy"\n[model_providers.proxy]\nbase_url = "https://provider.example/v1"\n'},
    {name: 'unshared home cannot use a provider token', config: savedToken, preserveHome: false},
  ]
  try {
    for (const scenario of cases) await t.test(scenario.name, async () => {
      await writeFile(join(home, 'config.toml'), scenario.config, {mode: 0o600})
      if (scenario.auth !== undefined) await writeFile(join(home, 'auth.json'), scenario.auth, {mode: 0o600})
      else await rm(join(home, 'auth.json'), {force: true})
      const diagnostics: string[] = []
      const calls: BoundedCodexCommand[] = []
      const runner = new NativeCodexHostPreflightRunner({
        probePath: probe, environment: {PATH: '/safe', HOME: home}, hasApiKey: false,
        onDiagnostic: code => diagnostics.push(code),
        commandRunner: async command => {
          await Promise.resolve()
          calls.push(command)
          if (command.argv[0] === '--version') return {status: 0, stdout: Buffer.from('codex-cli 0.163.0')}
          if (command.argv[0] === 'login') return scenario.savedLogin
            ? {status: 0, stdout: Buffer.alloc(0), stderr: Buffer.from('Logged in using ChatGPT\n')}
            : {status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('Not logged in\n')}
          return {status: 0, stdout: Buffer.from(JSON.stringify({
            cwd_matches: true, inside_write: true, inside_remove: true,
            outside_write_denied: true, child_outside_write_denied: true, network_denied: true,
            limits: {cpu: 'finite', as: 'unbounded', nofile: 'finite'},
          }))}
        },
      })
      const operation = runner.run({
        binary: hostBinaryForTest(await realpath(binary)),
        workspace: hostWorkspaceForTest(await realpath(workspace)),
        codexHome: hostCodexHomeForTest(await realpath(home), {ephemeral: false}),
        apiKey: null, developerInstructions: null, resumeThreadId: null,
        persistent: true, preserveHome: scenario.preserveHome ?? true, workingInterval: 30,
      }, 5_000)
      if (scenario.accepted) {
        const result = await operation
        assert.deepEqual(sanitizeCodexPreflightReport(result)?.credential, {
          present: true, identity: scenario.savedLogin ? 'chatgpt' : 'api_key',
          policy: scenario.savedLogin ? 'saved_login' : 'provider_config',
        })
        assert.equal(calls.length, 3, 'provider credentials still require the sandbox probe')
        assert.deepEqual(diagnostics, [], 'a usable alternative must not emit a login failure')
        assert.equal(JSON.stringify(result).includes(token), false)
      } else {
        await assert.rejects(operation, {code: 'credential_missing'})
        assert.equal(calls.length, 2)
        assert.deepEqual(diagnostics, ['codex_login_status_nonzero'])
      }
      assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), scenario.config)
      if (scenario.auth !== undefined) assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), scenario.auth)
      assert.equal(JSON.stringify(calls).includes(token), false)
    })
  } finally { await rm(root, {recursive: true, force: true}) }
})

test('unsandboxed or malformed native probe output fails closed with a stable code', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-codex-production-host-')))
  const workspace = join(root, 'workspace')
  const binary = join(root, 'codex')
  const home = join(root, 'home')
  const probe = join(root, 'probe')
  await mkdir(workspace)
  await mkdir(join(workspace, '.git'))
  await mkdir(home)
  await writeFile(binary, 'binary', {mode: 0o755})
  await writeFile(probe, 'probe', {mode: 0o755})
  try {
    let call = 0
    const runner = new NativeCodexHostPreflightRunner({
      probePath: probe,
      environment: {PATH: '/usr/bin:/bin', HOME: home},
      hasApiKey: true,
      commandRunner: async () => {
        await Promise.resolve()
        call += 1
        if (call === 1) return {status: 0, stdout: Buffer.from('codex-cli 0.147.0')}
        return {status: 0, stdout: Buffer.from('{"cwd_matches":true,"inside_write":true,"inside_remove":true,"outside_write_denied":false,"child_outside_write_denied":false,"network_denied":false,"limits":{"cpu":"finite","as":"finite","nofile":"finite"}}')}
      },
    })
    await assert.rejects(runner.run({
      binary: hostBinaryForTest(await realpath(binary)),
      workspace: hostWorkspaceForTest(await realpath(workspace)),
      codexHome: hostCodexHomeForTest(await realpath(home), {ephemeral: true}),
      apiKey: null,
      developerInstructions: null,
      resumeThreadId: null,
      persistent: false,
      workingInterval: 30,
    }, 5_000), error => (
      typeof error === 'object'
      && error !== null
      && Reflect.get(error, 'code') === 'sandbox_failed'
      && error instanceof Error
      && error.message === 'sandbox_failed'
    ))
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('production schema probe invokes the host binary and returns only the reviewed schema bundle', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-codex-schema-host-')))
  const workspace = join(root, 'workspace')
  const binary = join(root, 'codex')
  const home = join(root, 'home')
  await mkdir(workspace)
  await mkdir(home)
  await writeFile(binary, 'binary', {mode: 0o755})
  const bundle = supportedSchemaBundle()
  try {
    const probe = new NativeCodexLiveSchemaProbe({
      environment: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        CODEX_API_KEY: 'must-not-cross-schema-probe',
      },
      commandRunner: async command => {
        assert.deepEqual(command.argv.slice(0, 4), ['app-server', 'generate-json-schema', '--experimental', '--out'])
        assert.equal('CODEX_API_KEY' in command.environment, false)
        const output = command.argv[4]
        assert.notEqual(output, undefined)
        for (const [name, document] of Object.entries(bundle)) {
          const destination = join(output!, name)
          await mkdir(join(destination, '..'), {recursive: true})
          await writeFile(destination, JSON.stringify(document), {mode: 0o600})
        }
        return {status: 0, stdout: Buffer.alloc(0)}
      },
    })
    const result = await probe.generate({
      binary: hostBinaryForTest(await realpath(binary)),
      workspace: hostWorkspaceForTest(await realpath(workspace)),
      codexHome: hostCodexHomeForTest(await realpath(home), {ephemeral: true}),
      apiKey: null,
      developerInstructions: null,
      resumeThreadId: null,
      persistent: false,
      workingInterval: 30,
    }, 5_000)
    assert.deepEqual(validateCodexSchemaBundle(result), {
      initialize: true,
      'config/read': true,
      'thread/start': true,
      'thread/resume': true,
      'mcpServerStatus/list': true,
      'turn/start': true,
      'turn/steer': true,
      'turn/interrupt': true,
      'thread/name/set': true,
    })
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('Windows production schema probe derives HOME from USERPROFILE without a synthetic HOME', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-codex-windows-schema-env-')))
  const workspace = join(root, 'workspace')
  const binary = join(root, 'codex')
  const home = join(root, 'home')
  await mkdir(workspace)
  await mkdir(home)
  await writeFile(binary, 'binary', {mode: 0o755})
  const bundle = supportedSchemaBundle()
  try {
    const probe = new NativeCodexLiveSchemaProbe({
      platform: 'win32',
      environment: {
        Path: 'C:\\Windows\\System32',
        USERPROFILE: 'C:\\Users\\nova',
      },
      commandRunner: async command => {
        assert.deepEqual(command.environment, {
          PATH: 'C:\\Windows\\System32',
          HOME: 'C:\\Users\\nova',
        })
        const output = command.argv[4]
        assert.notEqual(output, undefined)
        for (const [name, document] of Object.entries(bundle)) {
          const destination = join(output!, name)
          await mkdir(join(destination, '..'), {recursive: true})
          await writeFile(destination, JSON.stringify(document), {mode: 0o600})
        }
        return {status: 0, stdout: Buffer.alloc(0)}
      },
    })
    assert.deepEqual(validateCodexSchemaBundle(await probe.generate({
      binary: hostBinaryForTest(await realpath(binary)),
      workspace: hostWorkspaceForTest(await realpath(workspace)),
      codexHome: hostCodexHomeForTest(await realpath(home), {ephemeral: true}),
      apiKey: null,
      developerInstructions: null,
      resumeThreadId: null,
      persistent: false,
      workingInterval: 30,
    }, 5_000)), {
      initialize: true,
      'config/read': true,
      'thread/start': true,
      'thread/resume': true,
      'mcpServerStatus/list': true,
      'turn/start': true,
      'turn/steer': true,
      'turn/interrupt': true,
      'thread/name/set': true,
    })
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('production host expands a leading tilde in the configured workspace', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-codex-home-workspace-')))
  const home = join(root, 'home')
  const workspace = join(home, 'workspace')
  const binary = join(root, 'codex')
  try {
    await mkdir(workspace, {recursive: true, mode: 0o700})
    await chmod(home, 0o700)
    await chmod(workspace, 0o700)
    await writeFile(binary, '#!/fixture\n', {mode: 0o700})
    await chmod(binary, 0o700)

    const host = createProductionCodexHost(loadSettings({
      EXECUTOR: 'codex',
      CODEX_WORKSPACE: '~/workspace',
      CODEX_BIN: binary,
    }), {
      resourcesPath: root,
      homeDirectory: home,
    })

    assert.deepEqual(host.catalog.canonicalWorkspaces, [await realpath(workspace)])
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('production host catalog admits only absolute host config and a packaged fixed probe', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-codex-production-catalog-')))
  const workspace = join(root, 'workspace')
  const binary = join(root, 'codex')
  const home = join(root, 'home')
  const temporary = join(root, 'tmp')
  const temporaryAlias = join(root, 'tmp-alias')
  const resources = join(root, 'resources')
  const probe = join(resources, 'native', 'codex-sandbox-probe')
  const body = fakeMachExecutable()
  try {
    await mkdir(workspace)
    await mkdir(join(workspace, '.git'))
    await mkdir(home)
    await mkdir(temporary)
    await symlink(temporary, temporaryAlias, process.platform === 'win32' ? 'junction' : 'dir')
    await mkdir(join(resources, 'native'), {recursive: true})
    await writeFile(binary, '#!/bin/sh\nexit 0\n', {mode: 0o755})
    await writeFile(probe, body, {mode: 0o755})
    await chmod(probe, 0o755)
    await writeFile(join(resources, 'native-resources-v1.json'), JSON.stringify({
      schema_version: 1,
      target: 'darwin-arm64',
      resources: [{
        logical_id: 'codex_sandbox_probe',
        relative_path: 'native/codex-sandbox-probe',
        byte_size: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        kind: 'executable', platform: 'darwin', architecture: 'arm64',
        electron_abi: null, build_contract_version: 1,
      }],
    }))
    const settings = loadSettings({
      EXECUTOR: 'codex',
      EXECUTORS: 'codex',
      CODEX_WORKSPACE: await realpath(workspace),
      CODEX_BIN: await realpath(binary),
    })
    const host = createProductionCodexHost(settings, {
      resourcesPath: await realpath(resources),
      platform: 'darwin',
      arch: 'arm64',
      electronAbi: '148',
      homeDirectory: await realpath(home),
      temporaryDirectory: await realpath(temporary),
      environment: {PATH: '/usr/bin:/bin', HOME: await realpath(home)},
    })
    assert.deepEqual(host.catalog.canonicalBinaries, [await realpath(binary)])
    assert.deepEqual(host.catalog.canonicalWorkspaces, [await realpath(workspace)])
    assert.equal(host.transportFactory.available, true)
    assert.equal(host.projectHost, null)
    assert.equal(canonicalSystemTemporaryDirectoryForTest(temporaryAlias), await realpath(temporary))

    const missingHome = createProductionCodexHost(settings, {
      resourcesPath: await realpath(resources),
      platform: 'darwin',
      arch: 'arm64',
      electronAbi: '148',
      homeDirectory: await realpath(home),
      temporaryDirectory: await realpath(temporary),
      environment: {PATH: '/usr/bin:/bin'},
    })
    assert.equal(missingHome.transportFactory.available, true)

    const configuredAlias = createProductionCodexHost(settings, {
      resourcesPath: await realpath(resources),
      platform: 'darwin', arch: 'arm64', homeDirectory: await realpath(home),
      temporaryDirectory: temporaryAlias,
      environment: {PATH: '/usr/bin:/bin', HOME: await realpath(home)},
    })
    assert.equal(configuredAlias.transportFactory.available, false)

    const defaultBinary = createProductionCodexHost(loadSettings({
      EXECUTOR: 'codex',
      EXECUTORS: 'codex',
      CODEX_WORKSPACE: await realpath(workspace),
    }), {
      resourcesPath: await realpath(resources),
      platform: 'darwin', arch: 'arm64', homeDirectory: await realpath(home),
    })
    assert.equal(defaultBinary.transportFactory.available, false)
    assert.deepEqual(defaultBinary.catalog.canonicalBinaries, [])
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('bounded POSIX command waits for pipe EOF and reaps a leader-first descendant tree', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-codex-command-tree-')))
  const pidFile = join(root, 'descendant.pid')
  try {
    assert.deepEqual(await runBoundedCodexCommand({
      binary: process.execPath,
      argv: ['-e', 'process.stdout.write("ready")'],
      cwd: root,
      environment: {PATH: '/usr/bin:/bin', HOME: root},
      timeoutMs: 2000,
      stdoutLimit: 1024,
      stderrLimit: 1024,
      shell: false,
    }), {status: 0, stdout: Buffer.from('ready')})
    const childCode = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`
    const leaderCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'}).unref()`
    const cleanupEvents: string[] = []
    await assert.rejects(runBoundedCodexCommand({
      observe: event => { cleanupEvents.push(event); throw new Error('advisory observer') },
      binary: process.execPath,
      argv: ['-e', leaderCode],
      cwd: root,
      environment: {PATH: '/usr/bin:/bin', HOME: root},
      timeoutMs: 500,
      stdoutLimit: 1024,
      stderrLimit: 1024,
      shell: false,
    }), error => (
      typeof error === 'object'
      && error !== null
      && Reflect.get(error, 'code') === 'preflight_timeout'
    ))
    assert.deepEqual(cleanupEvents, ['cleanup_started', 'cleanup_completed'])
    const descendant = Number(await readFile(pidFile, 'utf8'))
    assert.ok(Number.isSafeInteger(descendant) && descendant > 0)
    assert.throws(() => process.kill(descendant, 0), error => (
      typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ESRCH'
    ))
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})
