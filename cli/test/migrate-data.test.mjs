import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import {spawn} from 'node:child_process'
import {join, relative, resolve, sep} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {main} from '../src/command.mjs'
import {acquireMigrationLock, DATA_ROOT_JOURNAL, DATA_ROOT_MARKER, dataRootLocksHeld, defaultDataPath, mapLegacyDataPath, resolveDataRoot} from '../src/data-root.mjs'
import {resetPersonalState} from '../src/runtime.mjs'
import {migrateData, migrationBlockers, novaProcesses} from '../src/migrate-data.mjs'

function home(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'nova-migrate-data-')))
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}))
  return directory
}

/** Paths are interpolated into patterns verbatim: Windows separators and dots must not act as regex syntax. */
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

function write(path, content) {
  fs.mkdirSync(join(path, '..'), {recursive: true})
  fs.writeFileSync(path, content)
}

function tree(root) {
  const entries = {}
  if (!fs.existsSync(root)) return entries
  const visit = directory => {
    for (const name of fs.readdirSync(directory).sort()) {
      const path = join(directory, name), stats = fs.lstatSync(path)
      const key = relative(root, path).split(sep).join('/')
      if (stats.isSymbolicLink()) entries[key] = `link:${fs.readlinkSync(path)}`
      else if (stats.isDirectory()) { entries[`${key}/`] = 'dir'; visit(path) }
      else entries[key] = fs.readFileSync(path).toString('base64')
    }
  }
  visit(root)
  return entries
}

function fixture(t) {
  const directory = home(t)
  const legacy = join(directory, '.nova-audio-agent'), root = join(directory, '.nova-personal-agent')
  write(join(legacy, 'blackboard.sqlite.personal.json'), '{"goals":[1]}')
  write(join(legacy, 'goals.md'), '# goals')
  write(join(legacy, 'workspace-graph.sqlite'), 'ledger')
  write(join(legacy, 'workspace-graph.sqlite-wal'), 'ledger wal')
  write(join(legacy, 'workspace-graph.sqlite.memory', 'notes', 'one.md'), 'remembered')
  write(join(legacy, 'workspaces', 'default', 'notes.txt'), 'notes')
  write(join(legacy, 'skills', 'mine', 'SKILL.md'), 'mine')
  write(join(legacy, 'skills', 'computer-use', 'SKILL.md'), 'same skill')
  fs.mkdirSync(join(legacy, 'conversations'), {recursive: true})
  const database = new DatabaseSync(join(legacy, 'conversations', 'one.sqlite'))
  database.exec('CREATE TABLE turns(text TEXT); INSERT INTO turns VALUES (\'hello\')')
  database.close()
  // The new root already exists: skills-dir.mjs seeded it.
  write(join(root, 'skills', 'computer-use', 'SKILL.md'), 'same skill')
  write(join(root, 'skills', 'seeded', 'SKILL.md'), 'seeded')
  return {directory, legacy, root}
}

const fixedNow = () => new Date('2026-11-22T10:00:00.000Z')
const BACKUP = '.conflict-2026-11-22T10-00-00-000Z'

function run(directory, options = {}) {
  const output = []
  const code = migrateData({home: directory, platform: 'darwin', environment: {}, now: fixedNow, blockers: () => [], write: text => output.push(text), ...options})
  return {code, output: output.join('')}
}

function crashAfter(count) {
  let renames = 0, crashed = false
  return {...fs, renameSync: (from, to) => {
    if (String(to).endsWith(DATA_ROOT_JOURNAL) || String(to).endsWith(DATA_ROOT_MARKER)) return fs.renameSync(from, to)
    if (crashed || ++renames > count) { crashed = true; throw Object.assign(new Error('power loss'), {code: 'EIO'}) }
    return fs.renameSync(from, to)
  }}
}

test('the dry run prints the plan, sizes and effect and changes nothing', t => {
  const {directory, legacy, root} = fixture(t)
  const before = tree(directory)
  const {code, output} = run(directory, {dryRun: true})
  assert.equal(code, 0)
  assert.match(output, /Move \d+ entries \(.+\) from .*\.nova-audio-agent into .*\.nova-personal-agent/u)
  assert.match(output, new RegExp(`move    ${escapeRegExp(join(legacy, 'goals.md'))} -> ${escapeRegExp(join(root, 'goals.md'))} \\(7 B\\)`, 'u'))
  assert.match(output, /keep    .*computer-use[\\/]SKILL\.md as .*SKILL\.md\.conflict-/u)
  assert.match(output, /replace .*\.nova-audio-agent with a link/u)
  assert.match(output, /Dry run: nothing was changed\./u)
  assert.deepEqual(tree(directory), before)
  // Reported blockers do not change anything either.
  run(directory, {dryRun: true, blockers: () => ['a Nova desktop window owns x']})
  assert.deepEqual(tree(directory), before)
})

test('the move merges skills, moves every entry by rename, writes marker last and links the legacy root', t => {
  const {directory, legacy, root} = fixture(t)
  const before = tree(legacy)
  const inode = fs.statSync(join(legacy, 'conversations', 'one.sqlite')).ino
  const {code, output} = run(directory)
  assert.equal(code, 0, output)
  const after = tree(root)
  for (const [key, value] of Object.entries(before)) assert.equal(after[key], value, `${key} moved intact`)
  assert.equal(fs.statSync(join(root, 'conversations', 'one.sqlite')).ino, inode, 'renamed, not copied')
  assert.equal(after['skills/seeded/SKILL.md'], Buffer.from('seeded').toString('base64'))
  assert.equal(after[`skills/computer-use/SKILL.md${BACKUP}`], Buffer.from('same skill').toString('base64'))
  assert.equal(fs.existsSync(join(root, DATA_ROOT_MARKER)), true)
  assert.equal(fs.existsSync(join(root, DATA_ROOT_JOURNAL)), false)
  assert.equal(fs.realpathSync(legacy), root)
  assert.deepEqual(resolveDataRoot(directory), {root, legacy: false})
  assert.equal(fs.existsSync(join(directory, '.nova-personal-agent.migration.lock')), false)
  const reopened = new DatabaseSync(join(legacy, 'conversations', 'one.sqlite'))
  assert.deepEqual(reopened.prepare('SELECT text FROM turns').all().map(row => row.text), ['hello'])
  reopened.close()
  const snapshot = tree(root)
  assert.match(run(directory).output, /Already migrated/u)
  assert.deepEqual(tree(root), snapshot)
})

test('migrate-data refuses while a desktop, a runtime lock or a Nova process is present', {skip: process.platform === 'win32'}, async t => {
  const {directory, legacy} = fixture(t)
  const before = tree(directory)
  const blockers = processes => () => migrationBlockers({home: directory, platform: 'darwin', environment: {}, processes: () => processes})
  assert.deepEqual(blockers([])(), [])

  const profile = join(directory, 'Library', 'Application Support', 'Nova Audio Agent Ambient Orb')
  fs.mkdirSync(profile, {recursive: true})
  fs.symlinkSync(`host-${process.ppid}`, join(profile, 'SingletonLock'))
  let result = run(directory, {blockers: blockers([])})
  assert.equal(result.code, 1)
  assert.match(result.output, /desktop window owns/u)
  fs.unlinkSync(join(profile, 'SingletonLock'))

  result = run(directory, {blockers: blockers([{pid: 2 ** 30, ppid: 1, command: '/Applications/Nova Personal Agent.app/Contents/MacOS/Nova Personal Agent'}])})
  assert.match(result.output, /Nova process 1073741824 is running/u)
  assert.match(run(directory, {blockers: blockers(null)}).output, /process list could not be read/u)
  assert.deepEqual(novaProcesses([{pid: process.pid, ppid: 1, command: 'node novapersonal.mjs migrate-data'}]), [])

  // A memory repository lock deep inside a user workspace counts: no depth limit, no workspace exclusion.
  const lock = join(legacy, 'workspaces', 'default', 'project', 'ledger.sqlite.memory', '.nova-memory.lock')
  write(lock, JSON.stringify({pid: process.pid, token: 't'}))
  assert.match(run(directory, {blockers: blockers([])}).output, /holds a lock inside/u)
  write(lock, '')
  assert.equal(dataRootLocksHeld(legacy, {nativeLockHeld: () => true}), true, 'an unreadable lock counts as held')
  fs.rmSync(join(legacy, 'workspaces', 'default', 'project'), {recursive: true})

  // A runtime host holding its ownership database, and a natively locked project file held by another process.
  const owner = new DatabaseSync(join(legacy, 'blackboard.sqlite.personal.json.owner.sqlite'))
  owner.exec('BEGIN EXCLUSIVE')
  assert.equal(dataRootLocksHeld(legacy), true)
  owner.exec('ROLLBACK')
  owner.close()
  const projectLock = join(legacy, 'codex-projects-v1.owner.lock')
  write(projectLock, '')
  const holder = spawn(process.execPath, ['-e', "require('fs').openSync(process.argv[1],'r+');console.log('ready');setInterval(()=>{},1000)", projectLock])
  t.after(() => holder.kill())
  await new Promise(resolve => holder.stdout.once('data', resolve))
  assert.equal(dataRootLocksHeld(legacy), true)
  holder.kill()
  fs.rmSync(join(legacy, 'blackboard.sqlite.personal.json.owner.sqlite'))
  fs.rmSync(projectLock)
  fs.rmSync(join(directory, 'Library'), {recursive: true})
  assert.deepEqual(tree(directory), before)
})

test('a database group that is partial or present on both sides is refused before anything moves', t => {
  const cases = [
    ['a WAL without its database', ({legacy}) => write(join(legacy, 'orphan.sqlite-wal'), 'wal'), 'orphan.sqlite', 'sqlite_partial'],
    ['a stray WAL in the new root', ({root}) => write(join(root, 'workspace-graph.sqlite-wal'), 'foreign wal'), 'workspace-graph.sqlite-wal', 'sqlite_both'],
    ['an empty memory repository in the new root', ({root}) => fs.mkdirSync(join(root, 'workspace-graph.sqlite.memory')), 'workspace-graph.sqlite.memory', 'sqlite_both'],
    ['an identical main database file', ({legacy, root}) => write(join(root, 'conversations', 'one.sqlite'), fs.readFileSync(join(legacy, 'conversations', 'one.sqlite'))), join('conversations', 'one.sqlite'), 'sqlite_both'],
  ]
  for (const [label, arrange, name] of cases) {
    const paths = fixture(t)
    arrange(paths)
    const before = tree(paths.directory)
    const dry = run(paths.directory, {dryRun: true})
    assert.equal(dry.code, 1, label)
    assert.match(dry.output, new RegExp(`CONFLICT .*${escapeRegExp(name)}: .*database`, 'u'), label)
    const result = run(paths.directory)
    assert.equal(result.code, 1, label)
    assert.deepEqual(tree(paths.directory), before, `${label}: nothing moved`)
  }
})

test('an existing migrator lock is never taken over, even with a dead owner: the user is told to remove it', t => {
  const {directory, legacy} = fixture(t)
  const path = join(directory, '.nova-personal-agent.migration.lock')
  const before = tree(legacy)
  for (const content of ['', '{"pid":', 'garbage', JSON.stringify({pid: process.ppid, token: 'live'}), JSON.stringify({pid: 2 ** 30, token: 'dead'})]) {
    fs.writeFileSync(path, content)
    assert.equal(acquireMigrationLock(path), null)
    assert.equal(fs.readFileSync(path, 'utf8'), content, 'left exactly as found')
    const {code, output} = run(directory)
    assert.equal(code, 1)
    assert.ok(output.includes(path), output)
    assert.match(output, /owner pid (unknown|\d+)/u)
    assert.match(output, /delete that file/u)
    assert.deepEqual(tree(legacy), before)
  }
  assert.match(run(directory).output, /owner pid 1073741824/u)
  fs.unlinkSync(path)
  const lock = acquireMigrationLock(path)
  assert.ok(lock)
  assert.equal(acquireMigrationLock(path), null)
  assert.match(fs.readFileSync(path, 'utf8'), new RegExp(`"pid":${process.pid}`, 'u'))
  lock.release()
  assert.equal(fs.existsSync(path), false)
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('migration.lock')), [], 'no temporary files left')
})

test('a rollback that would overwrite keeps the journal, blocks startup and prints recovery steps', t => {
  const {directory, legacy, root} = fixture(t)
  const failing = {...fs, symlinkSync: (target, path, type) => {
    if (path === legacy) {
      // Something writes into the swapped-aside legacy directory, so undoing the goals.md move would overwrite it.
      fs.writeFileSync(join(`${legacy}.migrating-empty`, 'goals.md'), 'written meanwhile')
      throw Object.assign(new Error('injected'), {code: 'EPERM'})
    }
    return fs.symlinkSync(target, path, type)
  }}
  const {code, output} = run(directory, {fs: failing})
  assert.equal(code, 1)
  assert.match(output, /journal is kept/u)
  assert.ok(output.includes(`cannot move ${join(root, 'goals.md')} back to ${join(legacy, 'goals.md')}: both exist`), output)
  assert.match(output, /run `npa migrate-data` again/u)
  assert.equal(fs.existsSync(join(root, DATA_ROOT_JOURNAL)), true)
  assert.equal(fs.existsSync(join(root, DATA_ROOT_MARKER)), false)
  assert.equal(fs.readFileSync(join(legacy, 'goals.md'), 'utf8'), 'written meanwhile')
  assert.equal(fs.readFileSync(join(root, 'goals.md'), 'utf8'), '# goals')
  assert.throws(() => resolveDataRoot(directory), {code: 'data_root_migration_pending'})
  assert.throws(() => defaultDataPath('blackboard.sqlite', directory), {code: 'data_root_migration_pending'})
  // Still blocked on a rerun until the user resolves the duplicate.
  assert.equal(run(directory).code, 1)
  assert.equal(fs.existsSync(join(root, DATA_ROOT_JOURNAL)), true)
  fs.renameSync(join(legacy, 'goals.md'), join(directory, 'goals-meanwhile.md'))
  assert.equal(run(directory).code, 0)
  assert.equal(fs.readFileSync(join(root, 'goals.md'), 'utf8'), '# goals')
  assert.equal(fs.realpathSync(legacy), root)
})

test('a crash mid-move resumes from the journal on the next run without losing or duplicating data', t => {
  const {directory, legacy, root} = fixture(t)
  const before = tree(legacy)
  assert.equal(run(directory, {fs: crashAfter(3)}).code, 1)
  assert.equal(fs.existsSync(join(root, DATA_ROOT_JOURNAL)), true)
  assert.throws(() => resolveDataRoot(directory), {code: 'data_root_migration_pending'})
  assert.match(run(directory, {dryRun: true}).output, /interrupted migration is pending/u)
  const resumed = run(directory)
  assert.equal(resumed.code, 0, resumed.output)
  const after = tree(root)
  for (const [key, value] of Object.entries(before)) assert.equal(after[key], value, `${key} survived`)
  assert.equal(Object.keys(after).filter(key => key.includes('.conflict-')).length, 1, 'no duplicate backups')
  assert.equal(fs.realpathSync(legacy), root)
})

test('a failure before the link rolls every rename back exactly and removes the journal', t => {
  const {directory, legacy, root} = fixture(t)
  const legacyBefore = tree(legacy), rootBefore = tree(root)
  const noLink = {...fs, symlinkSync: (target, path, type) => {
    if (path === legacy) throw Object.assign(new Error('injected'), {code: 'EPERM'})
    return fs.symlinkSync(target, path, type)
  }}
  const {code, output} = run(directory, {fs: noLink})
  assert.equal(code, 1)
  assert.match(output, /Nothing was moved/u)
  assert.deepEqual(tree(legacy), legacyBefore)
  assert.deepEqual(tree(root), rootBefore)
  assert.deepEqual(resolveDataRoot(directory), {root: legacy, legacy: true})
})

test('a legacy root that is a link the user created is never migrated', t => {
  const directory = home(t)
  const elsewhere = join(directory, 'external-disk', 'nova')
  write(join(elsewhere, 'goals.md'), '# goals')
  fs.symlinkSync(elsewhere, join(directory, '.nova-audio-agent'), 'dir')
  const before = tree(directory)
  const {code, output} = run(directory)
  assert.equal(code, 0)
  assert.match(output, /link you created/u)
  assert.deepEqual(tree(directory), before)
  assert.deepEqual(resolveDataRoot(directory), {root: join(directory, '.nova-audio-agent'), legacy: true})
})

test('dry run previews the rewrite of a Space config that still lives in the legacy root', t => {
  const {directory, legacy, root} = fixture(t)
  const profile = join(directory, 'Library', 'Application Support', 'Nova Audio Agent Ambient Orb')
  const legacyConfig = join(legacy, 'space', 'config.json'), movedConfig = join(root, 'space', 'config.json')
  const settingsPath = join(profile, 'ambient-orb-settings.json')
  write(legacyConfig, JSON.stringify({v: 2, mode: 'host', data_mode: 'existing', space: 's', personal_path: join(legacy, 'blackboard.sqlite.personal.json'), members: []}))
  fs.chmodSync(legacyConfig, 0o600)
  write(settingsPath, JSON.stringify({version: 5, spaceHostConfigPath: legacyConfig}))
  fs.chmodSync(settingsPath, 0o600)
  const dry = run(directory, {dryRun: true})
  assert.match(dry.output, /update  .*space.config\.json: personal_path/u)
  assert.equal(fs.existsSync(movedConfig), false)
  assert.equal(JSON.parse(fs.readFileSync(legacyConfig, 'utf8')).personal_path, join(legacy, 'blackboard.sqlite.personal.json'))
  assert.equal(run(directory).code, 0)
  assert.equal(JSON.parse(fs.readFileSync(movedConfig, 'utf8')).personal_path, join(root, 'blackboard.sqlite.personal.json'))
})

test('settings and an existing-data Space config follow the move and match the runtime comparison', t => {
  const {directory, legacy, root} = fixture(t)
  const profile = join(directory, 'Library', 'Application Support', 'Nova Audio Agent Ambient Orb')
  const configPath = join(profile, 'space', 'config.json'), settingsPath = join(profile, 'ambient-orb-settings.json')
  write(configPath, JSON.stringify({v: 2, mode: 'host', data_mode: 'existing', space: 's', personal_path: join(legacy, 'blackboard.sqlite.personal.json'), members: []}))
  fs.chmodSync(configPath, 0o600)
  write(settingsPath, JSON.stringify({version: 5, spaceHostConfigPath: configPath, knowledgePath: join(legacy, 'kb', 'k.sqlite'), codexManagedRoot: '~/.nova-audio-agent/workspaces', codexWorkspace: join(directory, 'projects'), secrets: {a: {enc: 'safeStorage', data: 'c2VhbGVk'}}}))
  fs.chmodSync(settingsPath, 0o600)
  const dry = run(directory, {dryRun: true})
  assert.match(dry.output, /update  .*config\.json: personal_path/u)
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).personal_path, join(legacy, 'blackboard.sqlite.personal.json'))
  assert.equal(run(directory).code, 0)
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  // space-host/config.ts scopeHostSpaceSettings: resolve(expanded blackboard_path) + '.personal.json', compared literally.
  const blackboard = resolve(defaultDataPath('blackboard.sqlite', directory).replace(/^~(?=\/)/u, directory))
  assert.equal(config.personal_path, `${blackboard}.personal.json`)
  assert.equal(config.personal_path, join(root, 'blackboard.sqlite.personal.json'))
  assert.equal(fs.readFileSync(config.personal_path, 'utf8'), '{"goals":[1]}')
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  assert.deepEqual(settings, {version: 5, spaceHostConfigPath: configPath, knowledgePath: join(root, 'kb', 'k.sqlite'), codexManagedRoot: '~/.nova-personal-agent/workspaces', codexWorkspace: join(directory, 'projects'), secrets: {a: {enc: 'safeStorage', data: 'c2VhbGVk'}}})
  // Windows has no POSIX permission bits: stat reports 0o666/0o444 regardless of chmod.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600)
    assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600)
  }
})

test('npa routes migrate-data and its dry run, and rejects other arguments', async () => {
  const calls = []
  const stdout = {write() {}}
  assert.equal(await main(['migrate-data', '--dry-run'], {stdout, migrate: options => { calls.push(options.dryRun); return 0 }}), 0)
  assert.equal(await main(['migrate-data'], {stdout, migrate: options => { calls.push(options.dryRun); return 1 }}), 1)
  assert.equal(await main(['migrate-data', '--force'], {stdout, migrate: () => assert.fail('unexpected')}), 2)
  assert.deepEqual(calls, [true, false])
})

// --- Round 4 ---

test('the journal always wins over the marker, and a held migrator lock blocks every resolver', t => {
  const {directory, root} = fixture(t)
  assert.equal(run(directory).code, 0)
  fs.writeFileSync(join(root, DATA_ROOT_JOURNAL), JSON.stringify({version: 1, root, legacyRoot: join(directory, '.nova-audio-agent'), ops: []}))
  assert.throws(() => resolveDataRoot(directory), {code: 'data_root_migration_pending'})
  assert.match(run(directory, {dryRun: true}).output, /interrupted migration is pending/u)
  assert.equal(run(directory).code, 0, 'the rerun finishes from the journal')
  assert.equal(fs.existsSync(join(root, DATA_ROOT_JOURNAL)), false)
  const lock = join(directory, '.nova-personal-agent.migration.lock')
  fs.writeFileSync(lock, JSON.stringify({pid: process.pid, token: 'x'}))
  assert.throws(() => resolveDataRoot(directory), {code: 'data_root_migration_pending'})
  assert.throws(() => defaultDataPath('blackboard.sqlite', directory), {code: 'data_root_migration_pending'})
})

test('a missing compatibility link resolves the new root, is reported, and is repaired; legacy-named paths map onto the new root', async t => {
  const {directory, legacy, root} = fixture(t)
  assert.equal(run(directory).code, 0)
  fs.unlinkSync(legacy)
  assert.deepEqual(resolveDataRoot(directory), {root, legacy: false, linkBroken: true})
  // An explicit legacy-named path can never open a second, separate database.
  assert.equal(mapLegacyDataPath(join(legacy, 'blackboard.sqlite'), directory), join(root, 'blackboard.sqlite'))
  assert.equal(mapLegacyDataPath('~/.nova-audio-agent/memory.sqlite', directory), '~/.nova-personal-agent/memory.sqlite')
  assert.equal(mapLegacyDataPath(join(directory, 'elsewhere.sqlite'), directory), join(directory, 'elsewhere.sqlite'))
  const reset = await resetPersonalState({home: directory, environment: {BLACKBOARD_PATH: join(legacy, 'blackboard.sqlite')}, renameFile: async () => {}})
  assert.equal(reset.statePath, join(root, 'blackboard.sqlite.personal.json'))
  assert.equal(fs.existsSync(legacy), false, 'mapping created nothing at the legacy path')
  assert.match(run(directory, {dryRun: true}).output, /compatibility link .* is missing or points elsewhere/u)
  const repaired = run(directory)
  assert.equal(repaired.code, 0, repaired.output)
  assert.match(repaired.output, /Restored the compatibility link/u)
  assert.equal(fs.realpathSync(legacy), root)
  assert.deepEqual(resolveDataRoot(directory), {root, legacy: false})
  // A non-empty folder at the legacy path is never replaced.
  fs.unlinkSync(legacy)
  write(join(legacy, 'recreated.txt'), 'by an old build')
  assert.equal(run(directory).code, 1)
  assert.equal(fs.readFileSync(join(legacy, 'recreated.txt'), 'utf8'), 'by an old build')
})

test('a linked new root is refused, and database names compare case-insensitively', t => {
  const linked = fixture(t)
  const real = join(linked.directory, 'real-root')
  fs.renameSync(linked.root, real)
  fs.symlinkSync(real, linked.root, 'dir')
  write(join(real, 'workspace-graph.sqlite-wal'), 'stray wal')
  const before = tree(linked.directory)
  assert.match(run(linked.directory, {dryRun: true}).output, /is a link; the move needs a real folder/u)
  assert.equal(run(linked.directory).code, 1)
  assert.deepEqual(tree(linked.directory), before)

  const cased = fixture(t)
  write(join(cased.legacy, 'blackboard.sqlite'), 'board')
  write(join(cased.root, 'Blackboard.sqlite-wal'), 'other case wal')
  const casedBefore = tree(cased.directory)
  const dry = run(cased.directory, {dryRun: true})
  assert.equal(dry.code, 1)
  assert.match(dry.output, /CONFLICT .*Blackboard\.sqlite-wal: .*database/u)
  assert.equal(run(cased.directory).code, 1)
  assert.deepEqual(tree(cased.directory), casedBefore)
})

test('a resume re-checks database groups: a stray member keeps the journal and nothing is mixed', t => {
  const {directory, legacy, root} = fixture(t)
  assert.equal(run(directory, {fs: crashAfter(2)}).code, 1)
  assert.equal(fs.existsSync(join(root, DATA_ROOT_JOURNAL)), true)
  write(join(root, 'workspace-graph.sqlite-shm'), 'stray shm')
  const {code, output} = run(directory)
  assert.equal(code, 1)
  assert.ok(output.includes(`${join(root, 'workspace-graph.sqlite-shm')} appeared after the migration started`), output)
  assert.equal(fs.existsSync(join(root, DATA_ROOT_JOURNAL)), true, 'journal kept')
  assert.equal(fs.readFileSync(join(legacy, 'workspace-graph.sqlite'), 'utf8'), 'ledger', 'the group did not move')
  assert.equal(fs.existsSync(join(root, 'workspace-graph.sqlite')), false)
  assert.equal(fs.readFileSync(join(legacy, 'blackboard.sqlite.personal.json'), 'utf8'), '{"goals":[1]}', 'applied moves were rolled back')
  assert.throws(() => resolveDataRoot(directory), {code: 'data_root_migration_pending'})
  fs.renameSync(join(root, 'workspace-graph.sqlite-shm'), join(directory, 'stray-shm'))
  assert.equal(run(directory).code, 0)
  assert.equal(fs.readFileSync(join(root, 'workspace-graph.sqlite'), 'utf8'), 'ledger')
})

test('the final Nova check runs after the journal is published; a late start rolls back and removes the journal', t => {
  const {directory, legacy, root} = fixture(t)
  const before = tree(directory)
  const seen = []
  const {code} = run(directory, {blockers: () => {
    const published = fs.existsSync(join(root, DATA_ROOT_JOURNAL))
    seen.push(published)
    return published ? ['Nova process 42 is running'] : []
  }})
  assert.equal(code, 1)
  assert.equal(seen.at(-1), true, 'the last check saw the published journal')
  assert.equal(fs.existsSync(join(root, DATA_ROOT_JOURNAL)), false)
  assert.deepEqual(tree(directory), before)
  assert.deepEqual(resolveDataRoot(directory), {root: legacy, legacy: true})
})

test('settings are rewritten before the marker: a failed rewrite keeps the journal and a rerun finishes', {skip: process.platform === 'win32' || process.getuid?.() === 0}, t => {
  const {directory, legacy, root} = fixture(t)
  const profile = join(directory, 'Library', 'Application Support', 'Nova Audio Agent Ambient Orb')
  const settingsPath = join(profile, 'ambient-orb-settings.json')
  write(settingsPath, JSON.stringify({knowledgePath: join(legacy, 'kb.sqlite')}))
  fs.chmodSync(profile, 0o500)
  t.after(() => { try { fs.chmodSync(profile, 0o700) } catch { /* already removed */ } })
  const failed = run(directory)
  assert.equal(failed.code, 1)
  assert.match(failed.output, /updating saved paths failed/u)
  assert.equal(fs.existsSync(join(root, DATA_ROOT_MARKER)), false, 'no marker before the rewrites')
  assert.equal(fs.existsSync(join(root, DATA_ROOT_JOURNAL)), true)
  assert.equal(fs.realpathSync(legacy), root)
  fs.chmodSync(profile, 0o700)
  assert.equal(run(directory).code, 0)
  assert.equal(fs.existsSync(join(root, DATA_ROOT_MARKER)), true)
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).knowledgePath, join(root, 'kb.sqlite'))
})

test('reset-state refuses during a pending or running move, even with an explicit BLACKBOARD_PATH', async t => {
  const {directory, root} = fixture(t)
  const environment = {BLACKBOARD_PATH: join(directory, 'custom', 'board.sqlite')}
  const renameFile = async () => assert.fail('renamed')
  fs.writeFileSync(join(root, DATA_ROOT_JOURNAL), '{}')
  await assert.rejects(resetPersonalState({home: directory, environment, renameFile}), {code: 'data_root_migration_pending'})
  fs.unlinkSync(join(root, DATA_ROOT_JOURNAL))
  fs.writeFileSync(join(directory, '.nova-personal-agent.migration.lock'), '')
  await assert.rejects(resetPersonalState({home: directory, environment, renameFile}), {code: 'data_root_migration_pending'})
})
