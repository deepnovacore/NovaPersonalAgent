import {z} from 'zod'

export const SCHEDULE_CATCHUP_MS=2*60*60*1000
const timezone=z.string().min(1).max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true}catch{return false}},'invalid_timezone')
const time=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{const instant=new Date(value+'T00:00:00Z');return Number.isFinite(+instant)&&instant.toISOString().slice(0,10)===value},'invalid_date')
const ruleSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('once'),timezone,date,time}).strict(),
 z.object({kind:z.literal('daily'),timezone,time}).strict(),
 z.object({kind:z.literal('weekly'),timezone,time,weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(days=>new Set(days).size===days.length,'duplicate_weekday')}).strict(),
])
export type ScheduleRule=z.infer<typeof ruleSchema>
export const scheduleRuleSchema=ruleSchema.refine(rule=>rule.kind!=='once'||resolveLocal(rule.timezone,rule.date,rule.time).instant!==null,'nonexistent_local_time')
export interface ScheduleSlot {scheduled_at:string;local_date:string;local_time:string;slot_key:string}
export interface ScheduleDue {latest:ScheduleSlot|null;missed_count:number;dst_gaps:string[]}

function format(zone:string){return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})}
function local(formatter:Intl.DateTimeFormat,instant:number){
 const p=Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part=>[part.type,part.value]))
 return p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute
}
const resolved=new Map<string,{instant:number|null;gap_at:number}>()
function resolveLocal(zone:string,day:string,clock:string){
 const key=zone+':'+day+':'+clock,cached=resolved.get(key)
 if(cached)return cached
 const formatter=format(zone),target=day+'T'+clock,nominal=Date.parse(target+':00Z'),offsets=new Set<number>()
 // Sample both sides of civil-time transitions; verify every resulting instant by round trip.
 for(let hours=-48;hours<=48;hours+=6){const probe=nominal+hours*3600000;offsets.add(Date.parse(local(formatter,probe)+':00Z')-probe)}
 const candidates=[...offsets].map(offset=>nominal-offset).sort((a,b)=>a-b)
 const instant=candidates.find(candidate=>local(formatter,candidate)===target)??null
 let gap_at=0
 if(instant===null){
  const lower=candidates[0]!,upper=candidates.at(-1)!
  for(let probe=lower;probe<=upper;probe+=60000)if(local(formatter,probe)>=target){gap_at=probe;break}
  if(!gap_at)gap_at=upper
 }
 const value={instant,gap_at}
 if(resolved.size>=4096)resolved.delete(resolved.keys().next().value!)
 resolved.set(key,value);return value
}
function addDay(day:string,days:number){return new Date(Date.parse(day+'T00:00:00Z')+days*86400000).toISOString().slice(0,10)}
function matches(rule:ScheduleRule,day:string){return rule.kind==='once'?rule.date===day:rule.kind==='daily'||rule.weekdays.includes(new Date(day+'T00:00:00Z').getUTCDay()||7)}
function slot(rule:ScheduleRule,day:string,instant:number):ScheduleSlot{return {scheduled_at:new Date(instant).toISOString(),local_date:day,local_time:rule.time,slot_key:rule.timezone+':'+day+':'+rule.time}}

export function nextOccurrence(input:ScheduleRule,after:Date):ScheduleSlot|null{
 const rule=scheduleRuleSchema.parse(input)
 if(!Number.isFinite(+after))throw Error('invalid_clock')
 const first=rule.kind==='once'?rule.date:local(format(rule.timezone),+after).slice(0,10)
 for(let offset=0;offset<(rule.kind==='once'?1:370);offset++){
  const day=addDay(first,offset)
  if(!matches(rule,day))continue
  const {instant}=resolveLocal(rule.timezone,day,rule.time)
  if(instant!==null&&instant>+after)return slot(rule,day,instant)
 }
 return null
}

export function collectDueOccurrences(input:ScheduleRule,after:Date,now:Date):ScheduleDue{
 const rule=scheduleRuleSchema.parse(input),due:ScheduleDue={latest:null,missed_count:0,dst_gaps:[]}
 if(!Number.isFinite(+after)||!Number.isFinite(+now))throw Error('invalid_clock')
 if(+now<=+after)return due
 const formatter=format(rule.timezone),first=rule.kind==='once'?rule.date:local(formatter,+after).slice(0,10),last=rule.kind==='once'?rule.date:local(formatter,+now).slice(0,10)
 for(let day=first;day<=last;day=addDay(day,1)){
  if(!matches(rule,day))continue
  const {instant,gap_at}=resolveLocal(rule.timezone,day,rule.time)
  if(instant===null){if(gap_at>+after&&gap_at<=+now)due.dst_gaps.push(day);continue}
  if(instant<=+after||instant>+now)continue
  if(instant<+now-SCHEDULE_CATCHUP_MS){due.missed_count++;continue}
  if(due.latest)due.missed_count++
  due.latest=slot(rule,day,instant)
 }
 return due
}
