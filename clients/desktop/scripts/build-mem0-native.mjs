import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdir, rename, stat} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname, resolve} from 'node:path'
import {rebuild} from '@electron/rebuild'

// bindings already supports ABI-specific directories; keep Node tests and Electron compatible.
export async function buildMem0Native() {
  const require = createRequire(import.meta.url)
  const runtimeRoot = resolve(import.meta.dirname, '../../../runtime')
  const runtimeRequire = createRequire(resolve(runtimeRoot, 'package.json'))
  const root = dirname(runtimeRequire.resolve('better-sqlite3/package.json'))
  const electron = require('electron')
  const probe = spawnSync(electron, ['-p', 'JSON.stringify({abi:process.versions.modules,version:process.versions.electron})'], {
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, encoding: 'utf8',
  })
  assert.equal(probe.status, 0, probe.stderr)
  const {abi, version} = JSON.parse(probe.stdout.trim())
  const binding = value => resolve(root, `lib/binding/node-v${value}-${process.platform}-${process.arch}/better_sqlite3.node`)
  const release = resolve(root, 'build/Release/better_sqlite3.node')
  // npm installs the host Node binary. Validate its ABI before moving it.
  try {
    await stat(release)
    const check = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', release], {encoding: 'utf8'})
    const destination = binding(check.status === 0 ? process.versions.modules : abi)
    if (check.status !== 0) {
      const electronCheck = spawnSync(electron, ['-e', 'require(process.argv[1])', release], {
        env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, encoding: 'utf8',
      })
      assert.equal(electronCheck.status, 0, electronCheck.stderr)
    }
    await mkdir(dirname(destination), {recursive: true})
    await rename(release, destination)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  try { await stat(binding(abi)); return } catch (error) { if (error.code !== 'ENOENT') throw error }
  await rebuild({buildPath: runtimeRoot, electronVersion: version, onlyModules: ['better-sqlite3'], force: true})
  await mkdir(dirname(binding(abi)), {recursive: true})
  await rename(release, binding(abi))
}
