import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {loadExperience} from '../lib/experience-assets.mjs'
import {packExperience} from '../pack-experience.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'novacore-experience-'))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  const source = join(root, 'source')
  mkdirSync(source)
  const persona = {id: 'sample', name: 'Sample Person', occupation: 'Designer', sha256: {}}
  for (const key of ['profile', 'sources', 'memory', 'snapshot', 'avatar']) {
    persona[key] = `sample.${key}.${key === 'avatar' ? 'png' : 'json'}`
    const bytes = Buffer.from(key === 'avatar' ? 'sample image' : JSON.stringify({kind: key}))
    persona.sha256[key] = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(join(source, persona[key]), bytes)
  }
  const manifest = {version: 1, personas: [persona]}
  const save = () => writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest))
  save()
  return {root, source, manifest, persona, save}
}

test('optional empty experience and complete private staging preserve bytes', t => {
  const {root, source, manifest} = fixture(t)
  assert.equal(loadExperience(join(root, 'missing')), null)
  assert.throws(() => loadExperience(join(root, 'missing'), {required: true}), /invalid experience bundle/)
  const loaded = loadExperience(source)
  assert.deepEqual(loaded.manifest, manifest)
  const output = join(root, 'staged')
  packExperience(source, output)
  assert.deepEqual(loadExperience(join(output, 'experience')).manifest, manifest)
  for (const key of ['profile', 'sources', 'memory', 'snapshot', 'avatar']) {
    assert.deepEqual(loaded.files.get('sample')[key], readFileSync(join(output, 'experience', manifest.personas[0][key])))
  }
  assert.throws(() => packExperience(source, output), /output already exists/)
  assert.throws(() => packExperience(source, join(source, 'nested')), /independent/)
})

test('hash, missing file, manifest schema, traversal and symlinks fail closed before staging', t => {
  const {root, source, persona, manifest, save} = fixture(t)
  const output = join(root, 'staged')
  const original = persona.profile
  for (const invalid of ['../outside.json', '/tmp/outside.json', 'sub/file.json', '.', 'manifest.json']) {
    persona.profile = invalid; save()
    assert.throws(() => packExperience(source, output))
    assert.equal(existsSync(output), false)
  }
  persona.profile = original; save()
  writeFileSync(join(source, original), '{}')
  assert.throws(() => loadExperience(source), /invalid experience bundle/)
  rmSync(join(source, original))
  assert.throws(() => loadExperience(source), /invalid experience bundle/)
  symlinkSync(join(source, persona.sources), join(source, original))
  assert.throws(() => loadExperience(source), /invalid experience bundle/)
  manifest.version = 2; save()
  assert.throws(() => loadExperience(source), /invalid experience bundle/)
})

test('persona IDs share the 64-character client limit through loading and packing', t => {
  const {root, source, persona, save} = fixture(t)
  persona.id = 'a'.repeat(64)
  save()
  assert.ok(loadExperience(source).files.has(persona.id))
  const output = join(root, 'valid-staged')
  packExperience(source, output)
  assert.ok(loadExperience(join(output, 'experience')).files.has(persona.id))
  persona.id = 'a'.repeat(65)
  save()
  assert.throws(() => loadExperience(source), /invalid experience bundle/)
  const rejected = join(root, 'invalid-staged')
  assert.throws(() => packExperience(source, rejected), /invalid experience bundle/)
  assert.equal(existsSync(rejected), false)
})

test('ordinary packages without a manifest load as null while explicit packing requires assets', t => {
  const {root} = fixture(t)
  const empty = join(root, 'empty')
  mkdirSync(empty)
  assert.equal(loadExperience(empty), null)
  assert.equal(loadExperience(empty, {required: false}), null)
  const output = join(root, 'empty-staged')
  assert.throws(() => packExperience(empty, output), /invalid experience bundle/)
  assert.equal(existsSync(output), false)
})
