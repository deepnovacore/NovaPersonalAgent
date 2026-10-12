import type {ModelGateway} from '../src/model/model-gateway.js'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {initializeMemory,memoryOperation} from '../src/memory-substrate/store.js'
import {enableMemoryFiles} from '../src/memory-substrate/file-authority.js'
import {purgeEntry} from '../src/memory-substrate/purge.js'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'

const prefix='personal:test:',provider='fixture-provider'
interface Item {evidence_id:string;stamp:string;start:number;end:number}
interface Batch {id:string;items:Item[];task_id:string|null;run_id:string|null;status:string}
function setup(path=':memory:'){
 const db=new DatabaseSync(path);initializeMemory(db)
 function process(value:{action:'status'}):{pending_changes:number;completed_batches:number}
 function process(value:{action:'claim'}):Batch|null
 function process(value:{action:'topics'}):{items:unknown[]}
 function process(value:{action:'read';batch_id:string}):{items:(Item&{text:string})[]}|null
 function process(value:Record<string,unknown>):unknown
 function process(value:Record<string,unknown>):unknown{return memoryOperation(db,'source_processing',{prefix,provider,...value})}
 const add=(key:string,text='Synthetic project planning',scope=prefix)=>{
  const source_id=scope+'source:'+key,id=scope+'e:'+key,now=new Date().toISOString()
  memoryOperation(db,'append_evidence',{id,source_id,source_kind:'file',locator:key,raw_text:text,hash:key,observed_at:now,recorded_at:now,trust:'untrusted_external'})
  memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
  return id
 }
 const bind=(batch:Batch)=>process({action:'bind',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id})
 const commit=(batch:Batch)=>{bind(batch);return process({action:'commit',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,topics:[{title:'Planning',summary:'Index of planning material; not a personal fact.',refs:batch.items}]})}
 return {db,process,add,bind,commit}
}

test('bounded incremental batches cover long tails, append-only changes, and idle makes no batch',()=>{
 const {db,process,add,commit}=setup()
 try{
  const long=add('long','a'.repeat(25000)+'UNIQUE TAIL');for(let n=0;n<20;n++)add('doc'+n)
  add('other','Other user content','personal:other:')
  let chars=0,runs=0,tail=false
  for(;;){const batch=process({action:'claim'});if(!batch)break;runs++;assert.ok(batch.items.length<=8)
   const read=process({action:'read',batch_id:batch.id})!;assert.ok(read.items.reduce((n,i)=>n+i.text.length,0)<=16000)
   for(const item of read.items){assert.ok(item.evidence_id.startsWith(prefix));if(item.evidence_id===long){chars+=item.text.length;tail ||= item.text.includes('UNIQUE TAIL')}}
   commit(batch)
  }
  assert.ok(runs>1);assert.equal(chars,25011);assert.equal(tail,true)
  const before=process({action:'status'});assert.equal(before.pending_changes,0);assert.equal(process({action:'claim'}),null)
  add('new');const batch=process({action:'claim'})!;assert.equal(batch.items.length,1);commit(batch)
  assert.equal(process({action:'status'}).completed_batches,before.completed_batches+1)
 }finally{db.close()}
})

test('claim and task binding survive restart; failed work is retried without advancing the cursor',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'nova-processing-')),path=join(directory,'ledger.sqlite')
 let fixture=setup(path)
 try{
  fixture.add('one');const batch=fixture.process({action:'claim'})!;fixture.bind(batch)
  assert.equal(fixture.process({action:'claim'})!.id,batch.id);fixture.db.close();fixture=setup(path)
  assert.equal(fixture.process({action:'claim'})!.id,batch.id)
  assert.throws(()=>fixture.process({action:'bind',batch_id:batch.id,task_id:'different',run_id:'different'}),/CONFLICT/)
  fixture.process({action:'fail',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id})
  assert.equal(fixture.process({action:'status'}).completed_batches,0)
  const retry=fixture.process({action:'claim'})!;assert.notEqual(retry.id,batch.id);assert.deepEqual(retry.items,batch.items)
  fixture.commit(retry);assert.equal(fixture.process({action:'claim'}),null)
 }finally{fixture.db.close();await rm(directory,{recursive:true,force:true})}
})

test('commit is idempotent, rejects fabricated references, and revoke/regrant invalidates old topics',()=>{
 const {db,process,add,bind,commit}=setup()
 try{
  add('one');const batch=process({action:'claim'})!;bind(batch)
  assert.throws(()=>process({action:'commit',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,topics:[{title:'fake',summary:'fake',refs:[{...batch.items[0],evidence_id:'personal:other:e:one'}]}]}),/INVALID/)
  commit(batch);assert.deepEqual(commit(batch),{applied:true});assert.equal(process({action:'topics'}).items.length,1)
  memoryOperation(db,'source_grant',{source_id:prefix+'source:one',expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:null,embedding_provider:null,conversation_providers:[]}})
  assert.equal(process({action:'topics'}).items.length,0);assert.equal(process({action:'claim'}),null)
  memoryOperation(db,'source_grant',{source_id:prefix+'source:one',expected_revision:2,grant:{revision:3,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
  assert.equal(process({action:'topics'}).items.length,0)
  const replacement=process({action:'claim'})!;assert.ok(replacement);commit(replacement)
  assert.equal(process({action:'topics'}).items.length,1)
  memoryOperation(db,'delete_source',{source_id:prefix+'source:one'});assert.equal(process({action:'topics'}).items.length,0)
 }finally{db.close()}
})

test('revocation during execution rejects late result and never writes personal facts',()=>{
 const {db,process,add,bind}=setup()
 try{
  add('one');const batch=process({action:'claim'})!;bind(batch)
  memoryOperation(db,'source_grant',{source_id:prefix+'source:one',expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:null,embedding_provider:null,conversation_providers:[]}})
  assert.equal(process({action:'read',batch_id:batch.id}),null)
  const result=process({action:'commit',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,topics:[{title:'old',summary:'old',refs:batch.items}]})
  assert.deepEqual(result,{applied:false});assert.equal(process({action:'status'}).completed_batches,0)
  assert.deepEqual(memoryOperation(db,'list',{}),[])
 }finally{db.close()}
})

test('profile publication cites raw versions, preserves a good draft on failure, and hides revoked facts',()=>{
 const {db,process,add,bind}=setup()
 try{
  const evidence=add('one');const batch=process({action:'claim'})!;bind(batch)
  const draft={about:{text:'你正在推进资料整理项目。',refs:[{entry_id:evidence,version:'one'}]},work:[],interests:[]}
  const request={action:'publish',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,expected_revision:0,draft,refs:batch.items}
  assert.throws(()=>process(request),/INVALID/,'a summary reference alone is insufficient without reading the original')
  process({action:'read',batch_id:batch.id})
  assert.deepEqual(process(request),{applied:true,revision:1});assert.deepEqual(process(request),{applied:true,revision:1})
  assert.throws(()=>process({...request,expected_revision:1,draft:{...draft,about:{...draft.about,refs:[{entry_id:evidence,version:'invented'}]}}}),/INVALID/)
  assert.deepEqual(process({action:'profile'}),{revision:1,draft})
  process({action:'fail',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id})
  assert.deepEqual(process({action:'profile'}),{revision:1,draft})
  memoryOperation(db,'source_grant',{source_id:prefix+'source:one',expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:null,embedding_provider:null,conversation_providers:[]}})
  assert.deepEqual(process({action:'profile'}),{revision:1,draft:null})
 }finally{db.close()}
})

test('a bounded scan can skip disallowed history and resume at the next page',()=>{
 const {db,process,add,commit}=setup()
 try{
  for(let n=0;n<220;n++)add('blocked'+n,'not for this provider','personal:test:')
  db.prepare("UPDATE source_grants SET payload_json=json_set(payload_json,'$.extraction_provider','different')").run()
  add('eligible')
  let scans=0,batch:Batch|null=null
  while(process({action:'status'}).pending_changes&&!batch){batch=process({action:'claim'});scans++;assert.ok(scans<10)}
  assert.ok(scans>1);assert.equal(batch!.items[0]!.evidence_id,prefix+'e:eligible');commit(batch!)
 }finally{db.close()}
})

test('message edits A to B to A never resurrect a topic from an earlier activation',()=>{
 const {db,process,commit}=setup()
 try{
  const source_id=prefix+'im',now=new Date().toISOString()
  memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
  const append=(key:string)=>memoryOperation(db,'append_evidence',{id:prefix+key,source_id,source_kind:'im',locator:'same-message',raw_text:key,hash:key,observed_at:now,recorded_at:now,trust:'untrusted_external',source_metadata:{sender_id:'self',recipient_id:'self',account_id:'fixture'}})
  append('A');const first=process({action:'claim'})!;commit(first);assert.equal(process({action:'topics'}).items.length,1)
  append('B');assert.equal(process({action:'topics'}).items.length,0)
  append('A');assert.equal(process({action:'topics'}).items.length,0)
  const again=process({action:'claim'})!;assert.notEqual(first.items[0]!.stamp,again.items[0]!.stamp);commit(again)
  assert.equal(process({action:'topics'}).items.length,1)
 }finally{db.close()}
})

test('legacy messages without a head use the latest stored version only',()=>{
 const {db,process}=setup()
 try{
  const source_id=prefix+'legacy',now=new Date().toISOString()
  for(const key of ['old','new'])memoryOperation(db,'append_evidence',{id:prefix+key,source_id,source_kind:'im',locator:'same',raw_text:key,hash:key,observed_at:now,recorded_at:now,trust:'untrusted_external',source_metadata:{sender_id:'self',recipient_id:'self',account_id:'synthetic'}})
  memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
  db.exec('DELETE FROM memory_message_heads; DELETE FROM processing_heads')
  const batch=process({action:'claim'})!
  assert.deepEqual(batch.items.map(item=>item.evidence_id),[prefix+'new'])
 }finally{db.close()}
})

test('processing recipe changes reprocess evidence and cannot read an older recipe cache',()=>{
 const {db,process,add,commit}=setup()
 try{
  add('one');const first=process({action:'claim'})!;commit(first)
  const newer=(request:Record<string,unknown>)=>memoryOperation(db,'source_processing',{prefix,provider,recipe:'corrected-prompt-v2',...request})
  assert.deepEqual(newer({action:'topics'}),{items:[],next:null})
  const batch=newer({action:'claim'}) as Batch
  assert.notEqual(batch.items[0]!.stamp,first.items[0]!.stamp)
 }finally{db.close()}
})

test('permanent purge erases topic and profile plaintext from the compacted database',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-processing-purge-')),path=join(dir,'ledger.sqlite')
 const {db,process,add,bind}=setup(path),marker='SYNTHETIC_ERASE_PROCESSING_TEXT'
 try{
  const evidence=add('one',marker),batch=process({action:'claim'})!,owner={batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id}
  bind(batch);process({action:'read',batch_id:batch.id})
  memoryOperation(db,'merge',{entry_id:prefix+'fact',kind:'fact',origin:'inferred',written_by:'merge',evidence_refs:[evidence],content:{text:marker},recorded_at:new Date().toISOString()})
  process({action:'publish',...owner,expected_revision:0,draft:{about:{text:marker,refs:[{entry_id:evidence,version:'one'}]},work:[],interests:[]},refs:batch.items})
  process({action:'commit',...owner,topics:[{title:'topic',summary:marker,refs:batch.items}]})
  enableMemoryFiles(db,path+'.memory')
  const result=purgeEntry(db,path,{request_id:'purge',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'fact',expected_revision:1}})
  assert.equal(result.status,'complete')
  assert.equal((await readFile(path)).includes(Buffer.from(marker)),false)
 }finally{db.close();await rm(dir,{recursive:true,force:true})}
})

test('recipe replacement exposes its predecessor and requires explicit host reconciliation before dispatch',()=>{
 const {db,process,add,bind}=setup()
 try{
  add('one');const batch=process({action:'claim'})!;bind(batch)
  const newer=(request:Record<string,unknown>)=>memoryOperation(db,'source_processing',{prefix,provider,recipe:'changed',...request})
  const status=newer({action:'status'}) as {active_batch:Batch;reconciliation_required:boolean}
  assert.equal(status.reconciliation_required,true);assert.equal(status.active_batch.id,batch.id)
  assert.throws(()=>newer({action:'claim'}),/CONFLICT/)
  assert.throws(()=>newer({action:'retire',batch_id:batch.id,task_id:null,run_id:null,reason:'no_task_dispatched'}),/CONFLICT/)
  newer({action:'retire',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,reason:'task_terminal'})
  assert.ok(newer({action:'claim'}))
 }finally{db.close()}
})

test('deleting one input preserves unrelated profile items and queues surviving mixed-topic evidence',()=>{
 const {db,process,add,bind}=setup()
 try{
  const a=add('A'),b=add('B'),batch=process({action:'claim'})!,owner={batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id}
  bind(batch);process({action:'read',batch_id:batch.id})
  const keep={title:'B project',text:'Still supported',refs:[{entry_id:b,version:'B'}]}
  process({action:'publish',...owner,expected_revision:0,draft:{about:{text:'A',refs:[{entry_id:a,version:'A'}]},work:[keep],interests:[]},refs:batch.items})
  process({action:'commit',...owner,topics:[{title:'mixed',summary:'A and B',refs:batch.items}]})
  memoryOperation(db,'delete_source',{source_id:prefix+'source:A'})
  assert.deepEqual((process({action:'profile'}) as {draft:unknown}).draft,{about:null,work:[keep],interests:[]})
  const next=process({action:'claim'})!;assert.deepEqual(next.items.map(item=>item.evidence_id),[b])
 }finally{db.close()}
})

test('resource port fixes identity and provider on the host and uses the real worker without model calls',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-processing-resource-'));let modelCalls=0
 const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(dir,'ledger.sqlite')),userId:'processing-fixture',model:'fixture',personalMemoryEnabled:false,gateway:{async *stream(){/* unused */},complete(){modelCalls++;return Promise.reject(Error('must not call model'))}}})
 try{
  await memory.open()
  await memory.recordEvidence({sourceId:'folder',locator:'synthetic.txt',text:'Synthetic project notes',observedAt:new Date().toISOString(),kind:'file',embeddingConsent:false,processingConsent:memory.processingGrant(true)})
  const batch=await memory.sourceProcessing({action:'claim'}) as Batch
  assert.ok(batch.items[0]!.evidence_id.startsWith(memory.prefix))
  await assert.rejects(memory.sourceProcessing(Object.assign({action:'status' as const},{prefix:'personal:other:',provider:'other'})))
  assert.equal(modelCalls,0)
 }finally{await memory.close();await rm(dir,{recursive:true,force:true})}
})

test('batch context revalidation includes prior originals read through topic search',()=>{
 const {db,process,add,commit,bind}=setup()
 try{
  add('old');const prior=process({action:'claim'})!;commit(prior)
  add('current');const current=process({action:'claim'})!;bind(current)
  process({action:'topics',batch_id:current.id})
  assert.equal((process({action:'batch',batch_id:current.id}) as {valid:boolean}).valid,true)
  memoryOperation(db,'source_grant',{source_id:prefix+'source:old',expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:null,embedding_provider:null,conversation_providers:[]}})
  assert.equal((process({action:'batch',batch_id:current.id}) as {valid:boolean}).valid,false)
 }finally{db.close()}
})

test('profile writer retries revalidate authorization before sending original text again',async()=>{
 let allowed=true,calls=0
 const gateway={complete:()=>{calls++;allowed=false;return Promise.resolve({text:'invalid-json'})},stream(){throw Error('unused')}} as unknown as ModelGateway
 const resource=new SubstrateMemoryResource({client:{} as MemoryLedgerClient,userId:'test',gateway,model:'qwen3-vl-plus'})
 await assert.rejects(resource.sourceProcessingProfile([{id:'personal:test:e',version:'v',origin:'inferred',content:'synthetic original',source:{project:'synthetic',document:'self',kind:'im',relation:'self',sender_id:'self'}}],new AbortController().signal,()=>allowed?Promise.resolve():Promise.reject(Error('revoked'))),/revoked/)
 assert.equal(calls,1)
})

 test('incremental topic commits reject historical refs and preserve earlier topics',()=>{
 const {db,process,add,commit,bind}=setup()
 try{
  add('prior');const prior=process({action:'claim'})!;commit(prior)
  add('next');const next=process({action:'claim'})!;bind(next)
  assert.throws(()=>process({action:'commit',batch_id:next.id,task_id:'task:'+next.id,run_id:'run:'+next.id,topics:[{title:'mixed',summary:'mixed',refs:[...prior.items,...next.items]}]}),/STORE_INVALID_OPERATION/)
  commit(next);assert.equal(process({action:'topics'}).items.length,2)
 }finally{db.close()}
})
