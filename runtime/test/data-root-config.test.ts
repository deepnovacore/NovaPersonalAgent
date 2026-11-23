import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test, type TestContext} from 'node:test'
import {loadCapabilityRegistry, defaultCapabilitiesPath} from '../src/config/capability-registry.js'
import {loadSettings} from '../src/config/config.js'
import {DATA_ROOT_MARKER, defaultDataPath, environmentHome, rebaseDataRootDefault, resolveDataRoot} from '../src/config/data-root.js'
import {VirtualClock} from '../src/core/clock.js'
import {createRealtimeTelemetry} from '../src/realtime/telemetry.js'

function home(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'nova-runtime-data-root-'))
  t.after(() => rmSync(directory, {recursive: true, force: true}))
  return directory
}

function withLegacyRoot(directory: string): void {
  mkdirSync(join(directory, '.nova-audio-agent'))
  writeFileSync(join(directory, '.nova-audio-agent', 'capabilities.json'), JSON.stringify({version: 1, modules: {search: {enabled: false}}}))
}

test('defaulted runtime paths use the new root on a fresh install', t => {
  const directory = home(t)
  const settings = loadSettings({HOME: directory, EXECUTOR: 'codex'})
  assert.equal(settings.blackboard_path, '~/.nova-personal-agent/blackboard.sqlite')
  assert.equal(settings.memory_path, '~/.nova-personal-agent/memory.sqlite')
  assert.equal(settings.workspace_graph_path, '~/.nova-personal-agent/workspace-graph.sqlite')
  assert.equal(settings.knowledge_path, '~/.nova-personal-agent/knowledge.sqlite')
  assert.equal(settings.codex_managed_root, '~/.nova-personal-agent/workspaces')
  assert.equal(settings.codex_project_state_root, '~/.nova-personal-agent')
  assert.deepEqual(resolveDataRoot(directory), {root: join(directory, '.nova-personal-agent'), legacy: false})
})

test('defaulted runtime paths follow the legacy root until migrated; explicit paths are honoured as-is', t => {
  const directory = home(t)
  withLegacyRoot(directory)
  const explicit = join(directory, 'custom', 'memory.sqlite')
  const settings = loadSettings({HOME: directory, EXECUTOR: 'codex', MEMORY_PATH: explicit, CODEX_MANAGED_ROOT: '~/.nova-personal-agent/managed'})
  assert.equal(settings.blackboard_path, '~/.nova-audio-agent/blackboard.sqlite')
  assert.equal(settings.workspace_graph_path, '~/.nova-audio-agent/workspace-graph.sqlite')
  assert.equal(settings.knowledge_path, '~/.nova-audio-agent/knowledge.sqlite')
  assert.equal(settings.codex_project_state_root, '~/.nova-audio-agent')
  assert.equal(settings.memory_path, explicit)
  assert.equal(settings.codex_managed_root, '~/.nova-personal-agent/managed')
  assert.equal(defaultCapabilitiesPath(directory), '~/.nova-audio-agent/capabilities.json')
  assert.equal(loadCapabilityRegistry({environment: {}, home: directory}).modules.search.enabled, false)

  mkdirSync(join(directory, '.nova-personal-agent'))
  writeFileSync(join(directory, '.nova-personal-agent', DATA_ROOT_MARKER), '{}')
  assert.equal(loadSettings({HOME: directory}).blackboard_path, '~/.nova-personal-agent/blackboard.sqlite')
  assert.equal(defaultCapabilitiesPath(directory), '~/.nova-personal-agent/capabilities.json')
  assert.equal(defaultDataPath('', directory), '~/.nova-personal-agent')
})

test('an environment without a home keeps the static new-root defaults', () => {
  assert.equal(environmentHome({}), undefined)
  assert.equal(environmentHome({USERPROFILE: 'C:\\Users\\nova'}, 'win32'), 'C:\\Users\\nova')
  assert.equal(loadSettings({}).blackboard_path, '~/.nova-personal-agent/blackboard.sqlite')
  assert.equal(rebaseDataRootDefault('~/.nova-personal-agent/x', true), '~/.nova-audio-agent/x')
  assert.equal(rebaseDataRootDefault('~/.nova-personal-agentish/x', true), '~/.nova-personal-agentish/x')
  assert.equal(rebaseDataRootDefault('/abs/.nova-personal-agent/x', true), '/abs/.nova-personal-agent/x')
})

test('default telemetry stays in the legacy root until migrated and never creates it on a fresh install', t => {
  const fresh = home(t)
  const first = createRealtimeTelemetry({}, {clock: new VirtualClock(), homeDirectory: fresh})
  first.record('fresh', {revision: 1})
  first.close()
  assert.match(readFileSync(join(fresh, '.nova-personal-agent', 'realtime-telemetry.jsonl'), 'utf8'), /fresh/u)

  const legacy = home(t)
  withLegacyRoot(legacy)
  const second = createRealtimeTelemetry({}, {clock: new VirtualClock(), homeDirectory: legacy})
  second.record('legacy', {revision: 1})
  second.close()
  assert.match(readFileSync(join(legacy, '.nova-audio-agent', 'realtime-telemetry.jsonl'), 'utf8'), /legacy/u)
})

test('a pending migration journal blocks every runtime default and creates nothing', t => {
  const directory = home(t)
  withLegacyRoot(directory)
  mkdirSync(join(directory, '.nova-personal-agent'))
  writeFileSync(join(directory, '.nova-personal-agent', '.data-root-migration.journal.json'), '{}')
  const pending = {code: 'data_root_migration_pending'}
  assert.throws(() => resolveDataRoot(directory), pending)
  assert.throws(() => loadSettings({HOME: directory, EXECUTOR: 'codex'}), pending)
  assert.throws(() => defaultCapabilitiesPath(directory), pending)
  assert.throws(() => loadCapabilityRegistry({environment: {}, home: directory}), pending)
  assert.throws(() => createRealtimeTelemetry({}, {clock: new VirtualClock(), homeDirectory: directory}), pending)
  assert.deepEqual(readdirSync(join(directory, '.nova-personal-agent')), ['.data-root-migration.journal.json'])
})

test('a legacy root that is a foreign link stays the legacy root, never a fresh install', t => {
  const directory = home(t)
  const relocated = join(directory, 'elsewhere')
  mkdirSync(relocated)
  writeFileSync(join(relocated, 'capabilities.json'), JSON.stringify({version: 1, modules: {search: {enabled: false}}}))
  symlinkSync(relocated, join(directory, '.nova-audio-agent'), 'dir')
  assert.deepEqual(resolveDataRoot(directory), {root: join(directory, '.nova-audio-agent'), legacy: true})
  assert.equal(loadSettings({HOME: directory}).blackboard_path, '~/.nova-audio-agent/blackboard.sqlite')
  assert.equal(defaultCapabilitiesPath(directory), '~/.nova-audio-agent/capabilities.json')
  assert.equal(loadCapabilityRegistry({environment: {}, home: directory}).modules.search.enabled, false)
})

test('a held migrator lock blocks every runtime default like a pending journal', t => {
  const directory = home(t)
  withLegacyRoot(directory)
  writeFileSync(join(directory, '.nova-personal-agent.migration.lock'), JSON.stringify({pid: process.pid, token: 't'}))
  const pending = {code: 'data_root_migration_pending'}
  assert.throws(() => resolveDataRoot(directory), pending)
  assert.throws(() => loadSettings({HOME: directory, EXECUTOR: 'codex'}), pending)
  assert.throws(() => loadSettings({HOME: directory, EXECUTOR: 'codex', BLACKBOARD_PATH: join(directory, 'custom.sqlite')}), pending)
  assert.throws(() => defaultCapabilitiesPath(directory), pending)
  assert.throws(() => loadCapabilityRegistry({environment: {CAPABILITIES_CONFIG: join(directory, 'custom.json')}, home: directory}), pending)
  assert.throws(() => createRealtimeTelemetry({}, {clock: new VirtualClock(), homeDirectory: directory}), pending)
})

test('after migration, explicit legacy-root paths map onto the new root, even with the link missing', t => {
  const directory = home(t)
  const root = join(directory, '.nova-personal-agent')
  mkdirSync(root)
  writeFileSync(join(root, 'capabilities.json'), JSON.stringify({version: 1, modules: {search: {enabled: false}}}))
  writeFileSync(join(root, DATA_ROOT_MARKER), '{}')
  assert.deepEqual(resolveDataRoot(directory), {root, legacy: false, linkBroken: true})
  const settings = loadSettings({HOME: directory, EXECUTOR: 'codex', BLACKBOARD_PATH: join(directory, '.nova-audio-agent', 'blackboard.sqlite'), MEMORY_PATH: '~/.nova-audio-agent/memory.sqlite', KNOWLEDGE_PATH: join(directory, 'custom', 'knowledge.sqlite')})
  assert.equal(settings.blackboard_path, join(root, 'blackboard.sqlite'))
  assert.equal(settings.memory_path, '~/.nova-personal-agent/memory.sqlite')
  assert.equal(settings.knowledge_path, join(directory, 'custom', 'knowledge.sqlite'), 'paths outside the legacy root are untouched')
  assert.equal(loadCapabilityRegistry({environment: {CAPABILITIES_CONFIG: join(directory, '.nova-audio-agent', 'capabilities.json')}, home: directory}).modules.search.enabled, false)
  symlinkSync(root, join(directory, '.nova-audio-agent'), 'dir')
  assert.deepEqual(resolveDataRoot(directory), {root, legacy: false})
})
