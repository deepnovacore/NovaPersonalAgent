import {createHash} from 'node:crypto'
import {z} from 'zod'
import type {TimelineInput} from './timeline-brief.js'
import {SensitiveContentPolicy} from '../memory/sensitivity.js'

export const workbenchHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const workbenchRefSchema=z.object({entry_id:z.string().min(1).max(600),version:z.string(),quote:z.string().min(1).max(600)}).strict()
export const workbenchMatterSchema=z.object({
 kind:z.enum(['todo','goal','topic']),title:z.string().trim().min(1).max(160),summary:z.string().trim().min(1).max(400),
 ownership:z.enum(['user','other','uncertain']),assertion:z.enum(['direct','forwarded','inferred']),state:z.enum(['open','completed','cancelled','uncertain']),
 due:z.string().date().nullable(),due_quote:z.string().max(600).nullable(),
 refs:z.array(workbenchRefSchema).min(1).max(8),
}).strict()
export type WorkbenchMatter=z.infer<typeof workbenchMatterSchema>&{id:string;group:string;observed_at?:string}
export const workbenchEvidenceSchema=z.object({id:z.string(),version:z.string(),kind:z.string(),text:z.string().max(64000),observed_at:z.string(),relation:z.enum(['self','addressed','participant','system']).optional(),author:z.object({key:z.string(),name:z.string().optional(),kind:z.enum(['person','system','unknown']),is_user:z.boolean()}).optional()})
export const workbenchExtractionSchema=z.object({matters:z.array(workbenchMatterSchema).max(100)}).strict()
export const workbenchSuggestionSchema=z.object({
 tab:z.enum(['todos','ideas','goals']),title:z.string().trim().min(1).max(80),body:z.string().trim().min(1).max(120),
 why:z.string().max(80).nullable(),next:z.string().max(80).nullable(),matter_ids:z.array(z.string()).min(1).max(8),
}).strict()
export const workbenchCompositionSchema=z.object({
 suggestions:z.array(workbenchSuggestionSchema).max(9),
 matches:z.array(z.object({matter_id:z.string(),target_id:z.string().nullable(),same_as:z.string().nullable(),capture:z.enum(['record','suggest','skip'])}).strict()).max(100),
}).strict()
export interface WorkbenchExisting {id:string;kind:'todo'|'idea'|'goal';title:string;note:string;status:string;version:number;due?:string|null}
export type WorkbenchRequest=
 | {phase:'reconcile';matters:readonly WorkbenchMatter[];inputs:readonly TimelineInput[];date:string;timezone:string}
 | {phase:'extract';inputs:readonly TimelineInput[];previous:readonly WorkbenchMatter[];date:string;timezone:string}
 | {phase:'compose';matters:readonly WorkbenchMatter[];existing:readonly WorkbenchExisting[];date:string;timezone:string;identity_only?:boolean}
export type WorkbenchGenerator=(request:WorkbenchRequest,signal:AbortSignal)=>Promise<unknown>
const scrubber=new SensitiveContentPolicy()
export const workbenchSensitive=(text:string)=>scrubber.scrub('workbench',text).kind!=='clean'
export function validWorkbenchMatter(matter:z.infer<typeof workbenchMatterSchema>,inputs:readonly z.infer<typeof workbenchEvidenceSchema>[]):boolean{
 return !workbenchSensitive(JSON.stringify(matter))&&matter.refs.every(ref=>inputs.some(input=>input.id===ref.entry_id&&input.version===ref.version&&input.text.includes(ref.quote)))&&
  (matter.due===null||matter.due_quote!==null&&matter.refs.some(ref=>ref.quote.includes(matter.due_quote!)&&matter.due_quote!.includes(matter.due!)))
}
/** A quote and a structured attribution are both required; a sender flag alone never grants capture. */
export function automaticWorkbenchMatter(matter:WorkbenchMatter,inputs:readonly z.infer<typeof workbenchEvidenceSchema>[]):boolean{
 if(matter.kind==='topic'||matter.ownership!=='user'||matter.assertion!=='direct'||matter.state!=='open'||!validWorkbenchMatter(matter,inputs))return false
 const first=inputs.find(input=>input.id===matter.refs[0]!.entry_id)
 if(!first)return false
 if(first.kind==='file'||first.kind==='memory')return true
 if(matter.kind==='goal')return first.relation==='self'&&first.author?.is_user===true
 return first.relation==='self'&&first.author?.is_user===true||first.relation==='addressed'&&first.author?.kind==='person'&&!first.author.is_user
}
/** Stable source/day buckets avoid reshuffling every batch when one conversation receives a message. */
export function workbenchBatches(inputs:readonly TimelineInput[]):{group:string;inputs:TimelineInput[]}[]{
 const groups=new Map<string,TimelineInput[]>()
 for(const input of [...inputs].sort((a,b)=>a.observed_at.localeCompare(b.observed_at)||a.id.localeCompare(b.id))){
  if(!input.text.trim()||workbenchSensitive(input.text))continue
  const key=(input.group??input.kind)+':'+(input.kind==='file'?'documents':input.observed_at.slice(0,10))
  groups.set(key,[...groups.get(key)??[],{...input,text:input.text.slice(0,4000)}])
 }
 return [...groups].flatMap(([group,rows])=>{const batches:{group:string;inputs:TimelineInput[]}[]=[];let batch:TimelineInput[]=[],size=0
  for(const row of rows){if(batch.length&&(size+row.text.length>24000||batch.length>=60)){batches.push({group,inputs:batch});batch=[];size=0}batch.push(row);size+=row.text.length}
  if(batch.length)batches.push({group,inputs:batch});return batches
 })
}
/** Local lexical retrieval only selects identity candidates; the model decides whether they are the same object. */
export function workbenchExistingCandidates(matters:readonly WorkbenchMatter[],existing:readonly WorkbenchExisting[]):WorkbenchExisting[]{
 const grams=(text:string)=>{const s=text.normalize('NFKC').toLowerCase();return new Set(Array.from({length:Math.max(0,s.length-1)},(_,i)=>s.slice(i,i+2)))}
 const indexed=existing.map(row=>({row,grams:grams(row.title+' '+row.note)})),found=new Map<string,WorkbenchExisting>()
 for(const matter of matters){const query=grams(matter.title+' '+matter.summary)
  const scored=indexed.filter(item=>item.row.kind===matter.kind).map(item=>({...item,score:[...query].filter(g=>item.grams.has(g)).length/Math.max(1,Math.sqrt(query.size*item.grams.size))})).filter(item=>item.score>0).sort((a,b)=>b.score-a.score||a.row.id.localeCompare(b.row.id)).slice(0,4)
  for(const item of scored)found.set(item.row.id,{...item.row,note:item.row.note.slice(0,300)})
 }
 return [...found.values()]
}
