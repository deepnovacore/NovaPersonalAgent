import {z} from 'zod'
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)
export const temporalSchema=z.object({kind:z.enum(['event','ongoing','deadline','scheduled','synthesis','background','unknown']),dates:z.array(z.object({role:z.enum(['occurred','started','deadline','scheduled']),date,ref:z.string().min(1).max(600),quote:z.string().min(1).max(600)}).strict()).max(3)}).strict()
export const resolvedTimeSchema=z.object({kind:temporalSchema.shape.kind,anchor_date:date.nullable(),anchor_basis:z.enum(['occurred','deadline','scheduled','reported','unknown']),occurred_on:date.nullable(),started_on:date.nullable(),due_on:date.nullable(),scheduled_on:date.nullable(),last_reported_on:date.nullable(),evidence_from:date.nullable(),evidence_to:date.nullable(),as_of:date})
interface TimeInput {id:string;kind:string;text:string;observed_at:string}
const validDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/u.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value
const reportedDate=(input:TimeInput,timezone:string)=>['im','mail'].includes(input.kind)&&Number.isFinite(Date.parse(input.observed_at))?new Date(input.observed_at).toLocaleDateString('en-CA',{timeZone:timezone}):null
const shift=(day:string,offset:number)=>new Date(Date.parse(day+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10)
// Extract only calendar expressions actually present in the exact cited span.
// File modification/collection timestamps never resolve relative dates.
function supportsDate(claim:z.infer<typeof temporalSchema>['dates'][number],input:TimeInput,timezone:string){
 if(!input.text.includes(claim.quote)||!validDate(claim.date))return false
 const reported=reportedDate(input,timezone),dates=new Set<string>()
 for(const match of claim.quote.matchAll(/(?<!\d)(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})(?:日)?(?!\d)/gu)){
  const year=match[1]??reported?.slice(0,4)
  if(year)dates.add(`${year}-${match[2]!.padStart(2,'0')}-${match[3]!.padStart(2,'0')}`)
 }
 if(reported)for(const [word,offset] of [['前天',-2],['昨天',-1],['今天',0],['今日',0],['明天',1],['后天',2]] as const)if(claim.quote.includes(word))dates.add(shift(reported,offset))
 return dates.has(claim.date)
}
export function resolveTimelineTime(temporal:z.infer<typeof temporalSchema>,inputs:readonly TimeInput[],context:{local_date:string;timezone:string}):z.infer<typeof resolvedTimeSchema>|null{
 if(temporal.kind==='background')return null
 const roles=new Map<string,string>()
 for(const claim of temporal.dates){
  const input=inputs.find(input=>input.id===claim.ref)
  if(!input)return null
  // A message's own date can ground a report, but cannot prove when its subject occurred.
  // Keep grounded content when the model redundantly copies that metadata into occurred.
  if(claim.role==='occurred'&&claim.date===reportedDate(input,context.timezone)&&input.text.includes(claim.quote)&&!/(?:\d{1,4}[-/年月]\d{1,2}|前天|昨天|今天|今日|明天|后天)/u.test(claim.quote))continue
  if(roles.has(claim.role)||!supportsDate(claim,input,context.timezone)||['occurred','started'].includes(claim.role)&&claim.date>context.local_date)return null
  roles.set(claim.role,claim.date)
 }
 const occurred_on=roles.get('occurred')??null,started_on=roles.get('started')??null,due_on=roles.get('deadline')??null,scheduled_on=roles.get('scheduled')??null
 const observed=inputs.flatMap(input=>{const day=reportedDate(input,context.timezone);return day&&day<=context.local_date?[day]:[]}).sort()
 const evidence_from=observed[0]??null,last_reported_on=observed.at(-1)??null
 if(started_on&&(occurred_on&&started_on>occurred_on||last_reported_on&&started_on>last_reported_on))return null
 if(temporal.kind==='deadline'&&!due_on||temporal.kind==='scheduled'&&!scheduled_on)return null
 const anchor_basis=temporal.kind==='unknown'?'unknown':temporal.kind==='deadline'?'deadline':temporal.kind==='scheduled'?'scheduled':temporal.kind==='event'&&occurred_on?'occurred':last_reported_on?'reported':occurred_on?'occurred':'unknown'
 const anchor_date=anchor_basis==='deadline'?due_on:anchor_basis==='scheduled'?scheduled_on:anchor_basis==='occurred'?occurred_on:anchor_basis==='reported'?last_reported_on:null
 return {kind:temporal.kind,anchor_date,anchor_basis,occurred_on,started_on,due_on,scheduled_on,last_reported_on,evidence_from,evidence_to:last_reported_on,as_of:context.local_date}
}
