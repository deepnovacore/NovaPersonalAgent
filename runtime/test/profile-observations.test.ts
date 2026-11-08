import {test} from 'node:test'
import assert from 'node:assert/strict'
import {GatewayPersonalWriter} from '../src/model/personal-writer.js'
import type {ModelGateway} from '../src/model/model-gateway.js'

test('durable observations qualify original messages before all three synthesis stages',async()=>{
 const requests:{system:string;prompt:string}[]=[];let stage=0
 const narrative={about:{paragraphs:[{text:'You build Orchard with Mei.',refs:['e0']}]},work:[],interests:[]}
 const gateway={complete:(request:{system:string;prompt:string})=>{requests.push(request);return Promise.resolve({text:JSON.stringify(request.system.includes('画像发布逐句核验')?{claims:(JSON.parse(request.prompt) as {claims:{id:string}[]}).claims.map((item:{id:string})=>({id:item.id,assessment:'Synthetic evidence verdict',verdict:'supported'}))}:request.system.includes('逐条判定画像材料')?{sources:[{id:'e0',relevance:'relationship'}]}:request.system.includes('提取最多24条观察')?{facts:Array.from({length:30},(_,i)=>({text:'【事】Observation '+i,refs:['e'+i]}))}:++stage===1?narrative:stage===2?{review_notes:[]}:{profile:narrative,review_notes:[]})})}} as unknown as ModelGateway
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
 const gateway={complete:(request:{system:string;prompt:string})=>{requests.push(request);return Promise.resolve({text:JSON.stringify(request.system.includes('画像发布逐句核验')?{claims:(JSON.parse(request.prompt) as {claims:{id:string}[]}).claims.map((item:{id:string})=>({id:item.id,assessment:'Synthetic evidence verdict',verdict:'supported'}))}:request.system.includes('逐条判定画像材料')?{sources:[{id:'e0',relevance:'ongoing_work'},{id:'e1',relevance:'ephemeral_expression'}]}:++stage===1?narrative:stage===2?{review_notes:[]}:{profile:narrative,review_notes:[]})})}} as unknown as ModelGateway
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
  else if(request.system.includes('画像发布逐句核验')){audited=true;const prompt=JSON.parse(request.prompt) as {claims:{id:string;kind:string;text:string}[]};assert.equal(prompt.claims.find(c=>c.text==='交互方案')?.kind,'title');assert.equal(prompt.claims[0]?.kind,'sentence');reply={claims:prompt.claims.map(item=>({id:item.id,assessment:'Synthetic evidence verdict',verdict:['反复','尚处','自嘲'].some(word=>item.text.includes(word))?'unsupported':'supported'}))}}
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

test('the previous publication is continuity context only and never contributes references',async()=>{
 const requests:{system:string;prompt:string}[]=[];let stage=0
 const narrative={about:{paragraphs:[{text:'You develop Orchard.',refs:['e0']}]},work:[],interests:[]}
 const gateway={complete:(request:{system:string;prompt:string})=>{requests.push(request);return Promise.resolve({text:JSON.stringify(++stage===1?narrative:stage===2?{review_notes:[]}:{profile:narrative,review_notes:[]})})}} as unknown as ModelGateway
 const writer=new GatewayPersonalWriter({gateway,model:'fixture'})
 const result=await writer.generateProfile([{id:'project',version:1,origin:'stated',content:'I develop Orchard.'}],new AbortController().signal,undefined,{generated_at:'2026-10-18T00:00:00Z',about:'DELETED_SOURCE_FACT about a closed project',work:[{title:'Old project',text:'OLD_PROJECT_WORK'}],interests:['OLD_INTEREST']})
 assert.ok(requests.length>=1,'a draft was requested')
 const draftRequest=requests.find(request=>request.prompt.includes('"previous_publication"'))
 assert.ok(draftRequest,'the previous publication reaches the draft request')
 assert.match(draftRequest.prompt,/DELETED_SOURCE_FACT/)
 assert.match(draftRequest.system,/不是证据/)
 // Continuity is prose only: the parsed draft still cites nothing but the current entries.
 assert.deepEqual(result.about?.refs,[{entry_id:'project',version:1}])
 assert.deepEqual(result.work,[]);assert.deepEqual(result.interests,[])
})

test('profile JSON accepts a complete fence without retry but still validates its content',async()=>{
 const entries=[{id:'m',version:1,origin:'stated' as const,content:'I develop Orchard.'}]
 for(const [response,valid] of [["```json\n{\"observations\":[]}\n```",true],["```json\n{\"observations\":\"invalid\"}\n```",false],["Explanation\n```json\n{\"observations\":[]}\n```",false]] as const){
  let calls=0
  const gateway={complete:()=>{calls++;return Promise.resolve({text:response})}} as unknown as ModelGateway
  const result=new GatewayPersonalWriter({gateway,model:'fixture'}).observeProfile(entries,new AbortController().signal)
  if(valid){assert.deepEqual(await result,[]);assert.equal(calls,1)}else{await assert.rejects(result);assert.equal(calls,2)}
 }
})

interface Narrative {about:{paragraphs:{text:string;refs:string[]}[]};work:{title:string;text:string;refs:string[]}[];interests:{text:string;refs:string[]}[];keywords?:{text:string;refs:string[]}[]}
type Verifier=(claims:{id:string;tier:string;text:string;paragraph?:string}[])=>unknown
const tieredGateway=(narrative:Narrative,verifier:Verifier,classify:(prompt:{groups:{messages:string[]}[]})=>{id:string;relevance:string}[],seen:{system:string;prompt:string}[]=[])=>{
  let stage=0
  return {complete:(request:{system:string;prompt:string;maxTokens?:number})=>{
    seen.push(request)
    let reply:unknown
    if(request.system.includes('逐条判定画像材料'))reply={sources:classify(JSON.parse(request.prompt) as {groups:{messages:string[]}[]})}
    else if(request.system.includes('画像发布逐句核验'))return Promise.resolve({text:verifier((JSON.parse(request.prompt.split('\n格式错误')[0]!) as {claims:{id:string;tier:string;text:string}[]}).claims) as string})
    else reply=++stage===1?narrative:stage===2?{review_notes:[]}:{profile:narrative,review_notes:[]}
    return Promise.resolve({text:JSON.stringify(reply)})
  }} as unknown as ModelGateway
}
const twoMessages=[{id:'m1',version:1,origin:'stated' as const,content:'I outline the plan before I touch the code.'},{id:'m2',version:1,origin:'stated' as const,content:'Again I wrote the plan first for the release.'}]
const observing=[{kind:'style' as const,text:'Plans first.',refs:[{entry_id:'m1',version:1},{entry_id:'m2',version:1}]}]
const bothWork=()=>[{id:'e0',relevance:'ongoing_work'},{id:'e1',relevance:'ongoing_work'}]

test('tiered verifier keeps judgments backed by two distinct messages and drops facts, thin judgments and contradictions',async()=>{
  const narrative:Narrative={about:{paragraphs:[
    {text:'你做事习惯先梳理再动手。你负责Orchard的上线。',refs:['e0','e1']},
    {text:'你偏好简短的沟通方式。',refs:['e0']},
    {text:'你沟通方式很强势。',refs:['e0','e1']},
  ]},work:[],interests:[]}
  const seen:{system:string;prompt:string;maxTokens?:number}[]=[]
  const verifier:Verifier=claims=>JSON.stringify({claims:claims.map(item=>({id:item.id,assessment:'x',verdict:item.text.includes('强势')?'contradicted':item.text.includes('习惯')?'supported':'unsupported'}))})
  const result=await new GatewayPersonalWriter({gateway:tieredGateway(narrative,verifier,bothWork,seen),model:'fixture'}).generateProfile(twoMessages,new AbortController().signal,observing)
  assert.equal(result.about?.text,'你做事习惯先梳理再动手。')
  const verification=seen.find(request=>request.system.includes('画像发布逐句核验'))!
  const claims=(JSON.parse(verification.prompt) as {claims:{tier:string;text:string;paragraph?:string}[]}).claims
  assert.equal(claims.find(item=>item.text.includes('习惯'))?.tier,'judgment');assert.equal(claims.find(item=>item.text.includes('上线'))?.tier,'fact')
  assert.match(claims[0]!.paragraph??'',/上线/,'a multi-sentence paragraph travels with each of its sentences')
  assert.ok((verification.maxTokens??0)>=4096+claims.length*100,'the verifier allowance scales with the number of claims')
})

test('a judgment backed by a single message is not admitted',async()=>{
  const narrative:Narrative={about:{paragraphs:[{text:'你做事习惯先梳理再动手。',refs:['e0']}]},work:[],interests:[]}
  const slices=[{id:'same',version:1,origin:'stated' as const,content:'I outline the plan first. Then I write the code.'}]
  const verifier:Verifier=claims=>JSON.stringify({claims:claims.map(item=>({id:item.id,assessment:'x',verdict:'unsupported'}))})
  const result=await new GatewayPersonalWriter({gateway:tieredGateway(narrative,verifier,()=>[{id:'e0',relevance:'ongoing_work'}]),model:'fixture'}).generateProfile(slices,new AbortController().signal,[{kind:'style',text:'Plans first.',refs:[{entry_id:'same',version:1}]}])
  assert.equal(result.about,null)
})

test('a truncated verifier reply degrades to host rules: unverified facts and titles are dropped, judgments need two distinct messages',async()=>{
   const narrative:Narrative={about:{paragraphs:[{text:'你负责Orchard的发布。你反复提出三层交互。',refs:['e0']},{text:'你做事习惯先梳理再动手。',refs:['e0','e1']}]},work:[{title:'Orchard 发布',text:'你推进Orchard发布。',refs:['e0','e1']}],interests:[{text:'偏好先写计划的做事方式',refs:['e0','e1']}]}
   let calls=0
   const verifier:Verifier=()=>{calls++;return '{"claims":[{"id":"s0","assess'}
   const result=await new GatewayPersonalWriter({gateway:tieredGateway(narrative,verifier,bothWork),model:'fixture'}).generateProfile(twoMessages,new AbortController().signal,observing)
   assert.equal(calls,2,'the verifier is retried once before degrading')
   assert.equal(result.about?.text,'你做事习惯先梳理再动手。','the invented responsibility and the single-message frequency claim are removed')
   assert.deepEqual(result.work,[],'a work item whose title cannot be verified is dropped')
   assert.deepEqual(result.interests.map(item=>item.text),['偏好先写计划的做事方式'])
})

test('a judgment needs a supported verdict: an unrelated trait with two refs is dropped, and omitted verdicts reject the reply',async()=>{
   const narrative:Narrative={about:{paragraphs:[{text:'你做事习惯先梳理再动手。',refs:['e0','e1']},{text:'你沟通方式非常幽默。',refs:['e0','e1']}]},work:[],interests:[]}
   const verdictFor=(text:string)=>text.includes('幽默')?'unsupported':'supported'
   const writer=(verifier:Verifier)=>new GatewayPersonalWriter({gateway:tieredGateway(narrative,verifier,bothWork),model:'fixture'})
   const result=await writer(claims=>JSON.stringify({claims:[...claims].reverse().map(item=>({id:item.id,assessment:'x',verdict:verdictFor(item.text)}))})).generateProfile(twoMessages,new AbortController().signal,observing)
   assert.equal(result.about?.text,'你做事习惯先梳理再动手。','ordering of the verdicts does not matter')
   let calls=0
   const partial=await writer(claims=>{calls++;return JSON.stringify({claims:claims.slice(0,1).map(item=>({id:item.id,assessment:'x',verdict:'supported'}))})}).generateProfile(twoMessages,new AbortController().signal,observing)
   assert.equal(calls,1,'an incomplete claims array is a failed verification, not a partial one')
   assert.equal(partial.about?.text,'你做事习惯先梳理再动手。\n\n你沟通方式非常幽默。','degraded host rules admit only judgments with two distinct originals; the supported verdict of the one answered claim is not trusted')
})

test('a mixed sentence with a completion claim is a fact and needs the verifier, and an always-claim with two refs is dropped',async()=>{
   const narrative:Narrative={about:{paragraphs:[{text:'你偏好先梳理再动手，并已交付Orchard的发布。',refs:['e0','e1']},{text:'你总是先写计划。',refs:['e0']},{text:'你总是先写计划再动手。',refs:['e0','e0']}]},work:[],interests:[]}
   const seen:{system:string;prompt:string}[]=[]
   const verifier:Verifier=claims=>JSON.stringify({claims:claims.map(item=>({id:item.id,assessment:'x',verdict:item.tier==='fact'?'unsupported':'supported'}))})
   const result=await new GatewayPersonalWriter({gateway:tieredGateway(narrative,verifier,bothWork,seen),model:'fixture'}).generateProfile(twoMessages,new AbortController().signal,observing)
   const claims=(JSON.parse(seen.find(request=>request.system.includes('画像发布逐句核验'))!.prompt) as {claims:{tier:string;text:string}[]}).claims
   assert.equal(claims.find(item=>item.text.includes('交付'))?.tier,'fact')
   assert.equal(result.about,null,'the unsupported fact and both always-claims backed by a single distinct message are dropped')
})

test('observations repeated across batches merge, and repeated_pattern is accepted only for messages in a multi-message group',async()=>{
  const narrative:Narrative={about:{paragraphs:[{text:'你做事习惯先梳理再动手。',refs:['e0','e1']}]},work:[],interests:[]}
  const verifier:Verifier=claims=>JSON.stringify({claims:claims.map(item=>({id:item.id,assessment:'x',verdict:'supported'}))})
  const prompts:{groups:{messages:string[]}[]}[]=[]
  const classify=(prompt:{groups:{messages:string[]}[]})=>{prompts.push(prompt);return [{id:'e0',relevance:'repeated_pattern'},{id:'e1',relevance:'repeated_pattern'}]}
  const writer=new GatewayPersonalWriter({gateway:tieredGateway(narrative,verifier,classify),model:'fixture'})
  const separate=[{kind:'style' as const,text:'Plans first.',refs:[{entry_id:'m1',version:1}]},{kind:'style' as const,text:'plans first',refs:[{entry_id:'m2',version:1}]}]
  const result=await writer.generateProfile(twoMessages,new AbortController().signal,separate)
  assert.deepEqual(prompts[0]!.groups,[{messages:['e0','e1']}],'identical observations merge into one group spanning both messages')
  assert.equal(result.about?.text,'你做事习惯先梳理再动手。')
  const lone=await writer.generateProfile(twoMessages,new AbortController().signal,[{kind:'style',text:'Plans first.',refs:[{entry_id:'m1',version:1}]},{kind:'style',text:'Something else.',refs:[{entry_id:'m2',version:1}]}])
  assert.equal(lone.about,null,'repeated_pattern for a message outside any multi-message group is not qualified')
})

const imEntries=[
  {id:'m1',version:1,origin:'stated' as const,content:'I will outline the plan before touching the deployment.',source:{project:'p',document:'d',kind:'im' as const,relation:'self' as const,sender_id:'self',sender_name:'Me',message_id:'x1'}},
  {id:'m2',version:1,origin:'stated' as const,content:'Status: the deployment fix is mostly ready, tests come next.',source:{project:'p',document:'d',kind:'im' as const,relation:'participant' as const,sender_id:'ou_other',sender_name:'陈明',message_id:'x2'}},
]
const supportAll:Verifier=claims=>JSON.stringify({claims:claims.map(item=>({id:item.id,assessment:'x',verdict:'supported'}))})

test('sentences and clauses that report another sender without the user as subject are dropped, the user-centred text stays',async()=>{
  const narrative:Narrative={about:{paragraphs:[
    {text:'你习惯先梳理部署方案再动手；陈明提醒不要用旧版本。',refs:['e0','e1']},
    {text:'陈明说基本效果已经出来。陈明会继续测试。',refs:['e1']},
    {text:'你与陈明对接部署，并据此调整了顺序。',refs:['e0','e1']},
  ]},work:[],interests:[]}
  const result=await new GatewayPersonalWriter({gateway:tieredGateway(narrative,supportAll,bothWork),model:'fixture'}).generateProfile(imEntries,new AbortController().signal,observing)
  assert.equal(result.about?.text,'你习惯先梳理部署方案再动手。\n\n你与陈明对接部署，并据此调整了顺序。')
})

test('the profile prompts require the user as the subject of every sentence and keep interests as a judgment',async()=>{
  const seen:{system:string;prompt:string}[]=[]
  const narrative:Narrative={about:{paragraphs:[{text:'你做事习惯先梳理再动手。',refs:['e0','e1']}]},work:[],interests:[{text:'关注部署流程的可靠性',refs:['e0','e1']}]}
  await new GatewayPersonalWriter({gateway:tieredGateway(narrative,supportAll,bothWork,seen),model:'fixture'}).generateProfile(twoMessages,new AbortController().signal,observing)
  for(const operation of ['独立审查整份画像','统一修订整份画像'])assert.match(seen.find(request=>request.system.includes(operation))!.system,/以他人为主语/u)
  const draft=seen.find(request=>request.system.includes('为本人写一份'))!.system
  assert.doesNotMatch(draft,/每个句子的主语都是“你”/u);assert.match(draft,/不逐条罗列消息/u);assert.match(draft,/讲你自己行动的句子/u);assert.match(draft,/不是已落地的工作/u);assert.match(draft,/设想或讨论阶段/u);assert.match(draft,/不得复述about已写的规律句/u);assert.match(draft,/不单列work项/u);assert.match(draft,/一个项目只列一项work/u)
  const edit=seen.find(request=>request.system.includes('统一修订整份画像'))!.system;assert.match(edit,/不是已落地的工作/u);assert.match(edit,/设想或讨论阶段/u);assert.match(edit,/不复述about的规律句/u);assert.match(edit,/同一项目合并为一项work/u);assert.match(draft,/interests[\s\S]*不足两条不同原消息支持时才留空/u)
})

test('interest items are judgments: admitted on a supported verdict and two distinct messages even when they mention work words, never as facts',async()=>{
  const narrative:Narrative={about:{paragraphs:[]},work:[],interests:[
    {text:'关注发布流程的稳定性',refs:['e0','e1']},
    {text:'关注部署自动化',refs:['e0']},
    {text:'已发布Orchard 2.0',refs:['e0','e1']},
    {text:'关注测试优先的做法',refs:['e0','e1']},
  ]}
  const seen:{system:string;prompt:string}[]=[]
  const verifier:Verifier=claims=>JSON.stringify({claims:claims.map(item=>({id:item.id,assessment:'x',verdict:item.text.includes('测试优先')?'unsupported':'supported'}))})
  const result=await new GatewayPersonalWriter({gateway:tieredGateway(narrative,verifier,bothWork,seen),model:'fixture'}).generateProfile(twoMessages,new AbortController().signal,observing)
  const claims=(JSON.parse(seen.find(request=>request.system.includes('画像发布逐句核验'))!.prompt) as {claims:{tier:string;text:string}[]}).claims
  assert.equal(claims.find(item=>item.text.includes('稳定性'))?.tier,'judgment')
  assert.equal(claims.find(item=>item.text.includes('2.0'))?.tier,'fact')
  assert.deepEqual(result.interests.map(item=>item.text),['关注发布流程的稳定性','已发布Orchard 2.0'])
})

const draftBreaking=(inner:ModelGateway,replies:(string|null)[],seen:{system:string;prompt:string;reasoning?:string}[])=>{
  let index=0
  return {complete:(request:{system:string;prompt:string;reasoning?:string})=>{
    if(request.system.includes('为本人写一份')){
      seen.push(request)
      const reply=replies[index++]
      if(reply!==null&&reply!==undefined)return Promise.resolve({text:reply,finish_reason:'stop'})
    }
    return (inner as unknown as {complete:(r:unknown)=>Promise<unknown>}).complete(request)
  }} as unknown as ModelGateway
}
const aboutOnly='{"about":{"paragraphs":[{"text":"你习惯先梳理再动手。","refs":["e0","e1"]}]}'
const goodNarrative:Narrative={about:{paragraphs:[{text:'你习惯先梳理再动手。',refs:['e0','e1']}]},work:[],interests:[]}

test('a draft cut off after about is retried with the failure reason and then accepted',async()=>{
  const seen:{system:string;prompt:string;reasoning?:string}[]=[]
  const gateway=draftBreaking(tieredGateway(goodNarrative,supportAll,bothWork),[aboutOnly,null],seen)
  const result=await new GatewayPersonalWriter({gateway,model:'fixture'}).generateProfile(twoMessages,new AbortController().signal,observing)
  assert.equal(seen.length,2)
  assert.match(seen[1]!.prompt,/JSON对象没有闭合/u)
  assert.equal(seen[1]!.reasoning,'disabled')
  assert.equal(result.about?.text,'你习惯先梳理再动手。')
})

test('two cut-off drafts still get a third differently-prompted attempt, and a third failure is not accepted',async()=>{
  const seen:{system:string;prompt:string;reasoning?:string}[]=[]
  const ok=await new GatewayPersonalWriter({gateway:draftBreaking(tieredGateway(goodNarrative,supportAll,bothWork),[aboutOnly,aboutOnly,null],seen),model:'fixture'}).generateProfile(twoMessages,new AbortController().signal,observing)
  assert.equal(seen.length,3);assert.ok(ok.about)
  const bad:{system:string;prompt:string}[]=[]
  await assert.rejects(new GatewayPersonalWriter({gateway:draftBreaking(tieredGateway(goodNarrative,supportAll,bothWork),[aboutOnly,aboutOnly,aboutOnly],bad),model:'fixture'}).generateProfile(twoMessages,new AbortController().signal,observing))
  assert.equal(bad.length,3)
})

test('a complete reply that omits work or interests is accepted without a retry',async()=>{
  const seen:{system:string;prompt:string}[]=[]
  const reply=JSON.stringify({about:{paragraphs:[{text:'你习惯先梳理再动手。',refs:['e0','e1']}]}})
  const result=await new GatewayPersonalWriter({gateway:draftBreaking(tieredGateway(goodNarrative,supportAll,bothWork),[reply],seen),model:'fixture'}).generateProfile(twoMessages,new AbortController().signal,observing)
  assert.equal(seen.length,1)
  assert.ok(result.about);assert.deepEqual(result.work,[]);assert.deepEqual(result.interests,[])
})

test('the draft and edit prompts require every top-level key and the schema lists them as required',async()=>{
  const seen:{system:string;prompt:string}[]=[]
  await new GatewayPersonalWriter({gateway:tieredGateway(goodNarrative,supportAll,bothWork,seen),model:'fixture'}).generateProfile(twoMessages,new AbortController().signal,observing)
  for(const marker of ['为本人写一份','统一修订整份画像'])assert.match(seen.find(request=>request.system.includes(marker))!.system,/不得省略任何键/u)
  const schema=(JSON.parse(seen.find(request=>request.system.includes('为本人写一份'))!.prompt) as {output_schema:{required:string[]}}).output_schema
  assert.ok(['about','work','interests','keywords'].every(key=>schema.required.includes(key)))
})

test('a work item that mostly restates the about paragraphs is dropped, a project-level one stays',async()=>{
  const aboutText='你把交互当成产品的核心逻辑，认为助手的成长来自有来有回的闭环。'
  const narrative:Narrative={about:{paragraphs:[{text:aboutText,refs:['e0','e1']}]},work:[
    {title:'交互闭环',text:'你把交互当成产品的核心逻辑，认为助手的成长来自有来有回的闭环。',refs:['e0','e1']},
    {title:'发布流程',text:'发布流程方案目前处于讨论阶段，计划先梳理上线检查清单再决定灰度节奏。',refs:['e0','e1']},
  ],interests:[]}
  const result=await new GatewayPersonalWriter({gateway:tieredGateway(narrative,supportAll,bothWork),model:'fixture'}).generateProfile(twoMessages,new AbortController().signal,observing)
  assert.deepEqual((result.work??[]).map(item=>item.title),['发布流程'])
})

const withKeywords=(keywords:{text:string;refs:string[]}[]):Narrative=>({...goodNarrative,keywords})
const runKeywords=async(keywords:{text:string;refs:string[]}[])=>new GatewayPersonalWriter({gateway:tieredGateway(withKeywords(keywords),supportAll,bothWork),model:'fixture'}).generateProfile(twoMessages,new AbortController().signal,observing)

test('keywords backed by two distinct originals are kept and one-original keywords are dropped',async()=>{
  const result=await runKeywords([{text:'先梳理再动手',refs:['e0','e1']},{text:'发布节奏',refs:['e0']}])
  assert.deepEqual((result.keywords??[]).map(item=>item.text),['先梳理再动手'])
  assert.equal(result.keywords![0]!.refs.length,2)
})

test('keywords are deduplicated case-insensitively and contained labels are dropped',async()=>{
  const result=await runKeywords([{text:'Agent Loop',refs:['e0','e1']},{text:'agent loop',refs:['e0','e1']},{text:'Agent Loop Design',refs:['e0','e1']},{text:'交互设计',refs:['e0','e1']},{text:'交互',refs:['e0','e1']}])
  assert.deepEqual((result.keywords??[]).map(item=>item.text).sort(),['Agent Loop Design','交互设计'].sort())
})

test('a reply without keywords is accepted and yields no keywords',async()=>{
  const result=await new GatewayPersonalWriter({gateway:tieredGateway(goodNarrative,supportAll,bothWork),model:'fixture'}).generateProfile(twoMessages,new AbortController().signal,observing)
  assert.ok(result.about)
  assert.equal(result.keywords,undefined)
})

test('keywords that are sentences, carry digits or status markers are rejected',async()=>{
  const result=await runKeywords([{text:'你习惯先梳理再动手然后再发布上线',refs:['e0','e1']},{text:'已上线方案',refs:['e0','e1']},{text:'这是一个很长的英文句子用来测试长度限制 really long sentence here',refs:['e0','e1']},{text:'计划优先',refs:['e0','e1']}])
  assert.deepEqual((result.keywords??[]).map(item=>item.text),['计划优先'])
})
