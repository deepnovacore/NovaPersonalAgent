import assert from 'node:assert/strict'
import {existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {homedir, tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {test} from 'node:test'

import {main} from '../src/command.mjs'
import {defaultDataPath} from '../src/data-root.mjs'
import {resetPersonalState} from '../src/runtime.mjs'

import {
  desktopSettingsPath,
  PRODUCT_VERSION,
  releaseBaseUrl,
  releaseRoot,
  resolveTarget,
} from '../src/target.mjs'

test('public version and target matrix are stable', () => {
  assert.equal(PRODUCT_VERSION, '1.0.0')
  assert.equal(resolveTarget('darwin', 'arm64').artifact, 'nova-personal-agent-1.0.0-macos-arm64-app.zip')
  assert.equal(resolveTarget('win32', 'x64').executable, 'Nova Personal Agent.exe')
  assert.throws(() => resolveTarget('darwin', 'x64'), /unsupported platform/u)
  assert.equal(resolveTarget('linux', 'x64').archive, 'file')
  assert.equal(resolveTarget('linux', 'x64').artifact, 'nova-personal-agent-1.0.0-linux-x64.AppImage')
  assert.throws(() => resolveTarget('linux', 'arm64'), /unsupported platform/u)
})

test('release and settings paths use the documented local roots', () => {
  const target = resolveTarget('win32', 'x64')
  assert.equal(
    releaseRoot({home: '/tmp/nova-no-such-home', target}),
    join('/tmp/nova-no-such-home', '.nova-personal-agent', 'cli', 'releases', '1.0.0', 'win32-x64'),
  )
  assert.equal(
    desktopSettingsPath({platform: 'linux', home: '/tmp/nova-no-such-home', environment: {}}),
    join('/tmp/nova-no-such-home', '.config', 'Nova Personal Agent', 'ambient-orb-settings.json'),
  )
  assert.equal(releaseBaseUrl(), 'https://github.com/deepnovacore/NovaPersonalAgent/releases/download/v1.0.0')
})

function temporaryHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'nova-cli-target-'))
  t.after(() => rmSync(home, {recursive: true, force: true}))
  return home
}

test('the CLI installs into the new root, reads the legacy root before migration, and honours explicit paths', async t => {
  const target = resolveTarget('darwin', 'arm64')
  const home = temporaryHome(t)
  const releases = join(home, '.nova-personal-agent', 'cli', 'releases', '1.0.0', 'darwin-arm64')
  assert.equal(releaseRoot({home, target}), releases)
  mkdirSync(join(home, '.nova-audio-agent'))
  writeFileSync(join(home, '.nova-audio-agent', 'blackboard.sqlite.personal.json'), '{}')
  // Installs always go to the new root, so the desktop never runs from the legacy root it has to move.
  assert.equal(releaseRoot({home, target}), releases)
  assert.equal(defaultDataPath('blackboard.sqlite', home), '~/.nova-audio-agent/blackboard.sqlite')
  const reset = await resetPersonalState({home, environment: {}, renameFile: async () => {}})
  assert.equal(reset.statePath, join(home, '.nova-audio-agent', 'blackboard.sqlite.personal.json'))
  const explicit = await resetPersonalState({home, environment: {BLACKBOARD_PATH: join(home, 'custom', 'board.sqlite')}, renameFile: async () => {}})
  assert.equal(explicit.statePath, join(home, 'custom', 'board.sqlite.personal.json'))
})

test('a pending data-root migration makes every CLI path refuse without creating files', async t => {
  const target = resolveTarget('darwin', 'arm64')
  const home = temporaryHome(t)
  mkdirSync(join(home, '.nova-audio-agent'))
  mkdirSync(join(home, '.nova-personal-agent'))
  writeFileSync(join(home, '.nova-personal-agent', '.data-root-migration.journal.json'), '{}')
  assert.throws(() => releaseRoot({home, target}), {code: 'data_root_migration_pending'})
  assert.throws(() => defaultDataPath('blackboard.sqlite', home), {code: 'data_root_migration_pending'})
  await assert.rejects(resetPersonalState({home, environment: {}, renameFile: async () => assert.fail('renamed')}), {code: 'data_root_migration_pending'})
  assert.equal(existsSync(join(home, '.nova-personal-agent', 'cli')), false)
})

test('desktop settings use the source profile when only it has settings, as before the identity change', t => {
  const home = temporaryHome(t)
  const appData = join(home, 'Library', 'Application Support')
  const source = join(appData, '@nova-audio-agent/ambient-orb', 'ambient-orb-settings.json')
  mkdirSync(dirname(source), {recursive: true})
  writeFileSync(source, '{}')
  assert.equal(desktopSettingsPath({platform: 'darwin', home, environment: {}}), source)
  const legacy = join(appData, 'Nova Audio Agent Ambient Orb', 'ambient-orb-settings.json')
  mkdirSync(dirname(legacy), {recursive: true})
  writeFileSync(legacy, '{}')
  assert.equal(desktopSettingsPath({platform: 'darwin', home, environment: {}}), legacy)
})

test('desktop settings follow a new-identity profile, else an existing legacy profile in place', t => {
  const home = temporaryHome(t)
  const appData = join(home, 'Library', 'Application Support')
  const current = join(appData, 'Nova Personal Agent', 'ambient-orb-settings.json')
  const legacy = join(appData, 'Nova Audio Agent Ambient Orb', 'ambient-orb-settings.json')
  assert.equal(desktopSettingsPath({platform: 'darwin', home, environment: {}}), current)
  mkdirSync(dirname(legacy), {recursive: true})
  writeFileSync(legacy, '{}')
  assert.equal(desktopSettingsPath({platform: 'darwin', home, environment: {}}), legacy)
  mkdirSync(dirname(current), {recursive: true})
  writeFileSync(join(dirname(current), 'ambient-orb-settings.json'), '{}')
  assert.equal(desktopSettingsPath({platform: 'darwin', home, environment: {}}), legacy, 'an existing legacy profile stays in use')
  writeFileSync(join(dirname(current), 'desktop-identity.json'), JSON.stringify({version: 1, safeStorageName: 'Nova Personal Agent'}))
  assert.equal(desktopSettingsPath({platform: 'darwin', home, environment: {}}), current)
})

test('start never migrates the data root: only the desktop main process does', async () => {
  // HOME is a throwaway directory (test/home-guard.mjs); a migrating CLI would turn this legacy root into a link.
  const legacy = join(homedir(), '.nova-audio-agent')
  mkdirSync(legacy, {recursive: true})
  writeFileSync(join(legacy, 'goals.md'), '# goals')
  const calls = []
  const code = await main(['start'], {
    stdout: {write() {}},
    ensure: async () => { calls.push('ensure'); return {executable: '/fixture/app'} },
    launch: async () => { calls.push('launch') },
  })
  assert.equal(code, 0)
  assert.deepEqual(calls, ['ensure', 'launch'])
  assert.equal(lstatSync(legacy).isDirectory(), true)
  assert.equal(existsSync(join(homedir(), '.nova-personal-agent', '.data-root-migrated.json')), false)
  rmSync(legacy, {recursive: true, force: true})
})

test('CLI tests run against a temporary home', () => {
  const inside = realpathSync(homedir()).startsWith(`${realpathSync(tmpdir())}/`) || realpathSync(homedir()).startsWith(`${realpathSync(tmpdir())}\\`)
  assert.equal(inside, true, homedir())
})

test('published package and release metadata use strict public allowlists', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const assets = JSON.parse(await readFile(new URL('../release-assets.json', import.meta.url), 'utf8'))
  assert.equal(packageJson.version, PRODUCT_VERSION)
  assert.equal(packageJson.name, 'nova-personal-agent')
  assert.equal(packageJson.bin.npa, './bin/novapersonal.mjs')
  assert.equal(packageJson.bin.novapersonal, packageJson.bin.npa)
  assert.equal(packageJson.bin.novaaudio, packageJson.bin.novapersonal)
  assert.deepEqual(packageJson.files, ['bin/', 'src/', 'release-assets.json', 'README.md', 'LICENSE'])
  const builder = await readFile(new URL('../../clients/desktop/electron-builder.yml', import.meta.url), 'utf8')
  const productName = builder.match(/^productName: (.+)$/mu)?.[1]
  assert.ok(productName, 'electron-builder productName')
  assert.equal(assets.targets['darwin-arm64'].executable, `${productName}.app/Contents/MacOS/${productName}`)
  assert.equal(assets.targets['win32-x64'].executable, `${productName}.exe`)
  assert.deepEqual(Object.keys(assets.targets).sort(), [
    'darwin-arm64', 'linux-x64', 'win32-x64',
  ])
  for (const [id, entry] of Object.entries(assets.targets)) {
    const {id: resolvedId, ...definition} = resolveTarget(...id.split('-'))
    assert.equal(resolvedId, id)
    assert.deepEqual(entry, definition)
  }
})

test('v0.4 targets use the new brand while published v0.3 downloads retain their filenames', () => {
  assert.equal(resolveTarget('darwin', 'arm64', '0.3.1').artifact, 'nova-audio-agent-0.3.1-macos-arm64-app.zip')
  assert.equal(releaseBaseUrl('0.3.1'), 'https://github.com/deepnovacore/NovaPersonalAgent/releases/download/v0.3.1')
  assert.equal(resolveTarget('darwin', 'arm64', '1.0.0').artifact, 'nova-personal-agent-1.0.0-macos-arm64-app.zip')
  assert.equal(resolveTarget('win32', 'x64', '1.0.0-preview.1').executable, 'Nova Personal Agent.exe')
  assert.equal(resolveTarget('win32', 'x64', '0.4.1').executable, 'Nova Personal Agent Desktop.exe')
  assert.equal(resolveTarget('darwin', 'arm64', '0.4.1').executable, 'Nova Personal Agent Desktop.app/Contents/MacOS/Nova Personal Agent Desktop')
  assert.equal(resolveTarget('linux', 'x64', '1.0.0').artifact, 'nova-personal-agent-1.0.0-linux-x64.AppImage')
  assert.equal(releaseBaseUrl('1.0.0'), 'https://github.com/deepnovacore/NovaPersonalAgent/releases/download/v1.0.0')
})
