import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,realpath,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {AddressInfo} from 'node:net'
import {LifeService,emptyLifeState} from '../src/personal-agent/life.js'
import {HubStore} from '../src/hub/store.js'
import {createHubServer} from '../src/hub/server.js'
import {LifeSyncClient} from '../src/hub/life-sync.js'
import {saveHubCredentials} from '../src/hub/life-sync-transport.js'
import {lifeProjection} from '../src/hub/life-projection.js'

async function fixture(){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'nova-life-sync-'))),hub=new HubStore(':memory:'),server=createHubServer(hub)
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`,device=hub.enroll('alice','desktop')
 const credentialsPath=join(dir,'credentials'),statePath=join(dir,'sync-state'),life=new LifeService(join(dir,'life'))
 await life.open();await saveHubCredentials(credentialsPath,{url,token:device.token})
 const client=new LifeSyncClient(life,statePath,credentialsPath);await client.open()
 return {dir,hub,server,url,device,credentialsPath,statePath,life,client,
  async close(){await client.close();await life.close();await new Promise<void>(resolve=>server.close(()=>resolve()));hub.close();await rm(dir,{recursive:true,force:true})}}
}
test('sync is disabled without credentials and empty stores converge',async()=>{
 const f=await fixture()
 try{
  const disabled=new LifeSyncClient(f.life,join(f.dir,'disabled'),join(f.dir,'missing'))
  await disabled.open();await disabled.sync();assert.equal(disabled.status().enabled,false)
  await f.client.sync()
  assert.equal(f.client.status().cursor,0)
  assert.equal(f.client.status().account_id,'alice')
  assert.deepEqual(f.life.snapshot().todos,[])
  assert.equal((await readFile(f.statePath,'utf8')).includes(f.device.token),false)
 }finally{await f.close()}
})
test('seed imports goal then idea then todo with timestamps, loss record and no private news fields',async()=>{
 const f=await fixture()
 try{
  const goal=await f.life.mutate({op:'create',kind:'goal',title:'Goal'},'goal')
  const idea=await f.life.mutate({op:'create',kind:'idea',title:'Idea',goal_id:goal.id},'idea')
  const todo=await f.life.mutate({op:'convert',id:idea.id,target:'todo',expected_version:1},'converted')
  const news=await f.life.mutate({op:'from_news',kind:'todo',title:'News',article:{article_id:'a',source_id:'s',url:'https://example.com/news',content_hash:'h',title:'Article',summary:'Private source',published_at:null}},'news')
  const before=f.life.syncState()
  await f.client.sync()
  const remote=f.hub.snapshot(f.device.token)
  assert.deepEqual(remote.state.goals.map(row=>row.id),[goal.id])
  assert.equal(remote.state.todos.find(row=>row.id===todo.id)?.created_at,before.todos.find(row=>row.id===todo.id)?.created_at)
  assert.equal(remote.state.todos.find(row=>row.id===news.id)?.news_source,undefined)
  assert.ok(f.life.snapshot().todos.find(row=>row.id===news.id)?.news_source)
  assert.deepEqual(f.client.status().lost_fields,[{id:todo.id,fields:['idea_id']}])
  assert.deepEqual(f.hub.changes(f.device.token,0).events.map(event=>(event.input as {entity:{kind:string}}).entity.kind),['goal','idea','todo','todo'])
 }finally{await f.close()}
})
test('incremental create preserves request-derived ID and uses independent Hub versions',async()=>{
 const f=await fixture()
 try{
  await f.client.sync()
  const todo=await f.life.mutate({op:'create',kind:'todo',title:'Local'},'new-item')
  await f.client.sync()
  assert.equal(f.hub.snapshot(f.device.token).state.todos[0]?.id,todo.id)
  assert.equal(f.client.status().hub_versions[todo.id],2)
  const local=f.life.snapshot().todos[0]!
  await f.life.mutate({op:'update',kind:'todo',id:todo.id,expected_version:local.version,title:'Edited'},'local-edit')
  await f.client.sync()
  assert.equal(f.hub.snapshot(f.device.token).state.todos[0]?.title,'Edited')
  assert.equal(f.client.status().conflicts.length,0)
  f.hub.mutate(f.device.token,{op_id:'phone-edit',input:{op:'update',kind:'todo',id:todo.id,expected_version:3,title:'Phone'}})
  await f.client.sync()
  assert.equal(f.life.snapshot().todos[0]?.title,'Phone')
 }finally{await f.close()}
})
test('Hub-only arbitrary IDs download and same-ID conflicts retain both contents',async()=>{
 const f=await fixture()
 try{
  const local=await f.life.mutate({op:'create',kind:'todo',title:'Desktop'},'same')
  f.hub.mutate(f.device.token,{op_id:'remote',input:{op:'import',entity:{...lifeProjection(f.life.syncState())[local.id],title:'Hub'}}})
  f.hub.mutate(f.device.token,{op_id:'arbitrary',input:{op:'import',entity:{...lifeProjection(f.life.syncState())[local.id],id:'arbitrary-id',title:'Only Hub'}}})
  await f.client.sync()
  assert.equal(f.life.snapshot().todos.find(row=>row.id===local.id)?.title,'Hub')
  assert.equal(f.life.snapshot().todos.find(row=>row.id==='arbitrary-id')?.title,'Only Hub')
  const conflict=f.client.status().conflicts[0]!
  assert.equal(conflict.error,'entity_id_conflict')
  assert.equal(conflict.local?.kind==='todo'&&conflict.local.title,'Desktop')
  assert.equal(conflict.remote?.kind==='todo'&&conflict.remote.title,'Hub')
 }finally{await f.close()}
})
test('stale desktop edit is retained in conflicts while canonical Hub content wins',async()=>{
 const f=await fixture()
 try{
  const todo=await f.life.mutate({op:'create',kind:'todo',title:'Original'},'item')
  await f.client.sync()
  await f.life.mutate({op:'update',kind:'todo',id:todo.id,expected_version:1,title:'Desktop edit'},'edit')
  f.hub.mutate(f.device.token,{op_id:'remote-edit',input:{op:'update',kind:'todo',id:todo.id,expected_version:1,title:'Hub edit'}})
  await f.client.sync()
  assert.equal(f.life.snapshot().todos[0]?.title,'Hub edit')
  assert.equal(f.client.status().conflicts[0]?.error,'version_conflict')
  assert.equal((f.client.status().conflicts[0]?.local as {title:string}).title,'Desktop edit')
 }finally{await f.close()}
})
test('uncertain upload survives restart with the same receipt and no duplicate',async t=>{
 const f=await fixture()
 try{
  await f.life.mutate({op:'create',kind:'todo',title:'Offline'},'offline')
  const original=globalThis.fetch
  let dropped=false
  const mock=t.mock.method(globalThis,'fetch',async(...args:Parameters<typeof fetch>)=>{
   const response=await original(...args)
   if(args[1]?.method==='POST'&&!dropped){dropped=true;throw Error('lost acknowledgement')}
   return response
  })
  await assert.rejects(f.client.sync(),/hub_transport_failed/)
  assert.equal(f.client.status().pending.length,1)
  mock.mock.restore()
  const restarted=new LifeSyncClient(f.life,f.statePath,f.credentialsPath);await restarted.open();await restarted.sync()
  assert.equal(restarted.status().pending.length,0)
  assert.equal(f.hub.snapshot(f.device.token).state.todos.length,1)
  assert.equal(f.hub.snapshot(f.device.token).cursor,1)
 }finally{await f.close()}
})
test('account mismatch and history reset reject before upload or local overwrite',async()=>{
 const f=await fixture()
 try{
  await f.client.sync()
  await f.life.mutate({op:'create',kind:'todo',title:'Must stay local'},'local')
  const other=f.hub.enroll('bob','other')
  await saveHubCredentials(f.credentialsPath,{url:f.url,token:other.token})
  const mismatch=new LifeSyncClient(f.life,f.statePath,f.credentialsPath);await mismatch.open()
  await assert.rejects(mismatch.sync(),/account_mismatch/)
  assert.equal(f.hub.snapshot(other.token).cursor,0)
  assert.equal(f.life.snapshot().todos[0]?.title,'Must stay local')
  await saveHubCredentials(f.credentialsPath,{url:f.url,token:f.device.token})
  const saved=JSON.parse(await readFile(f.statePath,'utf8')) as {highest_cursor:number};saved.highest_cursor=10
  await writeFile(f.statePath,JSON.stringify(saved))
  const reset=new LifeSyncClient(f.life,f.statePath,f.credentialsPath);await reset.open()
  await assert.rejects(reset.sync(),/hub_history_reset/)
  assert.equal(f.hub.snapshot(f.device.token).cursor,0)
 }finally{await f.close()}
})
test('download traverses changes pages and local undo is honestly marked unpropagated',async()=>{
 const f=await fixture()
 try{
  const todo=f.hub.mutate(f.device.token,{op_id:'remote',input:{op:'create',kind:'todo',title:'Remote'}}).result.id
  for(let i=0;i<260;i++)f.hub.mutate(f.device.token,{op_id:'edit-'+i,input:{op:'update',kind:'todo',id:todo,expected_version:i+1,note:String(i)}})
  await f.client.sync()
  assert.equal(f.client.status().cursor,261)
  assert.equal(f.life.snapshot().todos[0]?.note,'259')
  const local=await f.life.mutate({op:'create',kind:'todo',title:'Delete locally'},'delete')
  await f.client.sync()
  await f.life.mutate({op:'undo_create',id:local.id,expected_version:1},'undo')
  await f.client.sync()
  assert.ok(f.client.status().unpropagated_local_deletions.includes(local.id))
  assert.ok(f.hub.snapshot(f.device.token).state.todos.some(row=>row.id===local.id))
  assert.equal(f.life.snapshot().todos.some(row=>row.id===local.id),false)
 }finally{await f.close()}
})
test('projection uses CAS, retains private metadata and fails closed for unsupported backend',async()=>{
 const f=await fixture()
 try{
  const local=await f.life.mutate({op:'create',kind:'todo',title:'Original'},'local')
  const before=f.life.syncState(),entity=lifeProjection(before)[local.id]!
  await assert.rejects(f.life.applySyncProjection({entities:[{...entity,title:'Remote'}],tombstones:[]},{requestId:'projection',expectedStateHash:'wrong'}),/local_state_changed/)
  assert.equal(f.life.snapshot().todos[0]?.title,'Original')
  await f.life.applySyncProjection({entities:[{...entity,title:'Remote'}],tombstones:[]},{requestId:'projection',expectedStateHash:createHash('sha256').update(JSON.stringify(before)).digest('hex')})
  const count=f.life.snapshot().todos[0]?.version
  await f.life.applySyncProjection({entities:[{...entity,title:'Remote'}],tombstones:[]},{requestId:'projection',expectedStateHash:'wrong'})
  assert.equal(f.life.snapshot().todos[0]?.version,count)
  const backendLife=new LifeService(join(f.dir,'backend'),()=>{/* test observer */},{
   load:()=>Promise.resolve({state:emptyLifeState(),revision:0}),mutate:()=>Promise.reject(Error('must not mutate')),
  })
  await backendLife.open()
  assert.throws(()=>backendLife.assertSyncSupported(),/unsupported_backend/)
  await assert.rejects(backendLife.applySyncProjection({entities:[]},{requestId:'no',expectedStateHash:'no'}),/unsupported_backend/)
 }finally{await f.close()}
})

test('conversion aliases preserve both entities and are not re-uploaded every sync',async()=>{
 const f=await fixture()
 try{
  const idea=await f.life.mutate({op:'create',kind:'idea',title:'Idea'},'idea')
  await f.client.sync()
  const remote=f.hub.mutate(f.device.token,{op_id:'phone-convert',input:{op:'convert',id:idea.id,target:'todo',expected_version:1}}).result.id
  const local=await f.life.mutate({op:'convert',id:idea.id,target:'todo',expected_version:1},'desktop-convert')
  await f.client.sync()
  assert.equal(f.client.status().conflicts[0]?.error,'conversion_alias')
  assert.ok(f.life.snapshot().todos.some(row=>row.id===local.id))
  assert.ok(f.life.snapshot().todos.some(row=>row.id===remote))
  const cursor=f.hub.snapshot(f.device.token).cursor,count=f.client.status().conflicts.length
  await f.client.sync()
  assert.equal(f.hub.snapshot(f.device.token).cursor,cursor)
  assert.equal(f.client.status().conflicts.length,count)
 }finally{await f.close()}
})

test('projection acknowledgement loss replays receipt after restart without another local revision',async t=>{
 const f=await fixture()
 try{
  f.hub.mutate(f.device.token,{op_id:'remote',input:{op:'create',kind:'todo',title:'Remote'}})
  const original=f.life.applySyncProjection.bind(f.life)
  const mock=t.mock.method(f.life,'applySyncProjection',async(...args:Parameters<typeof original>)=>{await original(...args);throw Error('simulated process loss')})
  await assert.rejects(f.client.sync(),/sync_failed/)
  assert.ok(f.client.status().applying)
  const version=f.life.snapshot().todos[0]?.version
  mock.mock.restore()
  const restarted=new LifeSyncClient(f.life,f.statePath,f.credentialsPath);await restarted.open();await restarted.sync()
  assert.equal(f.life.snapshot().todos[0]?.version,version)
  assert.equal(restarted.status().applying,null)
 }finally{await f.close()}
})
test('a replacement Hub with the same account cannot receive existing local data',async()=>{
 const f=await fixture(),replacement=await fixture()
 try{
  await f.client.sync()
  await f.life.mutate({op:'create',kind:'todo',title:'Private local'},'private')
  await saveHubCredentials(f.credentialsPath,{url:replacement.url,token:replacement.device.token})
  const restarted=new LifeSyncClient(f.life,f.statePath,f.credentialsPath);await restarted.open()
  await assert.rejects(restarted.sync(),/hub_identity_changed/)
  assert.equal(replacement.hub.snapshot(replacement.device.token).cursor,0)
 }finally{await f.close();await replacement.close()}
})
test('local goal deletion with new remote dependents is preserved as a visible conflict',async()=>{
 const f=await fixture()
 try{
  const goal=await f.life.mutate({op:'create',kind:'goal',title:'Goal'},'goal')
  await f.client.sync()
  const local=f.life.syncState();local.goals=[]
  await writeFile(f.life.path,JSON.stringify(local));await f.life.open()
  f.hub.mutate(f.device.token,{op_id:'new-child',input:{op:'create',kind:'todo',title:'Remote child',goal_id:goal.id}})
  await f.client.sync()
  assert.ok(f.client.status().unpropagated_local_deletions.includes(goal.id))
  assert.ok(f.client.status().conflicts.some(conflict=>conflict.error==='local_deletion_has_remote_dependents'&&conflict.id===goal.id))
  assert.equal(f.life.snapshot().goals[0]?.id,goal.id)
  assert.equal(f.life.snapshot().todos[0]?.goal_id,goal.id)
 }finally{await f.close()}
})

test('explicit LifeService config hook syncs mutations and stays off by default',async()=>{
 const f=await fixture()
 try{
  assert.equal(f.life.hubSyncStatus().enabled,false)
  await f.life.configureHubSync({statePath:join(f.dir,'hook-state'),credentialsPath:f.credentialsPath})
  assert.equal(f.life.hubSyncStatus().enabled,true)
  const todo=await f.life.mutate({op:'create',kind:'todo',title:'Hook'},'hook')
  await f.life.syncHub()
  assert.equal(f.hub.snapshot(f.device.token).state.todos[0]?.id,todo.id)
 }finally{await f.close()}
})

test('new local edits made after a lost acknowledgement survive in the conflict record',async t=>{
 const f=await fixture()
 try{
  const todo=await f.life.mutate({op:'create',kind:'todo',title:'First'},'offline')
  const original=globalThis.fetch
  let dropped=false
  const mock=t.mock.method(globalThis,'fetch',async(...args:Parameters<typeof fetch>)=>{
   const response=await original(...args)
   if(args[1]?.method==='POST'&&!dropped){dropped=true;throw Error('lost acknowledgement')}
   return response
  })
  await assert.rejects(f.client.sync(),/hub_transport_failed/);mock.mock.restore()
  await f.life.mutate({op:'update',kind:'todo',id:todo.id,expected_version:1,title:'New offline edit'},'new-edit')
  const restarted=new LifeSyncClient(f.life,f.statePath,f.credentialsPath);await restarted.open();await restarted.sync()
  const conflict=restarted.status().conflicts.find(item=>item.error==='local_changed_while_pending')
  assert.equal(conflict?.local?.kind==='todo'&&conflict.local.title,'New offline edit')
  assert.equal(f.life.snapshot().todos[0]?.title,'First')
 }finally{await f.close()}
})
