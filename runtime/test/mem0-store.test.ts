import {settingsSchema} from '../src/config/config.js'
import {configuredDiscoveryConsumer,configuredMemoryConsumers,configuredTaskVerifierConsumer} from '../src/memory/consumer.js'
import {PersonalMemoryStoreClient} from '../src/voicemem/store-client.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {provider, eventually, turn, userDirectory} from './helpers/mem0-fixture.js'
import {UnifiedRetrieval} from '../src/memory/retrieval.js'
import {memoryInspectionSchema} from '../src/memory/personal-memory-inspection.js'
import {MAX_BOARD_MESSAGE_BYTES} from '../src/realtime/memory-board.js'
import assert from 'node:assert/strict'
import {mkdtemp, readFile, realpath, rm, stat, symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import test from 'node:test'
import {createMem0PersonalMemory} from '../src/mem0/resource.js'


test('real mem0 persists admissions before inference, preserves provenance and isolation, tombstones in-flight learning', {timeout: 20000}, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-mem0-'))
  const endpoint = await provider()
  const path = join(directory, 'personal.sqlite')
  const options = {path, userId: 'host-user', embedding: {baseUrl: endpoint.baseUrl, apiKey: 'test-key', model: 'embedding', dimensions: 2}, extractionModel: 'extract'}
  let store = createMem0PersonalMemory(options)
  const other = createMem0PersonalMemory({...options, userId: 'other-user'})
  t.after(async () => {await store.close(); await other.close(); await endpoint.close(); await rm(directory, {recursive: true, force: true})})
  await store.open()
  assert.equal(store.responseAdaptation, undefined)
  assert.deepEqual(await store.remember!(turn('slow', 'slow kiwi')), {state: 'stored', sourceId: 'slow'})
  await eventually(() => endpoint.calls.some(prompt => prompt.includes('slow kiwi')))
  assert.deepEqual(await store.remember!(turn('slow', 'slow kiwi')), {state: 'stored', sourceId: 'slow'})
  await assert.rejects(store.remember!(turn('slow', 'different source')))
  assert.equal((await store.recall('kiwi', {scope: 'any'})).state, 'empty')
  assert.equal((await store.recall('kiwi', {scope: 'any'})).degraded, true)
  const pending = await store.inspect!({query: 'kiwi'})
  assert.equal(pending.entries[0]?.state, 'pending')
  assert.equal(pending.entries[0]?.original, 'slow kiwi')
  assert.deepEqual(await store.forget!('slow'), {state: 'deleted', sourceId: 'slow'})
  endpoint.release()
  await store.remember!({...turn('apples', 'likes apples'), previousAssistantReply: 'Assistant context, never a new user claim'})
  await eventually(async () => (await store.recall('apples', {scope: 'any'})).hits.some(hit => hit.text === 'likes apples'))
  const hit = (await store.recall('apples', {scope: 'any'})).hits[0]!
  assert.deepEqual(hit.evidenceIds, ['apples'])
  assert.equal(hit.subject, 'host-user')
  const inspected = await store.inspect!({query: 'apples'})
  assert.deepEqual(inspected.entries[0]?.memories, ['likes apples'])
  assert.equal(inspected.entries[0]?.original, 'likes apples')
  assert.equal((await store.inspect!({query: 'kiwi'})).entries.length, 0)
  await assert.rejects(store.inspect!({query: 'x'.repeat(201)}))
  assert.equal((await store.recall('kiwi', {scope: 'any'})).hits.some(hit => hit.text === 'slow kiwi'), false)
  for (const name of ['ledger.db', 'vectors.db', 'vectors_entities.db']) {
    const metadata = await stat(join(userDirectory(path), name))
    assert.ok(metadata.isFile())
    // Windows does not expose owner-only POSIX mode bits through stat().
    if (process.platform !== 'win32') assert.equal(metadata.mode & 0o777, 0o600)
  }
  await store.close()
  store = createMem0PersonalMemory(options)
  await store.open()
  assert.ok((await store.recall('apples', {scope: 'any'})).hits.some(hit => hit.text === 'likes apples'))
  assert.deepEqual(await store.remember!(turn('slow', 'slow kiwi')), {state: 'deleted', sourceId: 'slow'})
  await other.open()
  assert.equal((await other.recall('apples', {scope: 'any'})).state, 'empty')
  assert.equal((await other.inspect!({})).entries.length, 0)
  await store.forget!('apples')
  assert.equal((await store.recall('apples', {scope: 'any'})).state, 'empty')
})

test('real mem0 retries durable pending sources on reopen without a retry spin', {timeout: 20000}, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-mem0-retry-'))
  const endpoint = await provider()
  const path = join(directory, 'personal.sqlite')
  const options = {path, userId: 'host-user', embedding: {baseUrl: endpoint.baseUrl, apiKey: 'test-key', model: 'embedding', dimensions: 2}, extractionModel: 'extract'}
  let store = createMem0PersonalMemory(options)
  t.after(async () => {await store.close(); await endpoint.close(); await rm(directory, {recursive: true, force: true})})
  await store.open()
  await store.remember!(turn('retry', 'retry mango'))
  await eventually(() => endpoint.calls.length === 1)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(endpoint.calls.length, 1)
  const ledger = new DatabaseSync(join(userDirectory(path), 'ledger.db'), {readOnly: true})
  assert.equal((ledger.prepare('SELECT state FROM sources WHERE id = ?').get('retry') as {state: string}).state, 'pending')
  ledger.close()
  await store.close(); endpoint.recover()
  store = createMem0PersonalMemory(options); await store.open()
  await eventually(async () => (await store.recall('mango', {scope: 'any'})).hits.length === 1)
  assert.equal(endpoint.calls.length, 2)
  await store.close(); store = createMem0PersonalMemory(options); await store.open()
  assert.equal((await store.recall('mango', {scope: 'any'})).hits.length, 1)
})

test('mem0 keeps swallowed embedding failures pending and recovers on reopen', {timeout: 20000}, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-mem0-embedding-'))
  const endpoint = await provider(true)
  const path = join(directory, 'personal.sqlite')
  const options = {path, userId: 'host-user', embedding: {baseUrl: endpoint.baseUrl, apiKey: 'test-key', model: 'embedding', dimensions: 2}, extractionModel: 'extract'}
  let store = createMem0PersonalMemory(options)
  t.after(async () => {await store.close(); await endpoint.close(); await rm(directory, {recursive: true, force: true})})
  await store.open()
  await store.remember!(turn('embedding-failure', 'I enjoy apples'))
  await eventually(() => endpoint.embeddingFailures >= 2)
  await new Promise(resolve => setTimeout(resolve, 100))
  const ledger = new DatabaseSync(join(userDirectory(path), 'ledger.db'), {readOnly: true})
  try {assert.equal(ledger.prepare('SELECT state FROM sources WHERE id=?').get('embedding-failure')?.state, 'pending')} finally {ledger.close()}
  assert.equal((await store.recall('apples', {scope: 'any'})).degraded, true)
  await store.close(); endpoint.recover()
  store = createMem0PersonalMemory(options); await store.open()
  await eventually(async () => (await store.recall('apples', {scope: 'any'})).hits.length === 1)
})

test('mem0 refuses symlink database files', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-mem0-link-'))
  const path = join(directory, 'personal.sqlite')
  const {mkdir, writeFile} = await import('node:fs/promises')
  await mkdir(userDirectory(path), {recursive: true, mode: 0o700})
  const target = join(directory, 'target'); await writeFile(target, '', {mode: 0o600})
  await symlink(target, join(userDirectory(path), 'vectors.db'))
  const store = createMem0PersonalMemory({path, userId: 'host-user', embedding: {baseUrl: 'https://example.invalid/v1', apiKey: 'test', model: 'embedding', dimensions: 2}})
  t.after(async () => {await store.close(); await rm(directory, {recursive: true, force: true})})
  await assert.rejects(store.open())
})

test('recent mem0 recall restricts candidates before ranking and validates source boundaries', {timeout: 20000}, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-mem0-recent-'))
  const endpoint = await provider()
  const path = join(directory, 'personal.sqlite')
  const store = createMem0PersonalMemory({path, userId: 'host-user', embedding: {baseUrl: endpoint.baseUrl, apiKey: 'test-key', model: 'embedding', dimensions: 2}, extractionModel: 'extract'})
  t.after(async () => {await store.close(); await endpoint.close(); await rm(directory, {recursive: true, force: true})})
  await store.open()
  for (let index = 0; index < 7; index++) {
    const id = `source-${index}`
    await store.remember!(turn(id, 'likes apples'))
    const ledger = new DatabaseSync(join(userDirectory(path), 'ledger.db'), {readOnly: true})
    try {await eventually(() => ledger.prepare('SELECT state FROM sources WHERE id=?').get(id)?.state === 'learned')}
    finally {ledger.close()}
  }
  const recent = await store.recall('apples', {scope: 'recent', limit: 5})
  assert.equal(recent.hits.length, 5)
  assert.ok(recent.hits.every(hit => !hit.evidenceIds.includes('source-0') && !hit.evidenceIds.includes('source-1')))
  const all = await store.recall('apples', {scope: 'any', limit: 5})
  assert.ok(all.hits.some(hit => hit.evidenceIds.includes('source-0') || hit.evidenceIds.includes('source-1')))
  await assert.rejects(async () => store.remember!({...turn('invalid'), sequence: Number.MAX_SAFE_INTEGER + 1}))
  await assert.rejects(async () => store.remember!(turn('invalid', 'a'.repeat(40_001))))
  await assert.rejects(async () => store.remember!({...turn('invalid'), previousAssistantReply: '\0'}))
  await store.remember!(turn('*', 'likes apples'))
  const ledger = new DatabaseSync(join(userDirectory(path), 'ledger.db'), {readOnly: true})
  try {await eventually(() => ledger.prepare('SELECT state FROM sources WHERE id=?').get('*')?.state === 'learned')}
  finally {ledger.close()}
  await store.forget!('*')
  await eventually(async () => (await store.recall('apples', {scope: 'any', limit: 5})).hits.length === 5)
  await store.forget!('future')
  assert.deepEqual(await store.remember!(turn('future')), {sourceId: 'future', state: 'deleted'})
})

test('mem0 rejects SDK wildcard identities before opening storage', async t => {
  const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-mem0-wildcard-'))
  t.after(()=>rm(directory,{recursive:true,force:true}))
  assert.throws(() => createMem0PersonalMemory({path:join(directory,'memory.sqlite'),userId:'*',
    embedding:{baseUrl:'https://example.invalid/v1',apiKey:'test',model:'embedding'}}))
})

test('desktop and phone workers serialize learning and recover when the owner terminates', {timeout: 20000}, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-mem0-shared-'))
  const endpoint = await provider()
  const path = join(directory, 'personal.sqlite')
  const options = {path, userId: 'host-user', embedding: {baseUrl: endpoint.baseUrl, apiKey: 'test', model: 'embedding', dimensions: 2}, extractionModel: 'extract'}
  const desktop = createMem0PersonalMemory(options)
  const phone = createMem0PersonalMemory(options)
  t.after(async () => {await desktop.close(); await phone.close(); await endpoint.close(); await rm(directory, {recursive: true, force: true})})
  await desktop.open()
  await desktop.remember!(turn('shared', 'slow kiwi'))
  await eventually(() => endpoint.calls.length === 1)
  await phone.open()
  await phone.remember!(turn('shared', 'slow kiwi'))
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(endpoint.calls.length, 1, 'second Worker must not extract a locked source')
  await desktop.close()
  const ledger = new DatabaseSync(join(userDirectory(path), 'ledger.db'))
  try {
    assert.equal(ledger.prepare('SELECT state FROM sources WHERE id=?').get('shared')?.state, 'pending')
    endpoint.release()
    await eventually(async () => (await phone.recall('kiwi', {scope: 'any'})).hits.length === 1)
    assert.equal(endpoint.calls.length, 2)
    assert.equal(ledger.prepare('SELECT state FROM sources WHERE id=?').get('shared')?.state, 'learned')
  } finally {ledger.close()}
})

 test('mem0 inspection uses bounded source pages without duplicates', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-mem0-pages-'))
  const endpoint = await provider()
  const store = createMem0PersonalMemory({path: join(directory, 'personal.sqlite'), userId: 'host-user',
    embedding: {baseUrl: endpoint.baseUrl, apiKey: 'test', model: 'embedding', dimensions: 2}})
  // Read-only SDK instances cannot admit sources; seed through a learning-capable worker.
  const writer = createMem0PersonalMemory({path: join(directory, 'personal.sqlite'), userId: 'host-user',
    embedding: {baseUrl: endpoint.baseUrl, apiKey: 'test', model: 'embedding', dimensions: 2}, extractionModel: 'extract'})
  t.after(async () => {
    await writer.close()
    await store.close()
    await endpoint.close()
    await rm(directory, {recursive: true, force: true})
  })
  await store.open()
  await writer.open()
  for (let i = 0; i < 12; i++) await writer.remember!(turn('page-' + i, 'slow kiwi ' + i))
  const first = await store.inspect!({})
  assert.equal(first.entries.length, 10)
  assert.ok(first.next)
  const second = await store.inspect!({before: first.next})
  assert.equal(second.entries.length, 2)
  assert.equal(second.next, null)
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.sourceId)).size, 12)
 })

test('maximal inspection page fits the desktop JSON byte limit even with escaped text', () => {
  const page = memoryInspectionSchema.parse({engine: 'mem0', next: null, entries: Array.from({length: 10}, () => ({
    sourceId: '\u0001'.repeat(256), state: 'learned', recordedAt: '\u0001'.repeat(64),
    original: '\u0001'.repeat(1500), memories: Array.from({length: 4}, () => '\u0001'.repeat(500)), truncated: true,
  }))})
  assert.ok(Buffer.byteLength(JSON.stringify({type: 'memory.board', request_id: 'x'.repeat(256), personal: page,
    channels: [], diagnostics: {version: 1, records: []}})) < MAX_BOARD_MESSAGE_BYTES)
})


test('mem0 routes extraction to its own connection while keeping embeddings separate', {timeout: 20000}, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-mem0-split-'))
  const embedding = await provider(), extraction = await provider()
  const store = createMem0PersonalMemory({path: join(directory, 'memory.sqlite'), userId: 'host-user',
    embedding: {baseUrl: embedding.baseUrl, apiKey: 'embedding-key', model: 'embedding', dimensions: 2},
    extraction: {baseUrl: extraction.baseUrl, apiKey: 'text-key'}, extractionModel: 'deepseek-flash'})
  t.after(async () => {await store.close(); await embedding.close(); await extraction.close(); await rm(directory, {recursive: true, force: true})})
  await store.open()
  await store.remember!(turn('separate', 'likes apples'))
  await eventually(async () => (await store.inspect!({})).entries.some(entry => entry.state === 'learned'))
  assert.ok(extraction.calls.length > 0)
  assert.equal(embedding.calls.length, 0, 'text extraction must never reach the embedding endpoint')
  assert.equal((await store.recall('likes apples')).hits.length, 1)
})

test('forget physically erases learned facts and source text from every sqlite file', {timeout: 20000}, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-mem0-erase-'))
  const endpoint = await provider()
  const path = join(directory, 'personal.sqlite')
  const store = createMem0PersonalMemory({path, userId: 'host-user',
    embedding: {baseUrl: endpoint.baseUrl, apiKey: 'test-key', model: 'embedding', dimensions: 2}, extractionModel: 'extract'})
  t.after(async () => {await store.close(); await endpoint.close(); await rm(directory, {recursive: true, force: true})})
  await store.open()
  await store.remember!(turn('apples', 'likes apples'))
  await eventually(async () => (await store.recall('apples', {scope: 'any'})).hits.length > 0)
  const base = userDirectory(path)
  const files = ['ledger.db', 'vectors.db', 'vectors_entities.db'].flatMap(name => [join(base, name), join(base, name + '-wal')])
  const contains = async (needle: string) => {
    for (const file of files) {
      const bytes = await readFile(file).catch(() => Buffer.alloc(0))
      if (bytes.includes(Buffer.from(needle))) return true
    }
    return false
  }
  assert.equal(await contains('likes apples'), true, 'the learned fact is stored before deletion')
  assert.deepEqual(await store.forget!('apples'), {state: 'deleted', sourceId: 'apples'})
  for (let attempt = 0; attempt < 100 && await contains('likes apples'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await store.close()
  assert.equal(await contains('likes apples'), false)
})

test('forgetSource pending deletion survives restart', {timeout: 25000}, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-mem0-interrupted-'))
  const endpoint = await provider()
  const path = join(directory, 'personal.sqlite')
  const options = {path, userId: 'host-user',
    embedding: {baseUrl: endpoint.baseUrl, apiKey: 'test-key', model: 'embedding', dimensions: 2}, extractionModel: 'extract'}
  let store = createMem0PersonalMemory(options)
  t.after(async () => {await store.close(); await endpoint.close(); await rm(directory, {recursive: true, force: true})})
  await store.open()
  await store.remember!(turn('apples', 'likes apples'))
  await eventually(async () => (await store.recall('apples', {scope: 'any'})).hits.length > 0)
  const lock=new DatabaseSync(join(userDirectory(path),'learning-lock.db'))
  lock.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE')
  await store.forgetSource!('apples')
  const db=new DatabaseSync(join(userDirectory(path),'ledger.db'))
  assert.equal(db.prepare('SELECT cleaned FROM sources WHERE id=?').get('apples')?.cleaned,0)
  db.close()
  // Hold the learning lock until termination so cleanup is deterministically still pending.
  await store.close()
  lock.exec('ROLLBACK');lock.close()
  store = createMem0PersonalMemory(options)
  await store.open()
  const base = userDirectory(path)
  const files = ['ledger.db', 'vectors.db', 'vectors_entities.db'].flatMap(name => [join(base, name), join(base, name + '-wal')])
  const contains = async (needle: string) => {
    for (const file of files) {
      const bytes = await readFile(file).catch(() => Buffer.alloc(0))
      if (bytes.includes(Buffer.from(needle))) return true
    }
    return false
  }
  for (let attempt = 0; attempt < 150 && await contains('likes apples'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const remainingFiles=[]
  for(const file of files) if((await readFile(file).catch(()=>Buffer.alloc(0))).includes(Buffer.from('likes apples'))) remainingFiles.push(file.split('/').pop())
  const state=new DatabaseSync(join(base,'ledger.db'))
  const cleanup={sources:state.prepare('SELECT id,state,cleaned FROM sources').all(),meta:state.prepare('SELECT * FROM meta').all()}
  state.close()
  assert.equal(await contains('likes apples'), false, JSON.stringify({remainingFiles,cleanup}))
})

test('mem0 get/getMany/list, raw evidence, revision-safe edits and forget survive restart and re-extraction', {timeout:25000}, async t => {
  const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-mem0-entries-'))
  const endpoint=await provider()
  const path=join(directory,'memory.sqlite')
  const options={path,userId:'host-user',conversationProviders:['model-a'],embedding:{baseUrl:endpoint.baseUrl,apiKey:'test',model:'embedding',dimensions:2},extractionModel:'extract'}
  let store=createMem0PersonalMemory(options)
  t.after(async()=>{await store.close();await endpoint.close();await rm(directory,{recursive:true,force:true})})
  await store.open()
  assert.deepEqual(store.capabilities!(),{list:true,get:true,correct:true,forgetEntry:true,forgetSource:true})
  for(const id of ['one','two','three']) {
    await store.remember!(turn(id,`User RAW turn ${id}: I enjoy apples`))
    await eventually(async()=> (await store.inspect!({})).entries.some(row=>row.sourceId===id&&row.state==='learned'))
  }
  const first=await store.list!({limit:2})
  assert.equal(first.entries.length,2);assert.ok(first.cursor)
  const second=await store.list!({limit:2,cursor:first.cursor})
  assert.equal(second.entries.length,1);assert.equal(second.cursor,null)
  assert.equal(new Set([...first.entries,...second.entries].map(row=>row.id)).size,3)
  await assert.rejects(store.list!({limit:101}))
  const original=first.entries[0]!,removed=second.entries[0]!,sourceId=original.evidence_refs![0]!
  assert.equal(original.content,'likes apples');assert.ok(original.version)
  assert.deepEqual(await store.getMany!([original.id,'missing',original.id]),[original,null,original])
  assert.equal((await store.readEvidence!(sourceId))?.text,`User RAW turn ${sourceId}: I enjoy apples`)
  assert.equal(await store.canReadConversationEvidence!(sourceId,'model-a'),true)
  assert.equal(await store.canReadConversationEvidence!(sourceId,'model-b'),false)
  assert.equal(await store.canReadConversationEvidence!(sourceId,''),false)
  assert.equal((await new UnifiedRetrieval({memory:()=>store}).recall('apples')).entries.length,0,'missing consumer fails closed')
  const changed=await store.correct!(original.id,original.version,'prefers pears',{type:'conversation',ref:'user-correction',observed_at:'2026-11-02T00:00:00Z'})
  assert.equal(changed.entry.id,original.id);assert.notEqual(changed.entry.version,original.version)
  await assert.rejects(store.correct!(original.id,original.version,'stale',{type:'conversation',ref:'stale',observed_at:'2026-11-02T00:00:00Z'}),{code:'STORE_STALE_REVISION'})
  await assert.rejects(store.forgetEntry!(original.id,original.version),{code:'STORE_STALE_REVISION'})
  assert.equal((await store.forgetEntry!(removed.id,removed.version)).status,'forgotten')
  assert.equal(await store.get!(removed.id),null)
  assert.equal((await store.inspect!({})).entries.find(row=>row.sourceId===sourceId)?.memories[0],'prefers pears')
  await store.close()
  // Force a pending extraction as after an interrupted retry. Edited sources must never re-add old facts under new SDK ids.
  const db=new DatabaseSync(join(userDirectory(path),'ledger.db'))
  db.prepare("UPDATE sources SET state='pending' WHERE id IN (?,?)").run(sourceId,removed.evidence_refs![0]!)
  db.close()
  store=createMem0PersonalMemory(options);await store.open()
  await eventually(async()=> (await store.get!(original.id))?.content==='prefers pears')
  assert.equal((await store.get!(original.id))?.version,changed.entry.version)
  assert.equal(await store.get!(removed.id),null)
  const recalled=await store.recall('apples',{scope:'any'})
  assert.equal(recalled.hits.find(hit=>hit.memoryId===original.id)?.text,'prefers pears')
  assert.equal(recalled.hits.some(hit=>hit.evidenceIds.includes(removed.evidence_refs![0]!)),false)
  await store.forgetSources!([sourceId,removed.evidence_refs![0]!])
  assert.equal(await store.readEvidence!(sourceId),null)
  assert.equal(await store.canReadConversationEvidence!(sourceId,'model-a'),false)
  assert.equal(await store.get!(original.id),null)
})

test('mem0 legacy and changed consumer grants fail closed while host-local entries stay visible', {timeout:20000}, async t=>{
  const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-mem0-consent-'))
  const endpoint=await provider(),path=join(directory,'memory.sqlite')
  const options={path,userId:'host-user',embedding:{baseUrl:endpoint.baseUrl,apiKey:'test',model:'embedding',dimensions:2},extractionModel:'extract'}
  let store=createMem0PersonalMemory(options)
  t.after(async()=>{await store.close();await endpoint.close();await rm(directory,{recursive:true,force:true})})
  await store.open();await store.remember!(turn('legacy','raw apples'))
  await eventually(async()=> (await store.list!()).entries.length===1)
  await store.close()
  // Simulate the actual pre-migration sources table, rather than just an empty grant.
  const db=new DatabaseSync(join(userDirectory(path),'ledger.db'));db.exec('ALTER TABLE sources DROP COLUMN conversation_providers');db.close()
  store=createMem0PersonalMemory({...options,conversationProviders:['model-a']});await store.open()
  assert.equal((await store.list!()).entries.length,1)
  const retrieval=new UnifiedRetrieval({memory:()=>store})
  assert.equal((await retrieval.recall('apples',{consumer:'model-a'})).state,'empty')
  assert.equal((await retrieval.evidence('legacy',{consumer:'model-a'})).state,'gone')
  await store.remember!(turn('new','new raw apples'))
  await eventually(async()=> (await store.list!()).entries.length===2)
  assert.equal(await store.canReadConversationEvidence!('new','model-a'),true)
  await store.close();store=createMem0PersonalMemory({...options,conversationProviders:['model-b']});await store.open()
  assert.equal(await store.canReadConversationEvidence!('new','model-a'),false,'current config also required')
  assert.equal(await store.canReadConversationEvidence!('new','model-b'),false,'new config cannot grant old sources')
  let consumer:string|undefined='model-b'
  const host=new PersonalAgentHost({path:join(directory,'host.json'),userScope:'test',memory:()=>store,pool:new SuggestionPool(),evidence:()=>null,discoveryMemoryConsumer:()=>consumer})
  t.after(()=>host.close())
  await host.open()
  assert.deepEqual((await host.discoverySnapshot()).memory,[],'legacy and changed-destination entries never enter discovery')
  assert.equal(host.snapshot().memory.entries.length,2,'host-local listing is unrestricted')
  await store.remember!(turn('allowed','allowed raw apples'))
  await eventually(async()=> (await store.list!()).entries.length===3)
  assert.deepEqual((await host.discoverySnapshot()).memory,[],'even granted mem0 text is not a product substrate')
  assert.ok((await retrieval.recall('apples',{consumer:'model-b'})).entries.some(row=>row.evidence_refs.includes('allowed')),'granted recall remains available')
  consumer=undefined
  assert.deepEqual((await host.discoverySnapshot()).memory,[],'missing destination fails closed')
  consumer='model-b'
  const check=t.mock.method(store as typeof store & {canReadConversationEvidence:NonNullable<typeof store.canReadConversationEvidence>},'canReadConversationEvidence',()=>Promise.reject(Error('private diagnostic')))
  assert.deepEqual((await host.discoverySnapshot()).memory,[],'failed authorization fails closed')
  check.mock.restore()
  await store.remember!(turn('legacy','raw apples'))
  assert.equal(await store.canReadConversationEvidence!('legacy','model-b'),true,'identical admission refreshes an empty grant')
  await store.remember!(turn('new','new raw apples'))
  assert.equal(await store.canReadConversationEvidence!('new','model-b'),false,'nonempty grants never widen')
  await store.forgetSource!('legacy')
  await store.remember!(turn('legacy','raw apples'))
  assert.equal(await store.canReadConversationEvidence!('legacy','model-b'),false,'tombstones never acquire grants')
})

test('host Memory-page capabilities and mobile list/correct/forget commands reach mem0', {timeout:20000},async t=>{
  const {PersonalAgentHost}=await import('../src/personal-agent/host.js')
  const {SuggestionPool}=await import('../src/core/suggestions.js')
  const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-mem0-host-')),endpoint=await provider()
  const store=createMem0PersonalMemory({path:join(directory,'memory.sqlite'),userId:'host-user',embedding:{baseUrl:endpoint.baseUrl,apiKey:'test',model:'embedding',dimensions:2},extractionModel:'extract'})
  const host=new PersonalAgentHost({path:join(directory,'host.json'),userScope:'test',memory:()=>store,pool:new SuggestionPool(),evidence:()=>null})
  t.after(async()=>{await host.close();await store.close();await endpoint.close();await rm(directory,{recursive:true,force:true})})
  await store.open();await store.remember!(turn('host-source','raw apples'))
  await eventually(async()=> (await store.list!()).entries.length===1)
  await host.open()
  const capabilities=host.snapshot().capabilities.memory
  assert.equal(capabilities.purgeEntry,false)
  assert.equal(capabilities.includeExpired,false)
  for(const key of ['list','get','correct','forgetEntry','forgetSource'] as const) assert.equal(capabilities[key],true)
  const entry=(await store.list!()).entries[0]!
  const command=(request_id:string,method:string,params:Record<string,unknown>)=>host.command({type:'personal.command',request_id,method,params})
  assert.equal((await command('expired','memory.list',{include_expired:true}) as {ok:boolean}).ok,false)
  assert.equal(host.snapshot().memory.include_expired,false)
  await host.refreshMemory()
  assert.equal((await host.discoverySnapshot()).memory.length,0)
  assert.equal((await command('list','memory.list',{}) as {ok:boolean}).ok,true)
  assert.equal((await command('correct','memory.correct',{id:entry.id,expected_version:entry.version,content:'host corrected pears'}) as {ok:boolean}).ok,true)
  const changed=(await store.get!(entry.id))!
  assert.equal(changed.content,'host corrected pears')
  assert.equal((await command('forget','memory.forget',{id:entry.id,expected_version:changed.version}) as {ok:boolean}).ok,true)
  assert.equal(await store.get!(entry.id),null)
})


test('mem0 canonical content is bounded identically for recall and get, including astral characters', {timeout:20000},async t=>{
  const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-mem0-canonical-')),endpoint=await provider(false,'x'.repeat(499)+'😀tail')
  const store=createMem0PersonalMemory({path:join(directory,'memory.sqlite'),userId:'host-user',conversationProviders:['model-a'],embedding:{baseUrl:endpoint.baseUrl,apiKey:'test',model:'embedding',dimensions:2},extractionModel:'extract'})
  t.after(async()=>{await store.close();await endpoint.close();await rm(directory,{recursive:true,force:true})})
  await store.open();await store.remember!(turn('long','raw original turn'))
  await eventually(async()=> (await store.list!()).entries.length===1)
  const hit=(await store.recall('x',{scope:'any'})).hits[0]!,entry=(await store.get!(hit.memoryId))!
  assert.equal(entry.content.length,499);assert.equal(entry.content,hit.text.slice(0,500));assert.ok(entry.version)
  const result=await new UnifiedRetrieval({memory:()=>store}).recall('x',{consumer:'model-a'})
  assert.equal(result.entries.length,1);assert.equal(result.degraded,false)
})


test('mem0 forgotten item cleanup finishes after restart when SDK deletion already completed', {timeout:20000},async t=>{
  const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-mem0-item-retry-')),endpoint=await provider()
  const path=join(directory,'memory.sqlite'),options={path,userId:'host-user',embedding:{baseUrl:endpoint.baseUrl,apiKey:'test',model:'embedding',dimensions:2},extractionModel:'extract'}
  let store=createMem0PersonalMemory(options)
  t.after(async()=>{await store.close();await endpoint.close();await rm(directory,{recursive:true,force:true})})
  await store.open();await store.remember!(turn('item','raw apples'))
  await eventually(async()=> (await store.list!()).entries.length===1)
  const entry=(await store.list!()).entries[0]!
  await store.forgetEntry!(entry.id,entry.version)
  const db=new DatabaseSync(join(userDirectory(path),'ledger.db'));t.after(()=>db.close())
  await eventually(()=>db.prepare('SELECT cleaned FROM item_edits WHERE id=?').get(entry.id)?.cleaned===1)
  await store.close()
  db.prepare('UPDATE item_edits SET cleaned=0 WHERE id=?').run(entry.id)
  db.exec("INSERT OR REPLACE INTO meta(key,value) VALUES ('compaction_pending','1')")
  store=createMem0PersonalMemory(options);await store.open()
  await eventually(()=>db.prepare('SELECT cleaned FROM item_edits WHERE id=?').get(entry.id)?.cleaned===1 && !db.prepare("SELECT 1 FROM meta WHERE key='compaction_pending'").get())
  assert.equal(await store.get!(entry.id),null)
})

test('mem0 serializes simultaneous opens migrating a legacy sources table', {timeout:20000},async t=>{
  const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-mem0-migration-')),endpoint=await provider()
  const path=join(directory,'memory.sqlite'),options={path,userId:'host-user',embedding:{baseUrl:endpoint.baseUrl,apiKey:'test',model:'embedding',dimensions:2}}
  const seed=createMem0PersonalMemory(options),first=createMem0PersonalMemory(options),second=createMem0PersonalMemory(options)
  t.after(async()=>{await seed.close();await first.close();await second.close();await endpoint.close();await rm(directory,{recursive:true,force:true})})
  await seed.open();await seed.close()
  const db=new DatabaseSync(join(userDirectory(path),'ledger.db'))
  db.exec('ALTER TABLE sources DROP COLUMN conversation_providers');db.close()
  await Promise.all([first.open(),second.open()])
  assert.deepEqual(await first.list!(),{entries:[],cursor:null})
  assert.deepEqual(await second.list!(),{entries:[],cursor:null})
})

test('mem0 limit-one pages cover five items and reject expired-history requests', {timeout:20000},async t=>{
  const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-mem0-list-pages-')),endpoint=await provider()
  const store=createMem0PersonalMemory({path:join(directory,'memory.sqlite'),userId:'host-user',embedding:{baseUrl:endpoint.baseUrl,apiKey:'test',model:'embedding',dimensions:2},extractionModel:'extract'})
  t.after(async()=>{await store.close();await endpoint.close();await rm(directory,{recursive:true,force:true})})
  await store.open()
  for(let i=0;i<5;i++){await store.remember!(turn('page-'+i,'raw apples'));await eventually(async()=> (await store.list!()).entries.length===i+1)}
  const ids:string[]=[];let cursor:string|null=null
  do {const page=await store.list!({limit:1,...(cursor?{cursor}:{})});assert.equal(page.entries.length,1);ids.push(page.entries[0]!.id);cursor=page.cursor}while(cursor)
  assert.equal(ids.length,5);assert.equal(new Set(ids).size,5)
  assert.deepEqual(ids,(await store.list!()).entries.map(row=>row.id))
  await assert.rejects(store.list!({include_expired:true}),{code:'STORE_INVALID_INPUT'})
  assert.equal((await store.list!({include_expired:false})).entries.length,5)
})

test('mem0 read failures use content-free read error codes', {timeout:20000},async t=>{
  const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-mem0-read-errors-')),endpoint=await provider(),path=join(directory,'memory.sqlite')
  const store=createMem0PersonalMemory({path,userId:'host-user',conversationProviders:['model-a'],embedding:{baseUrl:endpoint.baseUrl,apiKey:'test',model:'embedding',dimensions:2},extractionModel:'extract'})
  t.after(async()=>{await store.close();await endpoint.close();await rm(directory,{recursive:true,force:true})})
  await store.open();await store.remember!(turn('broken','raw apples'))
  await eventually(async()=> (await store.list!()).entries.length===1)
  const id=(await store.list!()).entries[0]!.id,db=new DatabaseSync(join(userDirectory(path),'ledger.db'))
  db.exec("UPDATE sources SET payload='invalid private payload',conversation_providers='invalid private grant'; DROP TABLE item_edits");db.close()
  for(const read of [()=>store.get!(id),()=>store.getMany!([id]),()=>store.list!(),()=>store.readEvidence!('broken'),()=>store.canReadConversationEvidence!('broken','model-a'),()=>store.inspect!({query:'apples'})]){
    await assert.rejects(read(),error=>{assert.equal((error as {code:string}).code,'STORE_READ_FAILED');assert.equal((error as Error).message,'personal_memory_error');return true})
  }
})

test('mem0 forgetSources attempts every source before a content-free aggregate failure and permits retry',async t=>{
  const attempts:string[]=[];let reject=true
  t.mock.method(PersonalMemoryStoreClient.prototype,'forgetSource',(ref:string)=>{attempts.push(ref);return ref==='second'&&reject?Promise.reject(Error('private source detail')):Promise.resolve()})
  const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-mem0-forget-many-'))
  const store=createMem0PersonalMemory({path:join(directory,'memory.sqlite'),userId:'host-user',embedding:{baseUrl:'https://example.invalid',apiKey:'test',model:'embedding'}})
  t.after(async()=>{try{await store.close()}finally{await rm(directory,{recursive:true,force:true})}})
  await assert.rejects(store.forgetSources!(['first','second','third']),{message:'personal_memory_error'})
  assert.deepEqual(attempts,['first','second','third'])
  reject=false
  await store.forgetSources!(['first','second','third'])
  assert.deepEqual(attempts,['first','second','third','first','second','third'])
  await store.close()
})


test('mem0 scheduled recall verification follows only the granted support route', {timeout:20000},async t=>{
  const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-mem0-routed-host-')),endpoint=await provider()
  const routeA=settingsSchema.parse({executors:[],dashscope_api_key:'test',support_model:'legacy-support',model_routes:{support:{provider:'qwen',model:'support-a'}}})
  const routeB=settingsSchema.parse({...routeA,model_routes:{support:{provider:'qwen',model:'support-b'}}})
  const store=createMem0PersonalMemory({path:join(directory,'memory.sqlite'),userId:'host-user',conversationProviders:configuredMemoryConsumers(routeA),embedding:{baseUrl:endpoint.baseUrl,apiKey:'test',model:'embedding',dimensions:2},extractionModel:'extract'})
  const host=new PersonalAgentHost({path:join(directory,'host.json'),userScope:'test',memory:()=>store,pool:new SuggestionPool(),evidence:()=>null})
  t.after(async()=>{await host.close();await store.close();await endpoint.close();await rm(directory,{recursive:true,force:true})})
  await store.open();await store.remember!(turn('routed-source','raw apples'))
  await eventually(async()=> (await store.list!()).entries.length===1)
  await host.open()
  const consumer=configuredDiscoveryConsumer(routeA)!,retrieval=new UnifiedRetrieval({memory:()=>store})
  const projection=await retrieval.recall('apples',{consumer})
  assert.ok(projection.snippets.some(row=>row.evidence_id==='routed-source'))
  const task=await host.tasks.delegate('routed-task',{conversation_id:'chat:main',goal:'Read memory',acceptance:['Summary'],origin_ref:'conversation:1'})
  const fence={task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision}
  await host.tasks.recordContextEvidence(fence,'read',JSON.stringify({consumer,projection}),['routed-source'])
  assert.equal(await host.appContext.validateTask(task.id,consumer,configuredTaskVerifierConsumer(routeA)),true)
  assert.equal(await host.appContext.validateTask(task.id,consumer,configuredTaskVerifierConsumer(routeB)),false,'changing only support route cannot authorize verification')
})
