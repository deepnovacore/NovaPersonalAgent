import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
import type {TimelineInput} from '../src/personal-agent/timeline-brief.js'

test('restart restores the saved account before presenting cached timeline without generation',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-account-restart-'));
 const input={id:'personal:restored',version:'1',kind:'im',text:'Release passed',observed_at:new Date().toISOString(),account_scope:'saved-account'};
 let calls=0;
 const memory={timelineEvidence:()=>Promise.resolve([input])} as unknown as PersonalMemoryResource;
 const create=()=>{
  let account:string|undefined;
  const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'local',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,generateTimeline:()=>{calls++;return Promise.resolve({cards:[{category:'Release',title:'Release passed',why_now:'A result was recorded',facts:[{text:input.text,quote:input.text,ref:input.id}],uncertainty:'',actions:[],refs:[input.id]}]})}});
  const connector={restore:()=>{account='saved-account';return Promise.resolve()},snapshot:()=>({account_id:account}),open:()=>Promise.reject(Error('network must not be needed')),close:()=>Promise.resolve(),command:()=>Promise.resolve(null)};
  host.setFeishu(connector);return host;
 };
 let host=create();
 try{
  await host.open({deferBackground:true});
  assert.equal((host.snapshot().feishu as {account_id?:string}).account_id,'saved-account');
  await host.refreshTimeline();await host.timeline.refresh();assert.equal(host.snapshot().timeline.cards.length,1);
  await host.close();host=create();await host.open({deferBackground:true});await host.refreshTimeline();
  assert.equal(host.snapshot().timeline.cards.length,1);assert.equal(calls,1,'restart reads the saved result without another model call');
 }finally{await host.close();await rm(dir,{recursive:true,force:true});}
})

test('host synthesizes ordinary signals without Life writes and revalidates conversation recipient and source withdrawal',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-host-'))
 let inputs:TimelineInput[]=[{id:'personal:test:ordinary',version:'v1',kind:'im',text:'Synthetic approval is pending',observed_at:new Date().toISOString(),relation:'participant'}],calls=0,understandingCalls=0
 const memory={timelineEvidence:()=>Promise.resolve(inputs),canReadConversationEvidence:(_id:string,consumer:string)=>Promise.resolve(consumer==='allowed')} as unknown as PersonalMemoryResource
 const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'local',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,understand:()=>{understandingCalls++;return Promise.resolve([])},generateTimeline:items=>{calls++;return Promise.resolve({cards:[{category:'Approval',title:'Review the approval',why_now:'Its current state needs checking',facts:[{text:'An approval is pending',quote:'approval is pending',ref:items[0]!.id}],uncertainty:'No deadline known',actions:[{label:'Draft a question',kind:'draft'}],refs:[items[0]!.id]}]})}})
 try{
  await host.open({deferBackground:true});assert.equal(calls,0)
  await host.refreshTimeline();assert.equal(calls,0)
  await host.timeline.refresh();assert.equal(calls,1)
  const card=host.snapshot().timeline.cards[0]!;assert.ok(card);assert.equal(host.snapshot().life.todos.length,0)
  const reference={kind:'timeline' as const,id:card.id,version:card.version}
  assert.equal(await host.timelineAuthorized(card.id,card.version,'wrong'),false)
  assert.equal(await host.timelineAuthorized(card.id,card.version,'allowed'),true)
  const context=await host.discussionContext([reference]);assert.equal(context.prepared?.trust,'untrusted_external');assert.deepEqual(context.prepared?.evidence_refs,[inputs[0]!.id])
  host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>Promise.resolve({assistant:'Draft in this conversation'}),close:()=>Promise.resolve()}),()=>undefined)
  const action=await host.command({type:'personal.command',request_id:'draft-brief',method:'conversations.discuss',params:{text:'Draft here',references:[{...reference,interaction:'draft'}]}})
  assert.equal((action as {ok:boolean}).ok,true)
  await host.waitConversation('chat:main')
  assert.equal(understandingCalls,0,'briefing actions must not be interpreted as new todo commitments')
  assert.equal(host.snapshot().life.todos.length,0)
  await host.submitConversationText('chat:main','Remember to review my plan');await host.waitConversation('chat:main')
  assert.equal(understandingCalls,1,'ordinary user messages still reach understanding')
  inputs=[];await host.sourceChanged()
  const historical=host.snapshot().timeline.cards
  assert.equal(historical.length,1);assert.equal(historical[0]!.id,card.id)
  assert.equal(historical[0]!.sources_available,false);assert.equal(historical[0]!.historical,true)
  assert.equal(await host.timelineAuthorized(card.id,card.version,'allowed'),false)
  await assert.rejects(host.discussionContext([reference]),/stale_reference/)
  assert.equal(host.snapshot().life.todos.length,0)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('host forwards checked batch progress only after reauthorizing original sources',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-host-progress-'))
 let allowed=true,finished=false,release!:()=>void
 const input={id:'personal:batch',version:'1',kind:'im',text:'Release passed',observed_at:new Date().toISOString()}
 const memory={timelineEvidence:()=>{try{return Promise.resolve(allowed?[input]:[])}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}} as unknown as PersonalMemoryResource
 const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'local',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,generateTimeline:async(_inputs,_context,_signal,progress)=>{
  const reply={cards:[{category:'Release',title:'Release passed',why_now:'A result was recorded',facts:[{text:input.text,quote:input.text,ref:input.id}],uncertainty:'',actions:[],refs:[input.id]}]}
  await progress?.(reply);finished=true;await new Promise<void>(resolve=>{release=resolve});allowed=false
  await progress?.(reply);return reply
 }})
 try{
  await host.open({deferBackground:true});await host.refreshTimeline();const run=host.timeline.refresh()
  for(let i=0;i<1000&&!finished;i++)await new Promise(resolve=>setTimeout(resolve,1))
  assert.equal(finished,true);assert.equal(host.snapshot().timeline.cards.length,1);assert.equal(host.snapshot().timeline.status,'working')
  const card=host.snapshot().timeline.cards[0]!
  release();await run
  const historical=host.snapshot().timeline.cards
  assert.equal(historical.length,1);assert.equal(historical[0]!.id,card.id)
  assert.equal(historical[0]!.sources_available,false,'revoked progress loses source access immediately, before another refresh')
  assert.equal(historical[0]!.historical,true)
  assert.throws(()=>host.timeline.discussion(card.id,card.version),/stale_reference/)
 }finally{release?.();await host.close();await rm(dir,{recursive:true,force:true})}
})
