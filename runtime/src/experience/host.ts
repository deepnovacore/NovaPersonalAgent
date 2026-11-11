import {createHash,randomUUID} from 'node:crypto'
import {readFile,writeFile,rename} from 'node:fs/promises'
import {z} from 'zod'
import {PersonalAgentHost} from '../personal-agent/host.js'
import {resolvedTimeSchema} from '../personal-agent/timeline-time.js'
import {timelineReplySchema} from '../personal-agent/timeline-brief.js'
import {SuggestionPool} from '../core/suggestions.js'
import type {JsonValue} from '../core/events.js'

const recordSchema=z.object({id:z.string().min(1),source_id:z.string(),kind:z.string(),text:z.string(),observed_at:z.string()}).passthrough()
const attributionSchema=z.object({sender_name:z.string().max(200).optional(),thread_id:z.string().max(600).optional()})
const memorySchema=z.object({key:z.string().optional(),text:z.string(),kind:z.string().optional(),source:z.string().optional(),quote:z.string().optional()})
const cardSchema=z.object({title:z.string().max(500),text:z.string().max(16000).optional(),summary:z.string().max(16000).optional(),refs:z.array(z.string()).max(100),time:resolvedTimeSchema.optional()})
const timelineCardSchema=cardSchema.extend(timelineReplySchema.shape.cards.element.pick({temporal:true,kind:true,status_label:true,people:true,category:true,why_now:true,facts:true,next_steps:true,uncertainty:true,actions:true}).partial().shape)
const snapshotSchema=z.object({source_version:z.string().optional(),profile:z.array(cardSchema).max(100),timeline:z.array(timelineCardSchema).max(200)})
export interface ExperienceHostOptions {
 path:string;personaId:string;name:string;sourceVersion:string;profile:unknown;records:unknown[];memory:unknown[];snapshot:unknown
 complete:(messages:{role:string;content:string}[],signal:AbortSignal)=>Promise<string>
 refresh:(sourceVersion:string,signal:AbortSignal)=>Promise<unknown>
 emit:(frame:Record<string,unknown>)=>void
}
/** One real host and its durable stores per persona; no provider or connector is inherited. */
export async function createExperienceHost(options:ExperienceHostOptions){
 const records=z.array(recordSchema).max(100000).parse(options.records),byId=new Map(records.map(row=>[row.id,row]))
 if(byId.size!==records.length)throw Error('experience_source_invalid')
 const contextRecords=records.map(({id,kind,text,observed_at,metadata})=>({id,kind,text,observed_at,...attributionSchema.safeParse(metadata).data}))
 const memories=z.array(memorySchema).max(10000).parse(options.memory)
 const sourceVersion=z.string().regex(/^[0-9a-f]{64}$/).parse(options.sourceVersion)
 const original=snapshotSchema.parse(options.snapshot),projectionPath=options.path+'.experience.json'
 if(original.source_version!==sourceVersion)throw Error('experience_source_version_mismatch')
 let projection=original,revision=0,closed=false,refreshing=false,generation=1
 const abort=new AbortController()
 const validateRefs=(value:z.infer<typeof snapshotSchema>)=>{
  for(const row of [...value.profile,...value.timeline])if(row.refs.some(id=>!byId.has(id)))throw Error('experience_reference_invalid')
  for(const row of value.timeline)for(const claim of [...row.facts??[],...row.people??[],...row.temporal?.dates??[]])if(!row.refs.includes(claim.ref)||!byId.get(claim.ref)?.text.includes(claim.quote))throw Error('experience_reference_invalid')
  return value
 }
 validateRefs(original)
 let saved:string|undefined
 try{saved=await readFile(projectionPath,'utf8')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 if(saved!==undefined){
  try{const parsed=snapshotSchema.parse(JSON.parse(saved));if(parsed.source_version!==sourceVersion)throw Error('experience_source_version_mismatch');projection=validateRefs(parsed)}
  catch{await rename(projectionPath,projectionPath+'.recovery-'+randomUUID());projection=original}
 }
 const timelineVersion=(row:z.infer<typeof cardSchema>)=>createHash('sha256').update(sourceVersion+JSON.stringify(row)).digest('hex')
 class ExperiencePersonalHost extends PersonalAgentHost {
  override async discussionContext(references:Parameters<PersonalAgentHost['discussionContext']>[0]){
   if(!references.some(ref=>ref.kind==='timeline'))return super.discussionContext(references)
   const material:string[]=[],evidenceRefs:string[]=[];let sourceTodo:{id:string;version:number}|undefined
   for(const ref of references){
    if(ref.kind==='timeline'){
     const card=projection.timeline.find((row,index)=>ref.id==='experience:'+index&&ref.version===timelineVersion(row))
     if(!card)throw Error('stale_reference')
     material.push(JSON.stringify({kind:'timeline',card,originals:card.refs.map(id=>byId.get(id))}));evidenceRefs.push(...card.refs)
    }else{const context=await super.discussionContext([ref]);if(context.prepared){material.push(context.prepared.text);evidenceRefs.push(...context.prepared.evidence_refs)}sourceTodo??=context.source_todo}
   }
   if(new Set(evidenceRefs).size>16)throw Error('reference_evidence_limit')
   return {references,...(sourceTodo?{source_todo:sourceTodo}:{}),prepared:{trust:'untrusted_external' as const,text:material.join('\n').slice(0,12000),evidence_refs:[...new Set(evidenceRefs)]}}
  }
 }
 const host=new ExperiencePersonalHost({path:options.path,userScope:'experience:'+options.personaId,memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const source=(id:string)=>{const row=byId.get(id);return row?{id:row.id,evidence_id:row.id,type:['mail','calendar','im'].includes(row.kind)?row.kind:'file',label:row.source_id,summary:row.text,observed_at:row.observed_at}:null}
 const snapshot=()=>{
  const state=host.snapshot(),asOf=records.map(row=>row.observed_at.slice(0,10)).sort().at(-1)??new Date().toISOString().slice(0,10)
  const refs=(ids:string[])=>ids.map(entry_id=>({entry_id,version:'1'}))
  return {...state,revision:++revision,experience:{persona_id:options.personaId,name:options.name,source_version:sourceVersion},
   profile_preparation:{status:refreshing?'working':'ready',sources:records.map(row=>({id:row.id,label:row.source_id+' · '+row.text,available:true})),draft:{about:null,work:projection.profile.map(row=>({title:row.title,text:row.text??row.summary??'',refs:refs(row.refs)})),interests:[]}},
   timeline:{status:refreshing?'working':'ready',available:true,input_count:records.length,generation_id:String(generation),cards:projection.timeline.map((row,index)=>({...row,id:'experience:'+index,version:timelineVersion(row),kind:row.kind??'insight',category:row.category??'',why_now:row.why_now??row.summary??row.text??'',facts:row.facts??[],time:row.time??{as_of:asOf,kind:'event',last_reported_on:row.refs.map(id=>byId.get(id)!.observed_at.slice(0,10)).sort().at(-1)??asOf},sources:row.refs.map(source),actions:row.actions??[{kind:'discuss',label:'讨论这件事'},{kind:'draft',label:'起草内容'}]}))},
   memory:{entries:memories.map((value,index)=>({...value,id:value.key??String(index),content:value.text,origin:'observed',editable:false,source_refs:value.source?[{type:'file',ref:value.source}]:[],status:'active',version:1}))},
   capabilities:{...state.capabilities,schedules:false,memory:{...state.capabilities.memory,list:true}},
   sources:records.map(row=>({id:row.id,label:row.source_id,kind:row.kind,status:'ready',available:true}))}
 }
 const publish=()=>{if(!closed)options.emit(snapshot())}
 host.subscribe(publish)
 host.setConversationRuntime(async(conversation,_emit,mode)=>{
  if(mode==='voice')throw Error('experience_text_only')
  const history=conversation.messages.filter(message=>message.role==='assistant'||message.generation_status==='completed').map(message=>({role:message.role,content:message.text}))
  return {runTurn:async(text,signal,context)=>{
   const contextProjection={...projection,timeline:projection.timeline.map(row=>({title:row.title,summary:row.why_now??row.summary??row.text,refs:row.refs,time:row.time,status_label:row.status_label,next_steps:row.next_steps,uncertainty:row.uncertainty}))}
   const messages=[{role:'system',content:'You are NovaCore. This is a synthetic experience Space. Answer using its supplied context only. Do not claim that you performed actions.\n'+JSON.stringify({profile:options.profile,memory:options.memory,profile_snapshot:contextProjection,referenced_material:context?.prepared,life:host.life.snapshot(),sources:contextRecords})},...history.slice(-30),{role:'user',content:text}]
   while(messages.length>2&&Buffer.byteLength(JSON.stringify({model:'deepseek-flash',messages,stream:false}))>124*1024)messages.splice(1,1)
   if(Buffer.byteLength(JSON.stringify({model:'deepseek-flash',messages,stream:false}))>128*1024)throw Error('experience_context_too_large')
   const assistant=await options.complete(messages,signal);history.push({role:'user',content:text},{role:'assistant',content:assistant});return {assistant}
  },close:async()=>{}}
 },frame=>options.emit(frame.type==='conversation.error'?{...frame,reason:'experience_unavailable'}:frame))
 try{await host.open({deferBackground:true})}catch(error){closed=true;await host.close().catch(()=>{});throw error}
 const command=async(raw:unknown)=>{
  const request=z.object({type:z.literal('personal.command'),request_id:z.string(),method:z.string(),params:z.record(z.string(),z.unknown())}).parse(raw)
  const result=(data:unknown)=>({type:'personal.result',request_id:request.request_id,ok:true,data})
  if(closed)throw Error('experience_space_changed')
  if(request.method==='state')return result(snapshot())
  if(request.method==='source.read'){const row=byId.get(String(request.params.id));if(!row)throw Error('source_not_found');return result(row)}
  if(request.method==='profile.refresh'||request.method==='timeline.refresh'){
   if(refreshing)throw Error('experience_refresh_busy')
   refreshing=true;publish()
   try{
    const refreshed=snapshotSchema.parse(await options.refresh(sourceVersion,abort.signal))
    if(refreshed.source_version!==undefined&&refreshed.source_version!==sourceVersion)throw Error('experience_source_version_mismatch')
    const next=validateRefs({...refreshed,source_version:sourceVersion})
    if(closed||abort.signal.aborted)throw Error('experience_space_changed')
    const temp=projectionPath+'.tmp';await writeFile(temp,JSON.stringify(next),{mode:0o600});
    if(closed||abort.signal.aborted)throw Error('experience_space_changed')
    await rename(temp,projectionPath);projection=next;generation++;return result({status:'ready'})
   }finally{refreshing=false;publish()}
  }
  if(request.method==='timeline.dismiss')throw Error('experience_action_unavailable')
  if(request.method==='memory.list')return result(snapshot().memory)
  const allowed=new Set(['presentation.set','life.mutate','conversations.create','conversations.select','conversations.clear','conversations.delete','conversations.rename','conversations.read','conversations.cancel','conversations.start','conversations.discuss','tasks.list','tasks.get','tasks.cancel'])
  if(!allowed.has(request.method))throw Error('experience_text_only')
  const response=await host.command({...request,params:request.params as Record<string,JsonValue>},{client_id:'desktop:local',presentation_mode:'workbench'});publish();return response
 }
 return {snapshot,command,input:async(id:string,text:string,requestId:string)=>{if(closed)throw Error('experience_space_changed');await host.submitConversationText(id,text,requestId)},wait:(id:string)=>host.waitConversation(id),close:async()=>{closed=true;abort.abort();await host.close()}}
}
