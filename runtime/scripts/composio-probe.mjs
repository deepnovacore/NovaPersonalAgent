import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {writeFile} from 'node:fs/promises'

export const VERSION = '20260915_00'
export const READ_TOOLS = ['GMAIL_GET_PROFILE','GMAIL_LIST_HISTORY','GMAIL_FETCH_EMAILS','GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID','GMAIL_LIST_LABELS','GOOGLECALENDAR_GET_CURRENT_USER','GOOGLECALENDAR_LIST_CALENDARS','GOOGLECALENDAR_EVENTS_LIST','GOOGLECALENDAR_EVENTS_GET','GOOGLECALENDAR_EVENTS_INSTANCES']
export const createBudget = () => ({requests:0,bytes:0,started:Date.now()})
export const effectiveKey = (setting,parent) => setting.kind==='cleared'?undefined:setting.kind==='saved'?setting.value:parent
export function toolContract(slug,{status,data}) {
  const schema=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&value.type==='object'
  if(status!==200||!READ_TOOLS.includes(slug)||data?.slug!==slug||data.version!==VERSION||!schema(data.input_parameters)||!schema(data.output_parameters))throw Error('invalid_tool_contract')
  const contract={slug,version:VERSION,input_parameters:data.input_parameters,output_parameters:data.output_parameters}
  return {...contract,schema_sha256:createHash('sha256').update(JSON.stringify(contract)).digest('hex')}
}
export function summarize({caseId,status,layer,checks={}}) {
  if (!/^[a-z-]{1,60}$/.test(caseId)||!['pass','fail','unobserved'].includes(status)||!['offline','live','catalog'].includes(layer)) throw Error('invalid_summary')
  for (const [key,value] of Object.entries(checks)) if(!/^[a-z_]{1,60}$/.test(key)||!(typeof value==='boolean'||typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)) throw Error('invalid_check')
  return {caseId,status,layer,checks}
}
export function classify(kind,status) {
  if(status===429)return 'rate_limited'
  if(status===403)return 'permission_denied'
  if(status===401)return 'authorization_required'
  if(kind==='gmail-history'&&status===404||kind==='calendar-events'&&status===410)return 'cursor_expired'
  if(kind==='gmail-message'&&status===404)return 'object_unavailable'
  return status>=200&&status<300?'ok':'unknown'
}
export async function requestJson(path,{method='GET',apiKey,signal,budget=createBudget(),body},fetcher=fetch) {
  if(method!=='GET'||!READ_TOOLS.some(slug=>path===`/api/v3.1/tools/${slug}?version=${VERSION}`))throw Error('route_denied')
  const abort=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(15000)])
  abort.throwIfAborted()
  if(budget.requests>=20||budget.bytes>=5*1024*1024||Date.now()-budget.started>=30000)throw Error('budget_exhausted')
  budget.requests++
  let reader
  try {
    const response=await fetcher(`https://backend.composio.dev${path}`,{method,redirect:'error',signal:abort,headers:{'x-api-key':apiKey,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
    if(response.status>=300&&response.status<400)throw Error('redirect_denied')
    if(Number(response.headers.get('Content-Length'))>2*1024*1024)throw Error('response_too_large')
    reader=response.body?.getReader()
    const parts=[];let size=0
    if(reader)for(;;){
      abort.throwIfAborted()
      let onAbort
      const cancelled=new Promise((_,reject)=>{onAbort=()=>reject(Error('request_aborted'));abort.addEventListener('abort',onAbort,{once:true})})
      let chunk
      try {chunk=await Promise.race([reader.read(),cancelled])}finally{abort.removeEventListener('abort',onAbort)}
      if(chunk.done)break
      size+=chunk.value.byteLength;budget.bytes+=chunk.value.byteLength
      if(size>2*1024*1024)throw Error('response_too_large')
      if(budget.bytes>5*1024*1024||Date.now()-budget.started>=30000)throw Error('budget_exhausted')
      parts.push(Buffer.from(chunk.value))
    }
    const result={status:response.status,data:null,retryAfter:response.headers.get('Retry-After')}
    try{return {...result,data:JSON.parse(Buffer.concat(parts).toString('utf8'))}}catch{return {...result,error:'invalid_json'}}
  }finally{if(reader)await reader.cancel().catch(()=>{})}
}
export async function executeRead(input,fetcher=fetch) {
  if(!READ_TOOLS.includes(input.slug))throw Error('tool_denied')
  if(input.version!==VERSION)throw Error('version_unpinned')
  // Live schemas and selected account/scope must be reviewed before enabling execution.
  // This probe deliberately cannot read mailbox contents before that gate is met.
  throw Error('live_contract_unverified')
}
async function main() {
  const mode=process.argv[2]
  if(mode!=='catalog')throw Error('usage: node runtime/scripts/composio-probe.mjs catalog')
  if(!process.env.COMPOSIO_API_KEY){console.log(JSON.stringify(summarize({caseId:'catalog',status:'unobserved',layer:'live',checks:{key_present:false}})));return}
  const budget=createBudget()
  const contracts=[]
  for(const slug of READ_TOOLS){
    const result=await requestJson(`/api/v3.1/tools/${slug}?version=${VERSION}`,{apiKey:process.env.COMPOSIO_API_KEY,budget})
    contracts.push(toolContract(slug,result))
    console.log(JSON.stringify(summarize({caseId:'catalog',status:'pass',layer:'live',checks:{http_status:result.status,schema_present:true}})))
  }
  if(process.argv[3])await writeFile(process.argv[3],JSON.stringify({checked_at:new Date().toISOString(),tool_version:VERSION,contracts},null,2)+'\n',{flag:'wx',mode:0o600})
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('composio_probe_failed');process.exitCode=1})
