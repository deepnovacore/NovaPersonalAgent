import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DailyWorkbench} from '../src/personal-agent/daily-workbench.js'
import {LifeService} from '../src/personal-agent/life.js'
import {automaticWorkbenchMatter,workbenchExistingCandidates,type WorkbenchGenerator,type WorkbenchRequest,type WorkbenchMatter} from '../src/personal-agent/workbench-evidence.js'
import type {TimelineInput} from '../src/personal-agent/timeline-brief.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'

const input=(id='m1'):TimelineInput=>({id,version:'1',text:'我会整理发布材料。长期目标是让助手成为每日工作入口。',kind:'im',group:'chat:a',relation:'self',author:{key:'me',kind:'person',is_user:true},observed_at:'2026-10-18T01:00:00Z'})
const matter=(i:TimelineInput,kind:'todo'|'goal'|'topic'='todo')=>({kind,title:kind==='goal'?'助手成为每日工作入口':'整理发布材料',summary:'准备本轮发布',ownership:'user' as const,assertion:'direct' as const,state:'open' as const,due:null,due_quote:null,refs:[{entry_id:i.id,version:i.version,quote:i.text}]})
const generate:WorkbenchGenerator=request=>Promise.resolve(request.phase==='reconcile'?{groups:request.matters.map(m=>({members:[m.id],state:m.state,current:m.id,basis:[m.id]}))}:request.phase==='extract'?{matters:request.inputs.flatMap(i=>[matter(i),matter(i,'goal'),matter(i,'topic')])}:{matches:request.matters.filter(m=>m.kind!=='topic').map(m=>({matter_id:m.id,target_id:request.existing.find(e=>e.kind===m.kind)?.id??null,same_as:null,capture:'record'})),suggestions:[{tab:'ideas',title:'先做一个发布预检清单',body:'可以把发布检查变成一键预检，减少重复操作。',why:null,next:null,matter_ids:[request.matters[0]!.id]}]})
async function fixture(run:(f:{daily:DailyWorkbench;life:LifeService;setInputs:(i:TimelineInput[])=>void;nextDay:()=>void;calls:string[];reads:()=>number;failure:()=>Promise<string|null>;reopen:()=>Promise<void>})=>Promise<void>,generator:(r:Exclude<WorkbenchRequest,{phase:'reconcile'}>,s:AbortSignal)=>Promise<unknown>=generate,reconcile:WorkbenchGenerator=generate){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'daily-workbench-'));const life=new LifeService(join(dir,'life.json'));await life.open()
 let inputs=[input()],now=new Date('2026-10-18T03:00:00Z');const calls:string[]=[];let reads=0
 const daily=new DailyWorkbench({path:join(dir,'daily.json'),life:()=>life,inputs:()=>{reads++;return Promise.resolve(inputs)},timezone:()=>'Asia/Shanghai',now:()=>now,ready:()=>true,changed:()=>undefined,generate:async(r,s)=>{calls.push(r.phase);return r.phase==='reconcile'?reconcile(r,s):generator(r,s)}})
 await daily.open()
 try{await run({daily,life,setInputs:i=>{inputs=i},nextDay:()=>{now=new Date(now.getTime()+86400000)},calls,reads:()=>reads,failure:async()=>(JSON.parse(await readFile(join(dir,'daily.json'),'utf8')) as {failure:string|null}).failure,reopen:async()=>{await daily.close();await daily.open()}})}finally{await daily.close();await life.close();await rm(dir,{recursive:true,force:true})}
}
test('one shared run records explicit todos/goals and produces grounded inspiration',()=>fixture(async({daily,life,calls})=>{
 await daily.refresh(true);assert.equal(daily.snapshot().error,null);assert.equal(life.snapshot().todos.length,1);assert.equal(life.snapshot().goals.length,1)
 assert.equal(life.snapshot().todos[0]!.auto_recorded,true);assert.equal(daily.snapshot().cards[0]!.tab,'ideas');assert.deepEqual(calls,['extract','reconcile','compose'])
 await daily.refresh();assert.equal(calls.length,3);await daily.adopt(daily.snapshot().cards[0]!.id);assert.equal(life.snapshot().ideas.length,1)
}))
test('daily attempt survives restart; manual refresh only extracts changed batches',()=>fixture(async({daily,setInputs,calls,reopen,nextDay})=>{
 await daily.refresh(true);await reopen();setInputs([input(),{...input('m2'),group:'chat:b'}]);await daily.refresh(true);assert.equal(calls.length,3)
 await daily.refresh();assert.equal(calls.filter(c=>c==='extract').length,2);assert.equal(daily.snapshot().diagnostics.cache_hits,1)
 nextDay();await daily.refresh(true);assert.equal(calls.filter(c=>c==='extract').length,2)
}))
test('undo suppresses recreation after restart and paraphrased evidence',()=>fixture(async({daily,life,reopen,setInputs})=>{
 await daily.refresh();const id=life.snapshot().goals[0]!.id;await daily.undo(id);assert.equal(life.snapshot().goals.length,0)
 await reopen();setInputs([input(),{...input('m2'),text:'我会继续整理发布材料。长期目标是让助手成为每日工作入口。'}]);await daily.refresh();assert.equal(life.snapshot().goals.length,0)
}))
test('source withdrawal hides suggestions and cannot create new objects',()=>fixture(async({daily,life,setInputs})=>{
 await daily.refresh();const cards=daily.snapshot().cards;setInputs([]);await daily.sync();assert.equal(daily.snapshot().cards.length,0)
 await assert.rejects(daily.adopt(cards[0]!.id),/card_not_found/);assert.equal(life.snapshot().ideas.length,0)
}))
test('failed automatic attempt does not repeat; extraction cache survives composition failure',async()=>{
 let fail=true
 await fixture(async({daily,calls})=>{await daily.refresh(true);assert.equal(daily.snapshot().status,'failed');const n=calls.length;await daily.refresh(true);assert.equal(calls.length,n);fail=false;await daily.refresh();assert.equal(calls.filter(c=>c==='extract').length,1);assert.equal(daily.snapshot().status,'ready')},async(r,s)=>{if(r.phase==='compose'&&fail)throw Error('offline');return generate(r,s)})
})
test('invalid evidence and forwarded/other/completed statements cannot auto-record',()=>{
 const i=input(),m:WorkbenchMatter={...matter(i),id:'a',group:'c'}
 assert.equal(automaticWorkbenchMatter(m,[i]),true)
 for(const patch of [{ownership:'other' as const},{assertion:'forwarded' as const},{state:'completed' as const},{refs:[{entry_id:'unknown',version:'1',quote:i.text}]}])assert.equal(automaticWorkbenchMatter({...m,...patch},[i]),false)
 assert.equal(automaticWorkbenchMatter({...m,kind:'goal'},[{...i,relation:'addressed',author:{key:'other',kind:'person',is_user:false}}]),false)
})
test('identity candidates include completed and undone records without disclosing unrelated long notes',()=>{
 const m:WorkbenchMatter={...matter(input()),id:'a',group:'c'},rows=workbenchExistingCandidates([m],[{id:'old',kind:'todo',title:m.title,note:'x'.repeat(1000),status:'cancelled',version:1}])
 assert.equal(rows[0]!.id,'old');assert.equal(rows[0]!.note.length,300)
})

test('concurrent refreshes coalesce and user edits prevent undo',()=>fixture(async({daily,life,calls})=>{
 await Promise.all([daily.refresh(),daily.refresh()]);assert.deepEqual(calls,['extract','reconcile','compose'])
 const goal=life.snapshot().goals[0]!;await life.mutate({op:'update',kind:'goal',id:goal.id,expected_version:1,title:'我的修改'},'edit')
 await assert.rejects(daily.undo(goal.id),/version_conflict/);assert.equal(life.snapshot().goals[0]!.title,'我的修改')
}))

test('source withdrawal during composition cancels automatic persistence',async()=>{
 let withdraw=()=>undefined
 await fixture(async({daily,life,setInputs})=>{withdraw=()=>{setInputs([])};await daily.refresh();assert.equal(life.snapshot().todos.length,0);assert.equal(life.snapshot().goals.length,0)},async(r,s)=>{const result=await generate(r,s);if(r.phase==='compose')withdraw();return result})
})

test('host wires the shared generator and rejects direct automatic write injection',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'daily-workbench-host-'))
 const memory={timelineEvidence:()=>Promise.resolve([input()])} as unknown as PersonalMemoryResource
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'local',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,generateWorkbench:generate})
 host.setSources({list:()=>[{scope:'computer',scan_pending:true,indexed:2000}],command:()=>Promise.resolve({})})
 try{await host.open();await host.workbenchContext.refresh();assert.equal(host.snapshot().life.todos.length,1);assert.equal(host.snapshot().life.goals.length,1)
  const result=await host.command({type:'personal.command',request_id:'forged',method:'life.mutate',params:{op:'from_workbench'}})
  assert.equal((result as {ok:boolean}).ok,false)
  const card=host.snapshot().workbench_context.cards[0]!
  await host.command({type:'personal.command',request_id:'adopt-idea',method:'context.adopt',params:{id:card.id}})
  assert.equal(host.snapshot().life.ideas.length,1)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('two commitments in one quote retain separate identities',()=>fixture(async({daily,life})=>{
 await daily.refresh();assert.equal(daily.snapshot().error,null);assert.deepEqual(life.snapshot().todos.map(t=>t.title),['整理发布材料','准备演示'])
},(r,s)=>r.phase==='extract'?Promise.resolve({matters:[matter(r.inputs[0]!),{...matter(r.inputs[0]!),title:'准备演示'}]}):generate(r,s)))

test('dated explicit goals preserve the date in notes without a todo-only due field',()=>fixture(async({daily,life,setInputs})=>{
 setInputs([{...input(),text:'我的长期目标是在 2026-12-31 前做到每日使用。'}]);await daily.refresh();assert.equal(daily.snapshot().error,null)
 assert.equal(life.snapshot().goals.length,1);assert.match(life.snapshot().goals[0]!.note,/2026-12-31/)
},(r,s)=>r.phase==='extract'?Promise.resolve({matters:[{...matter(r.inputs[0]!,'goal'),due:'2026-12-31',due_quote:'2026-12-31'}]}):generate(r,s)))

test('zero-overlap paraphrase still checks durable undo identities before adding',async()=>{
 let revised=false,identityCalls=0
 await fixture(async({daily,life,setInputs})=>{
  await daily.refresh();await daily.undo(life.snapshot().todos[0]!.id);revised=true
  setInputs([{...input('new'),text:'交周报'}]);await daily.refresh();assert.equal(daily.snapshot().error,null);assert.equal(life.snapshot().todos.length,0);assert.ok(identityCalls>0)
 },(r,s)=>{
  if(r.phase==='extract')return Promise.resolve({matters:[{...matter(r.inputs[0]!),title:revised?'交周报':'提交报告',summary:revised?'交周报':'提交报告'}]})
  if(r.identity_only)identityCalls++
  return generate(r,s)
 })
})

test('source notification hides pending cards but a no-change refresh preserves the shared result',()=>fixture(async({daily,calls})=>{
 await daily.refresh();daily.suspend();assert.equal(daily.snapshot().cards.length,0);await daily.sync();assert.equal(daily.snapshot().cards.length,1)
 await daily.refresh();assert.deepEqual(calls,['extract','reconcile','compose'])
}))

test('host waits for the first successful selected-chat sync before shared generation',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'daily-workbench-sync-'));let lastSync:string|undefined,calls=0
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'local',memory:()=>({timelineEvidence:()=>Promise.resolve([input()])}) as unknown as PersonalMemoryResource,pool:new SuggestionPool(),evidence:()=>null,generateWorkbench:(r,s)=>{calls++;return generate(r,s)}})
 host.setFeishu({open:()=>Promise.resolve(),close:()=>Promise.resolve(),snapshot:()=>({state:'ready',chats:[{selected:true}],last_sync:lastSync}),command:()=>Promise.resolve({})})
 try{await host.open();await host.workbenchContext.refresh();assert.equal(calls,0);lastSync=new Date().toISOString();await host.workbenchContext.refresh();assert.equal(calls,3)}finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('workbench writer includes the schema for gateways using JSON-object mode',async()=>{
 const {createWorkbenchGenerator}=await import('../src/model/workbench-writer.js')
 const writer=createWorkbenchGenerator({stream:()=>{throw Error('unused')},complete:request=>{const prompt=JSON.parse(request.prompt) as {output_schema:unknown};assert.deepEqual(prompt.output_schema,request.jsonSchema);return Promise.resolve({text:'{"matters":[]}'})}},'model')
 await writer({phase:'extract',inputs:[input()],previous:[],date:'2026-10-18',timezone:'Asia/Shanghai'},new AbortController().signal)
})

test('small source batches share extraction while preserving incremental caches',()=>fixture(async({daily,setInputs,calls})=>{
 const rows=Array.from({length:8},(_,i)=>({...input('m'+i),group:'chat:'+i}));setInputs(rows)
 await daily.refresh();assert.equal(daily.snapshot().error,null);assert.equal(calls.filter(c=>c==='extract').length,1)
 setInputs(rows.map((r,i)=>i===0?{...r,version:'2'}:r));await daily.refresh()
 assert.equal(calls.filter(c=>c==='extract').length,2);assert.equal(daily.snapshot().diagnostics.cache_hits,7)
}))

test('a malformed extracted item does not discard other strictly validated evidence',()=>fixture(async({daily,life})=>{
 await daily.refresh();assert.equal(daily.snapshot().error,null);assert.equal(life.snapshot().todos.length,1);assert.equal(daily.snapshot().diagnostics.rejected,1)
},(r,s)=>r.phase==='extract'?Promise.resolve({matters:[matter(r.inputs[0]!),{...matter(r.inputs[0]!,'goal'),title:'x'.repeat(161)}]}):generate(r,s)))

test('malformed inspiration is filtered without weakening automatic identity validation',()=>fixture(async({daily,life})=>{
 await daily.refresh();assert.equal(daily.snapshot().error,null);assert.equal(life.snapshot().todos.length,1);assert.equal(daily.snapshot().cards.length,0);assert.equal(daily.snapshot().diagnostics.rejected,1)
},async(r,s)=>{const result=await generate(r,s);return r.phase==='extract'?result:{...(result as object),suggestions:[{tab:'ideas',title:'x'.repeat(81),body:'body',why:null,next:null,matter_ids:[r.matters[0]!.id]}]}}))

test('extra topic matches cannot block or authorize automatic records',()=>fixture(async({daily,life})=>{
 await daily.refresh();assert.equal(daily.snapshot().error,null);assert.equal(life.snapshot().todos.length,1)
},async(r,s)=>{const result=await generate(r,s) as {matches:unknown[]};return r.phase==='extract'?result:{...result,matches:[...result.matches,...r.matters.filter(m=>m.kind==='topic').map(m=>({matter_id:m.id,target_id:null,same_as:null,capture:'record'}))]}}))

for(const reason of ['count','duplicate_matter','unknown_matter','invalid_target','invalid_same_as'] as const)test('invalid matches fail closed with a bounded diagnostic: '+reason,()=>fixture(async({daily,life,failure})=>{
 await daily.refresh();assert.equal(daily.snapshot().error,'invalid_workbench_matches');assert.equal(life.snapshot().todos.length,0);assert.equal(life.snapshot().goals.length,0);assert.equal(daily.snapshot().cards.length,0)
 assert.equal(await failure(),'invalid_workbench_matches_'+reason)
},async(r,s)=>{
 const result=await generate(r,s) as {matches:{matter_id:string;target_id:string|null;same_as:string|null}[]}
 if(r.phase==='extract')return result
 if(reason==='count')result.matches.pop()
 if(reason==='duplicate_matter')result.matches[1]!.matter_id=result.matches[0]!.matter_id
 if(reason==='unknown_matter')result.matches[0]!.matter_id='untrusted-model-id'
 if(reason==='invalid_target')result.matches[0]!.target_id='untrusted-model-id'
 if(reason==='invalid_same_as')result.matches[0]!.same_as=result.matches[0]!.matter_id
 return result
}))

test('composition uses compact identifiers and restores only known identities',async()=>{
 const {createWorkbenchGenerator}=await import('../src/model/workbench-writer.js')
 const writer=createWorkbenchGenerator({stream:()=>{throw Error('unused')},complete:request=>{
  const p=JSON.parse(request.prompt) as {matters:{id:string}[];existing:{id:string}[];required_match_ids:string[]};assert.equal(p.matters[0]!.id,'m0');assert.equal(p.existing[0]!.id,'e0');assert.deepEqual(p.required_match_ids,['m0'])
  return Promise.resolve({text:JSON.stringify({matches:[{matter_id:'m0',target_id:'e0',same_as:null,capture:'skip'}],suggestions:[{tab:'ideas',title:'标题',body:'建议',why:null,next:null,matter_ids:['m0','unknown']}]})})
 }},'model')
 const result=await writer({phase:'compose',matters:[{...matter(input()),id:'long-matter',group:'chat:a'}],existing:[{id:'long-existing',kind:'todo',title:'标题',note:'',status:'open',version:1}],date:'2026-10-18',timezone:'Asia/Shanghai'},new AbortController().signal) as {matches:{matter_id:string;target_id:string}[];suggestions:{matter_ids:string[]}[]}
 assert.equal(result.matches[0]!.matter_id,'long-matter');assert.equal(result.matches[0]!.target_id,'long-existing');assert.deepEqual(result.suggestions[0]!.matter_ids,['long-matter','invalid:unknown'])
})

test('skipped matches do not reread the complete source pool per item',()=>fixture(async({daily,life,reads})=>{
 await daily.refresh();assert.equal(daily.snapshot().error,null);assert.equal(life.snapshot().todos.length,0);assert.ok(reads()<10)
},request=>Promise.resolve(request.phase==='extract'?{matters:Array.from({length:20},(_,i)=>({...matter(request.inputs[0]!),title:'已完成事项'+i}))}:{matches:request.matters.map(m=>({matter_id:m.id,target_id:null,same_as:null,capture:'skip'})),suggestions:[]})))

test('later model failure preserves already validated suggestion batches',async()=>{
 let compositions=0
 await fixture(async({daily})=>{await daily.refresh();assert.equal(daily.snapshot().status,'failed');assert.equal(daily.snapshot().cards.length,1);assert.equal(daily.snapshot().updated_at,null)},request=>{
  if(request.phase==='extract')return Promise.resolve({matters:Array.from({length:50},(_,i)=>({...matter(request.inputs[0]!,'topic'),title:'主题'+i,summary:'内容'.repeat(200)}))})
  if(++compositions>1)throw Error('upstream_unavailable')
  return Promise.resolve({matches:[],suggestions:[{tab:'ideas',title:'先验证一个方向',body:'建议先做一次小实验。',why:null,next:null,matter_ids:[request.matters[0]!.id]}]})
 })
})

test('a failed composition batch does not prevent later batches from producing suggestions',async()=>{
 let compositions=0
 await fixture(async({daily})=>{await daily.refresh();assert.equal(daily.snapshot().status,'failed');assert.ok(compositions>1);assert.equal(daily.snapshot().cards.length,1)},request=>{
  if(request.phase==='extract')return Promise.resolve({matters:Array.from({length:50},(_,i)=>({...matter(request.inputs[0]!,'topic'),title:'主题'+i,summary:'内容'.repeat(200)}))})
  if(++compositions===1)throw Error('upstream_unavailable')
  return Promise.resolve({matches:[],suggestions:[{tab:'ideas',title:'保留成功批次',body:'建议先做一次小实验。',why:null,next:null,matter_ids:[request.matters[0]!.id]}]})
 })
})

test('cross-date completion as topic prevents stale todos and produces a versioned update',async()=>{
 const groupAll:WorkbenchGenerator=r=>r.phase==='reconcile'?Promise.resolve({groups:[{members:r.matters.map(m=>m.id),state:r.matters.some(m=>m.state==='completed')?'completed':'open',current:r.matters.at(-1)!.id,basis:[r.matters.at(-1)!.id]}]}):generate(r,new AbortController().signal)
 const extract:WorkbenchGenerator=(r,s)=>r.phase==='extract'?Promise.resolve({matters:r.inputs.map(i=>i.id==='done'?{...matter(i,'topic'),state:'completed'}:matter(i))}):generate(r,s)
 await fixture(async({daily,life,setInputs,calls})=>{
  const old={...input('old'),observed_at:'2026-10-04T01:00:00Z'}
  setInputs([old]);await daily.refresh();assert.equal(life.snapshot().todos.length,1)
  setInputs([old,{...input('done'),group:'another-chat',text:'发布材料已整理完成。'}]);await daily.refresh()
  assert.equal(life.snapshot().todos.length,1);assert.equal(life.snapshot().todos[0]!.status,'open')
  const update=daily.snapshot().cards.find(c=>c.update);assert.ok(update);assert.equal(update.update!.status,'done')
  await daily.adopt(update.id);assert.equal(life.snapshot().todos.length,1);assert.equal(life.snapshot().todos[0]!.status,'done')
  const n=calls.length;await daily.refresh();assert.equal(calls.length,n)
 },extract,groupAll)
})
test('late completion across three dates is never auto-saved even if compose asks to record',()=>fixture(async({daily,life,setInputs})=>{
 setInputs([{...input('old'),observed_at:'2026-10-04T00:00:00Z'},{...input('progress'),observed_at:'2026-10-11T00:00:00Z'},input('done')]);await daily.refresh();assert.equal(daily.snapshot().error,null);assert.equal(life.snapshot().todos.length,0)
},(r,s)=>r.phase==='extract'?Promise.resolve({matters:r.inputs.map(i=>({...matter(i),state:i.id==='done'?'completed':'open'}))}):generate(r,s),r=>Promise.resolve(r.phase==='reconcile'?{groups:[{members:r.matters.map(m=>m.id),state:'completed',current:r.matters.at(-1)!.id,basis:[r.matters.at(-1)!.id]}]}:{})))
test('failed or incomplete global reconciliation cannot save a partial old commitment',()=>fixture(async({daily,life})=>{
 await daily.refresh();assert.equal(daily.snapshot().status,'failed');assert.equal(life.snapshot().todos.length,0)
},generate,()=>Promise.resolve({groups:[]})))
test('status update rejects concurrent user editing without creating a new todo',()=>fixture(async({daily,life,setInputs})=>{
 await life.mutate({op:'create',kind:'todo',title:'整理发布材料'},'existing')
 setInputs([input('done')]);await daily.refresh();const card=daily.snapshot().cards.find(c=>c.update);assert.ok(card)
 const todo=life.snapshot().todos[0]!;await life.mutate({op:'update',kind:'todo',id:todo.id,expected_version:todo.version,note:'用户更正'},'edit')
 await assert.rejects(daily.adopt(card.id),/version_conflict/);assert.equal(life.snapshot().todos.length,1);assert.equal(life.snapshot().todos[0]!.note,'用户更正')
},(r,s)=>r.phase==='extract'?Promise.resolve({matters:[{...matter(r.inputs[0]!),state:'completed'}]}):generate(r,s)))

test('a new source hides old actionable suggestions until temporal coverage is refreshed',()=>fixture(async({daily,life,setInputs})=>{
 await life.mutate({op:'create',kind:'todo',title:'整理发布材料'},'existing')
 await daily.refresh();const card=daily.snapshot().cards.find(c=>c.update);assert.ok(card)
 setInputs([input(),input('newer')]);await daily.sync();assert.equal(daily.snapshot().cards.some(c=>c.id===card.id),false)
 await assert.rejects(daily.adopt(card.id));assert.equal(life.snapshot().todos[0]!.status,'open')
},(r,s)=>r.phase==='extract'?Promise.resolve({matters:[{...matter(r.inputs[0]!),state:'completed'}]}):generate(r,s)))

test('status updates beyond the visible three remain available after the first is dismissed',()=>fixture(async({daily,life})=>{
 for(let i=0;i<4;i++)await life.mutate({op:'create',kind:'todo',title:'交付'+i},'existing'+i)
 await daily.refresh();assert.equal(daily.snapshot().cards.filter(c=>c.update).length,4)
 await daily.dismiss(daily.snapshot().cards[0]!.id);assert.equal(daily.snapshot().cards.filter(c=>c.update).length,3)
},r=>Promise.resolve(r.phase==='extract'?{matters:Array.from({length:4},(_,i)=>({...matter(r.inputs[0]!),title:'交付'+i,state:'completed'}))}:{matches:r.matters.map(m=>({matter_id:m.id,target_id:r.existing.find(e=>e.title===m.title)!.id,same_as:null,capture:'skip'})),suggestions:[]})))

test('state reads do not queue shared refresh behind a slow memory projection',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'daily-state-responsive-'))
 let slow=false,reads=0,release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 const memory={timelineEvidence:()=>Promise.resolve([input()]),list:async()=>{if(slow){reads++;await gate}return {entries:[],cursor:null}}} as unknown as PersonalMemoryResource
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'local',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,generateWorkbench:generate})
 try{
  await host.open();slow=true
  const state=host.command({type:'personal.command',request_id:'slow-state',method:'state',params:{}})
  const result=await Promise.race([state,new Promise(resolve=>setTimeout(()=>resolve('blocked'),500))])
  assert.notEqual(result,'blocked','cached state must remain readable during background memory refresh')
  await host.command({type:'personal.command',request_id:'second-state',method:'state',params:{}})
  const refresh=await host.command({type:'personal.command',request_id:'shared-refresh',method:'context.refresh',params:{}}) as {ok:boolean}
  assert.equal(refresh.ok,true)
  assert.ok(reads<=1,'concurrent state reads share one background refresh')
 }finally{release();await host.close();await rm(dir,{recursive:true,force:true})}
})

test('shared generation waits for the first complete memory projection after deferred startup',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'daily-memory-ready-'))
 let release!:()=>void,started!:()=>void,calls=0
 const gate=new Promise<void>(resolve=>{release=resolve}),loading=new Promise<void>(resolve=>{started=resolve})
 const memory={timelineEvidence:()=>Promise.resolve([input()]),list:async()=>{started();await gate;return {entries:[],cursor:null}}} as unknown as PersonalMemoryResource
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'local',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,generateWorkbench:(r,s)=>{calls++;return generate(r,s)}})
 try{
  await host.open({deferBackground:true});host.startBackgroundWork();await loading
  await host.workbenchContext.refresh();assert.equal(calls,0,'partial startup sources cannot start a paid generation')
  release();await host.refreshMemory();await host.workbenchContext.refresh();assert.ok(calls>0)
 }finally{release();await host.close();await rm(dir,{recursive:true,force:true})}
})

test('incomplete startup input does not erase cached generation, but ready withdrawals still invalidate it',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'daily-startup-cache-'))
 const life=new LifeService(join(dir,'life.json'));await life.open()
 let ready=true,inputs=[input()],calls=0
 const options={path:join(dir,'daily.json'),life:()=>life,inputs:()=>Promise.resolve(inputs),timezone:()=>'Asia/Shanghai',now:()=>new Date('2026-10-18T03:00:00Z'),ready:()=>ready,inputsReady:()=>ready,changed:()=>undefined,generate:((r,s)=>{calls++;return generate(r,s)}) as WorkbenchGenerator}
 let daily=new DailyWorkbench(options)
 try{
  await daily.open();await daily.refresh();assert.equal(daily.snapshot().status,'ready');await daily.close()
  const previousCalls=calls;ready=false;inputs=[];daily=new DailyWorkbench(options);await daily.open({deferGeneration:true});daily.startGeneration();await daily.sync();await daily.refresh()
  assert.equal(daily.snapshot().cards.length,0,'unloaded sources cannot expose cached cards')
  ready=true;inputs=[input()];await daily.refresh()
  assert.equal(calls,previousCalls,'loading the unchanged full source set must reuse the completed cache')
  assert.equal(daily.snapshot().status,'ready');assert.ok(daily.snapshot().cards.length)
  inputs=[];await daily.sync();assert.equal(daily.snapshot().cards.length,0,'a real withdrawal after startup must still hide stale cards')
 }finally{await daily.close();await life.close();await rm(dir,{recursive:true,force:true})}
})

test('automatic recording waits for its source revalidation before keeping batch suggestions',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'daily-record-revalidate-'))
 const life=new LifeService(join(dir,'life.json'),()=>daily.suspend());await life.open()
 const daily=new DailyWorkbench({path:join(dir,'daily.json'),life:()=>life,inputs:()=>Promise.resolve([input()]),timezone:()=>'Asia/Shanghai',now:()=>new Date('2026-10-18T03:00:00Z'),ready:()=>true,changed:()=>undefined,generate})
 try{await daily.open();await daily.refresh();assert.equal(life.snapshot().todos.length,1);assert.equal(daily.snapshot().status,'ready');assert.equal(daily.snapshot().cards.filter(c=>c.tab==='ideas').length,1,'own record notification must not discard otherwise grounded inspiration')}
 finally{await daily.close();await life.close();await rm(dir,{recursive:true,force:true})}
})

test('inferred records pushing stated memory to a later UI page do not change shared generation inputs',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'daily-stated-pages-'))
 let paginated=false,calls=0
 const entry={id:'stated-memory',version:1,content:input().text,kind:'fact',origin:'stated',source_refs:[{type:'conversation',ref:'own',observed_at:input().observed_at}],evidence_refs:['own-evidence'],observed_at:input().observed_at,recorded_at:input().observed_at,topic:'',status:'active',corrected_to:null,confidence_note:null}
 const memory={timelineEvidence:()=>Promise.resolve([input()]),canProcessEvidence:()=>Promise.resolve(true),getMany:(ids:readonly string[])=>Promise.resolve(ids.map(id=>id===entry.id?entry:null)),list:(options?:{cursor?:string})=>Promise.resolve(!paginated||options?.cursor==='next'?{entries:[entry],cursor:null}:{entries:[],cursor:'next'})} as unknown as PersonalMemoryResource
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'local',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,generateWorkbench:(r,s)=>{calls++;return generate(r,s)}})
 try{await host.open();await host.workbenchContext.refresh();assert.equal(host.workbenchContext.snapshot().status,'ready');const previous=calls;paginated=true;await host.refreshMemory();await host.workbenchContext.refresh();assert.equal(calls,previous,'UI pagination must not cause a paid re-extraction or recomposition')}
 finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('suggestions cannot expose compact model references unless the source actually uses that identifier',()=>fixture(async({daily,setInputs})=>{
 await daily.refresh();assert.equal(daily.snapshot().cards.length,0,'model-only compact identifiers must not leak into product copy')
 setInputs([{...input(),version:'2',text:'我会整理发布材料，接口型号为 m0。'}]);await daily.refresh();assert.equal(daily.snapshot().cards.length,1,'real source identifiers remain usable')
},r=>Promise.resolve(r.phase==='extract'?{matters:[matter(r.inputs[0]!,'topic')]}:{matches:[],suggestions:[{tab:'ideas',title:'整理接口说明',body:'参考 m0 的资料编写说明。',why:null,next:null,matter_ids:[r.matters[0]!.id]}]})))
