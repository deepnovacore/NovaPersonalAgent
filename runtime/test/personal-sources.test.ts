import assert from 'node:assert/strict'
import {VoiceMem} from 'voicemem'
import {VersionedMemory} from '../src/voicemem/versioned-memory.js'
import {mkdtemp, mkdir, writeFile, rm, realpath, symlink, rename, readFile, utimes} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {LocalDirectorySources} from '../src/personal-agent/sources.js'
import {orderComputerRoots} from '../src/personal-agent/source-priority.js'
import {KnowledgeService} from '../src/knowledge/service.js'
import {KnowledgeStoreClient} from '../src/knowledge/store-client.js'

async function fixture(realMemory = false, priorityWorkspace?:()=>Promise<string|null>) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'nova-directory-'))
  const folder = join(root, 'allowed'); await mkdir(folder)
  let failEmbedding = false, failInvalidation = false, failConsent=false
  let embeddingHook: () => Promise<void> = () => Promise.resolve()
  const knowledge = new KnowledgeService({store: new KnowledgeStoreClient({path: join(root, 'db', 'knowledge.sqlite')}),
    embedding: {id: 'test', dims: 2, embed: texts => failEmbedding ? Promise.reject(new Error('offline')) : embeddingHook().then(() => texts.map(() => new Float32Array([1, 0])))}})
  await knowledge.open()
  const embeddings = {model:'test', embed: (texts: readonly string[]) => Promise.resolve(texts.map(() => [1,0]))}
  const native = realMemory ? new VoiceMem({path:join(root,'memory.sqlite'), userId:'test', embeddings, model:{complete:()=> Promise.resolve('{}')}}) : undefined
  const memory = native ? new VersionedMemory(native,'test',embeddings) : undefined
  let memoryAvailable = true
  const invalidated: string[] = []
  const observations: {content: string; source_ref: {ref: string}}[] = []
  const options = {computerRoot:folder,...(priorityWorkspace?{priorityWorkspace}:{}),processingGrant:(consent:boolean,revision:number,scope_revision:number)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null}),path: join(root, 'db', 'sources.json'), knowledge, pollMs: 0,
    onProcessingConsent:()=>failConsent?Promise.reject(Error('grant_write_failed')):Promise.resolve(),
    onObserve: async (value: {content: string; source_ref: {type:'file'; ref: string; observed_at:string}; topic?:string}) => {
      if (!memoryAvailable) throw new Error('memory_unavailable')
      if (memory) await memory.observeSource(value)
      observations.push(value)
    },
    onInvalidate: (ref: string) => { if (failInvalidation) throw new Error('interrupted'); invalidated.push(ref); memory?.forgetSource(ref) }}
  let sources = new LocalDirectorySources(options)
  await sources.open()
  return {root, folder, knowledge, invalidated, observations, memory, setFailConsent(value:boolean){failConsent=value},setMemoryAvailable(value:boolean) {memoryAvailable=value}, setEmbeddingHook(hook: () => Promise<void>) {embeddingHook = hook}, setFail(value: boolean) {failEmbedding = value}, setFailInvalidation(value: boolean) {failInvalidation = value}, get sources() {return sources},
    reopen: async () => {await sources.close(); sources = new LocalDirectorySources(options); await sources.open()},
    close: async () => {await sources.close(); await knowledge.close(); await native?.close(); await rm(root, {recursive: true, force: true})}}
}

test('failed authority update does not publish a durable successful consent revocation',async()=>{
 const f=await fixture()
 try{
  await f.sources.command('sources.add',{path:f.folder,consent:true});f.setFailConsent(true)
  await assert.rejects(f.sources.command('sources.consent',{id:f.sources.list()[0]!.id,consent:false}),/grant_write_failed/)
  await f.reopen()
  assert.equal(f.sources.list()[0]!.processing_consent_required,false)
 }finally{await f.close()}
})

test('changed processing provider requires renewed consent',async()=>{
 const f=await fixture()
 try{
  await f.sources.command('sources.add',{path:f.folder,consent:true});await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{processing_consent:{extraction_provider:string}}[]}
  state.sources[0]!.processing_consent.extraction_provider='old-provider';await writeFile(path,JSON.stringify(state));await f.reopen()
  assert.equal(f.sources.list()[0]!.processing_consent_required,true)
 }finally{await f.close()}
})

test('snapshot open reads indexed file context without starting a scan',async()=>{
 const f=await fixture()
 try{
  await writeFile(join(f.folder,'readme.md'),'Next step: review the local note.')
  await f.sources.command('sources.add',{path:f.folder,consent:true})
  await f.sources.close()
  await writeFile(join(f.folder,'new.md'),'New file should not be indexed by a snapshot open.')
  let syncCalls=0
  const sources=new LocalDirectorySources({path:join(f.root,'db','sources.json'),pollMs:0,scanOnOpen:false,
   processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null}),
   knowledge:{listSources:()=>f.knowledge.listSources(),handle:(...args)=>f.knowledge.handle(...args),syncFile:(...args)=>{syncCalls++;return f.knowledge.syncFile(...args)}}})
  try{await sources.open();assert.equal(syncCalls,0);assert.equal(sources.contextEntries().length,1);assert.match(sources.contextEntries()[0]!.content,/review the local note/u)}finally{await sources.close()}
 }finally{await f.close()}
})

test('source state with a legacy 51st failure still opens and keeps the failure cap',async()=>{
 const f=await fixture()
 try{
  await f.sources.command('sources.add',{path:f.folder,consent:true});await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{view:{failures:{path:string;code:string}[]}}[]}
  state.sources[0]!.view.failures=Array.from({length:51},(_,index)=>({path:`file-${index}`,code:'source_unavailable'}))
  await writeFile(path,JSON.stringify(state))
  const sources=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
  try{await sources.open();assert.equal(sources.list()[0]!.failures.length,50);assert.equal(sources.list()[0]!.failures[0]!.path,'file-1');assert.equal(sources.list()[0]!.failures.at(-1)!.path,'file-50')}finally{await sources.close()}
 }finally{await f.close()}
})

test('computer scan settles files larger than its total byte budget without retrying them',async()=>{
 const f=await fixture()
 try{
  const oversized=join(f.folder,'oversized.md');await writeFile(oversized,'01234567890')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{view:{max_bytes:number};walk:unknown}[]}
  state.sources[0]!.view.max_bytes=10
  state.sources[0]!.walk={queue:[],pending:[{path:oversized,size:11,mtime:1,unit:f.folder}]}
  await writeFile(path,JSON.stringify(state))
  const sources=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,computerRoot:f.folder,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
  try{
   await sources.open();await sources.command('sources.sync',{id})
   const source=sources.list()[0]!
   const saved=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:{pending:{path:string}[]}|null}[]}
   assert.equal(source.reasons.body_budget,1)
   assert.equal(source.scan_pending,false)
   assert.equal(source.coverage,'partial')
   assert.equal(source.health,'degraded')
   assert.equal(saved.sources[0]!.walk?.pending?.some(file=>file.path===oversized)??false,false)
  }finally{await sources.close()}
 }finally{await f.close()}
})

test('computer snapshots migrate legacy failures and clear current health after a clean batch',async()=>{
 const f=await fixture()
 try{
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{view:{state:string;failures:{path:string;code:string}[]};walk:unknown}[]}
  state.sources[0]!.view.failures=Array.from({length:51},(_,index)=>({path:`file-${index}`,code:'source_unavailable'}))
  state.sources[0]!.view.state='error'
  state.sources[0]!.walk={queue:[],pending:[]}
  await writeFile(path,JSON.stringify(state))
  const sources=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,computerRoot:f.folder,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
  try{
   await sources.open();assert.ok(sources.list()[0]!.failures.length<=50)
   await sources.command('sources.sync',{id})
   const source=sources.list()[0]!
   assert.equal(source.state,'connected')
   assert.ok(source.failures.length<=50)
   assert.equal(source.failures.at(-1)?.path,'file-50')
  }finally{await sources.close()}
 }finally{await f.close()}
})

test('computer walk migrates legacy pending items at the index limit and settles them',async()=>{
 const f=await fixture()
 try{
  const pending=join(f.folder,'overflow.md');await writeFile(pending,'overflow')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:unknown;files:unknown[];view:unknown}[]}
  state.sources[0]!.files=Array.from({length:20000},(_,index)=>({path:join(f.folder,`old-${index}.md`),id:`id-${index}`,fingerprint:'x',size:1,mtime:1,owned:true,valid:true,excerpt:null,observed:true,observation_ref:null}))
  state.sources[0]!.walk={queue:[],pending:[{path:pending,size:8,mtime:1,unit:f.folder}]}
  await writeFile(path,JSON.stringify(state))
  const sources=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,computerRoot:f.folder,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
  try{
   await sources.open();await sources.command('sources.sync',{id})
   assert.equal(sources.list()[0]!.reasons.index_limit,1)
   assert.equal(sources.list()[0]!.scan_pending,false)
  }finally{await sources.close()}
 }finally{await f.close()}
})

test('computer ingestion failures move to a bounded future retry with an attempt count',async()=>{
 const f=await fixture()
 try{
  const file=join(f.folder,'retry.md');await writeFile(file,'retry this later')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:unknown}[]}
  state.sources[0]!.walk={queue:[],pending:[{path:file,size:16,mtime:1,unit:f.folder}]}
  await writeFile(path,JSON.stringify(state));f.setFail(true)
  const sources=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,computerRoot:f.folder,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
  try{
   await sources.open();await sources.command('sources.sync',{id})
   const saved=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:{deferred:{path:string;attempts:number;eligible_at:number}[]}|null}[]}
   const retry=saved.sources[0]!.walk?.deferred.find(item=>item.path===file)
   assert.equal(sources.list()[0]!.scan_pending,true)
   assert.equal(retry?.attempts,1)
   assert.ok((retry?.eligible_at??0)>Date.now())
  }finally{await sources.close()}
 }finally{await f.close()}
})

test('full pending and deferred computer queues stay bounded across sync and reopen',async()=>{
 const f=await fixture()
 try{
  const first=join(f.folder,'pending-0.md');await writeFile(first,'x')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{view:{max_bytes:number};walk:unknown}[]}
  const pending=Array.from({length:200},(_,index)=>({path:index===0?first:join(f.folder,`pending-${index}.md`),size:1,mtime:1,unit:f.folder}))
  const deferred=Array.from({length:200},(_,index)=>({path:join(f.folder,`deferred-${index}.md`),size:1,mtime:1,unit:f.folder,eligible_at:0,attempts:1,reason:'retry'}))
  state.sources[0]!.view.max_bytes=1
  state.sources[0]!.walk={queue:[],pending,deferred}
  await writeFile(path,JSON.stringify(state))
  const sources=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,computerRoot:f.folder,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
  try{
   await sources.open();await sources.command('sources.sync',{id})
   assert.equal(sources.list()[0]!.scan_pending,true)
   await sources.close()
   const reopened=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,computerRoot:f.folder,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
   try{
    await reopened.open()
    const saved=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:{pending:{path:string}[];deferred:{path:string}[]}|null}[]}
    assert.ok((saved.sources[0]!.walk?.pending.length??0)<=200)
    assert.ok((saved.sources[0]!.walk?.deferred.length??0)<=200)
    assert.equal((saved.sources[0]!.walk?.pending.length??0)+(saved.sources[0]!.walk?.deferred.length??0),399)
   }finally{await reopened.close()}
  }finally{await sources.close()}
 }finally{await f.close()}
})

test('current read failures report partial health without making source state error',async()=>{
 const f=await fixture();f.setFail(true)
 try{
  await writeFile(join(f.folder,'failure.md'),'content that cannot be embedded now')
  await f.sources.command('sources.add',{path:f.folder,consent:true})
  const source=f.sources.list()[0]!
  assert.equal(source.state,'connected')
  assert.equal(source.health,'degraded')
  assert.equal(source.coverage,'partial')
  assert.equal(source.failures.length,1)
 }finally{await f.close()}
})

test('successful retry clears current degraded health while retaining read failure diagnostics',async()=>{
 const f=await fixture()
 try{
  const file=join(f.folder,'recover.md');await writeFile(file,'retry can recover this source')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.close()
  const path=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:unknown}[]}
  state.sources[0]!.walk={queue:[],pending:[{path:file,size:29,mtime:1,unit:f.folder}]}
  await writeFile(path,JSON.stringify(state));f.setFail(true)
  const sources=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,computerRoot:f.folder,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
  try{
   await sources.open();await sources.command('sources.sync',{id})
   assert.equal(sources.list()[0]!.health,'degraded')
   assert.equal(sources.list()[0]!.coverage,'partial')
   await sources.close()
   const retryState=JSON.parse(await readFile(path,'utf8')) as {sources:{walk:{deferred:{eligible_at:number}[]}|null}[]}
   assert.ok(retryState.sources[0]!.walk?.deferred.length)
   retryState.sources[0]!.walk!.deferred[0]!.eligible_at=0
   await writeFile(path,JSON.stringify(retryState));f.setFail(false)
   const retrying=new LocalDirectorySources({path,pollMs:0,scanOnOpen:false,computerRoot:f.folder,knowledge:f.knowledge,processingGrant:(consent,revision,scope_revision)=>({revision,scope_revision,extraction_provider:consent?'test':null,embedding_provider:consent?'test':null})})
   try{
    await retrying.open();await retrying.command('sources.sync',{id})
    const recovered=retrying.list()[0]!
    assert.equal(recovered.scan_pending,false)
    assert.equal(recovered.health,'healthy')
    assert.equal(recovered.coverage,'complete')
    assert.equal(recovered.reasons.read_failed,1)
   }finally{await retrying.close()}
  }finally{await sources.close()}
 }finally{await f.close()}
})

test('legacy directory state without processing consent reads locally without embedding',async()=>{
 const f=await fixture();let embeddings=0
 try{
  await writeFile(join(f.folder,'readme.md'),'before')
  await f.sources.command('sources.add',{path:f.folder,consent:true});await f.sources.close()
  const path=join(f.root,'db','sources.json');const state=JSON.parse(await readFile(path,'utf8')) as {sources:{processing_consent?:unknown}[]}
  delete state.sources[0]!.processing_consent;await writeFile(path,JSON.stringify(state))
  await writeFile(join(f.folder,'another.md'),'new local content')
  f.setEmbeddingHook(()=>{embeddings++;return Promise.resolve()});await f.reopen()
  assert.equal(embeddings,0);assert.equal(f.sources.list()[0]!.processing_consent_required,true)
  assert.ok((await f.knowledge.listSources()).some(s=>s.locator.endsWith('another.md')))
 }finally{await f.close()}
})

test('local sources use explicit grants, exclude private trees and reconcile durable scoped knowledge', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.folder, 'readme.md'), 'The blue lamp is ready.')
    for (const name of ['.git', 'node_modules', 'Browser']) {await mkdir(join(f.folder, name)); await writeFile(join(f.folder, name, 'private.md'), 'Never read this')}
    await writeFile(join(f.folder, '.env'), 'secret')
    await writeFile(join(f.root, 'outside.md'), 'Outside grant')
    await symlink(join(f.root, 'outside.md'), join(f.folder, 'escape.md'))
    await assert.rejects(f.sources.command('sources.add', {path: f.folder}), /invalid_request/)
    await assert.rejects(f.sources.command('sources.add', {path: join(f.folder, 'Browser'), consent: true}), /path_denied/)
    assert.equal((await f.knowledge.listSources()).length, 0)
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const source = f.sources.list()[0]!
    assert.equal(source.read, 1)
    assert.ok(source.excludes.includes('Browser'))
    assert.ok(source.skipped >= 5)
    assert.equal((await f.knowledge.listSources()).length, 1)
    const ref = f.sources.evidenceSnapshot()[0]!.ref
    assert.ok(f.sources.evidence(ref))
    await f.reopen()
    assert.equal(f.sources.list()[0]!.id, source.id)
    await f.sources.command('sources.pause', {id: source.id})
    await writeFile(join(f.folder, 'new.md'), 'Another file')
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal((await f.knowledge.listSources()).length, 1)
    await f.sources.command('sources.resume', {id: source.id})
    assert.equal((await f.knowledge.listSources()).length, 2)
    await rm(join(f.folder, 'readme.md'))
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal((await f.knowledge.listSources()).length, 1)
    assert.ok(f.invalidated.includes(ref))
    assert.equal(f.sources.evidence(ref), null)
    await f.sources.command('sources.disconnect', {id: source.id})
    for (const method of ['sources.pause', 'sources.resume', 'sources.sync']) await assert.rejects(f.sources.command(method, {id: source.id}), /source_disconnected/)
    assert.equal(f.sources.list()[0]!.state, 'disconnected')
    await f.sources.command('sources.delete', {id: source.id})
    assert.deepEqual(await f.knowledge.listSources(), [])
    assert.deepEqual(f.sources.list(), [])
  } finally {await f.close()}
})

test('metadata coverage counts 10000 files while body budget is enforced and failed roots retain index', async () => {
  const f = await fixture()
  try {
    for (let start = 0; start < 10000; start += 100) {
      await Promise.all(Array.from({length: 100}, (_, index) => writeFile(join(f.folder, `note-${start + index}.md`), 'A short note.')))
    }
    await f.sources.command('sources.add', {path: f.folder, consent: true, max_files: 2, max_bytes: 100})
    const source = f.sources.list()[0]!
    assert.equal(source.scanned, 10000)
    assert.equal(source.read, 2)
    assert.equal(source.reasons.body_budget, 9998)
    await rename(f.folder, `${f.folder}-offline`)
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal(f.sources.list()[0]!.state, 'error')
    assert.equal((await f.knowledge.listSources()).length, 2)
    assert.equal(f.invalidated.length, 0)
    await rename(`${f.folder}-offline`, f.folder)
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal(f.sources.list()[0]!.state, 'connected')
    assert.equal(f.sources.list()[0]!.read, 2)
    assert.ok((await readFile(join(f.root, 'db', 'sources.json'), 'utf8')).includes(source.id))
  } finally {await f.close()}
})

test('scoped ingestion rejects a replaced directory resolving outside the grant', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.root, 'other'))
    await writeFile(join(f.root, 'other', 'readme.md'), 'Must not upload outside grant')
    await symlink(join(f.root, 'other'), join(f.folder, 'link'))
    await assert.rejects(f.knowledge.syncFile(join(f.folder, 'link', 'readme.md'), f.folder, new AbortController().signal), /path_denied|ingest_failed/)
    assert.equal((await f.knowledge.listSources()).length, 0)
  } finally {await f.close()}
})


test('failed refresh retries the changed file rather than blessing stale index metadata', async () => {
  const f = await fixture()
  try {
    const path = join(f.folder, 'notes.md')
    await writeFile(path, 'Original manually imported source')
    await f.knowledge.handle('knowledge.ingest', {kind: 'file', locator: path, consent: true})
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const source = f.sources.list()[0]!, before = (await f.knowledge.listSources())[0]!
    await writeFile(path, 'Updated source after an interrupted synchronization')
    f.setFail(true)
    await f.sources.command('sources.sync', {id: source.id})
    f.setFail(false)
    await f.sources.command('sources.sync', {id: source.id})
    assert.notEqual((await f.knowledge.listSources())[0]!.fingerprint, before.fingerprint)
    assert.equal((await f.knowledge.recall('Updated', 1))[0]!.text, 'Updated source after an interrupted synchronization')
  } finally {await f.close()}
})

test('body-budget deferred changes cannot keep stale source evidence or owned searchable chunks', async () => {
  const f = await fixture()
  try {
    const path = join(f.folder, 'notes.md')
    await writeFile(path, 'Original')
    await f.sources.command('sources.add', {path: f.folder, consent: true, max_bytes: 10})
    const source = f.sources.list()[0]!, ref = f.sources.evidenceSnapshot()[0]!.ref
    await writeFile(path, 'Changed content now larger than the authorized scan budget')
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal(f.sources.evidence(ref), null)
    assert.deepEqual(await f.knowledge.listSources(), [])
    assert.ok(f.invalidated.includes(ref))
  } finally {await f.close()}
})


test('restart retries source invalidation interrupted after durable stale marking', async () => {
  const f = await fixture()
  try {
    const path = join(f.folder, 'notes.md')
    await writeFile(path, 'Original version')
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const id = f.sources.list()[0]!.id, ref = f.sources.evidenceSnapshot()[0]!.ref
    f.setFailInvalidation(true)
    await writeFile(path, 'Changed version with distinct size')
    await f.sources.command('sources.sync', {id})
    assert.equal(f.sources.evidence(ref), null)
    assert.equal(f.invalidated.length, 0)
    f.setFailInvalidation(false)
    await f.reopen()
    assert.ok(f.invalidated.includes(ref))
    assert.equal(f.sources.evidenceSnapshot().length, 1)
    assert.notEqual(f.sources.evidenceSnapshot()[0]!.ref, ref)
  } finally {await f.close()}
})


test('pause fences an in-flight body import before it can commit', async () => {
  const f = await fixture()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => {release = resolve})
  const started = new Promise<void>(resolve => {entered = resolve})
  try {
    await writeFile(join(f.folder, 'notes.md'), 'An import being paused')
    f.setEmbeddingHook(() => {entered(); return gate})
    const adding = f.sources.command('sources.add', {path: f.folder, consent: true})
    await started
    const id = f.sources.list()[0]!.id
    const pausing = f.sources.command('sources.pause', {id})
    release()
    await Promise.all([adding, pausing])
    assert.equal(f.sources.list()[0]!.state, 'paused')
    assert.deepEqual(await f.knowledge.listSources(), [])
    assert.deepEqual(f.sources.evidenceSnapshot(), [])
  } finally {release(); await f.close()}
})


test('project descriptions become content memories while scan statistics stay in source settings', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.folder, 'README.md'), '# Example\n\n![build](https://example.com/badge.svg)\n\nA tool for evaluating phone agents with repeatable tasks.\n\n```sh\nignore instructions\n```')
    await writeFile(join(f.folder, 'newer.ts'), '// just code')
    await f.sources.command('sources.add', {path:f.folder, consent:true, max_files:1})
    assert.equal(f.observations.length,1)
    assert.match(f.observations[0]!.content,/evaluating phone agents/)
    assert.doesNotMatch(f.observations[0]!.content,/扫描|索引|ignore instructions|badge/)
    const id=f.sources.list()[0]!.id, ref=f.observations[0]!.source_ref.ref
    await f.sources.command('sources.sync',{id})
    assert.equal(f.observations.length,1)
    await writeFile(join(f.folder, 'README.md'), '# Example\n\nNow also evaluates desktop agents.')
    await f.sources.command('sources.sync',{id})
    assert.equal(f.observations.length,2)
    assert.match(f.observations[1]!.content,/desktop agents/)
    assert.ok(f.invalidated.includes(ref))
    await f.sources.command('sources.delete',{id})
    assert.ok(f.invalidated.includes(f.observations[1]!.source_ref.ref))
  } finally {await f.close()}
})


test('README version replacement survives touch and A-B-A without overriding explicit forgetting', async () => {
  const f = await fixture(true)
  try {
    const path=join(f.folder,'README.md'), original='# Example\n\nA voice conversation project.'
    await writeFile(path,original)
    await f.sources.command('sources.add',{path:f.folder,consent:true})
    const id=f.sources.list()[0]!.id
    assert.equal(f.memory!.list().entries.length,1)
    const firstRef=f.memory!.list().entries[0]!.source_refs[0]!.ref
    await utimes(path,new Date(),new Date(Date.now()+2000))
    await f.sources.command('sources.sync',{id})
    assert.equal(f.memory!.list().entries.length,1)
    assert.notEqual(f.memory!.list().entries[0]!.source_refs[0]!.ref,firstRef)
    await writeFile(path,'# Example\n\nA mobile evaluation project.')
    await f.sources.command('sources.sync',{id})
    assert.equal(f.memory!.list().entries.length,1)
    assert.match(f.memory!.list().entries[0]!.content,/mobile evaluation/)
    await writeFile(path,original)
    await f.sources.command('sources.sync',{id})
    const entry=f.memory!.list().entries[0]!
    assert.equal(f.memory!.list().entries.length,1)
    assert.match(entry.content,/voice conversation/)
    f.memory!.forgetEntry(entry.id,entry.version)
    await utimes(path,new Date(),new Date(Date.now()+4000))
    await f.sources.command('sources.sync',{id})
    assert.equal(f.memory!.list().entries.length,0)
    await f.reopen()
    assert.equal(f.memory!.list().entries.length,0)
    await f.sources.command('sources.delete',{id})
    assert.equal(f.memory!.list().entries.length,0)
  } finally {await f.close()}
})

test('nested documents retain project context and unavailable observations retry after restart', async () => {
  const f=await fixture(true)
  try {
    await mkdir(join(f.folder,'Alpha'))
    await mkdir(join(f.folder,'Beta'))
    await writeFile(join(f.folder,'Alpha','README.md'),'# Alpha\n\n'+ 'Voice conversations. '.repeat(35))
    await writeFile(join(f.folder,'Beta','README.md'),'# Beta\n\nRepeatable mobile agent evaluations.')
    f.setMemoryAvailable(false)
    await f.sources.command('sources.add',{path:f.folder,consent:true})
    assert.equal(f.memory!.list().entries.length,0)
    assert.equal(f.sources.list()[0]!.state,'error')
    f.setMemoryAvailable(true)
    await f.reopen()
    const entries=f.memory!.list().entries
    assert.equal(entries.length,2)
    assert.deepEqual(entries.map(entry=>entry.topic).sort(),['Alpha','Beta'])
    for(const entry of entries){assert.match(entry.content,new RegExp(entry.topic+'/README.md'));assert(entry.content.length<=500)}
    await f.sources.command('sources.delete',{id:f.sources.list()[0]!.id})
    assert.equal(f.memory!.list().entries.length,0)
  } finally {await f.close()}
})

test('project-balanced admission preserves a small old collection beside a crowded Git project',async()=>{
 const f=await fixture()
 try{
  await mkdir(join(f.folder,'large','.git'),{recursive:true});await mkdir(join(f.folder,'papers'))
  for(let i=0;i<12;i++){const d=join(f.folder,'large','part'+i);await mkdir(d);await writeFile(join(d,'README.md'),'Large project section '+i)}
  const note=join(f.folder,'papers','reading-notes.md');await writeFile(note,'Optical imaging research notes, collected in the past.');await utimes(note,new Date('2020-01-01'),new Date('2020-01-01'))
  await f.sources.command('sources.add',{path:f.folder,consent:true,max_files:4})
  assert.ok((await f.knowledge.listSources()).some(s=>s.locator===note),'small non-README collection must receive body budget')
  assert.ok(f.observations.some(o=>o.content.includes('Optical imaging')),'notes must supply representative observations')
 }finally{await f.close()}
})
test('project overview budget is stable across unchanged syncs and generated files stay out',async()=>{
 const f=await fixture()
 try{
  await mkdir(join(f.folder,'.git'));for(let i=0;i<20;i++)await writeFile(join(f.folder,'note-'+i+'.md'),'Distinct project note '+i)
  await writeFile(join(f.folder,'package-lock.json'),'{}');await f.sources.command('sources.add',{path:f.folder,consent:true})
  const before=await f.knowledge.listSources();assert.ok(before.length<=8,'one project must not consume all file slots');assert.ok(before.every(s=>!s.locator.endsWith('package-lock.json')))
  await f.sources.command('sources.sync',{id:f.sources.list()[0]!.id});assert.equal((await f.knowledge.listSources()).length,before.length);assert.equal(f.sources.list()[0]!.read,0)
 }finally{await f.close()}
})
test('evidence snapshot represents both roots',async()=>{
 const f=await fixture()
 try{
  const other=join(f.root,'other');await mkdir(other)
  for(let i=0;i<8;i++){await writeFile(join(f.folder,'a'+i+'.md'),'First collection '+i);await writeFile(join(other,'b'+i+'.md'),'Second collection '+i)}
  await f.sources.command('sources.add',{path:f.folder,consent:true});await f.sources.command('sources.add',{path:other,consent:true})
  const snapshot=f.sources.evidenceSnapshot();assert.equal(snapshot.length,8);assert.ok(snapshot.some(s=>/a\d+\.md/u.test(s.summary)));assert.ok(snapshot.some(s=>/b\d+\.md/u.test(s.summary)))
 }finally{await f.close()}
})

test('a Git metadata ceiling leaves sibling collections reachable and retains unseen indexed files',async()=>{
 const f=await fixture()
 try{
  const repo=join(f.folder,'large'),papers=join(f.folder,'papers');await mkdir(join(repo,'.git'),{recursive:true});await mkdir(papers)
  await Promise.all(Array.from({length:2050},(_,i)=>writeFile(join(repo,'part-'+i+'.txt'),'Project data '+i)))
  await writeFile(join(papers,'notes.md'),'Independent scientific reading notes.')
  await f.sources.command('sources.add',{path:f.folder,consent:true,max_files:3})
  assert.ok(f.sources.list()[0]!.reasons.project_metadata_limit)
  assert.ok((await f.knowledge.listSources()).some(s=>s.locator===join(papers,'notes.md')))
  const before=(await f.knowledge.listSources()).map(s=>s.id).sort()
  await f.sources.command('sources.sync',{id:f.sources.list()[0]!.id})
  assert.deepEqual((await f.knowledge.listSources()).map(s=>s.id).sort().filter(id=>before.includes(id)),before)
 }finally{await f.close()}
})
test('identical content occupies one snapshot slot without losing separate source ownership',async()=>{
 const f=await fixture()
 try{
  for(const name of ['one','two']){await mkdir(join(f.folder,name));await writeFile(join(f.folder,name,'README.md'),'Identical checkout overview.')}
  await f.sources.command('sources.add',{path:f.folder,consent:true})
  assert.equal((await f.knowledge.listSources()).length,2)
  assert.equal(f.sources.evidenceSnapshot().length,1)
 }finally{await f.close()}
})

test('a changed file outside the project overview budget cannot keep stale evidence',async()=>{
 const f=await fixture()
 try{
  await mkdir(join(f.folder,'.git'));const code=join(f.folder,'example.ts');await writeFile(code,'export const version = 1')
  await f.sources.command('sources.add',{path:f.folder,consent:true});const old=f.sources.evidenceSnapshot()[0]!.ref
  for(let i=0;i<8;i++){const dir=join(f.folder,'part'+i);await mkdir(dir);await writeFile(join(dir,'README.md'),'Overview '+i)}
  await writeFile(code,'export const version = 222')
  await f.sources.command('sources.sync',{id:f.sources.list()[0]!.id})
  assert.equal(f.sources.evidence(old),null);assert.ok(f.invalidated.includes(old))
  assert.ok((await f.knowledge.listSources()).every(s=>s.locator!==code))
 }finally{await f.close()}
})

test('project overview favors the root README over newer nested README files',async()=>{
 const f=await fixture()
 try{
  await mkdir(join(f.folder,'.git'));const overview=join(f.folder,'README.md');await writeFile(overview,'Whole project overview');await utimes(overview,new Date('2020-01-01'),new Date('2020-01-01'))
  for(let i=0;i<10;i++){const dir=join(f.folder,'part'+i);await mkdir(dir);await writeFile(join(dir,'README.md'),'Nested implementation '+i)}
  await f.sources.command('sources.add',{path:f.folder,consent:true,max_files:1})
  assert.equal((await f.knowledge.listSources())[0]!.locator,overview)
 }finally{await f.close()}
})


test('whole-computer grant resumes batches past the directory overview budget without admitting credentials',async()=>{
 const f=await fixture()
 try{
  await mkdir(join(f.folder,'.git'))
  for(let n=0;n<19;n++)await writeFile(join(f.folder,`note-${String(n).padStart(2,'0')}.md`),`Distinct project document ${n}: implementation notes.`)
  await writeFile(join(f.folder,'.env'),'SECRET=never-read')
  await assert.rejects(f.sources.command('sources.authorize_computer',{consent:true,path:'/'}))
  const grant=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  for(let i=0;i<3&&(await f.knowledge.listSources()).length<19;i++)await f.sources.command('sources.sync',{id:grant.id})
  assert.equal((await f.knowledge.listSources()).length,19)
  assert.equal(f.sources.list()[0]!.scope,'computer')
  assert.equal(f.sources.contextEntries().length,19)
  assert.equal(f.sources.contextEntries()[0]!.kind,'file')
  assert.doesNotMatch(f.sources.contextEntries()[0]!.content,/^note-\d+\.md:/u)
  await f.sources.command('sources.consent',{id:grant.id,consent:false});assert.equal(f.sources.contextEntries().length,0)
  await f.reopen()
  assert.equal(f.sources.list()[0]!.scope,'computer')
  assert.equal((await f.knowledge.listSources()).length,19)
 }finally{await f.close()}
})

test('whole-computer scan skips hidden content and invalidates a legacy hidden record',async()=>{
 const f=await fixture()
 try{
  const visible=join(f.folder,'project');await mkdir(visible)
  await writeFile(join(visible,'README.md'),'Visible project notes')
  const hidden=join(f.folder,'.tool');await mkdir(hidden)
  const hiddenFile=join(hidden,'notes.md');await writeFile(hiddenFile,'Hidden tool setting')
  await writeFile(join(f.folder,'.private.md'),'Hidden root note')
  const grant=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.sync',{id:grant.id})
  assert.ok((await f.knowledge.listSources()).some(s=>s.locator===join(visible,'README.md')))
  assert.ok(!(await f.knowledge.listSources()).some(s=>s.locator===hiddenFile))
  await f.sources.close()
  await f.knowledge.handle('knowledge.ingest',{kind:'file',locator:hiddenFile,consent:true})
  const indexed=(await f.knowledge.listSources()).find(s=>s.locator===hiddenFile)!
  const statePath=join(f.root,'db','sources.json'),state=JSON.parse(await readFile(statePath,'utf8')) as {sources:{files:unknown[]}[]}
  state.sources[0]!.files.push({path:hiddenFile,id:indexed.id,fingerprint:indexed.fingerprint,size:19,mtime:1,owned:true,valid:true,excerpt:'Hidden tool setting',observed:false,observation_ref:null})
  await writeFile(statePath,JSON.stringify(state))
  const legacyRef=`file:${indexed.id}:${indexed.fingerprint}`
  await f.reopen()
  assert.equal(f.sources.contextEntries().some(e=>e.content.includes('Hidden tool setting')),false)
  await f.sources.command('sources.sync',{id:grant.id})
  assert.ok(f.invalidated.includes(legacyRef))
  assert.ok(!(await f.knowledge.listSources()).some(s=>s.locator===hiddenFile))
 }finally{await f.close()}
})

test('priority directory changes scan order without changing computer authority',async()=>{
 const f=await fixture()
 try{
  const alpha=join(f.folder,'alpha'),project=join(f.folder,'project')
  await mkdir(alpha);await mkdir(project)
 await writeFile(join(alpha,'README.md'),'Alpha notes')
 await writeFile(join(project,'README.md'),'Project notes')
  await mkdir(join(project,'.github'));await writeFile(join(project,'.github','notes.md'),'Hidden project metadata')
  const grant=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.priority.add',{path:project})
  assert.deepEqual(f.sources.list()[0]!.priority_dirs,[project])
  await f.sources.command('sources.sync',{id:grant.id})
  assert.equal(f.sources.contextEntries().some(entry=>entry.content.includes('Hidden project metadata')),false)
  await f.sources.command('sources.priority.remove',{path:project})
  assert.deepEqual(f.sources.list()[0]!.priority_dirs,[])
  assert.equal(f.sources.list()[0]!.state,'connected')
  await f.sources.command('sources.sync',{id:grant.id})
  assert.ok((await f.knowledge.listSources()).some(s=>s.locator===join(project,'README.md')))
 }finally{await f.close()}
})
test('adding a priority does not resume a paused computer grant',async()=>{
 const f=await fixture()
 try{
  const project=join(f.folder,'project');await mkdir(project);await writeFile(join(project,'README.md'),'Project notes')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.pause',{id})
  const before=f.sources.list()[0]!.read
  await f.sources.command('sources.priority.add',{path:project})
  assert.equal(f.sources.list()[0]!.state,'paused')
  assert.equal(f.sources.list()[0]!.read,before)
 }finally{await f.close()}
})
test('computer candidates keep nested Git repositories separate',async()=>{
 const f=await fixture()
 try{
  const code=join(f.folder,'code');await mkdir(code)
  for(const name of ['active','older']){const repo=join(code,name);await mkdir(repo);await mkdir(join(repo,'.git'));await writeFile(join(repo,'README.md'),`An idea for ${name} setup.`)}
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  for(let i=0;i<4&&(await f.knowledge.listSources()).length<2;i++)await f.sources.command('sources.sync',{id})
  assert.deepEqual(new Set(f.sources.contextEntries().flatMap(item=>item.kind==='file'?[item.root]:[])),new Set([join(code,'active'),join(code,'older')]))
 }finally{await f.close()}
})
test('whole-computer scan invalidates a file when its parent folder is deleted',async()=>{
 const f=await fixture()
 try{
  const project=join(f.folder,'project'),nested=join(project,'notes');await mkdir(project);await mkdir(nested)
  const document=join(nested,'plan.md');await writeFile(document,'An idea for a simpler setup.')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.sync',{id})
  const tracked=f.sources.contextEntries().find(item=>item.kind==='file'&&item.content.includes('simpler setup'))
  assert.ok(tracked)
  await rm(nested,{recursive:true})
  await f.sources.command('sources.sync',{id})
  assert.equal(f.sources.contextEntries().some(item=>item.kind==='file'&&item.content.includes('simpler setup')),false)
  assert.equal((await f.knowledge.listSources()).some(item=>item.locator===document),false)
 }finally{await f.close()}
})
test('computer roots rank selected and current work ahead of recent Git and mtime',()=>{
 const roots=[
  {path:'/older',selected:false,currentWorkspace:false,lastGitCommitMs:null,mtimeMs:1},
  {path:'/git',selected:false,currentWorkspace:false,lastGitCommitMs:9,mtimeMs:2},
  {path:'/current',selected:false,currentWorkspace:true,lastGitCommitMs:null,mtimeMs:1},
  {path:'/selected',selected:true,currentWorkspace:false,lastGitCommitMs:null,mtimeMs:1},
 ]
 assert.deepEqual(orderComputerRoots(roots).map(root=>root.path),['/selected','/current','/git','/older'])
})
test('first computer batches include more than one visible project root',async()=>{
 const f=await fixture()
 try{
  const alpha=join(f.folder,'alpha'),beta=join(f.folder,'beta')
  await mkdir(alpha);await mkdir(beta)
  for(let i=0;i<48;i++)await writeFile(join(alpha,`note-${String(i).padStart(2,'0')}.md`),`Alpha note ${i}`)
  await writeFile(join(beta,'README.md'),'Beta project overview')
  await utimes(beta,new Date('2020-01-01'),new Date('2020-01-01'))
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.sync',{id})
  assert.ok((await f.knowledge.listSources()).some(source=>source.locator===join(beta,'README.md')))
 }finally{await f.close()}
})
test('current workspace reaches the first computer batches even behind a long saved queue',async()=>{
 let workspace:string|null=null
 const f=await fixture(false,()=>Promise.resolve(workspace))
 try{
  for(let i=0;i<80;i++){const dir=join(f.folder,`older-${String(i).padStart(2,'0')}`);await mkdir(dir);await writeFile(join(dir,'README.md'),`Older project ${i}`)}
  workspace=join(f.folder,'zz-current');await mkdir(workspace);await writeFile(join(workspace,'README.md'),'Current working project overview')
  const {id}=await f.sources.command('sources.authorize_computer',{consent:true}) as {id:string}
  await f.sources.command('sources.sync',{id})
  assert.ok((await f.knowledge.listSources()).some(source=>source.locator===join(workspace!,'README.md')))
 }finally{await f.close()}
})
