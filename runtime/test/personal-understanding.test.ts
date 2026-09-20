import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalUnderstanding} from '../src/personal-agent/understanding.js'
import {LifeService} from '../src/personal-agent/life.js'
import {understandingFixture} from '../src/understanding/fixture.js'
test('candidate acceptance is explicit, source checked, edited and idempotent',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-candidate-'));const life=new LifeService(join(dir,'life.json'));await life.open();const rows=understandingFixture();let source=rows[0]!.source
 const u=new PersonalUnderstanding({life,source:()=>source,pipeline:()=>Promise.resolve(rows),changed:()=>{/* observer */}})
 try{u.start();await new Promise(r=>setTimeout(r,0));assert.equal(life.snapshot().todos.length,0);assert.equal(u.snapshot().items.length,3)
  const todo=rows.find(r=>r.candidate.kind==='todo')!;await u.action({id:todo.candidate.id,action:'accept',text:'Compare courses'});await u.action({id:todo.candidate.id,action:'accept'});assert.equal(life.snapshot().todos.length,1)
  const profile=rows.find(r=>r.candidate.kind==='profile')!;await u.action({id:profile.candidate.id,action:'accept',expected_profile_version:0});assert.ok(life.snapshot().profile.about.includes('听力'))
  source={...source,text:source.text+'Changed'};const goal=rows.find(r=>r.candidate.kind==='goal')!;await assert.rejects(u.action({id:goal.candidate.id,action:'accept'}),/stale_source/);assert.equal(life.snapshot().goals.length,0)
 }finally{await u.close();await life.close();await rm(dir,{recursive:true,force:true})}
})
