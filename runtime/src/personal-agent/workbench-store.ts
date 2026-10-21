import {createHash,randomUUID} from 'node:crypto'
import {mkdir,open,rename,unlink} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {z} from 'zod'
import {resizeBase64ImageToJpeg,convertImgBufferToJpeg} from '@midscene/shared/img'
import {jsonValueSchema,type JsonValue} from '../core/events.js'
import {validateToolImage,type CascadedLlmInput} from '../realtime/cascaded/llm.js'
import type {ToolImage} from './computer-use/contract.js'
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
 z.object({kind:z.literal('tool_result'),call_id:z.string(),output:jsonValueSchema,images:z.array(z.custom<ToolImage>(value=>{try{validateToolImage(value as ToolImage);return true}catch{return false}})).optional()}).strict(),
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
  return this.#writeBytes(path,JSON.stringify(value))
 }
 #writeBytes(path:string,content:string|Uint8Array):Promise<void>{
  return this.#io(path,async()=>{
  await mkdir(dirname(path),{recursive:true,mode:0o700});const temporary=path+'.'+randomUUID()+'.tmp',file=await open(temporary,'wx',0o600)
  try{await file.writeFile(content);await file.sync();await file.close();await rename(temporary,path);if(process.platform!=='win32'){const folder=await open(dirname(path),'r');try{await folder.sync()}finally{await folder.close()}}}
  finally{await file.close().catch(()=>{ /* descriptor may already be closed */ });await unlink(temporary).catch(()=>{ /* rename already consumed the temporary */ })}
  })
 }
 #imagePath(id:string,generation:number,ref:string):string{
  if(!/^[a-f0-9]{64}\.(png|jpeg)$/u.test(ref))throw Error('invalid_image_ref')
  return join(this.root,'images-'+createHash('sha256').update(id+':'+generation).digest('hex'),ref)
 }
 async saveImage(id:string,generation:number,image:ToolImage):Promise<string>{
  validateToolImage(image)
  const bytes=Buffer.from(image.data_base64,'base64'),ref=createHash('sha256').update(bytes).update(JSON.stringify({...image,data_base64:''})).digest('hex')+'.'+(image.media_type==='image/png'?'png':'jpeg')
  const path=this.#imagePath(id,generation,ref)
  await this.#writeBytes(path,bytes)
  await this.#write(path+'.json',{...image,data_base64:undefined})
  return ref
 }
 async loadImage(id:string,generation:number,ref:string):Promise<ToolImage>{
  const path=this.#imagePath(id,generation,ref),metadata=await this.#read(path+'.json',4096)
  const file=await open(path,'r')
  try{
   if((await file.stat()).size>16*1024*1024)throw Error('workbench_image_capacity')
   return validateToolImage({...metadata as Omit<ToolImage,'data_base64'>,data_base64:(await file.readFile()).toString('base64')})
  }finally{await file.close()}
 }
 async thumbnail(id:string,generation:number,ref:string):Promise<ToolImage>{
  const image=await this.loadImage(id,generation,ref),scale=Math.min(1,480/Math.max(image.width,image.height))
  const width=Math.max(1,Math.round(image.width*scale)),height=Math.max(1,Math.round(image.height*scale))
  const resized=await resizeBase64ImageToJpeg('data:'+image.media_type+';base64,'+image.data_base64,{sourceSize:{width:image.width,height:image.height},targetSize:{width,height},jpegQuality:60})
  // Re-encode even unchanged JPEGs to strip oversized source metadata.
  const bytes=await convertImgBufferToJpeg(Buffer.from(resized.slice(resized.indexOf(',')+1),'base64'),60)
  const thumbnail:ToolImage={media_type:'image/jpeg',data_base64:bytes.toString('base64'),width,height,captured_at:image.captured_at}
  if(Buffer.byteLength(JSON.stringify(thumbnail))>200_000)throw Error('workbench_thumbnail_capacity')
  return thumbnail
 }
 async #images(value:unknown,id:string,generation:number,restore:boolean):Promise<unknown>{
  if(Array.isArray(value))return Promise.all(value.map(item=>this.#images(item,id,generation,restore)))
  if(value===null||typeof value!=='object')return value
  const item=value as Record<string,unknown>
  if(restore&&typeof item.workbench_image_ref==='string'){
   const image=await this.loadImage(id,generation,item.workbench_image_ref)
   return item.encoding==='data_url'?'data:'+image.media_type+';base64,'+image.data_base64:image
  }
  if(!restore&&typeof item.data_base64==='string'&&(item.media_type==='image/png'||item.media_type==='image/jpeg')&&typeof item.width==='number'&&typeof item.height==='number'&&typeof item.captured_at==='string'){
   return {workbench_image_ref:await this.saveImage(id,generation,item as unknown as ToolImage),encoding:'tool_image'}
  }
  const entries=await Promise.all(Object.entries(item).map(async([key,entry])=>{
   if(!restore&&(key==='url'||key==='image_url')&&typeof entry==='string'&&/^data:image\/(png|jpeg);base64,/u.test(entry)){
    const [prefix,data_base64]=entry.split(',')
    const image:ToolImage={media_type:prefix!.includes('png')?'image/png':'image/jpeg',data_base64:data_base64!,width:1,height:1,captured_at:'1970-01-01T00:00:00Z'}
    return [key,{workbench_image_ref:await this.saveImage(id,generation,image),encoding:'data_url'}]
   }
   return [key,await this.#images(entry,id,generation,restore)]
  }))
  return Object.fromEntries(entries)
 }
 async plan(id:string,version:number):Promise<WorkbenchPlan>{const value=planSchema.parse(await this.#read(this.#file('plan',id+':'+version)));if(value.id!==id||value.version!==version)throw Error('plan_version_conflict');return value}
 async savePlan(plan:WorkbenchPlan):Promise<void>{await this.#write(this.#file('plan',plan.id+':'+plan.version),planSchema.parse(plan))}
 #readCheckpoint(id:string,generation:number):Promise<unknown>{
  const path=this.#file('build',id+':'+generation)
  return this.#io(path+':images',()=>this.#read(path))
 }
 async checkpoint(id:string,generation:number):Promise<WorkbenchCheckpoint>{
  const value=await this.#images(await this.#readCheckpoint(id,generation),id,generation,true)
  if(value===null)return emptyWorkbenchCheckpoint(id,generation)
  const checked=z.object({version:z.literal(1),conversation_id:z.literal(id),generation:z.literal(generation),run_version:z.number().int().nonnegative(),status:buildStatusSchema,reason:z.string().nullable(),model:jsonValueSchema.nullable(),inputs:z.array(inputSchema),pending_calls:z.array(callSchema),calls:z.array(callSchema),last_user:z.string(),assistant:z.string(),updated_at:z.string(),model_failure:z.object({code:z.string().regex(/^[a-z_]{1,64}$/u),detail:z.string().regex(/^[a-z_]{1,64}$/u).optional(),tool_call_count:z.number().int().nonnegative().max(128).optional()}).strict().optional()}).strict().parse(value)
  const calls=new Map(checked.calls.map(call=>[call.id,call]));if(calls.size!==checked.calls.length)throw Error('duplicate_tool_call')
  checked.pending_calls=checked.pending_calls.map(call=>{const prior=calls.get(call.id);if(prior?.name!==call.name||JSON.stringify(prior.arguments)!==JSON.stringify(call.arguments))throw Error('tool_call_id_conflict');return prior})
  return checked as WorkbenchCheckpoint
 }
 async saveCheckpoint(checkpoint:WorkbenchCheckpoint):Promise<void>{
  const snapshot=structuredClone(checkpoint),path=this.#file('build',snapshot.conversation_id+':'+snapshot.generation)
  await this.#io(path+':images',async()=>this.#write(path,await this.#images(snapshot,snapshot.conversation_id,snapshot.generation,false)))
 }
 async resetCheckpoint(id:string,generation:number):Promise<void>{
  const previous=await this.checkpoint(id,generation)
  if(previous.model!==null||previous.inputs.length)await this.#write(this.#file('archive',id+':'+generation+':'+randomUUID()),await this.#images(previous,id,generation,false))
  await this.saveCheckpoint(emptyWorkbenchCheckpoint(id,generation))
 }
 async detail(id:string,generation:number,offset=0):Promise<{text:string;next_offset:number|null}>{const value=JSON.stringify(await this.#readCheckpoint(id,generation)??emptyWorkbenchCheckpoint(id,generation),null,2);return {text:value.slice(offset,offset+6000),next_offset:offset+6000<value.length?offset+6000:null}}
 async saveReply(id:string,generation:number,messageId:string,text:string):Promise<void>{if(Buffer.byteLength(text)>32*1024*1024)throw Error('workbench_reply_capacity');await this.#write(this.#file('reply',`${id}:${generation}:${messageId}`),{conversation_id:id,generation,message_id:messageId,text})}
 async reply(id:string,generation:number,messageId:string,offset=0):Promise<{text:string;next_offset:number|null}>{const value=await this.#read(this.#file('reply',`${id}:${generation}:${messageId}`),128*1024*1024);if(!value||typeof value!=='object')throw Error('workbench_reply_not_found');const checked=z.object({conversation_id:z.literal(id),generation:z.literal(generation),message_id:z.literal(messageId),text:z.string().max(32*1024*1024)}).strict().parse(value),size=24000;let end=Math.min(checked.text.length,offset+size);if(end<checked.text.length&&end>offset){const previous=checked.text.charCodeAt(end-1),next=checked.text.charCodeAt(end);if(previous>=0xd800&&previous<=0xdbff&&next>=0xdc00&&next<=0xdfff)end--}return {text:checked.text.slice(offset,end),next_offset:end<checked.text.length?end:null}}
 async calls(id:string,generation:number,offset=0){
  const raw=await this.#readCheckpoint(id,generation),state=raw===null?emptyWorkbenchCheckpoint(id,generation):z.object({calls:z.array(callSchema)}).parse(raw) as Pick<WorkbenchCheckpoint,'calls'>,items:ReturnType<typeof workbenchCallPreview>[]=[]
  let bytes=0,index=offset
  for(const call of state.calls.slice(offset,offset+4)){
   const item=workbenchCallPreview(call,index),size=Buffer.byteLength(JSON.stringify(item))
   if(items.length&&bytes+size>10000)break
   items.push(item);bytes+=size;index++
  }
  return {items,total:state.calls.length,next_offset:index<state.calls.length?index:null,generation}
 }
}

function firstImageRef(value:JsonValue|undefined):string|null{
 if(value===null||typeof value!=='object')return null
 if(!Array.isArray(value)){
  const ref=value.workbench_image_ref??value.image_ref
  if(typeof ref==='string'&&/^[a-f0-9]{64}\.(png|jpeg)$/u.test(ref))return ref
 }
 for(const child of Object.values(value)){const ref=firstImageRef(child);if(ref)return ref}
 return null
}

/** Small, display-only projections. Full arguments and results remain in the private journal. */
export function workbenchCallPreview(call:WorkbenchCall,sequence:number){
 const result=call.result&&typeof call.result==='object'&&!Array.isArray(call.result)?call.result:{}
 const status=call.state==='completed'?typeof result.status==='string'?result.status:result.code?'failed':result.state==='refused'||result.accepted===false?'refused':'completed':call.state
 const target=call.arguments.path??call.arguments.command
 const input=JSON.stringify(call.arguments,null,2),output=call.result===undefined?'':JSON.stringify(call.result,null,2)
 return {image_ref:firstImageRef(call.result),sequence,id:call.id.slice(0,512),name:call.name.slice(0,128),message_id:call.message_id??null,state:call.state,status,
  target:typeof target==='string'?target.slice(0,180):'',input:input.slice(0,500),output:output.slice(0,700),
  input_truncated:input.length>500,output_truncated:output.length>700||result.truncated===true,
  exit_code:typeof result.exit_code==='number'?result.exit_code:null,
  created_at:call.created_at??call.started_at??null,started_at:call.started_at??null,finished_at:call.finished_at??null}
}
