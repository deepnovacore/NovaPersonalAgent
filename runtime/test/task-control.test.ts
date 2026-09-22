import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath,rename,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {TaskRecord} from '../src/personal-agent/tasks.js'

async function fixture(){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-task-control-'))
 const make=()=>new PersonalAgentHost({path:join(dir,'host.json'),userScope:'local',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const host=make();await host.open()
 const command=(method:string,params:object={},request_id:string=crypto.randomUUID(),client_id='A')=>(host.command as (raw:unknown,context:unknown)=>Promise<{ok:boolean;error?:string;data:TaskRecord}> )({type:'personal.command',method,params,request_id},{client_id})
 const delegate=async(id:string)=>{const result=await command('tasks.delegate',{conversation_id:'chat:main',goal:'Deliver '+id,acceptance:['Checked'],origin_ref:'conversation:test'},id);assert.equal(result.ok,true);return result.data}
 const fence=(task:TaskRecord)=>({task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision})
 const take=async(task:TaskRecord,client='A')=>{const result=await command('tasks.control',{...fence(task),action:'takeover'},crypto.randomUUID(),client);assert.equal(result.ok,true);return result.data}
 return {host,make,command,delegate,fence,take,close:async()=>{await host.close();await rm(dir,{recursive:true,force:true})}}
}
test('authenticated task control fences input, deduplicates canonical retries and isolates actors',async()=>{
 const f=await fixture();try{
  const task=await f.delegate('one'),owned=await f.take(task)
  const params={...f.fence(owned),session_id:'session',text:'hello'}
  assert.equal((await f.command('tasks.input',params,'input','B')).error,'not_controller')
  assert.equal((await f.command('tasks.input',{...params,control_revision:0})).error,'stale_task')
  assert.equal((await f.command('tasks.input',params)).error,'session_not_found')
  await f.host.tasks.bindWork(f.fence(owned),'work','session')
  assert.equal((await f.command('tasks.input',params)).error,'task_input_unavailable')
  const control={...f.fence(owned),action:'return'}
  const accepted=await f.command('tasks.control',control,'return')
  assert.deepEqual(await f.command('tasks.control',{action:'return',goal_revision:0,control_revision:1,task_id:owned.id},'return'),accepted)
  assert.equal((await f.command('tasks.control',{...control,action:'takeover'},'return')).error,'request_conflict')
  assert.equal((await f.command('tasks.control',control,'return','B')).error,'stale_task')
  assert.equal((await f.command('tasks.control',{...f.fence(accepted.data),action:'takeover',client_id:'B'})).ok,false)
 }finally{await f.close()}
})
test('explicit mode exit returns only this client tasks with durable retry receipts and preserves approvals',async()=>{
 const f=await fixture();try{
  await f.command('presentation.set',{mode:'workbench'})
  const a=await f.take(await f.delegate('a')),b=await f.take(await f.delegate('b')),other=await f.take(await f.delegate('other'),'B')
  const approval={pending_approval:true,pending_approval_id:'approval',operation_summary:'Pending',queued:1}
  f.host.setApprovalView(()=>approval as never)
  const before=f.host.snapshot().pending_approvals
  const reply=await f.command('presentation.set',{mode:'orb'},'exit')
  assert.equal(reply.ok,true)
  assert.deepEqual(reply.data,{mode:'orb',returned_task_ids:[a.id,b.id],task_control_revisions:{[a.id]:2,[b.id]:2}})
  for(const task of [a,b]){assert.deepEqual(f.host.tasks.get(task.id).controller,{kind:'nova'});assert.equal(f.host.tasks.get(task.id).control_revision,2)}
  assert.deepEqual(f.host.tasks.get(other.id),other)
  assert.deepEqual(f.host.snapshot().pending_approvals,before)
  assert.deepEqual(await f.command('presentation.set',{mode:'orb'},'exit'),reply)
  await f.host.close();const reopened=f.make();await reopened.open()
  try{assert.deepEqual(await (reopened.command as (v:unknown,c:unknown)=>Promise<unknown>)({type:'personal.command',method:'presentation.set',request_id:'exit',params:{mode:'orb'}},{client_id:'A'}),reply);assert.equal(reopened.tasks.get(a.id).control_revision,2)}finally{await reopened.close()}
 }finally{await f.close()}
})
test('handback failure suppresses background capture but stays pending and same request retries',async()=>{
 const f=await fixture();try{
  await f.command('presentation.set',{mode:'workbench'});const task=await f.take(await f.delegate('a'))
  const path=f.host.tasks.path
  await rename(path,path+'.saved');await mkdir(path)
  const modes:string[]=[];f.host.subscribePresentation(mode=>{modes.push(mode)})
  const failed=await f.command('presentation.set',{mode:'background'},'exit')
  assert.equal(failed.ok,false);assert.equal(failed.error,'handback_pending');assert.equal(f.host.presentationMode,'background')
  assert.deepEqual(modes,['background']);assert.deepEqual(f.host.tasks.get(task.id).controller,{kind:'user',client_id:'A'})
  await rm(path,{recursive:true});await rename(path+'.saved',path)
  assert.equal((await f.command('presentation.set',{mode:'background'},'exit')).ok,true)
  assert.deepEqual(f.host.tasks.get(task.id).controller,{kind:'nova'})
 }finally{await f.close()}
})
test('disconnect and browsing retain ownership; another authenticated surface may explicitly return',async()=>{
 const f=await fixture();try{
  await f.command('presentation.set',{mode:'workbench'});const task=await f.take(await f.delegate('a'))
  assert.equal((await f.command('tasks.control',{...f.fence(task),action:'takeover'},'steal','B')).error,'not_controller')
  await f.command('tasks.get',{task_id:task.id});await f.command('tasks.list')
  assert.equal((await f.command('presentation.set',{mode:'orb',action:'collapse'})).ok,false)
  assert.equal((await f.command('presentation.set',{mode:'orb',action:'blur'})).ok,false)
  await f.host.disconnectPresentation()
  assert.equal(f.host.presentationMode,'background');assert.deepEqual(f.host.tasks.get(task.id),task)
  assert.equal((await f.host.command({type:'personal.command',method:'tasks.list',request_id:'anonymous',params:{}}) as {error:string}).error,'unauthenticated')
  assert.equal((await f.command('tasks.control',{...f.fence(task),action:'return'},'recover','B')).ok,true)
  await f.command('presentation.set',{mode:'workbench'})
  assert.deepEqual(f.host.tasks.get(task.id).controller,{kind:'nova'})
  assert.equal(f.host.snapshot().capabilities.tasks.input,false)
 }finally{await f.close()}
})
test('durable service transition receipt survives missing host receipt and later controller changes',async()=>{
 const f=await fixture();try{
  const task=await f.delegate('a'),fence=f.fence(task)
  const delegated=await f.host.tasks.delegate('service-delegate',{conversation_id:'chat:main',goal:'snapshot',acceptance:[],origin_ref:'user'})
  await f.host.tasks.controlClient('service-take',f.fence(delegated),'A','takeover')
  assert.deepEqual(await f.host.tasks.delegate('service-delegate',{conversation_id:'chat:main',goal:'snapshot',acceptance:[],origin_ref:'user'}),delegated)
  const accepted=await f.host.tasks.controlClient('service-retry',fence,'A','takeover')
  await f.host.tasks.returnClientTasks('handback','A')
  assert.deepEqual(await f.host.tasks.controlClient('service-retry',fence,'A','takeover'),accepted)
  assert.deepEqual(f.host.tasks.get(task.id).controller,{kind:'nova'})
  assert.equal((await f.host.tasks.returnClientTasks('handback','A')).find(item=>item.id===task.id)?.control_revision,2)
  assert.equal(f.host.tasks.get(task.id).control_revision,2)
 }finally{await f.close()}
})
test('shared remote master can explicitly recover control but cannot acquire it',async()=>{
 const f=await fixture();try{
  const task=await f.take(await f.delegate('master'))
  const master=(action:string,record:TaskRecord)=>f.host.command({type:'personal.command',method:'tasks.control',request_id:crypto.randomUUID(),params:{...f.fence(record),action}},{client_id:'remote:master',can_takeover:false}) as Promise<{ok:boolean;error?:string;data:TaskRecord}>
  assert.equal((await master('takeover',task)).error,'task_control_unavailable')
  const returned=await master('return',task);assert.equal(returned.ok,true)
  assert.equal((await master('takeover',returned.data)).error,'task_control_unavailable')
  assert.deepEqual(f.host.tasks.get(task.id).controller,{kind:'nova'})
 }finally{await f.close()}
})
test('disconnect background safety runs after an in-flight explicit mode transition',async()=>{
 const f=await fixture();try{
  await f.command('presentation.set',{mode:'workbench'})
  let release!:()=>void,entered!:()=>void
  const hold=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
  const original=f.host.tasks.returnClientTasks.bind(f.host.tasks)
  f.host.tasks.returnClientTasks=async(...args)=>{entered();await hold;return original(...args)}
  const exit=f.command('presentation.set',{mode:'orb'});await started
  const disconnect=f.host.disconnectPresentation();release();await exit;await disconnect
  assert.equal(f.host.presentationMode,'background')
 }finally{await f.close()}
})
test('failed presentation synchronization retains canonical request identity through retry, eviction and restart',async()=>{
 const f=await fixture();try{
  await f.command('presentation.set',{mode:'workbench'})
  const task=await f.take(await f.delegate('identity'))
  let fail=true
  f.host.subscribePresentation(()=>{if(fail)throw Error('listener unavailable')})
  assert.equal((await f.command('presentation.set',{mode:'orb'},'exit-identity')).error,'presentation_sync_failed')
  assert.equal(f.host.tasks.get(task.id).control_revision,2)
  fail=false
  for(const mode of ['background','workbench'])assert.equal((await f.command('presentation.set',{mode},'exit-identity')).error,'request_conflict')
  assert.equal((await f.command('presentation.set',{mode:'orb'},'exit-identity')).ok,true)
  assert.equal(f.host.tasks.get(task.id).control_revision,2)
  for(let i=0;i<256;i++)await f.command('tasks.list',{},'evict:'+i)
  await f.host.close();const restored=f.make();await restored.open()
  try{
   const retry=(mode:string)=>restored.command({type:'personal.command',method:'presentation.set',request_id:'exit-identity',params:{mode}},{client_id:'A'}) as Promise<{ok:boolean;error?:string}>
   for(const mode of ['workbench','background'])assert.equal((await retry(mode)).error,'request_conflict')
   assert.equal((await retry('orb')).ok,true)
   assert.equal(restored.tasks.get(task.id).control_revision,2)
  }finally{await restored.close()}
 }finally{await f.close()}
})
test('workbench synchronization failures also reserve their request before retry',async()=>{
 const f=await fixture();try{
  let fail=true
  f.host.subscribePresentation(()=>{if(fail)throw Error('listener unavailable')})
  assert.equal((await f.command('presentation.set',{mode:'workbench'},'enter-identity')).error,'presentation_sync_failed')
  fail=false
  assert.equal((await f.command('presentation.set',{mode:'orb'},'enter-identity')).error,'request_conflict')
  assert.equal((await f.command('presentation.set',{mode:'workbench'},'enter-identity')).ok,true)
 }finally{await f.close()}
})

test('detail exposes authenticated viewer and reconciles only that client exact input receipt',async()=>{
 const f=await fixture();try{const task=await f.take(await f.delegate('detail'));await f.host.tasks.bindWork(f.fence(task),'work','session')
 const {createHash}=await import('node:crypto'),request_id='exact',key=createHash('sha256').update(JSON.stringify({client:'A',request:request_id})).digest('hex')
 await f.host.tasks.input(key,f.fence(task),{kind:'user',client_id:'A'},'session','hello',()=>Promise.resolve('accepted'))
 const read=async(client_id:string)=>f.host.command({type:'personal.command',request_id:crypto.randomUUID(),method:'tasks.get',params:{task_id:task.id,input_request_id:request_id}},{client_id,can_takeover:false}) as Promise<{ok:boolean;data:{viewer:{client_id:string;can_takeover:boolean};input_receipt?:{request_id:string;status:string}}}>
 const a=await read('A');assert.equal(a.ok,true);assert.deepEqual(a.data.viewer,{client_id:'A',can_takeover:false});assert.deepEqual(a.data.input_receipt,{request_id:'exact',status:'accepted'});assert.equal((await read('B')).data.input_receipt,undefined)
 }finally{await f.close()}
})

test('accepted input with failed status persistence remains unknown and cannot be submitted twice',async()=>{
 const f=await fixture();let writes=0,damaged=false
 const path=f.host.tasks.path,backup=path+'.before-status'
 try{const task=await f.take(await f.delegate('persist-failure'));await f.host.tasks.bindWork(f.fence(task),'work','session')
 f.host.attachTaskRuntime('chat:main',0,{input:async()=>{writes++;await rename(path,backup);await mkdir(path);damaged=true;return 'accepted'},cancel(){/* no active executor */},dispatch:()=>Promise.resolve()})
 const params={...f.fence(task),session_id:'session',text:'send once'},raw={type:'personal.command',request_id:'persist-failure-input',method:'tasks.input',params}
 const result=await f.host.command(raw,{client_id:'A'}) as {ok:boolean;input_status:string};assert.equal(result.ok,false);assert.equal(result.input_status,'unknown');assert.equal(writes,1)
 await rm(path,{recursive:true});await rename(backup,path);damaged=false
 const read=await f.host.command({type:'personal.command',request_id:'reconcile-persistence',method:'tasks.get',params:{task_id:task.id,input_request_id:raw.request_id}},{client_id:'A'}) as {data:{input_receipt:{request_id:string;status:string}}}
 assert.deepEqual(read.data.input_receipt,{request_id:raw.request_id,status:'unknown'});await f.host.command(raw,{client_id:'A'});assert.equal(writes,1)
 const stale={...raw,request_id:'stale-input',params:{...params,control_revision:0}},rejected=await f.host.command(stale,{client_id:'A'}) as {input_status:string};assert.equal(rejected.input_status,'failed')
 const failure=await f.host.command({type:'personal.command',request_id:'reconcile-stale',method:'tasks.get',params:{task_id:task.id,input_request_id:stale.request_id}},{client_id:'A'}) as {data:{input_receipt:{status:string}}};assert.equal(failure.data.input_receipt.status,'failed')
 }finally{if(damaged){await rm(path,{recursive:true});await rename(backup,path)}await f.close()}
})
