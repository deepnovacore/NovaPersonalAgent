import test from 'node:test'
import assert from 'node:assert/strict'
import {SourceProcessingAgent} from '../src/personal-agent/source-processing-agent.js'
import {emptyUnderstanding} from '../src/personal-agent/understanding-products.js'
import type {PersonalAgentHost} from '../src/personal-agent/host.js'
import type {ScheduledRunGrant} from '../src/personal-agent/scheduled-run-authority.js'
import type {ProfileInput} from '../src/personal-agent/profile-warmup.js'

for(const mode of ['direct','observed','profile_only'] as const)test(`compose preserves original factual text despite generated project judgments (${mode})`,async()=>{
 const text='Orchard is a reference project; my role and its current status are unknown.'
 const ref={evidence_id:'message',stamp:'stamp',start:0,end:text.length}
 const original={...ref,source_key:'source',text,version:'v1',source_kind:'conversation',observed_at:'2026-10-18T01:00:00Z',locator:'conversation',source_metadata:null}
 const project={id:'orchard',name:'Orchard',relation:'participating' as const,status:'current' as const,summary:'Derived project judgment',as_of:null,refs:[{entry_id:'message',version:'v1'}]}
 const products={...emptyUnderstanding(),projects:[project]}
 const batch={items:[ref],provider:'provider',run_id:'run',task_id:'task',status:'bound',profile_only:mode==='profile_only'}
 const run={run_id:'run',task_id:'task',processing:{batch_id:'batch',recipe:'provider',calls:[]}}
 const generated:ProfileInput[][]=[],observed:ProfileInput[][]=[]
 let publication:Record<string,unknown>|undefined
 const memory={
  sourceProcessingConsumer:()=> 'provider',
  sourceProcessing:async(request:{action:string;[key:string]:unknown})=>{
   if(request.action==='batch')return {batch,valid:true}
   if(request.action==='evidence')return {items:[original]}
   if(request.action==='profile')return {revision:0,draft:null}
   if(request.action==='identities')return {items:[]}
   if(request.action==='products')return products
   if(request.action==='observe')return {applied:true}
   if(request.action==='profile_context')return {items:[original],observations:[],refs:[ref],key:'context',ready:true,unchanged:false}
   if(request.action==='publish'){publication=request;return {applied:true}}
   throw Error('unexpected operation '+request.action)
  },
  sourceProcessingProducts:async()=>({projects:[project],suggestions:[]}),
  ...(mode!=='direct'?{sourceProcessingObserve:async(entries:ProfileInput[])=>{observed.push(structuredClone(entries));return []}}:{}),
  sourceProcessingProfile:async(entries:ProfileInput[])=>{generated.push(structuredClone(entries));return {about:null,work:[],interests:[]}},
 }
 const host={options:{memory:()=>memory},
  scheduledAuthority:{assert:()=>{},signal:()=>new AbortController().signal},
  schedules:{getRun:()=>run,reserveSourceProcessingCall:async()=>run},
  sourceProcessingForegroundBusy:()=>false,sourceProjectRoots:()=>[],
  snapshot:()=>({settings:{timezone:'UTC'}}),understandingProductsChanged:()=>{},
 } as unknown as PersonalAgentHost
 const grant={run_id:'run',task_id:'task',consumer:'provider',fence:{task_id:'task'}} as ScheduledRunGrant
 await new SourceProcessingAgent(host).call(grant,'compose',{action:'compose',refs:[ref]})
 assert.equal(generated.length,1)
 assert.equal(observed.length,mode==='observed'?1:0)
 for(const inputs of [...generated,...observed]){
  assert.deepEqual(inputs.map(input=>input.content),[text])
  assert.doesNotMatch(inputs[0]!.content,/项目判断|参与=participating|状态=current/)
 }
 if(mode!=='profile_only')assert.deepEqual((publication?.products as {projects:unknown[]}).projects,[project],'derived judgments remain available as products')
})
