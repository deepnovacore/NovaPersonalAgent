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
 const resource=new SubstrateMemoryResource({client:{memory:()=>Promise.resolve({revision:0,corrections:{}})} as unknown as MemoryLedgerClient,userId:'test',gateway,model:'qwen3-vl-plus'})
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

test('revocation after whole-profile critique prevents the final editing request',async()=>{
 let allowed=true,calls=0
 const gateway={complete:()=>{calls++;if(calls===1)return Promise.resolve({text:JSON.stringify({about:{paragraphs:[{text:'你在准备验证接口。',refs:['e0']}]},work:[],interests:[]})});allowed=false;return Promise.resolve({text:JSON.stringify({review_notes:['保持计划状态。']})})},stream(){throw Error('unused')}} as unknown as ModelGateway
 const resource=new SubstrateMemoryResource({client:{memory:()=>Promise.resolve({revision:0,corrections:{}})} as unknown as MemoryLedgerClient,userId:'test',gateway,model:'qwen3-vl-plus'})
 await assert.rejects(resource.sourceProcessingProfile([{id:'personal:test:e',version:'v',origin:'stated',content:'我计划验证接口'}],new AbortController().signal,()=>allowed?Promise.resolve():Promise.reject(Error('revoked'))),/revoked/)
 assert.equal(calls,2)
})

test('shared products project only current evidence and keep dismissal through regeneration',()=>{
 const {db,process,add,bind}=setup()
 try{
  const evidence=add('shared','Next: review the interface');const batch=process({action:'claim'})!;bind(batch);process({action:'read',batch_id:batch.id})
  const refs=[{entry_id:evidence,version:'shared'}],draft={about:{text:'Works on interfaces.',refs},work:[],interests:[]}
  const products={projects:[],suggestions:[{id:'review',kind:'action',title:'Review interface',body:'Review the proposed interface',project_id:null,todo_id:null,due:null,refs}]}
  const publish={action:'publish',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,expected_revision:0,draft,refs:batch.items,products}
  process(publish)
  const snapshot=()=>process({action:'products'}) as {revision:number;draft:unknown;suggestions:unknown[]}
  assert.equal(snapshot().revision,1);assert.equal(snapshot().suggestions.length,1)
  process({action:'dismiss',id:'review'});assert.equal(snapshot().suggestions.length,0)
  process({...publish,expected_revision:1,products:{...products,suggestions:[{...products.suggestions[0],title:'Review updated interface'}]}})
  assert.equal(snapshot().suggestions.length,0)
  memoryOperation(db,'source_grant',{source_id:prefix+'source:shared',expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:null,embedding_provider:null,conversation_providers:[]}})
  assert.equal(snapshot().draft,null)
 }finally{db.close()}
})

test('shared products reject ungrounded suggestions even when the profile is grounded',()=>{
 const {db,process,add,bind}=setup()
 try{
  const evidence=add('shared');const batch=process({action:'claim'})!;bind(batch);process({action:'read',batch_id:batch.id})
  const refs=[{entry_id:evidence,version:'shared'}]
  assert.throws(()=>process({action:'publish',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,expected_revision:0,draft:{about:{text:'Known',refs},work:[],interests:[]},refs:batch.items,products:{projects:[],suggestions:[{id:'bad',kind:'action',title:'Invented',body:'Unknown',project_id:null,todo_id:null,due:null,refs:[{entry_id:'not-read',version:'v'}]}]}}),/INVALID/)
 }finally{db.close()}
})

test('participant policy is enforced during reads and opt-out records durable interest cleanup',()=>{
 const {db}=setup();const now=new Date().toISOString(),source_id=prefix+'chat',evidence=prefix+'participant'
 const process=(participants:boolean,request:Record<string,unknown>)=>memoryOperation(db,'source_processing',{prefix,provider,participants,...request}) as Record<string,unknown>
 try{memoryOperation(db,'append_evidence',{id:evidence,source_id,source_kind:'im',locator:'message',raw_text:'Other participant message',hash:'p',observed_at:now,recorded_at:now,trust:'untrusted_external',source_metadata:{sender_id:'other',recipient_id:'self',account_id:'acct',mention:'none'}});memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
 assert.equal(process(false,{action:'claim'}),null)
 const batch=process(true,{action:'claim'}) as unknown as Batch;assert.equal(batch.items.length,1)
 process(true,{action:'bind',batch_id:batch.id,task_id:'t',run_id:'r'});process(true,{action:'read',batch_id:batch.id})
 process(true,{action:'publish',batch_id:batch.id,task_id:'t',run_id:'r',expected_revision:0,draft:{about:{text:'Participant context',refs:[{entry_id:evidence,version:'p'}]},work:[],interests:[]},refs:batch.items})
 assert.ok(process(true,{action:'products'}).draft)
 const off=process(false,{action:'products'});assert.equal(off.draft,null);assert.equal(off.news_cleanup_pending,true)
 assert.equal(process(false,{action:'products'}).news_cleanup_pending,true)
 process(false,{action:'confirm_cleanup'});assert.equal(process(false,{action:'products'}).news_cleanup_pending,false)
 }finally{db.close()}
})

test('incremental publications preserve unrelated current products and erase revoked derivatives',()=>{
 const {db,process,add,bind,commit}=setup()
 const publish=(key:string,revision:number)=>{const id=add(key),batch=process({action:'claim'})!;bind(batch);process({action:'read',batch_id:batch.id});const refs=[{entry_id:id,version:key}];process({action:'publish',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,expected_revision:revision,refs:batch.items,draft:{about:null,work:[{title:key,text:key,refs}],interests:[]},products:{projects:[],suggestions:[{id:key,kind:'action',title:key,body:key,project_id:null,todo_id:null,due:null,refs}]}});commit(batch)}
 try{publish('one',0);publish('two',1)
 const products=process({action:'products'}) as {suggestions:{id:string}[];draft:{work:{title:string}[]}}
 assert.deepEqual(products.suggestions.map(s=>s.id).sort(),['one','two']);assert.equal(products.draft.work.length,2)
 memoryOperation(db,'delete_source',{source_id:prefix+'source:one'})
 const row=db.prepare('SELECT payload_json FROM processing_profiles').get()!
 assert.ok(!String(row.payload_json).includes('"title":"one"'));assert.ok(String(row.payload_json).includes('"title":"two"'))
 }finally{db.close()}
})

test('refresh requested while a batch is active survives completion and restart',()=>{
 const {db,process,add,commit}=setup()
 try{add('one');const batch=process({action:'claim'})!;process({action:'refresh'});commit(batch);initializeMemory(db);assert.ok(process({action:'claim'}))}finally{db.close()}
})

test('adoption rechecks current published suggestion and source permission in the Life transaction',()=>{
 const {db,process,add,bind}=setup()
 try{
  const evidence=add('adopt'),batch=process({action:'claim'})!;bind(batch);process({action:'read',batch_id:batch.id})
  const refs=[{entry_id:evidence,version:'adopt'}],item={id:'adopt',kind:'action',title:'Check interface',body:'Use the agreed examples',project_id:null,todo_id:null,due:null,refs}
  process({action:'publish',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,expected_revision:0,refs:batch.items,draft:{about:null,work:[],interests:[]},products:{projects:[],suggestions:[item]}})
  const namespace=prefix+'life:',legacy={todos:[],ideas:[],goals:[],profile:{about:'',version:0},receipts:{}}
  memoryOperation(db,'life_load',{namespace,legacy})
  const mutation={namespace,requestId:'adopt',expectedRevision:0,sourcePolicy:{provider,recipe:'source-processing-v3',participants:false},input:{op:'from_suggestion',suggestion_id:'adopt',title:item.title,note:item.body,todo_id:null,due:null,sources:[],provenance_refs:[evidence]}}
  memoryOperation(db,'source_grant',{source_id:prefix+'source:adopt',expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:null,embedding_provider:null,conversation_providers:[]}})
  assert.throws(()=>memoryOperation(db,'life_mutate',mutation),/STALE/)
  const after=memoryOperation(db,'life_load',{namespace}) as {state:{todos:unknown[]}};assert.equal(after.state.todos.length,0)
 }finally{db.close()}
})

test('Git state changes invalidate published project claims and enqueue new work',()=>{
 const {db,process,add,bind,commit}=setup()
 try{const id=add('git');process({action:'project_state',ids:[id],fingerprint:'head-one'});const batch=process({action:'claim'})!;bind(batch);process({action:'read',batch_id:batch.id});const refs=[{entry_id:id,version:'git'}]
 process({action:'publish',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,expected_revision:0,refs:batch.items,draft:{about:{text:'Historical work',refs},work:[],interests:[]}});commit(batch)
 process({action:'project_state',ids:[id],fingerprint:'head-two'});assert.equal((process({action:'products'}) as {draft:unknown}).draft,null);assert.ok(process({action:'claim'}))
 }finally{db.close()}
})

test('later slices of one document preserve earlier Profile parts and suggestions',()=>{
 const {db,process,add,bind,commit}=setup()
 try{const id=add('long-profile','a'.repeat(24000)),refs=[{entry_id:id,version:'long-profile'}]
 for(const [index,title] of ['First work','Later work'].entries()){const batch=process({action:'claim'})!;bind(batch);process({action:'read',batch_id:batch.id});process({action:'publish',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,expected_revision:index,refs:batch.items,draft:{about:{text:title,refs},work:[{title,text:title,refs}],interests:[]},products:{projects:[],suggestions:[{id:title,kind:'action',title,body:title,project_id:null,todo_id:null,due:null,refs}]}});commit(batch)}
 const current=process({action:'products'}) as {draft:{about:{text:string};work:unknown[]};suggestions:unknown[]}
 assert.equal(current.draft.work.length,2);assert.equal(current.suggestions.length,2);assert.match(current.draft.about.text,/First work/);assert.match(current.draft.about.text,/Later work/)
 }finally{db.close()}
})

test('user correction atomically supersedes source-derived understanding and can be processed',()=>{
 const {db,process,add,bind}=setup()
 try{const evidence=add('incorrect'),refs=[{entry_id:evidence,version:'incorrect'}],batch=process({action:'claim'})!;bind(batch);process({action:'read',batch_id:batch.id})
 process({action:'publish',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,expected_revision:0,refs:batch.items,draft:{about:{text:'Wrong role',refs},work:[],interests:[]}})
 const now=new Date().toISOString(),entry_id=prefix+'fact:role'
 memoryOperation(db,'merge',{entry_id,expected_revision:0,kind:'fact',origin:'inferred',written_by:'merge',evidence_refs:[evidence],content:{text:'Wrong role'},recorded_at:now})
 const correction=prefix+'e:correction',source_id=prefix+'correction';memoryOperation(db,'append_evidence',{id:correction,source_id,source_kind:'user_correction',locator:'correction',observed_at:now,recorded_at:now,raw_text:'I coordinate the team, not implementation.',hash:'corrected',trust:'trusted_user'})
 memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
 memoryOperation(db,'merge',{entry_id,expected_revision:1,kind:'fact',origin:'stated',written_by:'user_correction',evidence_refs:[correction],content:{text:'I coordinate the team, not implementation.'},recorded_at:now})
 assert.equal((process({action:'products'}) as {draft:unknown}).draft,null)
 assert.equal((process({action:'batch',batch_id:batch.id}) as {valid:boolean}).valid,false)
 process({action:'retire',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,reason:'task_terminal'})
 const next=process({action:'claim'})!;assert.ok(next.items.some(item=>item.evidence_id===correction));assert.ok(!next.items.some(item=>item.evidence_id===evidence))
 }finally{db.close()}
})

test('dismissed identities survive rewritten evidence but never bypass current permission',()=>{
 const {db,process,add,bind,commit}=setup()
 try{const id=add('rewrite','Check the API'),batch=process({action:'claim'})!;bind(batch);process({action:'read',batch_id:batch.id});const refs=[{entry_id:id,version:'rewrite'}]
 process({action:'publish',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,expected_revision:0,refs:batch.items,draft:{about:null,work:[],interests:[]},products:{projects:[],suggestions:[{id:'stable-action',kind:'action',title:'Check API',body:'Check API',project_id:null,todo_id:null,due:null,refs}]}});process({action:'dismiss',id:'stable-action'});commit(batch)
 const now=new Date().toISOString();memoryOperation(db,'append_evidence',{id:id+'-v2',source_id:prefix+'source:rewrite',source_kind:'file',locator:'rewrite',raw_text:'Verify the revised interface',hash:'rewrite-v2',observed_at:now,recorded_at:now,trust:'untrusted_external'})
 const next=process({action:'claim'})!;bind(next);const query={action:'identities',batch_id:next.id,task_id:'task:'+next.id,run_id:'run:'+next.id,refs:next.items}
 const rows=process(query) as {items:{id:string;body?:string}[]};assert.equal(rows.items[0]?.id,'stable-action');assert.equal(rows.items[0]?.body,undefined)
 memoryOperation(db,'source_grant',{source_id:prefix+'source:rewrite',expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:null,embedding_provider:null,conversation_providers:[]}})
 assert.throws(()=>process(query),/STALE|INVALID|NOT_FOUND/)
 }finally{db.close()}
})


test('todo model context excludes revoked sources and fences revocation during generation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-processing-todos-')),client=new MemoryLedgerClient(join(dir,'ledger.sqlite'))
 const resource=new SubstrateMemoryResource({client,userId:'todo-context',model:'fixture',extractionFingerprint:provider,personalMemoryEnabled:false,gateway:{async *stream(){/* unused */},complete(){throw Error('unused')}}})
 try{
  await resource.open();const now=new Date().toISOString(),source_id=resource.prefix+'source:todo',id=resource.prefix+'e:todo'
  await client.memory('append_evidence',{id,source_id,source_kind:'file',locator:'plan',raw_text:'Private action',hash:'v1',observed_at:now,recorded_at:now,trust:'untrusted_external'})
  await client.memory('source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
  await client.memory('merge',{entry_id:resource.prefix+'todo:one',expected_revision:0,kind:'todo',origin:'inferred',written_by:'merge',evidence_refs:[id],content:{text:'Private action',life_data:{id:'one',title:'Private action',status:'open',version:1,note:'',due:null,goal_id:null,idea_id:null,created_at:now,updated_at:now}},recorded_at:now})
  const initial=await resource.sourceProcessingTodoContext();assert.equal(initial.todos.length,1)
  await client.memory('source_grant',{source_id,expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:null,embedding_provider:null,conversation_providers:[]}})
  await assert.rejects(initial.authorize(),/processing_context_unavailable/)
  assert.deepEqual((await resource.sourceProcessingTodoContext()).todos,[])
 }finally{await resource.close();await rm(dir,{recursive:true,force:true})}
})


test('first refresh prioritizes recent authorized messages without skipping the older file queue',()=>{
 const {db,process,add,bind,commit}=setup()
 try{const file=add('old-file'),at=new Date().toISOString(),source_id=prefix+'recent',id=prefix+'e:recent'
 memoryOperation(db,'append_evidence',{id,source_id,source_kind:'conversation',locator:'recent',raw_text:'Review my interface tomorrow',hash:'recent',observed_at:at,recorded_at:at,trust:'trusted_user'})
 memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
 const first=process({action:'claim'})!;assert.deepEqual(first.items.map(item=>item.evidence_id),[id]);bind(first);process({action:'fail',batch_id:first.id,task_id:'task:'+first.id,run_id:'run:'+first.id})
 const retry=process({action:'claim'})!;assert.deepEqual(retry.items,first.items);commit(retry)
 const next=process({action:'claim'})!;assert.ok(next.items.some(item=>item.evidence_id===file));assert.ok(!next.items.some(item=>item.evidence_id===id));commit(next);assert.equal(process({action:'claim'}),null)
 process({action:'refresh'});assert.equal(process({action:'claim'})?.items[0]?.evidence_id,id)
 }finally{db.close()}
})

test('priority refresh drains multiple message batches before the old file backlog',()=>{
 const {db,process,add,commit}=setup()
 try{
  const file=add('backlog'),messages=new Set<string>()
  for(let n=0;n<12;n++){
   const source_id=prefix+'message:'+n,id=prefix+'e:message:'+n,at=new Date(Date.UTC(2026,9,15,0,n)).toISOString();messages.add(id)
   memoryOperation(db,'append_evidence',{id,source_id,source_kind:'conversation',locator:String(n),raw_text:'A distinct authorized conversation '+n,hash:String(n),observed_at:at,recorded_at:at,trust:'trusted_user'})
   memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
  }
  const first=process({action:'claim'})!;assert.equal(first.items.length,8);commit(first)
  const second=process({action:'claim'})!;assert.equal(second.items.length,4);assert.ok(second.items.every(item=>messages.has(item.evidence_id)));assert.ok(second.items.every(item=>!first.items.some(prior=>prior.evidence_id===item.evidence_id)));commit(second)
  const next=process({action:'claim'})!;assert.deepEqual(next.items.map(item=>item.evidence_id),[file]);commit(next);assert.equal(process({action:'claim'}),null)
 }finally{db.close()}
})

test('profile synthesis reads durable observations across batches and replaces the whole portrait',()=>{
 const {db,process,add,bind,commit}=setup()
 try{
  add('long-term','I lead the Orchard project with Mei.');const first=process({action:'claim'})!;bind(first)
  const owner=(b:Batch)=>({batch_id:b.id,task_id:'task:'+b.id,run_id:'run:'+b.id})
  process({action:'evidence',...owner(first),refs:first.items})
  process({action:'observe',...owner(first),refs:first.items,observations:[{kind:'people',text:'Coordinates Orchard with Mei.',refs:first.items}]})
  commit(first)
  add('recent-test','Please run the microphone acceptance check.');const next=process({action:'claim'})!;bind(next)
  process({action:'evidence',...owner(next),refs:next.items})
  process({action:'observe',...owner(next),refs:next.items,observations:[]})
  const context=process({action:'profile_context',...owner(next)}) as {items:{evidence_id:string;text:string}[];observations:{text:string}[];refs:Item[];key:string}
  assert.deepEqual(context.items.map(i=>i.evidence_id),[prefix+'e:long-term'])
  assert.equal(context.observations[0]?.text,'Coordinates Orchard with Mei.')
  const draft={about:{text:'You coordinate Orchard with Mei.',refs:[{entry_id:prefix+'e:long-term',version:'long-term'}]},work:[],interests:[]}
  process({action:'publish',...owner(next),expected_revision:0,draft,refs:context.refs,profile_context_key:context.key,products:{projects:[],suggestions:[{id:'orchard-review',kind:'action',title:'Review Orchard',body:'Review with Mei',project_id:null,todo_id:null,due:null,refs:draft.about.refs}]}})
  const published=process({action:'profile'}) as {draft:typeof draft}
  assert.equal(published.draft.about.text,'You coordinate Orchard with Mei.')
  commit(next)
  add('updated','Orchard is now complete.');const last=process({action:'claim'})!;bind(last)
  process({action:'evidence',...owner(last),refs:last.items})
  process({action:'observe',...owner(last),refs:last.items,observations:[{kind:'work',text:'Orchard completed.',refs:last.items}]})
  const updated=process({action:'profile_context',...owner(last)}) as typeof context
  process({action:'publish',...owner(last),expected_revision:1,draft:{...draft,about:{text:'You completed Orchard with Mei.',refs:[...draft.about.refs,{entry_id:prefix+'e:updated',version:'updated'}]}},refs:updated.refs,profile_context_key:updated.key,product_refs:last.items,products:{projects:[],suggestions:[]}})
  assert.equal((process({action:'profile'}) as {draft:typeof draft}).draft.about.text,'You completed Orchard with Mei.')
  assert.equal((process({action:'products'}) as {suggestions:{id:string}[]}).suggestions[0]?.id,'orchard-review')
 }finally{db.close()}
})

test('revocation invalidates a previously prepared whole-profile publication',()=>{
 const {db,process,add,bind}=setup()
 try{
  add('one');const batch=process({action:'claim'})!;bind(batch);const owner={batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id}
  process({action:'evidence',...owner,refs:batch.items})
  process({action:'observe',...owner,refs:batch.items,observations:[{kind:'work',text:'Project planning',refs:batch.items}]})
  const context=process({action:'profile_context',...owner}) as {key:string;refs:Item[]}
  memoryOperation(db,'source_grant',{source_id:prefix+'source:one',expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:null,embedding_provider:null,conversation_providers:[]}})
  assert.throws(()=>process({action:'publish',...owner,expected_revision:0,profile_context_key:context.key,refs:context.refs,draft:{about:{text:'Project planner',refs:[{entry_id:prefix+'e:one',version:'one'}]},work:[],interests:[]}}),/STALE|INVALID/)
  assert.equal((process({action:'profile'}) as {draft:unknown}).draft,null)
 }finally{db.close()}
})

test('initial profile waits for the authorized message sample, then survives restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'profile-observation-restart-')),path=join(dir,'ledger.sqlite');let fixture=setup(path)
 try{
  for(let i=0;i<10;i++){
   const source_id=prefix+'chat:'+i,id=prefix+'message:'+i,at=new Date(1790000000000+i*1000).toISOString()
   memoryOperation(fixture.db,'append_evidence',{id,source_id,source_kind:'conversation',locator:'conversation:'+i,raw_text:'I coordinate Orchard with Mei '+i,hash:'v'+i,observed_at:at,recorded_at:at,trust:'trusted_user'})
   memoryOperation(fixture.db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
  }
  const owner=(b:Batch)=>({batch_id:b.id,task_id:'task:'+b.id,run_id:'run:'+b.id})
  const first=fixture.process({action:'claim'})!;fixture.bind(first)
  fixture.process({action:'observe',...owner(first),refs:first.items,observations:[{kind:'people',text:'Coordinates Orchard with Mei',refs:[first.items[0]]}]})
  assert.equal((fixture.process({action:'profile_context',...owner(first)}) as {ready:boolean}).ready,false)
  fixture.commit(first);fixture.db.close();fixture=setup(path)
  const second=fixture.process({action:'claim'})!;fixture.bind(second)
  fixture.process({action:'observe',...owner(second),refs:second.items,observations:[]})
  const context=fixture.process({action:'profile_context',...owner(second)}) as {ready:boolean;observations:{text:string}[]}
  assert.equal(context.ready,true);assert.equal(context.observations[0]?.text,'Coordinates Orchard with Mei')
 }finally{fixture.db.close();await rm(dir,{recursive:true,force:true})}
})

test('provider changes and revoked interest evidence request durable cleanup without endless retries',()=>{
 const {db,process,add,bind}=setup()
 try{
  const id=add('interest'),batch=process({action:'claim'})!;bind(batch);process({action:'read',batch_id:batch.id})
  process({action:'publish',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,expected_revision:0,refs:batch.items,draft:{about:null,work:[],interests:[{text:'Orchard research',refs:[{entry_id:id,version:'interest'}]}]}})
  memoryOperation(db,'source_grant',{source_id:prefix+'source:interest',expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:null,embedding_provider:null,conversation_providers:[]}})
  assert.equal((process({action:'products'}) as {news_cleanup_pending:boolean}).news_cleanup_pending,true)
  process({action:'confirm_cleanup'})
  assert.equal((process({action:'products'}) as {news_cleanup_pending:boolean}).news_cleanup_pending,false)
  assert.equal((memoryOperation(db,'source_processing',{prefix,provider:'replacement-provider',action:'products'}) as {news_cleanup_pending:boolean}).news_cleanup_pending,true)
 }finally{db.close()}
})

test('shared sources retain the original channel metadata for display and adoption',()=>{
 const {db,process,bind}=setup()
 try{
  const id=prefix+'e:message',source_id=prefix+'messages',now=new Date().toISOString()
  memoryOperation(db,'append_evidence',{id,source_id,source_kind:'im',locator:'feishu://message/synthetic',raw_text:'I will review the design.',hash:'1',observed_at:now,recorded_at:now,trust:'untrusted_external',source_metadata:{sender_id:'self',recipient_id:'self',account_id:'synthetic',provider:'feishu',source_url:'https://example.com/message'}})
  memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
  const batch=process({action:'claim'})!;bind(batch);const owner={batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id}
  process({action:'evidence',...owner,refs:batch.items})
  process({action:'publish',...owner,expected_revision:0,draft:{about:{text:'I will review the design.',refs:[{entry_id:id,version:'1'}]},work:[],interests:[]},refs:batch.items,products:{projects:[],suggestions:[]}})
  const result=process({action:'products'}) as {sources:{type:string;provider:string;url:string}[]}
  assert.equal(result.sources[0]?.type,'im');assert.equal(result.sources[0]?.provider,'feishu');assert.equal(result.sources[0]?.url,'https://example.com/message')
 }finally{db.close()}
})


test('older synthesis rules require rewriting without discarding durable observations',()=>{
 const {db,process,add,bind}=setup()
 try{
  const id=add('project','I lead Orchard.'),batch=process({action:'claim'})!;bind(batch)
  const owner={batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id}
  process({action:'observe',...owner,refs:batch.items,observations:[{kind:'work',text:'Leads Orchard',refs:batch.items}]})
  const context=process({action:'profile_context',...owner}) as {key:string;refs:Item[]}
  const publish=()=>process({action:'publish',...owner,expected_revision:(process({action:'profile'}) as {revision:number}).revision,profile_context_key:context.key,refs:context.refs,draft:{about:{text:'You lead Orchard.',refs:[{entry_id:id,version:'project'}]},work:[],interests:[]}})
  publish();assert.equal((process({action:'profile_context',...owner}) as {unchanged:boolean}).unchanged,true)
  process({action:'commit',...owner,topics:[]});assert.equal(process({action:'claim'}),null)
  db.prepare("UPDATE processing_profiles SET payload_json=json_remove(payload_json,'$.generation_version')").run()
  const rewrite=process({action:'claim'});assert.ok(rewrite,'upgraded rules must schedule a rewrite even with no new source events');bind(rewrite)
  const rewriteOwner={batch_id:rewrite.id,task_id:'task:'+rewrite.id,run_id:'run:'+rewrite.id}
  const old=process({action:'profile_context',...rewriteOwner}) as {unchanged:boolean;observations:unknown[];key:string;refs:Item[]}
  assert.equal(old.unchanged,false);assert.equal(old.observations.length,1)
  process({action:'publish',...rewriteOwner,expected_revision:1,profile_context_key:old.key,refs:old.refs,draft:{about:{text:'You lead Orchard.',refs:[{entry_id:id,version:'project'}]},work:[],interests:[]}})
  process({action:'commit',...rewriteOwner,topics:[]});assert.equal(process({action:'claim'}),null)
 }finally{db.close()}
})


test('published profile is a display-only last success across recipe changes and source deletion',()=>{
 const {db,process,add,bind}=setup()
 try{
  const id=add('history','PRIVATE RAW ORIGINAL THAT MUST NOT BE ARCHIVED'),batch=process({action:'claim'})!;bind(batch);process({action:'read',batch_id:batch.id})
  process({action:'publish',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,expected_revision:0,refs:batch.items,draft:{about:{text:'Previously established profile.',refs:[{entry_id:id,version:'history'}]},work:[],interests:[]},products:{projects:[],suggestions:[]}})
  // Simulate a genuinely old successful cache imported by the migration.
  db.prepare("UPDATE processing_profiles SET payload_json=json_set(payload_json,'$.generation_version','understanding-v7','$.generated_at','2026-10-18T12:00:00.000Z')").run();db.prepare('DELETE FROM processing_publications').run();initializeMemory(db)
  const read=(presentation=false)=>memoryOperation(db,'source_processing',{prefix,provider,recipe:'new-v8-recipe',action:'products',presentation}) as {draft:unknown;last_success?:{draft:{about:{text:string}};generation_version:string;generated_at:string;unavailable_sources:number;read_only:boolean}}
  assert.equal(read().draft,null);assert.equal(read().last_success,undefined)
  let history=read(true).last_success!;assert.equal(history.draft.about.text,'Previously established profile.');assert.equal(history.generation_version,'understanding-v7');assert.equal(history.generated_at,'2026-10-18T12:00:00.000Z');assert.equal(history.read_only,true)
  memoryOperation(db,'delete_source',{source_id:prefix+'source:history'});initializeMemory(db)
  history=read(true).last_success!;assert.equal(history.draft.about.text,'Previously established profile.');assert.equal(history.unavailable_sources,1);assert.equal(read().draft,null)
  const archive=String(db.prepare('SELECT payload_json FROM processing_publications').get()!.payload_json);assert.ok(!archive.includes('PRIVATE RAW ORIGINAL'))
  assert.equal((memoryOperation(db,'source_processing',{prefix:'personal:other:',provider,action:'products',presentation:true}) as {last_success:unknown}).last_success,null)
 }finally{db.close()}
})

test('published discussion profile survives logout and file drafts but never follows another Feishu account',()=>{
 const {db,process,bind}=setup();const id=prefix+'account-message',source_id=prefix+'chat',now=new Date().toISOString()
 try{
  memoryOperation(db,'append_evidence',{id,source_id,source_kind:'im',locator:'message',raw_text:'I manage a team',hash:'account-hash',observed_at:now,recorded_at:now,trust:'untrusted_external',source_metadata:{sender_id:'self',recipient_id:'self',account_id:'original-account',mention:'direct'}})
  memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
  const batch=process({action:'claim'})!;bind(batch);process({action:'read',batch_id:batch.id});process({action:'publish',batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id,expected_revision:0,refs:batch.items,draft:{about:{text:'You manage a team.',refs:[{entry_id:id,version:'account-hash'}]},work:[],interests:[]}})
  const read=(account_scope?:string)=>process({action:'products',presentation:true,...(account_scope?{account_scope}: {})}) as {last_success:unknown}
  assert.ok(read('original-account').last_success);assert.equal(read('other-account').last_success,null);assert.ok(read().last_success,'local published prose remains readable while logged out')
  const archived=db.prepare('SELECT payload_json FROM processing_publications').get()!
  const fileDraft=JSON.parse(String(archived.payload_json)) as {draft:{about:{text:string}};sources:{type:string}[]};fileDraft.draft.about.text='New file-derived draft';for(const source of fileDraft.sources)source.type='file'
  db.prepare('INSERT INTO processing_publications VALUES(?,?,?,?,?)').run(prefix,'file-recipe','file-publication','[]',JSON.stringify(fileDraft))
  assert.equal((read().last_success as typeof fileDraft).draft.about.text,'You manage a team.','discussion portrait takes priority over a later file-only draft')
  memoryOperation(db,'delete_source',{source_id});initializeMemory(db)
  assert.ok(read('original-account').last_success);assert.ok(read().last_success)
  assert.equal((read('other-account').last_success as typeof fileDraft).draft.about.text,'New file-derived draft')
  db.prepare('INSERT INTO processing_publications VALUES(?,?,?,?,?)').run(prefix,'other-recipe','other-publication','["other-account"]',String(archived.payload_json))
  assert.equal((read().last_success as typeof fileDraft).draft.about.text,'New file-derived draft','logged-out fallback does not guess between different saved accounts')
 }finally{db.close()}
})
