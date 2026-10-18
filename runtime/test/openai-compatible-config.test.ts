import assert from 'node:assert/strict'
import {test} from 'node:test'
import {loadSettings,describeMissingBlockingCredentials} from '../src/config/config.js'
import {requireSelectedCascadedLlmConfig,requireSelectedCascadedRealtimeConfig} from '../src/config/cascaded-realtime-config.js'
import {cascadedProviderRegistries} from '../src/composition/cascaded-realtime-assembly.js'
import {VirtualClock} from '../src/core/clock.js'

const environment={PIPELINE_MODE:'cascaded',CASCADE_LLM_PROVIDER:'openai-compatible',CASCADE_LLM_MODEL:'synthetic-model',OPENAI_COMPATIBLE_BASE_URL:'https://relay.example/api/v1/',OPENAI_COMPATIBLE_API_KEY:'llm-only'}
test('generic LLM routes its endpoint and dedicated credential without vendor fallback',()=>{
  const selected=requireSelectedCascadedLlmConfig(loadSettings(environment))
  assert.equal(selected.config.baseUrl,'https://relay.example/api/v1')
  assert.equal(selected.config.apiKey,'llm-only')
  assert.equal(selected.config.model,'synthetic-model')
  assert.throws(()=>requireSelectedCascadedLlmConfig(loadSettings({...environment,OPENAI_COMPATIBLE_API_KEY:'',OPENAI_API_KEY:'wrong',MODEL_API_KEY:'wrong'})),/OPENAI_COMPATIBLE_API_KEY/)
  assert.throws(()=>requireSelectedCascadedLlmConfig(loadSettings({...environment,CASCADE_LLM_MODEL:''})),/CASCADE_LLM_MODEL/)
})

test('production LLM registry honors the generic protocol selection',async()=>{
  const original=globalThis.fetch
  const urls:string[]=[]
  globalThis.fetch=(url)=>{
    const address=typeof url==='string'?url:url instanceof URL?url.href:url.url
    urls.push(address)
    const events=address.endsWith('/responses')
      ? [{type:'response.created',response:{id:'r'}},{type:'response.output_text.delta',delta:'OK'},{type:'response.completed',response:{id:'r',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}]}}]
      : [{id:'r',choices:[{delta:{content:'OK'},finish_reason:'stop'}]}]
    return Promise.resolve(new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}}))
  }
  try {
    for(const protocol of ['chat-completions','responses']) {
      const selected=requireSelectedCascadedLlmConfig(loadSettings({...environment,OPENAI_COMPATIBLE_PROTOCOL:protocol}))
      assert.notEqual(selected.provider,'ark')
      const session=cascadedProviderRegistries.llm.qwen({config:selected.config,clock:new VirtualClock(),ids:{next:()=> 'id'},instructions:'test'}).open()
      try {const events=[];for await(const e of session.stream({inputs:[{kind:'user_text',text:'hello'}],tools:[],signal:new AbortController().signal}))events.push(e);assert.ok(events.some(e=>e.kind==='response_completed'))}
      finally {await session.close()}
    }
    assert.deepEqual(urls,['https://relay.example/api/v1/chat/completions','https://relay.example/api/v1/responses'])
  } finally {globalThis.fetch=original}
})
test('generic stages resolve independent speech endpoints and keys',()=>{
  const settings=loadSettings({...environment,CASCADE_ASR_PROVIDER:'openai-compatible',CASCADE_TTS_PROVIDER:'openai-compatible',COMPATIBLE_ASR_BASE_URL:'https://recognition.example/v1',COMPATIBLE_ASR_API_KEY:'asr-only',COMPATIBLE_ASR_MODEL:'recognizer',COMPATIBLE_TTS_BASE_URL:'https://speech.example/v1',COMPATIBLE_TTS_API_KEY:'tts-only',COMPATIBLE_TTS_MODEL:'speaker',COMPATIBLE_TTS_VOICE:'voice'})
  const selected=requireSelectedCascadedRealtimeConfig(settings)
  assert.equal(selected.asr.endpoint,'https://recognition.example/v1')
  assert.equal(selected.asr.apiKey,'asr-only')
  assert.equal(selected.tts.endpoint,'https://speech.example/v1')
  assert.equal(selected.tts.apiKey,'tts-only')
  assert.deepEqual(describeMissingBlockingCredentials(settings).missing,[])
  assert.deepEqual(describeMissingBlockingCredentials(loadSettings({...environment,CASCADE_ASR_PROVIDER:'openai-compatible',CASCADE_TTS_PROVIDER:'openai-compatible'})).missing,['COMPATIBLE_ASR_API_KEY','COMPATIBLE_TTS_API_KEY'])
})
test('generic endpoints reject ambiguous credentials and protocol selection is explicit',()=>{
  for(const url of ['https://user:password@relay.example/v1','http://relay.example/v1','https://relay.example/v1?key=secret','https://relay.example/v1#x']) {
    assert.throws(()=>requireSelectedCascadedLlmConfig(loadSettings({...environment,OPENAI_COMPATIBLE_BASE_URL:url})))
  }
  assert.throws(()=>loadSettings({...environment,OPENAI_COMPATIBLE_PROTOCOL:'guess'}),/OPENAI_COMPATIBLE_PROTOCOL/)
})
