import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {TimelineBrief,type TimelineInput} from '../src/personal-agent/timeline-brief.js'
const input:TimelineInput={id:'message',version:'v1',kind:'im',text:'Synthetic node is still down',observed_at:'2026-10-17T01:00:00Z',relation:'participant'}
const reply={cards:[{category:'需要关注',title:'Check the node',why_now:'Repeated alert needs checking',facts:[{text:'The node is down',quote:'node is still down',ref:'message'}],uncertainty:'No recovery confirmed',actions:[{label:'Draft a question',kind:'draft' as const}],refs:['message']}]}
test('timeline uses ordinary evidence, caches across restart, hides changed evidence and rejects ungrounded facts',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-brief-'));let calls=0
 const make=()=>new TimelineBrief(join(dir,'timeline.json'),()=>{calls++;return Promise.resolve(reply)},()=>undefined)
 let brief=make()
 try{
  await brief.open();brief.update([input],'2026-10-17','Asia/Shanghai');assert.equal(calls,0,'update does not wait for generation')
  await brief.refresh();assert.equal(brief.snapshot().cards.length,1);assert.equal(calls,1)
  await brief.close();brief=make();await brief.open();brief.update([input],'2026-10-17','Asia/Shanghai');assert.equal(brief.snapshot().cards.length,1);assert.equal(calls,1)
  brief.update([{...input,version:'v2',text:'recovered'}],'2026-10-17','Asia/Shanghai');assert.equal(brief.snapshot().cards.length,0)
  await brief.refresh();assert.equal(brief.snapshot().cards.length,0,'quote from the old source is not evidence')
  assert.equal(brief.snapshot().diagnostics?.host_dropped.unsupported_quote,1)
  assert.equal(brief.snapshot().diagnostics?.published,0)
  brief.update([],'2026-10-17','Asia/Shanghai');assert.equal(brief.snapshot().cards.length,0)
 }finally{await brief.close();await rm(dir,{recursive:true,force:true})}
})
test('timeline drops a late model result after revocation and close cancels non-cooperative generation',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-revoke-'));let release!:(value:typeof reply)=>void
 const brief=new TimelineBrief(join(dir,'timeline.json'),()=>new Promise(resolve=>{release=resolve}),()=>undefined)
 try{
  await brief.open();brief.update([input],'2026-10-17','Asia/Shanghai');const run=brief.refresh()
  while(!release)await new Promise(resolve=>setTimeout(resolve,1))
  brief.update([],'2026-10-17','Asia/Shanghai');release(reply);await run;assert.equal(brief.snapshot().cards.length,0)
  brief.update([input],'2026-10-17','Asia/Shanghai');release=undefined as unknown as typeof release;const hanging=brief.refresh()
  while(!release)await new Promise(resolve=>setTimeout(resolve,1))
  await brief.close();await hanging
 }finally{await brief.close();await rm(dir,{recursive:true,force:true})}
})

test('briefing retains evidence time across days and omits static background or fabricated dates',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-time-cache-'))
 const card=reply.cards[0]!
 const brief=new TimelineBrief(join(dir,'timeline.json'),()=>Promise.resolve({cards:[
  {...card,temporal:{kind:'synthesis',dates:[]}},
  {...card,title:'Static background',temporal:{kind:'background',dates:[]}},
  {...card,title:'Invented date',temporal:{kind:'event',dates:[{role:'occurred',date:'2026-10-17',ref:input.id,quote:input.text}]}},
 ]}),()=>undefined)
 try{
  await brief.open();brief.update([{...input,observed_at:'2026-10-12T18:00:00Z'}],'2026-10-17','Asia/Shanghai');await brief.refresh()
  assert.equal(brief.snapshot().cards.length,1);assert.equal(brief.snapshot().cards[0]!.time.anchor_date,'2026-10-13')
  brief.update([{...input,observed_at:'2026-10-12T18:00:00Z'}],'2026-10-18','Asia/Shanghai');await brief.refresh()
  assert.equal(brief.snapshot().cards[0]!.time.anchor_date,'2026-10-13');assert.equal(brief.snapshot().cards[0]!.time.as_of,'2026-10-18')
 }finally{await brief.close();await rm(dir,{recursive:true,force:true})}
})

test('timeline distinguishes pending generation, timeout, and an actual empty result',async(t)=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-status-'))
 const controller=new AbortController();t.mock.method(AbortSignal,'timeout',()=>controller.signal)
 const brief=new TimelineBrief(join(dir,'timeline.json'),()=>new Promise(()=>{/* This fixture deliberately has no side effects. */}),()=>undefined)
 try{
  await brief.open();brief.update([input],'2026-10-17','Asia/Shanghai')
  assert.equal(brief.snapshot().status,'queued')
  const run=brief.refresh();controller.abort(new DOMException('Timed out','TimeoutError'));await run
  assert.equal(brief.snapshot().status,'failed');assert.equal(brief.snapshot().error,'timeline_generation_timeout')
 }finally{await brief.close();await rm(dir,{recursive:true,force:true})}
})

test('superseded generation restarts after debounce instead of a five minute failure backoff',async(t)=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-reschedule-'));let calls=0
 const brief=new TimelineBrief(join(dir,'timeline.json'),()=>++calls===1?new Promise(()=>{/* This fixture deliberately has no side effects. */}):Promise.resolve({cards:[]}),()=>undefined)
 try{
  await brief.open();brief.update([input],'2026-10-17','Asia/Shanghai');const old=brief.refresh()
  while(calls===0)await new Promise(resolve=>setImmediate(resolve))
  t.mock.timers.enable({apis:['setTimeout']});brief.startGeneration()
  brief.invalidate();brief.update([{...input,version:'v2'}],'2026-10-17','Asia/Shanghai');await old
  assert.equal(brief.snapshot().status,'queued');t.mock.timers.tick(1000)
  assert.equal(brief.snapshot().status,'working','the superseding input starts promptly')
  await brief.refresh();assert.equal(calls,2);assert.equal(brief.snapshot().status,'ready');assert.equal(brief.snapshot().cards.length,0)
 }finally{t.mock.timers.reset();await brief.close();await rm(dir,{recursive:true,force:true})}
})

test('old reports stay out of recent briefing while future deadlines remain, and memory discussions use original evidence',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-relevance-'))
 const old={...input,id:'old',observed_at:'2026-09-30T01:00:00Z',text:'2026-10-20 交付'}
 const memory={...input,id:'memory:stated',kind:'memory',evidence_refs:['original-evidence']}
 const base=reply.cards[0]!
 const brief=new TimelineBrief(join(dir,'timeline.json'),()=>Promise.resolve({cards:[
  {...base,title:'Old report',refs:['old'],facts:[{text:old.text,quote:old.text,ref:'old'}],temporal:{kind:'event',dates:[]}},
  {...base,title:'Future deadline',refs:['old'],facts:[{text:old.text,quote:old.text,ref:'old'}],temporal:{kind:'deadline',dates:[{role:'deadline',date:'2026-10-20',quote:old.text,ref:'old'}]}},
  {...base,title:'Saved context',refs:[memory.id],facts:[{text:memory.text,quote:memory.text,ref:memory.id}],temporal:{kind:'unknown',dates:[]}},
 ]}),()=>undefined)
 try{
  await brief.open();brief.update([old,memory],'2026-10-17','Asia/Shanghai');await brief.refresh()
  assert.deepEqual(brief.snapshot().cards.map(card=>card.title),['Future deadline','Saved context'])
  const saved=brief.snapshot().cards[1]!;assert.deepEqual(brief.discussion(saved.id,saved.version).evidence_refs,['original-evidence'])
 }finally{await brief.close();await rm(dir,{recursive:true,force:true})}
})

test('rechecking unchanged source permissions hides cached cards without cancelling synthesis',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-recheck-'));let release!:(value:typeof reply)=>void,signal:AbortSignal|undefined
 const brief=new TimelineBrief(join(dir,'timeline.json'),(_inputs,_context,current)=>{signal=current;return new Promise(resolve=>{release=resolve})},()=>undefined)
 try{
  await brief.open();brief.update([input],'2026-10-17','Asia/Shanghai');const running=brief.refresh()
  while(!release)await new Promise(resolve=>setImmediate(resolve))
  brief.suspend();assert.equal(brief.snapshot().cards.length,0);assert.equal(signal!.aborted,false)
  brief.update([input],'2026-10-17','Asia/Shanghai');assert.equal(signal!.aborted,false)
  release(reply);await running;assert.equal(brief.snapshot().cards.length,1)
  brief.suspend();assert.equal(brief.snapshot().cards.length,0)
  brief.update([input],'2026-10-17','Asia/Shanghai');assert.equal(brief.snapshot().cards.length,1)
  brief.suspend();brief.update([],'2026-10-17','Asia/Shanghai');assert.equal(brief.snapshot().cards.length,0)
 }finally{await brief.close();await rm(dir,{recursive:true,force:true})}
})

test('more than six independent briefings survive storage and restart',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-many-'))
 const cards=Array.from({length:13},(_,i)=>({...reply.cards[0]!,title:'Independent update '+i}))
 let brief=new TimelineBrief(join(dir,'timeline.json'),()=>{try{return Promise.resolve(({cards}))}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}},()=>undefined)
 try{
  await brief.open();brief.update([input],'2026-10-17','UTC');await brief.refresh()
  assert.equal(brief.snapshot().cards.length,13)
  await brief.close();brief=new TimelineBrief(join(dir,'timeline.json'),()=>{try{return Promise.resolve(({cards:[]}))}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}},()=>undefined)
  await brief.open();brief.update([input],'2026-10-17','UTC');assert.equal(brief.snapshot().cards.length,13)
 }finally{await brief.close();await rm(dir,{recursive:true,force:true})}
})

test('batch diagnostics survive persistence alongside the grounded cards',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-diagnostics-'))
 const diagnostics={input_count:1,selected_inputs:1,screened_topics:2,composition_batches:2,pending_batches:0,failed_batches:[{batch:1,reason:'invalid_evidence'}],stages:[{batch:0,phase:'compose' as const,received:2,accepted:1,dropped:{unsupported_quote:1}}],host_received:0,published:0,host_dropped:{}}
 let brief=new TimelineBrief(join(dir,'timeline.json'),()=>{try{return Promise.resolve(({...reply,diagnostics}))}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}},()=>undefined)
 try{
  await brief.open();brief.update([input],'2026-10-17','UTC');await brief.refresh();await brief.close()
  brief=new TimelineBrief(join(dir,'timeline.json'),()=>{try{return Promise.resolve(({cards:[]}))}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}},()=>undefined);await brief.open();brief.update([input],'2026-10-17','UTC')
  assert.equal(brief.snapshot().diagnostics?.published,1)
  assert.deepEqual(brief.snapshot().diagnostics?.failed_batches,[{batch:1,reason:'invalid_evidence'}])
  assert.equal(brief.snapshot().diagnostics?.stages[0]?.dropped.unsupported_quote,1)
 }finally{await brief.close();await rm(dir,{recursive:true,force:true})}
})

test('checked batches appear while working and survive timeout; withdrawal still hides them',async(t)=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-progress-'))
 const timeout=new AbortController();t.mock.method(AbortSignal,'timeout',()=>timeout.signal)
 let published=false
 const brief=new TimelineBrief(join(dir,'timeline.json'),async(_inputs,_context,_signal,progress)=>{
  await progress?.(reply);published=true;return new Promise(()=>{/* This fixture deliberately has no side effects. */})
 },()=>undefined)
 try{
  await brief.open();brief.update([input],'2026-10-17','UTC');const run=brief.refresh()
  while(!published)await new Promise(resolve=>setImmediate(resolve))
  assert.equal(brief.snapshot().status,'working');assert.equal(brief.snapshot().cards.length,1)
  timeout.abort(new DOMException('Timed out','TimeoutError'));await run
  assert.equal(brief.snapshot().status,'failed');assert.equal(brief.snapshot().cards.length,1)
  brief.update([],'2026-10-17','UTC');assert.equal(brief.snapshot().cards.length,0)
 }finally{await brief.close();await rm(dir,{recursive:true,force:true})}
})

test('new messages do not starve an authorized generation; edits and revocation still cancel it',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-arrivals-'))
 let release!:(value:typeof reply)=>void,signal:AbortSignal|undefined
 const brief=new TimelineBrief(join(dir,'timeline.json'),(_inputs,_context,current)=>{signal=current;return new Promise(resolve=>{release=resolve})},()=>undefined)
 try{
  await brief.open();brief.update([input],'2026-10-17','UTC');const run=brief.refresh()
  while(!release)await new Promise(resolve=>setImmediate(resolve))
  brief.update([input,{...input,id:'new-message'}],'2026-10-17','UTC')
  assert.equal(signal?.aborted,false)
  release(reply);await run;assert.equal(brief.snapshot().cards.length,1)
  const next=brief.refresh();while(signal?.aborted)await new Promise(resolve=>setImmediate(resolve))
  brief.update([{...input,version:'changed'}, {...input,id:'new-message'}],'2026-10-17','UTC')
  await next;assert.equal(brief.snapshot().cards.length,0)
 }finally{await brief.close();await rm(dir,{recursive:true,force:true})}
})

test('people tags retain only names grounded in the card sources and prose, and survive restart',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-people-'))
 const peer={...input,text:'林舟负责 Windows 复现，陈雨提供测试素材。'}
 const card={...reply.cards[0]!,title:'林舟与陈雨协作复现',facts:[{text:peer.text,quote:peer.text,ref:peer.id}],people:[
  {name:'林舟',quote:'林舟负责 Windows 复现',ref:peer.id},
  {name:'陈雨',quote:'陈雨提供测试素材',ref:peer.id},
  {name:'林舟',quote:peer.text,ref:peer.id},
  {name:'杜撰姓名',quote:peer.text,ref:peer.id},
  {name:'路人',quote:'路人负责',ref:'missing'},
 ]}
 const make=()=>new TimelineBrief(join(dir,'timeline.json'),()=>{try{return Promise.resolve(({cards:[card]}))}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}},()=>undefined)
 let brief=make()
 try{
  await brief.open();brief.update([peer],'2026-10-17','Asia/Shanghai');await brief.refresh()
  assert.deepEqual(brief.snapshot().cards[0]!.people.map(p=>p.name),['林舟','陈雨'])
  await brief.close();brief=make();await brief.open();brief.update([peer],'2026-10-17','Asia/Shanghai')
  assert.deepEqual(brief.snapshot().cards[0]!.people.map(p=>p.name),['林舟','陈雨'])
 }finally{await brief.close();await rm(dir,{recursive:true,force:true})}
})

test('unrelated source edits preserve still-authorized published cards while changed citations disappear',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-independent-'))
 const other={...input,id:'other',version:'v1'}
 const brief=new TimelineBrief(join(dir,'timeline.json'),()=>{try{return Promise.resolve(({cards:[reply.cards[0]!,{...reply.cards[0]!,title:'Other issue',refs:['other'],facts:[{text:other.text,quote:other.text,ref:'other'}]}]}))}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}},()=>undefined)
 try{
  await brief.open();brief.update([input,other],'2026-10-17','Asia/Shanghai');await brief.refresh()
  brief.update([input,{...other,version:'v2'}],'2026-10-17','Asia/Shanghai')
  assert.deepEqual(brief.snapshot().cards.map(c=>c.title),['Check the node'])
  assert.deepEqual(brief.basis(),[{id:input.id,version:input.version}])
  brief.update([{...other,version:'v2'}],'2026-10-17','Asia/Shanghai');assert.equal(brief.snapshot().cards.length,0)
 }finally{await brief.close();await rm(dir,{recursive:true,force:true})}
})


test('cached briefings from the old relevance policy require regeneration before display',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-policy-')),path=join(dir,'timeline.json')
 const make=()=>new TimelineBrief(path,()=>{try{return Promise.resolve(reply)}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}},()=>undefined)
 let brief=make()
 try{
  await brief.open();brief.update([input],'2026-10-17','Asia/Shanghai');await brief.refresh();await brief.close()
  const saved=JSON.parse(await readFile(path,'utf8')) as Record<string,unknown>;delete saved.perspective_revision;await writeFile(path,JSON.stringify(saved))
  brief=make();await brief.open();brief.update([input],'2026-10-17','Asia/Shanghai')
  assert.equal(brief.snapshot().cards.length,0)
  await brief.refresh();assert.equal(brief.snapshot().cards.length,1)
 }finally{await brief.close();await rm(dir,{recursive:true,force:true})}
})


test('a colleague name may be grounded in sender metadata but not an unrelated name or bot',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-named-author-'))
 const peer={...input,text:'我已经完成复现。',author:{key:'peer',name:'林舟',kind:'person' as const,is_user:false}}
 const card={...reply.cards[0]!,title:'林舟已完成复现',facts:[{text:'林舟已完成复现。',quote:peer.text,ref:peer.id}],people:[{name:'林舟',quote:peer.text,ref:peer.id}]}
 const brief=new TimelineBrief(join(dir,'timeline.json'),()=>{try{return Promise.resolve(({cards:[card]}))}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}},()=>undefined)
 try{
  await brief.open();brief.update([peer],'2026-10-17','Asia/Shanghai');await brief.refresh()
  assert.deepEqual(brief.snapshot().cards[0]!.people.map(person=>person.name),['林舟'])
  brief.update([{...peer,version:'v2',author:{...peer.author,name:'别人'}}],'2026-10-17','Asia/Shanghai');await brief.refresh()
  assert.deepEqual(brief.snapshot().cards[0]!.people,[])
 }finally{await brief.close();await rm(dir,{recursive:true,force:true})}
})
