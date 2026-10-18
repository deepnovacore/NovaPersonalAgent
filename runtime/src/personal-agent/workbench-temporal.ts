import {z} from 'zod'
import type {TimelineInput} from './timeline-brief.js'
import {workbenchHash,type WorkbenchMatter} from './workbench-evidence.js'

export const TEMPORAL_RECIPE='temporal-v2'
export const temporalReplySchema=z.object({groups:z.array(z.object({
 members:z.array(z.string()).min(1).max(512),
 state:z.enum(['open','completed','cancelled','uncertain']),
 current:z.string(),basis:z.array(z.string()).min(1).max(8),
}).strict()).max(512)}).strict()
export type TemporalReply=z.infer<typeof temporalReplySchema>
export interface TemporalGroup {id:string;members:WorkbenchMatter[];state:WorkbenchMatter['state'];current:WorkbenchMatter;basis:WorkbenchMatter[]}
/** Coverage and closure are code gates; semantic identity still requires evidence review. */
export function resolveWorkbenchGroups(matters:readonly WorkbenchMatter[],raw:unknown):TemporalGroup[]{
 const parsed=temporalReplySchema.parse(raw),byId=new Map(matters.map(m=>[m.id,m])),seen=new Set<string>()
 const groups=parsed.groups.map(group=>{
  for(const id of group.members){if(!byId.has(id)||seen.has(id))throw Error('invalid_temporal_members');seen.add(id)}
  if(!group.members.includes(group.current)||!group.basis.includes(group.current)||group.basis.some(id=>!group.members.includes(id)))throw Error('invalid_temporal_members')
  const members=group.members.map(id=>byId.get(id)!),current=byId.get(group.current)!,basis=group.basis.map(id=>byId.get(id)!)
  let state=group.state
  if((state==='completed'||state==='cancelled')&&(current.state!==state||current.assertion!=='direct'||!basis.some(m=>m.state===state&&m.assertion==='direct')))state='uncertain'
  if(new Set(members.filter(m=>m.kind!=='topic').map(m=>m.kind)).size>1||members.some(m=>m.ownership==='other')&&members.some(m=>m.ownership==='user'))state='uncertain'
  // A claimed reopening must be confirmed; message receipt time cannot reopen a closed event.
  if(state==='open'&&(members.some(m=>m.state==='completed'||m.state==='cancelled')||current.assertion!=='direct'||current.state!=='open'||members.some(m=>m.ownership==='other')&&members.some(m=>m.ownership==='user')))state='uncertain'
  return {id:workbenchHash([...group.members].sort()),members,state,current,basis}
 })
 if(seen.size!==byId.size)throw Error('incomplete_temporal_coverage')
 return groups
}
/** Original quotations are retained; compact identifiers remove repeated hashes and paths. */
export function temporalIndex(matters:readonly WorkbenchMatter[],inputs:readonly TimelineInput[]=[]){
 const authors=new Map<string,number>()
 return matters.map((m,i)=>{
  return {id:'m'+i,kind:m.kind,title:m.title,state:m.state,ownership:m.ownership,assertion:m.assertion,reported_at:m.observed_at,quotes:m.refs.map(ref=>{const input=inputs.find(i=>i.id===ref.entry_id),author=input?.author;if(author&&!authors.has(author.key))authors.set(author.key,authors.size);return {text:ref.quote,reported_at:input?.observed_at,kind:input?.kind,author:author?{...author,key:'p'+authors.get(author.key)}:undefined}})}
 })
}
/** Repeated author metadata is factored out without shortening any original quotation. */
export function compactTemporalIndex(rows:ReturnType<typeof temporalIndex>){
 const authors:Record<string,NonNullable<(typeof rows)[number]['quotes'][number]['author']>>={}
 const keys=new Map<string,string>()
 const matters=rows.map(row=>({...row,quotes:row.quotes.map(quote=>{
  let key:string|undefined
  if(quote.author){const identity=JSON.stringify(quote.author);key=keys.get(identity);if(key===undefined){key='a'+keys.size;keys.set(identity,key);authors[key]=quote.author}}
  return {...quote,author:key}
 })}))
 return {authors,matters}
}
