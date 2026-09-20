import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {readFile, readdir} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

export async function verifyCandidateArtifacts(root, version) {
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/u)
  const names = ['macos-arm64-app.zip', 'macos-arm64.dmg', 'windows-x64-portable.zip', 'windows-x64.exe']
    .map(suffix => `nova-audio-agent-${version}-${suffix}`)
  assert.deepEqual((await readdir(root)).sort(), names.flatMap(name => [name, `${name}.sha256`]).sort(), 'candidate asset names mismatch')
  for (const name of names) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join(root, name))) hash.update(chunk)
    const checksum = (await readFile(join(root, `${name}.sha256`), 'utf8')).trim()
    assert.equal(checksum, `${hash.digest('hex')}  ${name}`, `${name} checksum mismatch`)
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await verifyCandidateArtifacts(process.argv[2], process.env.RELEASE_VERSION)
}
