/* eslint-disable @typescript-eslint/require-await -- deterministic injected loop ports preserve asynchronous contracts */
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {TaskService,type TaskRecord} from '../src/personal-agent/tasks.js'
const fence=(t:TaskRecord)=>({task_id:t.id,control_revision:t.control_revision,goal_revision:t.goal_revision})
test('completion requires resolved task evidence, not public refs, and preserves original goal',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-loop-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{await tasks.open();const task=await tasks.delegate('d',{conversation_id:'c',goal:'original',acceptance:['checked'],origin_ref:'conversation:1'})
 await tasks.appendEvent({task_id:task.id,kind:'tool',text:'ok',refs:['fake']},'display')
 const service=tasks as TaskService & {applyDecision?:(f:ReturnType<typeof fence>,d:unknown)=>Promise<TaskRecord>}
 assert.equal(typeof service.applyDecision,'function')
 await assert.rejects(service.applyDecision(fence(task),{kind:'complete',evidence_refs:['fake']}),/evidence/)
 await assert.rejects(service.applyDecision(fence(task),{kind:'complete',evidence_refs:[]}),/evidence/)
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

import {TaskLoop} from '../src/personal-agent/task-loop.js'
import {LifeService} from '../src/personal-agent/life.js'
async function setup(){const dir=await mkdtemp(join(await realpath(tmpdir()),'task-loop-')),tasks=new TaskService(join(dir,'tasks.json'));await tasks.open();const task=await tasks.delegate('d',{conversation_id:'c',goal:'original',acceptance:['checked'],origin_ref:'conversation:1'});return {tasks,task,close:async()=>{await tasks.close();await rm(dir,{recursive:true,force:true})}}}
test('real outcomes complete; active work and stale goal/control cannot complete',async()=>{
 const f=await setup();try{await f.tasks.bindWork(fence(f.task),'w');await assert.rejects(f.tasks.applyDecision(fence(f.task),{kind:'complete',evidence_refs:[]}),/active/)
 const ref=await f.tasks.recordWorkOutcome('w','ok',{checks:['passed']});assert.ok(ref)
 await f.tasks.reviseGoal('r',fence(f.task),{kind:'nova'},'new goal',['more']);assert.equal(f.tasks.get(f.task.id).original_goal,'original')
 await assert.rejects(f.tasks.applyDecision(fence(f.task),{kind:'complete',evidence_refs:[ref]}),/stale/)
 await assert.rejects(f.tasks.applyDecision(fence(f.tasks.get(f.task.id)),{kind:'complete',evidence_refs:[ref]}),/evidence/)
 await f.tasks.recordDelivery(fence(f.tasks.get(f.task.id)),'reply','actual deliverable')
 await f.tasks.applyDecision(fence(f.tasks.get(f.task.id)),{kind:'complete',evidence_refs:['task-delivery:reply']});assert.equal(f.tasks.get(f.task.id).phase,'completed')
 }finally{await f.close()}
})
test('three corrections then wait; explicit continue resets; dispatch error cannot spin',async()=>{
 const f=await setup();let executions=0;try{await f.tasks.recordDelivery(fence(f.task),'reply','incomplete');const loop=new TaskLoop(f.tasks,{evaluate:async()=>({kind:'correct',instruction:'fix',evidence_refs:['task-delivery:reply']}),execute:async()=>{executions++},syncTodo:async()=> 'synced'})
 for(let i=0;i<4;i++)await loop.wake(f.task.id)
 assert.equal(executions,3);assert.equal(f.tasks.get(f.task.id).waiting_reason,'correction_limit')
 await f.tasks.continue('continue',fence(f.tasks.get(f.task.id)),{kind:'nova'});await loop.wake(f.task.id);assert.equal(executions,4);await loop.close()
 const failing=new TaskLoop(f.tasks,{evaluate:async()=>({kind:'correct',instruction:'fix',evidence_refs:[]}),execute:async()=>{executions++;throw Error('lost')},syncTodo:async()=> 'synced'});await failing.wake(f.task.id);await failing.wake(f.task.id);assert.equal(executions,5);assert.equal(f.tasks.get(f.task.id).waiting_reason,'task_effect_unknown');await failing.close()
 }finally{await f.close()}
})
test('cancellation during verification and concurrent new work invalidate final acceptance',async()=>{
 for(const mutate of ['cancel','work','control'] as const){const f=await setup();try{await f.tasks.recordDelivery(fence(f.task),'reply','answer');let release!:()=>void;let started!:()=>void;const ready=new Promise<void>(done=>{started=done});const barrier=new Promise<void>(done=>{release=done});const loop=new TaskLoop(f.tasks,{evaluate:async()=>{started();await barrier;return {kind:'complete',evidence_refs:['task-delivery:reply']}},execute:async()=>{/* no corrective work in this race */},syncTodo:async()=> 'synced'});const run=loop.wake(f.task.id);await ready;if(mutate==='cancel')await f.tasks.cancel('c',fence(f.task),{kind:'nova'});else if(mutate==='work')await f.tasks.bindWork(fence(f.task),'new');else await f.tasks.control('c',fence(f.task),{kind:'nova'},{kind:'user',client_id:'u'});release();await run;assert.notEqual(f.tasks.get(f.task.id).phase,'completed');await loop.close()}finally{await f.close()}}
})
test('Todo completion uses deterministic receipt and preserves manual changes',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-todo-')),life=new LifeService(join(dir,'life.json'));try{await life.open();const todo=await life.mutate({op:'create',kind:'todo',title:'Keep title',note:'Keep note'},'create');const task={id:'t',goal_revision:0,todo_ref:todo} as TaskRecord
 assert.equal(await life.completeTaskTodo(task),'synced');assert.equal(await life.completeTaskTodo(task),'synced');assert.equal(life.snapshot().todos[0]!.version,2);assert.equal(life.snapshot().todos[0]!.note,'Keep note')
 const second=await life.mutate({op:'create',kind:'todo',title:'manual'},'second');await life.mutate({op:'update',kind:'todo',id:second.id,expected_version:1,status:'cancelled'},'cancel');assert.equal(await life.completeTaskTodo({...task,id:'t2',todo_ref:second}),'conflict');assert.equal(life.snapshot().todos[1]!.status,'cancelled')
 }finally{await life.close();await rm(dir,{recursive:true,force:true})}
})

import {hostResponseIntentSchema} from '../src/realtime/protocol.js'
test('Nova continuation is an explicit drafting intent, not a narrated host fact',()=>{
 assert.equal(hostResponseIntentSchema.safeParse({kind:'task_continuation',item:{kind:'recovery',host_item_id:'h',event_id:'h',call_id:null,content:'authorized task'},task_summary:null,origin_spoken:false}).success,true)
})

test('projection failure retries only the Todo and model failure waits without execution',async()=>{
 const f=await setup();let evaluated=0,synced=0;try{await f.tasks.recordDelivery(fence(f.task),'reply','answer');const loop=new TaskLoop(f.tasks,{evaluate:async()=>{evaluated++;return {kind:'complete',evidence_refs:['task-delivery:reply']}},execute:async()=>assert.fail('execution'),syncTodo:async()=>{synced++;throw Error('lost acknowledgement')}})
 // Linked Todo is captured at declaration, not reconstructed from the completion text.
 const linked=await f.tasks.delegate('linked',{conversation_id:'c',goal:'linked',acceptance:[],origin_ref:'conversation:1',todo_ref:{id:'todo',version:1}});await f.tasks.recordDelivery(fence(linked),'linked','answer')
 const projection=new TaskLoop(f.tasks,{evaluate:async()=>{evaluated++;return {kind:'complete',evidence_refs:['task-delivery:linked']}},execute:async()=>assert.fail('execution'),syncTodo:async()=>{synced++;if(synced===1)throw Error('lost');return 'synced'}});await projection.wake(linked.id);assert.equal(f.tasks.get(linked.id).todo_sync,'pending');await projection.wake(linked.id);assert.equal(f.tasks.get(linked.id).todo_sync,'synced');assert.equal(evaluated,1);await projection.close();await loop.close()
 const failed=new TaskLoop(f.tasks,{evaluate:async()=>{throw Error('model unavailable')},execute:async()=>assert.fail('execution'),syncTodo:async()=> 'synced'});await failed.wake(f.task.id);assert.equal(f.tasks.get(f.task.id).waiting_reason,'task_check_unavailable');assert.equal(f.tasks.get(f.task.id).corrections,0);await failed.close()
 }finally{await f.close()}
})

test('an accepted steer receipt cannot serve as primary completion evidence',async()=>{
 const f=await setup();try{await f.tasks.bindWork(fence(f.task),'steer',undefined,false);const ref=await f.tasks.recordWorkOutcome('steer','ok',{accepted:true});await assert.rejects(f.tasks.applyDecision(fence(f.task),{kind:'complete',evidence_refs:[ref!]}),/evidence/)}finally{await f.close()}
})

test('unknown user input blocks correction after terminal work and handback, including serialized effect admission',async()=>{
 const f=await setup();let executions=0;try{await f.tasks.bindWork(fence(f.task),'work','session');await f.tasks.controlClient('take',fence(f.task),'client','takeover');const owned=f.tasks.get(f.task.id)
 assert.equal(await f.tasks.input('input',fence(owned),{kind:'user',client_id:'client'},'session','change it',async()=> 'unknown'),'unknown');await f.tasks.recordWorkOutcome('work','ok',{checks:['failed']});await f.tasks.controlClient('return',fence(owned),'client','return');const returned=f.tasks.get(f.task.id)
 const decision={kind:'correct' as const,instruction:'retry change',evidence_refs:['task-work:work']};const loop=new TaskLoop(f.tasks,{evaluate:async()=>decision,execute:async()=>{executions++},syncTodo:async()=> 'synced'})
 await loop.wake(f.task.id);assert.equal(executions,0);assert.equal(f.tasks.get(f.task.id).waiting_reason,'task_effect_unknown');assert.equal(f.tasks.get(f.task.id).corrections,0)
 await assert.rejects(f.tasks.applyDecision(fence(returned),decision),/task_effect_unknown/);await assert.rejects(f.tasks.reserveInitial(fence(returned)),/task_effect_unknown/);await loop.close()
 }finally{await f.close()}
})

test('input acknowledgement becoming unknown during evaluation fences the corrective decision',async()=>{
 const f=await setup();let release!:()=>void,entered!:()=>void,executions=0;const started=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 try{await f.tasks.bindWork(fence(f.task),'work','session');await f.tasks.recordWorkOutcome('work','ok',{checks:['failed']});const loop=new TaskLoop(f.tasks,{evaluate:async()=>{entered();await gate;return {kind:'correct',instruction:'fix',evidence_refs:['task-work:work']}},execute:async()=>{executions++},syncTodo:async()=> 'synced'});const run=loop.wake(f.task.id);await started;await f.tasks.input('input',fence(f.task),{kind:'nova'},'session','update',async()=> 'unknown');release();await run;assert.equal(executions,0);assert.equal(f.tasks.get(f.task.id).waiting_reason,'task_effect_unknown');await loop.close()}finally{release?.();await f.close()}
})

import {TaskExecutionRejected} from '../src/personal-agent/task-loop.js'
test('known refused initial attempts retry without verification or correction allowance',async()=>{
 const f=await setup();let attempts=0;const loop=new TaskLoop(f.tasks,{evaluate:async()=>assert.fail('initial admission is not verification'),execute:async()=>{attempts++;throw new TaskExecutionRejected('busy')},syncTodo:async()=> 'synced'})
 try{await loop.wake(f.task.id);await loop.wake(f.task.id);assert.equal(attempts,2);assert.equal(f.tasks.get(f.task.id).corrections,0);assert.equal(f.tasks.get(f.task.id).waiting_reason,'busy')}finally{await loop.close();await f.close()}
})
test('shutdown during evaluation does not write an unavailable check',async()=>{
 const f=await setup();let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve});await f.tasks.recordDelivery(fence(f.task),'reply','answer');const loop=new TaskLoop(f.tasks,{evaluate:async(_task,signal)=>{entered();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));signal.throwIfAborted();return {kind:'wait',reason:'unused',evidence_refs:[]}},execute:async()=>assert.fail('shutdown'),syncTodo:async()=> 'synced'})
 try{const run=loop.wake(f.task.id);await started;await loop.close();await run;assert.equal(f.tasks.get(f.task.id).waiting_reason,null)}finally{await f.close()}
})
test('takeover after effect reservation is a failed preflight rather than an unknown write',async()=>{
 const f=await setup(),reserve=f.tasks.reserveInitial.bind(f.tasks);f.tasks.reserveInitial=async bound=>{const id=await reserve(bound);await f.tasks.controlClient('take',bound,'client','takeover');return id};const loop=new TaskLoop(f.tasks,{evaluate:async()=>assert.fail('initial'),execute:async()=>assert.fail('preflight stopped it'),syncTodo:async()=> 'synced'})
 try{await loop.wake(f.task.id);assert.equal(f.tasks.pendingEffect(f.task.id),null)}finally{await loop.close();await f.close()}
})

test('a pending Nova delivery coalesces repeated wakes until its exact disposition',async()=>{
 const f=await setup();let executions=0;await f.tasks.recordDelivery(fence(f.task),'initial','incomplete');const loop=new TaskLoop(f.tasks,{evaluate:async()=>({kind:'correct',instruction:'finish',evidence_refs:['task-delivery:initial']}),execute:async(_task,_instruction,bound)=>{executions++;await f.tasks.beginDelivery(bound,'delivery:'+executions)},syncTodo:async()=> 'synced'})
 try{await loop.wake(f.task.id);for(let i=0;i<3;i++)await loop.wake(f.task.id);assert.equal(executions,1);assert.equal(f.tasks.get(f.task.id).corrections,1);await f.tasks.finishDelivery(f.task.id,'wrong');await loop.wake(f.task.id);assert.equal(executions,1);await f.tasks.finishDelivery(f.task.id,'delivery:1');await loop.wake(f.task.id);assert.equal(executions,2)}finally{await loop.close();await f.close()}
})
