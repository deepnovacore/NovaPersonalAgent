import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {LifeService,goalCheckinEligible,type LifeState} from '../src/personal-agent/life.js'
import {initializeMemory,memoryOperation,type EntryRevision,type MemoryOperation} from '../src/memory-substrate/store.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {goalCheckinSource,type NotificationInput} from '../src/notifications/contracts.js'

const now=new Date('2026-10-12T12:00:00Z')
async function withDir(prefix:string,fn:(dir:string)=>Promise<void>){const dir=await mkdtemp(join(await realpath(tmpdir()),prefix));try{await fn(dir)}finally{await rm(dir,{recursive:true,force:true})}}

test('JSON store: deleting a goal detaches linked todos and ideas, is idempotent and works for any status',()=>withDir('nova-goal-delete-',async dir=>{
 const life=new LifeService(join(dir,'life.json'));await life.open()
 try{
  const goal=await life.mutate({op:'create',kind:'goal',title:'跑完半马',success_criteria:'2 小时内'},'g')
  const todo=await life.mutate({op:'create',kind:'todo',title:'周三跑 5 公里',goal_id:goal.id},'t')
  const idea=await life.mutate({op:'create',kind:'idea',title:'买跑鞋',goal_id:goal.id},'i')
  const other=await life.mutate({op:'create',kind:'goal',title:'读完一本书'},'g2')
  await life.mutate({op:'update',kind:'goal',id:other.id,expected_version:1,status:'paused'},'pause')
  await assert.rejects(life.mutate({op:'delete',kind:'goal',id:goal.id,expected_version:2},'stale'),/version_conflict/)
  const deleted=await life.mutate({op:'delete',kind:'goal',id:goal.id,expected_version:1},'delete')
  assert.deepEqual(deleted,{id:goal.id,version:1})
  const state=life.snapshot()
  assert.deepEqual(state.goals.map(g=>g.id),[other.id])
  assert.equal(state.todos.find(r=>r.id===todo.id)!.goal_id,null);assert.equal(state.todos[0]!.version,2)
  assert.equal(state.ideas.find(r=>r.id===idea.id)!.goal_id,null);assert.equal(state.ideas[0]!.version,2)
  const ids=new Set(state.goals.map(g=>g.id));assert.ok([...state.todos,...state.ideas].every(r=>r.goal_id===null||ids.has(r.goal_id)),'no dangling goal_id')
  assert.deepEqual(await life.mutate({op:'delete',kind:'goal',id:goal.id,expected_version:1},'delete'),deleted,'a repeated request id returns the first result')
  assert.equal(life.snapshot().todos[0]!.version,2,'the repeat does not touch children again')
  await assert.rejects(life.mutate({op:'delete',kind:'goal',id:goal.id,expected_version:1},'delete-again'),/item_not_found/)
  await life.mutate({op:'delete',kind:'goal',id:other.id,expected_version:2},'delete-paused');assert.deepEqual(life.snapshot().goals,[])
  assert.throws(()=>life.mutate({op:'delete',kind:'todo',id:todo.id,expected_version:2},'todo'),/invalid_value|Invalid/u,'todos have no general delete')
 }finally{await life.close()}
}))

test('memory backend: goal deletion tombstones the goal entry and rewrites linked children as user corrections',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const run=(op:string,input:unknown)=>memoryOperation(db,op as MemoryOperation,input) as {revision:number;state:LifeState;result:{id:string;version:number}}
 const namespace='personal:test:life:'
 try{
  let at=run('life_load',{namespace,legacy:{todos:[],ideas:[],goals:[],profile:{about:'',version:0},receipts:{}}})
  const step=(requestId:string,input:unknown)=>{at=run('life_mutate',{namespace,expectedRevision:at.revision,requestId,input});return at}
  const goal=step('g',{op:'create',kind:'goal',title:'学西班牙语'}).result
  step('t',{op:'create',kind:'todo',title:'背 20 个单词',goal_id:goal.id});step('i',{op:'create',kind:'idea',title:'看西语电影',goal_id:goal.id})
  const deleted=step('delete',{op:'delete',kind:'goal',id:goal.id,expected_version:1})
  assert.deepEqual(deleted.state.goals,[]);assert.equal(deleted.state.todos[0]!.goal_id,null);assert.equal(deleted.state.ideas[0]!.goal_id,null)
  const rows=memoryOperation(db,'list',{include_history:true}) as EntryRevision[]
  const tombstone=rows.find(r=>r.kind==='goal'&&r.op==='tombstone')!
  assert.equal(tombstone.content.reason,'delete');assert.equal(tombstone.written_by,'user_correction')
  const todo=rows.filter(r=>r.kind==='todo').at(-1)!
  assert.equal((todo.content.life_data as {goal_id:unknown}).goal_id,null);assert.equal(todo.origin,'stated')
  const repeat=run('life_mutate',{namespace,expectedRevision:0,requestId:'delete',input:{op:'delete',kind:'goal',id:goal.id,expected_version:1}})
  assert.deepEqual(repeat.result,deleted.result);assert.equal(repeat.revision,deleted.revision,'a repeated request id does not write again')
  assert.deepEqual(run('life_load',{namespace}).state.goals,[])
 }finally{db.close()}
})

test('goalCheckinEligible accepts only an existing active goal',()=>{
 const goals=(['active','paused','completed','archived'] as const).map(status=>({id:status,status}))
 assert.deepEqual(goalCheckinEligible({goals},'active'),{eligible:true,reason:'eligible'})
 for(const status of ['paused','completed','archived'])assert.deepEqual(goalCheckinEligible({goals},status),{eligible:false,reason:'goal_not_active'})
 assert.deepEqual(goalCheckinEligible({goals},'missing'),{eligible:false,reason:'goal_not_found'})
 assert.deepEqual(goalCheckinEligible({goals:goals.filter(g=>g.id!=='active')},'active'),{eligible:false,reason:'goal_not_found'},'a deleted goal is no longer eligible')
})

const host=(dir:string)=>new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:ref=>({subject_key:ref,source:{type:'conversation',ref}}),now:()=>now})
const command=async(h:PersonalAgentHost,request_id:string,params:Record<string,unknown>)=>{const r=await h.command({type:'personal.command',request_id,method:'life.mutate',params}) as {ok:boolean;data?:{id:string;version:number};error?:string};assert.equal(r.ok,true,r.error);return r.data!}
const checkin=(goalId:string,key:string):NotificationInput=>({event_key:'goal-checkin:'+key,revision:'1',occurrence:'initial',kind:'suggestion',title:'今天的目标',body:'今天推进了吗？',source:{type:goalCheckinSource,id:goalId},created_at:now.getTime(),expires_at:null,not_before:0,priority:40,coalesce_key:null,feedback:[]})

test('a queued goal check-in is dropped once its goal is paused or deleted',()=>withDir('nova-goal-checkin-',async dir=>{
 const h=host(dir)
 try{await h.open()
  const kept=await command(h,'keep',{op:'create',kind:'goal',title:'保持运动'}),paused=await command(h,'pause-goal',{op:'create',kind:'goal',title:'学吉他'}),deleted=await command(h,'delete-goal',{op:'create',kind:'goal',title:'写小说'})
  for(const g of [kept,paused,deleted])assert.equal(await h.notificationValidity(checkin(g.id,g.id)),'valid')
  for(const g of [kept,paused,deleted])await h.notifications.publish(checkin(g.id,g.id))
  await command(h,'pause',{op:'update',kind:'goal',id:paused.id,expected_version:1,status:'paused'})
  await command(h,'delete',{op:'delete',kind:'goal',id:deleted.id,expected_version:1})
  assert.equal(await h.notificationValidity(checkin(paused.id,'p')),'invalid');assert.equal(await h.notificationValidity(checkin(deleted.id,'d')),'invalid')
  await h.flushNotifications();await h.flushNotifications()
  const sent=h.conversationSnapshot().messages.filter(m=>m.origin==='proactive')
  assert.equal(sent.length,1,'only the active goal check-in is delivered');assert.match(sent[0]!.text,/今天推进了吗/u)
 }finally{await h.close()}
}))

test('goal progress is derived state: shown read-only, stale after a goal edit, cleared on delete, never written by life.mutate',()=>withDir('nova-goal-progress-',async dir=>{
 const h=host(dir)
 try{await h.open()
  const goal=await command(h,'g',{op:'create',kind:'goal',title:'跑完半马'})
  const row={goal_id:goal.id,goal_version:1,summary:'本周跑了 3 次',next_step:'周六长距离 15 公里',last_progress_at:'2026-10-11T08:00:00.000Z',evidence_refs:['conversation:1'],basis_revision:'chat:main:42',updated_at:now.toISOString()}
  await assert.rejects(h.recordGoalProgress({...row,goal_version:2}),/version_conflict/)
  await assert.rejects(h.recordGoalProgress({...row,goal_id:'missing'}),/goal_not_found/)
  await h.recordGoalProgress(row)
  const shown=()=>(h.snapshot().life.goals[0] as {derived_progress?:{summary:string;next_step:string;stale:boolean}}).derived_progress
  assert.deepEqual(shown(),{summary:row.summary,next_step:row.next_step,last_progress_at:row.last_progress_at,stale:false})
  await command(h,'edit',{op:'update',kind:'goal',id:goal.id,expected_version:1,success_criteria:'2 小时内'})
  assert.equal(h.goalProgress(goal.id)!.stale,true);assert.equal(shown()!.stale,true);assert.equal(h.goalProgress(goal.id)!.summary,row.summary,'the record is kept')
  const rejected=await h.command({type:'personal.command',request_id:'smuggle',method:'life.mutate',params:{op:'update',kind:'goal',id:goal.id,expected_version:2,summary:'模型写的进展'}}) as {ok:boolean}
  assert.equal(rejected.ok,false,'progress fields are not part of the life.mutate contract')
  assert.equal('summary' in h.snapshot().life.goals[0]!,false)
  await command(h,'delete',{op:'delete',kind:'goal',id:goal.id,expected_version:2})
  assert.equal(h.goalProgress(goal.id),null)
  assert.deepEqual((JSON.parse(await readFile(join(dir,'personal.json'),'utf8')) as {goal_progress:unknown[]}).goal_progress,[],'the stored record is removed with its goal')
 }finally{await h.close()}
}))
