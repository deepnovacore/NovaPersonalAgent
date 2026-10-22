import {createHash,randomUUID} from 'node:crypto'
import {mkdir,open,rename,unlink} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {z} from 'zod'
import {jsonValueSchema,type JsonValue} from '../core/events.js'
import type {CascadedLlmInput} from '../realtime/cascaded/llm.js'
import type {LocalShellProcess} from './local-shell.js'

export const planSchema=z.object({id:z.string(),version:z.number().int().positive(),title:z.string().min(1).max(120),content:z.string().min(1).max(131072),conversation_id:z.string(),generation:z.number().int().nonnegative(),created_at:z.string(),publication_key:z.string().optional()}).strict()
export type WorkbenchPlan=z.infer<typeof planSchema>
export const buildStatusSchema=z.enum(['idle','running','awaiting_approval','paused','completed','failed','outcome_unknown','finished'])
export type BuildStatus=z.infer<typeof buildStatusSchema>
export interface WorkbenchCall {id:string;name:string;arguments:Record<string,JsonValue>;state:'prepared'|'awaiting_approval'|'running'|'completed';result?:JsonValue;message_id?:string;created_at?:string;approval_id?:string;started_at?:string;finished_at?:string;process?:LocalShellProcess}
export interface WorkbenchCheckpoint {
 version:1;conversation_id:string;generation:number;run_version:number;status:BuildStatus;reason:string|null;model:JsonValue|null;
 inputs:CascadedLlmInput[];pending_calls:WorkbenchCall[];calls:WorkbenchCall[];last_user:string;assistant:string;updated_at:string
 model_failure?:{code:string;detail?:string;tool_call_count?:number}
}
const callSchema=z.object({id:z.string().min(1),name:z.string().min(1),arguments:z.record(z.string(),jsonValueSchema),state:z.enum(['prepared','awaiting_approval','running','completed']),result:jsonValueSchema.optional(),message_id:z.string().optional(),created_at:z.string().optional(),approval_id:z.string().optional(),started_at:z.string().optional(),finished_at:z.string().optional(),process:z.object({platform:z.enum(['darwin','win32']),pid:z.number().int().positive()}).strict().optional()}).strict()
const inputSchema=z.union([
 z.object({kind:z.literal('user_text'),text:z.string()}).strict(),
 z.object({kind:z.enum(['host_context','host_task','host_activation','packed_history']),content:z.string()}).strict(),
 z.object({kind:z.literal('tool_result'),call_id:z.string(),output:jsonValueSchema}).strict(),
])
export function emptyWorkbenchCheckpoint(conversation_id:string,generation:number):WorkbenchCheckpoint{return {version:1,conversation_id,generation,run_version:0,status:'idle',reason:null,model:null,inputs:[],pending_calls:[],calls:[],last_user:'',assistant:'',updated_at:new Date().toISOString()}}
/** Durable private state is separate from the bounded UI transcript. Never stores model credentials. */
const storeOperations=new Map<string,Promise<void>>()
export class WorkbenchStore {
 constructor(readonly root:string){}
 #file(kind:string,id:string):string{return join(this.root,kind+'-'+createHash('sha256').update(id).digest('hex')+'.json')}
 async #io<T>(path:string,operation:()=>Promise<T>):Promise<T>{
  const key=process.platform==='win32'?resolve(path).toLowerCase():resolve(path)
  const pending=(storeOperations.get(key)??Promise.resolve()).then(operation),tail=pending.then(()=>{ /* release the next reader or writer */ },()=>{ /* a failed access must not block later receipts */ })
  storeOperations.set(key,tail)
  try{return await pending}finally{if(storeOperations.get(key)===tail)storeOperations.delete(key)}
 }
 async #read(path:string,maxBytes=64*1024*1024):Promise<unknown>{return this.#io(path,async()=>{try{const file=await open(path,'r');try{if((await file.stat()).size>maxBytes)throw Error('workbench_store_capacity');return JSON.parse(await file.readFile('utf8')) as unknown}finally{await file.close()}}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}})}
 #write(path:string,value:unknown):Promise<void>{
  // Capture before queuing: later tool completions must not rewrite an earlier receipt.
  const content=JSON.stringify(value)
  return this.#io(path,async()=>{
  await mkdir(dirname(path),{recursive:true,mode:0o700});const temporary=path+'.'+randomUUID()+'.tmp',file=await open(temporary,'wx',0o600)
  try{await file.writeFile(content);await file.sync();await file.close();await rename(temporary,path);if(process.platform!=='win32'){const folder=await open(dirname(path),'r');try{await folder.sync()}finally{await folder.close()}}}
  finally{await file.close().catch(()=>{ /* descriptor may already be closed */ });await unlink(temporary).catch(()=>{ /* rename already consumed the temporary */ })}
  })
 }
 async plan(id:string,version:number):Promise<WorkbenchPlan>{const value=planSchema.parse(await this.#read(this.#file('plan',id+':'+version)));if(value.id!==id||value.version!==version)throw Error('plan_version_conflict');return value}
 async savePlan(plan:WorkbenchPlan):Promise<void>{await this.#write(this.#file('plan',plan.id+':'+plan.version),planSchema.parse(plan))}
 async checkpoint(id:string,generation:number):Promise<WorkbenchCheckpoint>{
  const value=await this.#read(this.#file('build',id+':'+generation))
  if(value===null)return emptyWorkbenchCheckpoint(id,generation)
  const checked=z.object({version:z.literal(1),conversation_id:z.literal(id),generation:z.literal(generation),run_version:z.number().int().nonnegative(),status:buildStatusSchema,reason:z.string().nullable(),model:jsonValueSchema.nullable(),inputs:z.array(inputSchema),pending_calls:z.array(callSchema),calls:z.array(callSchema),last_user:z.string(),assistant:z.string(),updated_at:z.string(),model_failure:z.object({code:z.string().regex(/^[a-z_]{1,64}$/u),detail:z.string().regex(/^[a-z_]{1,64}$/u).optional(),tool_call_count:z.number().int().nonnegative().max(128).optional()}).strict().optional()}).strict().parse(value)
  const calls=new Map(checked.calls.map(call=>[call.id,call]));if(calls.size!==checked.calls.length)throw Error('duplicate_tool_call')
  checked.pending_calls=checked.pending_calls.map(call=>{const prior=calls.get(call.id);if(prior?.name!==call.name||JSON.stringify(prior.arguments)!==JSON.stringify(call.arguments))throw Error('tool_call_id_conflict');return prior})
  return checked as WorkbenchCheckpoint
 }
 async saveCheckpoint(checkpoint:WorkbenchCheckpoint):Promise<void>{await this.#write(this.#file('build',checkpoint.conversation_id+':'+checkpoint.generation),checkpoint)}
 async resetCheckpoint(id:string,generation:number):Promise<void>{
  const previous=await this.checkpoint(id,generation)
  if(previous.model!==null||previous.inputs.length)await this.#write(this.#file('archive',id+':'+generation+':'+randomUUID()),previous)
  await this.saveCheckpoint(emptyWorkbenchCheckpoint(id,generation))
 }
 async detail(id:string,generation:number,offset=0):Promise<{text:string;next_offset:number|null}>{const value=JSON.stringify(await this.checkpoint(id,generation),null,2);return {text:value.slice(offset,offset+6000),next_offset:offset+6000<value.length?offset+6000:null}}
 async saveReply(id:string,generation:number,messageId:string,text:string):Promise<void>{if(Buffer.byteLength(text)>32*1024*1024)throw Error('workbench_reply_capacity');await this.#write(this.#file('reply',`${id}:${generation}:${messageId}`),{conversation_id:id,generation,message_id:messageId,text})}
 async reply(id:string,generation:number,messageId:string,offset=0):Promise<{text:string;next_offset:number|null}>{const value=await this.#read(this.#file('reply',`${id}:${generation}:${messageId}`),128*1024*1024);if(!value||typeof value!=='object')throw Error('workbench_reply_not_found');const checked=z.object({conversation_id:z.literal(id),generation:z.literal(generation),message_id:z.literal(messageId),text:z.string().max(32*1024*1024)}).strict().parse(value),size=24000;let end=Math.min(checked.text.length,offset+size);if(end<checked.text.length&&end>offset){const previous=checked.text.charCodeAt(end-1),next=checked.text.charCodeAt(end);if(previous>=0xd800&&previous<=0xdbff&&next>=0xdc00&&next<=0xdfff)end--}return {text:checked.text.slice(offset,end),next_offset:end<checked.text.length?end:null}}
 async calls(id:string,generation:number,offset=0){
  const state=await this.checkpoint(id,generation),items:ReturnType<typeof workbenchCallPreview>[]=[]
  let bytes=0,index=offset
  for(const call of state.calls.slice(offset,offset+4)){
   const item=workbenchCallPreview(call,index),size=Buffer.byteLength(JSON.stringify(item))
   if(items.length&&bytes+size>10000)break
   items.push(item);bytes+=size;index++
  }
  return {items,total:state.calls.length,next_offset:index<state.calls.length?index:null,generation}
 }
}

/** Small, display-only projections. Full arguments and results remain in the private journal. */
export function workbenchCallPreview(call:WorkbenchCall,sequence:number){
 const result=call.result&&typeof call.result==='object'&&!Array.isArray(call.result)?call.result:{}
 const status=call.state==='completed'?typeof result.status==='string'?result.status:result.code?'failed':result.state==='refused'||result.accepted===false?'refused':'completed':call.state
 const target=call.arguments.path??call.arguments.command
 const input=JSON.stringify(call.arguments,null,2),output=call.result===undefined?'':JSON.stringify(call.result,null,2)
 return {sequence,id:call.id.slice(0,512),name:call.name.slice(0,128),message_id:call.message_id??null,state:call.state,status,
  target:typeof target==='string'?target.slice(0,180):'',input:input.slice(0,500),output:output.slice(0,700),
  input_truncated:input.length>500,output_truncated:output.length>700||result.truncated===true,
  exit_code:typeof result.exit_code==='number'?result.exit_code:null,
  created_at:call.created_at??call.started_at??null,started_at:call.started_at??null,finished_at:call.finished_at??null}
}
