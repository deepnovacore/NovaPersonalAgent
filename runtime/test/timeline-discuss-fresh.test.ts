import {test} from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
import type {TimelineInput} from '../src/personal-agent/timeline-brief.js'

async function fixture(t:TestContext){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-fresh-'))
 let inputs:TimelineInput[]=[{id:'personal:fresh:1',version:'v1',kind:'im',text:'Synthetic approval is pending',observed_at:new Date().toISOString(),relation:'participant'}],reads=0,account:string|undefined
 const memory={productSurfaces:true,timelineEvidence:()=>{reads++;return Promise.resolve(inputs)},canReadConversationEvidence:()=>Promise.resolve(true)} as unknown as PersonalMemoryResource
 const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'local',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,
  generateTimeline:items=>Promise.resolve({cards:[{category:'Approval',title:'Review the approval',why_now:'Its state needs checking',facts:[{text:'An approval is pending',quote:'approval is pending',ref:items[0]!.id}],uncertainty:'No deadline known',actions:[{label:'Discuss',kind:'discuss'}],refs:[items[0]!.id]}]})})
 host.setFeishu({restore:()=>Promise.resolve(),snapshot:()=>({account_id:account}),open:()=>Promise.resolve(),close:()=>Promise.resolve(),command:()=>Promise.resolve(null)} as never)
 t.after(async()=>{await host.close();await rm(dir,{recursive:true,force:true})})
 await host.open({deferBackground:true});await host.refreshTimeline();await host.timeline.refresh()
 const card=host.snapshot().timeline.cards[0]!
 assert.ok(card)
 return {host,card,reference:{kind:'timeline' as const,id:card.id,version:card.version,interaction:'discuss' as const},reads:()=>reads,setInputs:(next:TimelineInput[])=>{inputs=next},setAccount:(next:string|undefined)=>{account=next}}
}

test('a discussion reuses the completed timeline read and costs no ledger read',async t=>{
 const f=await fixture(t)
 const before=f.reads()
 await f.host.discussionContext([f.reference]);await f.host.discussionContext([f.reference])
 assert.equal(await f.host.timelineAuthorized(f.card.id,f.card.version,'consumer'),true)
 assert.equal(f.reads()-before,0)
})

for(const [name,invalidate] of [
 ['a source change',(f:Awaited<ReturnType<typeof fixture>>)=>f.host.sourceChanged()],
 ['a connection or consent change',(f:Awaited<ReturnType<typeof fixture>>)=>Promise.resolve(f.host.connectionChanged())],
 ['a Feishu account switch',(f:Awaited<ReturnType<typeof fixture>>)=>Promise.resolve(f.setAccount('other-account'))],
 ['a timeline invalidation',(f:Awaited<ReturnType<typeof fixture>>)=>Promise.resolve(f.host.timeline.invalidate())],
 ['a timeline clear',(f:Awaited<ReturnType<typeof fixture>>)=>f.host.timeline.clear()],
] as const)test(`${name} makes the next discussion read the evidence again`,async t=>{
 const f=await fixture(t)
 const before=f.reads()
 await invalidate(f)
 // The card may be gone or withdrawn afterwards; the point is that nothing is served from the read made before the event.
 await f.host.discussionContext([f.reference]).catch(()=>undefined)
 await f.host.discussionContext([f.reference]).catch(()=>undefined)
 const reads=f.reads()-before
 assert.ok(reads>=1,'a read happened after the event')
 assert.ok(reads<=2,'and the second discussion reused it')
})

test('a withdrawn source is rejected even though the last read was recent',async t=>{
 const f=await fixture(t)
 f.setInputs([])
 await f.host.sourceChanged()
 await assert.rejects(f.host.discussionContext([f.reference]),/stale_reference/)
 assert.equal(await f.host.timelineAuthorized(f.card.id,f.card.version,'consumer'),false)
})

test('an old completed read is not reused after the freshness window',async t=>{
 const f=await fixture(t)
 const now=Date.now()
 t.mock.method(Date,'now',()=>now+60_000)
 const before=f.reads()
 await f.host.discussionContext([f.reference]).catch(()=>undefined)
 assert.ok(f.reads()-before>=1)
})
