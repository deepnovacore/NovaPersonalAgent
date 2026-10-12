import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ScheduleService} from '../src/personal-agent/scheduled-tasks.js'
import {TaskService} from '../src/personal-agent/tasks.js'
import {ScheduledRunAuthority} from '../src/personal-agent/scheduled-run-authority.js'
import {ScheduledResponseScope} from '../src/personal-agent/scheduled-response-scope.js'
import {schedulePresets} from '../src/personal-agent/schedule-presets.js'
test('scheduled queries inherit only their exact host response or accepted tool continuation',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-schedule-scope-')),schedules=new ScheduleService(join(dir,'s.json')),tasks=new TaskService(join(dir,'t.json')),lifetime=new AbortController()
 try{await schedules.open();await tasks.open();const input=schedulePresets('Asia/Shanghai')[0]!.input
  const s=await schedules.create('s',input,{user_scope:'test',source:'ui',origin_ref:'ui:s',source_refs:[],allowed_context:input.context}),run=await schedules.runNow('r',s.id,1),task=await tasks.delegate('t',run.input)
  await schedules.bindTask(run.run_id,task.id)
  const authority=new ScheduledRunAuthority(schedules,tasks),grant=authority.issue(schedules.getRun(run.run_id),task,lifetime.signal),scope=new ScheduledResponseScope(authority,grant)
  assert.throws(()=>new ScheduledResponseScope(authority,{...grant}),/invalid_scheduled_grant/)
  assert.equal(scope.bind(1,'unrelated',['other'],[],new Set(['root'])),null)
  assert.throws(()=>scope.acceptCall(1,'unrelated','c0',true),/scheduled_response_unbound/)
  assert.equal(scope.bind(1,'first',['root'],[],new Set(['root'])),'root')
  scope.acceptCall(1,'first','c1',true)
  assert.equal(scope.bind(1,'child',[],['c1'],new Set()),'root')
  scope.acceptCall(1,'child','c2',true)
  assert.equal(scope.bind(1,'spoof',[],['unknown'],new Set()),null)
  assert.equal(scope.bind(2,'new-epoch',[],['c1'],new Set()),null)
  assert.throws(()=>scope.acceptCall(1,'first','late',false),/scheduled_response_stale/)
  lifetime.abort();assert.throws(()=>scope.acceptCall(1,'child','after-close',true),/scheduled_run_closed/)
 }finally{await tasks.close();await schedules.close();await rm(dir,{recursive:true,force:true})}
})
