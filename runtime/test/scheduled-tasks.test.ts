import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ScheduleService,type ScheduleInput,type ScheduleCreateAuthority} from '../src/personal-agent/scheduled-tasks.js'
import {TaskService} from '../src/personal-agent/tasks.js'

const input:ScheduleInput={title:'Morning review',goal:'Review current priorities',acceptance:['Explain the highest priorities'],rule:{kind:'daily',timezone:'Asia/Shanghai',time:'10:30'},context:{todos:true,goals:true,tasks:true,memory:false,knowledge:false,search:false}}
const authority:ScheduleCreateAuthority={user_scope:'local',source:'ui',origin_ref:'ui:create',source_refs:[],allowed_context:input.context}
async function fixture(run:(s:ScheduleService,t:TaskService,setNow:(iso:string)=>void,path:string)=>Promise<void>){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-schedules-')),path=join(dir,'schedules.json')
 let now=new Date('2026-10-12T02:29:00Z')
 const s=new ScheduleService(path,()=>{},()=>now),t=new TaskService(join(dir,'tasks.json'))
 try{await s.open();await t.open();await run(s,t,iso=>{now=new Date(iso)},path)}finally{await s.close();await t.close();await rm(dir,{recursive:true,force:true})}
}
test('scoped create and manual run retries survive restart and reject different payloads',()=>fixture(async(s,t,_set,path)=>{
 const created=await s.create('same',input,authority)
 assert.equal((await s.create('same',input,authority)).id,created.id)
 await assert.rejects(s.create('same',{...input,goal:'Other goal'},authority),/request_conflict/)
 const manual=await s.runNow('manual',created.id,1)
 assert.equal((await s.runNow('manual',created.id,1)).run_id,manual.run_id)
 const task=await t.delegate('scheduled:'+manual.run_id,manual.input);await s.bindTask(manual.run_id,task.id)
 assert.equal(t.findByRun(manual.run_id)?.id,task.id)
 assert.equal((await t.delegate('another-request',manual.input)).id,task.id)
 await assert.rejects(t.delegate('malformed',{...manual.input,goal:'Another'}),/run_conflict/)
 const restored=new ScheduleService(path);await restored.open()
 try{assert.equal((await restored.runNow('manual',created.id,1)).task_id,task.id)}finally{await restored.close()}
}))
test('parallel ticks claim one slot; edits freeze existing runs and active runs skip later slots',()=>fixture(async(s,_t,set)=>{
 const created=await s.create('create',input,authority);set('2026-10-12T02:30:00Z')
 const ticks=await Promise.all([s.claimDue(),s.claimDue()]),runs=ticks.flat()
 assert.equal(runs.length,1);const run=runs[0]!
 await s.update('edit',created.id,1,{...input,goal:'New goal'})
 assert.equal(s.getRun(run.run_id).input.goal,input.goal)
 set('2026-10-13T02:30:00Z');assert.equal((await s.claimDue()).length,0)
 assert.equal(s.history(created.id).items.at(-1)?.terminal_summary?.outcome,'skipped')
 await s.delete('delete',created.id,2)
 assert.equal(s.getRun(run.run_id).stage,'claimed');assert.equal(s.get(created.id).archived,true)
}))
test('pause and resume start from now, never catch up paused slots or rewind the cursor',()=>fixture(async(s,_t,set)=>{
 const created=await s.create('create',input,authority)
 await s.pause('pause',created.id,1);set('2026-10-14T03:00:00Z')
 await s.resume('resume',created.id,2);assert.equal((await s.claimDue()).length,0)
 const cursor=s.get(created.id).cursor;set('2026-10-12T01:00:00Z');await s.claimDue()
 assert.equal(s.get(created.id).cursor,cursor)
 set('2026-10-15T02:30:00Z');assert.equal((await s.claimDue()).length,1)
}))
test('once rules reject past instants and selected context cannot exceed user authority',()=>fixture(async(s)=>{
 await assert.rejects(s.create('past',{...input,rule:{kind:'once',timezone:'Asia/Shanghai',date:'2026-10-11',time:'10:30'}},authority),/schedule_in_past/)
 await assert.rejects(s.create('expand',{...input,context:{...input.context,search:true}},authority),/context_not_authorized/)
 const first=await s.create('same',input,authority)
 const other=await s.create('same',input,{...authority,user_scope:'other'})
 assert.notEqual(first.id,other.id)
}))
test('retired Task receipts prevent a second execution even after the detailed Task is pruned',()=>fixture(async(s,t)=>{
 const created=await s.create('create',input,authority),run=await s.runNow('manual',created.id,1)
 const task=await t.delegate('scheduled:'+run.run_id,run.input)
 await t.cancel('cancel',{task_id:task.id,control_revision:0,goal_revision:0},{kind:'nova'})
 for(let i=0;i<205;i++){
  const item=await t.delegate('ordinary:'+i,{conversation_id:'chat:main',goal:'Small task',acceptance:[],origin_ref:'user:'+i})
  await t.cancel('cancel:'+i,{task_id:item.id,control_revision:0,goal_revision:0},{kind:'nova'})
 }
 assert.throws(()=>t.findByRun(run.run_id),/task_retired/)
 await assert.rejects(t.delegate('new-request',run.input),/task_retired/)
}))
