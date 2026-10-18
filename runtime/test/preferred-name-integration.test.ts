import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalStore,initialState} from '../src/personal-agent/store.js'
import {DatabaseSync} from 'node:sqlite'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {initializeMemory,memoryOperation,type MemoryOperation} from '../src/memory-substrate/store.js'
import {buildAssembly} from '../src/composition/assembly.js'
import {buildRealtimeAssembly} from '../src/composition/realtime-assembly.js'
import {VirtualClock} from '../src/core/clock.js'
import {settingsSchema} from '../src/config/config.js'
import {parseCapabilityRegistry} from '../src/config/capability-registry.js'
import type {RealtimeProvider} from '../src/realtime/protocol.js'
import type {ToolCallReady} from '../src/realtime/bridge.js'
import type {ExplicitMemoryArguments} from '../src/memory/explicit-memory.js'

const gateway={async *stream(){await Promise.reject(Error('unexpected model call'))},complete(){throw Error('unexpected model call')}}
async function fixture(){
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-name-integration-')),path=join(root,'personal.json'),db=new DatabaseSync(join(root,'ledger.sqlite'));initializeMemory(db)
 // Real transactional ledger, with an in-process transport to keep these domain tests independent of worker boot.
 const client={open:()=>Promise.resolve(),memory:(operation:MemoryOperation,input:unknown)=>Promise.resolve(operation==='enable_files'?null:memoryOperation(db,operation,input))} as MemoryLedgerClient
 const memory=new SubstrateMemoryResource({client,userId:'test',model:'fixture',gateway,inputConsent:true,conversationProviders:['chat'],closeClient:false})
 await memory.open({deferBackground:true})
 const hosts:PersonalAgentHost[]=[],graphs:ReturnType<typeof buildRealtimeAssembly>[]=[]
 const create=async(consumer='chat')=>{const host=new PersonalAgentHost({path,userScope:'test',memory:()=>memory,explicitMemoryConsumer:()=>consumer,pool:new SuggestionPool(),evidence:()=>null});hosts.push(host);await host.open({deferBackground:true});return host}
 const graph=async(host:PersonalAgentHost)=>{
  const provider:RealtimeProvider={connect:()=>Promise.resolve({epoch:1,provider_session_id:'fixture'}),sendAudio:()=>Promise.resolve(),replaceResponseAdaptation:()=>Promise.resolve(),injectHostItem:item=>Promise.resolve({session_epoch:1,host_item_id:item.host_item_id,provider_item_id:'provider-'+item.host_item_id}),createResponse:()=>Promise.resolve(),cancelResponse:()=>Promise.resolve(),close:()=>Promise.resolve(),async *events(signal){if(!signal.aborted)await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))}}
  const core=buildAssembly({settings:settingsSchema.parse({executors:[]}),gateway,clock:new VirtualClock(),blackboard:{path:join(root,'board-'+graphs.length+'.sqlite'),ownerId:'fixture'},capabilities:parseCapabilityRegistry({version:1,modules:{search:{enabled:false},camera:{enabled:false},coding:{enabled:false},knowledge:{enabled:false}}})})
  const built=buildRealtimeAssembly({core,provider,sharedPersonal:{host,memory},memoryConsumerFingerprint:'chat',memoryReadMode:'text',onDiagnostic:()=>undefined});graphs.push(built);await built.start();return built
 }
 return {root,path,memory,create,graph,async close(){for(const graph of graphs)await graph.stop();for(const host of hosts)await host.close();await memory.close();db.close();await rm(root,{recursive:true,force:true})}}
}
async function tool(graph:ReturnType<typeof buildRealtimeAssembly>,requestId:string,text:string,args:ExplicitMemoryArguments){
 const originRef=await graph.bridge.acceptUserTranscript(text)
 const call:ToolCallReady={kind:'tool_call_ready',call_id:requestId,item_id:'item-'+requestId,name:'memory__remember',arguments:JSON.parse(JSON.stringify(args)) as ToolCallReady['arguments'],response_id:'response',session_epoch:0}
 return {result:await graph.bridge.acceptToolCall(call,{originRef,userTurn:{originRef,sessionEpoch:0,acceptedUserInputRevision:1,stillWanted:()=>true}}),originRef,call}
}
const configure=(host:PersonalAgentHost,id:string,name:string)=>host.command({type:'personal.command',request_id:id,method:'identity.configure',params:{assistant_name:'小星',user_name:name}}) as Promise<{ok:boolean;error?:string}>

test('production memory tool mirrors current name to durable host settings; old receipts and ID forget use current memory',async()=>{
 const f=await fixture()
 try{
  let host=await f.create(),graph=await f.graph(host)
  assert.equal((await configure(host,'ui','旧名字')).ok,true)
  assert.equal((await f.memory.lookupExplicit({slot:'preferred_name'},'chat')).entries[0]?.text,'旧名字')
  const first=await tool(graph,'first','请叫我新名字',{action:'set',kind:'preference',slot:'preferred_name',text:'新名字',quote:'叫我新名字'})
  assert.equal(first.result.code,'committed');assert.equal(host.identity().user_name,'新名字')
  const concurrent=await f.graph(host)
  const second=await tool(concurrent,'second','请叫我最新名字',{action:'set',kind:'preference',slot:'preferred_name',text:'最新名字',quote:'叫我最新名字'})
  assert.equal(second.result.code,'committed')
  const replay=await graph.bridge.acceptToolCall(first.call,{originRef:first.originRef,userTurn:{originRef:first.originRef,sessionEpoch:0,acceptedUserInputRevision:1,stillWanted:()=>true}})
  assert.equal(replay.code,'committed');assert.equal(host.identity().user_name,'最新名字')
  const turns=(await readFile(f.path,'utf8'));assert.match(turns,/最新名字/)
  const old=await configure(host,'ui','旧名字');assert.equal(old.ok,true);assert.equal(host.identity().user_name,'最新名字')
  const entry=(await f.memory.lookupExplicit({slot:'preferred_name'},'chat')).entries[0]!
  const forgotten=await tool(graph,'forget','忘记我的称呼',{action:'forget',id:entry.id,quote:'忘记我的称呼'})
  assert.equal(forgotten.result.code,'committed');assert.equal(host.identity().user_name,'')
  await graph.stop();await host.close();host=await f.create();graph=await f.graph(host)
  assert.equal(host.snapshot().settings.user_name,'');assert.equal(host.identity().assistant_name,'小星')
 }finally{await f.close()}
})

test('a committed chat receipt whose settings sync failed is repaired on restart before identity is read',async()=>{
 const f=await fixture()
 try{
  let host=await f.create();const graph=await f.graph(host)
  const synchronize=host.synchronizePreferredName.bind(host);let fail=true
  host.synchronizePreferredName=()=>fail?(fail=false,Promise.reject(Error('settings unavailable'))):synchronize()
  const saved=await tool(graph,'rename','叫我恢复后的名字',{action:'set',kind:'preference',slot:'preferred_name',text:'恢复后的名字',quote:'叫我恢复后的名字'})
  assert.equal(saved.result.accepted,false)
  assert.equal(host.identity().user_name,'')
  assert.equal((await f.memory.lookupExplicit({slot:'preferred_name'},'chat')).entries[0]?.text,'恢复后的名字')
  await graph.stop();await host.close();host=await f.create()
  assert.equal(host.identity().user_name,'恢复后的名字')
 }finally{await f.close()}
})

test('pending settings admission retries the same persisted turn; replay after a newer rename cannot roll it back',async()=>{
 const f=await fixture()
 try{
  let host=await f.create();const write=f.memory.writeExplicit.bind(f.memory);let fail=true
  f.memory.writeExplicit=async(...args)=>{const result=await write(...args);if(fail){fail=false;throw Error('lost reply after durable write')}return result}
  assert.equal((await configure(host,'ui-pending','早先名字')).ok,false)
  assert.equal(host.identity().user_name,'')
  await host.close();host=await f.create();assert.equal(host.identity().user_name,'早先名字')
  const graph=await f.graph(host)
  assert.equal((await tool(graph,'newer','叫我较新名字',{action:'set',kind:'preference',slot:'preferred_name',text:'较新名字',quote:'叫我较新名字'})).result.code,'committed')
  assert.equal((await configure(host,'ui-pending','早先名字')).ok,true)
  assert.equal(host.identity().user_name,'较新名字')
  assert.equal((await f.memory.lookupExplicit({slot:'preferred_name'},'chat')).entries[0]?.text,'较新名字')
 }finally{await f.close()}
})

test('failed memory admission never changes settings; explicit clear and 64-character names persist',async()=>{
 const f=await fixture()
 try{
  const host=await f.create();assert.equal((await configure(host,'initial','原名字')).ok,true)
  f.memory.options.inputConsent=false
  assert.equal((await configure(host,'denied','未授权名字')).ok,false)
  assert.equal(host.identity().user_name,'原名字')
  assert.equal(host.identity().assistant_name,'小星')
  f.memory.options.inputConsent=true
  assert.equal((await configure(host,'long','名'.repeat(64))).ok,true)
  assert.equal(host.identity().user_name.length,64)
  assert.equal((await configure(host,'clear','')).ok,true)
  assert.equal(host.identity().user_name,'')
  assert.deepEqual((await f.memory.lookupExplicit({slot:'preferred_name'},'chat')).entries,[])
  const bypass=await host.command({type:'personal.command',request_id:'bypass',method:'discovery.configure',params:{user_name:'绕过'}}) as {ok:boolean};assert.equal(bypass.ok,false)
 }finally{await f.close()}
})


test('invalid preferred names are rejected before admission through slot and ID corrections',async()=>{
 const f=await fixture()
 try{
  let host=await f.create();assert.equal((await configure(host,'valid-name','有效名字')).ok,true)
  const graph=await f.graph(host),entry=(await f.memory.lookupExplicit({slot:'preferred_name'},'chat')).entries[0]!
  for(const [i,name]of ['坏\u0000名字','坏\u200b名字','名'.repeat(65)].entries()){
   const args={action:'set' as const,kind:'preference' as const,text:name,quote:'修改称呼'}
   assert.equal((await tool(graph,'bad-slot-'+i,'修改称呼',{...args,slot:'preferred_name'})).result.accepted,false)
   assert.equal((await tool(graph,'bad-id-'+i,'修改称呼',{...args,id:entry.id})).result.accepted,false)
   assert.equal(host.identity().user_name,'有效名字')
   const retained=(await f.memory.lookupExplicit({slot:'preferred_name'},'chat')).entries[0]!
   assert.equal(retained.text,'有效名字');assert.equal(retained.version,entry.version)
  }
  await graph.stop();await host.close();host=await f.create();assert.equal(host.identity().user_name,'有效名字')
 }finally{await f.close()}
})


test('a settings-only name survives memory activation and an explicit UI clear without a slot',async()=>{
 const f=await fixture()
 try{
  const state=initialState();state.user_scope='test';state.settings.user_name='已有称呼';await new PersonalStore(f.path).write(state)
  const host=await f.create();assert.equal(host.identity().user_name,'已有称呼')
  assert.deepEqual((await f.memory.lookupExplicit({slot:'preferred_name'},'chat')).entries,[])
  assert.equal((await configure(host,'clear-legacy','')).ok,true)
  assert.equal(host.identity().user_name,'')
  await host.close();assert.equal((await f.create()).identity().user_name,'')
 }finally{await f.close()}
})

test('provider visibility changes cannot erase names or disclose an unauthorized forget',async()=>{
 const f=await fixture()
 try{
  let host=await f.create();assert.equal((await configure(host,'initial-provider','持久称呼')).ok,true)
  await host.close();host=await f.create('other-provider')
  assert.equal(host.identity().user_name,'持久称呼')
  assert.deepEqual(await f.memory.lookupExplicit({slot:'preferred_name'},'other-provider'),{entries:[],next_cursor:null})
  assert.equal((await configure(host,'unauthorized-clear','')).ok,false)
  assert.equal(host.identity().user_name,'持久称呼')
  await host.close();host=await f.create()
  // Simulate a committed forget whose settings mirror was interrupted.
  const turn=await f.memory.beginExplicitTurn({sourceId:'forget-before-mirror',text:'忘记称呼',occurredAt:new Date().toISOString()})
  await f.memory.writeExplicit(turn,'forget-before-mirror',{action:'forget',slot:'preferred_name',quote:'忘记称呼'},'chat')
  assert.equal(host.identity().user_name,'持久称呼')
  assert.deepEqual(await f.memory.lookupExplicit({slot:'preferred_name'},'chat'),{entries:[],next_cursor:null,forgotten:true})
  assert.deepEqual(await f.memory.lookupExplicit({slot:'preferred_name'},'other-provider'),{entries:[],next_cursor:null})
  await host.close();host=await f.create('other-provider');assert.equal(host.identity().user_name,'持久称呼')
  await host.close();host=await f.create();assert.equal(host.identity().user_name,'')
 }finally{await f.close()}
})
