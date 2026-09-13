import assert from 'node:assert/strict'
import {chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {
  CredentialSnapshotter,
  credentialSnapshotEnvironment,
  prepareCodexCredentialSnapshotForTest,
  removeEphemeralHomeWithRaceHookForTest,
} from '../src/executors/codex/credential-snapshot.js'
import {hostCodexHomeForTest} from '../src/executors/codex/process-owner.js'

test('saved login stays in its original HOME and the child environment is an exact allowlist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-credential-'))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await mkdir(source, {mode: 0o700})
  await mkdir(destination, {mode: 0o700})
  await writeFile(join(source, 'auth.json'), '{"token":"credential-sentinel"}', {mode: 0o600})
  await chmod(join(source, 'auth.json'), 0o600)
  try {
    process.env.NOVA_PARENT_CREDENTIAL_SENTINEL = 'must-not-cross'

    const result = await prepareCodexCredentialSnapshotForTest({
      sourceHome: await realpath(source),
      destinationHome: await realpath(destination),
      apiKey: null,
      environment: {
        PATH: '/safe-path',
        HOME: '/safe-home',
        LANG: 'C.UTF-8',
        NOVA_PARENT_CREDENTIAL_SENTINEL: 'must-not-cross',
      },
    })

    await assert.rejects(lstat(join(destination, 'auth.json')), {code: 'ENOENT'})
    await assert.rejects(lstat(join(destination, '.nova-credential-source-v1.json')), {code: 'ENOENT'})
    await assert.rejects(lstat(join(destination, 'config.toml')), {code: 'ENOENT'})
    assert.equal(await readFile(join(source, 'auth.json'), 'utf8'), '{"token":"credential-sentinel"}')
    assert.deepEqual(Object.keys(result.environment as Record<string, string>).sort(), [
      'CODEX_HOME',
      'CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED',
      'HOME',
      'LANG',
      'PATH',
    ])
  } finally {
    delete process.env.NOVA_PARENT_CREDENTIAL_SENTINEL
    await rm(root, {recursive: true, force: true})
  }
})

test('an API key skips hostile saved-login files and remains process-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-key-'))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await mkdir(source, {mode: 0o700})
  await mkdir(destination, {mode: 0o700})
  if (process.platform === 'win32') {
    await writeFile(join(source, 'auth.json'), 'saved-login-secret', {mode: 0o600})
  } else {
    const outside = join(root, 'outside-auth')
    await writeFile(outside, 'saved-login-secret', {mode: 0o600})
    await symlink(outside, join(source, 'auth.json'))
  }
  try {
    const home = hostCodexHomeForTest(await realpath(destination), {ephemeral: true})
    const snapshotter = new CredentialSnapshotter({
      environment: {PATH: '/safe-path', HOME: '/safe-home', SECRET_SENTINEL: 'drop-me'},
    })
    const snapshot = await snapshotter.prepare({codexHome: home, apiKey: 'api-key-process-only'})
    assert.deepEqual(credentialSnapshotEnvironment(snapshot), {
      PATH: '/safe-path',
      HOME: '/safe-home',
      CODEX_HOME: await realpath(destination),
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
      NOVA_CODEX_API_KEY: 'api-key-process-only',
    })
    await assert.rejects(readFile(join(destination, 'auth.json')), {code: 'ENOENT'})
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('Windows environment aliases are canonicalized for the credential child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-windows-env-'))
  const destination = join(root, 'destination')
  await mkdir(destination, {mode: 0o700})
  try {
    const home = hostCodexHomeForTest(await realpath(destination), {ephemeral: true})
    const snapshotter = new CredentialSnapshotter({
      platform: 'win32',
      environment: {
        Path: 'C:\\Windows\\System32',
        USERPROFILE: 'C:\\Users\\nova',
        SECRET_SENTINEL: 'drop-me',
      },
    })
    const snapshot = await snapshotter.prepare({codexHome: home, apiKey: 'api-key-process-only'})
    assert.deepEqual(credentialSnapshotEnvironment(snapshot), {
      PATH: 'C:\\Windows\\System32',
      HOME: 'C:\\Users\\nova',
      CODEX_HOME: await realpath(destination),
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
      NOVA_CODEX_API_KEY: 'api-key-process-only',
    })
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('ephemeral cleanup is exact and idempotent while persistent homes remain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-clean-home-'))
  const ephemeralPath = join(root, 'ephemeral')
  const persistentPath = join(root, 'persistent')
  await mkdir(ephemeralPath, {mode: 0o700})
  await mkdir(persistentPath, {mode: 0o700})
  try {
    const snapshotter = new CredentialSnapshotter({environment: {PATH: '/safe', HOME: '/home'}})
    const ephemeral = hostCodexHomeForTest(await realpath(ephemeralPath), {ephemeral: true})
    const persistent = hostCodexHomeForTest(await realpath(persistentPath), {ephemeral: false})
    await snapshotter.removeEphemeralHome(ephemeral)
    await snapshotter.removeEphemeralHome(ephemeral)
    await assert.rejects(lstat(ephemeralPath), {code: 'ENOENT'})
    await snapshotter.removeEphemeralHome(persistent)
    assert.equal((await lstat(persistentPath)).isDirectory(), true)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('ephemeral cleanup restores a chmodded owned root but refuses an inode replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-clean-identity-'))
  const chmoddedPath = join(root, 'chmodded')
  const replacedPath = join(root, 'replaced')
  await mkdir(chmoddedPath, {mode: 0o700})
  await mkdir(replacedPath, {mode: 0o700})
  const snapshotter = new CredentialSnapshotter({environment: {PATH: '/safe', HOME: '/home'}})
  try {
    const chmodded = hostCodexHomeForTest(await realpath(chmoddedPath), {ephemeral: true})
    await chmod(chmoddedPath, 0o000)
    await snapshotter.removeEphemeralHome(chmodded)
    await assert.rejects(lstat(chmoddedPath), {code: 'ENOENT'})

    const replaced = hostCodexHomeForTest(await realpath(replacedPath), {ephemeral: true})
    const original = join(root, 'original')
    const {rename} = await import('node:fs/promises')
    await rename(replacedPath, original)
    await mkdir(replacedPath, {mode: 0o700})
    await assert.rejects(
      snapshotter.removeEphemeralHome(replaced),
      (error: unknown) => String(error) === 'CodexCredentialError: credential_missing',
    )
    assert.equal((await lstat(replacedPath)).isDirectory(), true)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('ephemeral cleanup never deletes a replacement raced after its identity check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-clean-race-'))
  const selectedPath = join(root, 'selected')
  const originalPath = join(root, 'original')
  let replacementPath = ''
  await mkdir(selectedPath, {mode: 0o700})
  const selected = hostCodexHomeForTest(await realpath(selectedPath), {ephemeral: true})
  try {
    await assert.rejects(
      removeEphemeralHomeWithRaceHookForTest(selected, async quarantinedPath => {
        replacementPath = quarantinedPath
        await rename(quarantinedPath, originalPath)
        await mkdir(quarantinedPath, {mode: 0o700})
        await writeFile(join(quarantinedPath, 'replacement-sentinel'), 'must remain', {mode: 0o600})
      }),
      (error: unknown) => String(error) === 'CodexCredentialError: credential_missing',
    )
    assert.equal(await readFile(join(replacementPath, 'replacement-sentinel'), 'utf8'), 'must remain')
    await assert.rejects(lstat(selectedPath), {code: 'ENOENT'})
    assert.equal((await lstat(originalPath)).isDirectory(), true)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('shared home preparation preserves configuration, saved login and directory permissions', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'nova-shared-home-')))
  try {
    await chmod(home, 0o755)
    await writeFile(join(home, 'config.toml'), 'model = "user-model"\n')
    await writeFile(join(home, 'auth.json'), 'original-login', {mode: 0o600})
    const credentials = new CredentialSnapshotter({environment: {HOME: home, PATH: '/safe-path'}})
    const capability = hostCodexHomeForTest(home, {ephemeral: false})
    const snapshot = await credentials.prepare({codexHome: capability, apiKey: 'selected-key', preserveHome: true})
    await credentials.removeEphemeralHome(capability)
    assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), 'model = "user-model"\n')
    assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), 'original-login')
    assert.equal(credentialSnapshotEnvironment(snapshot).NOVA_CODEX_API_KEY, 'selected-key')
    if (process.platform !== 'win32') assert.equal((await lstat(home)).mode & 0o777, 0o755)
  } finally { await rm(home, {recursive: true, force: true}) }
})
