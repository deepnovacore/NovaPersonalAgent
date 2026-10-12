import type {UnifiedRetrievalResult,RetrievedEvidenceResult} from '../memory/retrieval.js'
import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import type {JsonValue} from '../core/events.js'
import type {PersonalAgentHost} from './host.js'
import type {ScheduledRunGrant} from './scheduled-run-authority.js'
import {scheduleHash} from './scheduled-tasks.js'
const sectionSchema=z.enum(['todos','goals','tasks'])
export type AppContextSection=z.infer<typeof sectionSchema>
export interface AppContextPage{
 section:AppContextSection
 owner_task_id:string
 consumer:string|null
 items:(Record<string,JsonValue>&{id:string;version:string|number})[]
 next_cursor:string|null
 coverage:{complete:boolean;omitted:number;truncated:boolean;collection_version:string}
 evidence_refs:string[]
 observed_at:string
}
export class ScheduledAppContext{
 constructor(readonly host:PersonalAgentHost){}
 async read(section:AppContextSection,cursor:string|null,grant:ScheduledRunGrant):Promise<AppContextPage>{
  section=sectionSchema.parse(section);this.host.scheduledAuthority.assert(grant,grant.fence)
  if(!this.host.schedules.getRun(grant.run_id).definition.context[section])throw Error('context_not_authorized')
  const projection=await this.#project(section,grant.consumer,grant.task_id),version=scheduleHash(projection)
  let offset=0
  if(cursor){
   let parsed:{section:AppContextSection;version:string;offset:number}
   try{z.string().max(1024).parse(cursor);parsed=z.object({section:sectionSchema,version:z.string(),offset:z.number().int().nonnegative()}).strict().parse(JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')))}catch{throw Error('context_cursor_invalid: start with cursor null; otherwise copy next_cursor unchanged')}
   if(parsed.section!==section||parsed.version!==version)throw Error('context_cursor_stale');offset=parsed.offset
  }
  if(offset>projection.items.length)throw Error('context_cursor_stale')
  const items=projection.items.slice(offset,offset+20),truncated=items.some(item=>item.truncated===true)
  const page:AppContextPage={section,owner_task_id:grant.task_id,consumer:grant.consumer,items,next_cursor:null,coverage:{complete:false,omitted:projection.omitted,truncated,collection_version:version},evidence_refs:['app:'+section+':'+version],observed_at:new Date().toISOString()}
  while(Buffer.byteLength(JSON.stringify(page))>30000&&items.length>1){items.pop();page.coverage.truncated=true}
  const next=offset+items.length
  if(next<projection.items.length)page.next_cursor=Buffer.from(JSON.stringify({section,version,offset:next})).toString('base64url')
  page.coverage.complete=offset===0&&page.next_cursor===null&&page.coverage.omitted===0&&!page.coverage.truncated
  this.host.scheduledAuthority.assert(grant,grant.fence)
  if(!await this.validateRefs(page.evidence_refs,grant.consumer,grant.task_id))throw Error('context_authorization_changed')
  if(Buffer.byteLength(JSON.stringify(page))>32768)throw Error('context_capacity')
  await this.host.tasks.recordContextEvidence(grant.fence,randomUUID(),JSON.stringify(page),page.evidence_refs)
  return page
 }
 async validateTask(taskId:string,consumer:string|null,recipient=consumer):Promise<boolean>{
  for(const evidence of this.host.tasks.evidence(taskId).filter(item=>item.kind==='context')){
   let page:AppContextPage & {projection?:UnifiedRetrievalResult|RetrievedEvidenceResult}
   try{page=JSON.parse(evidence.content) as typeof page}catch{return false}
   if(page.projection){
    const memory=this.host.options.memory(),projection=page.projection
    if(Array.isArray(projection.entries))for(const entry of (projection as UnifiedRetrievalResult).entries){const row=await memory?.get?.(entry.entry_id);if(row?.status!=='active'||row.version!==entry.revision||!row.content.startsWith(entry.text))return false}
    const snippets=Array.isArray(projection.snippets)?(projection as UnifiedRetrievalResult).snippets:(projection as RetrievedEvidenceResult).evidence?[(projection as RetrievedEvidenceResult).evidence!]:[]
    for(const snippet of snippets){const row=await memory?.readEvidence?.(snippet.evidence_id);if(!row||!row.text.startsWith(snippet.text)||row.locator!==snippet.locator||row.observed_at!==snippet.observed_at)return false}
   }
   if(page.consumer!==consumer||!await this.validateRefs(evidence.refs,consumer,taskId)||recipient!==consumer&&!await this.validateRefs(evidence.refs,recipient,taskId))return false
  }
  return true
 }
 async validateRefs(refs:readonly string[],consumer:string|null,taskId:string):Promise<boolean>{
  for(const ref of refs){
   const match=/^app:(todos|goals|tasks):([a-f0-9]{64})$/.exec(ref)
   if(match){if(scheduleHash(await this.#project(sectionSchema.parse(match[1]),consumer,taskId))!==match[2])return false}
   else if(!consumer||!await this.host.options.memory()?.canReadConversationEvidence?.(ref,consumer))return false
  }
  return true
 }
 async #project(section:AppContextSection,consumer:string|null,taskId:string){
  await this.host.life.refresh()
  const items:AppContextPage['items']=[];let omitted=0
  if(section==='tasks'){
   for(const task of this.host.tasks.list().filter(task=>task.id!==taskId))items.push({id:task.id,version:task.control_revision+':'+task.goal_revision+':'+task.phase,status:task.phase,waiting:task.waiting_reason!==null,execution_route:task.execution_route??null})
  }else{
   for(const row of this.host.life.snapshot()[section]){
    const sources=[...new Set([...(row.provenance_refs??[]),...(row.sources??[]).map(source=>source.evidence_id)])]
    if(row.source_changed||row.auto_recorded&&!sources.length||sources.length&&(!consumer||(await Promise.all(sources.map(ref=>this.host.options.memory()?.canReadConversationEvidence?.(ref,consumer)??Promise.resolve(false)))).some(allowed=>!allowed))){omitted++;continue}
    const note=row.note.slice(0,900),criteria='success_criteria' in row?row.success_criteria.slice(0,600):null
    items.push({id:row.id,version:row.version,title:row.title,note,status:row.status,...('due'in row?{due:row.due,goal_id:row.goal_id}:{success_criteria:criteria}),truncated:note.length<row.note.length||('success_criteria'in row&&criteria!.length<row.success_criteria.length)})
   }
  }
  return {items,omitted}
 }
}
