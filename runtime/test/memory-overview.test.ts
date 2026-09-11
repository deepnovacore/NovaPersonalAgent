import type {CompleteRequest, ModelGateway} from '../src/model-gateway.js'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, rm, realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {validateMemoryOverview, type MemoryOverview} from '../src/personal-agent/memory-overview.js'
import type {MemoryEntry} from '../src/memory/entry.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
import {SuggestionPool} from '../src/suggestions.js'
const entry: MemoryEntry = {id:'one',version:1,content:'Nova supports voice conversations.',kind:'fact',origin:'inferred',topic:'Nova',status:'active',corrected_to:null,confidence_note:null,source_refs:[{type:'file',ref:'README.md',observed_at:'2026-09-11T00:00:00Z'}],observed_at:'2026-09-11T00:00:00Z',recorded_at:'2026-09-11T00:00:00Z'}
const overview = (version=1): MemoryOverview => ({summary:'Nova supports voice conversations.',sections:[{title:'Nova',summary:'Voice conversations.',keywords:['voice'],refs:[{entry_id:'one',version}]}]})
const tick = () => new Promise(resolve => setImmediate(resolve))
test('overview requires bounded sections and exact active source versions', () => {
  assert.deepEqual(validateMemoryOverview(overview(),[entry]),overview())
  assert.equal(validateMemoryOverview(overview(2),[entry]),null)
  assert.equal(validateMemoryOverview(overview(),[{...entry,status:'forgotten'}]),null)
  assert.equal(validateMemoryOverview({...overview(),sections:[{...overview().sections[0],refs:[]}]},[entry]),null)
  assert.equal(validateMemoryOverview({...overview(),sections:Array(5).fill(overview().sections[0])},[entry]),null)
})
test('late summaries cannot survive corrections, forgetting, page changes or close; repeated page reuses cache', async () => {
  const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-overview-'))
  let entries=[entry]
  const calls:{resolve:(value:MemoryOverview)=>void;signal:AbortSignal}[]=[]
  const memory={list:()=>Promise.resolve({entries,cursor:null}),get:(id:string)=>Promise.resolve(entries.find(e=>e.id===id)??null),correct:()=>{entries=[{...entry,version:2}];return Promise.resolve({previous:entry,entry:entries[0]})},forgetEntry:()=>{entries=[];return Promise.resolve({...entry,status:'forgotten'})}} as unknown as PersonalMemoryResource
  const host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,summarizeMemory:(_entries,signal)=>new Promise(resolve=>calls.push({resolve,signal}))})
  try {
    await host.open();assert.equal(calls.length,1);assert.equal(host.snapshot().memory.overview,null)
    await host.command({type:'personal.command',request_id:'correct',method:'memory.correct',params:{id:'one',expected_version:1,content:'New text'}})
    await tick();assert.equal(calls[0]!.signal.aborted,true);assert.equal(calls.length,2)
    calls[0]!.resolve(overview());await tick();assert.equal(host.snapshot().memory.overview,null)
    const beforeSummary=host.snapshot().revision;calls[1]!.resolve(overview(2));await tick();assert(host.snapshot().revision>beforeSummary);assert.deepEqual(host.snapshot().memory.overview,overview(2))
    await host.refreshMemory();assert.equal(calls.length,2)
    entries=[{...entry,version:3}];await host.refreshMemory();assert.equal(host.snapshot().memory.overview,null)
    await host.command({type:'personal.command',request_id:'forget',method:'memory.forget',params:{id:'one',expected_version:3}})
    calls[2]!.resolve(overview(3));await tick();assert.equal(host.snapshot().memory.overview,null);assert.equal(calls.length,3)
    entries=[entry];await host.refreshMemory();await tick();assert.equal(calls.length,4)
    await host.command({type:'personal.command',request_id:'page',method:'memory.list',params:{cursor:'next'}})
    await tick();assert.equal(calls[3]!.signal.aborted,true);assert.equal(calls.length,5)
    await host.close();calls.at(-1)!.resolve(overview());await tick();assert.equal(host.snapshot().memory.overview,null)
  } finally {await host.close();await rm(dir,{recursive:true,force:true})}
})
test('empty memory and absent model stay available without model calls',async()=>{
  const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-overview-empty-'));let calls=0
  const host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null,summarizeMemory:()=>{calls++;return Promise.resolve(overview())}})
  try {await host.open();await tick();assert.equal(calls,0);assert.equal(host.snapshot().memory.overview,null)} finally {await host.close();await rm(dir,{recursive:true,force:true})}
})
test('memory synthesis uses the existing gateway model and rejects ungrounded references',async()=>{
  const {GatewaySurrogate}=await import('../src/model-adapters.js')
  const requests:CompleteRequest[]=[]
  let value=overview()
  const gateway={complete:(request:CompleteRequest)=>{requests.push(request);return Promise.resolve({text:JSON.stringify(value)})}} as unknown as ModelGateway
  const surrogate=new GatewaySurrogate({gateway,model:'existing-model',proactivityPreset:'balanced'})
  const signal=new AbortController().signal
  assert.equal(await surrogate.summarizeMemory([],signal),null);assert.equal(requests.length,0)
  assert.deepEqual(await surrogate.summarizeMemory([entry],signal),overview())
  assert.equal(requests[0]!.model,'existing-model');assert.equal(requests[0]!.signal,signal)
  assert.deepEqual(JSON.parse(requests[0]!.prompt),{entries:[entry]})
  value=overview(9);assert.equal(await surrogate.summarizeMemory([entry],signal),null)
})
test('failed overview retries on explicit refresh without looping or caching failure',async()=>{
  const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-overview-retry-'));let calls=0
  const memory={list:()=>Promise.resolve({entries:[entry],cursor:null})} as unknown as PersonalMemoryResource
  const host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,summarizeMemory:()=>++calls===1?Promise.reject(Error('temporary')):Promise.resolve(overview())})
  try {
    await host.open();await tick();assert.equal(calls,1);assert.equal(host.snapshot().memory.overview,null)
    await tick();assert.equal(calls,1)
    await host.refreshMemory();await tick();assert.equal(calls,2);assert.deepEqual(host.snapshot().memory.overview,overview())
    await host.refreshMemory();await tick();assert.equal(calls,2)
  } finally {await host.close();await rm(dir,{recursive:true,force:true})}
})
test('source observation refreshes memory while discovery is disabled and evidence signature unchanged',async()=>{
  const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-overview-source-'));let entries:MemoryEntry[]=[];let discovered=0
  const memory={list:()=>Promise.resolve({entries,cursor:null})} as unknown as PersonalMemoryResource
  const host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,discover:()=>{discovered++;return Promise.resolve(null)}})
  try {
    await host.open();await host.command({type:'personal.command',request_id:'off',method:'discovery.configure',params:{enabled:false}})
    await host.sourceChanged()
    entries=[entry];await host.sourceChanged()
    assert.deepEqual(host.snapshot().memory.entries,[entry]);assert.equal(discovered,0)
  } finally {await host.close();await rm(dir,{recursive:true,force:true})}
})
