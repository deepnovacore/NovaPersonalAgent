import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {test} from 'node:test'

import {
  desktopSettingsPath,
  PRODUCT_VERSION,
  releaseBaseUrl,
  releaseRoot,
  resolveTarget,
} from '../src/target.mjs'

test('public version and target matrix are stable', () => {
  assert.equal(PRODUCT_VERSION, '0.4.0')
  assert.equal(resolveTarget('darwin', 'arm64').artifact, 'nova-personal-agent-0.4.0-macos-arm64-app.zip')
  assert.equal(resolveTarget('win32', 'x64').executable, 'Nova Personal Agent Desktop.exe')
  assert.throws(() => resolveTarget('darwin', 'x64'), /unsupported platform/u)
  assert.equal(resolveTarget('linux', 'x64').archive, 'file')
  assert.equal(resolveTarget('linux', 'x64').artifact, 'nova-personal-agent-0.4.0-linux-x64.AppImage')
  assert.throws(() => resolveTarget('linux', 'arm64'), /unsupported platform/u)
})

test('release and settings paths use the documented local roots', () => {
  const target = resolveTarget('win32', 'x64')
  assert.equal(
    releaseRoot({home: '/tmp/home', target}),
    join('/tmp/home', '.nova-audio-agent', 'cli', 'releases', '0.4.0', 'win32-x64'),
  )
  assert.equal(
    desktopSettingsPath({platform: 'linux', home: '/tmp/home', environment: {}}),
    join('/tmp/home', '.config', 'Nova Audio Agent Ambient Orb', 'ambient-orb-settings.json'),
  )
  assert.equal(releaseBaseUrl(), 'https://github.com/deepnovacore/NovaAudioAgent/releases/download/v0.4.0')
})

test('published package and release metadata use strict public allowlists', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const assets = JSON.parse(await readFile(new URL('../release-assets.json', import.meta.url), 'utf8'))
  assert.equal(packageJson.version, PRODUCT_VERSION)
  assert.equal(packageJson.name, 'nova-personal-agent')
  assert.equal(packageJson.bin.novapersonal, './bin/novapersonal.mjs')
  assert.equal(packageJson.bin.novaaudio, packageJson.bin.novapersonal)
  assert.deepEqual(packageJson.files, ['bin/', 'src/', 'release-assets.json', 'README.md', 'LICENSE'])
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
  assert.equal(releaseBaseUrl('0.3.1'), 'https://github.com/deepnovacore/NovaAudioAgent/releases/download/v0.3.1')
  assert.equal(resolveTarget('darwin', 'arm64', '0.4.0').artifact, 'nova-personal-agent-0.4.0-macos-arm64-app.zip')
  assert.equal(resolveTarget('win32', 'x64', '0.4.0-preview.1').executable, 'Nova Personal Agent Desktop.exe')
  assert.equal(resolveTarget('linux', 'x64', '0.4.0').artifact, 'nova-personal-agent-0.4.0-linux-x64.AppImage')
  assert.equal(releaseBaseUrl('0.4.0'), 'https://github.com/deepnovacore/NovaAudioAgent/releases/download/v0.4.0')
})
