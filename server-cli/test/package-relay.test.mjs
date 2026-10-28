import assert from 'node:assert/strict'
import {test} from 'node:test'
import {cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {bundleServerRelay} from '../../scripts/pack-server.mjs'

const repository = resolve(import.meta.dirname, '../..')
test('packed server installs its private relay without consulting a registry and resolves its crypto exports', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'nova-server-relay-package-'))
  const run = (args, cwd = root) => {
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd, encoding: 'utf8', env: {...process.env, npm_config_cache: join(root, 'npm-cache')}, shell: process.platform === 'win32',
    })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    return result.stdout
  }
  try {
    const source = join(root, 'source'), stage = join(root, 'stage'), install = join(root, 'installed')
    const relay = JSON.parse(await readFile(join(repository, 'relay/package.json'), 'utf8'))
    await mkdir(join(source, 'relay/dist/src'), {recursive: true})
    await writeFile(join(source, 'relay/package.json'), JSON.stringify(relay))
    const dist = process.env.NOVA_TEST_RELAY_DIST ?? join(root, 'relay-build')
    if (!process.env.NOVA_TEST_RELAY_DIST) {
      const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc')
      const built = spawnSync(process.execPath, [compiler, '-p', join(repository, 'relay/tsconfig.json'),
        '--noEmit', 'false', '--outDir', dist, '--tsBuildInfoFile', join(root, 'relay.tsbuildinfo'),
        '--declaration', 'false', '--declarationMap', 'false', '--sourceMap', 'false'], {encoding: 'utf8'})
      assert.equal(built.status, 0, built.stdout + built.stderr || built.error?.message)
    }
    await cp(join(dist, 'src'), join(source, 'relay/dist/src'), {recursive: true})
    await writeFile(join(source, 'relay/dist/src/private.env'), 'must-not-package')
    await writeFile(join(source, 'relay/dist/src/client.js.map'), 'must-not-package')
    await mkdir(stage)
    const dependencies = {[relay.name]: relay.version, ...relay.dependencies}
    const bundled = await bundleServerRelay({root: source, stage, dependencies})
    // Bundle installed public dependencies solely to keep this regression offline.
    for (const name of Object.keys(relay.dependencies)) await cp(join(repository, 'node_modules', name), join(stage, 'node_modules', name), {recursive: true, dereference: true})
    await writeFile(join(stage, 'package.json'), JSON.stringify({name: 'nova-server-package-regression', version: '1.0.0', type: 'module', dependencies,
      bundleDependencies: [...bundled, ...Object.keys(relay.dependencies)]}))
    await writeFile(join(stage, 'probe.mjs'), `import assert from 'node:assert/strict';\nimport {RelayClient} from '@nova-personal-agent/relay';\nimport {generateContentKey,encryptBody,decryptBody} from '@nova-personal-agent/relay/crypto';\nassert.equal(typeof RelayClient,'function');const key=generateContentKey();assert.deepEqual(await decryptBody(await encryptBody({installed:true},key),key),{installed:true});\n`)
    const [{filename, files}] = JSON.parse(run(['pack', stage, '--ignore-scripts', '--pack-destination', root, '--json']))
    assert.ok(files.some(file => file.path === 'node_modules/@nova-personal-agent/relay/dist/src/client.js'))
    assert.ok(!files.some(file => /private\.env|client\.js\.map/u.test(file.path)))
    run(['install', '--prefix', install, join(root, filename), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--registry=http://127.0.0.1:1'])
    const installed = join(install, 'node_modules/nova-server-package-regression')
    const result = spawnSync(process.execPath, [join(installed, 'probe.mjs')], {cwd: install, encoding: 'utf8'})
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    assert.match(await realpath(join(installed, 'node_modules/@nova-personal-agent/relay')), /installed/u)
  } finally { await rm(root, {recursive: true, force: true}) }
})
