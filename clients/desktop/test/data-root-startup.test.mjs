import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import {join, relative} from 'node:path'
import {tmpdir} from 'node:os'
import {DATA_ROOT_JOURNAL, DATA_ROOT_MARKER, defaultDataPath, resolveDataRoot} from '../src/main/data-root.mjs'
import {checkDataRootStartup, legacyDataRootNotice} from '../src/main/local-data.mjs'

function home(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'nova-data-root-startup-')))
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}))
  return directory
}

function tree(root) {
  const entries = {}
  if (!fs.existsSync(root)) return entries
  const visit = directory => {
    for (const name of fs.readdirSync(directory).sort()) {
      const path = join(directory, name), stats = fs.lstatSync(path)
      if (stats.isDirectory()) { entries[`${relative(root, path)}/`] = 'dir'; visit(path) }
      else entries[relative(root, path)] = stats.isSymbolicLink() ? `link:${fs.readlinkSync(path)}` : fs.readFileSync(path).toString('base64')
    }
  }
  visit(root)
  return entries
}

test('startup never moves anything: an existing user keeps resolving the legacy root', t => {
  const directory = home(t)
  const legacy = join(directory, '.nova-audio-agent')
  fs.mkdirSync(join(legacy, 'conversations'), {recursive: true})
  fs.writeFileSync(join(legacy, 'blackboard.sqlite.personal.json'), '{}')
  const before = tree(directory)
  for (let launch = 0; launch < 3; launch += 1) {
    assert.deepEqual(checkDataRootStartup({home: directory}), {ok: true, root: legacy, legacy: true})
    assert.equal(defaultDataPath('blackboard.sqlite', directory), '~/.nova-audio-agent/blackboard.sqlite')
  }
  assert.deepEqual(legacyDataRootNotice({home: directory}), {kind: 'legacy', path: '~/.nova-audio-agent', command: 'npa migrate-data'})
  assert.deepEqual(tree(directory), before)
  assert.equal(fs.existsSync(join(directory, '.nova-personal-agent')), false)
})

test('startup resolves the new root on a fresh install or after migration, with no notice', t => {
  const fresh = home(t)
  assert.deepEqual(checkDataRootStartup({home: fresh}), {ok: true, root: join(fresh, '.nova-personal-agent'), legacy: false})
  assert.equal(legacyDataRootNotice({home: fresh}), null)
  assert.equal(fs.existsSync(join(fresh, '.nova-audio-agent')), false)

  const migrated = home(t)
  fs.mkdirSync(join(migrated, '.nova-personal-agent'))
  fs.writeFileSync(join(migrated, '.nova-personal-agent', DATA_ROOT_MARKER), '{}')
  fs.symlinkSync(join(migrated, '.nova-personal-agent'), join(migrated, '.nova-audio-agent'), 'dir')
  assert.deepEqual(checkDataRootStartup({home: migrated}), {ok: true, root: join(migrated, '.nova-personal-agent'), legacy: false})
  assert.equal(legacyDataRootNotice({home: migrated}), null)
})

test('a legacy root that is a link the user created resolves in place and is never treated as fresh', t => {
  const directory = home(t)
  const elsewhere = join(directory, 'external-disk')
  fs.mkdirSync(elsewhere)
  fs.symlinkSync(elsewhere, join(directory, '.nova-audio-agent'), 'dir')
  assert.deepEqual(resolveDataRoot(directory), {root: join(directory, '.nova-audio-agent'), legacy: true})
  assert.equal(checkDataRootStartup({home: directory}).legacy, true)
})

test('a pending migration journal stops startup before any backend path is resolved', t => {
  const directory = home(t)
  fs.mkdirSync(join(directory, '.nova-audio-agent'))
  fs.mkdirSync(join(directory, '.nova-personal-agent'))
  fs.writeFileSync(join(directory, '.nova-personal-agent', DATA_ROOT_JOURNAL), '{}')
  const before = tree(directory)
  assert.deepEqual(checkDataRootStartup({home: directory}), {
    ok: false,
    root: join(directory, '.nova-personal-agent'),
    legacyRoot: join(directory, '.nova-audio-agent'),
    journal: join(directory, '.nova-personal-agent', DATA_ROOT_JOURNAL),
  })
  assert.throws(() => defaultDataPath('blackboard.sqlite', directory), {code: 'data_root_migration_pending'})
  assert.deepEqual(tree(directory), before)
})

test('the journal wins over the marker, a held migrator lock stops startup, and a broken link is reported', t => {
  const directory = home(t)
  const root = join(directory, '.nova-personal-agent'), legacy = join(directory, '.nova-audio-agent')
  fs.mkdirSync(root)
  fs.writeFileSync(join(root, DATA_ROOT_MARKER), '{}')
  // Migrated, but the compatibility link is missing: still the new root, with a repair notice.
  assert.deepEqual(checkDataRootStartup({home: directory}), {ok: true, root, legacy: false, linkBroken: true})
  assert.deepEqual(legacyDataRootNotice({home: directory}), {kind: 'link', path: '~/.nova-audio-agent', command: 'npa migrate-data'})
  fs.symlinkSync(join(directory, 'elsewhere'), legacy, 'dir')
  assert.equal(checkDataRootStartup({home: directory}).linkBroken, true, 'a link elsewhere is broken too')
  fs.unlinkSync(legacy)
  fs.symlinkSync(root, legacy, 'dir')
  assert.deepEqual(checkDataRootStartup({home: directory}), {ok: true, root, legacy: false})

  fs.writeFileSync(join(root, DATA_ROOT_JOURNAL), '{}')
  assert.equal(checkDataRootStartup({home: directory}).ok, false, 'a journal wins over the marker')
  fs.unlinkSync(join(root, DATA_ROOT_JOURNAL))

  const lock = join(directory, '.nova-personal-agent.migration.lock')
  fs.writeFileSync(lock, JSON.stringify({pid: process.pid, token: 't'}))
  assert.deepEqual(checkDataRootStartup({home: directory}), {ok: false, root, legacyRoot: legacy, journal: join(root, DATA_ROOT_JOURNAL), lock})
  assert.equal(legacyDataRootNotice({home: directory}), null)
})
