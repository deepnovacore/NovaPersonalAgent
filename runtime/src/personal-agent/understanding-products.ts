import type {SourceTag} from '../memory/provenance.js'
import {createHash} from 'node:crypto'
import type {ProfileInput} from './profile-warmup.js'
import type {inspectProject} from './project-history.js'
import {z} from 'zod'
import {profileDraftSchema} from './profile-warmup.js'
const ref=profileDraftSchema.shape.work.unwrap().element.shape.refs
export const projectUnderstandingSchema=z.object({id:z.string().max(128),name:z.string().min(1).max(120),relation:z.enum(['participating','reference','uncertain']),status:z.enum(['current','historical','uncertain']),summary:z.string().max(500),as_of:z.string().nullable(),refs:ref}).strict()
export const actionSuggestionSchema=z.object({id:z.string().max(128),kind:z.enum(['action','progress','idea','goal']),title:z.string().min(1).max(200),body:z.string().max(1000),project_id:z.string().nullable(),source_key:z.string().optional(),todo_id:z.string().nullable(),due:z.string().date().nullable(),date_evidence:z.object({entry_id:z.string(),quote:z.string().max(80)}).nullable().optional(),anchor:z.object({entry_id:z.string(),quote:z.string().max(160)}).nullable().optional(),refs:ref}).strict()
export const understandingProductsSchema=z.object({projects:z.array(projectUnderstandingSchema).max(24),suggestions:z.array(actionSuggestionSchema).max(24)}).strict()
export type UnderstandingProducts=z.infer<typeof understandingProductsSchema>
export const projectCorrectionSchema=z.enum(['participating','historical','reference','automatic'])
export interface UnderstandingSnapshot extends UnderstandingProducts {
 profile_pending?:boolean;news_cleanup_pending?:boolean;revision:number;draft:z.infer<typeof profileDraftSchema>|null;generated_at:string|null;
 sources:{id:string;version:string;label:string;observed_at:string;type?:SourceTag['type'];provider?:string;url?:string}[];
 corrections:Record<string,z.infer<typeof projectCorrectionSchema>>;
}
export const emptyUnderstanding=():UnderstandingSnapshot=>({revision:0,draft:null,generated_at:null,projects:[],suggestions:[],sources:[],corrections:{}})

export interface ProductGenerationContext {
 projects:(Awaited<ReturnType<typeof inspectProject>>&{evidence_ids:string[]})[];
 identities?:{id:string;kind:string;title:string;project_id:string|null;source_key:string}[];previous:UnderstandingProducts;corrections:UnderstandingSnapshot['corrections'];timezone:string;
 todos:{id:string;title:string;status:string;due:string|null}[];
}
const eventTime=(entry:ProfileInput|undefined)=>entry&&(!entry.source||entry.source.kind||entry.source.project==='Conversation')?entry.observed_at:undefined
const identity=(text:string)=>createHash('sha256').update(text).digest('hex').slice(0,32)
function evidenceDate(quote:string,at:string|undefined,timezone:string):string|null{
 if(/^\d{4}-\d{2}-\d{2}$/u.test(quote))return z.string().date().safeParse(quote).success?quote:null
 if(!at||!Number.isFinite(Date.parse(at)))return null
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at)),base=new Date(date+'T12:00:00Z')
 const offset:Record<string,number>={'今天':0,'明天':1,'后天':2,today:0,tomorrow:1}
 let days=Object.hasOwn(offset,quote.toLowerCase())?offset[quote.toLowerCase()]:undefined
 const week=/^下周([一二三四五六日天])$/u.exec(quote)
 if(week)days=7-((base.getUTCDay()+6)%7)+'一二三四五六日'.indexOf(week[1]==='天'?'日':week[1]!)
 if(days===undefined)return null
 base.setUTCDate(base.getUTCDate()+days);return base.toISOString().slice(0,10)
}
/** Validate model references and dates; words alone never authorize a Life mutation. */
export function validateProducts(raw:unknown,entries:readonly ProfileInput[],projectIds:readonly string[],corrections:UnderstandingSnapshot['corrections'],timezone:string,previous:UnderstandingProducts={projects:[],suggestions:[]},identities:ProductGenerationContext['identities']=[],todos:ProductGenerationContext['todos']=[]):UnderstandingProducts{
 const value=understandingProductsSchema.parse(raw),valid=(refs:z.infer<typeof ref>)=>refs.every(r=>entries.some(e=>e.id===r.entry_id&&e.version===r.version))
 const nonGit=(p:UnderstandingProducts['projects'][number])=>p.refs.every(r=>entries.find(e=>e.id===r.entry_id)?.source?.project==='Conversation'||entries.find(e=>e.id===r.entry_id)?.source?.kind)&&p.refs.some(r=>entries.find(e=>e.id===r.entry_id)?.content.normalize('NFKC').toLowerCase().includes(p.name.normalize('NFKC').toLowerCase()))
 const canonical=(p:UnderstandingProducts['projects'][number])=>!projectIds.includes(p.id)&&nonGit(p)?identity('project:'+p.name.normalize('NFKC').trim().toLowerCase()):p.id
 const proposals=value.projects.map(p=>({...p,id:canonical(p)})),allowedIds=value.projects.filter(nonGit).map(canonical),aliases=new Map(value.projects.filter(p=>p.id!==''||value.projects.length===1).map(p=>[p.id,canonical(p)]))
 const projects=proposals.filter(p=>(projectIds.includes(p.id)||allowedIds.includes(p.id))&&valid(p.refs)).map(p=>({...p,id:p.id||identity('project:'+p.name.normalize('NFKC').trim().toLowerCase()),...(corrections[p.id]==='reference'?{relation:'reference' as const}:corrections[p.id]==='historical'?{status:'historical' as const}:corrections[p.id]==='participating'?{relation:'participating' as const,status:'current' as const}:{}),as_of:p.refs.map(r=>eventTime(entries.find(e=>e.id===r.entry_id))).filter((at):at is string=>!!at).sort().at(-1)??null}))
 const quotedAnchor=(item:UnderstandingProducts['suggestions'][number])=>item.anchor&&item.anchor.quote.trim()?entries.find(entry=>entry.id===item.anchor!.entry_id&&item.refs.some(ref=>ref.entry_id===entry.id&&ref.version===entry.version)&&entry.content.includes(item.anchor!.quote)):undefined
 const suggestions=value.suggestions.map(item=>({...item,project_id:item.project_id===null?null:aliases.get(item.project_id)??item.project_id})).filter(item=>(!item.todo_id||todos.some(todo=>todo.id===item.todo_id))&&(item.kind!=='progress'||!!item.todo_id)&&valid(item.refs)&&(!['action','progress'].includes(item.kind)||!!quotedAnchor(item))&&(!item.project_id||projects.some(p=>p.id===item.project_id&&p.relation==='participating'&&p.status==='current'))).map(item=>{
  const first=entries.find(e=>e.id===item.refs[0]?.entry_id)!,date=item.date_evidence,source=date&&entries.find(e=>e.id===date.entry_id&&item.refs.some(r=>r.entry_id===e.id)),anchor=quotedAnchor(item),identitySource=anchor??first,sourceKey=identitySource.identity_key??JSON.stringify(identitySource.source??identitySource.id)
  const prior=[...previous.suggestions,...identities].find(p=>p.id===item.id&&p.kind===item.kind&&p.project_id===item.project_id&&(p.source_key===sourceKey||('refs' in p&&p.refs.some(r=>entries.some(e=>e.id===r.entry_id&&item.refs.some(n=>n.entry_id===e.id))))))
  const stable=identity(JSON.stringify([item.project_id??sourceKey,item.kind,anchor?item.anchor!.quote.normalize('NFKC').trim():first.source?.document??first.id]))
  return {...item,source_key:sourceKey,id:prior?.id??stable,due:date&&source?.content.includes(date.quote)?evidenceDate(date.quote,eventTime(source),timezone):null}
 })
 return {projects:[...new Map(projects.map(p=>[p.id,p])).values()],suggestions:[...new Map(suggestions.map(item=>[item.id,item])).values()]}
}

/** Carry host-derived channel metadata through presentation and confirmed adoption. */
export function understandingSourceTags(refs:readonly {entry_id:string}[],sources:UnderstandingSnapshot['sources']):SourceTag[]{
 return refs.flatMap(ref=>{const source=sources.find(item=>item.id===ref.entry_id);if(!source?.type)return [];return [{evidence_id:ref.entry_id,type:source.type,label:source.label.slice(0,120),observed_at:source.observed_at,...(source.provider?{provider:source.provider}:{}),...(source.url?{url:source.url}:{})}]})
}
