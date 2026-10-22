import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,realpath,stat,rename,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {TimelineBrief} from '../src/personal-agent/timeline-brief.js'
import {SuggestionPool} from '../src/core/suggestions.js'

test('reading copies follow durable Life changes and survive restart without generation',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'reading-copies-host-'))
 const options={path:join(dir,'personal.json'),readingCopiesDirectory:dir,userScope:'local',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null}
 let host=new PersonalAgentHost(options)
 try{
  await host.open({deferBackground:true})
  const goal=await host.life.mutate({op:'create',kind:'goal',title:'交付阅读副本',success_criteria:'启动后可阅读'},'goal')
  const todo=await host.life.mutate({op:'create',kind:'todo',title:'核对中文 [阅读] <script>',goal_id:goal.id,due:'2026-10-25'},'todo')
  await host.life.mutate({op:'create',kind:'idea',title:'更容易找到历史结果'},'idea')
  await host.life.mutate({op:'profile',expected_version:0,about:'我手写的介绍'},'profile')
  await host.life.mutate({op:'update',kind:'todo',id:todo.id,expected_version:todo.version,status:'done'},'complete')
  await host.close()
  const todos=await readFile(join(dir,'todos.md'),'utf8')
  assert.match(todos,/已完成/);assert.ok(todos.includes(todo.id));assert.ok(todos.includes(goal.id));assert.ok(todos.includes('2026-10-25'))
  assert.ok(!todos.includes('<script>'));assert.ok(todos.includes('核对中文'))
  assert.match(await readFile(join(dir,'profile.md'),'utf8'),/我手写的介绍/)
  assert.match(await readFile(join(dir,'goals.md'),'utf8'),/启动后可阅读/)
  assert.match(await readFile(join(dir,'ideas.md'),'utf8'),/更容易找到历史结果/)
  assert.match(await readFile(join(dir,'timeline.md'),'utf8'),/暂无/)
  assert.equal((await stat(join(dir,'profile.md'))).mode&0o777,0o600)
  const before=(await stat(join(dir,'todos.md'))).mtimeMs
  host=new PersonalAgentHost(options);await host.open({deferBackground:true});await host.close()
  assert.equal((await stat(join(dir,'todos.md'))).mtimeMs,before,'unchanged restarts do not rewrite copies')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('reading a timeline uses the last durable cards when a later save fails',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'reading-timeline-failure-')),path=join(dir,'timeline.json');let fail=false
 const input={id:'im:one',kind:'im',text:'交付成功',version:'1',observed_at:'2026-10-21T01:00:00.000Z'}
 const timeline=new TimelineBrief(path,async()=>{
  if(fail){await rename(path,path+'.saved');await mkdir(path)}
  return {cards:[{category:'进展',title:fail?'未保存的版本':'已保存的版本',why_now:'交付成功',facts:[{text:input.text,quote:input.text,ref:input.id}],uncertainty:'',actions:[],refs:[input.id]}]}
 },()=>{/* no UI */})
 try{
  await timeline.open();timeline.update([input],'2026-10-21','Asia/Shanghai');await timeline.refresh();assert.equal(timeline.snapshot().cards.length,1)
  fail=true;timeline.update([{...input,version:'2'}],'2026-10-21','Asia/Shanghai');await timeline.refresh()
  const persisted=timeline.snapshot(true)
  assert.equal(persisted.cards.some(card=>card.title==='未保存的版本'),false)
  assert.equal(persisted.cards.some(card=>card.title==='已保存的版本'),true)
 }finally{await timeline.close();await rm(dir,{recursive:true,force:true})}
})
