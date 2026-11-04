import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
import type {TimelineInput} from '../src/personal-agent/timeline-brief.js'

/** Nearest-rank percentile over sorted samples. */
export function percentile(samples:readonly number[],rank:number):number{
 const sorted=[...samples].sort((a,b)=>a-b)
 return sorted.length?sorted[Math.max(0,Math.ceil(sorted.length*rank)-1)]!:0
}

const ROWS=Number(process.env.NOVA_TIMELINE_BENCH_ROWS??5000)
const SAMPLES=Number(process.env.NOVA_TIMELINE_BENCH_SAMPLES??9)

function inputs(count:number):TimelineInput[]{
 const now=Date.now()
 return Array.from({length:count},(_,index)=>({id:`personal:bench:${index}`,version:'v1',kind:'im' as const,text:`Synthetic approval is pending for item ${index}`,observed_at:new Date(now-index*1000).toISOString(),relation:'participant' as const}))
}

/**
 * Repeatable latency probe for a Timeline card discussion click: a host with `ROWS` synthetic evidence rows,
 * counting ledger reads and timing the host work that precedes the persisted user message. Set
 * NOVA_TIMELINE_BENCH_ROWS / NOVA_TIMELINE_BENCH_SAMPLES to change the size; nothing touches a real data dir.
 */
test('timeline discussion click: reads and latency with synthetic evidence',{timeout:120000},async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-latency-'))
 const rows=inputs(ROWS)
 let reads=0
 const memory={productSurfaces:true,timelineEvidence:()=>{reads++;return Promise.resolve(rows)}} as unknown as PersonalMemoryResource
 const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'local',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,
  generateTimeline:items=>Promise.resolve({cards:[{category:'Approval',title:'Review the approval',why_now:'Its state needs checking',facts:[{text:'An approval is pending',quote:'approval is pending',ref:items[0]!.id}],uncertainty:'No deadline known',actions:[{label:'Discuss',kind:'discuss'}],refs:[items[0]!.id]}]})})
 try{
  await host.open({deferBackground:true})
  const cold=performance.now();await host.refreshTimeline();const coldMs=performance.now()-cold
  await host.timeline.refresh()
  const card=host.snapshot().timeline.cards[0]
  assert.ok(card,'a card exists to discuss')
  const reference={kind:'timeline' as const,id:card.id,version:card.version,interaction:'discuss' as const}
  const warm:number[]=[],warmReads:number[]=[],authorized:number[]=[],authorizedReads:number[]=[]
  for(let index=0;index<SAMPLES;index++){
   let before=reads,start=performance.now();await host.discussionContext([reference]);warm.push(performance.now()-start);warmReads.push(reads-before)
   before=reads;start=performance.now();assert.equal(await host.timelineAuthorized(card.id,card.version,'consumer'),false);authorized.push(performance.now()-start);authorizedReads.push(reads-before)
  }
  const round=(value:number)=>Math.round(value*10)/10
  console.log(JSON.stringify({bench:'timeline_discuss_click',rows:ROWS,samples:SAMPLES,cold_refresh_ms:round(coldMs),
   discussion_context_ms:{p50:round(percentile(warm,.5)),p95:round(percentile(warm,.95))},discussion_context_reads:warmReads,
   timeline_authorized_ms:{p50:round(percentile(authorized,.5)),p95:round(percentile(authorized,.95))},timeline_authorized_reads:authorizedReads}))
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
