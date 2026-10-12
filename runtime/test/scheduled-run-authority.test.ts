import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ScheduleService} from '../src/personal-agent/scheduled-tasks.js'
import {TaskService} from '../src/personal-agent/tasks.js'
import {ScheduledRunAuthority} from '../src/personal-agent/scheduled-run-authority.js'

test('run grants reject copies, mismatched definitions, different fences, stale control and expired lifetimes',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-run-grant-')),s=new ScheduleService(join(dir,'schedules.json')),t=new TaskService(join(dir,'tasks.json'))
 try{await s.open();await t.open()
  const context={todos:true,goals:false,tasks:false,memory:false,search:false,knowledge:false}
  const schedule=await s.create('create',{title:'Review',goal:'Review priorities',acceptance:['State priorities'],rule:{kind:'daily',timezone:'UTC',time:'10:00'},context},{user_scope:'test',source:'ui',origin_ref:'ui:create',source_refs:[],allowed_context:context})
  let run=await s.runNow('run',schedule.id,1);const task=await t.delegate('run',run.input),fence={task_id:task.id,control_revision:0,goal_revision:0}
  run=await s.bindTask(run.run_id,task.id);await s.markPrepared(run.run_id,'schedule-run:'+run.run_id);run=s.getRun(run.run_id)
  const authority=new ScheduledRunAuthority(s,t),lifetime=new AbortController(),grant=authority.issue(run,task,lifetime.signal)
  authority.assert(grant,fence)
  assert.throws(()=>authority.assert({...grant},fence),/invalid_scheduled_grant/)
  assert.throws(()=>authority.issue({...run,definition_hash:'0'.repeat(64)},task,lifetime.signal),/invalid_schedule_binding/)
  assert.throws(()=>authority.assert(grant,{...fence,task_id:'other'}),/invalid_scheduled_fence/)
  lifetime.abort();assert.throws(()=>authority.assert(grant,fence),/scheduled_run_closed/)
  const current=authority.issue(run,task,new AbortController().signal)
  await t.cancel('cancel',fence,{kind:'nova'});assert.throws(()=>authority.assert(current,fence),/task_terminal/)
 }finally{await s.close();await t.close();await rm(dir,{recursive:true,force:true})}
})
