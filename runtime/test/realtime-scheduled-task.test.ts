import assert from 'node:assert/strict'
import {test} from 'node:test'
import {loadSettings} from '../src/config/config.js'
import {VirtualClock} from '../src/core/clock.js'
import {cascadedProviderRegistries} from '../src/composition/cascaded-realtime-assembly.js'
import {buildCascadedTextProvider} from '../src/cascaded-text-provider.js'
import {hostResponseIntentSchema} from '../src/realtime/protocol.js'

test('scheduled response exposes query tools while ordinary task continuation remains content-only',async()=>{
 for(const kind of ['scheduled_task','task_continuation'] as const){
  let sequence=0,tools:string[]=[],guidance=''
  const signal=new AbortController().signal,provider=buildCascadedTextProvider({settings:loadSettings({DASHSCOPE_API_KEY:'test',CASCADE_LLM_PROVIDER:'qwen'},true),clock:new VirtualClock(),idFactory:()=>String(++sequence)},{
   ...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({
    async *stream(input){tools=input.tools.map(tool=>tool.name);guidance=input.responseAdaptation??'';yield {kind:'response_started',response_id:'r'};yield {kind:'text_delta',text:'Review'};yield {kind:'response_completed',response_id:'r'}},
    abandonPendingResponse:async()=>{},close:async()=>{},
   })})},
  })
  try{
   await provider.connect({tools:[{type:'function',function:{name:'app__context',description:'Read current App state',parameters:{type:'object'}}}],signal})
   const item={kind:kind==='scheduled_task'?'scheduled_task' as const:'recovery' as const,host_item_id:'host:run',event_id:'host:run',call_id:null,content:JSON.stringify({purpose:kind==='scheduled_task'?'run_scheduled_task':'continue_authorized_task'})}
   const done=(async()=>{for await(const event of provider.events(signal))if((event as {kind:string}).kind==='response_terminal')return})()
   await provider.injectHostItem(item,{signal,confirmationTimeout:null,asUserActivation:false})
   await provider.createResponse(hostResponseIntentSchema.parse({kind,item}),signal);await done
   assert.deepEqual(tools,kind==='scheduled_task'?['app__context']:[])
   assert.match(guidance,kind==='scheduled_task'?/read.only/i:/content.only/i)
  }finally{await provider.close()}
 }
})
test('a narration recovery item cannot impersonate a scheduled activation',()=>{
 assert.equal(hostResponseIntentSchema.safeParse({kind:'scheduled_task',item:{kind:'recovery',host_item_id:'h',event_id:'h',call_id:null,content:'Old narration'}}).success,false)
})
