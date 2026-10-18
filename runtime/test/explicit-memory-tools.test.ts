import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Memory,makeMemoryRef} from '../src/core/memory.js'
import {VirtualClock} from '../src/core/clock.js'
import {compileToolSchema} from '../src/core/tool-schema.js'
import {RealtimeRuntimeBridge,type ToolCallReady} from '../src/realtime/bridge.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import type {ExplicitMemoryReceipt,ExplicitMemoryPage} from '../src/memory/explicit-memory.js'

test('model tool saves through the real ledger and a fresh conversation reads it; stale authority and invented quotes cannot write',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-memory-tools-'))
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
