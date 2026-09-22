import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,writeFile,rename,unlink,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {execFileSync} from 'node:child_process'
import {WorkspaceGraphStoreClient} from '../src/workspace-graph/store-client.js'
import {initializeMemory,memoryOperation} from '../src/memory-substrate/store.js'
import {enableMemoryFiles} from '../src/memory-substrate/file-authority.js'
import {purgeEntry} from '../src/memory-substrate/purge.js'
import type {EntryRevision} from '../src/memory-substrate/store.js'

const now='2026-09-21T00:00:00Z',prefix='personal:purge:'
async function add(client:WorkspaceGraphStoreClient,id:string,text:string){
 await client.memory('append_evidence',{id:prefix+'e:'+id,source_id:prefix+'s:'+id,source_kind:'conversation',locator:id,observed_at:now,recorded_at:now,raw_text:'RAW '+text,hash:id,trust:'trusted_user'})
 await client.memory('merge',{entry_id:prefix+id,kind:'fact',origin:'stated',written_by:'merge',evidence_refs:[prefix+'e:'+id],content:{text},recorded_at:now})
}
test('entry purge erases ledger evidence and Git history, preserves another object, and retries after restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-')),path=join(root,'ledger.sqlite');let client=new WorkspaceGraphStoreClient(path)
 try{
  await client.open();await client.memory('enable_files',{});await add(client,'one','SYNTHETIC DELETE SECRET');await add(client,'two','SYNTHETIC KEEP')
  const input={request_id:'purge-1',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'one',expected_revision:1}}
  const result=await client.memory('purge',input) as {status:string;removed_entries:number;removed_evidence:number}
  assert.equal(result.status,'complete');assert.equal(result.removed_entries,1);assert.equal(result.removed_evidence,1)
  assert.deepEqual((await client.memory('list',{}) as EntryRevision[]).map(row=>row.entry_id),[prefix+'two'])
  assert.equal(await client.memory('evidence',{id:prefix+'e:one'}),null)
  assert.equal(execFileSync('git',['-C',path+'.memory','rev-list','--count','HEAD'],{encoding:'utf8'}).trim(),'1')
  await client.close();client=new WorkspaceGraphStoreClient(path);await client.open()
  assert.equal((await client.memory('purge',{...input,request_id:'purge-retry'}) as {status:string}).status,'complete')
  assert.equal((await readFile(path)).includes(Buffer.from('SYNTHETIC DELETE SECRET')),false)
  assert.equal((await client.memory('purge',{request_id:'purge-2',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'two',expected_revision:1}}) as {status:string}).status,'complete')
  assert.equal((await readFile(path)).includes(Buffer.from('SYNTHETIC KEEP')),false,'prior successful purge receipts cannot retain the next selected content')
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

const legacyLife=()=>({todos:[],ideas:[],goals:[],profile:{about:'SYNTHETIC LEGACY DELETE',version:3},receipts:{}})
test('purge cleans only the selected Life migration object and retries a temporarily missing registered backup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-life-')),path=join(root,'ledger.sqlite'),backup=join(root,'life.json'),hidden=join(root,'temporarily-unavailable.json'),namespace=prefix+'life:';let client=new WorkspaceGraphStoreClient(path)
 try{
  const legacy=legacyLife();await writeFile(backup,JSON.stringify(legacy));await client.open();await client.memory('enable_files',{})
  await client.memory('life_load',{namespace,legacy,hostMigrationPath:backup});await add(client,'keep','KEEP SEPARATE OBJECT')
  const selected=(await client.memory('list',{}) as EntryRevision[]).find(row=>row.kind==='profile')!
  await rename(backup,hidden)
  const input={request_id:'missing-backup',entry_prefix:prefix,selection:{kind:'entry',id:selected.entry_id,expected_revision:selected.revision}}
  assert.equal((await client.memory('purge',input) as {status:string}).status,'incomplete')
  assert.equal((await client.memory('purge_status',{entry_prefix:prefix}) as unknown[]).length,1)
  await assert.rejects(client.memory('purge',{request_id:'cannot-overlap',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'keep',expected_revision:1}}))
  await client.close();await rename(hidden,backup);client=new WorkspaceGraphStoreClient(path);await client.open()
  assert.equal((await client.memory('purge',{...input,request_id:'retry-backup'}) as {status:string}).status,'complete')
  assert.equal((JSON.parse(await readFile(backup,'utf8')) as {profile:{about:string}}).profile.about,'')
  assert.deepEqual((await client.memory('list',{}) as EntryRevision[]).map(row=>row.entry_id),[prefix+'keep'])
  assert.equal((await client.memory('purge_status',{entry_prefix:prefix}) as unknown[]).length,0)
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})
test('purge does not claim completion for an old Life migration with no registered backup path',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-unregistered-')),path=join(root,'ledger.sqlite'),client=new WorkspaceGraphStoreClient(path)
 try{
  await client.open();await client.memory('enable_files',{});await client.memory('life_load',{namespace:prefix+'life:',legacy:legacyLife()})
  const row=(await client.memory('list',{}) as EntryRevision[])[0]!
  const result=await client.memory('purge',{request_id:'unregistered',entry_prefix:prefix,selection:{kind:'entry',id:row.entry_id,expected_revision:row.revision}}) as {status:string;backup_cleanup:{unresolved:string[]}}
  assert.equal(result.status,'incomplete');assert.ok(result.backup_cleanup.unresolved.includes('life_backup_path_unregistered'))
  assert.equal((await client.memory('list',{}) as unknown[]).length,0)
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})
test('purge cleans a registered legacy VoiceMem backup without deleting another user or remaining object',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-legacy-')),path=join(root,'ledger.sqlite'),backup=join(root,'legacy.sqlite'),client=new WorkspaceGraphStoreClient(path)
 const legacy=new DatabaseSync(backup)
 legacy.exec('CREATE TABLE vm_memories(user_id TEXT,scope TEXT,id TEXT,payload TEXT);CREATE TABLE vm_sources(user_id TEXT,scope TEXT,id TEXT,payload TEXT,state TEXT)')
 const insert=(user:string,id:string,text:string)=>{
  legacy.prepare('INSERT INTO vm_sources VALUES(?,?,?,?,?)').run(user,'personal','s:'+id,JSON.stringify({text,recordedAt:now,occurredAt:null}),'active')
  legacy.prepare('INSERT INTO vm_memories VALUES(?,?,?,?)').run(user,'personal',id,JSON.stringify({id,kind:'fact',text,evidenceIds:['s:'+id],authority:'inferred',recordedAt:now,occurredAt:null,supersededBy:null}))
 }
 insert('test','one','LEGACY SELECTED SECRET');insert('test','two','LEGACY RETAINED');insert('other','one','OTHER USER RETAINED');legacy.close()
 try{
  await client.open();await client.memory('migrate_legacy',{path:backup,user_id:'test',entry_prefix:prefix,source_prefix:prefix});await client.memory('enable_files',{})
  assert.equal((await client.memory('purge',{request_id:'legacy-purge',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'one',expected_revision:1}}) as {status:string}).status,'complete')
  const check=new DatabaseSync(backup,{readOnly:true});try{assert.equal(check.prepare('SELECT COUNT(*) n FROM vm_memories').get()!.n,2);assert.equal(check.prepare('SELECT COUNT(*) n FROM vm_sources').get()!.n,2)}finally{check.close()}
  assert.equal((await readFile(backup)).includes(Buffer.from('LEGACY SELECTED SECRET')),false)
  assert.equal(await client.memory('migrate_legacy',{path:backup,user_id:'test',entry_prefix:prefix,source_prefix:prefix}),0)
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('purge Git failure stays incomplete and restart finishes the same operation before rebuilding',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-recover-')),path=join(root,'ledger.sqlite');let client=new WorkspaceGraphStoreClient(path)
 try{
  await client.open();await client.memory('enable_files',{});await add(client,'one','CRASH SELECTED SECRET')
  const lock=join(path+'.memory','.git','HEAD.lock');await writeFile(lock,'synthetic Git failure')
  const input={request_id:'failed-git',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'one',expected_revision:1}}
  const failed=await client.memory('purge',input) as {status:string;operation_id:string};assert.equal(failed.status,'incomplete')
  await client.close();await unlink(lock);client=new WorkspaceGraphStoreClient(path);await client.open()
  assert.equal((await client.memory('list',{}) as unknown[]).length,0)
  const recovered=await client.memory('purge',{...input,request_id:'retry-git'}) as {status:string;operation_id:string};assert.equal(recovered.status,'complete');assert.equal(recovered.operation_id,failed.operation_id)
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})
test('purge refuses a symlink migration backup and keeps the external file unchanged',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-symlink-')),path=join(root,'ledger.sqlite'),backup=join(root,'life.json'),external=join(root,'external.json'),client=new WorkspaceGraphStoreClient(path),legacy=legacyLife()
 try{
  await writeFile(external,JSON.stringify(legacy));await symlink(external,backup);await client.open();await client.memory('enable_files',{})
  await client.memory('life_load',{namespace:prefix+'life:',legacy,hostMigrationPath:backup})
  const row=(await client.memory('list',{}) as EntryRevision[])[0]!
  assert.equal((await client.memory('purge',{request_id:'symlink',entry_prefix:prefix,selection:{kind:'entry',id:row.entry_id,expected_revision:row.revision}}) as {status:string}).status,'incomplete')
  assert.equal(await readFile(external,'utf8'),JSON.stringify(legacy))
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})
test('purging one entry removes dependent summaries but preserves independent raw evidence and gates shared evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-summary-')),path=join(root,'ledger.sqlite'),client=new WorkspaceGraphStoreClient(path)
 try{
  await client.open();await client.memory('enable_files',{});await add(client,'one','SELECTED');await add(client,'two','RETAINED')
  for(const id of ['one','two'])await client.memory('source_grant',{source_id:prefix+'s:'+id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:null,embedding_provider:null,conversation_providers:['consumer']}})
  await client.memory('merge',{entry_id:prefix+'shared',kind:'fact',origin:'stated',written_by:'merge',evidence_refs:[prefix+'e:one'],content:{text:'OTHER SHARED UNDERSTANDING'},recorded_at:now})
  await client.memory('merge',{entry_id:prefix+'summary',kind:'memory_summary',origin:'inferred',written_by:'merge',evidence_refs:[prefix+'e:one',prefix+'e:two'],content:{text:'SUMMARY',basis:[{id:prefix+'one',revision:1},{id:prefix+'two',revision:1}]},recorded_at:now})
  assert.equal((await client.memory('purge',{request_id:'summary',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'one',expected_revision:1}}) as {status:string}).status,'complete')
  assert.notEqual(await client.memory('evidence',{id:prefix+'e:two'}),null)
  assert.deepEqual((await client.memory('list',{}) as EntryRevision[]).map(row=>row.entry_id).sort(),[prefix+'shared',prefix+'two'])
  assert.deepEqual((await client.memory('conversation_snapshot',{entry_prefix:prefix,consumer:'consumer'}) as EntryRevision[]).map(row=>row.entry_id),[prefix+'two'])
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('a failure after saving compaction intent cannot leave a durable complete receipt',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-compact-')),path=join(root,'ledger.sqlite');let db=new DatabaseSync(path)
 try{
  initializeMemory(db);enableMemoryFiles(db,path+'.memory')
  memoryOperation(db,'append_evidence',{id:prefix+'e:one',source_id:prefix+'s:one',source_kind:'conversation',locator:'one',observed_at:now,recorded_at:now,raw_text:'COMPACTION SECRET',hash:'one',trust:'trusted_user'})
  memoryOperation(db,'merge',{entry_id:prefix+'one',kind:'fact',origin:'stated',written_by:'merge',evidence_refs:[prefix+'e:one'],content:{text:'COMPACTION SECRET'},recorded_at:now})
  const input={request_id:'compaction-failure',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'one',expected_revision:1}}
  const interrupted={prepare:db.prepare.bind(db),close:db.close.bind(db),exec:(sql:string)=>{if(sql==='VACUUM')throw Error('synthetic interruption before compaction');db.exec(sql)}}
  assert.equal(purgeEntry(interrupted,path,input).status,'incomplete')
  const durable=JSON.parse(String(db.prepare('SELECT payload_json FROM memory_purges').get()!.payload_json)) as {result:{status:string;backup_cleanup:{unresolved:string[]}}}
  assert.equal(durable.result.status,'incomplete');assert.ok(durable.result.backup_cleanup.unresolved.includes('ledger_compaction_pending'))
  db.close();db=new DatabaseSync(path);initializeMemory(db)
  assert.equal(purgeEntry(db,path,input).status,'complete')
  assert.equal((await readFile(path)).includes(Buffer.from('COMPACTION SECRET')),false)
 }finally{db.close();await rm(root,{recursive:true,force:true})}
})

test('purge remains incomplete until the host confirms evidence-linked index cleanup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-purge-index-')),path=join(root,'ledger.sqlite'),client=new WorkspaceGraphStoreClient(path)
 try{
  await client.open();await client.memory('enable_files',{});await add(client,'one','INDEXED SELECTED SECRET')
  await client.memory('record_extraction',{evidence_id:prefix+'e:one',attempt_id:'knowledge-index',extracted:{}})
  const result=await client.memory('purge',{request_id:'index-purge',entry_prefix:prefix,selection:{kind:'entry',id:prefix+'one',expected_revision:1}}) as {status:string;operation_id:string;index_evidence_ids:string[]}
  assert.equal(result.status,'incomplete');assert.deepEqual(result.index_evidence_ids,[prefix+'e:one'])
  await assert.rejects(client.memory('purge_index_complete',{entry_prefix:prefix,entry_id:prefix+'one',operation_id:'wrong-operation'}))
  const completed=await client.memory('purge_index_complete',{entry_prefix:prefix,entry_id:prefix+'one',operation_id:result.operation_id}) as {status:string;index_evidence_ids:string[]}
  assert.equal(completed.status,'complete');assert.deepEqual(completed.index_evidence_ids,[])
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})
