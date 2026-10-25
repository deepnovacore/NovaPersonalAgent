import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {initializeMemory,memoryOperation,type MemoryOperation,type EntryRevision,type EvidenceRecord} from '../src/memory-substrate/store.js'
import {understandingFixture} from '../src/understanding/fixture.js'
import type {LifeState} from '../src/personal-agent/life.js'
import {normalizeLifeContent} from '../src/memory-substrate/life-operations.js'

const namespace='personal:test:life:'
const empty=()=>({todos:[],ideas:[],goals:[],profile:{about:'',version:0},receipts:{}})
interface Loaded {revision:number;state:LifeState;result:{id:string;version:number}}
function setup(){const db=new DatabaseSync(':memory:');initializeMemory(db);return {db,run:(op:string,input:unknown)=>memoryOperation(db,op as MemoryOperation,input) as Loaded}}

test('workbench capture revalidates explicit evidence, preserves provenance and can undo a goal',()=>{
 const {db,run}=setup()
 try{
  const initial=run('life_load',{namespace,legacy:empty()}),refs=[{entry_id:'source:plan',version:'v1',quote:'我的长期目标是每天使用自己的助手。'}]
  const proof={kind:'goal',title:'每天使用自己的助手',summary:'持续改进日常使用体验',ownership:'user',assertion:'direct',state:'open',due:null,due_quote:null,refs}
  const input={op:'from_workbench',kind:'goal',title:proof.title,note:proof.summary,due:null,success_criteria:'',automatic:true,source:{candidate_id:'daily-goal',refs},sources:[],proof,evidence:[{id:'source:plan',version:'v1',kind:'file',text:refs[0]!.quote,observed_at:'2026-10-18T00:00:00Z'}]}
  const request={namespace,expectedRevision:initial.revision,requestId:'daily-goal',input,workbench_provider:'test-provider'}
  assert.throws(()=>run('life_mutate',{...request,input:{...input,proof:{...proof,assertion:'inferred'}}}),/workbench_capture_not_explicit/)
  assert.throws(()=>run('life_mutate',{...request,input:{...input,evidence:[{...input.evidence[0],text:'无关原文'}]}}),/workbench_invalid_evidence/)
  const saved=run('life_mutate',request);assert.equal(saved.state.goals.length,1);assert.equal(saved.state.goals[0]!.auto_recorded,true)
  const entry=(memoryOperation(db,'list',{}) as EntryRevision[]).find(r=>r.kind==='goal')!,event=memoryOperation(db,'evidence',{id:entry.evidence_refs[0]}) as EvidenceRecord
  assert.equal(event.extracted.event,'workbench_capture');assert.equal(event.trust,'trusted_system')
  const repeated=run('life_mutate',request);assert.equal(repeated.state.goals.length,1)
  const undone=run('life_mutate',{namespace,expectedRevision:saved.revision,requestId:'undo-daily-goal',input:{op:'undo_create',kind:'goal',id:saved.result.id,expected_version:1}});assert.equal(undone.state.goals.length,0)
 }finally{db.close()}
})

test('workbench message capture fails closed when original evidence is unavailable in storage',()=>{
 const {db,run}=setup()
 try{
  const initial=run('life_load',{namespace,legacy:empty()}),refs=[{entry_id:'missing-message',version:'v1',quote:'我要完成报告'}],proof={kind:'goal',title:'完成报告',summary:'完成报告',ownership:'user',assertion:'direct',state:'open',due:null,due_quote:null,refs}
  const input={op:'from_workbench',kind:'goal',title:proof.title,note:proof.summary,due:null,success_criteria:'',automatic:true,source:{candidate_id:'m',refs},sources:[],proof,evidence:[{id:'missing-message',version:'v1',kind:'im',text:refs[0]!.quote,observed_at:'2026-10-18T00:00:00Z',relation:'self',author:{key:'u',kind:'person',is_user:true}}]}
  assert.throws(()=>run('life_mutate',{namespace,expectedRevision:initial.revision,requestId:'m',input,workbench_provider:'test'}),/workbench_source_changed/)
  assert.equal(run('life_load',{namespace}).state.goals.length,0)
 }finally{db.close()}
})

test('life migration preserves legacy text and version without inventing original evidence; empty cutover is durable',()=>{
 const {db,run}=setup()
 try{
  const legacy={...empty(),profile:{about:'手工全文\n不能推断原始出处',version:9}}
  const first=run('life_load',{namespace,legacy});assert.deepEqual(first.state.profile,legacy.profile)
  const row=(memoryOperation(db,'list',{}) as EntryRevision[]).find(r=>r.kind==='profile')!
  assert.equal(row.content.legacy,true)
  const evidence=memoryOperation(db,'evidence',{id:row.evidence_refs[0]}) as EvidenceRecord
  assert.equal(evidence.raw_text,null);assert.equal(evidence.extracted.original_evidence_available,false)
  assert.equal(run('life_load',{namespace,legacy:{...legacy,profile:{about:'不可重新导入',version:99}}}).state.profile.about,legacy.profile.about)
  run('life_load',{namespace:'personal:empty:life:',legacy:empty()})
  assert.equal(run('life_load',{namespace:'personal:empty:life:',legacy}).state.profile.about,'')
 }finally{db.close()}
})

test('worker Life transitions are transactional, idempotent, CAS fenced and reconstructed from merge rows',()=>{
 const {db,run}=setup()
 try{
  let loaded=run('life_load',{namespace,legacy:empty()})
  const mutate=(input:unknown,requestId:string,expectedRevision=loaded.revision)=>{const next=run('life_mutate',{namespace,input,requestId,expectedRevision});loaded=next;return next.result}
  const idea=mutate({op:'create',kind:'idea',title:'学习日语'},'idea')
  const goal=mutate({op:'convert',id:idea.id,target:'goal',expected_version:1},'goal')
  assert.equal(mutate({op:'convert',id:idea.id,target:'goal',expected_version:1},'goal-again').id,goal.id)
  const todo=mutate({op:'create',kind:'todo',title:'第一课',goal_id:goal.id},'todo')
  const before=loaded.revision
  mutate({op:'update',kind:'todo',id:todo.id,expected_version:1,status:'done'},'done')
  assert.throws(()=>mutate({op:'profile',expected_version:0,about:'过期更新'},'stale',before),/version_conflict/)
  assert.throws(()=>mutate({op:'undo_create',id:todo.id,expected_version:1},'undo-edited'),/version_conflict/)
  assert.throws(()=>mutate({op:'create',kind:'todo',title:'坏链接',goal_id:'missing'},'bad'),/goal_not_found/)
  assert.deepEqual(mutate({op:'update',kind:'todo',id:todo.id,expected_version:1,status:'done'},'done',before),{id:todo.id,version:2},'receipt retries succeed despite stale aggregate CAS')
  const another=mutate({op:'create',kind:'todo',title:'可撤销'},'another');mutate({op:'undo_create',id:another.id,expected_version:1},'undo')
  const rows=memoryOperation(db,'list',{include_history:true}) as EntryRevision[]
  assert.equal(rows.find(r=>r.content.life_id===another.id)?.op,'tombstone')
  const reloaded=run('life_load',{namespace,legacy:empty()});assert.equal(reloaded.state.todos.length,1)
  assert.equal(reloaded.state.todos[0]!.status,'done')
 }finally{db.close()}
})

test('accepted Understanding candidates retain source, span and decision in their evidence event',()=>{
 const {db,run}=setup()
 try{
  const loaded=run('life_load',{namespace,legacy:empty()}),row=understandingFixture().find(r=>r.candidate.kind==='profile')!
  run('life_mutate',{namespace,expectedRevision:loaded.revision,requestId:'candidate:'+row.candidate.id,input:{op:'profile',expected_version:0,about:row.candidate.text},provenance:{type:'accepted_candidate',row}})
  const entry=(memoryOperation(db,'list',{}) as EntryRevision[]).find(r=>r.kind==='profile')!
  const evidence=memoryOperation(db,'evidence',{id:entry.evidence_refs[0]}) as EvidenceRecord
  assert.equal(evidence.source_kind,'user_correction')
  assert.equal(evidence.extracted.event,'accepted_candidate')
  assert.deepEqual(evidence.extracted.candidate,row.candidate)
  assert.deepEqual(evidence.extracted.decision,row.decision)
  assert.equal(evidence.raw_text,row.source.text)
  assert.equal((evidence.extracted.source as {id:string}).id,row.source.id)
 }finally{db.close()}
})

test('out-of-band domain edits invalidate aggregate CAS and load refreshes the version',()=>{
 const {db,run}=setup()
 try{
  const first=run('life_load',{namespace,legacy:empty()})
  const added=run('life_mutate',{namespace,expectedRevision:first.revision,requestId:'profile',input:{op:'profile',expected_version:0,about:'旧内容'}})
  const profile=(memoryOperation(db,'list',{}) as EntryRevision[]).find(r=>r.kind==='profile')!
  memoryOperation(db,'merge',{entry_id:profile.entry_id,expected_revision:profile.revision,kind:profile.kind,origin:'stated',written_by:'user_correction',evidence_refs:profile.evidence_refs,content:{...profile.content,text:'手改'},recorded_at:new Date().toISOString()})
  assert.throws(()=>run('life_mutate',{namespace,expectedRevision:added.revision,requestId:'stale',input:{op:'profile',expected_version:1,about:'不得覆盖'}}),/version_conflict/)
  const loaded=run('life_load',{namespace,legacy:empty()});assert.equal(loaded.state.profile.about,'手改');assert.equal(loaded.state.profile.version,2);assert.equal(loaded.revision,added.revision+1)
 }finally{db.close()}
})

test('Life editable body normalization rejects oversized edits and does not bump a normal mutation twice',()=>{
 const previous={life_data:{about:'旧内容',version:7},text:'旧内容'}
 const next=normalizeLifeContent('profile',{...previous,text:'手改内容'},previous)
 assert.deepEqual(next.life_data,{about:'手改内容',version:8})
 assert.deepEqual(normalizeLifeContent('profile',next,previous),next)
 assert.throws(()=>normalizeLifeContent('profile',{...previous,text:'字'.repeat(5001)},previous))
})

test('editing one migrated object does not suppress the evidence of other legacy objects',()=>{
 const {db,run}=setup()
 try{
  const item=(id:string)=>({id,version:1,title:id,note:'',created_at:'2026-09-21T00:00:00Z',updated_at:'2026-09-21T00:00:00Z',status:'open',due:null,goal_id:null,idea_id:null})
  const loaded=run('life_load',{namespace,legacy:{...empty(),todos:[item('first'),item('second')]}})
  const other=(memoryOperation(db,'list',{}) as EntryRevision[]).find(r=>r.content.life_id==='second')!
  run('life_mutate',{namespace,expectedRevision:loaded.revision,requestId:'edit-first',input:{op:'update',kind:'todo',id:'first',expected_version:1,title:'修正第一项'}})
  assert.notEqual(memoryOperation(db,'retrieval_evidence',{id:other.evidence_refs[0]}),null)
 }finally{db.close()}
})

test('Life evidence processing requires an explicit host provider grant, including legacy import',()=>{
 const {db,run}=setup(),processingGrant={revision:1,scope_revision:0,extraction_provider:'consented-model',embedding_provider:null}
 try{
  const first=run('life_load',{namespace,legacy:{...empty(),profile:{about:'legacy profile',version:1}}})
  let profile=(memoryOperation(db,'list',{}) as EntryRevision[]).find(r=>r.kind==='profile')!
  assert.equal(memoryOperation(db,'processing_stamp',{ids:profile.evidence_refs,purpose:'extraction',provider:'consented-model'}),null)
  run('life_mutate',{namespace,expectedRevision:first.revision,requestId:'consented',input:{op:'profile',expected_version:1,about:'可整理内容'},processingGrant})
  profile=(memoryOperation(db,'list',{}) as EntryRevision[]).find(r=>r.kind==='profile')!
  assert.equal(typeof memoryOperation(db,'processing_stamp',{ids:profile.evidence_refs,purpose:'extraction',provider:'consented-model'}),'string')
  assert.equal(memoryOperation(db,'processing_stamp',{ids:profile.evidence_refs,purpose:'extraction',provider:'other-model'}),null)
  const grantedNamespace='personal:granted:life:'
  run('life_load',{namespace:grantedNamespace,legacy:{...empty(),profile:{about:'granted legacy profile',version:1}},processingGrant})
  const imported=(memoryOperation(db,'list',{}) as EntryRevision[]).find(r=>r.entry_id.startsWith(grantedNamespace))!
  assert.equal(typeof memoryOperation(db,'processing_stamp',{ids:imported.evidence_refs,purpose:'extraction',provider:'consented-model'}),'string')
 }finally{db.close()}
})

test('host may register a previously missing legacy backup path without replacing a known path',()=>{
 const {db,run}=setup()
 try{
  run('life_load',{namespace,legacy:empty()})
  run('life_load',{namespace,hostMigrationPath:'/synthetic/registered-life.json'})
  const read=()=>JSON.parse(String(db.prepare('SELECT payload_json FROM memory_life_meta WHERE namespace=?').get(namespace)!.payload_json)) as {legacy_path?:string}
  assert.equal(read().legacy_path,'/synthetic/registered-life.json')
  run('life_load',{namespace,hostMigrationPath:'/synthetic/unrelated.json'})
  assert.equal(read().legacy_path,'/synthetic/registered-life.json')
 }finally{db.close()}
})


test('empty cutover creates no Profile or migration evidence and explicit blank Profile remains durable',()=>{
 const {db,run}=setup(),processingGrant={revision:1,scope_revision:0,extraction_provider:'consented-model',embedding_provider:null}
 try{
  let loaded=run('life_load',{namespace,legacy:empty(),processingGrant})
  assert.deepEqual(memoryOperation(db,'list',{}),[])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_evidence').get()!.n,0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM source_grants').get()!.n,0)
  assert.notEqual(run('life_load',{namespace}),null)
  loaded=run('life_mutate',{namespace,expectedRevision:loaded.revision,requestId:'blank-profile',input:{op:'profile',expected_version:0,about:''}})
  assert.deepEqual(loaded.state.profile,{about:'',version:1})
  const profile=(memoryOperation(db,'list',{}) as EntryRevision[])[0]!
  assert.equal(profile.kind,'profile');assert.equal(profile.content.legacy,false)
  assert.deepEqual(run('life_load',{namespace}).state.profile,{about:'',version:1})
 }finally{db.close()}
})

test('failed Life revision insert rolls back evidence, processing grant and receipts together',()=>{
 const {db,run}=setup(),processingGrant={revision:1,scope_revision:0,extraction_provider:'consented-model',embedding_provider:null}
 try{
  const loaded=run('life_load',{namespace,legacy:empty()})
  const snapshot=()=>['memory_evidence','source_grants','memory_revisions','memory_life_meta'].map(table=>db.prepare('SELECT * FROM '+table).all())
  const before=snapshot();let injected=false
  const faulty={exec:db.exec.bind(db),close:db.close.bind(db),prepare:(sql:string)=>{if(sql==='INSERT INTO memory_revisions VALUES(?,?,?)'){assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_evidence').get()!.n,1,'evidence is already in the transaction');assert.equal(db.prepare('SELECT COUNT(*) n FROM source_grants').get()!.n,1,'grant is already in the transaction');injected=true;throw Error('synthetic revision failure')}return db.prepare(sql)}}
  const request={namespace,expectedRevision:loaded.revision,requestId:'atomic-profile',input:{op:'profile',expected_version:0,about:'retry me'},processingGrant}
  assert.throws(()=>memoryOperation(faulty,'life_mutate',request),/synthetic revision failure/)
  assert.equal(injected,true);assert.deepEqual(snapshot(),before)
  run('life_mutate',request);run('life_mutate',request)
  assert.equal((memoryOperation(db,'list',{}) as EntryRevision[]).filter(row=>row.kind==='profile').length,1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_evidence').get()!.n,1)
 }finally{db.close()}
})

test('workbench capture accepts Timeline authorization versions and rejects a changed grant',()=>{
 const {db,run}=setup(),source_id='personal:test:message',provider='model',text='我会整理发布材料。',now=new Date().toISOString()
 try{
  memoryOperation(db,'append_evidence',{id:'timeline-source',source_id,source_kind:'im',locator:'message',observed_at:now,recorded_at:now,raw_text:text,hash:'raw-hash',trust:'untrusted_external'})
  memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null}})
  const [e]=memoryOperation(db,'timeline_evidence',{source_prefix:'personal:test:',provider}) as EvidenceRecord[]
  assert.notEqual(e!.hash,'raw-hash')
  const refs=[{entry_id:e!.id,version:e!.hash,quote:text}],proof={kind:'goal',title:'整理发布材料',summary:'整理材料',ownership:'user',assertion:'direct',state:'open',due:null,due_quote:null,refs}
  const input={op:'from_workbench',kind:'goal',title:proof.title,note:proof.summary,due:null,success_criteria:'',automatic:true,source:{candidate_id:'timeline-candidate',refs},sources:[],proof,evidence:[{id:e!.id,version:e!.hash,kind:'im',text,observed_at:now,relation:'self',author:{key:'me',kind:'person',is_user:true}}]}
  const loaded=run('life_load',{namespace,legacy:empty()})
  const saved=run('life_mutate',{namespace,input,expectedRevision:loaded.revision,requestId:'timeline-create',workbench_provider:provider});assert.equal(saved.state.goals.length,1)
  memoryOperation(db,'source_grant',{source_id,expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:provider,embedding_provider:null}})
  assert.throws(()=>run('life_mutate',{namespace,input,expectedRevision:saved.revision,requestId:'stale-timeline-create',workbench_provider:provider}),/workbench_source_changed/)
 }finally{db.close()}
})
