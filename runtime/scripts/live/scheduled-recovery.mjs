/** Fault injection against normal production composition, using only an isolated synthetic profile. */
import {fork} from 'node:child_process'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
const file=fileURLToPath(import.meta.url)
export async function runScheduledCrashRecovery(directory,environment){
 await mkdir(directory,{recursive:true,mode:0o700})
 const run=phase=>new Promise((resolve,reject)=>{
  const child=fork(file,[phase,directory],{env:environment,stdio:['ignore','ignore','ignore','ipc']})
  const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('recovery_worker_timeout'))},60000)
  child.once('error',error=>{clearTimeout(timer);reject(error)})
  child.once('exit',(code,signal)=>{clearTimeout(timer);if(phase==='crash'?signal==='SIGKILL':code===0)resolve();else reject(Error('recovery_worker_'+phase+'_'+code+'_'+signal))})
 })
 await run('crash');await run('recover')
 return JSON.parse(await readFile(join(directory,'recovery.json'),'utf8'))
}
async function worker(phase,directory){
 const {buildProductionComposition}=await import('../../dist/src/composition/production-composition.js')
 const environment={...process.env,BLACKBOARD_PATH:join(directory,'blackboard.sqlite'),REALTIME_TELEMETRY:join(directory,'telemetry.jsonl')},cleanup=new Set(),stop=new AbortController()
 const composition=await buildProductionComposition({token:randomUUID(),stop,ownership:{own:fn=>{cleanup.add(fn);return()=>cleanup.delete(fn)}},onDiagnostic:()=>{},environment})
 try{
  await composition.realtime.start();const host=composition.realtime.personalAgent
  if(phase==='crash'){
   const context={todos:true,goals:false,tasks:false,memory:false,knowledge:false,search:false}
   const ack=await host.command({type:'personal.command',method:'schedules.create',request_id:'recovery-create',params:{input:{title:'合成测试：崩溃恢复',goal:'读取当前事项并说明有哪些事项，没有时如实说明。',acceptance:['说明当前事项'],rule:{kind:'daily',timezone:'UTC',time:'09:00'},context}}},{client_id:'recovery-live'})
   if(!ack.ok)throw Error('recovery_create_failed')
   const schedule=ack.data
   const result=await host.command({type:'personal.command',method:'schedules.run_now',request_id:'recovery-run',params:{id:schedule.id,expected_revision:schedule.revision}},{client_id:'recovery-live'})
   if(!result.ok)throw Error('recovery_run_failed')
   const until=Date.now()+30000
   while(Date.now()<until){
    const task=host.tasks.findByRun(result.data.run_id)
    if(task?.pending_delivery&&host.conversationService(task.conversation_id)?.deliveryState().activeResponseId){
     await writeFile(join(directory,'crash.json'),JSON.stringify({run_id:result.data.run_id,task_id:task.id,pending_delivery:task.pending_delivery,trigger_mode:'real_model_in_flight_process_kill'}),{mode:0o600})
     process.kill(process.pid,'SIGKILL')
    }
    await new Promise(resolve=>setTimeout(resolve,10))
   }
   throw Error('in_flight_boundary_not_observed')
  }
  const before=JSON.parse(await readFile(join(directory,'crash.json'),'utf8'))
  await new Promise(resolve=>setTimeout(resolve,2000))
  const task=host.tasks.get(before.task_id)
  if(task.phase!=='waiting'||task.waiting_reason!=='task_delivery_uncertain'||host.tasks.list().filter(row=>row.trigger?.run_id===before.run_id).length!==1)throw Error('unsafe_recovery')
  const telemetry=await readFile(join(directory,'telemetry.jsonl'),'utf8')
  const requests=telemetry.split('\n').filter(line=>line.includes('cascaded.llm.requested')).length
  if(requests!==1)throw Error('unexpected_model_reexecution')
  await writeFile(join(directory,'recovery.json'),JSON.stringify({...before,status:'passed',phase:task.phase,waiting_reason:task.waiting_reason,model_requests:requests,task_count:host.tasks.list().length}),{mode:0o600})
 }finally{stop.abort();await composition.realtime.stop();for(const close of [...cleanup].reverse())await Promise.resolve(close())}
}
if(process.argv[1]&&resolve(process.argv[1])===file)await worker(process.argv[2],resolve(process.argv[3]))
