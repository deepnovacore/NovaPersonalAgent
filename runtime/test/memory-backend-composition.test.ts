import assert from 'node:assert/strict'
import {test} from 'node:test'
import {ConfigurationError, loadSettings, resolveMemoryComposition} from '../src/config/config.js'
import {legacyMemoryComposition, personalMemoryFactory} from '../src/memory/factory.js'
import {FULL_MEMORY_TOOLS, planMemoryToolCapabilities} from '../src/memory/tool-capabilities.js'

const credentials = {DASHSCOPE_API_KEY: 'fixture', CASCADE_LLM_PROVIDER: 'qwen'}
test('default and legacy voicemem resolve to identical ledger plus migration', () => {
  const defaults = resolveMemoryComposition(loadSettings(credentials))
  assert.deepEqual(resolveMemoryComposition(loadSettings({...credentials, MEMORY_PROVIDER: 'voicemem'})), defaults)
  assert.equal(defaults.kind, 'ledger')
  if (defaults.kind !== 'ledger') return
  assert.equal(defaults.engine, 'ledger')
  assert.deepEqual(defaults.extractors, ['ledger'])
  assert.deepEqual(defaults.migrateLegacy, {path: defaults.local.path, userId: defaults.local.userId})
  assert.deepEqual(legacyMemoryComposition(Object.assign(() => undefined, {localMemoryConfig: defaults.local})), defaults)
})
test('legacy use emits one content-free deprecation warning, never during pure resolution', t => {
  const warning = t.mock.method(process, 'emitWarning', () => { /* Capture warning without writing to stderr. */ })
  const settings = loadSettings({...credentials, MEMORY_PROVIDER: 'voicemem'})
  resolveMemoryComposition(settings)
  assert.equal(warning.mock.callCount(), 0)
  personalMemoryFactory(settings)
  personalMemoryFactory(settings)
  assert.equal(warning.mock.callCount(), 1)
  assert.match(String(warning.mock.calls[0]!.arguments[0]), /^MEMORY_PROVIDER is deprecated;/)
})
test('legacy mem0 keeps standalone resource and reduced tool capabilities', () => {
  const settings = loadSettings({...credentials, MEMORY_PROVIDER: 'mem0'})
  const {factory, composition} = personalMemoryFactory(settings)
  assert.equal(composition.kind, 'standalone-mem0')
  assert.equal(factory!().recallEngine, 'mem0')
  assert.equal(factory!().writeExplicit, undefined)
  assert.equal(planMemoryToolCapabilities({settings, memoryComposition: composition, createPersonalMemory: factory, knowledge: true}).engine, 'mem0')
})
test('new ledger settings use explicit composition without legacy migration or tag', () => {
  for (const env of [{MEMORY_RECALL_ENGINE: 'ledger'}, {MEMORY_EXTRACTORS: 'ledger'}, {MEMORY_RECALL_ENGINE: 'ledger', MEMORY_EXTRACTORS: ' ledger '}]) {
    const settings = loadSettings({...credentials, ...env})
    const {factory, composition} = personalMemoryFactory(settings)
    assert.equal(factory, undefined)
    assert.equal(composition.kind, 'ledger')
    assert.ok(!('migrateLegacy' in composition))
    assert.deepEqual(planMemoryToolCapabilities({settings, memoryComposition: composition, knowledge: false}), FULL_MEMORY_TOOLS)
  }
})
test('disabled, credential-disabled and remote preserve their connection modes', () => {
  assert.deepEqual(resolveMemoryComposition(loadSettings({})), {kind: 'disabled'})
  assert.deepEqual(resolveMemoryComposition(loadSettings({...credentials, MEMORY_CONNECTION: 'disabled', MEMORY_RECALL_ENGINE: 'ledger'})), {kind: 'disabled'})
  assert.equal(resolveMemoryComposition(loadSettings({MEMORY_CONNECTION: 'remote', MEMORY_URL: 'https://memory.example', MEMORY_TOKEN: 'fixture'})).kind, 'remote')
})
test('conflicts, remote overrides and unfinished engine feeding fail at configuration time', () => {
  for (const env of [
    {MEMORY_PROVIDER: 'voicemem', MEMORY_RECALL_ENGINE: 'ledger'},
    {MEMORY_PROVIDER: 'mem0', MEMORY_EXTRACTORS: 'ledger'},
    {MEMORY_CONNECTION: 'remote', MEMORY_RECALL_ENGINE: 'ledger'},
    {MEMORY_CONNECTION: 'remote', MEMORY_EXTRACTORS: 'ledger'},
    {MEMORY_EXTRACTORS: 'ledger,voicemem'}, {MEMORY_EXTRACTORS: 'mem0'},
  ]) assert.throws(() => loadSettings({...credentials, ...env}), ConfigurationError)
  for (const engine of ['voicemem', 'mem0']) assert.throws(() => loadSettings({...credentials, MEMORY_RECALL_ENGINE: engine}), /engine feeding is not available yet/)
})


test('legacyMemoryComposition rejects malformed tags without narrowing injected tools', () => {
  const settings = loadSettings(credentials)
  const composition = resolveMemoryComposition(settings)
  assert.equal(composition.kind, 'ledger')
  if (composition.kind !== 'ledger') return
  for (const localMemoryConfig of [{}, true, {path: 'fixture'}, {...composition.local, embedding: null}, {...composition.local, userId: ''}]) {
    const factory = Object.assign(() => undefined, {localMemoryConfig})
    assert.equal(legacyMemoryComposition(factory), undefined)
    assert.deepEqual(planMemoryToolCapabilities({settings, createPersonalMemory: factory, knowledge: false}), FULL_MEMORY_TOOLS)
  }
})
