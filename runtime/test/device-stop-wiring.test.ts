import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm,writeFile,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {StopRevoker} from '../src/device/port.js'
import {buildProductionComposition} from '../src/composition/production-composition.js'

for(const mode of ['absent','success','failure'] as const)test('stop revoker: '+mode,async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'device-stop-'))
 const order:string[]=[],diagnostics:string[]=[]
 let finish:()=>void=()=>undefined
 const pending=new Promise<void>(resolve=>{finish=resolve})
 const revoker:StopRevoker={revokeForStop:async id=>{
  assert.equal(id,task.id);order.push('revoke');await pending
  if(mode==='failure')throw Error('private failure detail')
 }}
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,
  pool:new SuggestionPool(),evidence:()=>null,...(mode==='absent'?{}:{stopRevoker:revoker}),
  ...{onDiagnostic:(code:string)=>{diagnostics.push(code)}}})
 let task:Awaited<ReturnType<typeof host.tasks.delegate>>
 try{
  await host.open()
  task=await host.tasks.delegate('declare',{conversation_id:'chat:main',goal:'stop',acceptance:[],origin_ref:'conversation:1'})
  const cancel=host.tasks.cancel.bind(host.tasks)
  host.tasks.cancel=(...args)=>{order.push('cancel');return cancel(...args)}
  const result=host.cancelTask('stop',{task_id:task.id,goal_revision:0,control_revision:0},{kind:'nova'})
  if(mode!=='absent'){assert.deepEqual(order,['revoke']);finish()}
  assert.equal((await result).phase,'cancelled')
  assert.deepEqual(order,mode==='absent'?['cancel']:['revoke','cancel'])
  assert.deepEqual(diagnostics,mode==='failure'?['device_stop_revocation_failed']:[])
 }finally{finish();await host.close();await rm(dir,{recursive:true,force:true})}
})

test('default production composition creates no device gateway or ledger',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'device-default-'))
 const stop=new AbortController(),cleanups=new Set<()=>void|Promise<void>>()
 let composition:Awaited<ReturnType<typeof buildProductionComposition>>|undefined
 try{
  const capabilities=join(dir,'capabilities.json')
  await writeFile(capabilities,JSON.stringify({version:1,modules:{search:{enabled:false},camera:{enabled:false},coding:{enabled:false},knowledge:{enabled:false}}}))
  composition=await buildProductionComposition({token:'0'.repeat(32),stop,
   ownership:{own:cleanup=>{cleanups.add(cleanup);return()=>{cleanups.delete(cleanup)}}},
   onDiagnostic:()=>undefined,environment:{DASHSCOPE_API_KEY:'synthetic-text-key',PIPELINE_MODE:'integrated',
    CAPABILITIES_CONFIG:capabilities,REALTIME_TELEMETRY:join(dir,'telemetry.jsonl'),
    BLACKBOARD_PATH:join(dir,'blackboard.sqlite'),MEMORY_PATH:join(dir,'memory.sqlite'),WORKSPACE_GRAPH_PATH:join(dir,'workspace.sqlite')}})
  await composition.realtime.start()
  assert.equal('stopRevoker' in composition.realtime.personalAgent.options,false)
  assert.equal((await readdir(dir)).some(name=>name.includes('.device')),false)
 }finally{stop.abort();await composition?.realtime.stop();for(const cleanup of [...cleanups].reverse())await cleanup();await rm(dir,{recursive:true,force:true})}
})
