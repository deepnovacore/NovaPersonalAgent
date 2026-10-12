import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {compileToolSchema} from '../src/core/tool-schema.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {ScheduleInput} from '../src/personal-agent/scheduled-tasks.js'
import {ScheduleAgentController} from '../src/personal-agent/schedule-agent.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
import {schedulePresets} from '../src/personal-agent/schedule-presets.js'

test('schedule and App tools are opt-in and the ordinary tool set stays unchanged',()=>{
 const ordinary=compileToolSchema([]),scoped=compileToolSchema([],Object.assign({},{includeSchedules:true,includeAppContext:true}))
 assert.equal(ordinary.bindings.has('schedule'),false);assert.equal(ordinary.bindings.has('app__context'),false)
 assert.equal(scoped.bindings.get('schedule')?.kind,'host');assert.equal(scoped.bindings.get('app__context')?.kind,'query')
})
test('Agent writes require current user sources and an affirmative structured intent decision',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-schedule-agent-')),host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let authorized=false,current=true,calls=0
 const input=schedulePresets('Asia/Shanghai')[0]!.input
 const gateway={complete:()=>{calls++;return Promise.resolve({text:JSON.stringify({authorized,reason:authorized?'explicit_schedule':'quoted_example',allowed_context:input.context})});}} as unknown as ModelGateway
 try{await host.open();const controller=new ScheduleAgentController(host,gateway,'test','chat:main',0)
  const source={request_id:'tool-1',origin_ref:'conversation:1',sources:[{ref:'conversation:1',text:'每天 09:00 帮我整理优先事项'}],stillWanted:()=>current}
  const args={operation:'create',input,source_refs:['conversation:1']}
  await assert.rejects(controller.invoke(args,source),/schedule_not_authorized/);assert.equal(host.schedules.list().length,0)
  authorized=true
  await assert.rejects(controller.invoke({...args,run_id:'spoof'},source),/invalid_params/)
  await assert.rejects(controller.invoke({...args,source_refs:['assistant:1']},source),/invalid_source_refs/)
  const before=calls;current=false;await assert.rejects(controller.invoke(args,source),/superseded/);assert.equal(calls,before)
  current=true
  await assert.rejects(controller.invoke({...args,input:{...input,context:{...input.context,search:true}}},source),/context_not_authorized/)
  const created=await controller.invoke(args,source) as {id:string}
  assert.equal(host.schedules.list().length,1)
  const messages=host.conversationSnapshot().messages
  assert.equal(messages.filter(item=>item.schedule_ref?.schedule_id===created.id).length,1)
  await controller.invoke(args,source);assert.equal(host.schedules.list().length,1)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('authenticated manual commands share editable presets, revision checks, durable requests and Agent runs',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-schedule-api-')),host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const command=(method:string,params:Record<string,unknown>,request_id:string,authenticated=true)=>host.command({type:'personal.command',method,params,request_id},authenticated?{client_id:'client'}:undefined) as Promise<{ok:boolean;error?:string;data:Record<string,unknown>}>
 try{await host.open()
  const presets=await command('schedules.presets',{timezone:'Asia/Shanghai'},'presets')
  assert.equal(presets.ok,true)
  const choices=presets.data.items as {id:string;input:ScheduleInput}[]
  assert.deepEqual(choices.map(item=>item.input.title),['每日优先级清单与风险提示','重点项目周度进展整理'])
  assert.deepEqual(choices.map(item=>item.input.rule),[{kind:'daily',timezone:'Asia/Shanghai',time:'09:00'},{kind:'weekly',timezone:'Asia/Shanghai',time:'09:00',weekdays:[1]}])
  assert.equal(host.schedules.list().length,0,'browsing presets does not activate them')
  const input=choices[0]!.input
  assert.equal((await command('schedules.create',{input},'unauthorized',false)).error,'unauthenticated')
  const created=await command('schedules.create',{input},'create');assert.equal(created.ok,true)
  assert.deepEqual(await command('schedules.create',{input},'create'),created)
  assert.equal(host.schedules.list().length,1)
  assert.equal((await command('schedules.create',{input:{...input,trigger:{kind:'schedule'}}},'forged')).ok,false)
  const id=created.data.id as string
  assert.equal((await command('schedules.update',{id,expected_revision:99,input},'stale')).error,'stale_schedule')
  const changed=await command('schedules.update',{id,expected_revision:1,input:{...input,title:'My daily brief',context:{...input.context,search:true}}},'edit')
  assert.equal(changed.ok,true);assert.equal(changed.data.revision,2)
  const first=await command('schedules.run_now',{id,expected_revision:2},'now'),again=await command('schedules.run_now',{id,expected_revision:2},'now')
  assert.equal(first.ok,true);assert.deepEqual(again,first)
  await host.scheduledTaskTick();assert.equal(host.tasks.list().length,1);assert.equal(host.tasks.list()[0]!.execution_route,'nova')
  const history=await command('schedules.history',{id},'history');assert.equal((history.data.items as unknown[]).length,1)
  const paused=await command('schedules.pause',{id,expected_revision:2},'pause');assert.equal(paused.data.enabled,false)
  const listed=await command('schedules.list',{},'list');assert.equal((listed.data.items as unknown[]).length,1)
  assert.ok(!JSON.stringify(listed.data).includes('user_scope'))
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
