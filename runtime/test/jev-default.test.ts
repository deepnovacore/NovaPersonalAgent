/* eslint-disable @typescript-eslint/require-await */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {buildAssembly} from '../src/composition/assembly.js'
import type {ModelGateway,CompleteRequest} from '../src/model/model-gateway.js'
import {settingsSchema} from '../src/config/config.js'
import {decide} from '../src/model/jev-client.js'
import {createJevNewsRanker} from '../src/news/jev-ranking.js'
test('without an OpenRouter key news falls back to the support model visibly and the fallback can be turned off',async()=>{
 assert.equal(settingsSchema.parse({executors:[]}).openrouter_api_key,null)
 const calls:CompleteRequest[]=[]
 const article={id:'a',source_id:'bbc',title:'New voice model',summary:'A voice model can run offline.',url:'https://www.bbc.com/a',published_at:null,first_seen:new Date().toISOString(),content_hash:'h'}
 const gateway={complete:(request:CompleteRequest)=>{calls.push(request);return Promise.resolve({text:JSON.stringify(request.jsonSchema&&JSON.stringify(request.jsonSchema).includes('scores')?{scores:[{id:'a',matches:[{interest_id:'voice',score:0.9,quote:'New voice model'}],reason:'相关'}]}:{candidates:[{quote:'记下想法',occurrence:0,kind:'idea',text:'记下想法'}]})})}} as unknown as ModelGateway
 const build=(extra:Record<string,unknown>={})=>buildAssembly({settings:settingsSchema.parse({executors:[],support_model:'support-test',...extra}),gateway,cameraModuleEnabled:false,blackboard:{path:':memory:',ownerId:'test'}}).personalAgentConfig!.models
 const keyless=build()
 assert.ok(keyless.rankNewsFallback,'keyless assembly offers the support-model ranker')
 const rows=await keyless.rankNewsFallback!([{id:'voice',text:'语音模型',weight:1}],[article],new AbortController().signal)
 assert.ok(calls.length>0);assert.equal(calls[0]!.model,'support-test');assert.equal(rows[0]!.matches[0]!.interest_id,'voice')
 assert.deepEqual(Object.keys(JSON.parse(calls[0]!.prompt) as object).sort(),['articles','interests','output_schema'])
 // The plain ranker stays Jev: with fallback switched off the host calls it and it still refuses.
 const before=calls.length
 await assert.rejects(keyless.rankNews([],[],new AbortController().signal),/jev_not_configured/)
 assert.equal(calls.length,before,'Jev path never calls the chat model')
 const keyed=build({openrouter_api_key:'sk-test'})
 assert.equal(keyed.rankNewsFallback,undefined,'a configured key leaves Jev as the only news ranker')
 await assert.rejects(keyless.understand({id:'source',version:1,text:'记下想法',origin:'user'},new AbortController().signal),/jev_not_configured/)
 assert.equal(calls.at(-1)!.model,'support-test','understanding extracts with the shared LLM before Jev judgment')
})
test('typed transport rejects incomplete probability distributions',async()=>{
 const q={one:{type:'choice' as const,instructions:'test',criteria:{yes:'yes',no:'no'}}}
 await assert.rejects(decide({apiKey:'test',fetcher:async()=>Response.json({answers:{one:{type:'choice',choice:'yes',confidence:1,probabilities:{yes:1}}}})}, {},q,new AbortController().signal),/invalid_decision/)
})
test('news batches interest and substance judgments with original quote evidence',async()=>{
 const article={id:'a',source_id:'bbc',title:'New voice model',summary:'A voice model can run offline.',url:'https://www.bbc.com/a',published_at:null,first_seen:new Date().toISOString(),content_hash:'h'}
 let requests=0
 const rank=createJevNewsRanker({apiKey:'test',fetcher:async(_url,init)=>{
  requests++;const request=JSON.parse(init!.body as string) as {questions:Record<string,{criteria:Record<string,string>}>}
  return Response.json({answers:Object.fromEntries(Object.entries(request.questions).map(([id,q])=>{const choice=id.endsWith('substance')?'concrete':'relevant';return [id,{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===choice?1:0]))}]}))})
 }})
 const rows=await rank([{id:'voice',text:'语音模型',weight:1}],[article],new AbortController().signal)
 assert.equal(requests,1);assert.equal(rows[0]!.matches[0]!.quote,article.title);assert.equal(rows[0]!.judgment!.provider,'jev')
 assert.equal(rows[0]!.judgment!.probabilities.concrete,1)
})
