import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {Worker} from 'node:worker_threads'
import {enableMemoryFiles, queueMemoryFiles} from '../src/memory-substrate/file-authority.js'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {LedgerRecallEngine, validateResponseStyleHits, type MemoryRecallEngine} from '../src/memory/ledger-recall-engine.js'
import {retrievalPrerecall} from '../src/memory/prerecall-port.js'
import {UnifiedRetrieval} from '../src/memory/retrieval.js'
import {deriveMemoryToolCapabilities} from '../src/memory/tool-capabilities.js'
import type {MemoryEntry, PersonalMemoryRecallHit, PersonalMemoryResource} from '../src/memory/personal-memory.js'
import type {ModelGateway} from '../src/model/model-gateway.js'

const gateway: ModelGateway = {async *stream() { /* No streaming extraction in this fixture. */ }, complete: () => Promise.resolve({text: JSON.stringify({entries: [{key: 'tea', text: 'I prefer tea', topic: 'tea', kind: 'preference', due: null, direction: null, status: null, valid_until: null}]})})}
const signal = () => new AbortController().signal

// Adversarial candidates over real ledger authority; production SDK feeding has its own behavioral suite.
for (const backend of ['ledger', 'voicemem', 'mem0'] as const) test(`memory-backend contract: ${backend} candidates over persistent ledger`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-backend-contract-'))
  const path = join(root, 'ledger.sqlite')
  const create = (userId = 'owner') => new SubstrateMemoryResource({client: new MemoryLedgerClient(path), userId, gateway, model: 'fixture', inputConsent: true, embedding:{id:'fixture',dims:2,embed:texts=>Promise.resolve(texts.map(()=>new Float32Array([1,0])))}, conversationProviders: ['consumer'], consolidation: {enabled: false}})
  let ledger = create()
  let candidates: PersonalMemoryRecallHit[] = [], contextHits: PersonalMemoryRecallHit[] = []
  const engine: MemoryRecallEngine = {recallEngine: backend === 'ledger' ? 'voicemem' : backend,
    recall: () => Promise.resolve({source: 'personal', state: 'ok', scope: 'any', hits: candidates, contextHits, degraded: false})}
  const facade = (): PersonalMemoryResource => {
    const recall = backend === 'ledger' ? ledger : new LedgerRecallEngine(ledger, engine, 'consumer')
    return {open: () => ledger.open(), close: () => ledger.close(), recallEngine: backend, supportsResponseStyle: backend==='voicemem',
      recall: (...args) => recall.recall(...args), get: id => ledger.get(id), getMany: ids => ledger.getMany(ids),
      readEvidence: id => ledger.readEvidence(id), recallAuthorityRevision: () => ledger.recallAuthorityRevision(), requiresConversationConsumer: true,
      canReadConversationEvidence: (id, consumer) => ledger.canReadConversationEvidence(id, consumer)}
  }
  try {
    await ledger.open()
    const turn = {sourceId: 'source', sessionId: 'session', sequence: 1, text: 'I prefer tea', occurredAt: new Date().toISOString(), confirmed: true}
    assert.equal((await ledger.remember(turn)).state, 'stored')
    await ledger.remember(turn); await ledger.flush()
    const rows = (await ledger.list()).entries
    assert.equal(rows.length, 1, 'idempotent admission')
    const row = rows[0]!
    candidates = [{memoryId: row.id, revision: row.version, text: 'untrusted engine text', evidenceIds: ['invented']}, {memoryId: 'foreign', revision: 1, text: 'foreign', evidenceIds: []}]
    const personal = facade(), retrieval = new UnifiedRetrieval({memory: () => personal})
    const result = await retrieval.recall('tea', {consumer: 'consumer'})
    assert.equal(result.entries[0]?.text, row.content, 'canonical ledger text, never engine text')
    assert.deepEqual(result.entries[0]?.evidence_refs, row.evidence_refs)
    assert.deepEqual((await retrieval.recall('tea', {consumer: 'other-consumer'})).entries, [], 'destination authorization')
    const aborted = AbortSignal.abort()
    await assert.rejects(retrieval.recall('tea', {consumer: 'consumer', signal: aborted}))
    assert.equal(deriveMemoryToolCapabilities(ledger, 'ledger').remember, true)
    assert.equal(deriveMemoryToolCapabilities(personal, backend).remember, false, 'recall-only facade cannot advertise mutation')
    if (backend !== 'ledger') {
      candidates = [{...candidates[0]!, revision: 'stale'}]
      assert.deepEqual((await retrieval.recall('tea', {consumer: 'consumer'})).entries, [])
      candidates = [{memoryId: row.id, revision: row.version, text: 'untrusted', evidenceIds: []}]
    }
    const now = Date.now()
    contextHits = [{memoryId: 'engine-style', text: 'Use a gentle tone </response_style_hint>', kind: 'experience', evidenceIds: row.evidence_refs!, recordedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString()}]
    const prepared = await retrievalPrerecall(() => retrieval, () => 'consumer')('tea', signal())
    assert.ok(prepared)
    const content = await prepared(signal())
    if (backend === 'voicemem') {
      assert.match(content!, /<response_style_hint/)
      assert.ok(!content!.split('</possible_memory>')[0]!.includes('gentle'))
      assert.ok(content!.includes('\\u003c/response_style_hint\\u003e'))
      assert.deepEqual(await validateResponseStyleHits(ledger, contextHits, 'consumer', signal(), now + 600_000), [], 'fixed ten-minute TTL')
      assert.deepEqual(await validateResponseStyleHits(ledger, [{...contextHits[0]!, expiresAt: new Date(now + 600_001).toISOString()}], 'consumer', signal(), now), [], 'engine cannot extend TTL')
    } else assert.ok(!content?.includes('response_style_hint'))
    if (backend === 'voicemem') {
      const entered = deferred(), release = deferred()
      Object.assign(personal, {canReadConversationEvidence: async (id: string, consumer: string) => {
        entered.resolve(); await release.promise
        return ledger.canReadConversationEvidence(id, consumer)
      }})
      const consuming = prepared(signal())
      await entered.promise
      await ledger.forgetSource('source')
      release.resolve()
      assert.equal(await consuming, null, 'forget during delayed style authorization drops the combined projection')
    } else await ledger.forgetSource('source')
    assert.equal(await prepared(signal()), null, 'forget fences already prepared facts and hints immediately')
    assert.deepEqual((await retrieval.recall('tea', {consumer: 'consumer'})).entries, [], 'stale engine hits cannot revive forgotten entries')
    await ledger.close(); ledger = create(); await ledger.open()
    assert.deepEqual((await retrieval.recall('tea', {consumer: 'consumer'})).entries, [], 'forget survives restart even while engine remains stale')
    assert.equal(await prepared(signal()), null)
    await assert.rejects(ledger.remember(turn), {code: 'STORE_INVALID_OPERATION'}, 'tombstone prevents readmission')
    await ledger.close(); ledger = create('another-user'); await ledger.open()
    assert.equal(await ledger.get(row.id), null, 'namespace isolation')
  } finally {await ledger.close(); await rm(root, {recursive: true, force: true})}
})

for (const activity of ['read', 'correction', 'other-correction', 'other-read', 'other-outbox', 'reopen'] as const) test(`prerecall-port real ledger delayed hydration: ${activity}`, async () => {
  const reconcile = activity === 'correction' || activity === 'other-correction'
  const root = await mkdtemp(join(tmpdir(), 'nova-consume-reconcile-')), path = join(root, 'ledger.sqlite')
  const workers: Worker[] = [], reopened = deferred()
  const client = new MemoryLedgerClient(path, {workerFactory: (url, options) => {
    const worker = new Worker(url, options)
    workers.push(worker)
    if (workers.length > 1) worker.once('message', () => reopened.resolve())
    return worker
  }}), other = new MemoryLedgerClient(path)
  const ledger = new SubstrateMemoryResource({client, userId: 'owner', gateway, model: 'fixture', conversationProviders: ['consumer']})
  try {
    await ledger.open({deferBackground: true}); await other.open()
    const now = new Date().toISOString(), prefix = ledger.prefix
    for (const [key, text] of [['A', 'I prefer tea'], ['B', 'I prefer gentle replies']]) {
      const evidenceId = prefix + 'e:' + key, sourceId = prefix + (activity === 'reopen' && key === 'B' ? 'feishu:' : 'source:') + key
      await client.memory('append_evidence', {id: evidenceId, source_id: sourceId, source_kind: 'conversation', locator: 'fixture:' + key, observed_at: now, recorded_at: now, raw_text: text, hash: key, trust: 'trusted_user'})
      await client.memory('source_grant', {source_id: sourceId, expected_revision: 0, grant: {revision: 1, scope_revision: 0, extraction_provider: null, embedding_provider: null, conversation_providers: ['consumer']}})
      await client.memory('merge', {entry_id: prefix + key, kind: 'preference', origin: 'stated', written_by: 'merge', evidence_refs: [evidenceId], content: {text}, recorded_at: now})
    }
    const sessionGrant = {revision: 1, scope_revision: 0, extraction_provider: null, embedding_provider: null, conversation_providers: ['consumer']}
    if (activity === 'reopen') await ledger.feishuProcessingConsent('activate', ['feishu:B'], sessionGrant)
    const fact = (await ledger.get(prefix + 'A'))!
    const style: PersonalMemoryRecallHit = {memoryId: 'style-B', text: 'Use a gentle tone', kind: 'experience', evidenceIds: [prefix + 'e:B'], recordedAt: now, expiresAt: new Date(Date.parse(now) + 600_000).toISOString()}
    const entered = deferred(), release = deferred()
    let consuming = false, styleAuthorized = false
    const personal: PersonalMemoryResource = {
      open: () => ledger.open(), close: () => ledger.close(), recallEngine: 'voicemem', supportsResponseStyle:true, requiresConversationConsumer: true,
      recallAuthorityRevision: () => ledger.recallAuthorityRevision(),
      recall: () => Promise.resolve({source: 'personal', state: 'ok', scope: 'any', hits: [{memoryId: fact.id, revision: fact.version, text: fact.content, evidenceIds: fact.evidence_refs!}], contextHits: [style], degraded: false}),
      readEvidence: id => ledger.readEvidence(id),
      canReadConversationEvidence: async (id, consumer) => {
        const allowed = await ledger.canReadConversationEvidence(id, consumer)
        if (consuming && id === prefix + 'e:B') {assert.equal(allowed, true); styleAuthorized = true}
        return allowed
      },
      get: async id => {
        if (consuming) {assert.ok(styleAuthorized, 'B was authorized before factual hydration'); entered.resolve(); await release.promise}
        return ledger.get(id)
      },
    }
    const retrieval = new UnifiedRetrieval({memory: () => personal})
    const prepared = await retrievalPrerecall(() => retrieval, () => 'consumer')('tea', signal())
    assert.ok(prepared)
    const before = client.recallAuthorityRevision()
    consuming = true
    const pending = prepared(signal())
    await entered.promise
    if (reconcile) {
      const directory = join(path + '.memory', 'entries')
      let edited = false
      for (const name of await readdir(directory)) {
        const file = join(directory, name), text = await readFile(file, 'utf8'), at = text.lastIndexOf('I prefer gentle replies')
        if (at < 0) continue
        await writeFile(file, text.slice(0, at) + 'I prefer concise replies' + text.slice(at + 'I prefer gentle replies'.length))
        edited = true
      }
      assert.ok(edited)
      assert.equal(client.recallAuthorityRevision(), before, 'editing Markdown alone has not reconciled it')
    }
    if (activity === 'other-outbox') {
      const db = new DatabaseSync(path)
      try {
        enableMemoryFiles(db, path + '.memory')
        queueMemoryFiles(db)
        assert.ok(db.prepare('SELECT 1 FROM memory_file_outbox').get())
      } finally {db.close()}
    }
    if (activity.startsWith('other-')) {
      await other.memory('list', {})
      assert.equal(client.recallAuthorityRevision(), before, 'another client cannot update the synchronous fence until the next RPC')
      if (activity === 'other-outbox') {
        const db = new DatabaseSync(path)
        try {assert.equal(db.prepare('SELECT 1 FROM memory_file_outbox').get(), undefined)} finally {db.close()}
      }
    }
    if (activity === 'reopen') {
      const db = new DatabaseSync(path)
      try {
        const epoch = () => db.prepare('SELECT value FROM recall_authority_epoch WHERE slot=1').get()!.value
        const beforeEpoch = epoch()
        await workers[0]!.terminate()
        await reopened.promise
        await client.open()
        assert.equal(epoch(), beforeEpoch, 'idle replacement loses only TEMP consent, without persistent authority writes')
        assert.equal(await ledger.canReadConversationEvidence(prefix + 'e:B', 'consumer'), false, 'replacement starts with empty session consent')
      } finally {db.close()}
    }
    release.resolve()
    const content = await pending
    if (activity === 'reopen') {
      assert.equal(content, null, 'lost session consent for independent B drops the combined projection while A remains valid')
      assert.ok(client.recallAuthorityRevision() > before, 'worker replacement fences the old authorization')
      consuming = false
      const fresh = await retrievalPrerecall(() => retrieval, () => 'consumer')('tea', signal())
      assert.ok(fresh)
      const freshContent = await fresh(signal())
      assert.match(freshContent!, /I prefer tea/)
      assert.ok(!freshContent!.includes('response_style_hint'), 'fresh consumption cannot use B without session consent')
      await ledger.feishuProcessingConsent('activate', ['feishu:B'], sessionGrant)
      const authorized = await retrievalPrerecall(() => retrieval, () => 'consumer')('tea', signal())
      assert.ok(authorized)
      assert.match((await authorized(signal()))!, /response_style_hint/, 'fresh authorized consumption succeeds after reactivation')
    } else if (reconcile) {
      assert.equal(content, null, 'a correction to independent evidence B drops the combined projection even though fact A remains valid')
      assert.ok(client.recallAuthorityRevision() > before, 'the read RPC reports the real committed reconciliation')
      assert.equal(await ledger.canReadConversationEvidence(prefix + 'e:B', 'consumer'), false)
      assert.equal((await ledger.get(prefix + 'B'))?.version, 2)
    } else {
      assert.match(content!, /I prefer tea/)
      assert.match(content!, /response_style_hint/)
      assert.equal(client.recallAuthorityRevision(), before, 'ordinary reads must not invalidate consumption')
    }
    assert.equal((await ledger.get(fact.id))?.version, fact.version, 'independent fact A is unchanged')
  } finally {await ledger.close(); await other.close(); await rm(root, {recursive: true, force: true})}
})

test('ledger-recall-engine cancellation rejects an uncooperative engine promptly', async () => {
  const ledger: PersonalMemoryResource = {open: () => Promise.resolve(), close: () => Promise.resolve(), recall: () => Promise.resolve({source: 'personal', state: 'empty', scope: 'any', hits: [], degraded: false}), get: () => Promise.resolve(null), canReadConversationEvidence: () => Promise.resolve(true)}
  const engine: MemoryRecallEngine = {recallEngine: 'voicemem', recall: () => new Promise(() => { /* Deliberately ignores cancellation. */ })}
  const controller = new AbortController()
  const pending = new LedgerRecallEngine(ledger, engine, 'consumer').recall('tea', {signal: controller.signal})
  controller.abort()
  await assert.rejects(pending, {name: 'AbortError'})
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {resolve = done})
  return {promise, resolve}
}

function recallFixture() {
  const now = Date.now(), evidence = {evidence_id: 'evidence', locator: 'fixture', text: 'tea source', source_kind: 'conversation', observed_at: new Date(now).toISOString(), trust: 'untrusted_external' as const}
  const entry: MemoryEntry = {memory_scope:'user',id: 'fact-A', version: 1, content: 'I prefer tea', kind: 'preference', origin: 'stated', source_refs: [], evidence_refs: [evidence.evidence_id], observed_at: evidence.observed_at, recorded_at: evidence.observed_at, topic: 'tea', status: 'active', corrected_to: null, confidence_note: null}
  const fact: PersonalMemoryRecallHit = {memoryId: entry.id, revision: 1, text: entry.content, evidenceIds: entry.evidence_refs!}
  const style: PersonalMemoryRecallHit = {memoryId: 'style-B', text: 'Use a gentle tone', kind: 'experience', evidenceIds: [evidence.evidence_id], recordedAt: new Date(now).toISOString(), expiresAt: new Date(now + 1000).toISOString()}
  const ledger = {open: () => Promise.resolve(), close: () => Promise.resolve(), recallEngine: 'voicemem', supportsResponseStyle:true,
    recall: () => Promise.resolve({source: 'personal', state: 'ok', scope: 'any', hits: [fact], contextHits: [style], degraded: false}),
    get: (id: string): Promise<MemoryEntry | null> => Promise.resolve(id === entry.id ? entry : null), readEvidence: () => Promise.resolve(evidence), canReadConversationEvidence: () => Promise.resolve(true)} satisfies PersonalMemoryResource
  return {now, entry, fact, style, ledger}
}

for (const mutation of ['none', 'forget', 'revoke', 'legacy'] as const) test(`prerecall-port consumption authority fence: ${mutation}`, async () => {
  const {ledger} = recallFixture()
  let revision = 0, blocked = false, forgotten = false
  if (mutation !== 'legacy') Object.assign(ledger, {recallAuthorityRevision: () => revision})
  const get = ledger.get
  ledger.get = id => forgotten ? Promise.resolve(null) : get(id)
  const entered = deferred(), release = deferred()
  ledger.canReadConversationEvidence = async () => {
    if (blocked) {entered.resolve(); await release.promise}
    return true
  }
  const retrieval = new UnifiedRetrieval({memory: () => ledger})
  const prepared = await retrievalPrerecall(() => retrieval, () => 'consumer')('tea', signal())
  assert.ok(prepared)
  blocked = true
  const consuming = prepared(signal())
  await entered.promise
  if (mutation === 'forget') forgotten = true
  if (mutation === 'forget' || mutation === 'revoke') revision++
  release.resolve()
  const content = await consuming
  if (mutation === 'forget' || mutation === 'revoke') assert.equal(content, null, 'any authority change drops both facts and hints')
  else {
    assert.match(content!, /I prefer tea/)
    // Without a recall-authority revision a style hint cannot be fenced against forget/revoke, so it fails closed.
    if (mutation === 'legacy') assert.doesNotMatch(content!, /response_style_hint/)
    else assert.match(content!, /response_style_hint/)
  }
})

test('ledger-recall-engine and rendering drop style that expires during async authorization', async t => {
  const {now, ledger, style} = recallFixture()
  let clock = now
  t.mock.method(Date, 'now', () => clock)
  const entered = deferred(), release = deferred()
  ledger.canReadConversationEvidence = async () => {entered.resolve(); await release.promise; return true}
  const validating = validateResponseStyleHits(ledger, [style], 'consumer', signal())
  await entered.promise
  clock = now + 1000
  release.resolve()
  assert.deepEqual(await validating, [])
})

test('prerecall-port rechecks style expiry after final factual hydration', async t => {
  const {now, ledger} = recallFixture()
  let clock = now, consuming = false
  t.mock.method(Date, 'now', () => clock)
  const get = ledger.get
  ledger.get = id => {if (consuming) clock = now + 1000; return get(id)}
  const retrieval = new UnifiedRetrieval({memory: () => ledger})
  const prepared = await retrievalPrerecall(() => retrieval, () => 'consumer')('tea', signal())
  assert.ok(prepared)
  consuming = true
  const content = await prepared(signal())
  assert.match(content!, /I prefer tea/)
  assert.ok(!content!.includes('response_style_hint'))
})

for (const [limit, max, facts, styles] of [[1, 5, 1, 1], [8, 5, 5, 3], [8, 2, 2, 2]] as const) test(`ledger-recall-engine clamps over-returned groups: caller ${limit}, engine ${max}`, async () => {
  const {ledger, fact, style} = recallFixture()
  let requested: number | undefined
  const engine: MemoryRecallEngine = {recallEngine: 'voicemem', maxRecallLimit: max, recall: (_query, options) => {
    requested = options?.limit
    return Promise.resolve({source: 'personal', state: 'ok', scope: 'any', hits: Array.from({length: 10}, () => fact), contextHits: Array.from({length: 10}, () => style), degraded: false})
  }}
  const result = await new LedgerRecallEngine(ledger, engine, 'consumer').recall('tea', {limit})
  assert.equal(requested, Math.min(limit, max))
  assert.equal(result.hits.length, facts)
  assert.equal(result.contextHits.length, styles)
})
