import test from 'node:test'
import assert from 'node:assert/strict'
import {completeConfiguredExperience} from '../src/main/experience-model.mjs'
test('configured experience completion uses the selected route and never exposes the key in its body',async()=>{
 const original=globalThis.fetch,calls=[]
 globalThis.fetch=async(url,options)=>{calls.push({url,options});return Response.json({id:'sample',choices:[{message:{content:'A grounded reply'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}})}
 try{
  const config={settings:{modelRoutes:{conversationText:{provider:'openai-compatible',model:'selected-model'}},cascadedLlmProvider:'deepseek',openaiCompatibleBaseUrl:'https://example.test/v1',openaiCompatibleProtocol:'chat-completions'},secrets:{openaiCompatibleApiKey:'selected-secret',deepseekApiKey:'unselected-secret'},environment:{}}
  const result=await completeConfiguredExperience(config,[{role:'system',content:'Synthetic context only'},{role:'user',content:'My question'}],new AbortController().signal)
  assert.equal(result,'A grounded reply');assert.equal(calls.length,1)
  assert.equal(String(calls[0].url),'https://example.test/v1/chat/completions')
  assert.equal(new Headers(calls[0].options.headers).get('authorization'),'Bearer selected-secret')
  const body=JSON.parse(calls[0].options.body);assert.equal(body.model,'selected-model');assert.equal(body.messages[0].content,'Synthetic context only')
  assert.ok(calls[0].options.body.includes('My question'));assert.equal(calls[0].options.body.includes('secret'),false)
  assert.equal(await completeConfiguredExperience({...config,secrets:{}},[],new AbortController().signal),null)
  assert.equal(calls.length,1)
  const legacy={settings:{pipelineMode:'integrated',cascadedLlmProvider:'deepseek',cascadedLlmModels:{deepseek:'deepseek-flash'}},secrets:{deepseekApiKey:'legacy-secret'},environment:{}}
  assert.equal(await completeConfiguredExperience(legacy,[{role:'user',content:'Legacy route'}],new AbortController().signal),'A grounded reply')
  assert.equal(new Headers(calls[1].options.headers).get('authorization'),'Bearer legacy-secret')
  assert.equal(JSON.parse(calls[1].options.body).model,'deepseek-flash')
  assert.equal(new URL(calls[1].url).hostname,'api.deepseek.com')
 }finally{globalThis.fetch=original}
})
