import assert from 'node:assert/strict'
import {cp, readFile, readdir, writeFile} from 'node:fs/promises'
import {resolve, join} from 'node:path'

// A narrowly scoped npm patch: reuse the accepted 0.4.0 payload, changing only
// repository links and npm package metadata. Desktop assets stay on v0.4.0.
const [previous, candidate] = process.argv.slice(2).map(path => resolve(path))
assert.ok(previous && candidate && previous !== candidate)
const manifest = JSON.parse(await readFile(join(previous, 'package.json'), 'utf8'))
assert.ok(['nova-personal-agent', 'nova-audio-agent', 'nova-personal-agent-server'].includes(manifest.name))
assert.equal(manifest.version, '0.4.0')
const desktop = manifest.name !== 'nova-personal-agent-server'
const rename = text => text.replaceAll('deepnovacore/NovaAudioAgent', 'deepnovacore/NovaPersonalAgent')
  .replaceAll('deepnovacore.github.io/NovaAudioAgent/', 'deepnovacore.github.io/NovaPersonalAgent/')
await cp(previous, candidate, {recursive: true, errorOnExist: true, force: false})
const allowed = new Set(['package.json', 'README.md', ...(desktop ? ['src/target.mjs', 'release-assets.json'] : [])])
for (const name of allowed) {
  const original = await readFile(join(previous, name), 'utf8')
  let updated = rename(original)
  if (name === 'package.json') {
    const pkg = JSON.parse(updated)
    pkg.version = '0.4.1'
    updated = JSON.stringify(pkg, null, 2) + '\n'
  }
  if (name === 'src/target.mjs') {
    const legacyLine = "  const repository = /^0\\.[0-3]\\./u.test(version) ? 'deepnovacore/NovaPersonalAgent' : RELEASE_REPOSITORY\n"
    assert.ok(updated.includes(legacyLine), 'Unexpected 0.4.0 repository selector')
    updated = updated.replace(legacyLine, '').replace('${repository}/releases/download', '${RELEASE_REPOSITORY}/releases/download')
  }
  if (name !== 'package.json') {
    const source = resolve(desktop ? 'cli' : 'server-cli', name)
    assert.equal(updated, await readFile(source, 'utf8'), `Source includes changes beyond the repository rename: ${name}`)
  }
  await writeFile(join(candidate, name), updated)
}
async function files(root) {
  return (await readdir(root, {recursive: true, withFileTypes: true}))
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(root.length + 1)).sort()
}
assert.deepEqual(await files(candidate), await files(previous))
let unchanged = 0
for (const name of await files(previous)) {
  if (allowed.has(name)) continue
  assert.deepEqual(await readFile(join(candidate, name)), await readFile(join(previous, name)), `Payload changed: ${name}`)
  unchanged++
}
console.log(`${manifest.name}: audited repository-only 0.4.1 patch; ${unchanged} payload files unchanged`)
