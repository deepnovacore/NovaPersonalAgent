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
  if(operation.startsWith('compose.repair'))return Promise.resolve({text:JSON.stringify({cards:[this.options.repair?.(request)??this.options.card(request)]})})
  if(operation.startsWith('review')){const body=JSON.parse(request.prompt) as {cards:unknown[]};return Promise.resolve({text:JSON.stringify({cards:body.cards})})}
  if(operation.startsWith('compose'))return Promise.resolve({text:JSON.stringify({cards:[this.options.card(request)]})})
  throw Error('unexpected timeline operation '+operation)
 }
}

test('identical routine alerts are folded into their newest copy with a repeat count',async()=>{
 const inputs=[input('d0','disk usage alert on node-7','2026-10-17T00:00:00Z'),input('d1','disk usage alert on node-7','2026-10-17T01:00:00Z'),input('d2','disk usage alert on node-7','2026-10-17T02:00:00Z'),input('u1','unrelated project update','2026-10-17T03:00:00Z')]
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
