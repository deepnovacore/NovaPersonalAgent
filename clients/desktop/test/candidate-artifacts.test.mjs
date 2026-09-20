import assert from 'node:assert/strict'
import {mkdtemp, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import test from 'node:test'
import {verifyCandidateArtifacts} from '../scripts/verify-candidate-artifacts.mjs'

test('candidate assets require exact names and matching checksums', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-candidate-'))
  const name = 'nova-audio-agent-0.2.0-macos-arm64-app.zip'
  try {
    for (const suffix of ['macos-arm64-app.zip', 'macos-arm64.dmg', 'windows-x64-portable.zip', 'windows-x64.exe']) {
      const file = `nova-audio-agent-0.2.0-${suffix}`
      await writeFile(join(root, file), 'candidate')
      await writeFile(join(root, `${file}.sha256`), `${createHash('sha256').update('candidate').digest('hex')}  ${file}\n`)
    }
    await verifyCandidateArtifacts(root, '0.2.0')
    await writeFile(join(root, name), 'corrupted')
    await assert.rejects(verifyCandidateArtifacts(root, '0.2.0'), /checksum/)
    await writeFile(join(root, name), 'candidate')
    await writeFile(join(root, 'unexpected.exe'), 'extra')
    await assert.rejects(verifyCandidateArtifacts(root, '0.2.0'), /names/)
    await assert.rejects(verifyCandidateArtifacts(root, '0.1.1'), /names/)
  } finally { await rm(root, {recursive: true, force: true}) }
})
