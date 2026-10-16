import {z} from 'zod'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import {lifeStateSchema} from '../personal-agent/life.js'

const counter=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const hubSnapshotSchema=z.object({
 schema_version:z.literal(1),hub_id:z.string().min(1),account_id:z.string().min(1),
 cursor:counter,state:lifeStateSchema,tombstones:z.record(z.string(),counter),
}).strict()
export const hubChangesSchema=z.object({
 schema_version:z.literal(1),account_id:z.string().min(1),cursor:counter,has_more:z.boolean(),
 events:z.array(z.object({seq:counter,device_id:z.string(),op_id:z.string(),result:z.object({id:z.string(),version:counter}),input:z.unknown()}).strict()).max(256),
}).strict()
const credentialsSchema=z.object({url:z.string(),token:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict()
export type HubCredentials=z.infer<typeof credentialsSchema>
function origin(value:string){
 let url:URL
 try{url=new URL(value)}catch{throw Error('hub_url_invalid')}
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||
  !(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw Error('hub_url_invalid')
 return url
}
/** Separate private credential file; never persist credentials in Life or sync state. */
export async function saveHubCredentials(path:string,raw:HubCredentials){
 let value:HubCredentials
 try{value=credentialsSchema.parse(raw)}catch{throw Error('hub_credentials_invalid')}
 origin(value.url)
 const store=new BoundedJsonStore(path,credentialsSchema.nullable(),8192)
 await store.read(null)
 await store.write(value)
}
export async function loadHubCredentials(path:string):Promise<HubCredentials|null>{
 const value=await new BoundedJsonStore(path,credentialsSchema.nullable(),8192).read(null)
 if(value)origin(value.url)
 return value
}
export class HubResponseError extends Error{
 constructor(readonly code:string,readonly snapshot?:z.infer<typeof hubSnapshotSchema>){super(code)}
}
const conflictCodes=new Set(['version_conflict','item_not_found','idea_not_found','item_deleted','goal_not_found','idea_archived','store_capacity','op_id_conflict','entity_id_conflict'])
export class LifeSyncTransport{
 readonly #url:URL
 readonly #token:string
 constructor(credentials:HubCredentials){
  try{credentialsSchema.parse(credentials)}catch{throw Error('hub_credentials_invalid')}
  this.#url=origin(credentials.url);this.#token=credentials.token
 }
 async #request(path:string,body?:unknown):Promise<unknown>{
  try{
   const response=await fetch(new URL('/hub/v1/'+path,this.#url),{
    method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+this.#token,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(15000),
   })
   // Bound decoded response bytes, including chunked/compressed responses.
   if(!response.body)throw Error('hub_response_invalid')
   const chunks:Uint8Array[]=[];let bytes=0
   const reader=response.body.getReader()
   try{for(;;){const result=await reader.read();if(result.done)break;const value:unknown=result.value;if(!(value instanceof Uint8Array))throw Error('hub_response_invalid');bytes+=value.length;if(bytes>16*1024*1024)throw Error('hub_response_too_large');chunks.push(value)}}
   finally{await reader.cancel().catch(()=>{/* release connection on rejection */})}
   const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'))
   if(!response.ok){
    const parsed=z.object({error:z.string(),snapshot:hubSnapshotSchema.optional()}).safeParse(value)
    if(response.status===409&&parsed.success&&conflictCodes.has(parsed.data.error)&&parsed.data.snapshot)throw new HubResponseError(parsed.data.error,parsed.data.snapshot)
    throw new HubResponseError(response.status===401?'unauthorized':'hub_request_failed')
   }
   return value
  }catch(error){
   if(error instanceof HubResponseError)throw error
   // Fetch/parse errors may contain URLs, headers or response data.
   throw Error('hub_transport_failed')
  }
 }
 async snapshot(){return checked(hubSnapshotSchema,await this.#request('state'))}
 async changes(after:number){counter.parse(after);return checked(hubChangesSchema,await this.#request('changes?after='+after))}
 async mutate(command:unknown){
  return checked(z.object({result:z.object({id:z.string(),version:counter}),snapshot:hubSnapshotSchema}).strict(),await this.#request('mutations',command))
 }
}

function checked<T>(schema:z.ZodType<T>,raw:unknown):T{
 const parsed=schema.safeParse(raw)
 if(!parsed.success)throw Error('hub_response_invalid')
 return parsed.data
}
