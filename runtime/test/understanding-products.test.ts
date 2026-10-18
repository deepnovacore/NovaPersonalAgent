import {test} from 'node:test'
import assert from 'node:assert/strict'
import {validateProducts} from '../src/personal-agent/understanding-products.js'
const refs=[{entry_id:'e1',version:'v1'}]
const entry={id:'e1',version:'v1',content:'明天核对接口，然后再定日期。',origin:'stated' as const,observed_at:'2026-10-15T08:00:00Z'}
const suggestion={id:'',kind:'action' as const,title:'核对接口',body:'检查接口',project_id:null,todo_id:null,due:'2026-10-17',anchor:{entry_id:'e1',quote:'核对接口'},refs}
test('suggestion dates require exact source evidence and resolve relative dates from source time',()=>{
 const a=validateProducts({projects:[],suggestions:[suggestion]},[entry],[],{},'Asia/Shanghai')
 assert.equal(a.suggestions[0]?.due,null)
 const b=validateProducts({projects:[],suggestions:[{...suggestion,date_evidence:{entry_id:'e1',quote:'明天'}}]},[entry],[],{},'Asia/Shanghai')
 assert.equal(b.suggestions[0]?.due,'2026-10-16')
})
test('suggestion identity survives rewriting title and source version with same evidence anchor',()=>{
 const a=validateProducts({projects:[],suggestions:[suggestion]},[entry],[],{},'UTC')
 const b=validateProducts({projects:[],suggestions:[{...suggestion,id:a.suggestions[0]!.id,title:'检查新接口'}]},[entry],[],{},'UTC')
 assert.equal(a.suggestions[0]?.id,b.suggestions[0]?.id)
})
test('project corrections win and fabricated project identity cannot reach the product',()=>{
 const project={id:'p1',name:'Project',relation:'participating' as const,status:'current' as const,summary:'Current work',as_of:null,refs}
 const result=validateProducts({projects:[project,{...project,id:'invented'}],suggestions:[]},[entry],['p1'],{p1:'reference'},'UTC')
 assert.equal(result.projects.length,1);assert.equal(result.projects[0]?.relation,'reference')
})

test('separate actions in one document retain their anchors across evidence versions',()=>{
 const make=(id:string,version:string)=>({id,version,origin:'inferred' as const,source:{project:'P',document:'notes.md'},content:'检查接口。补齐截图。',observed_at:entry.observed_at})
 const a=make('old','v1'),b=make('new','v2'),raw=(e:typeof a)=>({projects:[],suggestions:['检查接口','补齐截图'].map(quote=>({...suggestion,refs:[{entry_id:e.id,version:e.version}],anchor:{entry_id:e.id,quote}}))})
 const first=validateProducts(raw(a),[a],[],{},'UTC'),second=validateProducts(raw(b),[b],[],{},'UTC',first)
 assert.equal(first.suggestions.length,2);assert.deepEqual(first.suggestions.map(i=>i.id),second.suggestions.map(i=>i.id))
})

test('explicit team work in conversation can establish a non Git project',()=>{
 const input={...entry,source:{project:'Conversation',document:'team plan'},content:'我正在负责 PaperNest 团队的验收计划。'}
 const result=validateProducts({projects:[{id:'',name:'PaperNest',relation:'participating',status:'current',summary:'负责团队验收',as_of:null,refs}],suggestions:[]},[input],[],{},'UTC')
 assert.equal(result.projects.length,1);assert.ok(result.projects[0]?.id);assert.equal(result.projects[0]?.as_of,input.observed_at)
})

test('relative dates in old documents never use the indexing timestamp',()=>{
 const file={...entry,source:{project:'Archived project',document:'notes.md'}}
 const result=validateProducts({projects:[{id:'p',name:'P',relation:'uncertain',status:'uncertain',summary:'Old note',as_of:'2020-01-01',refs}],suggestions:[{...suggestion,date_evidence:{entry_id:'e1',quote:'明天'}}]},[file],['p'],{},'UTC')
 assert.equal(result.suggestions[0]?.due,null);assert.equal(result.projects[0]?.as_of,null)
})


test('rewritten source can reuse a dismissed identity without using its old content',()=>{
 const old={...entry,identity_key:'stable-source',content:'Old text'}
 const first=validateProducts({projects:[],suggestions:[{...suggestion,anchor:{entry_id:'e1',quote:'Old text'}}]},[old],[],{},'UTC')
 const prior=first.suggestions[0]!,input={...entry,identity_key:'stable-source',version:'v2',content:'Rewritten interface work'}
 const next=validateProducts({projects:[],suggestions:[{...suggestion,id:prior.id,title:'Revised API',refs:[{entry_id:'e1',version:'v2'}],anchor:{entry_id:'e1',quote:'Rewritten interface work'}}]},[input],[],{},'UTC',{projects:[],suggestions:[]},[{id:prior.id,kind:prior.kind,title:prior.title,project_id:null,source_key:'stable-source'}])
 assert.equal(next.suggestions[0]?.id,prior.id)
})
test('progress must refer to an authorized existing todo',()=>{
 const raw={projects:[],suggestions:[{...suggestion,kind:'progress',todo_id:'invented'}]}
 assert.deepEqual(validateProducts(raw,[entry],[],{},'UTC').suggestions,[])
 assert.equal(validateProducts(raw,[entry],[],{},'UTC',{projects:[],suggestions:[]},[],[{id:'invented',title:'API',status:'pending',due:null}]).suggestions.length,1)
})


import {generateUnderstandingProducts} from '../src/model/understanding-writer.js'
import type {ModelGateway,CompleteRequest} from '../src/model/model-gateway.js'
test('real gateway JSON mode receives the schema in the prompt and repairs one malformed response',async()=>{
 const requests:CompleteRequest[]=[]
 const gateway={complete:(request:CompleteRequest)=>{requests.push(request);return Promise.resolve({text:requests.length===1?'[]':JSON.stringify({projects:[],suggestions:[suggestion]})})},stream(){throw Error('unused')}} as unknown as ModelGateway
 const result=await generateUnderstandingProducts(gateway,'fixture',[entry],{projects:[],previous:{projects:[],suggestions:[]},corrections:{},timezone:'UTC',todos:[]},new AbortController().signal)
 assert.equal(requests.length,2);assert.match(requests[0]!.prompt, /"output_schema":/);assert.match(requests[1]!.prompt,/上次输出格式无效/);assert.equal(result.suggestions.length,1)
})


test('a model supplied non Git project alias is normalized with its linked suggestions',()=>{
 const input={...entry,source:{project:'Conversation',document:'team plan'},content:'我在推进 PaperNest，需要核对接口。'}
 const result=validateProducts({projects:[{id:'PaperNest',name:'PaperNest',relation:'participating',status:'current',summary:'团队工作',as_of:null,refs}],suggestions:[{...suggestion,project_id:'PaperNest'}]},[input],[],{},'UTC')
 assert.equal(result.projects.length,1);assert.equal(result.suggestions.length,1);assert.notEqual(result.projects[0]?.id,'PaperNest');assert.equal(result.suggestions[0]?.project_id,result.projects[0]?.id)
 const unrelated=validateProducts({projects:[{id:'Invented',name:'Invented',relation:'participating',status:'current',summary:'Unfounded',as_of:null,refs}],suggestions:[]},[input],[],{},'UTC')
 assert.deepEqual(unrelated.projects,[])
})

test('prototype property names are not relative dates and never fail a products batch',()=>{
 for(const quote of ['constructor','__proto__']){
  const input={...entry,content:`请核对接口；代码中有 ${quote}。`}
  const result=validateProducts({projects:[],suggestions:[{...suggestion,anchor:{entry_id:'e1',quote:'核对接口'},date_evidence:{entry_id:'e1',quote}}]},[input],[],{},'UTC')
  assert.equal(result.suggestions[0]?.due,null)
 }
})
test('action and progress suggestions require a nonempty exact quotation from their cited current evidence',()=>{
 const todos=[{id:'todo',title:'核对接口',status:'open',due:null}]
 for(const kind of ['action','progress'] as const)for(const anchor of [undefined,null,{entry_id:'e1',quote:''},{entry_id:'e1',quote:' '},{entry_id:'e1',quote:'不存在的原文'},{entry_id:'uncited',quote:'核对接口'}]){
  const {anchor:_existing,...unanchored}=suggestion;const raw={...unanchored,kind,todo_id:kind==='progress'?'todo':null,...(anchor===undefined?{}:{anchor})}
  assert.deepEqual(validateProducts({projects:[],suggestions:[raw]},[entry],[],{},'UTC',{projects:[],suggestions:[]},[],todos).suggestions,[],`${kind}: ${JSON.stringify(anchor)}`)
 }
 const valid={...suggestion,anchor:{entry_id:'e1',quote:'核对接口'}}
 assert.equal(validateProducts({projects:[],suggestions:[valid]},[entry],[],{},'UTC').suggestions.length,1)
})
test('suggestion identity follows its exact evidence anchor when refs are reordered',()=>{
 const firstEntry={...entry,identity_key:'message-1',content:'核对接口。'},secondEntry={...entry,id:'e2',identity_key:'message-2',content:'补充上下文。'}
 const original={...suggestion,refs:[{entry_id:firstEntry.id,version:firstEntry.version},{entry_id:secondEntry.id,version:secondEntry.version}],anchor:{entry_id:firstEntry.id,quote:'核对接口'}}
 const first=validateProducts({projects:[],suggestions:[original]},[firstEntry,secondEntry],[],{},'UTC')
 const next=validateProducts({projects:[],suggestions:[{...original,refs:[...original.refs].reverse()}]},[firstEntry,secondEntry],[],{},'UTC')
 assert.equal(next.suggestions[0]?.id,first.suggestions[0]?.id)
 assert.equal(next.suggestions[0]?.source_key,'message-1')
})

import {understandingSourceTags} from '../src/personal-agent/understanding-products.js'
test('missing source metadata never fabricates a file provenance tag',()=>{
 assert.deepEqual(understandingSourceTags([{entry_id:'missing'}],[]),[])
 const sources=[{id:'e1',version:'v1',label:'message',observed_at:entry.observed_at,type:'im' as const}]
 assert.equal(understandingSourceTags(refs,sources)[0]?.type,'im')
})
test('already cancelled product generation never invokes the gateway',async()=>{
 const abort=new AbortController();abort.abort();let calls=0
 const gateway={complete:async()=>{calls++;return {text:'{"projects":[],"suggestions":[]}'}}} as unknown as ModelGateway
 await assert.rejects(generateUnderstandingProducts(gateway,'fixture',[entry],{projects:[],previous:{projects:[],suggestions:[]},corrections:{},timezone:'UTC',todos:[]},abort.signal),{name:'AbortError'})
 assert.equal(calls,0)
})
test('cancellation during a non-cooperative gateway call cannot yield products or a format-repair call',async()=>{
 const abort=new AbortController();let calls=0
 const gateway={complete:async()=>{calls++;abort.abort();return {text:'[]'}}} as unknown as ModelGateway
 await assert.rejects(generateUnderstandingProducts(gateway,'fixture',[entry],{projects:[],previous:{projects:[],suggestions:[]},corrections:{},timezone:'UTC',todos:[]},abort.signal),{name:'AbortError'})
 assert.equal(calls,1)
})

test('shared reference schema already rejects empty project and suggestion references',()=>{
 assert.throws(()=>validateProducts({projects:[],suggestions:[{...suggestion,refs:[]}]},[entry],[],{},'UTC'),z.ZodError)
 assert.throws(()=>validateProducts({projects:[{id:'p',name:'Project',relation:'uncertain',status:'uncertain',summary:'',as_of:null,refs:[]}],suggestions:[]},[entry],['p'],{},'UTC'),z.ZodError)
})
import {z} from 'zod'
test('sensitivity screening preserves the nonempty schema envelope while removing a synthetic private key',async()=>{
 let prompt=''
 const input={...entry,content:'-----BEGIN PRIVATE KEY-----\nsynthetic-private-material\n-----END PRIVATE KEY-----'}
 const gateway={complete:async(request:CompleteRequest)=>{prompt=request.prompt;return {text:'{"projects":[],"suggestions":[]}'}}} as unknown as ModelGateway
 await generateUnderstandingProducts(gateway,'fixture',[input],{projects:[],previous:{projects:[],suggestions:[]},corrections:{},timezone:'UTC',todos:[]},new AbortController().signal)
 assert.match(prompt,/"output_schema":/);assert.ok(prompt.length>0);assert.doesNotMatch(prompt,/synthetic-private-material/)
})
