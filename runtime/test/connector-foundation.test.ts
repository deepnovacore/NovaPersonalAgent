import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {connectorSourceId,initializeSourceState,assertSourceStateSchema} from '../src/memory-substrate/source-state.js'
import {WorkspaceGraphStoreClient} from '../src/workspace-graph/store-client.js'
import {initializeMemory,memoryOperation,EvidenceRecordSchema,CandidateSchema,type MemoryOperation,type EntryRevision} from '../src/memory-substrate/store.js'

test('source identity separates accounts and deletion generations within reference budget',()=>{
 const a=connectorSourceId('account',0,'x'.repeat(4096))
 assert.ok(('personal:'+ 'a'.repeat(64)+':'+a).length<=256)
 assert.equal(a,connectorSourceId('account',0,'x'.repeat(4096)))
 assert.notEqual(a,connectorSourceId('other',0,'x'.repeat(4096)))
 assert.notEqual(a,connectorSourceId('account',1,'x'.repeat(4096)))
 assert.throws(()=>connectorSourceId('account',-1,'x'))
 assert.throws(()=>connectorSourceId('account',Number.MAX_SAFE_INTEGER+1,'x'))
})

test('v3 migration preserves evidence and suppression and does not reset source clock',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-source-migration-'));const path=join(root,'memory.sqlite')
 let client=new WorkspaceGraphStoreClient(path)
 try{
  await client.open();await client.close()
  const old=new DatabaseSync(path)
  for(const table of ['source_connections','source_objects','source_pages','source_grants','source_extractions','source_clock'])old.exec(`DROP TABLE IF EXISTS ${table}`)
  old.exec('DELETE FROM schema_migrations WHERE version>3; INSERT OR IGNORE INTO schema_migrations VALUES(3,0)')
  old.prepare('INSERT INTO memory_suppressed VALUES(?)').run('forgotten')
  old.prepare('INSERT INTO memory_evidence VALUES(?,?,?,?)').run('e','s','h','{"preserve":true}')
  old.close()
  client=new WorkspaceGraphStoreClient(path);await client.open();await client.close()
  const upgraded=new DatabaseSync(path)
  assert.equal(upgraded.prepare('SELECT MAX(version) n FROM schema_migrations').get()!.n,4)
  assert.equal(upgraded.prepare('SELECT COUNT(*) n FROM memory_suppressed').get()!.n,1)
  assert.equal(upgraded.prepare('SELECT payload_json FROM memory_evidence WHERE id=?').get('e')!.payload_json,'{"preserve":true}')
  upgraded.exec('UPDATE source_clock SET revision=7');upgraded.close()
  client=new WorkspaceGraphStoreClient(path);await client.open();await client.close()
  const again=new DatabaseSync(path);assert.equal(again.prepare('SELECT revision FROM source_clock').get()!.revision,7)
  again.exec('INSERT INTO schema_migrations VALUES(999,0)');again.close()
  client=new WorkspaceGraphStoreClient(path);await assert.rejects(client.open(),{code:'STORE_SCHEMA_UNSUPPORTED'})
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('source schema rejects missing uniqueness rather than silently accepting damaged tables',()=>{
 const db=new DatabaseSync(':memory:')
 try{
  initializeSourceState(db);assertSourceStateSchema(db)
  db.exec('DROP TABLE source_grants; CREATE TABLE source_grants(source_id TEXT,payload_json TEXT NOT NULL) STRICT')
  assert.throws(()=>assertSourceStateSchema(db),/SCHEMA/)
 }finally{db.close()}
})

test('object activation withdraws derived memory, reuses A, and ignores metadata-only changes',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const run=(op:string,input:unknown)=>memoryOperation(db,op as MemoryOperation,input)
 try{
  run('source_connection',{action:'create',id:'c',namespace:'n'})
  const connected=run('source_connection',{action:'fence',id:'c',state:'connected',expected_epoch:0}) as {fence:unknown}
  const source=connectorSourceId('n',0,'message')
  const raw=(id:string)=>EvidenceRecordSchema.parse({id,source_id:source,source_kind:'mail',locator:'mail/message',observed_at:new Date().toISOString(),recorded_at:new Date().toISOString(),raw_text:id,hash:id,trust:'untrusted_external'})
  const a=raw('a'),b=raw('b')
  const page=(id:string,e:typeof a,metadata:Record<string,boolean>={})=>({fence:connected.fence,batch_id:'1',page_id:id,changes:[{object_key:'message',source_id:source,semantic_hash:e.id,metadata,evidence:[e],status:'current'}],pending_ids:[],continuation:null,checkpoint:null,complete:false})
  const first=run('source_apply_page',page('1',a)) as {revision:number;activations:{revision:number}[]}
  const candidate=CandidateSchema.parse({entry_id:'promise',kind:'fact',origin:'inferred',written_by:'merge',evidence_refs:['a'],content:{text:'promise from A'},recorded_at:new Date().toISOString()})
  run('merge',candidate)
  const independent=raw('independent');independent.source_id='user-source';independent.source_kind='user_correction';independent.trust='trusted_user'
  run('append_evidence',independent)
  run('merge',{...candidate,entry_id:'mixed',evidence_refs:['a','independent']})
  run('merge',{...candidate,entry_id:'user',origin:'stated',written_by:'user_correction',evidence_refs:['independent']})
  run('source_apply_page',page('2',b))
  assert.equal(run('retrieval_evidence',{id:'a'}),null)
  assert.equal((run('history',{entry_id:'promise'}) as EntryRevision[]).at(-1)!.op,'tombstone')
  assert.equal((run('history',{entry_id:'mixed'}) as EntryRevision[]).at(-1)!.op,'tombstone')
  assert.ok((run('list',{}) as EntryRevision[]).some(e=>e.entry_id==='user'))
  assert.throws(()=>run('merge',{...candidate,entry_id:'late'}),/NOT_FOUND/)
  assert.ok(!(run('pending_evidence',{source_prefix:'connector:'}) as {id:string}[]).some(e=>e.id==='a'))
  const back=run('source_apply_page',page('3',a)) as typeof first
  assert.equal(back.activations[0]!.revision,3)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_evidence WHERE id=?').get('a')!.n,1)
  assert.notEqual(run('retrieval_evidence',{id:'a'}),null)
  const flags=run('source_apply_page',page('4',a,{read:true})) as typeof first
  assert.equal(flags.activations.length,0)
  const replay=run('source_apply_page',page('4',a,{read:true})) as {applied:boolean;revision:number}
  assert.equal(replay.applied,false);assert.equal(replay.revision,flags.revision)
  assert.throws(()=>run('source_apply_page',page('4',b)),/IDEMPOTENCY/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_deleted_sources').get()!.n,0)
  db.prepare('INSERT INTO memory_suppressed VALUES(?)').run('a')
  run('source_apply_page',page('5',b));run('source_apply_page',page('6',a))
  assert.equal(run('retrieval_evidence',{id:'a'}),null,'reactivation cannot defeat forgetting')
  assert.equal(run('merge',{...candidate,entry_id:'forgotten'}),null)
 }finally{db.close()}
})
