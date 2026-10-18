import type {JsonValue} from '../src/core/events.js'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {compileToolSchema} from '../src/core/tool-schema.js'
import {UnifiedRetrieval} from '../src/memory/retrieval.js'
import {ScheduledResponseScope} from '../src/personal-agent/scheduled-response-scope.js'
import {ScheduledToolRuntime,scheduledToolResult} from '../src/personal-agent/scheduled-tool-runtime.js'
import {schedulePresets} from '../src/personal-agent/schedule-presets.js'
import {hostContextItemSchema} from '../src/realtime/protocol.js'
test('the background tool boundary rejects writes and forged metadata even when tools bypass the offered schema',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-scheduled-tools-')),host=new PersonalAgentHost({path:join(dir,'p.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{await host.open();const input=schedulePresets('Asia/Shanghai')[0]!.input,s=await host.schedules.create('s',input,{user_scope:'test',source:'ui',origin_ref:'ui:s',source_refs:[],allowed_context:input.context}),run=await host.schedules.runNow('r',s.id,1),task=await host.tasks.delegate('t',run.input)
  await host.schedules.bindTask(run.run_id,task.id)
  const grant=host.scheduledRunGrant(run.run_id,new AbortController().signal),scope=new ScheduledResponseScope(host.scheduledAuthority,grant)
  scope.bind(1,'response',['root'],[],new Set(['root']))
  let active=true
  const tools=new ScheduledToolRuntime({host,grant,scope,tools:compileToolSchema([],{includeSchedules:true,includeAppContext:true,includeMemoryRecall:true}),retrieval:new UnifiedRetrieval({memory:()=>undefined}),session:()=>({sessionEpoch:1,activeProviderResponseId:active?'response':null,providerTurnPhase:()=>active?'active':'completed',providerTurnWasFenced:()=>false}),readonlyOperation:()=>false,dispatch:()=>Promise.resolve(assert.fail('no executor admitted'))})
  let seq=0
  const call=(name:string,args:Record<string,unknown>)=>tools.accept({kind:'tool_call_ready',session_epoch:1,call_id:'c'+(++seq),item_id:'i'+seq,response_id:'response',name,arguments:args as Record<string,JsonValue>})
  for(const name of ['schedule','task','dispatch','cancel','confirm','unknown__write'])assert.equal((await call(name,{})).accepted,false,name)
  assert.equal((await call('app__context',{section:'todos',run_id:'fake'})).accepted,false)
  const result=await call('app__context',{section:'todos',cursor:null});assert.equal(result.accepted,true);assert.equal(hostContextItemSchema.safeParse(result.host_item).success,true)
  assert.equal(host.tasks.evidence(task.id).filter(item=>item.kind==='context').length,1)
  active=false;assert.equal((await call('app__context',{section:'todos'})).accepted,false)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('bounded structured read results preserve full pages without widening ordinary narration',()=>{
 const item={kind:'tool_output',host_item_id:'h',event_id:'e',call_id:'c',content:'x'.repeat(20000)}
 assert.equal(hostContextItemSchema.safeParse(item).success,false)
 assert.equal(hostContextItemSchema.safeParse({...item,context_read:true}).success,true)
 assert.equal(hostContextItemSchema.safeParse({...item,context_read:true,content:'x'.repeat(32769)}).success,false)
 assert.equal(hostContextItemSchema.safeParse({...item,kind:'recovery',call_id:null,context_read:true}).success,false)
})

test('only the host source-processing path marks larger structured originals',()=>{
 const call={kind:'tool_call_ready' as const,session_epoch:1,call_id:'c',item_id:'i',response_id:'response',name:'source__process',arguments:{action:'read'}}
 const data={text:'资料'.repeat(8000)},source=scheduledToolResult(call,data,'ok',true,131072,true)
 assert.ok(Buffer.byteLength(JSON.stringify(data))>32768)
 assert.equal(hostContextItemSchema.safeParse(source.host_item).success,true)
 assert.throws(()=>scheduledToolResult(call,data),/context_capacity/)
 assert.equal(hostContextItemSchema.safeParse({...source.host_item,source_processing_read:undefined}).success,false)
 assert.equal(hostContextItemSchema.safeParse({...source.host_item,content:'x'.repeat(131073)}).success,false)
 assert.equal(hostContextItemSchema.safeParse({...source.host_item,context_read:undefined}).success,false)
 assert.equal(hostContextItemSchema.safeParse({...source.host_item,kind:'recovery',call_id:null}).success,false)
})
