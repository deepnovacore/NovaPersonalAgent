import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
import type {EntryRevision} from '../src/memory-substrate/store.js'

type DiaryResource=SubstrateMemoryResource & {configureDiary?:(settings:{enabled:boolean;timezone:string})=>void;diaries?:()=>Promise<{id:string;version:number;day:string;text:string}[]>}
for(const scenario of ['success','incorrect','revoke','disable','correct','revoke-before-send'] as const)test(`diary uses yesterday authorized revisions and fences ${scenario}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'nova-diary-')),client=new MemoryLedgerClient(join(root,'memory.sqlite'))
 const yesterday=Date.parse('2026-10-22T10:00:00Z');t.mock.timers.enable({apis:['Date'],now:yesterday})
 let calls=0,release!:()=>void,started!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),ready=new Promise<void>(resolve=>{started=resolve})
 const gateway:ModelGateway={async *stream(){ /* complete only */ },async complete(request){
  if(request.usage?.operation==='diary'){
   calls++;const p=JSON.parse(request.prompt) as {entries:{id:string;revision:number}[]};started();await gate
   return {text:JSON.stringify({paragraphs:[{text:scenario==='incorrect'?'预算3元':'预算3万元',refs:[{id:p.entries[0]!.id,revision:p.entries[0]!.revision}]}]})}
  }
  return {text:JSON.stringify({entries:[{key:'budget',text:'预算3万元',topic:'预算',kind:'fact',due:null,direction:null,status:null,valid_until:null}]})}
 }}
 const resource:DiaryResource=new SubstrateMemoryResource({client,userId:'diary',gateway,model:'fixture',inputConsent:true,closeClient:false})
 try{
  assert.equal(typeof resource.configureDiary,'function');assert.equal(typeof resource.diaries,'function')
  await resource.open();await resource.remember({sourceId:'one',sessionId:'test',sequence:1,text:'预算3万元',occurredAt:new Date().toISOString(),confirmed:true});await resource.flush()
  resource.configureDiary({enabled:true,timezone:'Asia/Shanghai'});await resource.flush();assert.equal(calls,0,'no entries from the previous local day')
  t.mock.timers.setTime(Date.parse('2026-10-22T17:00:00Z'))
  if(scenario==='revoke-before-send'){
   const read=client.memory.bind(client);let revoked=false
   t.mock.method(client,'memory',async(operation:Parameters<typeof client.memory>[0],value:Parameters<typeof client.memory>[1],options:Parameters<typeof client.memory>[2])=>{
    const result=await read(operation,value,options)
    if(!revoked&&operation==='list'&&value&&typeof value==='object'&&'include_history' in value&&value.include_history===true){revoked=true;await resource.setProcessingConsent('one',resource.processingGrant(false,2))}
    return result
   })
  }
  resource.configureDiary({enabled:true,timezone:'Asia/Shanghai'})
  if(scenario==='revoke-before-send'){release();await resource.flush();assert.equal(calls,0,'revoked inputs never reach the model');return}
  await ready
  if(scenario==='revoke')await resource.setProcessingConsent('one',resource.processingGrant(false,2))
  if(scenario==='disable')resource.configureDiary({enabled:false,timezone:'Asia/Shanghai'})
  if(scenario==='correct'){const entry=(await resource.list()).entries[0]!;await resource.correct(entry.id,entry.version,'预算4万元',{type:'conversation',ref:'correction',observed_at:new Date().toISOString()})}
  release();await resource.flush()
  const diaries=await resource.diaries();assert.equal(diaries.length,scenario==='success'?1:0)
  if(scenario==='success'){
   const diary=diaries[0]!;assert.equal(diary.day,'2026-10-22');assert.match(diary.text,/预算3万元.*@1/s)
   assert.equal((await resource.list()).entries.length,1)
   assert.ok(!(await resource.recall('预算')).hits.some(hit=>hit.memoryId===diary.id))
   assert.ok(!resource.responseAdaptation().memoryContext?.text.includes(diary.id))
   await resource.forgetEntry(diary.id,diary.version);assert.deepEqual(await resource.diaries(),[]);assert.equal((await resource.recall('预算')).hits.length,1,'deleting the diary preserves source evidence')
   resource.configureDiary({enabled:true,timezone:'Asia/Shanghai'});await resource.flush();assert.equal(calls,1,'deletion is not regenerated')
   const rows=await client.memory('list',{include_history:true}) as EntryRevision[];assert.ok(rows.some(row=>row.kind==='diary'&&row.op==='tombstone'))
   await resource.close();const reopened=new SubstrateMemoryResource({client,userId:'diary',gateway,model:'fixture',inputConsent:true,closeClient:false})
   try{await reopened.open();reopened.configureDiary({enabled:true,timezone:'Asia/Shanghai'});await reopened.flush();assert.deepEqual(await reopened.diaries(),[]);assert.equal(calls,1,'tombstone prevents regeneration after reopening')}finally{await reopened.close()}
  }else{resource.configureDiary({enabled:true,timezone:'Asia/Shanghai'});await resource.flush();assert.equal(calls,1,'no immediate retry')}
  if(scenario==='incorrect'){for(let attempt=1;attempt<=4;attempt++){t.mock.timers.setTime(Date.parse('2026-10-22T17:00:00Z')+attempt*300001);resource.configureDiary({enabled:true,timezone:'Asia/Shanghai'});await resource.flush()}assert.equal(calls,3,'at most three generation attempts per day');assert.deepEqual(await resource.diaries(),[])}
 }finally{release?.();await resource.close();await client.close();t.mock.timers.reset();await rm(root,{recursive:true,force:true})}
})

test('host persists the diary switch and exposes diaries separately from generation memories',async()=>{
 const {PersonalAgentHost}=await import('../src/personal-agent/host.js'),{SuggestionPool}=await import('../src/core/suggestions.js')
 const root=await mkdtemp(join(tmpdir(),'nova-diary-host-')),settings:{enabled:boolean;timezone:string}[]=[]
 const diary={id:'d',version:1,day:'2026-10-22',text:'derived diary'}
 const memory={configureDiary:(s:{enabled:boolean;timezone:string})=>settings.push(s),diaries:()=>Promise.resolve([diary])}
 const make=()=>new PersonalAgentHost({path:join(root,'personal.json'),userScope:'test',memory:()=>memory as unknown as PersonalMemoryResource,pool:new SuggestionPool(),evidence:()=>null})
 let host=make()
 try{
  await host.open();await host.refreshMemory();assert.equal(settings.at(-1)?.enabled,true)
  assert.deepEqual((host.snapshot().memory as {diaries?:unknown}).diaries,[diary])
  const result=await host.command({type:'personal.command',request_id:'off',method:'discovery.configure',params:{diary_enabled:false}}) as {ok:boolean};assert.equal(result.ok,true);assert.equal(settings.at(-1)?.enabled,false)
  await host.close();host=make();await host.open();await host.refreshMemory();assert.equal(settings.at(-1)?.enabled,false)
 }finally{await host.close();await rm(root,{recursive:true,force:true})}
})

test('diary calendar boundaries use the previous local date, including leap day and DST',async()=>{
 const {prepareDiary}=await import('../src/memory-substrate/diary.js')
 const row=(recorded_at:string)=>({entry_id:'e',revision:1,supersedes:null,kind:'fact',origin:'stated',written_by:'user_correction',evidence_refs:['ref'],entity_refs:[],content:{text:'fact'},valid_until:null,recorded_at,op:'add'}) as EntryRevision
 for(const [now,timezone,at,day] of [
  ['2024-03-01T01:00:00Z','UTC','2024-02-29T12:00:00Z','2024-02-29'],
  ['2026-03-09T05:00:00Z','America/New_York','2026-03-08T08:00:00Z','2026-03-08'],
  ['2026-10-22T17:00:00Z','Asia/Shanghai','2026-10-21T17:00:00Z','2026-10-22']
 ]){const plan=prepareDiary([row(at!)],new Date(now!),timezone!);assert.equal(plan?.day,day)}
 assert.equal(prepareDiary([row('2026-10-20T12:00:00Z')],new Date('2026-10-23T12:00:00Z'),'UTC'),null,'older dates are not backfilled')
})
