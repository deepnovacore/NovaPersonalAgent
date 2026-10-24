import {test} from 'node:test'
import assert from 'node:assert/strict'
import {GatewayPersonalWriter} from '../src/model/personal-writer.js'
import type {ModelGateway} from '../src/model/model-gateway.js'

test('durable observations qualify original messages before all three synthesis stages',async()=>{
 const requests:{system:string;prompt:string}[]=[];let stage=0
 const narrative={about:{paragraphs:[{text:'You build Orchard with Mei.',refs:['e0']}]},work:[],interests:[]}
 const gateway={complete:(request:{system:string;prompt:string})=>{requests.push(request);return Promise.resolve({text:JSON.stringify(request.system.includes('画像发布逐句核验')?{claims:(JSON.parse(request.prompt) as {claims:{id:string}[]}).claims.map((item:{id:string})=>({id:item.id,assessment:'Synthetic evidence verdict',supported:true}))}:request.system.includes('逐条判定画像材料')?{sources:[{id:'e0',relevance:'relationship'}]}:request.system.includes('提取最多24条观察')?{facts:Array.from({length:30},(_,i)=>({text:'【事】Observation '+i,refs:['e'+i]}))}:++stage===1?narrative:stage===2?{review_notes:[]}:{profile:narrative,review_notes:[]})})}} as unknown as ModelGateway
 const writer=new GatewayPersonalWriter({gateway,model:'fixture'})
 const entries=Array.from({length:30},(_,i)=>({id:'message-'+i,version:1,content:i===0?'Mei and I have worked on Orchard since January.':'Run this one-off microphone test.',origin:'inferred' as const}))
 // The cached observation is a selection hint. Its prose must not become evidence.
 const generate=writer.generateProfile as unknown as (input:typeof entries,signal:AbortSignal,observations:unknown[])=>ReturnType<typeof writer.generateProfile>
 const result=await generate(entries,new AbortController().signal,[{kind:'people',text:'UNTRUSTED SUMMARY CLAIM',refs:[{entry_id:'message-0',version:1}]}])
 assert.equal(requests.length,5)
 for(const request of requests){assert.match(request.prompt,/Mei and I have worked on Orchard/);assert.doesNotMatch(request.prompt,/UNTRUSTED SUMMARY CLAIM|microphone test/)}
 assert.deepEqual(result.about?.refs,[{entry_id:'message-0',version:1}])
})

test('profile observations never transmit credential-only lines or invented references',async()=>{
 const captured:string[]=[]
 const gateway={complete:(request:{prompt:string})=>{captured.push(request.prompt);return Promise.resolve({text:JSON.stringify({observations:[{kind:'work',relevance:'ongoing_work',text:'Invented',refs:['e0','not-supplied']},{kind:'people',relevance:'relationship',text:'Works with Mei',refs:['e0']}]})})}} as unknown as ModelGateway
 const writer=new GatewayPersonalWriter({gateway,model:'fixture'})
 const result=await writer.observeProfile([{id:'m',version:1,origin:'stated',content:'Works with Mei\nExample!23Pass\ntskey-auth-abcdef0123456789ABCDEF\n'+'ab12'.repeat(16)}],new AbortController().signal)
 assert.doesNotMatch(captured[0]!,/Example!23Pass|tskey-auth-|ab12ab12/)
 assert.match(captured[0]!,/Works with Mei/)
 assert.equal(result.length,1);assert.equal(result[0]?.text,'Works with Mei')
})

test('one-off task observations cannot enter the durable Profile selection pool',async()=>{
 const gateway={complete:()=>Promise.resolve({text:JSON.stringify({observations:[
  {kind:'work',relevance:'one_off_task',text:'Creates a voice acceptance workspace.',refs:['e1']},
  {kind:'work',relevance:'ongoing_work',text:'Develops Orchard.',refs:['e0']},
  {kind:'style',relevance:'uncertain',text:'Has an enduring testing philosophy.',refs:['e1']},
 ]})})} as unknown as ModelGateway
 const writer=new GatewayPersonalWriter({gateway,model:'fixture'})
 const result=await writer.observeProfile([{id:'project',version:1,origin:'stated',content:'I develop Orchard.'},{id:'check',version:1,origin:'stated',content:'Create acceptance.txt, read it back, and stop.'}],new AbortController().signal)
 assert.deepEqual(result.map(item=>item.refs.map(ref=>ref.entry_id)),[['project']])
})


test('multiple slices of one message do not establish a repeated personal pattern',async()=>{
 const gateway={complete:()=>Promise.resolve({text:JSON.stringify({observations:[{kind:'style',relevance:'repeated_pattern',text:'Repeatedly reflects on presentation quality.',refs:['e0','e1']}]})})} as unknown as ModelGateway
 const writer=new GatewayPersonalWriter({gateway,model:'fixture'})
 const result=await writer.observeProfile([{id:'one-message',version:1,origin:'stated',content:'I forgot to describe the product brain.'},{id:'one-message',version:1,origin:'stated',content:'That was a clumsy presentation.'}],new AbortController().signal)
 assert.deepEqual(result,[])
})


test('a mixed cached observation cannot smuggle a passing remark into the portrait',async()=>{
 const requests:{system:string;prompt:string}[]=[];let stage=0
 const narrative={about:{paragraphs:[{text:'You develop Orchard.',refs:['e0']}]},work:[],interests:[]}
 const gateway={complete:(request:{system:string;prompt:string})=>{requests.push(request);return Promise.resolve({text:JSON.stringify(request.system.includes('画像发布逐句核验')?{claims:(JSON.parse(request.prompt) as {claims:{id:string}[]}).claims.map((item:{id:string})=>({id:item.id,assessment:'Synthetic evidence verdict',supported:true}))}:request.system.includes('逐条判定画像材料')?{sources:[{id:'e0',relevance:'ongoing_work'},{id:'e1',relevance:'ephemeral_expression'}]}:++stage===1?narrative:stage===2?{review_notes:[]}:{profile:narrative,review_notes:[]})})}} as unknown as ModelGateway
 const writer=new GatewayPersonalWriter({gateway,model:'fixture'})
 const entries=[{id:'project',version:1,origin:'stated' as const,content:'I develop Orchard.'},{id:'remark',version:1,origin:'stated' as const,content:'ONE_OFF_REMARK about the product brain.'}]
 const result=await writer.generateProfile(entries,new AbortController().signal,[{kind:'work',text:'Develops Orchard and reflects on a missing module.',refs:entries.map(e=>({entry_id:e.id,version:e.version}))}])
 assert.equal(requests.length,5)
 assert.match(requests[0]!.prompt,/ONE_OFF_REMARK/)
 for(const request of requests.slice(1))assert.doesNotMatch(request.prompt,/ONE_OFF_REMARK/)
 assert.deepEqual(result.about?.refs,[{entry_id:'project',version:1}])
})

test('publication rejects unsupported sentences even when editing leaves them in',async()=>{
 let stage=0,audited=false
 const narrative={about:{paragraphs:[{text:'你提出三层交互。你反复提出三层交互。',refs:['e0']}]},work:[{title:'交互方案',text:'你提出执行纠偏。尚处于理念阶段，没有实现。',refs:['e0']},{title:'交互方案。尚处理念阶段。',text:'你提出执行纠偏。',refs:['e0']}],interests:[{text:'经常自嘲，追求逻辑严密性。',refs:['e0']}]}
 const gateway={complete:(request:{system:string;prompt:string})=>{
  let reply:unknown
  if(request.system.includes('逐条判定画像材料'))reply={sources:[{id:'e0',relevance:'ongoing_work'}]}
  else if(request.system.includes('画像发布逐句核验')){audited=true;const prompt=JSON.parse(request.prompt) as {claims:{id:string;kind:string;text:string}[]};assert.equal(prompt.claims.find(c=>c.text==='交互方案')?.kind,'title');assert.equal(prompt.claims[0]?.kind,'sentence');reply={claims:prompt.claims.map(item=>({id:item.id,assessment:'Synthetic evidence verdict',supported:!['反复','尚处','自嘲'].some(word=>item.text.includes(word))}))}}
  else reply=++stage===1?narrative:stage===2?{review_notes:[]}:{profile:narrative,review_notes:[]}
  return Promise.resolve({text:JSON.stringify(reply)})
 }} as unknown as ModelGateway
 const result=await new GatewayPersonalWriter({gateway,model:'fixture'}).generateProfile([{id:'proposal',version:1,origin:'stated',content:'我提出三层交互方案，其中一层是执行纠偏。'}],new AbortController().signal,[{kind:'work',text:'Interaction proposal',refs:[{entry_id:'proposal',version:1}]}])
 assert.equal(audited,true);assert.equal(result.about?.text,'你提出三层交互。');assert.equal(result.work?.[0]?.text,'你提出执行纠偏。');assert.equal(result.work?.length,1);assert.deepEqual(result.interests,[])
})


test('a bare review-note array is normalized without regenerating valid review feedback',async()=>{
 const requests:string[]=[],narrative={about:{paragraphs:[{text:'You develop Orchard.',refs:['e0']}]},work:[],interests:[]}
 const gateway={complete:(request:{system:string;prompt:string})=>{requests.push(request.system);if(request.system.includes('独立审查整份画像'))return Promise.resolve({text:JSON.stringify(['Keep the supported project.'])});if(request.system.includes('统一修订整份画像')){assert.match(request.prompt,/Keep the supported project/);return Promise.resolve({text:JSON.stringify({profile:narrative,review_notes:[]})})}return Promise.resolve({text:JSON.stringify(narrative)})}} as unknown as ModelGateway
 const result=await new GatewayPersonalWriter({gateway,model:'fixture'}).generateProfile([{id:'project',version:1,origin:'stated',content:'I develop Orchard.'}],new AbortController().signal)
 assert.equal(result.about?.text,'You develop Orchard.');assert.equal(requests.length,3)
})


test('profile JSON accepts a complete fence without retry but still validates its content',async()=>{
 const entries=[{id:'m',version:1,origin:'stated' as const,content:'I develop Orchard.'}]
 for(const [response,valid] of [["```json\n{\"observations\":[]}\n```",true],["```json\n{\"observations\":\"invalid\"}\n```",false],["Explanation\n```json\n{\"observations\":[]}\n```",false]] as const){
  let calls=0
  const gateway={complete:async()=>{calls++;return {text:response}}} as unknown as ModelGateway
  const result=new GatewayPersonalWriter({gateway,model:'fixture'}).observeProfile(entries,new AbortController().signal)
  if(valid){assert.deepEqual(await result,[]);assert.equal(calls,1)}else{await assert.rejects(result);assert.equal(calls,2)}
 }
})
