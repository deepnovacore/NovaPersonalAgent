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
import {ScheduledToolRuntime} from '../src/personal-agent/scheduled-tool-runtime.js'

test('refused source calls consume a durable bounded attempt budget without authorizing effects',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-source-attempts-'))
 const host=new PersonalAgentHost({path:join(dir,'p.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{
  await host.open()
  const schedule=await host.schedules.ensureSourceProcessing('test'),run=await host.schedules.claimSourceProcessing(schedule.id,'batch','recipe'),task=await host.tasks.delegate('task',run.input)
  await host.schedules.bindTask(run.run_id,task.id)
  const grant=host.scheduledRunGrant(run.run_id,new AbortController().signal),scope=new ScheduledResponseScope(host.scheduledAuthority,grant)
  let response='response-0'
  const boundary=new ScheduledToolRuntime({host,grant,scope,tools:compileToolSchema([],{includeSourceProcessing:true}),retrieval:new UnifiedRetrieval({memory:()=>undefined}),session:()=>({sessionEpoch:1,activeProviderResponseId:response,providerTurnPhase:()=> 'active',providerTurnWasFenced:()=>false}),readonlyOperation:()=>false,dispatch:()=>Promise.resolve(assert.fail('no executor admitted'))})
  // These provider responses have no authorized root: scope rejection must remain.
  const call=(n:number)=>{response='response-'+n;return boundary.accept({kind:'tool_call_ready',session_epoch:1,call_id:'call-'+n,item_id:'item-'+n,response_id:response,name:'source__process',arguments:{action:'read'}})}
  assert.equal((await call(0)).code,'scheduled_response_unbound')
  assert.equal((await call(0)).code,'scheduled_response_unbound')
  assert.equal(host.schedules.getRun(run.run_id).processing!.attempts.length,1,'duplicate delivery is not another attempt')
  for(let n=1;n<24;n++)assert.equal((await call(n)).code,'scheduled_response_unbound')
  assert.equal((await call(24)).code,'processing_budget_exhausted')
  assert.equal(host.schedules.getRun(run.run_id).processing!.exhausted,true)
  assert.equal(host.schedules.getRun(run.run_id).processing!.attempts.length,24)
  assert.equal(host.schedules.getRun(run.run_id).processing!.calls.length,0)
  assert.equal(await boundary.validateContext(),false,'exhaustion prevents the next provider continuation')
  const persisted=await import('node:fs/promises').then(fs=>fs.readFile(join(dir,'p.json.schedules.json'),'utf8'))
  assert.equal(JSON.parse(persisted).runs[0].processing.attempts.length,24)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
