
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Memory,makeMemoryRef} from '../src/core/memory.js'
import {VirtualClock} from '../src/core/clock.js'
import {compileToolSchema} from '../src/core/tool-schema.js'
import {RealtimeRuntimeBridge,type ToolCallReady} from '../src/realtime/bridge.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import type {ExplicitMemoryReceipt,ExplicitMemoryPage} from '../src/memory/explicit-memory.js'
import {buildAssembly} from '../src/composition/assembly.js'
import {buildRealtimeAssembly} from '../src/composition/realtime-assembly.js'
import {settingsSchema} from '../src/config/config.js'
import {parseCapabilityRegistry} from '../src/config/capability-registry.js'
import {hostContextItemSchema,type HostContextItem,type RealtimeProvider} from '../src/realtime/protocol.js'
import {setTimeout as delay} from 'node:timers/promises'

test('model tool saves through the real ledger and a fresh conversation reads it; stale authority and invented quotes cannot write',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-memory-tools-'))
 const resource=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'ledger.sqlite')),userId:'test',model:'fixture',gateway:{async *stream(){await Promise.reject(Error('no model'))},complete(){throw Error('no model')}},inputConsent:true,conversationProviders:['chat']})
 const tools=compileToolSchema([],{includeMemoryRecall:true,includeExplicitMemory:true})
 let serial=0
 const bridge=()=>{
  const memory=new Memory(),clock=new VirtualClock()
  return new RealtimeRuntimeBridge({tools,idFactory:()=>String(++serial),conversationConsumer:'chat',explicitMemory:()=>resource,runtime:{memory,clock,executors:new Map(),ingestUserInput({text}){return Promise.resolve(makeMemoryRef('conversation',memory.append('conversation',{ts:clock.now(),trust:'trusted_user',priority:100,content:{role:'user',text}}).seq))},dispatchExternal(){throw Error('must not delegate')}}})
 }
 const call=(name:string,args:ToolCallReady['arguments']):ToolCallReady=>({kind:'tool_call_ready',call_id:'call-'+(++serial),item_id:'item-'+serial,name,arguments:args,response_id:'response',session_epoch:0})
 try{
  await resource.open({deferBackground:true})
  const a=bridge(),originRef=await a.acceptUserTranscript('请记住叫我 kant')
  const userTurn={originRef,sessionEpoch:0,acceptedUserInputRevision:1,stillWanted:()=>true}
  const saved=await a.acceptToolCall(call('memory__remember',{action:'set',kind:'preference',slot:'preferred_name',text:'kant',quote:'叫我 kant'}),{originRef,userTurn})
  assert.equal(saved.code,'committed');assert.equal((JSON.parse(saved.host_item.content) as ExplicitMemoryReceipt).current?.text,'kant')
  const b=bridge(),second=await b.acceptUserTranscript('记得我叫什么吗')
  const lookup=await b.acceptToolCall(call('memory__lookup',{slot:'preferred_name'}),{originRef:second})
  assert.equal((JSON.parse(lookup.host_item.content) as ExplicitMemoryPage).entries[0]?.text,'kant')
  const refused=await a.acceptToolCall(call('memory__remember',{action:'set',kind:'preference',slot:'preferred_name',text:'kay',quote:'叫我 kay'}),{originRef,userTurn})
  assert.equal(refused.accepted,false)
  const stale=await a.acceptToolCall(call('memory__remember',{action:'forget',slot:'preferred_name',quote:'叫我 kant'}),{originRef,userTurn:{...userTurn,stillWanted:()=>false}})
  assert.equal(stale.accepted,false)
  const forged=await a.acceptToolCall(call('memory__remember',{action:'forget',slot:'preferred_name',quote:'叫我 kant'}),{originRef})
  assert.equal(forged.accepted,false,'a trusted transcript alone is not live write authority')
  assert.equal((await resource.lookupExplicit({slot:'preferred_name'},'chat')).entries[0]?.text,'kant')
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('production composition delivers explicit tool receipts across two service sessions', {timeout:30000}, async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-explicit-service-'))
 const gateway={async *stream(){await Promise.reject(Error('no model'))},complete(){throw Error('no model')}}
 const createResource=()=>new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'ledger.sqlite')),userId:'test',model:'fixture',gateway,inputConsent:true,conversationProviders:['chat']})
 let resource=createResource()
 const outputs:HostContextItem[]=[]
 let sessionId=0
 const session=()=>{
  const provider:RealtimeProvider={
   connect:()=>Promise.resolve({epoch:1,provider_session_id:'fixture'}),
   sendAudio:()=>Promise.resolve(),replaceResponseAdaptation:()=>Promise.resolve(),
   injectHostItem:item=>{outputs.push(hostContextItemSchema.parse(item));return Promise.resolve({session_epoch:1,host_item_id:item.host_item_id,provider_item_id:'provider-'+item.host_item_id})},
   createResponse:()=>Promise.resolve(),cancelResponse:()=>Promise.resolve(),close:()=>Promise.resolve(),
   async *events(signal){if(!signal.aborted)await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))},
  }
  const core=buildAssembly({settings:settingsSchema.parse({executors:[]}),gateway,clock:new VirtualClock(),blackboard:{path:join(root,'board-'+(++sessionId)+'.sqlite'),ownerId:'fixture'},capabilities:parseCapabilityRegistry({version:1,modules:{search:{enabled:false},camera:{enabled:false},coding:{enabled:false},knowledge:{enabled:false}}})})
  return buildRealtimeAssembly({core,provider,createPersonalMemory:()=>resource,memoryConsumerFingerprint:'chat',memoryReadMode:'text',onDiagnostic:()=>undefined})
 }
 const call=async(graph:ReturnType<typeof session>,id:string,text:string,name:string,args:ToolCallReady['arguments'])=>{
  await graph.service.handleEvent({kind:'user_speech_started',session_epoch:1,speech_id:id,provider_item_id:id})
  await graph.service.handleEvent({kind:'user_speech_ended',session_epoch:1,speech_id:id,provider_item_id:id})
  await graph.service.handleEvent({kind:'user_transcript_final',session_epoch:1,item_id:id,text})
  await graph.service.handleEvent({kind:'response_started',session_epoch:1,response_id:'response-'+id})
  await graph.service.handleEvent({kind:'tool_call_ready',session_epoch:1,call_id:id,item_id:'tool-'+id,response_id:'response-'+id,name,arguments:args})
  await graph.service.handleEvent({kind:'response_terminal',session_epoch:1,response_id:'response-'+id,status:'completed',reason:''})
  for(let i=0;i<400&&!outputs.some(item=>item.call_id===id);i++)await delay(10)
  const output=outputs.find(item=>item.call_id===id)
  assert(output,'service must deliver the tool result to the provider')
  return output.content
 }
 let graph:ReturnType<typeof session>|undefined
 try{
  await resource.open({deferBackground:true});graph=session();await graph.start()
  const saved=JSON.parse(await call(graph,'save','请记住叫我 kant','memory__remember',{action:'set',kind:'preference',slot:'preferred_name',text:'kant',quote:'叫我 kant'})) as ExplicitMemoryReceipt
  assert.equal(saved.state,'committed');assert.equal(saved.current?.text,'kant')
  await graph.stop();resource=createResource();await resource.open({deferBackground:true});graph=session();await graph.start()
  const found=JSON.parse(await call(graph,'lookup','记得我叫什么吗','memory__lookup',{slot:'preferred_name'})) as ExplicitMemoryPage
  assert.equal(found.entries[0]?.text,'kant')
 }finally{await graph?.stop();await resource.close();await rm(root,{recursive:true,force:true})}
})
