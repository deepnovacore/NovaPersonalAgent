import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {LifeService} from '../src/personal-agent/life.js'
test('five-tab objects persist, conversion is idempotent, links and versions are enforced',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-life-'));let life=new LifeService(join(dir,'life.json'))
 await life.open()
 try{
  const idea=await life.mutate({op:'create',kind:'idea',title:'Learn Japanese',note:'For travel'},'one')
  const goal=await life.mutate({op:'convert',id:idea.id,target:'goal',expected_version:idea.version},'two')
  assert.equal((await life.mutate({op:'convert',id:idea.id,target:'goal',expected_version:idea.version},'three')).id,goal.id)
  const todo=await life.mutate({op:'create',kind:'todo',title:'First lesson',goal_id:goal.id},'four')
  assert.equal(life.snapshot().goals[0]!.progress.total,1)
  await life.mutate({op:'update',kind:'todo',id:todo.id,expected_version:todo.version,status:'done'},'five')
  assert.equal(life.snapshot().goals[0]!.progress.done,1);assert.equal(life.snapshot().goals[0]!.status,'active')
  await assert.rejects(life.mutate({op:'update',kind:'todo',id:todo.id,expected_version:todo.version,title:'Stale'},'six'),/version_conflict/)
  await assert.rejects(life.mutate({op:'create',kind:'todo',title:'Bad link',goal_id:'missing'},'seven'),/goal_not_found/)
  await life.mutate({op:'profile',expected_version:0,about:'I like language learning'},'eight')
  life=new LifeService(join(dir,'life.json'));await life.open();assert.equal(life.snapshot().profile.about,'I like language learning');assert.equal(life.snapshot().todos[0]!.status,'done')
 }finally{await rm(dir,{recursive:true,force:true})}
})
