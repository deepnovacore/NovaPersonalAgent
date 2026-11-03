import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createRequire} from 'node:module'
import {cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {prepareVoiceMemSdk} from './prepare-voicemem-sdk.mjs'

test('prepare-voicemem-sdk: pristine exact preimage, fresh copy, provenance and fail-closed integrity', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-package-'))
  const original = resolve(dirname(createRequire(import.meta.url).resolve('voicemem')), '../..')
  const source = join(root, 'pristine'), output = join(root, 'generated')
  try {
    cpSync(original, source, {recursive: true})
    const before = readFileSync(join(source, 'dist/src/memory.js'), 'utf8')
    prepareVoiceMemSdk({source, output})
    assert.equal(readFileSync(join(source, 'dist/src/memory.js'), 'utf8'), before, 'source dependency is immutable')
    assert.match(readFileSync(join(output, 'memory.js'), 'utf8'), /groundedStyleCandidates/u)
    for (const name of ['LICENSE', 'NOTICE.md', 'PATCH-NOTICE.md']) assert.ok(readFileSync(join(output, name)).length)
    assert.throws(() => prepareVoiceMemSdk({source, output}), /not_fresh_owned/u)
    assert.throws(() => prepareVoiceMemSdk({source, output: join(root, 'node_modules/voicemem')}), /not_fresh_owned/u)
    symlinkSync(root, join(root, 'linked'))
    assert.throws(() => prepareVoiceMemSdk({source, output: join(root, 'linked/copy')}), /symlink/u)
    writeFileSync(join(source, 'dist/src/memory.js'), before + '\n')
    assert.throws(() => prepareVoiceMemSdk({source, output: join(root, 'tampered')}), /preimage_integrity/u)
    writeFileSync(join(source, 'dist/src/memory.js'), before)
    writeFileSync(join(source, 'extra.js'), '')
    assert.throws(() => prepareVoiceMemSdk({source, output: join(root, 'extra')}), /preimage_file_set/u)
  } finally { rmSync(root, {recursive: true, force: true}) }
})

test('prepare-voicemem-sdk: production and isolated packaging retain SDK code and notices', () => {
  const runtime = resolve(import.meta.dirname, '..'), repo = resolve(runtime, '..')
  const manifest = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts.postbuild, 'node scripts/prepare-voicemem-sdk.mjs')
  assert.ok(manifest.files.includes('dist/src'))
  assert.match(readFileSync(join(runtime, 'scripts/test-isolated.mjs'), 'utf8'), /prepare-voicemem-sdk\.mjs/u)
  const desktop = readFileSync(join(repo, 'clients/desktop/electron-builder.yml'), 'utf8')
  for (const name of ['LICENSE', 'NOTICE.md', 'PATCH-NOTICE.md']) assert.ok(desktop.includes(`voicemem-sdk/${name}`))
  assert.match(readFileSync(join(repo, 'scripts/pack-server.mjs'), 'utf8'), /voicemem-sdk\/\$\{name\}/u)
})
