import {createServer} from 'node:http'
import {randomBytes, timingSafeEqual} from 'node:crypto'
import {once} from 'node:events'

const OMIT = ['background','conversation','max_output_tokens','max_tool_calls','metadata','moderation','multi_agent','prompt','prompt_cache_retention','safety_identifier','temperature','top_logprobs','top_p','truncation','user','previous_response_id']
export function chatGptRequest(body) {
  if(!body||typeof body!=='object'||Array.isArray(body)||!Array.isArray(body.input)||typeof body.model!=='string')throw Error('invalid_request')
  const result={...body,store:false,stream:true}
  for(const key of OMIT)delete result[key]
  result.input=body.input.map(item=>item?.role==='system'?{...item,role:'developer'}:item)
  const tools=body.tools??[]
  if(!Array.isArray(tools))throw Error('unsupported_tools')
  const flat=tools.filter(t=>['function','custom'].includes(t?.type))
  const grouped=tools.filter(t=>!['function','custom'].includes(t?.type))
  for(const tool of grouped)if(!['namespace','web_search'].includes(tool?.type)||tool.type==='namespace'&&(!Array.isArray(tool.tools)||tool.tools.some(t=>!['function','custom'].includes(t?.type))))throw Error('unsupported_tools')
  result.tools=[...grouped,...(flat.length?[{type:'namespace',name:'nova',description:'Nova local tools',tools:flat}]:[])]
  return result
}

/** Local capability token authenticates clients; only main owns the renewable OAuth grant. */
export async function createChatGptBroker({accounts,fetcher=fetch}) {
  const secret=randomBytes(32).toString('hex'),active=new Set()
  const server=createServer((request,response)=>{void handle(request,response)})
  async function handle(request,response){
    const controller=new AbortController();active.add(controller)
    response.once('close',()=>controller.abort())
    const timeout=setTimeout(()=>controller.abort(),10*60_000);timeout.unref()
    try{
      const provided=Buffer.from(request.headers.authorization??''),expected=Buffer.from(`Bearer ${secret}`)
      if(request.headers.origin||provided.length!==expected.length||!timingSafeEqual(provided,expected)){response.writeHead(401);response.end();return}
      if(request.method!=='POST'||request.url!=='/v1/responses'){response.writeHead(404);response.end();return}
      let bytes=0;const chunks=[]
      for await(const chunk of request){bytes+=chunk.length;if(bytes>8*1024*1024)throw Error('request_too_large');chunks.push(chunk)}
      const body=chatGptRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const selected=accounts.view().active
      const token=await accounts.accessToken()
      if(selected!==accounts.view().active)throw Error('chatgpt_account_changed')
      const model=accounts.view().model
      if(!model)throw Error('chatgpt_model_required')
      body.model=model
      if(controller.signal.aborted)throw Error('aborted')
      const upstream=await fetcher('https://api.openai.com/v1/responses',{method:'POST',redirect:'error',signal:controller.signal,
        headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'text/event-stream'},body:JSON.stringify(body)})
      response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json','cache-control':'no-store',...(upstream.headers.get('x-request-id')?{'x-request-id':upstream.headers.get('x-request-id')}:{})})
      if(upstream.body)for await(const chunk of upstream.body){if(!response.write(chunk))await once(response,'drain',{signal:controller.signal})}
      response.end()
    }catch(error){if(response.headersSent)response.destroy();else{response.writeHead(error.message==='unsupported_tools'?400:503,{'content-type':'application/json'});response.end(JSON.stringify({error:{code:'chatgpt_request_failed',message:'ChatGPT request unavailable. Check sign-in, permissions and usage in settings.'}}))}}
    finally{clearTimeout(timeout);active.delete(controller)}
  }
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  server.unref()
  return {baseUrl:`http://127.0.0.1:${server.address().port}/v1`,secret,
    cancel(){for(const c of active)c.abort()},close(){for(const c of active)c.abort();server.closeAllConnections();server.close()}}
}

export function applyChatGptEnvironment(env,view,broker){
  const model=view.model||'chatgpt-model-selection-required'
  if(view.useModels){
    Object.assign(env,{CASCADE_LLM_PROVIDER:'openai-compatible',OPENAI_COMPATIBLE_BASE_URL:broker.baseUrl,OPENAI_COMPATIBLE_API_KEY:broker.secret,OPENAI_COMPATIBLE_PROTOCOL:'responses',CASCADE_LLM_MODEL:model,
      MODEL_API_KEY:'',WATCH_MODEL:model,SUPPORT_MODEL:model,PLANNER_MODEL:model,COMPRESSOR_MODEL:model})
  }
  if(view.useCodex)Object.assign(env,{CODEX_API_KEY:broker.secret,NOVA_CODEX_RESPONSES_PROXY:broker.baseUrl})
  return env
}
