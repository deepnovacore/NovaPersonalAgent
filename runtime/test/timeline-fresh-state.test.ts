import {test} from 'node:test'
import assert from 'node:assert/strict'
import {GatewayPersonalWriter} from '../src/model/personal-writer.js'
import type {CompleteRequest,GatewayCompletion,ModelGateway} from '../src/model/model-gateway.js'
import type {TimelineContext,TimelineInput} from '../src/personal-agent/timeline-brief.js'

const context:TimelineContext={local_date:'2026-10-17',timezone:'UTC'}
const input=(id:string,text:string,at:string):TimelineInput=>({id,version:'v1',kind:'im',text,observed_at:at,group:'chat'})
const card=(ref:string,quote:string,priorId?:string)=>({category:'Alert',title:'Node alert',why_now:'The node state changed',facts:[{text:'Node state',quote,ref}],uncertainty:'',actions:[],refs:[ref],...(priorId?{prior_id:priorId}:{})})

/** Replies by operation; `repair` lets a test choose what the stale-state repair returns. */
class StateGateway implements ModelGateway {
 readonly requests:CompleteRequest[]=[]
 constructor(private readonly options:{card:(request:CompleteRequest)=>unknown;repair?:(request:CompleteRequest)=>unknown}){}
 count(prefix:string){return this.requests.filter(request=>(request.usage?.operation??'').startsWith(prefix)).length}
 async *stream():AsyncIterable<never>{/* the writer only calls complete */}
 complete(request:CompleteRequest):Promise<GatewayCompletion>{
  this.requests.push(request)
  const operation=request.usage?.operation??''
  if(operation.startsWith('compose.repair'))return Promise.resolve({text:JSON.stringify({cards:[this.options.repair?.(request)??this.options.card(request)].flat()})})
  if(operation.startsWith('review')){const body=JSON.parse(request.prompt) as {cards:unknown[]};return Promise.resolve({text:JSON.stringify({cards:body.cards})})}
  if(operation.startsWith('compose'))return Promise.resolve({text:JSON.stringify({cards:[this.options.card(request)].flat()})})
  throw Error('unexpected timeline operation '+operation)
 }
}

test('identical routine alerts are folded into their newest copy with a repeat count',async()=>{
 const inputs=[...['00','01','02'].map((hour,i)=>({...input('d'+i,'disk usage alert on node-7',`2026-10-17T${hour}:00:00Z`),relation:'system' as const})),input('u1','unrelated project update','2026-10-17T03:00:00Z')]
 const gateway=new StateGateway({card:request=>{const body=JSON.parse(request.prompt) as {inputs:{key:string;text:string}[]};return card(body.inputs[0]!.key,body.inputs[0]!.text)}})
 const result=await new GatewayPersonalWriter({gateway,model:'fixture'}).generateTimeline(inputs,context,new AbortController().signal)
 assert.equal(result.diagnostics?.duplicates_folded,2)
 const compose=gateway.requests.find(request=>(request.usage?.operation??'')==='compose')!
 const body=JSON.parse(compose.prompt) as {inputs:{key:string;text:string;repeat_count?:number}[]}
 assert.equal(body.inputs.length,2,'one copy of the repeated alert plus the unrelated message')
 const repeated=body.inputs.find(entry=>entry.text==='disk usage alert on node-7')
 assert.equal(repeated?.repeat_count,3,'the kept copy carries how many alerts it represents')
})

test('a revision that ignores a new state change is repaired once and then accepted',async()=>{
 const inputs=[input('m0','node-7 is still down','2026-10-16T00:00:00Z'),input('m1','node-7 recovered','2026-10-17T00:00:00Z')]
 const gateway=new StateGateway({card:()=>card('e0','node-7 is still down','card-1'),repair:()=>card('e1','node-7 recovered','card-1')})
 const writer=new GatewayPersonalWriter({gateway,model:'fixture'})
 const result=await writer.generateTimeline(inputs,{...context,prior_cards:[{id:'card-1',title:'Node alert',category:'Alert',why_now:'state',anchor_date:null,evidence_ids:['m0']}],new_input_ids:['m1']},new AbortController().signal)
 assert.equal(gateway.count('compose.repair'),1,'the guard asks once for the missed state change')
 assert.equal(result.diagnostics?.stale_state_repairs,1)
 assert.equal(result.diagnostics?.stale_state_dropped,0)
 assert.deepEqual(result.cards[0]?.refs,['m1'],'the repaired revision cites the new state message')
})

test('a revision that still ignores the new state change is dropped so the published card survives',async()=>{
 const inputs=[input('m0','node-7 is still down','2026-10-16T00:00:00Z'),input('m1','node-7 recovered','2026-10-17T00:00:00Z')]
 const gateway=new StateGateway({card:()=>card('e0','node-7 is still down','card-1')})
 const writer=new GatewayPersonalWriter({gateway,model:'fixture'})
 const result=await writer.generateTimeline(inputs,{...context,prior_cards:[{id:'card-1',title:'Node alert',category:'Alert',why_now:'state',anchor_date:null,evidence_ids:['m0']}],new_input_ids:['m1']},new AbortController().signal)
 assert.equal(result.diagnostics?.stale_state_repairs,1)
 assert.equal(result.diagnostics?.stale_state_dropped,1)
 assert.equal(result.cards.length,0,'no stale revision reaches the host merge')
})

const prior=(id:string,evidence:string)=>({id,title:id,category:'Alert',why_now:'state',anchor_date:null,evidence_ids:[evidence]})

test('an inferred revision cannot bypass the state guard',async()=>{
 const inputs=[input('old','node is down','2026-10-15T00:00:00Z'),input('note','investigation continues','2026-10-16T00:00:00Z'),input('new','node recovered','2026-10-17T00:00:00Z')]
 const gateway=new StateGateway({card:()=>({...card('e0','node is down'),refs:['e0','e1']})})
 const result=await new GatewayPersonalWriter({gateway,model:'fixture'}).generateTimeline(inputs,{...context,prior_cards:[prior('prior','old')],new_input_ids:['note','new']},new AbortController().signal)
 assert.equal(gateway.count('compose.repair'),1)
 assert.equal(result.cards.length,0)
})

test('another card citing recovery cannot cover a stale revision',async()=>{
 const inputs=[input('old','node is down','2026-10-16T00:00:00Z'),input('new','node recovered','2026-10-17T00:00:00Z')]
 const gateway=new StateGateway({card:()=>[card('e0','node is down','prior'),card('e1','node recovered')]})
 const result=await new GatewayPersonalWriter({gateway,model:'fixture'}).generateTimeline(inputs,{...context,prior_cards:[prior('prior','old')],new_input_ids:['new']},new AbortController().signal)
 assert.equal(gateway.count('compose.repair'),1)
 assert.equal(result.cards.length,1)
 assert.deepEqual(result.cards[0]?.refs,['new'])
 assert.equal(result.diagnostics?.stale_state_dropped,1)
})

for(const includeStale of [true,false])test(includeStale?'a failed repair retains valid revisions from unrelated topics':'an unrelated state change does not trigger repair',async()=>{
 const inputs=[input('a0','node is down','2026-10-16T00:00:00Z'),input('a1','node recovered','2026-10-17T00:00:00Z'),input('b0','design draft','2026-10-16T00:00:00Z'),input('b1','design feedback','2026-10-17T00:00:00Z')]
 const gateway=new StateGateway({card:request=>{const rows=(JSON.parse(request.prompt) as {inputs:{key:string;text:string}[]}).inputs;return [...(includeStale?[card(rows.find(row=>row.text==='node is down')!.key,'node is down','a')]:[]),card(rows.find(row=>row.text==='design feedback')!.key,'design feedback','b')]}})
 const complete=gateway.complete.bind(gateway)
 gateway.complete=async request=>{
  if(request.usage?.operation?.startsWith('select'))return {text:JSON.stringify({topics:[{title:'Node',refs:['e0','e1']},{title:'Design',refs:['e2','e3']}]})}
  if(request.usage?.operation==='reconcile')return {text:JSON.stringify({groups:[{members:['t0']},{members:['t1']}]})}
  return complete(request)
 }
 const cache={open:()=>Promise.resolve(),clear:()=>Promise.resolve(),flush:()=>Promise.resolve(),beginRun:()=>({getTopics:()=>[],getScreened:()=>[],appendBatchResult:()=>undefined,getStage:()=>undefined,putStage:()=>undefined,deleteStage:()=>undefined,commit:()=>Promise.resolve()})}
 const result=await new GatewayPersonalWriter({gateway,model:'fixture'}).generateTimeline(inputs,{...context,prior_cards:[prior('a','a0'),prior('b','b0')],new_input_ids:['a1','b1']},new AbortController().signal,undefined,{cache,scope:'local',force:false})
 assert.equal(gateway.count('compose.repair'),includeStale?1:0)
 assert.deepEqual(result.cards.map(card=>card.prior_id),['b'])
})

test('more than sixteen state updates only require the latest state',async()=>{
 const inputs=[input('old','node is down','2026-10-16T00:00:00Z'),...Array.from({length:20},(_,i)=>input('new'+i,'node recovered '+i,'2026-10-17T00:'+String(i).padStart(2,'0')+':00Z'))]
 const gateway=new StateGateway({card:()=>card('e0','node is down','prior'),repair:()=>card('e20','node recovered 19','prior')})
 const result=await new GatewayPersonalWriter({gateway,model:'fixture'}).generateTimeline(inputs,{...context,prior_cards:[prior('prior','old')],new_input_ids:inputs.slice(1).map(input=>input.id)},new AbortController().signal)
 assert.deepEqual(result.cards[0]?.refs,['new19'])
 assert.equal(result.diagnostics?.stale_state_dropped,0)
})

test('a state change beyond a composition split blocks an earlier stale revision',async()=>{
 const inputs=[input('old','node is down','2026-10-16T00:00:00Z'),...Array.from({length:205},(_,i)=>input('n'+i,'investigation '+i,'2026-10-17T00:00:00Z')),input('latest','node recovered','2026-10-17T01:00:00Z')]
 const gateway=new StateGateway({card:request=>{
  const rows=(JSON.parse(request.prompt) as {inputs:{key:string;text:string}[]}).inputs
  const recovery=rows.find(row=>row.text==='node recovered'),old=rows.find(row=>row.text==='node is down')
  if(recovery)return card(recovery.key,recovery.text,'prior')
  return {...card(old!.key,old!.text,'prior'),refs:[old!.key,rows[1]!.key]}
 }})
 const complete=gateway.complete.bind(gateway)
 gateway.complete=async request=>{
  if(request.usage?.operation?.startsWith('select')){const rows=(JSON.parse(request.prompt) as {inputs:{key:string}[]}).inputs;return {text:JSON.stringify({topics:[{title:'Node',refs:rows.map(row=>row.key)}]})}}
  if(request.usage?.operation==='reconcile')return {text:JSON.stringify({groups:[{members:['t0','t1']}]})}
  return complete(request)
 }
 const result=await new GatewayPersonalWriter({gateway,model:'fixture'}).generateTimeline(inputs,{...context,prior_cards:[prior('prior','old')],new_input_ids:inputs.slice(1).map(input=>input.id)},new AbortController().signal)
 assert.ok(result.cards.length)
 assert.ok(result.cards.every(card=>card.refs.includes('latest')))
})

test('identical person statements keep both speakers and user attribution',async()=>{
 const inputs:TimelineInput[]=[
  {...input('self','I will submit the report tomorrow','2026-10-17T00:00:00Z'),relation:'self',author:{key:'self',name:'User',kind:'person',is_user:true}},
  {...input('peer','I will submit the report tomorrow','2026-10-17T01:00:00Z'),relation:'participant',author:{key:'peer',name:'Peer',kind:'person',is_user:false}},
 ]
 const gateway=new StateGateway({card:()=>[]})
 const result=await new GatewayPersonalWriter({gateway,model:'fixture'}).generateTimeline(inputs,context,new AbortController().signal)
 const body=JSON.parse(gateway.requests.find(request=>request.usage?.operation==='compose')!.prompt) as {inputs:{author:{name:string;is_user:boolean}}[]}
 assert.deepEqual(body.inputs.map(input=>[input.author.name,input.author.is_user]),[['User',true],['Peer',false]])
 assert.equal(result.diagnostics?.duplicates_folded,0)
})
